/**
 * Scripture Memory - worker entry point.
 *
 * The worker owns everything that is not a pixel: the database, the schedule,
 * the scoring, and the session the user is in the middle of. The panel asks
 * and renders. That split is not stylistic - a popped-out panel is a brand new
 * document with a brand new iframe, so anything the panel held would be lost
 * the moment the user detached the window. The worker is long-lived, so the
 * session survives.
 *
 * `import type` only, everywhere: the whole `@bible/core` surface is erased at
 * build time, and `dist/main.js` ships as first-party code with no runtime
 * dependency on the host's packages.
 */

import type { BibleExtensionAPI, BibleVerseDto, DisposableHandle } from './bibleTypes';
import type {
  AnswerMode,
  Passage,
  PanelReply,
  PanelRequest,
  PassageContext,
  PassageView,
  PlanView,
  Rung,
  RungView,
  SessionSummary,
  StepAnswer,
  VerseText,
} from './types';
import { migrate, ensureDefaultCollection } from './db';
import { MemoryStore } from './store';
import { applicableRungs, levelFromScore, WELL_LEARNED_LEVEL } from './ladder';
import { schedule, makeRng, isDue } from './scheduler';
import { Session, nextSessionId } from './session';
import { toVerseText, CONTEXT_VERSES } from './verses';
import { resolveReference, ReferenceError, MAX_PASSAGE_VERSES } from './reference';

const DB_NAME = 'memory';
const DEFAULT_COLLECTION_NAME = 'My plan';

/** This extension's manifest id, used to namespace the command ids it binds. */
const EXTENSION_ID = 'ext.bible-app.scripture-memory';

/**
 * Verse id encoding: book * 1e6 + chapter * 1e3 + verse.
 *
 * This is the host's KJV-absolute scheme, and it is used here only to render
 * the "3:16" label in the margin. It is an inference from the shape of the
 * ids, not a documented contract, so `verifyVerseIdEncoding` checks it once at
 * activation against `listChapters` - real data the host computed itself - and
 * disables the labels rather than showing wrong ones if it ever stops holding.
 */
const BOOK_FACTOR = 1_000_000;
const CHAPTER_FACTOR = 1_000;

let verseIdEncodingTrusted = true;

function labelFor(verseId: number): string {
  if (!verseIdEncodingTrusted) return String(verseId);
  const chapter = Math.floor((verseId % BOOK_FACTOR) / CHAPTER_FACTOR);
  const verse = verseId % CHAPTER_FACTOR;
  return `${chapter}:${verse}`;
}

/** Book number -> display name, from the host. Empty until loaded, or if the host refuses. */
let bookNames = new Map<number, string>();

/**
 * A full reference - "John 3:16", or "John 3:16-18" for a run within one
 * chapter. Plan entries and the panel's placeholder need the book: "3:16" is
 * ambiguous in a list, and the reference parser cannot read it back. Falls
 * back to `labelFor` when the book name is unknown.
 */
function referenceFor(startVerseId: number, endVerseId = startVerseId): string {
  const label = labelFor(startVerseId);
  const range = endVerseId === startVerseId ? label : `${label}-${endVerseId % CHAPTER_FACTOR}`;
  const book = verseIdEncodingTrusted
    ? bookNames.get(Math.floor(startVerseId / BOOK_FACTOR))
    : undefined;
  return book ? `${book} ${range}` : range;
}

/** Module-level state. The realm gives each extension its own isolated global. */
let api: BibleExtensionAPI;
let store: MemoryStore;
let collectionId: number;
let activeVerseId: number | null = null;
/** Abbreviation of the translation the reader is in, from the active-verse event. */
let activeModule: string | null = null;
let statusBarHandle: DisposableHandle | null = null;
let lastStatusText: string | null = null;
const sessions = new Map<string, Session>();
/** When each in-flight session started, for the (currently unshown) duration column. */
const sessionStartedAt = new Map<string, number>();

// ---------------------------------------------------------------------------
// Activation
// ---------------------------------------------------------------------------

/**
 * Permissions this extension needs that the host does NOT grant on its own.
 *
 * Only `bible:read` and `commands:register` are in
 * `DEFAULT_GRANTED_PERMISSIONS`. Current hosts show a consent dialog on install
 * - including Developer Mode's "Load unpacked extension" - and grant what the
 * user leaves ticked; anything unticked, or refused by an older host that
 * grants only the defaults, waits for the user to grant it in
 * Preferences > Extensions.
 *
 * That makes a permission failure the single most likely thing to go wrong on
 * a first run, so it is handled as an expected state rather than as a crash.
 */
const REQUIRED_GRANTS = [
  'storage:database',
  'ui:contribute-pane',
  'ui:context-menu',
  'ui:status-bar',
  'ui:notification',
] as const;

/** Set once storage is open. Panel requests answer honestly while it is false. */
let ready = false;

export async function activate(host: BibleExtensionAPI): Promise<void> {
  api = host;

  // Storage first, and fatally: everything else in this extension is a view
  // over the database, so there is nothing worth registering without it. A
  // thrown error here would be reported by the host as a broken extension,
  // which is misleading - nothing is broken, a permission is simply missing -
  // so it is caught and explained instead.
  try {
    const db = await api.storage.openDatabase(DB_NAME);
    await migrate(db);
    store = new MemoryStore(db);
    collectionId = await ensureDefaultCollection(db, DEFAULT_COLLECTION_NAME, Date.now());
    ready = true;
  } catch (err) {
    console.error(
      'Scripture Memory could not open its database. This is almost always a ' +
        'missing permission rather than a fault: open Preferences > Extensions, ' +
        'grant Scripture Memory the permissions it asks for ' +
        `(${REQUIRED_GRANTS.join(', ')}), then reload the extension. ` +
        `Underlying error: ${err instanceof Error ? err.message : String(err)}`,
    );
    return;
  }

  await verifyVerseIdEncoding();
  await loadBookNames();

  // Registered imperatively because that is the only path that works:
  // nothing in the host reads `contributes.panelTypes` from the manifest.
  // The manifest entry is documentation until that changes.
  await api.ui.registerPanelType({
    id: 'panel',
    title: 'Scripture Memory',
    uiEntry: 'ui/index.html',
    defaultBucket: 'right',
    // Wider than the 900x700 every extension panel would otherwise detach at.
    // The practice view renders scripture in a measured column with context
    // either side, and at 900 the context has to be cropped to fit.
    defaultWindowSize: { width: 1180, height: 860 },
  });

  await api.panels.onMessage(handlePanelMessage);

  await registerCommands();
  await registerContextMenu();
  await refreshStatusBar();

  await api.bible.onDidChangeActiveVerse.subscribe((event) => {
    activeVerseId = event ? event.verseId : null;
    if (event?.module) activeModule = event.module;
    postActiveVerse();
  });

  console.log('Scripture Memory activated');
}

/**
 * Tell the panel which verse the reader is on, for the Add field's
 * placeholder. Sent on every change, and again when the panel asks for its
 * plan: a panel opened after the last change would otherwise never hear it.
 */
function postActiveVerse(): void {
  if (activeVerseId === null) return;
  void api.panels.postMessage({
    type: 'activeVerse',
    verseId: activeVerseId,
    reference: referenceFor(activeVerseId),
  });
}

export function deactivate(): void {
  // Sessions are in-memory and intentionally not flushed as attempts: a
  // half-finished exercise is not a fact worth recording as one, and writing
  // a partial attempt on shutdown would put a score in the history for work
  // the user never finished. The resume point up to the last completed verse
  // was already written to disk by `submitStep`, so nothing is lost except
  // the verse in progress.
  sessions.clear();
  sessionStartedAt.clear();
  console.log('Scripture Memory deactivated');
}

/**
 * Check the verse-id arithmetic against data the host computed.
 *
 * John is book 43; if `listChapters` says chapter 3 starts at 43003001 then
 * the encoding holds. A mismatch is logged loudly and downgrades every label
 * to a bare id, which is ugly but honest - a wrong chapter:verse in the margin
 * of a memorisation exercise would actively teach the user the wrong address.
 */
async function verifyVerseIdEncoding(): Promise<void> {
  try {
    const chapters = await api.bible.listChapters(43);
    const third = chapters.find((c) => c.chapter === 3);
    if (!third) return;
    const expected = 43 * BOOK_FACTOR + 3 * CHAPTER_FACTOR + 1;
    if (third.firstVerseId !== expected) {
      verseIdEncodingTrusted = false;
      console.warn(
        `Scripture Memory: verse id encoding changed (expected ${expected}, ` +
          `host says ${third.firstVerseId}); verse labels disabled.`,
      );
    }
  } catch (err) {
    verseIdEncodingTrusted = false;
    console.warn('Scripture Memory: could not verify verse id encoding:', err);
  }
}

/**
 * Load book names for `referenceFor`. Best effort: without them references
 * degrade to "3:16", which is what they were before names were available.
 */
async function loadBookNames(): Promise<void> {
  try {
    const books = await api.bible.listBooks();
    // `name` is a LocalizedString. The host sends plain strings; the other
    // form is a catalog key the worker cannot resolve, so it is skipped
    // rather than shown raw.
    bookNames = new Map(
      books.flatMap((b) => (typeof b.name === 'string' ? [[b.bookNumber, b.name] as const] : [])),
    );
  } catch (err) {
    console.warn('Scripture Memory: could not load book names:', err);
  }
}

// ---------------------------------------------------------------------------
// Host contributions
// ---------------------------------------------------------------------------

/**
 * Commands take TWO calls, and missing either one fails silently.
 *
 *  1. `api.commands.register` puts the command in the host's registry, which
 *     is what the palette, the keyboard, the Tools menu and any context-menu
 *     item naming it all read. Declaring it under `contributes.commands` in
 *     the manifest does *not* do this - nothing in the host reads that key.
 *     Without this call the command does not exist, and a context-menu item
 *     pointing at it dangles.
 *  2. `api.runtime.expose` binds the `handlerEndpoint` *name* to an actual
 *     function. A function cannot survive the RPC hop to the host, so the
 *     registration carries a name and the host calls back with it. Without
 *     this call the command appears everywhere and does nothing when invoked.
 *
 * The two are separate because they cross the boundary in opposite
 * directions, and each is silent on its own - which is why both are done here,
 * together, from one list.
 */
const COMMANDS: { endpoint: string; title: string }[] = [
  { endpoint: 'practiceDue', title: "Scripture Memory: Practice what's due" },
  { endpoint: 'addActiveVerse', title: 'Scripture Memory: Add this verse to my plan' },
];

async function registerCommands(): Promise<void> {
  for (const command of COMMANDS) {
    // The id must start with `${EXTENSION_ID}.` or the registry rejects it.
    await api.commands.register({
      id: `${EXTENSION_ID}.${command.endpoint}`,
      title: command.title,
      category: 'Scripture Memory',
      handlerEndpoint: command.endpoint,
    });
  }

  await api.runtime.expose('practiceDue', async () => {
    const next = await store.nextDueCard(Date.now());
    if (!next) {
      await api.ui.showNotification('Nothing is due right now.');
      return;
    }
    await api.workspace.openPanel('panel');
    void api.panels.postMessage({ type: 'planChanged' });
  });

  await api.runtime.expose('addActiveVerse', async (args?: unknown) => {
    // From the verse context menu the host says what was right-clicked, which
    // need not be the active verse. From the command palette there is only
    // the active verse to go on.
    const clicked = versesFromMenuArgs(args);
    if (clicked) {
      await addPassageFromVerseId(clicked.start, clicked.end, clicked.module);
      return;
    }
    if (activeVerseId === null) {
      await api.ui.showNotification('Open a verse first, then add it to your plan.');
      return;
    }
    await addPassageFromVerseId(activeVerseId);
  });
}

async function registerContextMenu(): Promise<void> {
  await api.ui.registerContextMenu('verse', {
    id: 'addToPlan',
    // "Add to memorization plan", not "Add to memory" - the shorter phrasing
    // reads as a computing term rather than a spiritual discipline.
    label: 'Add to memorization plan',
    command: `${EXTENSION_ID}.addActiveVerse`,
  });
}

/**
 * Re-register the status bar item to change its text.
 *
 * There is no `ui.updateStatusBarItem` on the platform, so the only way to
 * change a status bar item is to dispose it and register a new one - the
 * descriptor's own documented use case ("X items indexed") has the same
 * problem. `lastStatusText` guards the churn so a no-op refresh does not
 * dispose and recreate an identical item on every scheduling tick.
 */
async function refreshStatusBar(): Promise<void> {
  const count = await store.dueCount(Date.now());
  const text = count === 0 ? 'Memory: up to date' : `Memory: ${count} due`;
  if (text === lastStatusText) return;

  if (statusBarHandle) {
    await statusBarHandle.dispose();
    statusBarHandle = null;
  }
  statusBarHandle = await api.ui.registerStatusBarItem({
    id: 'dueCount',
    text,
    tooltip: 'Scripture Memory',
    command: `${EXTENSION_ID}.practiceDue`,
    alignment: 'right',
  });
  lastStatusText = text;
  void api.panels.postMessage({ type: 'dueCountChanged', count });
}

// ---------------------------------------------------------------------------
// Panel protocol
// ---------------------------------------------------------------------------

async function handlePanelMessage(message: unknown): Promise<PanelReply<unknown>> {
  const req = message as PanelRequest;
  try {
    return { ok: true, data: await dispatch(req) };
  } catch (err) {
    // Failures travel as data, not as exceptions. An exception thrown here
    // reaches the panel as an opaque RPC failure with no usable message, and
    // "that reference does not parse" is precisely the kind of failure the
    // user has to be able to read.
    const msg = err instanceof Error ? err.message : String(err);
    if (!(err instanceof ReferenceError)) {
      console.warn(`Scripture Memory: ${req?.type ?? 'unknown'} failed:`, err);
    }
    return { ok: false, error: msg };
  }
}

async function dispatch(req: PanelRequest): Promise<unknown> {
  // Activation gives up quietly when storage is unavailable, so the panel can
  // still be opened afterwards. Say why rather than throwing on a null store.
  if (!ready) {
    throw new Error(
      'Scripture Memory has no storage yet. Open Preferences > Extensions, ' +
        'grant it the permissions it asks for, then reload the extension.',
    );
  }

  switch (req.type) {
    case 'getPlan':
      postActiveVerse();
      return buildPlanView();

    case 'getAnalytics':
      return store.analytics(collectionId, Date.now());

    case 'getSettings':
      return { defaultAnswerMode: await store.getDefaultAnswerMode() };

    case 'setDefaultAnswerMode':
      await store.setDefaultAnswerMode(req.mode);
      void api.panels.postMessage({ type: 'planChanged' });
      return {};

    case 'setPassageAnswerMode':
      await store.setPassageAnswerMode(req.passageId, req.mode);
      void api.panels.postMessage({ type: 'planChanged' });
      return {};

    case 'getContext':
      return buildContext(req.passageId, { withholdAfter: false });

    case 'addPassage': {
      const passage = await addPassageFromReference(req.reference);
      return { passage };
    }

    case 'removePassage':
      await store.removePassage(req.passageId);
      await refreshStatusBar();
      return {};

    case 'startSession':
      return startSession(req.passageId, req.rung, req.restart ?? false);

    case 'submitStep':
      return submitStep(req.sessionId, req.answer);

    case 'endSession':
      // Abandoning a session records nothing beyond the resume point already
      // on disk. A user who closes the panel halfway through has not
      // demonstrated anything, and writing a partial score would punish them
      // for stopping.
      sessions.delete(req.sessionId);
      sessionStartedAt.delete(req.sessionId);
      return { summary: null };

    case 'navigateTo':
      await api.bible.navigateToVerse(req.verseId);
      return {};

    default: {
      const exhaustive: never = req;
      throw new Error(`Unknown request: ${JSON.stringify(exhaustive)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

async function buildPlanView(): Promise<PlanView> {
  const now = Date.now();
  const passages = await store.listPassages(collectionId);
  const siblingCount = passages.length;
  const views: PassageView[] = [];
  let totalDue = 0;

  for (const passage of passages) {
    const applicable = new Set(applicableRungs(passage.verseCount, siblingCount));
    const cards = await store.listCards(passage.id);
    const rungs: RungView[] = [];
    let bestLevel = 0;
    let dueCount = 0;

    for (const c of cards) {
      const isApplicable = applicable.has(c.rung);
      const level = levelFromScore(c.lastScore);
      if (isApplicable) {
        bestLevel = Math.max(bestLevel, level);
        if (isDue(c.dueAt, now)) dueCount += 1;
      }

      const totalSteps = totalStepsFor(c.rung, passage.verseCount);
      const resumeRow = await store.getResume(c.id);
      const resume =
        resumeRow && resumeRow.cursor > 0 && resumeRow.cursor < totalSteps
          ? { stepsDone: resumeRow.cursor, totalSteps }
          : null;

      rungs.push({
        rung: c.rung,
        level,
        dueAt: c.dueAt,
        streak: c.streak,
        lastScore: c.lastScore,
        applicable: isApplicable,
        resume,
      });
    }

    totalDue += dueCount;
    views.push({
      passage,
      rungs,
      dueCount,
      bestLevel,
      wellLearned: bestLevel >= WELL_LEARNED_LEVEL,
    });
  }

  return {
    collectionId,
    collectionName: DEFAULT_COLLECTION_NAME,
    passages: views,
    totalDue,
    defaultAnswerMode: await store.getDefaultAnswerMode(),
  };
}

/**
 * How many verses (or ordering placements) one pass through a rung takes.
 *
 * Mirrors `Session#totalSteps` (`session.ts`) - kept in sync by hand because
 * this is computed for a passage screen's paused-activity display, where no
 * `Session` object exists to ask directly. The first verse is a real pick
 * now, not given away for free, so `ordering` is `verseCount`, not
 * `verseCount - 1` - see `session.ts#prepareStep`'s note.
 */
function totalStepsFor(rung: Rung, verseCount: number): number {
  if (rung === 'ordering') return Math.max(1, verseCount);
  if (rung === 'refmatch') return 1;
  return verseCount;
}

/**
 * Fetch a passage and the verses around it.
 *
 * `withholdAfter` is the one place the "context is real text" decision needs a
 * caveat. Rendering the surrounding verses as actual scripture is right - it
 * is what the user asked for, and it is how the passage is really encountered
 * - but during an exercise the verses *after* the working point are the
 * answer. The ordering picker would be trivially solvable by reading ahead. So
 * they are withheld by the worker rather than merely hidden by the panel: a
 * panel that never receives them cannot leak them through a stylesheet.
 */
async function buildContext(
  passageId: number,
  opts: { withholdAfter: boolean },
): Promise<PassageContext> {
  const passage = await store.getPassage(passageId);
  if (!passage) throw new Error('That passage is no longer in your plan.');

  const verses = await fetchVerses(passage.startVerseId, passage.endVerseId, passage.moduleId);

  const before = await fetchVersesSafely(
    passage.startVerseId - CONTEXT_VERSES,
    passage.startVerseId - 1,
    passage.moduleId,
  );

  const after = opts.withholdAfter
    ? []
    : await fetchVersesSafely(
        passage.endVerseId + 1,
        passage.endVerseId + CONTEXT_VERSES,
        passage.moduleId,
      );

  return { passageId, reference: passage.reference, before, verses, after };
}

async function fetchVerses(start: number, end: number, moduleId: string): Promise<VerseText[]> {
  const dtos = await api.bible.getRange(start, end, { module: moduleId });
  return dtos.map((d: BibleVerseDto) => toVerseText(d, labelFor(d.verseId)));
}

/**
 * Fetch context verses, tolerating a range that runs off the end of a book.
 *
 * A passage at a book boundary has no neighbours, and the host is entitled to
 * refuse the range rather than return fewer verses. Missing context is a
 * cosmetic loss; a thrown error here would take out the whole practice view.
 */
async function fetchVersesSafely(
  start: number,
  end: number,
  moduleId: string,
): Promise<VerseText[]> {
  if (end < start) return [];
  try {
    return await fetchVerses(start, end, moduleId);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Adding passages
// ---------------------------------------------------------------------------

/**
 * The module new passages are recorded against: the translation the reader is
 * in (from the context menu, else the active-verse event), falling back to the
 * first installed module when the host has not said.
 *
 * Returns the abbreviation rather than `id`. Both resolve in `getRange` on
 * current hosts, but earlier hosts resolve only the abbreviation - their `id`
 * was a registry row number that read back as an empty range.
 */
async function activeModuleId(preferred: string | null | undefined = activeModule): Promise<string> {
  const modules = await api.bible.listModules();
  const match = preferred
    ? modules.find((m) => m.abbreviation === preferred || m.id === preferred)
    : undefined;
  const chosen = match ?? modules[0];
  if (!chosen) throw new Error('No Bible module is installed.');
  return chosen.abbreviation;
}

/**
 * The verses a `verse` context menu item was opened on, from the `args.verse`
 * the host merges in: a contiguous run within one chapter becomes a range,
 * anything else just its first verse. Null when the host sent nothing - a
 * palette invocation, or an older host.
 */
export function versesFromMenuArgs(
  args: unknown,
): { start: number; end: number; module?: string } | null {
  const verse = (args as { verse?: unknown } | null | undefined)?.verse as
    | { verseId?: unknown; verseIds?: unknown; module?: unknown }
    | undefined;
  if (!verse || typeof verse.verseId !== 'number') return null;
  const module = typeof verse.module === 'string' && verse.module !== '' ? verse.module : undefined;

  const ids = (Array.isArray(verse.verseIds) ? verse.verseIds : [])
    .filter((n): n is number => typeof n === 'number')
    .sort((a, b) => a - b);
  const first = ids[0];
  const last = ids[ids.length - 1];
  const contiguous =
    first !== undefined &&
    last !== undefined &&
    ids.length <= MAX_PASSAGE_VERSES &&
    ids.every((id, i) => i === 0 || id === ids[i - 1]! + 1) &&
    Math.floor(first / CHAPTER_FACTOR) === Math.floor(last / CHAPTER_FACTOR);
  return contiguous
    ? { start: first, end: last, ...(module ? { module } : {}) }
    : { start: verse.verseId, end: verse.verseId, ...(module ? { module } : {}) };
}

async function addPassageFromReference(reference: string) {
  const moduleId = await activeModuleId();
  const resolved = await resolveReference(api, reference, moduleId);
  const now = Date.now();

  const { passage, created } = await store.addPassage(
    {
      collectionId,
      moduleId,
      startVerseId: resolved.startVerseId,
      endVerseId: resolved.endVerseId,
      reference: resolved.reference,
      verseCount: resolved.verseCount,
      addedAt: now,
    },
  );

  if (created) await refreshStatusBar();
  void api.panels.postMessage({ type: 'planChanged' });
  return passage;
}

/** The context-menu path: add whatever single verse the user right-clicked. */
async function addPassageFromVerseId(
  startVerseId: number,
  endVerseId = startVerseId,
  preferredModule?: string,
): Promise<void> {
  const moduleId = await activeModuleId(preferredModule ?? activeModule);
  const now = Date.now();

  const { created } = await store.addPassage(
    {
      collectionId,
      moduleId,
      startVerseId,
      endVerseId,
      reference: referenceFor(startVerseId, endVerseId),
      verseCount: endVerseId - startVerseId + 1,
      addedAt: now,
    },
  );

  await refreshStatusBar();
  void api.panels.postMessage({ type: 'planChanged' });
  await api.ui.showNotification(
    created ? 'Added to your memorization plan.' : 'That verse is already in your plan.',
  );
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

/**
 * Start practising one rung of one passage.
 *
 * `rung` is used to start a specific activity (the passage screen's own
 * buttons always pass one); when omitted - "Start practicing" on the home
 * screen for a passage it has already chosen - `suggestedRungForPassage`
 * picks the same activity the passage screen would badge "Suggested".
 *
 * There is no more `replay` distinction: nothing is locked, so every attempt
 * here is a live one and reschedules its card in `finishSession`.
 */
async function startSession(passageId: number, rung: Rung | undefined, restart: boolean) {
  const passage = await store.getPassage(passageId);
  if (!passage) throw new Error('That passage is no longer in your plan.');

  const siblings = (await store.listPassages(collectionId)).filter((p) => p.id !== passageId);
  const applicable = applicableRungs(passage.verseCount, siblings.length + 1);

  const now = Date.now();
  const chosen = rung ?? (await suggestedRungForPassage(passage, applicable, now));
  if (!applicable.includes(chosen)) {
    throw new Error('That exercise does not apply to this passage.');
  }

  const card = await store.getCard(passageId, chosen);
  if (!card) throw new Error('That exercise has not been set up for this passage.');

  if (restart) await store.clearResume(card.id);
  const resumeRow = restart ? undefined : await store.getResume(card.id);

  const verses = await fetchVerses(passage.startVerseId, passage.endVerseId, passage.moduleId);
  const answerMode: AnswerMode = passage.answerMode ?? (await store.getDefaultAnswerMode());

  const session = new Session({
    sessionId: nextSessionId(),
    passageId,
    cardId: card.id,
    rung: chosen,
    verses,
    siblings: siblings.map((p) => ({ passageId: p.id, reference: p.reference })),
    self: { passageId, reference: passage.reference },
    answerMode,
    rng: makeRng(now ^ passageId),
    resume: resumeRow
      ? {
          cursor: resumeRow.cursor,
          correctFirstUnits: resumeRow.correctFirst,
          gradedUnits: resumeRow.gradedUnits,
        }
      : undefined,
  });

  sessions.set(session.sessionId, session);
  sessionStartedAt.set(session.sessionId, now);
  return session.view();
}

/**
 * The activity a passage's own "Practice" / "Start practicing" button starts
 * when the caller has not named one: whichever applicable rung is due
 * soonest; failing that, the first applicable rung that has not reached
 * "well learned"; failing that (everything mastered), the hardest rung, as an
 * upkeep suggestion. This never returns nothing - unlike v0, there is no
 * "everything is locked or mastered" dead end.
 */
async function suggestedRungForPassage(
  passage: Passage,
  applicable: Rung[],
  now: number,
): Promise<Rung> {
  let dueBest: { rung: Rung; dueAt: number } | null = null;
  const levels = new Map<Rung, number>();

  for (const rung of applicable) {
    const card = await store.getCard(passage.id, rung);
    if (!card) continue;
    levels.set(rung, levelFromScore(card.lastScore));
    if (isDue(card.dueAt, now) && (dueBest === null || (card.dueAt as number) < dueBest.dueAt)) {
      dueBest = { rung, dueAt: card.dueAt as number };
    }
  }
  if (dueBest) return dueBest.rung;

  for (const rung of applicable) {
    if ((levels.get(rung) ?? 0) < WELL_LEARNED_LEVEL) return rung;
  }
  return applicable[applicable.length - 1] as Rung;
}

async function submitStep(sessionId: string, answer: StepAnswer) {
  const session = sessions.get(sessionId);
  if (!session) throw new Error('That practice session has ended. Start it again.');

  const result = session.submit(answer);
  let summary: SessionSummary | null = null;

  if (session.isFinished) {
    summary = await finishSession(session);
    sessions.delete(sessionId);
    sessionStartedAt.delete(sessionId);
  } else {
    // Written after each verse (or ordering placement), not on every
    // keystroke - see the `resume_state` note in `db.ts`.
    await store.saveResume(
      session.cardId,
      {
        cursor: session.cursorIndex,
        correctFirst: session.correctFirst,
        gradedUnits: session.gradedTotal,
      },
      Date.now(),
    );
  }

  return { result, session: session.view(), summary };
}

/**
 * Record the attempt and reschedule.
 *
 * Every finished session reaches this now - there is no "was this a replay"
 * branch left. See the task 0004 review, point 4: nothing is locked, so there
 * is no "ahead of schedule" attempt left to treat specially.
 */
async function finishSession(session: Session): Promise<SessionSummary> {
  const now = Date.now();
  const score = session.score;
  const startedAt = sessionStartedAt.get(session.sessionId) ?? now;

  await store.recordAttempt({
    cardId: session.cardId,
    at: now,
    score,
    correctFirst: session.correctFirst,
    totalSteps: session.gradedTotal,
    durationMs: Math.max(0, now - startedAt),
  });
  await store.clearResume(session.cardId);

  const card = await store.getCard(session.passageId, session.rung);
  if (!card) throw new Error('That exercise disappeared mid-session.');

  const result = schedule({
    intervalStep: card.intervalStep,
    streak: card.streak,
    score,
    now,
    rng: makeRng(now ^ card.id),
  });
  await store.applySchedule(card.id, result, score);

  await refreshStatusBar();
  void api.panels.postMessage({ type: 'planChanged' });

  return {
    passageId: session.passageId,
    rung: session.rung,
    score,
    correctFirst: session.correctFirst,
    totalSteps: session.gradedTotal,
    nextDueAt: result.dueAt,
    level: levelFromScore(score),
    passageWellLearned: await isPassageWellLearned(session.passageId, session.rung, score),
  };
}

/**
 * Whether the passage is "well learned" after this attempt - the highest
 * level across every applicable rung, this attempt's included. See
 * `PassageView.bestLevel`: a level earned on one rung counts for the whole
 * passage without being written onto the others.
 */
async function isPassageWellLearned(
  passageId: number,
  justAttempted: Rung,
  justAttemptedScore: number,
): Promise<boolean> {
  const passage = await store.getPassage(passageId);
  if (!passage) return false;
  const siblingCount = (await store.listPassages(collectionId)).length;
  const applicable = applicableRungs(passage.verseCount, siblingCount);

  let bestLevel = levelFromScore(justAttemptedScore);
  for (const rung of applicable) {
    if (rung === justAttempted) continue;
    const card = await store.getCard(passageId, rung);
    if (card) bestLevel = Math.max(bestLevel, levelFromScore(card.lastScore));
  }
  return bestLevel >= WELL_LEARNED_LEVEL;
}
