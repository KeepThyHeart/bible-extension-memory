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

import type {
  BibleBookDto,
  BibleChapterDto,
  BibleExtensionAPI,
  BibleVerseDto,
  DisposableHandle,
  ParsedReferenceDto,
} from './bibleTypes';
import type {
  AnswerMode,
  Card,
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
import { MemoryStore, activityLevels, byCard, scopeOf } from './store';
import type { ScopeFacts, TierProgressRow } from './store';
import {
  applicableRungs,
  inRungOrder,
  levelForActivity,
  MIN_VERSES_FOR_REFERENCE_ACTIVITIES,
  passageWellLearned,
  summarizeActivity,
  TIERS,
  WELL_LEARNED_LEVEL,
} from './ladder';
import { schedule, makeRng, isDue } from './scheduler';
import { Session, nextSessionId, MAX_REFERENCE_STEPS } from './session';
import type { ReferenceCatalog } from './session';
import { toVerseText, CONTEXT_VERSES } from './verses';
import { resolveReference, ReferenceError, MAX_PASSAGE_VERSES } from './reference';
import { BOOK_GENRE, buildReferenceDistractors, type ReferencePoint } from './exercises/references';

const DB_NAME = 'memory';
const DEFAULT_COLLECTION_NAME = 'Default';
/**
 * The old default list's name, before T5 introduced multiple lists.
 *
 * Used only by `renameLegacyDefaultCollection`, the one-time activation
 * upgrade below - a database created before this task has exactly one
 * collection, still called this.
 */
const LEGACY_DEFAULT_COLLECTION_NAME = 'My plan';

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

/**
 * Build a labeller for one passage: bare verse numbers when both the passage
 * and the verse being labelled sit in the same single chapter, "chapter:verse"
 * otherwise.
 *
 * A single-chapter passage reads fine with bare numbers in its own margin,
 * but a context verse from the chapter before or after it does not belong to
 * that chapter - labelling it bare would misread as if it were part of the
 * passage's chapter. So the "bare number" shortcut only applies when the
 * passage itself is single-chapter *and* the verse being labelled is inside
 * that same chapter; everything else gets the fully qualified label.
 */
function makeLabeller(startVerseId: number, endVerseId: number): (verseId: number) => string {
  if (!verseIdEncodingTrusted) {
    return (verseId: number) => String(verseId);
  }
  const startChapter = Math.floor((startVerseId % BOOK_FACTOR) / CHAPTER_FACTOR);
  const endChapter = Math.floor((endVerseId % BOOK_FACTOR) / CHAPTER_FACTOR);
  const singleChapter = startChapter === endChapter ? startChapter : null;
  return (verseId: number) => {
    const chapter = Math.floor((verseId % BOOK_FACTOR) / CHAPTER_FACTOR);
    if (singleChapter !== null && chapter === singleChapter) {
      return String(verseId % CHAPTER_FACTOR);
    }
    return labelFor(verseId);
  };
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
/**
 * The Default list's id, set once at activation. Used only as the initial
 * value and by `renameLegacyDefaultCollection`; every other read that needs
 * "the Default list right now" goes through `resolveAddTargetCollectionId` /
 * `findDefaultListId` instead, because the Default list can itself be
 * deleted (its passages moved elsewhere) after activation, which would leave
 * this variable pointing at a row that no longer exists.
 */
let defaultCollectionId: number;
let activeVerseId: number | null = null;
/** Abbreviation of the translation the reader is in, from the active-verse event. */
let activeModule: string | null = null;
let statusBarHandle: DisposableHandle | null = null;
let lastStatusText: string | null = null;
const sessions = new Map<string, Session>();
/** When each in-flight session started, for the (currently unshown) duration column. */
const sessionStartedAt = new Map<string, number>();

/**
 * Book catalog and chapter-extent caches for `refmatch`'s distractor pool.
 *
 * `listBooks` is one call, fetched once and kept for the life of the
 * activation. `listChapters` is genuinely one host call PER BOOK - see its
 * own doc comment in `ExtensionApiTypes.d.ts` - so it is fetched lazily, only
 * for whichever books a session's tier actually needs (see
 * `buildReferenceCatalog`), and cached the same way so a book fetched for one
 * user's session is not re-fetched for the next.
 */
let bookCatalogCache: BibleBookDto[] | null = null;
const chaptersCache = new Map<number, BibleChapterDto[]>();

async function getBookCatalog(): Promise<BibleBookDto[]> {
  if (!bookCatalogCache) bookCatalogCache = await api.bible.listBooks();
  return bookCatalogCache;
}

async function getChaptersCached(bookNumber: number): Promise<BibleChapterDto[]> {
  const cached = chaptersCache.get(bookNumber);
  if (cached) return cached;
  const chapters = await api.bible.listChapters(bookNumber);
  chaptersCache.set(bookNumber, chapters);
  return chapters;
}

/**
 * The book/chapter/verse each of `verses` actually is, off the same trusted
 * verse-id encoding `labelFor` uses. Pure arithmetic, no host call - see
 * `session.ts#SessionOpts.referencePoints`'s doc comment for why `refmatch`
 * needs this rather than parsing `VerseText.label` back (which can be a bare
 * verse number for a single-chapter passage).
 */
function referencePointsFor(verses: VerseText[]): ReferencePoint[] {
  return verses.map((v) => ({
    bookNumber: Math.floor(v.verseId / BOOK_FACTOR),
    chapter: Math.floor((v.verseId % BOOK_FACTOR) / CHAPTER_FACTOR),
    verse: v.verseId % CHAPTER_FACTOR,
  }));
}

/**
 * How many distinct books a `refmatch` distractor pool samples, at tiers 0
 * and 1 - a bound on `listChapters` calls, not an exhaustive fetch of every
 * book in the canon or every book of a genre. Large enough that a real
 * session essentially never runs short (see the `< 3` check in
 * `startSession`), small enough that opening a fresh reference activity does
 * not fire a dozen-plus host calls in a row.
 */
const REFERENCE_POOL_BOOKS = 8;

/**
 * Build the pre-fetched distractor pool `refmatch` needs for one tier.
 *
 * Tier 2 (same book) only ever needs the correct verse's own book - one
 * `listChapters` call, cached forever after. Tiers 0/1 sample a bounded set
 * of candidate books (any book / same genre) and fetch each one's chapters,
 * also cached, so repeated sessions on the same tier cost nothing further.
 */
async function buildReferenceCatalog(
  correctBookNumber: number,
  tier: number,
  rng: () => number,
): Promise<ReferenceCatalog> {
  const books = await getBookCatalog();
  const bookNames: Record<number, string> = {};
  for (const b of books) {
    if (typeof b.name === 'string') bookNames[b.bookNumber] = b.name;
  }

  let candidates: BibleBookDto[];
  if (tier >= 2) {
    candidates = books.filter((b) => b.bookNumber === correctBookNumber);
  } else if (tier === 1) {
    const genre = BOOK_GENRE[correctBookNumber];
    candidates = shuffledBooks(
      books.filter((b) => BOOK_GENRE[b.bookNumber] === genre),
      rng,
    ).slice(0, REFERENCE_POOL_BOOKS);
  } else {
    candidates = shuffledBooks(books, rng).slice(0, REFERENCE_POOL_BOOKS);
  }
  // The correct book is always fetched, tier 2 or not: without it a step
  // could not even format its OWN correct answer's chapter/verse bounds.
  if (!candidates.some((b) => b.bookNumber === correctBookNumber)) {
    const correctBook = books.find((b) => b.bookNumber === correctBookNumber);
    if (correctBook) candidates = [correctBook, ...candidates];
  }

  const chapters: Record<number, { chapter: number; verseCount: number }[]> = {};
  for (const book of candidates) {
    const list = await getChaptersCached(book.bookNumber);
    chapters[book.bookNumber] = list.map((c) => ({
      chapter: c.chapter,
      verseCount: c.verseCount,
    }));
  }

  return {
    books: books.map((b) => ({ bookNumber: b.bookNumber, chapterCount: b.chapterCount })),
    chapters,
    bookNames,
  };
}

/** Fisher-Yates over a `BibleBookDto[]`, using the session's own injected RNG. */
function shuffledBooks(books: BibleBookDto[], rng: () => number): BibleBookDto[] {
  const out = books.slice();
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    const a = out[i] as BibleBookDto;
    out[i] = out[j] as BibleBookDto;
    out[j] = a;
  }
  return out;
}

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
    defaultCollectionId = await ensureDefaultCollection(db, DEFAULT_COLLECTION_NAME, Date.now());
    await renameLegacyDefaultCollection();
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
 * One-time, idempotent upgrade: a database created before T5 has exactly one
 * collection, still named the old default `'My plan'`. Rename it to
 * `'Default'` so it reads correctly under the new naming.
 *
 * Guarded on BOTH "exactly one list" and "still literally named the old
 * default" so this can never fire a second time (the name will not match
 * once it has been renamed) and never fires wrongly once the user has
 * created a second list or renamed the first one themselves - either of
 * which is a deliberate choice this upgrade must not undo.
 */
async function renameLegacyDefaultCollection(): Promise<void> {
  const collections = await store.listCollections();
  if (collections.length !== 1) return;
  if (collections[0]!.name !== LEGACY_DEFAULT_COLLECTION_NAME) return;
  await store.renameCollection(collections[0]!.id, DEFAULT_COLLECTION_NAME);
}

/**
 * The Default list's id right now, without creating anything - for display
 * purposes only (`buildPlanView`'s `collectionId` field). `undefined` when no
 * list is named `'Default'` (the user renamed or deleted it); callers that
 * need a real target to write into use `resolveAddTargetCollectionId`, which
 * creates one if it has to.
 */
function findDefaultListId(lists: { id: number; name: string }[]): number | undefined {
  return lists.find((c) => c.name === DEFAULT_COLLECTION_NAME)?.id;
}

/**
 * Where `addPassage` should land right now: the currently scoped list, or -
 * scope `'all'` - the Default list, created fresh if something has deleted
 * it since activation.
 */
async function resolveAddTargetCollectionId(): Promise<number> {
  const scope = await store.getScope();
  if (scope.kind === 'list') return scope.id;

  const lists = await store.listCollections();
  const existing = findDefaultListId(lists);
  if (existing !== undefined) return existing;
  const created = await store.createCollection(DEFAULT_COLLECTION_NAME, Date.now());
  return created.id;
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
    // Same global choice as `refreshStatusBar`: this command is reached from
    // the palette or the status bar item, neither of which is scoped to one
    // list.
    const next = await store.nextDueCard({ kind: 'all' }, Date.now());
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
  // Global on purpose: the status bar item is a system-wide reminder, not a
  // reflection of whatever list a panel happens to have scoped right now -
  // and a panel need not even be open for it to matter.
  const count = await store.dueCount({ kind: 'all' }, Date.now());
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
      return store.analytics(await store.getScope(), Date.now());

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

    case 'resetPassageProgress':
      // The only action that can lower a level. `Date.now()` is the reset
      // boundary and attempts are compared strictly against it, so a session
      // finishing in the same millisecond belongs to the run being discarded
      // - see `store.ts#listTierProgress`.
      await store.resetPassageProgress(req.passageId, Date.now());
      await refreshStatusBar();
      void api.panels.postMessage({ type: 'planChanged' });
      // Unlike `removePassage`, the reply carries the rebuilt plan: the
      // screen that asked is showing the levels that just changed, and
      // waiting for the push to come round would flash the old ones.
      return buildPlanView();

    case 'startSession':
      return startSession(req.passageId, req.rung, req.restart ?? false, req.tier);

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

    case 'getPassageView':
      return buildPassageView(req.passageId);

    case 'createList':
      await store.createCollection(req.name, Date.now());
      void api.panels.postMessage({ type: 'planChanged' });
      return buildPlanView();

    case 'renameList':
      await store.renameCollection(req.id, req.name);
      void api.panels.postMessage({ type: 'planChanged' });
      return buildPlanView();

    case 'deleteList':
      // Throws a readable error (and touches nothing) when `req.id` is the
      // only list - see `store.ts#deleteCollection`. Passages, cards and
      // attempt history all move to `movePassagesTo` first.
      await store.deleteCollection(req.id, req.movePassagesTo);
      await refreshStatusBar();
      void api.panels.postMessage({ type: 'planChanged' });
      return buildPlanView();

    case 'movePassage':
      await store.movePassage(req.passageId, req.collectionId);
      await refreshStatusBar();
      void api.panels.postMessage({ type: 'planChanged' });
      return buildPlanView();

    case 'setScope':
      await store.setScope(req.scope);
      void api.panels.postMessage({ type: 'planChanged' });
      return buildPlanView();

    default: {
      const exhaustive: never = req;
      throw new Error(`Unknown request: ${JSON.stringify(exhaustive)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

/**
 * One passage's ladder, as both the plan list and the passage screen need it.
 *
 * Factored out of `buildPlanView` so `getPassageView` can build a single
 * passage's view (`buildPassageView`) without fetching every other passage in
 * the plan to get there - the whole point of that request existing (see
 * `types.ts#RequestMap.getPassageView`).
 */
async function assemblePassageView(
  passage: Passage,
  cards: Card[],
  tierRows: Map<number, TierProgressRow[]>,
  scope: ScopeFacts,
  now: number,
): Promise<PassageView> {
  const applicable = new Set(
    applicableRungs(passage.verseCount, scope.siblingCount, scope.scopeVerseCount),
  );
  const rungs: RungView[] = [];
  let bestLevel = 0;
  let dueCount = 0;

  for (const c of cards) {
    const isApplicable = applicable.has(c.rung);
    // The level is derived from per-tier bests over the whole history, not
    // from `c.lastScore`. That is what makes it non-regressing: a bad
    // session below still moves `dueAt` closer without moving this number.
    const progress = summarizeActivity(c.rung, tierRows.get(c.id) ?? []);
    const level = levelForActivity(progress);
    if (isApplicable) {
      bestLevel = Math.max(bestLevel, level);
      if (isDue(c.dueAt, now)) dueCount += 1;
    }

    // `totalStepsFor` needs the resume row's OWN tier, not the tier a fresh
    // session would auto-select: `blanks` has a different step count per
    // tier, so sizing this against today's suggested tier could make a
    // perfectly valid tier-0 resume point read as "past the end" (or vice
    // versa) the moment `nextTier` moves on.
    const resumeRow = await store.getResume(c.id);
    const totalSteps = totalStepsFor(c.rung, passage.verseCount, resumeRow?.tier ?? 0);
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
      tiers: progress.totalTiers,
      tiersPassed: progress.tiersPassed,
      bestScore: progress.bestScore,
      attempts: progress.attempts,
      nextTier: progress.nextTier,
    });
  }

  return {
    passage,
    rungs: inRungOrder(rungs),
    dueCount,
    bestLevel,
    // Not `bestLevel >= 4` any more: every applicable activity has to be
    // satisfied, and an empty applicable set is never satisfied - see
    // `PassageView.wellLearned`.
    wellLearned: passageWellLearned(rungs),
  };
}

async function buildPlanView(): Promise<PlanView> {
  const now = Date.now();
  const scope = await store.getScope();
  const passages = await store.listPassagesInScope(scope);
  const scopeFacts = scopeOf(passages);
  // One query for the whole plan's attempt history, reduced in SQL. A plan of
  // thirty passages is ~150 cards, and every one of their levels is needed to
  // draw the list.
  const tierRows = byCard(await store.listTierProgress(passages.map((p) => p.id)));
  const views: PassageView[] = [];
  let totalDue = 0;

  for (const passage of passages) {
    const cards = await store.listCards(passage.id);
    const view = await assemblePassageView(passage, cards, tierRows, scopeFacts, now);
    totalDue += view.dueCount;
    views.push(view);
  }

  const lists = await store.listCollections();
  const scopedListId = scope.kind === 'list' ? scope.id : findDefaultListId(lists);
  const scopedList = scopedListId !== undefined ? lists.find((l) => l.id === scopedListId) : undefined;

  return {
    // The list `addPassage` would target right now - see the field's own doc
    // comment in `types.ts` for why this is kept rather than dropped.
    collectionId: scopedListId ?? defaultCollectionId,
    collectionName: scopedList ? scopedList.name : 'All lists',
    lists,
    scope: scope.kind === 'all' ? 'all' : scope.id,
    scopeVerseCount: scopeFacts.scopeVerseCount,
    referenceActivitiesUnlocked: scopeFacts.scopeVerseCount >= MIN_VERSES_FOR_REFERENCE_ACTIVITIES,
    passages: views,
    totalDue,
    defaultAnswerMode: await store.getDefaultAnswerMode(),
  };
}

/**
 * One passage's view on its own, for `getPassageView` - without rebuilding
 * the whole plan just to find one row in it, the inefficiency the request was
 * added to avoid.
 *
 * Scoped to the passage's OWN list, not the panel's current browsing scope:
 * a passage's applicable activities are a property of the list it actually
 * belongs to (D2(i) - a passage lives in exactly one list), not of whatever
 * the plan list happens to be filtered to when this is requested.
 */
async function buildPassageView(passageId: number): Promise<PassageView> {
  const passage = await store.getPassage(passageId);
  if (!passage) throw new Error('That passage is no longer in your plan.');

  const siblings = await store.listPassages(passage.collectionId);
  const scopeFacts = scopeOf(siblings);
  const cards = await store.listCards(passage.id);
  const tierRows = byCard(await store.listTierProgress([passage.id]));

  return assemblePassageView(passage, cards, tierRows, scopeFacts, Date.now());
}

/**
 * How many verses (or ordering placements) one pass through a rung takes.
 *
 * `tier` only matters for `blanks`: tier 1 is one step for the whole passage
 * regardless of `verseCount`, mirroring `Session#totalSteps` in `session.ts`.
 */
function totalStepsFor(rung: Rung, verseCount: number, tier = 0): number {
  if (rung === 'ordering') return Math.max(1, verseCount - 1);
  // One question per verse of the passage, capped - see `session.ts`'s
  // `MAX_REFERENCE_STEPS` and `Session#verseSteps`, which this mirrors.
  if (rung === 'refmatch' || rung === 'refprovide') {
    return Math.min(Math.max(1, verseCount), MAX_REFERENCE_STEPS);
  }
  if (rung === 'blanks' && tier >= 1) return 1;
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

  const label = makeLabeller(passage.startVerseId, passage.endVerseId);

  const verses = await fetchVerses(passage.startVerseId, passage.endVerseId, passage.moduleId, label);

  const before = await fetchVersesSafely(
    passage.startVerseId - CONTEXT_VERSES,
    passage.startVerseId - 1,
    passage.moduleId,
    label,
  );

  const after = opts.withholdAfter
    ? []
    : await fetchVersesSafely(
        passage.endVerseId + 1,
        passage.endVerseId + CONTEXT_VERSES,
        passage.moduleId,
        label,
      );

  return { passageId, reference: passage.reference, before, verses, after };
}

async function fetchVerses(
  start: number,
  end: number,
  moduleId: string,
  label: (verseId: number) => string = labelFor,
): Promise<VerseText[]> {
  const dtos = await api.bible.getRange(start, end, { module: moduleId });
  return dtos.map((d: BibleVerseDto) => toVerseText(d, label(d.verseId)));
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
  label: (verseId: number) => string = labelFor,
): Promise<VerseText[]> {
  if (end < start) return [];
  try {
    return await fetchVerses(start, end, moduleId, label);
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
  const targetCollectionId = await resolveAddTargetCollectionId();

  const { passage, created } = await store.addPassage(
    {
      collectionId: targetCollectionId,
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
  const targetCollectionId = await resolveAddTargetCollectionId();

  const { created } = await store.addPassage(
    {
      collectionId: targetCollectionId,
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
async function startSession(
  passageId: number,
  rung: Rung | undefined,
  restart: boolean,
  tier?: number,
) {
  const passage = await store.getPassage(passageId);
  if (!passage) throw new Error('That passage is no longer in your plan.');

  // The passage's own list, not the panel's current browsing scope - see
  // `buildPassageView`'s doc comment for why applicability is anchored to a
  // passage's actual list (D2(i)) rather than to whatever is being viewed.
  const all = await store.listPassages(passage.collectionId);
  const scope = scopeOf(all);
  const applicable = applicableRungs(
    passage.verseCount,
    scope.siblingCount,
    scope.scopeVerseCount,
  );

  const now = Date.now();
  const chosen = rung ?? (await suggestedRungForPassage(passage, applicable, now));
  if (!applicable.includes(chosen)) {
    throw new Error('That exercise does not apply to this passage.');
  }

  const card = await store.getCard(passageId, chosen);
  if (!card) throw new Error('That exercise has not been set up for this passage.');

  // Resolved decision D4: omitted, serve the lowest tier not yet passed (or
  // the hardest tier once every tier has been passed) - the same computation
  // `RungView.nextTier` exposes for display, via the same `summarizeActivity`
  // helper. Given explicitly, the tier is validated rather than clamped: a
  // stale or malicious panel request for a tier that does not exist gets a
  // readable error, not a silently different exercise.
  const totalTiers = TIERS[chosen];
  let selectedTier: number;
  if (tier !== undefined) {
    if (!Number.isInteger(tier) || tier < 0 || tier >= totalTiers) {
      throw new Error(
        `That difficulty tier does not exist for this exercise ` +
          `(it has ${totalTiers} tier${totalTiers === 1 ? '' : 's'}).`,
      );
    }
    selectedTier = tier;
  } else {
    const tierRows = byCard(await store.listTierProgress([passageId]));
    selectedTier = summarizeActivity(chosen, tierRows.get(card.id) ?? []).nextTier;
  }

  if (restart) await store.clearResume(card.id);
  let resumeRow = restart ? undefined : await store.getResume(card.id);
  // A resume point taken at a different tier cannot be reapplied here: tiers
  // can have different step counts and different candidate sets (`ordering`,
  // `blanks`), so its `cursor` would either be misinterpreted or point past
  // an activity that no longer has that many steps. Switching tier drops the
  // stale resume rather than misapplying it - the user restarts that tier's
  // activity from the top, same as an explicit `restart`.
  if (resumeRow && resumeRow.tier !== selectedTier) {
    await store.clearResume(card.id);
    resumeRow = undefined;
  }

  const verses = await fetchVerses(
    passage.startVerseId,
    passage.endVerseId,
    passage.moduleId,
    makeLabeller(passage.startVerseId, passage.endVerseId),
  );
  const answerMode: AnswerMode = passage.answerMode ?? (await store.getDefaultAnswerMode());

  // `refmatch` needs a pre-fetched distractor pool (see `buildReferenceCatalog`)
  // and a sanity check that the pool is not degenerate; `refprovide` needs the
  // host's own reference parser, injected rather than reached into directly so
  // grading stays inside `Session` alongside every other rung's grading. Both
  // are built here, in the worker, from the worker's own host API access -
  // never something the panel could supply or fake.
  let referencePoints: ReferencePoint[] | undefined;
  let referenceCatalog: ReferenceCatalog | undefined;
  let parseReferenceFn: ((input: string) => Promise<ParsedReferenceDto | null>) | undefined;

  if (chosen === 'refmatch') {
    referencePoints = referencePointsFor(verses);
    const correctBook = referencePoints[0]?.bookNumber;
    if (correctBook === undefined) {
      throw new Error('That passage has no verses to match a reference against.');
    }
    referenceCatalog = await buildReferenceCatalog(
      correctBook,
      selectedTier,
      makeRng(now ^ passageId ^ 0x5eed),
    );
    // Item 4 of the task: `applicableRungs` cannot know how many distinct
    // references its own pool can generate (it has no host access), so the
    // floor it is gated on there is only a cheap proxy. This is the real
    // check, against the actual fetched pool, right before a session that
    // could not be answered meaningfully would otherwise be served.
    const sample = buildReferenceDistractors({
      correct: referencePoints[0] as ReferencePoint,
      tier: selectedTier,
      books: referenceCatalog.books,
      chapters: referenceCatalog.chapters,
      bookNames: referenceCatalog.bookNames,
      count: 3,
      rng: makeRng(now ^ passageId ^ 0xc0ffee),
    });
    if (sample.length < 3) {
      throw new Error(
        'Not enough distinct references are available for this exercise yet.',
      );
    }
  } else if (chosen === 'refprovide') {
    parseReferenceFn = (input: string) => api.bible.parseReference(input);
  }

  const session = new Session({
    sessionId: nextSessionId(),
    passageId,
    cardId: card.id,
    rung: chosen,
    tier: selectedTier,
    verses,
    referencePoints,
    referenceCatalog,
    parseReference: parseReferenceFn,
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
  const tierRows = byCard(await store.listTierProgress([passage.id]));

  for (const rung of applicable) {
    const card = await store.getCard(passage.id, rung);
    if (!card) continue;
    // The same derived level the plan screen shows. Reading `lastScore` here
    // instead would suggest an activity the user's own screen says is
    // finished, on the strength of one bad session.
    levels.set(rung, levelForActivity(summarizeActivity(rung, tierRows.get(card.id) ?? [])));
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

  // `submit` is async because `refprovide` grades against a host round trip
  // (`api.bible.parseReference`) - see `session.ts#Session.submit`. A parse
  // failure thrown by the host is not caught here: it propagates out of this
  // function, back through `dispatch`, to `handlePanelMessage`'s top-level
  // catch, which turns it into a readable `{ ok: false }` reply without
  // losing the session - the same path every other worker-side error uses.
  const result = await session.submit(answer);
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
        tier: session.tier,
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
    tier: session.tier,
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

  // Read back AFTER the attempt row was written, so the level reported here
  // is the same one the plan view will show a moment later. Reporting
  // `levelFromScore(score)` - what v1 did - would now contradict the screen
  // the user lands on: this attempt's score is only one input to the level.
  const tierRows = byCard(await store.listTierProgress([session.passageId]));
  const level = levelForActivity(
    summarizeActivity(session.rung, tierRows.get(card.id) ?? []),
  );

  return {
    passageId: session.passageId,
    rung: session.rung,
    tier: session.tier,
    tiers: TIERS[session.rung],
    score,
    correctFirst: session.correctFirst,
    totalSteps: session.gradedTotal,
    nextDueAt: result.dueAt,
    level,
    passageWellLearned: await isPassageWellLearned(session.passageId),
  };
}

/**
 * Whether the passage is "well learned" - EVERY applicable activity
 * satisfied, over a non-empty set.
 *
 * This replaces v1's "the best applicable rung reached level 4". The old rule
 * let one mastered activity speak for activities the user had never opened;
 * the new one only lets a *harder* activity speak for an easier one, and only
 * inside the text-recall chain (`ladder.ts#TEXT_RECALL_CHAIN`), because
 * reciting a passage from first letters really does demonstrate the ordering
 * and the missing words, while knowing its words says nothing about knowing
 * its address.
 *
 * Called after the attempt has been recorded, so nothing needs to be passed
 * in about the session that just finished - it is already part of the
 * history this reads.
 */
async function isPassageWellLearned(passageId: number): Promise<boolean> {
  const passage = await store.getPassage(passageId);
  if (!passage) return false;
  const scope = scopeOf(await store.listPassages(passage.collectionId));
  const cards = await store.listCards(passageId);
  const tierRows = byCard(await store.listTierProgress([passageId]));
  return passageWellLearned(activityLevels(passage, cards, tierRows, scope));
}
