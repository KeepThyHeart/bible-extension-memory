/**
 * @vitest-environment jsdom
 *
 * Rendering tests: the part of the panel that had never been executed.
 *
 * `panel.test.ts` covers the panel's *decisions* - which card is next, how a
 * date reads, how an ambiguous `StepResult` maps back onto answers - and says
 * in its own header that none of the rendering, none of the event handling and
 * none of the measurement is covered because "those need a browser". They do,
 * and this file supplies one. The exercises are what the extension is for and
 * essentially all of their behaviour lives in the DOM, so a suite that stops at
 * the pure helpers is testing the easy half.
 *
 * The pragma above turns on `jsdom` for this file only rather than changing
 * `vitest.config.ts`: the rest of the suite is deliberately DOM-free (see the
 * note at the top of `format.ts`) and giving every test a document would
 * quietly remove the pressure that keeps the logic testable.
 *
 * WHAT IS ASSERTED, AND WHAT IS NOT. These tests assert what a user would
 * experience - the words on screen, which element is distinguished from its
 * neighbours, what a screen reader would be given, whether an input is sized to
 * its word - and avoid asserting on class names or markup shape wherever the
 * behaviour can be reached another way. Class names are used to *locate* nodes
 * in a couple of places where nothing else identifies them; they are not the
 * thing being checked.
 *
 * WHAT JSDOM CANNOT DO, stated once here rather than implied at each site:
 *
 *   - It has no layout engine. Every `getBoundingClientRect()` is zero, which
 *     is exactly the condition `WordMeasurer.measure` documents as "the panel
 *     is not being laid out" and falls back from. So the width assertions
 *     below exercise the documented fallback (`estimateTextWidth`) and check
 *     that it is proportional and respects its floor. A real pixel width for a
 *     real font cannot be produced here and is not claimed.
 *   - It does not resolve `var()`. Computed colours come back as the literal
 *     token reference, so "is this red?" is answered by following the token to
 *     the hex fallback declared in `styles.css`.
 *   - It does not evaluate `::after { content }`. The ✗ on a *picker*
 *     candidate is drawn that way, so the picker tests assert the candidate is
 *     visually distinguished from its siblings rather than looking for a glyph
 *     that jsdom will never generate. (The ✗ inside a missed *word* is a real
 *     text node and is asserted directly.)
 *
 * The panel's real stylesheet is loaded into the document, because several of
 * the decisions being guarded here - poetry indentation, context that is legible
 * rather than blurred, and above all the absence of any strike-through - are
 * expressed in CSS and would be reintroduced there, not in TypeScript.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  AnalyticsView,
  AnswerMode,
  BlanksStep,
  CollectionView,
  FirstLettersStep,
  OrderingStep,
  PanelReply,
  PanelRequest,
  Passage,
  PassageContext,
  PassageSortOrder,
  PassageView,
  PlanView,
  RequestMap,
  Rung,
  RungView,
  SessionView,
  SettingsView,
  Step,
  StepResult,
  VerseText,
} from '../src/types';
import type { PanelHost } from '../src/ui/host';
import type { Flow, NavAction } from '../src/ui/state';
import {
  breadcrumb,
  icon,
  menu as menuComponent,
  modal,
  type Crumb,
  type IconName,
} from '../src/ui/components';
import { WordMeasurer, blankWidthFor, estimateTextWidth, MIN_BLANK_WIDTH_PX } from '../src/ui/measure';
import { ACTIVITY_TILES } from '../src/ui/activities';
import { SUGGESTED_LISTS } from '../src/ui/suggestedLists';
import { renderPassage } from '../src/ui/scripture';
import { PracticeView } from '../src/ui/practiceView';
import { renderPlan } from '../src/ui/planView';
import { renderPassageScreen } from '../src/ui/passageView';
import { renderSettings } from '../src/ui/settingsView';
import { renderAnalytics } from '../src/ui/analyticsView';
import { renderManage } from '../src/ui/manageView';

// ---------------------------------------------------------------------------
// The panel's own stylesheet
// ---------------------------------------------------------------------------

const STYLESHEET_PATH = resolve(process.cwd(), 'ui', 'styles.css');
const STYLESHEET_TEXT = readFileSync(STYLESHEET_PATH, 'utf8');

/**
 * Every style rule in the sheet, flattened out of its `@media` blocks.
 *
 * Captured once, before the hover rules are pruned (see `installStylesheet`),
 * and read from parsed rules rather than the raw file text: the file's own
 * header comment contains the words "line-through" while promising there is no
 * such declaration, so a text search would report the promise as a violation of
 * itself.
 */
const ALL_RULE_TEXTS: string[] = [];

function eachStyleRule(rules: CSSRuleList, visit: (rule: CSSStyleRule) => void): void {
  for (const rule of Array.from(rules)) {
    if (rule instanceof CSSStyleRule) visit(rule);
    const grouping = rule as CSSRule & { cssRules?: CSSRuleList };
    if (grouping.cssRules) eachStyleRule(grouping.cssRules, visit);
  }
}

/** Drops `:hover` / `:active` rules from a sheet or an `@media` block. */
function pruneHoverRules(container: CSSStyleSheet | CSSGroupingRule): void {
  const rules = container.cssRules;
  for (let i = rules.length - 1; i >= 0; i--) {
    const rule = rules.item(i)!;
    if (rule instanceof CSSStyleRule && /:hover|:active/.test(rule.selectorText)) {
      container.deleteRule(i);
      continue;
    }
    const grouping = rule as CSSRule & { cssRules?: CSSRuleList; deleteRule?: unknown };
    if (grouping.cssRules && typeof grouping.deleteRule === 'function') {
      pruneHoverRules(rule as CSSGroupingRule);
    }
  }
}

/**
 * Loads the panel's real stylesheet, then removes its `:hover` and `:active`
 * rules.
 *
 * The removal is a harness fix, not a statement about the panel. jsdom resolves
 * `:hover` against the focused element, so a control that has just been given
 * focus - which the picker does deliberately after a wrong pick - computes as
 * permanently hovered, and any test asking "does this element look different
 * from its siblings?" would then be answering a question about focus. The
 * hover rules are still captured for the strike-through scan below.
 */
function installStylesheet(): void {
  const style = document.createElement('style');
  style.textContent = STYLESHEET_TEXT;
  document.head.appendChild(style);

  const sheet = style.sheet as CSSStyleSheet;
  eachStyleRule(sheet.cssRules, (rule) => ALL_RULE_TEXTS.push(rule.cssText));
  pruneHoverRules(sheet);
}

/**
 * Follows a custom property to the hex it ultimately falls back to.
 *
 * jsdom does not resolve `var()`, so a computed colour arrives as the literal
 * string `var(--sm-danger)`. The tokens in `styles.css` are all of the form
 * `var(--theme-x, #rrggbb)` - the host's theme if it is there, a stated hex if
 * it is not - so the hex is what this panel renders when it is opened outside
 * the host, and it is the only concrete colour available to assert on.
 */
function tokenFallbackHexes(token: string): string[] {
  const pattern = new RegExp(`${token}\\s*:\\s*([^;]+);`, 'g');
  const hexes: string[] = [];
  for (const match of STYLESHEET_TEXT.matchAll(pattern)) {
    const hex = /#([0-9a-fA-F]{6})/.exec(match[1] ?? '');
    if (hex) hexes.push(`#${hex[1]!.toLowerCase()}`);
  }
  return hexes;
}

function isRed(hex: string): boolean {
  const r = Number.parseInt(hex.slice(1, 3), 16);
  const g = Number.parseInt(hex.slice(3, 5), 16);
  const b = Number.parseInt(hex.slice(5, 7), 16);
  return r > 120 && r > g * 1.8 && r > b * 1.8;
}

// ---------------------------------------------------------------------------
// Reading the tree the way a user would
// ---------------------------------------------------------------------------

/**
 * Blocks that put a line break between what is on either side of them.
 *
 * `textContent` concatenates with nothing in between, so three poetic lines
 * come back as "…ungodly,nor standeth…" and a test on the words of the verse
 * fails on an artefact rather than on the rendering. A reader sees a line
 * break, which is whitespace, so that is what this treats it as.
 */
const BLOCK_TAGS = new Set([
  'DIV', 'P', 'LI', 'UL', 'OL', 'SECTION', 'HEADER', 'FOOTER', 'FORM',
  'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BR',
]);

/**
 * The text a reader gets, with the presentational bits taken out.
 *
 * Verse labels and the ✗ glyph are marked `aria-hidden`; dropping them leaves
 * the scripture itself plus the words written for a screen reader, which is
 * what nearly every assertion here is about.
 */
function spokenText(node: Node): string {
  const parts: string[] = [];

  const walk = (current: Node): void => {
    if (current.nodeType === Node.TEXT_NODE) {
      parts.push(current.nodeValue ?? '');
      return;
    }
    if (current.nodeType !== Node.ELEMENT_NODE) return;
    const element = current as Element;
    if (element.getAttribute('aria-hidden') === 'true') return;

    const block = BLOCK_TAGS.has(element.tagName);
    if (block) parts.push(' ');
    for (const child of Array.from(element.childNodes)) walk(child);
    if (block) parts.push(' ');
  };

  walk(node);
  return parts.join('').replace(/\s+/g, ' ').trim();
}

/**
 * A few computed properties, as one comparable string.
 *
 * Used to ask "does this element look different from its siblings?" without
 * naming the class that makes it so. `var()` is not resolved by jsdom, but the
 * token *reference* still differs between a marked and an unmarked candidate,
 * which is the whole question.
 */
function visualSignature(node: Element): string {
  const cs = getComputedStyle(node);
  return [cs.background, cs.backgroundColor, cs.color, cs.boxShadow].join('|');
}

/** Every element in a tree, the root included. */
function everyElement(root: Element): Element[] {
  return [root, ...Array.from(root.querySelectorAll('*'))];
}

/**
 * Anything that would draw a line through text, by any route.
 *
 * Three routes exist and all three are checked, because ruling out only the one
 * that happens to be in use today is how a rule like this comes back: an inline
 * style written by a view, a declaration in the stylesheet, and the elements
 * that are struck through by default with no CSS at all.
 */
function strikeThroughOffenders(root: Element): string[] {
  const offenders: string[] = [];

  for (const node of everyElement(root)) {
    if (['S', 'STRIKE', 'DEL'].includes(node.tagName)) {
      offenders.push(`<${node.tagName.toLowerCase()}> element`);
    }
    const inline = (node as HTMLElement).style;
    const declared = `${inline.textDecoration} ${inline.textDecorationLine}`;
    if (declared.includes('line-through')) offenders.push(`inline style on ${node.tagName}`);

    const cs = getComputedStyle(node);
    if (`${cs.textDecoration} ${cs.textDecorationLine}`.includes('line-through')) {
      offenders.push(`computed style on ${node.tagName}.${node.className}`);
    }
  }

  for (const rule of ALL_RULE_TEXTS) {
    if (rule.includes('line-through')) offenders.push(`rule ${rule.slice(0, 60)}`);
  }

  return offenders;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const NOW = Date.UTC(2026, 2, 12, 9, 0, 0);

/**
 * Psalm 1:1 - three poetic lines at three different indent levels.
 *
 * The shape is the point. `Line.end` is documented as INCLUSIVE, and the cost
 * of reading it as exclusive is that the last word of every line disappears -
 * "the counsel of the", "the way of", "the seat of the" - which reads as a
 * slightly odd line break rather than as a bug. A fixture whose lines all end
 * on a memorable word makes that failure loud.
 */
const PSALM_1_1: VerseText = {
  verseId: 19001001,
  label: '1:1',
  words: [
    'Blessed', 'is', 'the', 'man', 'that', 'walketh', 'not', 'in', 'the',
    'counsel', 'of', 'the', 'ungodly,',
    'nor', 'standeth', 'in', 'the', 'way', 'of', 'sinners,',
    'nor', 'sitteth', 'in', 'the', 'seat', 'of', 'the', 'scornful.',
  ],
  lines: [
    { start: 0, end: 12, level: 1 },
    { start: 13, end: 19, level: 2 },
    { start: 20, end: 27, level: 3 },
  ],
  psalmTitle: null,
  paragraphStart: true,
};

const PSALM_1_2: VerseText = {
  verseId: 19001002,
  label: '1:2',
  words: [
    'But', 'his', 'delight', 'is', 'in', 'the', 'law', 'of', 'the', 'LORD;',
    'and', 'in', 'his', 'law', 'doth', 'he', 'meditate', 'day', 'and', 'night.',
  ],
  lines: [
    { start: 0, end: 9, level: 1 },
    { start: 10, end: 19, level: 2 },
  ],
  psalmTitle: null,
  paragraphStart: false,
};

const PSALM_1_3: VerseText = {
  verseId: 19001003,
  label: '1:3',
  words: [
    'And', 'he', 'shall', 'be', 'like', 'a', 'tree', 'planted', 'by', 'the',
    'rivers', 'of', 'water',
  ],
  lines: [
    { start: 0, end: 5, level: 1 },
    { start: 6, end: 12, level: 2 },
  ],
  psalmTitle: null,
  paragraphStart: false,
};

/** A superscription-bearing verse. The only "heading" the data ever carries. */
const PSALM_3_1: VerseText = {
  verseId: 19003001,
  label: '3:1',
  words: ['LORD,', 'how', 'are', 'they', 'increased', 'that', 'trouble', 'me!'],
  lines: [{ start: 0, end: 7, level: 1 }],
  psalmTitle: 'A Psalm of David, when he fled from Absalom his son.',
  paragraphStart: true,
};

/** Prose: `lines` is null, so it must not be broken into indented lines. */
const JOHN_3_16: VerseText = {
  verseId: 43003016,
  label: '3:16',
  words: [
    'For', 'God', 'so', 'loved', 'the', 'world,', 'that', 'he', 'gave', 'his',
    'only', 'begotten', 'Son.',
  ],
  lines: null,
  psalmTitle: null,
  paragraphStart: true,
};

const JOHN_3_17: VerseText = {
  ...JOHN_3_16,
  verseId: 43003017,
  label: '3:17',
  words: ['For', 'God', 'sent', 'not', 'his', 'Son', 'to', 'condemn', 'the', 'world.'],
  paragraphStart: false,
};

/** The passage under exercise, with a verse of context before it. */
function psalmContext(): PassageContext {
  return {
    passageId: 1,
    reference: 'Psalm 1:2-3',
    before: [PSALM_1_1],
    verses: [PSALM_1_2, PSALM_1_3],
    // Empty during an exercise, by design - the verses after the working point
    // are the answer to the ordering picker.
    after: [],
  };
}

function session(step: Step | null, over: Partial<SessionView> = {}): SessionView {
  return {
    sessionId: 'session-1',
    passageId: 1,
    rung: 'blanks',
    step,
    correctFirst: 0,
    stepsTaken: 0,
    ...over,
  };
}

/**
 * `fullWord` by default: most of this describe block exercises the Check-
 * button, measured-width flow, which is what `blanks` looked like before task
 * 0004 made the answer mode a setting. The `firstLetter` describe block below
 * passes `'firstLetter'` explicitly to exercise the new default instead.
 */
function blanksStep(verse: VerseText, blankIndices: number[], answerMode: AnswerMode = 'fullWord'): BlanksStep {
  return { kind: 'blanks', verse, blankIndices, answerMode, stepNumber: 1, totalSteps: 2 };
}

/**
 * The standard pair of blanks: "his" (1) and "law" (6) in Psalm 1:2.
 *
 * Both sit in the verse's first poetic line, and both are three letters long
 * while rendering at visibly different widths - which is what makes them useful
 * for the sizing tests, since a character count cannot tell them apart.
 *
 * The working verse is deliberately one of `PassageContext.verses` rather than
 * one of `before`: `renderWorkingPassage` substitutes the step's copy of the
 * verse into the context by verse id, so a step whose verse is not in the
 * passage renders no exercise at all.
 */
const BLANKED = [1, 6];

function firstLettersStep(verse: VerseText, answerMode: AnswerMode = 'firstLetter'): FirstLettersStep {
  return { kind: 'firstletters', verse, answerMode, stepNumber: 1, totalSteps: 2 };
}

function orderingStep(): OrderingStep {
  return {
    kind: 'ordering',
    placed: [PSALM_1_1],
    candidates: [
      { verseId: 19001004, preview: 'The ungodly are not so', truncated: false },
      { verseId: 19001002, preview: 'But his delight is in the law of the LORD', truncated: true },
      { verseId: 19001003, preview: 'And he shall be like a tree planted', truncated: true },
    ],
    stepNumber: 2,
    totalSteps: 3,
  };
}

function stepResult(over: Partial<StepResult> = {}): StepResult {
  return { correct: false, wrong: [], blocking: false, ...over };
}

function emptyPlan(): PlanView {
  return {
    collectionId: 1,
    collectionName: 'My plan',
    passages: [],
    totalDue: 0,
    defaultAnswerMode: 'firstLetter',
    sortOrder: 'bible',
  };
}

function rungView(over: Partial<RungView> & Pick<RungView, 'rung'>): RungView {
  return {
    level: 0,
    dueAt: null,
    streak: 0,
    lastScore: null,
    applicable: true,
    resume: null,
    ...over,
  };
}

function passageFixture(over: Partial<Passage> = {}): Passage {
  return {
    id: 10,
    collectionId: 1,
    moduleId: 'kjv',
    startVerseId: 19023001,
    endVerseId: 19023006,
    reference: 'Psalm 23:1-6',
    verseCount: 6,
    addedAt: NOW - 30 * 86_400_000,
    answerMode: null,
    ...over,
  };
}

function passageViewFixture(over: Partial<PassageView> = {}): PassageView {
  return {
    passage: passageFixture(),
    dueCount: 0,
    bestLevel: 0,
    wellLearned: false,
    rungs: [
      rungView({ rung: 'ordering', level: 3 }),
      rungView({ rung: 'refmatch', applicable: false }),
      rungView({ rung: 'blanks', level: 1, dueAt: NOW - 60_000 }),
      rungView({ rung: 'firstletters' }),
    ],
    ...over,
  };
}

function emptyAnalytics(): AnalyticsView {
  return {
    streakDays: 0,
    versesLearned: 0,
    passagesWellLearned: 0,
    calendar: [],
    recentlyReached: [],
    nextMilestone: { versesLearned: 5, toGo: 5 },
  };
}

// ---------------------------------------------------------------------------
// A stub host
// ---------------------------------------------------------------------------

type Handlers = {
  [K in PanelRequest['type']]?: (request: Extract<PanelRequest, { type: K }>) => PanelReply<RequestMap[K]>;
};

/**
 * Everything a view is allowed to reach, faked.
 *
 * `PanelHost` exists precisely so the screens can be rendered without the SDK
 * (see its own header), and this is the harness that claim was made for. The
 * measurer is real, not stubbed: the width behaviour under test is its
 * fallback path, and stubbing it would test the stub.
 */
class TestHost implements PanelHost {
  readonly requests: PanelRequest[] = [];
  readonly announcements: string[] = [];
  readonly navigations: NavAction[] = [];
  readonly sessionsStarted: { passageId: number; rung?: Rung; restart?: boolean; flow?: Flow }[] = [];
  readonly flowsStarted: { flow: Flow; exclude?: ReadonlySet<number> }[] = [];
  readonly openedVerses: number[] = [];
  reloads = 0;
  activeReference: string | null = null;
  readonly measurer: WordMeasurer;
  handlers: Handlers = {};

  constructor() {
    this.measurer = new WordMeasurer(document);
  }

  now(): number {
    return NOW;
  }

  request<R extends PanelRequest>(request: R): Promise<PanelReply<RequestMap[R['type']]>> {
    this.requests.push(request);
    const handler = this.handlers[request.type] as
      | ((r: PanelRequest) => PanelReply<RequestMap[R['type']]>)
      | undefined;
    if (!handler) {
      return Promise.resolve({
        ok: false,
        error: `No stub registered for "${request.type}".`,
      });
    }
    return Promise.resolve(handler(request));
  }

  go(action: NavAction): void {
    this.navigations.push(action);
  }

  reload(): void {
    this.reloads += 1;
  }

  async startSession(passageId: number, rung?: Rung, restart?: boolean, flow?: Flow): Promise<void> {
    this.sessionsStarted.push({ passageId, rung, restart, flow });
  }

  async startFlow(flow: Flow, exclude?: ReadonlySet<number>): Promise<void> {
    this.flowsStarted.push({ flow, exclude });
  }

  openInBible(verseId: number): void {
    this.openedVerses.push(verseId);
  }

  announce(message: string): void {
    this.announcements.push(message);
  }
}

/** Lets the stubbed replies - all immediate - reach the view. */
async function settle(): Promise<void> {
  for (let i = 0; i < 6; i++) await Promise.resolve();
}

let container: HTMLElement;
let host: TestHost;
let view: PracticeView | null = null;

/**
 * Mounts a practice view with the standard Psalm 1 context available.
 *
 * `flow` defaults to `undefined`, letting `PracticeView`'s own constructor
 * default apply (`{ kind: 'passage', passageId }`, no Next button) - the same
 * "existing calls keep behaving exactly as they did" reasoning its own
 * default documents.
 */
async function mountPractice(
  step: Step | null,
  over: Partial<SessionView> = {},
  contextReply?: PanelReply<PassageContext>,
  flow?: Flow,
): Promise<PracticeView> {
  host.handlers.getContext = () => contextReply ?? { ok: true, data: psalmContext() };
  const practice =
    flow !== undefined ? new PracticeView(host, session(step, over), flow) : new PracticeView(host, session(step, over));
  practice.mount(container);
  await settle();
  view = practice;
  return practice;
}

/** The verse the exercise is about, as the accessibility tree marks it. */
function workingVerse(root: HTMLElement): HTMLElement {
  const found = root.querySelectorAll<HTMLElement>('[aria-current="step"]');
  expect(found.length).toBe(1);
  return found[0]!;
}

beforeAll(() => {
  installStylesheet();
});

beforeEach(() => {
  document.body.innerHTML = '';
  container = document.createElement('div');
  document.body.appendChild(container);
  host = new TestHost();
  // `renderManage` (P5) always fetches `getCollections` for its lists table,
  // even on screens/tests that only care about the passage list below it - a
  // missing stub would otherwise surface as a stray `role="alert"` error
  // banner ("No stub registered...") ahead of whatever alert a test is
  // actually looking for. Any test - or whole describe block - that cares
  // about the table's own content overrides this.
  host.handlers.getCollections = () => ({ ok: true, data: [{ id: 1, name: 'My plan', passageCount: 0 }] });
});

afterEach(() => {
  view?.destroy();
  view = null;
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// 1. Scripture
// ---------------------------------------------------------------------------

describe('scripture rendering', () => {
  function render(verses: VerseText[]): HTMLElement {
    const wrapper = document.createElement('div');
    for (const block of renderPassage(verses, () => ({}))) wrapper.appendChild(block);
    container.appendChild(wrapper);
    return wrapper;
  }

  it('lays a poetic verse out as its lines, not as a paragraph', () => {
    const wrapper = render([PSALM_1_1]);
    const verse = wrapper.firstElementChild!;

    // Three lines in, three blocks out. A wrapped paragraph would be one.
    expect(verse.children.length).toBe(3);
    expect(spokenText(verse.children[0]!)).toBe(
      'Blessed is the man that walketh not in the counsel of the ungodly,',
    );
    expect(spokenText(verse.children[1]!)).toBe('nor standeth in the way of sinners,');
    expect(spokenText(verse.children[2]!)).toBe('nor sitteth in the seat of the scornful.');
  });

  it('treats Line.end as inclusive, so no line loses its last word', () => {
    const wrapper = render([PSALM_1_1]);
    const verse = wrapper.firstElementChild!;

    // The exclusive reading drops exactly these three words and nothing else,
    // which is why it survives a casual look at the screen.
    for (const lastWord of ['ungodly,', 'sinners,', 'scornful.']) {
      expect(spokenText(verse)).toContain(lastWord);
    }
    // Stronger: every word, once, in order.
    expect(spokenText(verse)).toBe(PSALM_1_1.words.join(' '));
  });

  it('indents each line further than the one above it', () => {
    const wrapper = render([PSALM_1_1]);
    const verse = wrapper.firstElementChild!;

    const indents = Array.from(verse.children).map((line) =>
      Number.parseFloat(getComputedStyle(line).paddingLeft),
    );

    expect(indents.every((n) => Number.isFinite(n))).toBe(true);
    expect(indents[0]!).toBeLessThan(indents[1]!);
    expect(indents[1]!).toBeLessThan(indents[2]!);
  });

  it('does not break prose into indented lines', () => {
    const wrapper = render([JOHN_3_16, JOHN_3_17]);

    // One paragraph, because `paragraphStart` is false on the second verse:
    // prose flows across verse boundaries.
    expect(wrapper.children.length).toBe(1);
    expect(wrapper.firstElementChild!.tagName).toBe('P');
    expect(spokenText(wrapper)).toBe(
      `${JOHN_3_16.words.join(' ')} ${JOHN_3_17.words.join(' ')}`,
    );

    // Nothing here is a poetic line, and nothing here is indented.
    const indented = everyElement(wrapper).filter(
      (n) => Number.parseFloat(getComputedStyle(n).paddingLeft) > 0,
    );
    expect(indented).toEqual([]);
  });

  it('starts a new paragraph where the data says to', () => {
    const wrapper = render([JOHN_3_16, { ...JOHN_3_17, paragraphStart: true }]);
    expect(wrapper.children.length).toBe(2);
  });

  it('recovers words the line markup leaves off the end of a verse', () => {
    // A module whose poetry markup does not cover the whole verse is a real
    // possibility, and a verse that silently lost its last seven words would be
    // very hard to spot - it would read as a slightly short line. The trailing
    // shortfall is emitted rather than dropped.
    //
    // Only the trailing shortfall: a gap *before* `lines[0].start` or between
    // two lines is still dropped, which is worth knowing when reading the
    // coverage tracking in `renderPoetryVerse`.
    const undercovered: VerseText = {
      ...PSALM_1_3,
      lines: [{ start: 0, end: 5, level: 1 }],
    };
    const wrapper = render([undercovered]);
    expect(spokenText(wrapper)).toBe(PSALM_1_3.words.join(' '));
  });

  it('renders a psalm superscription as its own block of text', () => {
    const wrapper = render([PSALM_3_1]);

    expect(wrapper.children.length).toBe(2);
    expect(spokenText(wrapper.children[0]!)).toBe(PSALM_3_1.psalmTitle);
    expect(spokenText(wrapper.children[1]!)).toBe(PSALM_3_1.words.join(' '));
  });

  it('emits no section headings - the superscription is text, not a heading', () => {
    const wrapper = render([PSALM_3_1, PSALM_1_1, JOHN_3_16]);

    // There are no headings in the data and none are invented. A superscription
    // rendered as an <h2> would be announced as a document landmark, which is a
    // claim about the text that USFM \d does not make.
    expect(wrapper.querySelectorAll('h1, h2, h3, h4, h5, h6').length).toBe(0);
    expect(wrapper.querySelectorAll('[role="heading"]').length).toBe(0);
  });

  it('keeps the verse label out of the reading text and out of the spoken text', () => {
    const wrapper = render([PSALM_1_1]);
    // Visible in the margin...
    expect(wrapper.textContent).toContain('1:1');
    // ...but not part of the verse as far as assistive tech is concerned.
    expect(spokenText(wrapper)).not.toContain('1:1');
  });
});

// ---------------------------------------------------------------------------
// 2. The working verse among its context
// ---------------------------------------------------------------------------

describe('the working verse among its context', () => {
  it('shows the reference in the toolbar as soon as context arrives, before any answer is submitted', async () => {
    // The toolbar title comes from `PassageContext.reference` alone, fetched
    // separately from the step and deliberately not awaited before the first
    // paint (see `practiceView.ts#loadContext`'s own header). Before this,
    // nothing re-rendered the head once that fetch resolved, so the title
    // sat blank until the next unrelated redraw (the first submitted
    // answer) - exactly what a review round flagged as the reference not
    // being prominent on this screen.
    const practice = await mountPractice(blanksStep(PSALM_1_2, [2, 16]));

    const title = practice.root.querySelector<HTMLElement>('.sm-crumb-current')!;
    expect(title.textContent).toBe('Psalm 1:2-3');
  });

  it('marks exactly one verse as the one being worked on', async () => {
    const practice = await mountPractice(blanksStep(PSALM_1_2, [2, 16]));

    const current = workingVerse(practice.root);
    expect(current.getAttribute('data-verse-id')).toBe(String(PSALM_1_2.verseId));
  });

  it('draws the working verse differently from every verse around it', async () => {
    const practice = await mountPractice(blanksStep(PSALM_1_2, [2, 16]));

    const current = workingVerse(practice.root);
    const others = Array.from(
      practice.root.querySelectorAll<HTMLElement>('[data-verse-id]'),
    ).filter((n) => n !== current);

    expect(others.length).toBeGreaterThan(0);
    for (const other of others) {
      expect(visualSignature(other)).not.toBe(visualSignature(current));
    }
  });

  it('renders context as real, readable text rather than placeholder shapes', async () => {
    const practice = await mountPractice(blanksStep(PSALM_1_2, [2, 16]));

    // Psalm 1:1 comes from `PassageContext.before`; Psalm 1:3 from the passage
    // itself. Both are context here, and both must be readable.
    const before = practice.root.querySelector<HTMLElement>(
      `[data-verse-id="${PSALM_1_1.verseId}"]`,
    )!;
    const after = practice.root.querySelector<HTMLElement>(
      `[data-verse-id="${PSALM_1_3.verseId}"]`,
    )!;

    expect(spokenText(before)).toBe(PSALM_1_1.words.join(' '));
    expect(spokenText(after)).toBe(PSALM_1_3.words.join(' '));
  });

  it('does not blur or ghost the context it just made readable', async () => {
    const practice = await mountPractice(blanksStep(PSALM_1_2, [2, 16]));

    // "A small step down in contrast, not a blur and not a 30%-opacity ghost"
    // is the stated rule, and it is a rule that a later styling tweak could
    // undo without anyone noticing the reading experience had gone.
    for (const node of everyElement(practice.root)) {
      const cs = getComputedStyle(node);
      expect(cs.filter).not.toContain('blur');
      expect(cs.webkitFilter ?? '').not.toContain('blur');
      const opacity = Number.parseFloat(cs.opacity);
      if (Number.isFinite(opacity)) expect(opacity).toBeGreaterThanOrEqual(0.6);
      expect(cs.visibility).not.toBe('hidden');
      expect(cs.color).not.toContain('transparent');
    }
  });

  it('renders nothing at all for the withheld verses after the working point', async () => {
    const practice = await mountPractice(blanksStep(PSALM_1_2, [2, 16]));

    // `PassageContext.after` is empty during an exercise. An "…" or an empty
    // bordered box would read as a passage that failed to load.
    const verses = Array.from(
      practice.root.querySelectorAll<HTMLElement>('[data-verse-id]'),
    ).map((n) => n.getAttribute('data-verse-id'));

    expect(verses.sort()).toEqual(
      [PSALM_1_1, PSALM_1_2, PSALM_1_3].map((v) => String(v.verseId)).sort(),
    );
  });
});

// ---------------------------------------------------------------------------
// 3. The ordering picker blocks
// ---------------------------------------------------------------------------

describe('the ordering picker', () => {
  /** The candidates, in the order they are offered. */
  function candidates(root: HTMLElement): HTMLButtonElement[] {
    return Array.from(root.querySelectorAll<HTMLButtonElement>('.sm-choice'));
  }

  /** The one candidate that is drawn differently from the rest, if any. */
  function markedCandidate(root: HTMLElement): HTMLButtonElement | null {
    const all = candidates(root);
    const signatures = all.map(visualSignature);
    const odd = signatures
      .map((sig, i) => ({ sig, i }))
      .filter(({ sig }) => signatures.filter((s) => s === sig).length === 1);
    return odd.length === 1 ? all[odd[0]!.i]! : null;
  }

  async function pickWrong(): Promise<{ practice: PracticeView; step: OrderingStep }> {
    const step = orderingStep();
    const held = session(step, { rung: 'ordering' });
    host.handlers.submitStep = () => ({
      ok: true,
      data: {
        // Wrong, and the picker blocks: the SAME step comes back.
        result: stepResult({ correct: false, wrong: [19001004], blocking: true }),
        session: held,
        summary: null,
      },
    });

    const practice = await mountPractice(step, { rung: 'ordering' });
    vi.useFakeTimers();
    candidates(practice.root)[0]!.click();
    await settle();
    return { practice, step };
  }

  it('marks the candidate that was clicked', async () => {
    const { practice } = await pickWrong();

    const marked = markedCandidate(practice.root);
    expect(marked).not.toBeNull();
    expect(marked!.getAttribute('data-verse-id')).toBe('19001004');
  });

  it('keeps the same step on screen instead of advancing past a wrong pick', async () => {
    const { practice, step } = await pickWrong();

    // Same question, same three candidates, in the same order.
    expect(spokenText(practice.root)).toContain('Which verse comes next?');
    expect(
      candidates(practice.root).map((c) => c.getAttribute('data-verse-id')),
    ).toEqual(step.candidates.map((c) => String(c.verseId)));
  });

  it('says why, out loud, rather than only in colour', async () => {
    const { practice } = await pickWrong();

    const live = practice.root.querySelector<HTMLElement>('[aria-live]')!;
    expect(spokenText(live)).toContain('Not that one');
  });

  it('lets the mark expire - it says "not that one", it does not keep a tally', async () => {
    const { practice } = await pickWrong();
    expect(markedCandidate(practice.root)).not.toBeNull();

    // The blocked step is handed back clean. A mark that survived into the
    // retry would turn a hint into a scoreboard, which is explicitly not what
    // it is for; a second wrong pick would then leave two candidates marked and
    // the picker would look like it was accumulating a verdict.
    vi.advanceTimersByTime(2_000);

    expect(markedCandidate(practice.root)).toBeNull();
    const live = practice.root.querySelector<HTMLElement>('[aria-live]')!;
    expect(spokenText(live)).toBe('');
  });

  it('does not submit twice while a pick is still in flight', async () => {
    const step = orderingStep();
    host.handlers.submitStep = () => ({
      ok: true,
      data: {
        result: stepResult({ correct: false, wrong: [19001004], blocking: true }),
        session: session(step, { rung: 'ordering' }),
        summary: null,
      },
    });

    const practice = await mountPractice(step, { rung: 'ordering' });
    vi.useFakeTimers();

    const buttons = candidates(practice.root);
    buttons[0]!.click();
    buttons[1]!.click();
    await settle();

    // Double-clicking a candidate must not score the step twice.
    expect(host.requests.filter((r) => r.type === 'submitStep').length).toBe(1);
  });

  it('asks "which verse comes first?" when nothing has been placed yet', async () => {
    // The first pick is a real choice now, not a given - see
    // `session.ts#prepareStep`. Presupposing an answer in the prompt would be
    // exactly the bug being fixed.
    const step = { ...orderingStep(), placed: [], stepNumber: 1 };
    const practice = await mountPractice(step, { rung: 'ordering' });

    expect(spokenText(practice.root)).toContain('Which verse comes first?');
    expect(spokenText(practice.root)).not.toContain('Which verse comes next?');
  });

  it('labels each card with the number that picks it', async () => {
    const practice = await mountPractice(orderingStep(), { rung: 'ordering' });
    const keys = Array.from(practice.root.querySelectorAll<HTMLElement>('.sm-choice-key')).map(
      (k) => k.textContent,
    );
    expect(keys).toEqual(['1', '2', '3']);
  });

  it('picks a card by pressing the number printed on it, the same as a click', async () => {
    const step = orderingStep();
    let submitted: unknown = null;
    host.handlers.submitStep = (req) => {
      submitted = req.answer;
      return {
        ok: true,
        data: { result: stepResult({ correct: true }), session: session(null), summary: null },
      };
    };

    const practice = await mountPractice(step, { rung: 'ordering' });
    const list = practice.root.querySelector('.sm-choices')!;
    list.dispatchEvent(new KeyboardEvent('keydown', { key: '2', bubbles: true, cancelable: true }));
    await settle();

    // The step's SECOND candidate - the number printed on that card.
    expect(submitted).toMatchObject({ kind: 'ordering', verseId: step.candidates[1]!.verseId });
  });
});

// ---------------------------------------------------------------------------
// 4. Blanks
// ---------------------------------------------------------------------------

describe('blanks', () => {
  /** The measurement `measure.ts` will actually be able to take under jsdom. */
  function fallbackWidthFor(word: string, sample: Element): number {
    const parsed = Number.parseFloat(getComputedStyle(sample).fontSize);
    const fontPx = Number.isFinite(parsed) && parsed > 0 ? parsed : 16;
    return blankWidthFor(estimateTextWidth(word, fontPx));
  }

  function blanks(root: HTMLElement): HTMLInputElement[] {
    return Array.from(root.querySelectorAll<HTMLInputElement>('.sm-blank'));
  }

  it('puts an input where the word goes, inside the line it belongs to', async () => {
    // "his" (index 1) and "law" (index 6) both sit in the first poetic line of
    // Psalm 1:2.
    const practice = await mountPractice(blanksStep(PSALM_1_2, BLANKED));

    const current = workingVerse(practice.root);
    const inputs = blanks(practice.root);
    expect(inputs.length).toBe(2);

    // Both blanks are inside the first line, not in an answer box below the
    // passage - the arrangement that was explicitly rejected.
    const firstLine = current.children[0]!;
    for (const input of inputs) expect(firstLine.contains(input)).toBe(true);
  });

  it('still renders every word that was not blanked', async () => {
    const practice = await mountPractice(blanksStep(PSALM_1_2, BLANKED));

    const hidden = new Set(BLANKED);
    const expected = PSALM_1_2.words.filter((_, i) => !hidden.has(i)).join(' ');
    expect(spokenText(workingVerse(practice.root))).toBe(expected);
  });

  it('sizes each blank from a measurement rather than leaving it at a default', async () => {
    const practice = await mountPractice(blanksStep(PSALM_1_2, BLANKED));

    const current = workingVerse(practice.root);
    for (const [i, input] of blanks(practice.root).entries()) {
      const word = PSALM_1_2.words[BLANKED[i]!]!;
      expect(input.style.width).not.toBe('');
      // jsdom reports zero for every text metric, which is exactly the
      // condition `WordMeasurer.measure` documents and falls back from, so what
      // is being checked here is the fallback: the input carries the estimate,
      // not the browser's default input width and not a zero.
      expect(Number.parseFloat(input.style.width)).toBe(fallbackWidthFor(word, current));
    }
  });

  it('is proportional, not a character count - two 3-letter words differ', async () => {
    const practice = await mountPractice(blanksStep(PSALM_1_2, BLANKED));

    const [his, law] = blanks(practice.root);
    expect(PSALM_1_2.words[1]).toBe('his');
    expect(PSALM_1_2.words[6]).toBe('law');

    // `size=3` or `width: 3ch` would give these two the same box despite "law"
    // being visibly the wider word - `ch` is the advance of "0", so it cannot
    // tell an "i" from a "w". That is the failure this whole measurement path
    // exists to avoid, and it is invisible in a screenshot.
    expect(Number.parseFloat(law!.style.width)).toBeGreaterThan(
      Number.parseFloat(his!.style.width),
    );
  });

  it('respects the floor, so a one-letter word is still something you can hit', async () => {
    // "a" is word 5 of Psalm 1:3. Its estimate is about eight pixels.
    const practice = await mountPractice(blanksStep(PSALM_1_3, [5]));

    const input = blanks(practice.root)[0]!;
    expect(PSALM_1_3.words[5]).toBe('a');
    expect(Number.parseFloat(input.style.width)).toBe(MIN_BLANK_WIDTH_PX);
  });

  it('grows a blank that is overtyped, and never shrinks it back', async () => {
    const practice = await mountPractice(blanksStep(PSALM_1_2, BLANKED));

    const input = blanks(practice.root)[0]!;
    const initial = Number.parseFloat(input.style.width);

    input.value = 'hishishishis';
    input.dispatchEvent(new Event('input'));
    const grown = Number.parseFloat(input.style.width);
    expect(grown).toBeGreaterThan(initial);

    // Backspacing must not shuffle the line about under the user's hands.
    input.value = 'h';
    input.dispatchEvent(new Event('input'));
    expect(Number.parseFloat(input.style.width)).toBe(grown);
  });
});

// ---------------------------------------------------------------------------
// 4a. Blanks in firstLetter mode - the default answer mode (task 0004)
// ---------------------------------------------------------------------------

describe('blanks in firstLetter mode (the default)', () => {
  it('hides the blanked words completely - no letter shown, no Check button', async () => {
    const practice = await mountPractice(blanksStep(PSALM_1_2, BLANKED, 'firstLetter'));

    const inputs = Array.from(practice.root.querySelectorAll<HTMLInputElement>('.sm-fl'));
    expect(inputs.length).toBe(BLANKED.length);
    for (const input of inputs) {
      expect(input.getAttribute('placeholder')).toBeNull();
      expect(input.getAttribute('maxlength')).toBe('1');
    }
    // firstLetter mode has nothing left to confirm once every slot resolves,
    // so there is no Check button at all - unlike fullWord mode above.
    expect(practice.root.querySelector('.sm-exercise-actions button')).toBeNull();
  });

  it('reveals the whole word on a correct letter and moves to the next blank', async () => {
    const practice = await mountPractice(blanksStep(PSALM_1_2, BLANKED, 'firstLetter'));

    const input = practice.root.querySelectorAll<HTMLInputElement>('.sm-fl')[0]!; // "his"
    input.value = 'h';
    input.dispatchEvent(new Event('input'));

    expect(spokenText(workingVerse(practice.root))).toContain('his');
    // One blank left ("law"); the other word is not blanked at all.
    expect(practice.root.querySelectorAll('.sm-fl').length).toBe(1);
  });

  it('submits automatically once every blank is resolved, with no confirmation step', async () => {
    let submitted: unknown = null;
    host.handlers.submitStep = (req) => {
      submitted = req.answer;
      return {
        ok: true,
        data: { result: stepResult({ correct: true }), session: session(null), summary: null },
      };
    };

    const practice = await mountPractice(blanksStep(PSALM_1_2, BLANKED, 'firstLetter'));
    const first = practice.root.querySelectorAll<HTMLInputElement>('.sm-fl')[0]!;
    first.value = 'h';
    first.dispatchEvent(new Event('input'));

    const second = practice.root.querySelectorAll<HTMLInputElement>('.sm-fl')[0]!;
    second.value = 'l';
    second.dispatchEvent(new Event('input'));
    await settle();

    expect(submitted).toMatchObject({ kind: 'blanks', words: ['his', 'law'] });
  });
});

// ---------------------------------------------------------------------------
// 5. Wrong answers
// ---------------------------------------------------------------------------

describe('a missed word', () => {
  async function submitOneWrong(): Promise<PracticeView> {
    const step = blanksStep(PSALM_1_2, BLANKED);
    host.handlers.submitStep = () => ({
      ok: true,
      data: {
        // `wrong: [6]` is a word index - "law", the second blank.
        result: stepResult({
          correct: false,
          wrong: [6],
          blocking: false,
          reveal: { words: ['his', 'law'] },
        }),
        session: session(null),
        summary: null,
      },
    });

    const practice = await mountPractice(step);
    const inputs = Array.from(practice.root.querySelectorAll<HTMLInputElement>('.sm-blank'));
    inputs[0]!.value = 'his';
    inputs[1]!.value = 'lore';

    practice.root.querySelector<HTMLButtonElement>('.sm-exercise-actions button')!.click();
    await settle();
    return practice;
  }

  it('shows the right word and the wrong answer beside it, both readable', async () => {
    const practice = await submitOneWrong();
    const text = spokenText(workingVerse(practice.root));

    // The verse is intact - "law" is back in its place in the line - and what
    // the user actually typed is shown next to it, named as a miss rather than
    // left to be inferred from a colour.
    expect(text).toContain('But his delight is in the law');
    expect(text).toContain('of the LORD;');
    expect(text).toContain('lore');
    expect(text).toContain('missed');
  });

  it('marks the miss with a ✗ that is not the only thing carrying the meaning', async () => {
    const practice = await submitOneWrong();
    const current = workingVerse(practice.root);

    // The glyph is present for a sighted reader...
    expect(current.textContent).toContain('✗');
    // ...and hidden from assistive tech, which gets words instead. A bare ✗ is
    // announced as "multiplication sign" or skipped entirely.
    const marks = Array.from(current.querySelectorAll('[aria-hidden="true"]')).filter((n) =>
      (n.textContent ?? '').includes('✗'),
    );
    expect(marks.length).toBe(1);
  });

  it('renders the wrong answer in red', async () => {
    const practice = await submitOneWrong();

    const typed = everyElement(workingVerse(practice.root)).find(
      (n) => n.children.length === 0 && n.textContent === 'lore',
    )!;
    expect(typed).toBeTruthy();

    // jsdom does not resolve custom properties, so the chain is followed by
    // hand: the element's colour is a danger token, and every value that token
    // is defined with in `styles.css` - light theme and dark - is a red.
    const colour = getComputedStyle(typed.parentElement ?? typed).color;
    const token = /var\((--[\w-]+)/.exec(colour)?.[1];
    expect(token, `expected a colour token, got ${JSON.stringify(colour)}`).toBeTruthy();
    expect(token).toContain('danger');

    const hexes = tokenFallbackHexes(token!);
    expect(hexes.length).toBeGreaterThan(0);
    for (const hex of hexes) expect(isRed(hex), `${token} = ${hex}`).toBe(true);
  });

  it('leaves the word that was right unmarked', async () => {
    const practice = await submitOneWrong();
    const current = workingVerse(practice.root);

    // Exactly one miss, not two: the resolution of `StepResult.wrong` onto
    // positions is what decides which words go red, and getting it wrong looks
    // like a scoring bug in the worker.
    expect((spokenText(current).match(/missed/g) ?? []).length).toBe(1);
    expect(spokenText(current)).toContain('But his delight');
  });

  it('never strikes scripture through, by any route', async () => {
    const practice = await submitOneWrong();

    // An explicit user decision: the mistake gets a mark, the words of the
    // verse are not defaced. Checked against inline styles, computed styles,
    // the elements that strike through with no CSS at all, and every rule in
    // the panel's own stylesheet - because the stylesheet is where a "tidy-up"
    // would reintroduce it.
    expect(strikeThroughOffenders(practice.root)).toEqual([]);
    expect(strikeThroughOffenders(document.body)).toEqual([]);
  });

  it('would notice if a strike-through were reintroduced', () => {
    // A rule this important must not be able to pass by being a no-op - an
    // empty rule list or a property jsdom does not model would make the check
    // above green forever. So the detector is shown catching each of the three
    // routes it claims to cover.
    expect(ALL_RULE_TEXTS.length).toBeGreaterThan(50);

    const planted = document.createElement('div');
    planted.innerHTML =
      '<span style="text-decoration: line-through">a</span><del>b</del>';
    container.appendChild(planted);

    const offenders = strikeThroughOffenders(planted);
    expect(offenders.some((o) => o.includes('inline style'))).toBe(true);
    expect(offenders.some((o) => o.includes('<del>'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 6. First letters
// ---------------------------------------------------------------------------

describe('first letters', () => {
  function slots(root: HTMLElement): HTMLInputElement[] {
    return Array.from(root.querySelectorAll<HTMLInputElement>('.sm-fl'));
  }

  it('shows nothing of the word - not even its first letter', async () => {
    // Task 0004, point 1: v0 put the initial in the box as a placeholder,
    // which turned this into a copy exercise rather than a recall one. The
    // box must be empty until the user types into it.
    const practice = await mountPractice(firstLettersStep(PSALM_1_3), { rung: 'firstletters' });

    const inputs = slots(practice.root);
    expect(inputs.length).toBe(PSALM_1_3.words.length);

    inputs.forEach((input) => {
      // No placeholder at all - not the letter, not anything derived from it.
      expect(input.getAttribute('placeholder')).toBeNull();
      expect(input.getAttribute('maxlength')).toBe('1');
      expect(input.value).toBe('');
    });
    expect(spokenText(workingVerse(practice.root))).toBe('');
  });

  it('reveals the WHOLE word on a correct initial - there is no partial tier', async () => {
    const practice = await mountPractice(firstLettersStep(PSALM_1_3), { rung: 'firstletters' });

    const input = slots(practice.root)[7]!; // "planted"
    input.value = 'p';
    input.dispatchEvent(new Event('input'));

    // Not "p...", not "pl", not "p_____": the word. The staged partial reveal
    // in the older design was cut, and a tier creeping back in would be a
    // change to what this rung actually trains.
    expect(spokenText(workingVerse(practice.root))).toBe('planted');
    expect(slots(practice.root).length).toBe(PSALM_1_3.words.length - 1);
  });

  it('reveals the word on a wrong initial too, and marks it missed', async () => {
    const practice = await mountPractice(firstLettersStep(PSALM_1_3), { rung: 'firstletters' });

    const input = slots(practice.root)[7]!; // "planted"
    input.value = 'x';
    input.dispatchEvent(new Event('input'));

    const text = spokenText(workingVerse(practice.root));
    // One attempt per word: the answer is given whether or not it was earned,
    // because the score is defined over first attempts and a retry loop would
    // drive every score to 1.0.
    expect(text).toContain('planted');
    expect(text).toContain('missed');
    expect(text).toContain('x');
    expect(strikeThroughOffenders(practice.root)).toEqual([]);
  });

  it('says which word was missed rather than leaving it to the colour', async () => {
    const practice = await mountPractice(firstLettersStep(PSALM_1_3), { rung: 'firstletters' });

    const input = slots(practice.root)[7]!;
    input.value = 'x';
    input.dispatchEvent(new Event('input'));

    const live = practice.root.querySelector<HTMLElement>('[aria-live]')!;
    expect(spokenText(live)).toContain('planted');
  });

  it('does not offer a slot for a token with no initial to ask for', async () => {
    const punctuated: VerseText = {
      ...PSALM_1_3,
      words: ['And', '—', 'he', 'shall'],
      lines: [{ start: 0, end: 3, level: 1 }],
    };
    const practice = await mountPractice(firstLettersStep(punctuated), {
      rung: 'firstletters',
    });

    // Three answerable words; the em dash is printed outright rather than
    // presented as an input that cannot be answered.
    expect(slots(practice.root).length).toBe(3);
    expect(spokenText(workingVerse(practice.root))).toBe('—');
  });
});

// ---------------------------------------------------------------------------
// 7. Accessibility basics
// ---------------------------------------------------------------------------

describe('accessibility', () => {
  it('has the live region in the document before there is anything to announce', async () => {
    const practice = await mountPractice(blanksStep(PSALM_1_2, BLANKED));

    // A live region created at the same moment as its text is frequently not
    // announced at all - the announcement is triggered by a mutation inside a
    // region that was already there. So the region has to pre-exist, empty.
    const live = practice.root.querySelector<HTMLElement>('[aria-live]');
    expect(live).not.toBeNull();
    expect(live!.getAttribute('aria-live')).toBe('assertive');
    expect(spokenText(live!)).toBe('');
  });

  it('announces a result into that same region, not a replacement for it', async () => {
    host.handlers.submitStep = () => ({
      ok: true,
      data: {
        result: stepResult({ correct: true, wrong: [] }),
        session: session(null),
        summary: null,
      },
    });
    const practice = await mountPractice(blanksStep(PSALM_1_2, BLANKED));

    const live = practice.root.querySelector<HTMLElement>('[aria-live]')!;
    practice.root.querySelector<HTMLButtonElement>('.sm-exercise-actions button')!.click();
    await settle();

    expect(practice.root.querySelector('[aria-live]')).toBe(live);
    expect(spokenText(live)).not.toBe('');
  });

  it('uses real buttons for every control the picker offers', async () => {
    const practice = await mountPractice(orderingStep(), { rung: 'ordering' });

    const controls = Array.from(practice.root.querySelectorAll<HTMLElement>('.sm-choice'));
    expect(controls.length).toBe(3);
    for (const control of controls) {
      // Not a clickable div: Enter and Space, focus order and the button role
      // all come free, and none of them are reimplemented anywhere in here.
      expect(control.tagName).toBe('BUTTON');
      expect((control as HTMLButtonElement).type).toBe('button');
    }
  });

  it('gives every blank an accessible name that says which blank it is', async () => {
    const practice = await mountPractice(blanksStep(PSALM_1_2, BLANKED));

    const labels = Array.from(
      practice.root.querySelectorAll<HTMLInputElement>('.sm-blank'),
    ).map((n) => n.getAttribute('aria-label'));

    // An unlabelled inline input is announced as "edit text, blank", which in a
    // passage of them tells the user nothing about where they are.
    expect(labels).toEqual(['Missing word 1 of 2', 'Missing word 2 of 2']);
  });

  it('names a first-letter slot by position only, never by its initial', async () => {
    const practice = await mountPractice(firstLettersStep(PSALM_1_3), { rung: 'firstletters' });

    const first = practice.root.querySelector<HTMLInputElement>('.sm-fl')!;
    const label = first.getAttribute('aria-label') ?? '';
    // "Blessed"/"And" is word 1 of 13 in Psalm 1:3 - the position is exactly
    // what the label says, and nothing else: task 0004 point 1 asked that the
    // first letter never be shown, and a screen-reader spoiler would be just
    // as much a violation of that as the visible placeholder v0 had.
    expect(label).toBe('Missing word 1 of 13');
  });

  it('marks the working verse in the accessibility tree, not only in colour', async () => {
    const practice = await mountPractice(blanksStep(PSALM_1_2, [2, 16]));

    // The highlight is a tinted band, and a tint is not available to everyone
    // using this panel. `aria-current="step"` answers "which verse am I on"
    // without it.
    expect(workingVerse(practice.root).getAttribute('aria-current')).toBe('step');
  });
});

// ---------------------------------------------------------------------------
// 7a. The passage screen
// ---------------------------------------------------------------------------

describe('the plan row', () => {
  function planWith(pv: PassageView): PlanView {
    return {
      collectionId: 1,
      collectionName: 'My plan',
      totalDue: 0,
      defaultAnswerMode: 'firstLetter',
      sortOrder: 'bible',
      passages: [pv],
    };
  }

  it('draws one square per applicable activity, and none for one that does not apply', () => {
    const root = renderPlan(host, planWith(passageViewFixture()));
    container.appendChild(root);

    // The fixture has four rungs; `refmatch` is inapplicable.
    expect(root.querySelectorAll('.sm-activity-square').length).toBe(3);
  });

  it('colours a square green when that activity itself is mastered, and orange when only partly attempted', () => {
    const pv = passageViewFixture({
      rungs: [
        rungView({ rung: 'ordering', level: 5 }),
        rungView({ rung: 'refmatch', applicable: false }),
        rungView({ rung: 'blanks', level: 2 }),
        rungView({ rung: 'firstletters', level: 0 }),
      ],
    });
    const root = renderPlan(host, planWith(pv));
    container.appendChild(root);

    const squares = Array.from(root.querySelectorAll('.sm-activity-square'));
    expect(squares.map((s) => s.className)).toEqual([
      expect.stringContaining('sm-activity-square-done'), // ordering: mastered
      expect.stringContaining('sm-activity-square-partial'), // blanks: tried, not mastered
      expect.stringContaining('sm-activity-square-new'), // firstletters: never tried
    ]);
  });

  it('colours a square light green when it is not itself mastered but a harder activity carries it', () => {
    const pv = passageViewFixture({
      rungs: [
        rungView({ rung: 'ordering', level: 0 }),
        rungView({ rung: 'refmatch', applicable: false }),
        rungView({ rung: 'blanks', level: 1 }),
        rungView({ rung: 'firstletters', level: 5 }), // mastered - carries down to ordering and blanks
      ],
    });
    const root = renderPlan(host, planWith(pv));
    container.appendChild(root);

    const squares = Array.from(root.querySelectorAll('.sm-activity-square'));
    expect(squares[0]!.className).toContain('sm-activity-square-carried'); // ordering
    expect(squares[1]!.className).toContain('sm-activity-square-carried'); // blanks
    expect(squares[2]!.className).toContain('sm-activity-square-done'); // firstletters itself
  });

  it('opens the passage screen from the row, with no separate Practice or Show in Bible button on the row itself', () => {
    const pv = passageViewFixture();
    const root = renderPlan(host, planWith(pv));
    container.appendChild(root);

    const row = root.querySelector('.sm-row')!;
    // The whole row is one button; a review round asked that per-row actions
    // stay hidden until a passage is actually selected, since opening it
    // already puts Practice and Show in Bible one click away.
    expect(row.querySelectorAll('button').length).toBe(1);

    row.querySelector<HTMLButtonElement>('button')!.click();
    expect(host.navigations).toContainEqual({ type: 'goPassage', passageId: pv.passage.id });
  });
});

// ---------------------------------------------------------------------------
// 7a-2. The passage list's heading and sort control (M4, decisions 10 and 12)
// ---------------------------------------------------------------------------

describe('the passage list sort control', () => {
  function planWithSort(passages: PassageView[], sortOrder: PassageSortOrder): PlanView {
    return {
      collectionId: 1,
      collectionName: 'My plan',
      totalDue: 0,
      defaultAnswerMode: 'firstLetter',
      sortOrder,
      passages,
    };
  }

  /**
   * Two passages whose "bible order" (array order, as `store.ts#listPassages`
   * would hand it back) disagrees with their "need" order: a well-practiced
   * passage not due for a while, listed first, and a never-attempted one,
   * listed second - `format.ts#sortPassagesByNeed` puts never-attempted
   * passages ahead of anything merely leveled up, so 'need' order reverses
   * this pair.
   */
  function needOrderDisagreesWithBibleOrder(): PassageView[] {
    const wellPracticed = passageViewFixture({
      passage: passageFixture({ id: 1, reference: 'Psalm 1:1-6' }),
      bestLevel: 5,
      dueCount: 0,
      rungs: [rungView({ rung: 'blanks', level: 5, dueAt: NOW + 10 * 86_400_000 })],
    });
    const neverAttempted = passageViewFixture({
      passage: passageFixture({ id: 2, reference: 'Romans 8:28-30' }),
      bestLevel: 0,
      dueCount: 0,
      rungs: [rungView({ rung: 'blanks', level: 0, dueAt: null })],
    });
    return [wellPracticed, neverAttempted];
  }

  function rowReferences(root: HTMLElement): string[] {
    return Array.from(root.querySelectorAll('.sm-row-ref')).map((el) => el.textContent ?? '');
  }

  it('renders the "Practice by Passage" heading with the sort select right above the list', () => {
    const root = renderPlan(host, planWithSort(needOrderDisagreesWithBibleOrder(), 'bible'));
    container.appendChild(root);

    const heading = Array.from(root.querySelectorAll('h2')).find((h) => h.textContent === 'Practice by Passage');
    expect(heading).toBeTruthy();

    const select = root.querySelector<HTMLSelectElement>('.sm-select');
    expect(select).toBeTruthy();
    const options = Array.from(select!.querySelectorAll('option')).map((o) => ({
      value: o.value,
      label: o.textContent,
    }));
    expect(options).toEqual([
      { value: 'bible', label: 'Bible order' },
      { value: 'need', label: 'Needs practice' },
    ]);

    // The select sits directly above the passage `<ul>`, not merely
    // somewhere on the screen.
    const list = root.querySelector('.sm-list')!;
    expect(select!.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('selects "Bible order" when plan.sortOrder is bible', () => {
    const root = renderPlan(host, planWithSort(needOrderDisagreesWithBibleOrder(), 'bible'));
    container.appendChild(root);

    const select = root.querySelector<HTMLSelectElement>('.sm-select')!;
    expect(select.value).toBe('bible');
  });

  it('selects "Needs practice" when plan.sortOrder is need', () => {
    const root = renderPlan(host, planWithSort(needOrderDisagreesWithBibleOrder(), 'need'));
    container.appendChild(root);

    const select = root.querySelector<HTMLSelectElement>('.sm-select')!;
    expect(select.value).toBe('need');
  });

  it('keeps plan.passages\' own order for "bible" - it is already ORDER BY start_verse_id, so nothing is re-sorted', () => {
    const root = renderPlan(host, planWithSort(needOrderDisagreesWithBibleOrder(), 'bible'));
    container.appendChild(root);

    expect(rowReferences(root)).toEqual(['Psalm 1:1-6', 'Romans 8:28-30']);
  });

  it('reorders the list by need to practice for "need"', () => {
    const root = renderPlan(host, planWithSort(needOrderDisagreesWithBibleOrder(), 'need'));
    container.appendChild(root);

    // Never-attempted outranks a merely well-leveled, not-yet-due passage -
    // same rule `sortPassagesByNeed`'s own tests (panel.test.ts) cover.
    expect(rowReferences(root)).toEqual(['Romans 8:28-30', 'Psalm 1:1-6']);
  });

  it('tells the worker and reloads when the sort choice is changed', async () => {
    host.handlers.setPassageSortOrder = () => ({ ok: true, data: {} });
    const root = renderPlan(host, planWithSort(needOrderDisagreesWithBibleOrder(), 'bible'));
    container.appendChild(root);

    const select = root.querySelector<HTMLSelectElement>('.sm-select')!;
    select.value = 'need';
    select.dispatchEvent(new Event('change'));
    await settle();

    expect(host.requests).toContainEqual({ type: 'setPassageSortOrder', order: 'need' });
    expect(host.reloads).toBeGreaterThan(0);
  });

  it('does not reload when persisting the choice fails', async () => {
    host.handlers.setPassageSortOrder = () => ({ ok: false, error: 'boom' });
    const root = renderPlan(host, planWithSort(needOrderDisagreesWithBibleOrder(), 'bible'));
    container.appendChild(root);

    const select = root.querySelector<HTMLSelectElement>('.sm-select')!;
    select.value = 'need';
    select.dispatchEvent(new Event('change'));
    await settle();

    expect(host.requests).toContainEqual({ type: 'setPassageSortOrder', order: 'need' });
    expect(host.reloads).toBe(0);
    expect(host.announcements).toContain('boom');
  });
});

// ---------------------------------------------------------------------------
// 7b. The home screen's activity tile grid (round-2 UI review, M2)
// ---------------------------------------------------------------------------

describe('the activity tile grid', () => {
  function planWithPassages(passages: PassageView[]): PlanView {
    return {
      collectionId: 1,
      collectionName: 'My plan',
      totalDue: 0,
      defaultAnswerMode: 'firstLetter',
      sortOrder: 'bible',
      passages,
    };
  }

  /**
   * Two passages, each with the default fixture's six verses - enough to
   * satisfy every tile's own availability rule except `provideref`, which
   * `activityAvailability` reports as unavailable regardless of the plan
   * (M7 has not landed the exercise).
   */
  function fullyAvailablePlan(): PlanView {
    return planWithPassages([
      passageViewFixture({ passage: passageFixture({ id: 10, reference: 'Psalm 23:1-6' }) }),
      passageViewFixture({ passage: passageFixture({ id: 11, reference: 'Psalm 1:1-6' }) }),
    ]);
  }

  function tileButtons(root: HTMLElement): HTMLButtonElement[] {
    return Array.from(root.querySelectorAll<HTMLButtonElement>('.sm-tile'));
  }

  function findTile(root: HTMLElement, title: string): HTMLButtonElement {
    return tileButtons(root).find((t) => spokenText(t.querySelector('.sm-tile-title')!) === title)!;
  }

  it('renders all six tiles, in catalogue order, with their title, subtext and icon', () => {
    const root = renderPlan(host, fullyAvailablePlan());
    container.appendChild(root);

    const tiles = tileButtons(root);
    expect(tiles.length).toBe(ACTIVITY_TILES.length);

    tiles.forEach((tileEl, i) => {
      const tile = ACTIVITY_TILES[i]!;
      expect(spokenText(tileEl.querySelector('.sm-tile-title')!)).toBe(tile.title);
      expect(spokenText(tileEl.querySelector('.sm-tile-sub')!)).toBe(tile.subtext);
      expect(tileEl.querySelector(`.sm-icon-${tile.id}`)).not.toBeNull();
    });
  });

  it('starts the variety flow, with no rung, when the Variety tile is pressed', () => {
    const root = renderPlan(host, fullyAvailablePlan());
    container.appendChild(root);

    const tile = findTile(root, 'Variety');
    expect(tile.disabled).toBe(false);

    tile.click();
    expect(host.flowsStarted).toEqual([{ flow: { kind: 'variety' }, exclude: undefined }]);
  });

  it("starts an explicit activity flow naming the tile's own rung when a rung-backed tile is pressed", () => {
    const root = renderPlan(host, fullyAvailablePlan());
    container.appendChild(root);

    const tile = findTile(root, 'Fill in the Blanks');
    expect(tile.disabled).toBe(false);

    tile.click();
    expect(host.flowsStarted).toEqual([{ flow: { kind: 'activity', rung: 'blanks' }, exclude: undefined }]);
  });

  it('keeps an unavailable tile visible but disabled, shows its warning as a third line, and does nothing when pressed', () => {
    // One passage only - below `MIN_PASSAGES_FOR_REFMATCH` (2), so "Match
    // References" is unavailable.
    const root = renderPlan(host, planWithPassages([passageViewFixture()]));
    container.appendChild(root);

    const tile = findTile(root, 'Match References');
    expect(tile.disabled).toBe(true);

    const warning = tile.querySelector('.sm-tile-warning');
    expect(warning).not.toBeNull();
    expect(spokenText(warning!)).toContain('Requires at least 2 passages');

    tile.click();
    expect(host.flowsStarted).toEqual([]);
  });

  it('shows the Provide Reference tile as always unavailable, with "Not available yet.", regardless of the plan', () => {
    const root = renderPlan(host, fullyAvailablePlan());
    container.appendChild(root);

    const tile = findTile(root, 'Provide Reference');
    expect(tile.disabled).toBe(true);
    expect(spokenText(tile.querySelector('.sm-tile-warning')!)).toBe('Not available yet.');

    tile.click();
    expect(host.flowsStarted).toEqual([]);
  });

  it('shows no tile grid at all on an empty plan - the empty state replaces it', () => {
    const root = renderPlan(host, emptyPlan());
    container.appendChild(root);

    expect(root.querySelector('.sm-tile-grid')).toBeNull();
    expect(root.querySelector('.sm-empty')).not.toBeNull();
  });
});

describe('the passage screen', () => {
  it('offers one big Practice button that starts the suggested activity', () => {
    // The fixture's suggested activity is `blanks` (see the "selects the
    // suggested activity's tab by default" test below) - a second review
    // round asked that a decision be made *for* the user rather than only
    // offered per-row, "so the user never has to not practice for lack of
    // decisiveness".
    const pv = passageViewFixture();
    const root = renderPassageScreen(host, pv, 'firstLetter');
    container.appendChild(root);

    const callout = root.querySelector<HTMLElement>('.sm-callout-action')!;
    const practiceButton = callout.querySelector('button')!;
    expect(practiceButton.textContent).toBe('Practice');

    practiceButton.click();
    expect(host.sessionsStarted).toEqual([{ passageId: pv.passage.id, rung: 'blanks', restart: undefined }]);
  });

  it('offers "Resume practicing" instead of "Practice" when the suggested activity was left mid-way', () => {
    const pv = passageViewFixture({
      rungs: [
        rungView({ rung: 'ordering', level: 3 }),
        rungView({ rung: 'refmatch', applicable: false }),
        rungView({ rung: 'blanks', level: 1, dueAt: NOW - 60_000, resume: { stepsDone: 2, totalSteps: 6 } }),
        rungView({ rung: 'firstletters' }),
      ],
    });
    const root = renderPassageScreen(host, pv, 'firstLetter');
    container.appendChild(root);

    const practiceButton = root.querySelector<HTMLElement>('.sm-callout-action')!.querySelector('button')!;
    // The button's label must not disagree with what pressing it actually
    // does - `host.startSession` without `restart` resumes a paused activity.
    expect(practiceButton.textContent).toBe('Resume practicing');
  });

  it('draws one tab per applicable activity, in ladder order, and none for one that does not apply', () => {
    const pv = passageViewFixture();
    const root = renderPassageScreen(host, pv, 'firstLetter');
    container.appendChild(root);

    const tabLabels = Array.from(root.querySelectorAll<HTMLButtonElement>('[role="tab"]')).map(
      (t) => t.textContent,
    );
    // Four rungs in the fixture; `refmatch` is inapplicable and gets no tab
    // at all, in ladder order rather than whatever order the worker sent.
    expect(tabLabels).toEqual(['Put in order', 'Fill in the blanks', 'First letters only']);
  });

  it('keeps an inapplicable activity out of the tab strip, but still explains it in the body', () => {
    const root = renderPassageScreen(host, passageViewFixture(), 'firstLetter');
    container.appendChild(root);

    const tabLabels = Array.from(root.querySelectorAll('[role="tab"]')).map((t) => t.textContent);
    expect(tabLabels).not.toContain('Match the reference');
    expect(spokenText(root)).toContain('Matching a reference needs other passages');
  });

  it("selects the suggested activity's tab by default, and shows only that activity's detail", () => {
    // The fixture's `blanks` is due; everything else is not. `suggestedRungFor`
    // is exercised for real here, not stubbed.
    const root = renderPassageScreen(host, passageViewFixture(), 'firstLetter');
    container.appendChild(root);

    const tabButtons = Array.from(root.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
    const selected = tabButtons.filter((t) => t.getAttribute('aria-selected') === 'true');
    expect(selected.map((t) => t.textContent)).toEqual(['Fill in the blanks']);

    // Only the selected activity's own detail is drawn now - the old stacked
    // list of every activity's card (one per rung, four in this fixture) is
    // gone.
    expect(root.querySelectorAll('.sm-activity-card')).toHaveLength(1);
  });

  it('lets an explicit view rung override which tab is selected', () => {
    // The fixture's suggestion is `blanks`; passing `rung` explicitly (as
    // `panel.ts` does with `state.ts#View`'s own `rung`) wins over it.
    const root = renderPassageScreen(host, passageViewFixture(), 'firstLetter', 'ordering');
    container.appendChild(root);

    const selected = root.querySelector<HTMLButtonElement>('[role="tab"][aria-selected="true"]')!;
    expect(selected.textContent).toBe('Put in order');
  });

  it('dispatches goPassage with the clicked rung when a different tab is chosen', () => {
    const pv = passageViewFixture();
    const root = renderPassageScreen(host, pv, 'firstLetter');
    container.appendChild(root);

    const orderingTab = Array.from(root.querySelectorAll<HTMLButtonElement>('[role="tab"]')).find(
      (t) => t.textContent === 'Put in order',
    )!;
    orderingTab.click();

    expect(host.navigations).toContainEqual({
      type: 'goPassage',
      passageId: pv.passage.id,
      rung: 'ordering',
    });
  });

  it('moves focus among tabs with Left/Right/Home/End, on a roving tabindex', () => {
    const root = renderPassageScreen(host, passageViewFixture(), 'firstLetter');
    container.appendChild(root);

    const tabButtons = Array.from(root.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
    // `blanks` (index 1) is selected by default and is the only tab in the
    // page's own Tab order until the arrows move it.
    expect(tabButtons.map((t) => t.tabIndex)).toEqual([-1, 0, -1]);

    tabButtons[1]!.focus();
    tabButtons[1]!.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }),
    );
    expect(document.activeElement).toBe(tabButtons[2]);
    expect(tabButtons.map((t) => t.tabIndex)).toEqual([-1, -1, 0]);

    tabButtons[2]!.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }),
    );
    expect(document.activeElement).toBe(tabButtons[0]); // wraps past the end

    tabButtons[0]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true, cancelable: true }));
    expect(document.activeElement).toBe(tabButtons[2]);

    tabButtons[2]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true, cancelable: true }));
    expect(document.activeElement).toBe(tabButtons[0]);

    // Moving focus is not itself a selection - only a click (or Enter/Space,
    // which a `<button>` already turns into one) navigates.
    expect(host.navigations).toEqual([]);
  });

  it('offers Restart and Resume, not a plain Practice, for a paused activity', () => {
    const pv = passageViewFixture({
      rungs: [
        rungView({ rung: 'ordering', level: 2, resume: { stepsDone: 2, totalSteps: 5 } }),
        rungView({ rung: 'refmatch', applicable: false }),
        rungView({ rung: 'blanks' }),
        rungView({ rung: 'firstletters' }),
      ],
    });
    // Nothing is due and `ordering` is the first applicable rung below
    // mastered, so it is the suggested - and so default-selected - activity.
    const root = renderPassageScreen(host, pv, 'firstLetter');
    container.appendChild(root);

    const card = root.querySelector('.sm-activity-card')!;
    const labels = Array.from(card.querySelectorAll('button')).map((b) => b.textContent);
    expect(labels).toEqual(['Restart', 'Resume']);
    expect(spokenText(card)).toContain('Paused at verse 2 of 5');
  });

  it('starts the right activity, with restart, from the Restart button', () => {
    const pv = passageViewFixture({
      rungs: [
        rungView({ rung: 'ordering', resume: { stepsDone: 1, totalSteps: 5 } }),
        rungView({ rung: 'refmatch', applicable: false }),
        rungView({ rung: 'blanks' }),
        rungView({ rung: 'firstletters' }),
      ],
    });
    const root = renderPassageScreen(host, pv, 'firstLetter');
    container.appendChild(root);

    const restart = Array.from(root.querySelectorAll('button')).find((b) => b.textContent === 'Restart')!;
    restart.click();

    expect(host.sessionsStarted).toEqual([{ passageId: pv.passage.id, rung: 'ordering', restart: true }]);
  });

  it('lets a passage override the answer mode, and tells the worker', async () => {
    host.handlers.setPassageAnswerMode = () => ({ ok: true, data: {} });
    const pv = passageViewFixture();
    const root = renderPassageScreen(host, pv, 'firstLetter');
    container.appendChild(root);

    const select = root.querySelector<HTMLSelectElement>('#sm-answer-mode')!;
    select.value = 'fullWord';
    select.dispatchEvent(new Event('change'));
    await settle();

    const sent = host.requests.find((r) => r.type === 'setPassageAnswerMode');
    expect(sent).toMatchObject({ type: 'setPassageAnswerMode', passageId: pv.passage.id, mode: 'fullWord' });
  });

  it('asks for confirmation before removing a passage that has already been practiced', () => {
    const pv = passageViewFixture({ bestLevel: 4 });
    const root = renderPassageScreen(host, pv, 'firstLetter');
    container.appendChild(root);

    expect(spokenText(root)).not.toContain('Remove this passage and its history?');
    root.querySelector<HTMLButtonElement>('.sm-remove button')!.click();
    expect(spokenText(root)).toContain('Remove this passage and its history?');
    // Not removed yet - only the confirmation step has been shown.
    expect(host.requests.filter((r) => r.type === 'removePassage')).toEqual([]);
  });

  it('removes a never-practiced passage immediately, with no confirmation step', () => {
    // `passageViewFixture()`'s default `bestLevel` is 0 - nothing has ever
    // been attempted, so there is no history a confirmation would protect.
    host.handlers.removePassage = () => ({ ok: true, data: {} });
    const pv = passageViewFixture({ bestLevel: 0 });
    const root = renderPassageScreen(host, pv, 'firstLetter');
    container.appendChild(root);

    root.querySelector<HTMLButtonElement>('.sm-remove button')!.click();

    expect(spokenText(root)).not.toContain('Remove this passage and its history?');
    expect(host.requests).toContainEqual({ type: 'removePassage', passageId: pv.passage.id });
  });

  it('hides the answer-mode setting behind a gear icon until it is opened', () => {
    // A follow-up review round: "Hide the 'first letter' setting behind a
    // Settings icon for cleanliness."
    const root = renderPassageScreen(host, passageViewFixture(), 'firstLetter');
    container.appendChild(root);

    const select = root.querySelector<HTMLSelectElement>('#sm-answer-mode')!;
    expect(select.closest('[hidden]')).not.toBeNull();

    const gear = root.querySelector<HTMLButtonElement>('[aria-label="Answer mode settings"]')!;
    expect(gear.getAttribute('aria-expanded')).toBe('false');

    gear.click();

    expect(select.closest('[hidden]')).toBeNull();
    expect(gear.getAttribute('aria-expanded')).toBe('true');

    gear.click();

    expect(select.closest('[hidden]')).not.toBeNull();
    expect(gear.getAttribute('aria-expanded')).toBe('false');
  });
});

// ---------------------------------------------------------------------------
// 7b. The settings screen
// ---------------------------------------------------------------------------

describe('the settings screen', () => {
  function settings(mode: AnswerMode = 'firstLetter'): SettingsView {
    return { defaultAnswerMode: mode };
  }

  it('checks the radio matching the current default', () => {
    const root = renderSettings(host, settings('fullWord'), emptyPlan());
    container.appendChild(root);

    const checked = root.querySelector<HTMLInputElement>('input[type="radio"]:checked')!;
    expect(checked.value).toBe('fullWord');
  });

  it('tells the worker when the default is changed', async () => {
    host.handlers.setDefaultAnswerMode = () => ({ ok: true, data: {} });
    const root = renderSettings(host, settings('firstLetter'), emptyPlan());
    container.appendChild(root);

    const fullWord = root.querySelector<HTMLInputElement>('input[value="fullWord"]')!;
    fullWord.checked = true;
    fullWord.dispatchEvent(new Event('change'));
    await settle();

    expect(host.requests).toContainEqual({ type: 'setDefaultAnswerMode', mode: 'fullWord' });
  });

  it('lists only the passages that have overridden the default', () => {
    const plan: PlanView = {
      collectionId: 1,
      collectionName: 'My plan',
      totalDue: 0,
      defaultAnswerMode: 'firstLetter',
      sortOrder: 'bible',
      passages: [
        passageViewFixture({ passage: passageFixture({ id: 1, reference: 'Psalm 23:1-6', answerMode: 'fullWord' }) }),
        passageViewFixture({ passage: passageFixture({ id: 2, reference: 'John 3:16', answerMode: null }) }),
      ],
    };
    const root = renderSettings(host, settings(), plan);
    container.appendChild(root);

    expect(spokenText(root)).toContain('Psalm 23:1-6');
    expect(spokenText(root)).not.toContain('John 3:16');
  });

  it('navigates to a passage screen from "Change"', () => {
    const plan: PlanView = {
      collectionId: 1,
      collectionName: 'My plan',
      totalDue: 0,
      defaultAnswerMode: 'firstLetter',
      sortOrder: 'bible',
      passages: [
        passageViewFixture({ passage: passageFixture({ id: 7, reference: 'Psalm 23:1-6', answerMode: 'fullWord' }) }),
      ],
    };
    const root = renderSettings(host, settings(), plan);
    container.appendChild(root);

    const change = Array.from(root.querySelectorAll('button')).find((b) => b.textContent === 'Change')!;
    change.click();

    expect(host.navigations).toContainEqual({ type: 'goPassage', passageId: 7 });
  });
});

// ---------------------------------------------------------------------------
// 7c. The manage passages screen (P1)
// ---------------------------------------------------------------------------

describe('the manage passages screen', () => {
  function managePlan(passages: PassageView[] = [], collectionName = 'My plan'): PlanView {
    return {
      collectionId: 1,
      collectionName,
      passages,
      totalDue: 0,
      defaultAnswerMode: 'firstLetter',
      sortOrder: 'bible',
    };
  }

  function collectionViewFixture(over: Partial<CollectionView> = {}): CollectionView {
    return { id: 1, name: 'My plan', passageCount: 0, ...over };
  }

  /** The one `<li>` row for a given list name, once `getCollections` has resolved. */
  function listRow(root: HTMLElement, name: string): HTMLElement {
    const row = Array.from(root.querySelectorAll<HTMLElement>('ul[aria-label="Lists"] > li')).find((li) =>
      spokenText(li).includes(name),
    );
    if (!row) throw new Error(`No list row found for "${name}"`);
    return row;
  }

  it('breadcrumbs Home › Manage passages, with Manage passages as the current page', () => {
    const root = renderManage(host, managePlan());
    container.appendChild(root);

    const crumbLabels = Array.from(root.querySelectorAll('.sm-crumb, .sm-crumb-current')).map((n) =>
      n.textContent?.trim(),
    );
    expect(crumbLabels.some((l) => l?.includes('Home'))).toBe(true);
    expect(crumbLabels.some((l) => l?.includes('Manage passages'))).toBe(true);

    const current = root.querySelector('[aria-current="page"]')!;
    expect(current.textContent).toContain('Manage passages');
    expect(current.tagName).toBe('H1');
  });

  it('goes home from the Home crumb', () => {
    const root = renderManage(host, managePlan());
    container.appendChild(root);

    root.querySelectorAll('button').forEach((b) => {
      if (b.textContent === 'Home') b.click();
    });

    expect(host.navigations).toContainEqual({ type: 'goPlan' });
  });

  // -------------------------------------------------------------------------
  // The lists table (P5)
  // -------------------------------------------------------------------------

  it('renders one row per collection, each with its own name, Edit and Delete enabled', async () => {
    host.handlers.getCollections = () => ({
      ok: true,
      data: [
        collectionViewFixture({ id: 1, name: 'My plan' }),
        collectionViewFixture({ id: 2, name: 'Sunday memory verses' }),
      ],
    });
    const root = renderManage(host, managePlan());
    container.appendChild(root);
    await settle();

    const rows = root.querySelectorAll('ul[aria-label="Lists"] > li');
    expect(rows.length).toBe(2);
    expect(spokenText(root)).toContain('My plan');
    expect(spokenText(root)).toContain('Sunday memory verses');

    for (const name of ['My plan', 'Sunday memory verses']) {
      const row = listRow(root, name);
      const edit = Array.from(row.querySelectorAll('button')).find((b) => b.textContent === 'Edit')!;
      const del = Array.from(row.querySelectorAll('button')).find((b) => b.textContent === 'Delete')!;
      expect(edit.disabled).toBe(false);
      expect(del.disabled).toBe(false);
    }
    // A lone list works exactly the same way - `deleteCollection` does not
    // special-case "the last list", so neither does this table any more.
    expect(spokenText(root)).not.toContain("can't be deleted");
  });

  it('renames a row (not just the first one) on Save, and reloads both the table and the screen', async () => {
    host.handlers.getCollections = () => ({
      ok: true,
      data: [
        collectionViewFixture({ id: 1, name: 'My plan' }),
        collectionViewFixture({ id: 2, name: 'Sunday memory verses' }),
      ],
    });
    host.handlers.renameCollection = () => ({ ok: true, data: {} });
    const root = renderManage(host, managePlan());
    container.appendChild(root);
    await settle();

    const row = listRow(root, 'Sunday memory verses');
    const edit = Array.from(row.querySelectorAll('button')).find((b) => b.textContent === 'Edit')!;
    edit.click();

    const input = row.querySelector<HTMLInputElement>('input[aria-label="List name"]')!;
    expect(input.value).toBe('Sunday memory verses');
    input.value = 'Renamed list';

    const save = Array.from(row.querySelectorAll('button')).find((b) => b.textContent === 'Save')!;
    save.click();
    await settle();

    expect(host.requests).toContainEqual({
      type: 'renameCollection',
      collectionId: 2,
      name: 'Renamed list',
    });
    expect(host.reloads).toBe(1);
  });

  it('cancels an in-progress rename without sending a request', async () => {
    const root = renderManage(host, managePlan());
    container.appendChild(root);
    await settle();

    const row = listRow(root, 'My plan');
    const edit = Array.from(row.querySelectorAll('button')).find((b) => b.textContent === 'Edit')!;
    edit.click();
    expect(row.querySelector('input[aria-label="List name"]')).not.toBeNull();

    const cancel = Array.from(row.querySelectorAll('button')).find((b) => b.textContent === 'Cancel')!;
    cancel.click();

    expect(row.querySelector('input[aria-label="List name"]')).toBeNull();
    expect(spokenText(row)).toContain('My plan');
    expect(host.requests.filter((r) => r.type === 'renameCollection')).toEqual([]);
  });

  it('refuses to save a blank name', async () => {
    const root = renderManage(host, managePlan());
    container.appendChild(root);
    await settle();

    const row = listRow(root, 'My plan');
    const edit = Array.from(row.querySelectorAll('button')).find((b) => b.textContent === 'Edit')!;
    edit.click();

    const input = row.querySelector<HTMLInputElement>('input[aria-label="List name"]')!;
    input.value = '   ';

    const save = Array.from(row.querySelectorAll('button')).find((b) => b.textContent === 'Save')!;
    save.click();
    await settle();

    expect(host.requests.filter((r) => r.type === 'renameCollection')).toEqual([]);
    expect(spokenText(row)).toContain('Give the list a name.');
  });

  it('shows the simple confirm when a list has no practice history, and deletes it on "Yes, delete"', async () => {
    host.handlers.getCollections = () => ({
      ok: true,
      data: [collectionViewFixture({ id: 1, name: 'My plan' }), collectionViewFixture({ id: 2, name: 'Empty list' })],
    });
    host.handlers.getCollectionPracticeStats = () => ({ ok: true, data: { total: 3, practiced: 0 } });
    host.handlers.deleteCollection = () => ({ ok: true, data: {} });
    const root = renderManage(host, managePlan());
    container.appendChild(root);
    await settle();

    const row = listRow(root, 'Empty list');
    const del = row.querySelector<HTMLButtonElement>('button[aria-label="Delete Empty list"]')!;
    del.click();
    await settle();

    expect(host.requests).toContainEqual({ type: 'getCollectionPracticeStats', collectionId: 2 });
    expect(spokenText(row)).toContain('Delete "Empty list"?');
    expect(row.querySelector('input')).toBeNull();

    const confirm = Array.from(row.querySelectorAll('button')).find((b) => b.textContent === 'Yes, delete')!;
    confirm.click();
    await settle();

    expect(host.requests).toContainEqual({ type: 'deleteCollection', collectionId: 2 });
    expect(host.announcements).toContainEqual('Deleted Empty list.');
    expect(host.reloads).toBe(1);
  });

  it('cancels the simple delete confirm without sending deleteCollection', async () => {
    host.handlers.getCollectionPracticeStats = () => ({ ok: true, data: { total: 0, practiced: 0 } });
    const root = renderManage(host, managePlan());
    container.appendChild(root);
    await settle();

    const row = listRow(root, 'My plan');
    row.querySelector<HTMLButtonElement>('button[aria-label="Delete My plan"]')!.click();
    await settle();
    expect(spokenText(row)).toContain('Delete "My plan"?');

    const cancel = Array.from(row.querySelectorAll('button')).find((b) => b.textContent === 'Cancel')!;
    cancel.click();

    expect(spokenText(row)).not.toContain('Delete "My plan"?');
    expect(spokenText(row)).toContain('My plan');
    expect(host.requests.filter((r) => r.type === 'deleteCollection')).toEqual([]);
  });

  it('shows the stronger, name-typed warning - with the exact N-of-M wording - when a list has practice history', async () => {
    host.handlers.getCollections = () => ({ ok: true, data: [collectionViewFixture({ id: 5, name: 'Psalm list' })] });
    host.handlers.getCollectionPracticeStats = () => ({ ok: true, data: { total: 4, practiced: 3 } });
    host.handlers.deleteCollection = () => ({ ok: true, data: {} });
    const root = renderManage(host, managePlan());
    container.appendChild(root);
    await settle();

    const row = listRow(root, 'Psalm list');
    row.querySelector<HTMLButtonElement>('button[aria-label="Delete Psalm list"]')!.click();
    await settle();

    expect(host.requests).toContainEqual({ type: 'getCollectionPracticeStats', collectionId: 5 });
    expect(spokenText(row)).toContain(
      'This list has practice history on 3 of 4 passages. Deleting it removes that history.',
    );

    const input = row.querySelector<HTMLInputElement>('input')!;
    const confirm = Array.from(row.querySelectorAll('button')).find((b) => b.textContent === 'Yes, delete') as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);

    input.value = 'wrong name';
    input.dispatchEvent(new Event('input'));
    expect(confirm.disabled).toBe(true);

    input.value = 'Psalm list';
    input.dispatchEvent(new Event('input'));
    expect(confirm.disabled).toBe(false);

    confirm.click();
    await settle();

    expect(host.requests).toContainEqual({ type: 'deleteCollection', collectionId: 5 });
    expect(host.announcements).toContainEqual('Deleted Psalm list.');
    expect(host.reloads).toBe(1);
  });

  it('cancels the history-gated delete confirm without sending deleteCollection', async () => {
    host.handlers.getCollections = () => ({ ok: true, data: [collectionViewFixture({ id: 5, name: 'Psalm list' })] });
    host.handlers.getCollectionPracticeStats = () => ({ ok: true, data: { total: 4, practiced: 3 } });
    const root = renderManage(host, managePlan());
    container.appendChild(root);
    await settle();

    const row = listRow(root, 'Psalm list');
    row.querySelector<HTMLButtonElement>('button[aria-label="Delete Psalm list"]')!.click();
    await settle();

    const cancel = Array.from(row.querySelectorAll('button')).find((b) => b.textContent === 'Cancel')!;
    cancel.click();

    expect(spokenText(row)).not.toContain('practice history');
    expect(spokenText(row)).toContain('Psalm list');
    expect(row.querySelector('input')).toBeNull();
    expect(host.requests.filter((r) => r.type === 'deleteCollection')).toEqual([]);
  });

  it('creates a new list via "+ New list", and reloads', async () => {
    host.handlers.createCollection = (req) => ({ ok: true, data: { id: 9, name: req.name } });
    const root = renderManage(host, managePlan());
    container.appendChild(root);
    await settle();

    const openBtn = Array.from(root.querySelectorAll('button')).find((b) => b.textContent === '+ New list')!;
    openBtn.click();

    const input = root.querySelector<HTMLInputElement>('input[aria-label="List name"]')!;
    input.value = 'Sunday memory verses';

    const create = Array.from(root.querySelectorAll('button')).find((b) => b.textContent === 'Create')!;
    create.click();
    await settle();

    expect(host.requests).toContainEqual({ type: 'createCollection', name: 'Sunday memory verses' });
    expect(host.announcements).toContainEqual('Created Sunday memory verses.');
    expect(host.reloads).toBe(1);
  });

  it('refuses to create a list with a blank name', async () => {
    const root = renderManage(host, managePlan());
    container.appendChild(root);
    await settle();

    Array.from(root.querySelectorAll('button')).find((b) => b.textContent === '+ New list')!.click();
    const create = Array.from(root.querySelectorAll('button')).find((b) => b.textContent === 'Create')!;
    create.click();
    await settle();

    expect(host.requests.filter((r) => r.type === 'createCollection')).toEqual([]);
    expect(spokenText(root)).toContain('Give the list a name.');
  });

  // -------------------------------------------------------------------------
  // "Add a suggested list…" (P7)
  // -------------------------------------------------------------------------

  describe('"Add a suggested list…"', () => {
    /** The suggested-lists modal's own dialog, however it got opened. */
    function suggestedDialog(root: HTMLElement): HTMLElement {
      return root.querySelector<HTMLElement>('[role="dialog"]')!;
    }

    function suggestedBackdrop(root: HTMLElement): HTMLElement {
      return root.querySelector<HTMLElement>('.sm-modal-backdrop')!;
    }

    function openSuggestedListsModal(root: HTMLElement): void {
      Array.from(root.querySelectorAll('button'))
        .find((b) => b.textContent === 'Add a suggested list…')!
        .click();
    }

    it('opens the modal, showing the Romans Road entry\'s name, description and an "Add this list" button', () => {
      const root = renderManage(host, managePlan());
      container.appendChild(root);

      openSuggestedListsModal(root);

      expect(suggestedBackdrop(root).hidden).toBe(false);
      const romansRoad = SUGGESTED_LISTS.find((l) => l.id === 'romans-road')!;
      const dialogText = spokenText(suggestedDialog(root));
      expect(dialogText).toContain(romansRoad.name);
      expect(dialogText).toContain(romansRoad.description);
      expect(
        Array.from(suggestedDialog(root).querySelectorAll('button')).some((b) => b.textContent === 'Add this list'),
      ).toBe(true);
    });

    it('closes again on Close without creating anything', () => {
      const root = renderManage(host, managePlan());
      container.appendChild(root);

      openSuggestedListsModal(root);
      Array.from(suggestedDialog(root).querySelectorAll('button')).find((b) => b.textContent === 'Close')!.click();

      expect(suggestedBackdrop(root).hidden).toBe(true);
      expect(host.requests.filter((r) => r.type === 'createCollection')).toEqual([]);
    });

    it(
      'pressing "Add this list" creates the collection, activates it *before* adding, ' +
        'adds all five Romans Road references, reloads, closes the modal and announces the result',
      async () => {
        const references = ['Romans 3:23', 'Romans 6:23', 'Romans 5:8', 'Romans 10:9-10', 'Romans 10:13'];
        host.handlers.createCollection = (req) => ({ ok: true, data: { id: 42, name: req.name } });
        host.handlers.setActiveCollection = () => ({ ok: true, data: {} });
        // Distinct id and non-overlapping verse range per reference (as the
        // batch-add tests above do): otherwise every stubbed passage shares
        // `passageFixture`'s default range and `addReferences`'s own overlap
        // consolidation collapses all five into one, which is not what this
        // test is about.
        host.handlers.addPassage = (req) => {
          const index = references.indexOf(req.reference);
          return {
            ok: true,
            data: {
              passage: passageFixture({
                id: 200 + index,
                reference: req.reference,
                startVerseId: 45000000 + index * 100,
                endVerseId: 45000000 + index * 100 + 5,
              }),
            },
          };
        };

        const root = renderManage(host, managePlan());
        container.appendChild(root);
        await settle();

        openSuggestedListsModal(root);
        Array.from(suggestedDialog(root).querySelectorAll('button'))
          .find((b) => b.textContent === 'Add this list')!
          .click();
        // Two sequential requests (create, then activate) ahead of five more
        // (one per reference) is a longer chain than `settle()`'s own six
        // ticks comfortably covers elsewhere in this file - a second call
        // lets it fully drain rather than asserting mid-chain.
        await settle();
        await settle();

        expect(host.requests).toContainEqual({ type: 'createCollection', name: 'Romans Road' });
        expect(host.requests).toContainEqual({ type: 'setActiveCollection', collectionId: 42 });
        expect(
          host.requests.filter((r) => r.type === 'addPassage').map((r) => (r as { reference: string }).reference),
        ).toEqual(['Romans 3:23', 'Romans 6:23', 'Romans 5:8', 'Romans 10:9-10', 'Romans 10:13']);

        // The new list must be made active *before* any addPassage - that RPC
        // has no collectionId of its own and always acts on whichever
        // collection is currently active (`main.ts#resolveActiveCollectionId`).
        const createIndex = host.requests.findIndex((r) => r.type === 'createCollection');
        const activeIndex = host.requests.findIndex((r) => r.type === 'setActiveCollection');
        const firstAddIndex = host.requests.findIndex((r) => r.type === 'addPassage');
        expect(createIndex).toBeLessThan(activeIndex);
        expect(activeIndex).toBeLessThan(firstAddIndex);

        expect(host.announcements).toContainEqual('Added Romans Road (5 references).');
        expect(host.reloads).toBeGreaterThan(0);
        expect(suggestedBackdrop(root).hidden).toBe(true);
      },
    );

    it('reports a failed reference rather than swallowing it, and still reloads', async () => {
      const references = ['Romans 3:23', 'Romans 6:23', 'Romans 5:8', 'Romans 10:9-10', 'Romans 10:13'];
      host.handlers.createCollection = (req) => ({ ok: true, data: { id: 7, name: req.name } });
      host.handlers.setActiveCollection = () => ({ ok: true, data: {} });
      // Distinct id/range per reference - see the note in the test above.
      host.handlers.addPassage = (req) => {
        if (req.reference === 'Romans 5:8') return { ok: false, error: 'boom' };
        const index = references.indexOf(req.reference);
        return {
          ok: true,
          data: {
            passage: passageFixture({
              id: 300 + index,
              reference: req.reference,
              startVerseId: 46000000 + index * 100,
              endVerseId: 46000000 + index * 100 + 5,
            }),
          },
        };
      };

      const root = renderManage(host, managePlan());
      container.appendChild(root);
      await settle();

      openSuggestedListsModal(root);
      Array.from(suggestedDialog(root).querySelectorAll('button'))
        .find((b) => b.textContent === 'Add this list')!
        .click();
      await settle();
      await settle();

      expect(host.announcements).toContainEqual('Added Romans Road: 4 references added, 1 reference failed.');
      expect(host.reloads).toBeGreaterThan(0);
    });

    it('shows the worker\'s error and does not add references when createCollection itself fails', async () => {
      host.handlers.createCollection = () => ({ ok: false, error: 'Could not create the list.' });

      const root = renderManage(host, managePlan());
      container.appendChild(root);
      await settle();

      openSuggestedListsModal(root);
      Array.from(suggestedDialog(root).querySelectorAll('button'))
        .find((b) => b.textContent === 'Add this list')!
        .click();
      await settle();

      expect(spokenText(suggestedDialog(root))).toContain('Could not create the list.');
      expect(host.requests.filter((r) => r.type === 'setActiveCollection')).toEqual([]);
      expect(host.requests.filter((r) => r.type === 'addPassage')).toEqual([]);
      // Left open so the error is visible, not closed as if it had worked.
      expect(suggestedBackdrop(root).hidden).toBe(false);
    });
  });

  it('lists every passage in the plan', () => {
    const plan = managePlan([
      passageViewFixture({ passage: passageFixture({ id: 1, reference: 'Psalm 23:1-6' }) }),
      passageViewFixture({ passage: passageFixture({ id: 2, reference: 'John 3:16' }) }),
    ]);
    const root = renderManage(host, plan);
    container.appendChild(root);

    expect(spokenText(root)).toContain('Psalm 23:1-6');
    expect(spokenText(root)).toContain('John 3:16');
  });

  it('asks for confirmation before removing a passage, then removes it on "Yes, remove"', async () => {
    host.handlers.removePassage = () => ({ ok: true, data: {} });
    const plan = managePlan([
      passageViewFixture({ passage: passageFixture({ id: 56, reference: 'Psalm 23:1-6' }) }),
    ]);
    const root = renderManage(host, plan);
    container.appendChild(root);

    expect(spokenText(root)).not.toContain('Remove this passage and its history?');

    const removeButton = root.querySelector<HTMLButtonElement>('.sm-row button[aria-label="Remove Psalm 23:1-6 from the plan"]')!;
    removeButton.click();

    expect(spokenText(root)).toContain('Remove this passage and its history?');
    expect(host.requests.filter((r) => r.type === 'removePassage')).toEqual([]);

    const confirm = Array.from(root.querySelectorAll('button')).find((b) => b.textContent === 'Yes, remove')!;
    confirm.click();
    await settle();

    expect(host.requests).toContainEqual({ type: 'removePassage', passageId: 56 });
    expect(host.announcements).toContainEqual('Removed Psalm 23:1-6.');
    expect(host.reloads).toBe(1);
  });

  it('cancels the remove confirmation without sending a request', () => {
    const plan = managePlan([
      passageViewFixture({ passage: passageFixture({ id: 56, reference: 'Psalm 23:1-6' }) }),
    ]);
    const root = renderManage(host, plan);
    container.appendChild(root);

    const removeButton = root.querySelector<HTMLButtonElement>('.sm-row button[aria-label="Remove Psalm 23:1-6 from the plan"]')!;
    removeButton.click();

    const cancel = Array.from(root.querySelectorAll('button')).find((b) => b.textContent === 'Cancel')!;
    cancel.click();

    expect(spokenText(root)).not.toContain('Remove this passage and its history?');
    expect(root.querySelector('button[aria-label="Remove Psalm 23:1-6 from the plan"]')).not.toBeNull();
    expect(host.requests.filter((r) => r.type === 'removePassage')).toEqual([]);
    expect(host.reloads).toBe(0);
  });

  it('shows an empty state when there are no passages yet', () => {
    const root = renderManage(host, managePlan([]));
    container.appendChild(root);

    expect(spokenText(root)).toContain('Nothing in your plan yet.');
  });
});

// ---------------------------------------------------------------------------
// 7b. The add-passage form (moved to Manage Passages, M5)
// ---------------------------------------------------------------------------

/**
 * Decision 10: `renderAddPassage` and its batch-paste UI moved off the home
 * screen to Manage Passages; `renderAddAndStart`'s empty-plan one-click
 * callout is the only add-related thing that stayed on home (covered above,
 * under "empty and error states"). These tests are the same behaviours P3
 * originally proved against `renderPlan`'s output, now asserted against
 * `renderManage`'s instead - nothing about the behaviour itself changed.
 */
describe('the add-passage form on Manage Passages (M5)', () => {
  it('no longer renders on the home screen once the plan has a passage in it', () => {
    const root = renderPlan(host, { ...emptyPlan(), passages: [passageViewFixture()] });
    container.appendChild(root);

    expect(root.querySelector('#sm-add-reference')).toBeNull();
    expect(root.querySelector('form.sm-add')).toBeNull();
  });

  it('associates the add-passage field with a real label', () => {
    const root = renderManage(host, emptyPlan());
    container.appendChild(root);

    const input = root.querySelector<HTMLInputElement>('input')!;
    const label = root.querySelector<HTMLLabelElement>('label')!;
    expect(input.id).not.toBe('');
    expect(label.getAttribute('for')).toBe(input.id);
    expect(spokenText(label)).not.toBe('');
  });

  it('shows the worker\'s reason for a rejected reference, word for word', async () => {
    // The common case, and the whole reason failures travel as data rather than
    // as an exception: only the worker can say which of "Jn 3.16", "1 Jn 1" or
    // "Psalm 151" went wrong, and a generic "Could not add passage" throws that
    // away.
    const reason = '"Psalm 151:1" is not a passage in this Bible - Psalms ends at 150.';
    host.handlers.addPassage = () => ({ ok: false, error: reason });

    const root = renderManage(host, emptyPlan());
    container.appendChild(root);

    const input = root.querySelector<HTMLInputElement>('input')!;
    input.value = 'Psalm 151:1';
    root.querySelector('form')!.dispatchEvent(
      new Event('submit', { bubbles: true, cancelable: true }),
    );
    await settle();

    expect(spokenText(root)).toContain(reason);
    // And read out when it appears, since the user is looking at the field they
    // just submitted, not at the space below it.
    const alert = root.querySelector<HTMLElement>('[role="alert"]')!;
    expect(alert.textContent).toBe(reason);
    // The field keeps what was typed so it can be corrected rather than retyped.
    expect(input.value).toBe('Psalm 151:1');
  });

  it('refuses an empty reference without asking the worker', async () => {
    host.handlers.addPassage = () => ({ ok: false, error: 'should not be reached' });
    const root = renderManage(host, emptyPlan());
    container.appendChild(root);

    root.querySelector('form')!.dispatchEvent(
      new Event('submit', { bubbles: true, cancelable: true }),
    );
    await settle();

    expect(host.requests.filter((r) => r.type === 'addPassage')).toEqual([]);
    expect(spokenText(root)).toContain('Type a reference first');
  });

  /** Fires a paste with the given text, the way a browser would before jsdom's DataTransfer support is needed. */
  function pasteInto(input: HTMLInputElement, text: string): void {
    const event = new Event('paste', { bubbles: true, cancelable: true }) as ClipboardEvent;
    Object.defineProperty(event, 'clipboardData', { value: { getData: () => text } });
    input.dispatchEvent(event);
  }

  /** The "add several at once" modal's dialog element, however it got opened. */
  function batchDialog(root: HTMLElement): HTMLElement {
    return root.querySelector<HTMLElement>('[role="dialog"]')!;
  }

  /** The modal's own backdrop - `.hidden` is how open/closed is asserted. */
  function batchBackdrop(root: HTMLElement): HTMLElement {
    return root.querySelector<HTMLElement>('.sm-modal-backdrop')!;
  }

  /** A button inside the batch modal whose label starts with `label` (e.g. "Find", "Add", "Back", "Cancel"). */
  function batchButton(root: HTMLElement, label: string): HTMLButtonElement {
    return Array.from(batchDialog(root).querySelectorAll<HTMLButtonElement>('button')).find((b) =>
      (b.textContent ?? '').startsWith(label),
    )!;
  }

  /** The "Add several passages at once…" link below the single-line field. */
  function addSeveralLink(root: HTMLElement): HTMLButtonElement {
    return Array.from(root.querySelectorAll<HTMLButtonElement>('button')).find((b) =>
      (b.textContent ?? '').startsWith('Add several passages at once'),
    )!;
  }

  it('opens the batch modal, blank, with the exact hint text, from the "Add several passages at once…" link', () => {
    const root = renderManage(host, emptyPlan());
    container.appendChild(root);

    addSeveralLink(root).click();

    expect(batchBackdrop(root).hidden).toBe(false);
    const dialog = batchDialog(root);
    expect(spokenText(dialog)).toContain(
      'Paste a list of references, or any text that has references in it, and they will be auto-detected.',
    );
    const textarea = dialog.querySelector<HTMLTextAreaElement>('textarea')!;
    expect(textarea.tagName).toBe('TEXTAREA');
    expect(textarea.getAttribute('rows')).toBe('8');
    expect(textarea.value).toBe('');
  });

  it('parses the textarea and shows the confirm list, with the right count and lines, when Find references is pressed', () => {
    const root = renderManage(host, emptyPlan());
    container.appendChild(root);

    addSeveralLink(root).click();
    const textarea = batchDialog(root).querySelector<HTMLTextAreaElement>('textarea')!;
    textarea.value = 'John 3:16\nRomans 8:28\nPsalm 23:1-6';
    batchButton(root, 'Find').click();

    const dialog = batchDialog(root);
    expect(spokenText(dialog)).toContain('Add 3 passages?');
    const items = Array.from(dialog.querySelectorAll('.sm-batch-list-item')).map((li) => li.textContent);
    expect(items).toEqual(['John 3:16', 'Romans 8:28', 'Psalm 23:1-6']);
    // Nothing sent to the worker yet - the list still needs to be confirmed.
    expect(host.requests.filter((r) => r.type === 'addPassage')).toEqual([]);
  });

  it('returns to the textarea, with its text preserved, when Back is pressed from the confirm view', () => {
    const root = renderManage(host, emptyPlan());
    container.appendChild(root);

    addSeveralLink(root).click();
    const textarea = batchDialog(root).querySelector<HTMLTextAreaElement>('textarea')!;
    textarea.value = 'John 3:16\nRomans 8:28';
    batchButton(root, 'Find').click();

    batchButton(root, 'Back').click();

    // Same modal, still open - Back is not Cancel.
    expect(batchBackdrop(root).hidden).toBe(false);
    const dialog = batchDialog(root);
    const textareaAgain = dialog.querySelector<HTMLTextAreaElement>('textarea')!;
    expect(textareaAgain.value).toBe('John 3:16\nRomans 8:28');
    expect(spokenText(dialog)).toContain(
      'Paste a list of references, or any text that has references in it, and they will be auto-detected.',
    );
  });

  it('opens the batch modal, pre-filled and already parsed, when a multi-candidate paste lands on the field', async () => {
    host.handlers.addPassage = (req) => ({ ok: true, data: { passage: passageFixture({ reference: req.reference }) } });
    const root = renderManage(host, emptyPlan());
    container.appendChild(root);
    const input = root.querySelector<HTMLInputElement>('input')!;

    pasteInto(input, 'John 3:16\nRomans 8:28\nPsalm 23:1-6');
    await settle();

    // Nothing sent to the worker yet - task 0004's follow-up review asked for
    // bulk-add "after confirmation", not on the paste itself. But the modal
    // - not the old inline confirm slot - is what is showing it, landing
    // straight on the confirm view exactly as the old inline slot did.
    expect(host.requests.filter((r) => r.type === 'addPassage')).toEqual([]);
    expect(batchBackdrop(root).hidden).toBe(false);
    const dialog = batchDialog(root);
    const text = spokenText(dialog);
    expect(text).toContain('John 3:16');
    expect(text).toContain('Romans 8:28');
    expect(text).toContain('Psalm 23:1-6');
    // The confirm view has no textarea of its own to check directly - Back
    // is what proves the pre-fill actually reached it.
    batchButton(root, 'Back').click();
    const textarea = batchDialog(root).querySelector<HTMLTextAreaElement>('textarea')!;
    expect(textarea.value).toBe('John 3:16\nRomans 8:28\nPsalm 23:1-6');
  });

  it('adds every line of a pasted list as its own passage, one reference per line, once confirmed, via the lifted addReferences helper', async () => {
    const references = ['John 3:16', 'Romans 8:28', 'Psalm 23:1-6'];
    // Distinct id and non-overlapping verse range per reference: three real,
    // unrelated passages, not three copies of the same row - so the batch's
    // own overlap-consolidation (task 0004's review) has nothing to collapse
    // here and every one of the three is expected to survive.
    host.handlers.addPassage = (req) => {
      const index = references.indexOf(req.reference);
      return {
        ok: true,
        data: {
          passage: passageFixture({
            id: 100 + index,
            reference: req.reference,
            startVerseId: 40000000 + index * 100,
            endVerseId: 40000000 + index * 100 + 5,
          }),
        },
      };
    };

    const root = renderManage(host, emptyPlan());
    container.appendChild(root);
    const input = root.querySelector<HTMLInputElement>('input')!;

    pasteInto(input, references.join('\n'));
    await settle();
    batchButton(root, 'Add').click();
    await settle();

    expect(host.requests.filter((r) => r.type === 'addPassage').map((r) => (r as { reference: string }).reference)).toEqual(
      references,
    );
    expect(host.announcements.some((a) => a.includes('Added 3 passages'))).toBe(true);
    expect(host.reloads).toBeGreaterThan(0);
    // Any success closes the modal.
    expect(batchBackdrop(root).hidden).toBe(true);
  });

  it('adds nothing, and leaves the modal open on the textarea, when Cancel is pressed', () => {
    host.handlers.addPassage = () => ({ ok: false, error: 'should not be reached' });
    const root = renderManage(host, emptyPlan());
    container.appendChild(root);
    const input = root.querySelector<HTMLInputElement>('input')!;

    pasteInto(input, 'John 3:16\nRomans 8:28');
    batchButton(root, 'Back').click();
    batchButton(root, 'Cancel').click();

    expect(host.requests.filter((r) => r.type === 'addPassage')).toEqual([]);
    expect(batchBackdrop(root).hidden).toBe(true);
  });

  it('does not let a multi-line paste land in the single-line field as concatenated text', async () => {
    host.handlers.addPassage = (req) => ({ ok: true, data: { passage: passageFixture({ reference: req.reference }) } });
    const root = renderManage(host, emptyPlan());
    container.appendChild(root);
    const input = root.querySelector<HTMLInputElement>('input')!;

    pasteInto(input, 'John 3:16\nRomans 8:28');
    await settle();

    // The single-line field is never touched by a multi-candidate paste at
    // all - the text goes straight into the modal's textarea instead (see
    // above), so the field is left exactly as it was before the paste.
    expect(input.value).toBe('');
  });

  it('finds several references sprinkled in one pasted line, not just one per line', async () => {
    host.handlers.addPassage = (req) => ({ ok: true, data: { passage: passageFixture({ reference: req.reference }) } });
    const root = renderManage(host, emptyPlan());
    container.appendChild(root);
    const input = root.querySelector<HTMLInputElement>('input')!;

    pasteInto(input, 'Check out John 3:16, and also Romans 8:28 today!');
    await settle();

    // Not a single line handed through whole - two candidates, each its own
    // reference, extracted out of the surrounding prose.
    expect(host.requests.filter((r) => r.type === 'addPassage')).toEqual([]);
    const text = spokenText(batchDialog(root));
    expect(text).toContain('John 3:16');
    expect(text).toContain('Romans 8:28');
    expect(text).not.toContain('Check out');
  });

  it('consolidates a batch that names both a range and one of its own verses', async () => {
    // "if John 3:16-17 is in there, John 3:16 separately should be ignored" -
    // a follow-up review round on the batch-add feature.
    host.handlers.addPassage = (req) => {
      if (req.reference === 'John 3:16-17') {
        return { ok: true, data: { passage: passageFixture({ id: 55, reference: 'John 3:16-17', startVerseId: 43003016, endVerseId: 43003017 }) } };
      }
      return { ok: true, data: { passage: passageFixture({ id: 56, reference: 'John 3:16', startVerseId: 43003016, endVerseId: 43003016 }) } };
    };
    host.handlers.removePassage = () => ({ ok: true, data: {} });

    const root = renderManage(host, emptyPlan());
    container.appendChild(root);
    const input = root.querySelector<HTMLInputElement>('input')!;

    pasteInto(input, 'John 3:16-17\nJohn 3:16');
    await settle();
    batchButton(root, 'Add').click();
    await settle();

    // Both were added (each is a real add on the worker), then the narrower
    // one - fully covered by the range also in this batch - is removed again.
    expect(host.requests.filter((r) => r.type === 'addPassage').map((r) => (r as { reference: string }).reference)).toEqual(
      ['John 3:16-17', 'John 3:16'],
    );
    expect(host.requests).toContainEqual({ type: 'removePassage', passageId: 56 });
    expect(
      host.announcements.some(
        (a) => a.includes('Added 1 passage') && a.includes('already covered by another passage in this batch'),
      ),
    ).toBe(true);
  });

  it('reports which lines of a pasted batch failed, each with the worker\'s own reason, without closing the modal', async () => {
    host.handlers.addPassage = (req) => {
      if (req.reference === 'Psalm 151:1') return { ok: false, error: '"Psalm 151:1" is not a passage in this Bible.' };
      return { ok: true, data: { passage: passageFixture({ reference: req.reference }) } };
    };

    const root = renderManage(host, emptyPlan());
    container.appendChild(root);
    const input = root.querySelector<HTMLInputElement>('input')!;

    pasteInto(input, 'John 3:16\nPsalm 151:1');
    await settle();
    batchButton(root, 'Add').click();
    await settle();

    expect(host.announcements.some((a) => a.includes('Added 1 passage') && a.includes('1 failed'))).toBe(true);
    expect(spokenText(batchDialog(root))).toContain('Psalm 151:1: "Psalm 151:1" is not a passage in this Bible.');
    // A partial failure leaves the modal open rather than discarding the rest
    // of the batch's context.
    expect(batchBackdrop(root).hidden).toBe(false);
  });

  it('leaves a single-line paste to the field\'s normal behaviour, without opening the modal', async () => {
    host.handlers.addPassage = () => ({ ok: false, error: 'should not be reached' });
    const root = renderManage(host, emptyPlan());
    container.appendChild(root);
    const input = root.querySelector<HTMLInputElement>('input')!;

    pasteInto(input, 'John 3:16');
    await settle();

    // A single reference is not a batch: the paste is left alone rather than
    // pre-empted, and nothing is submitted until the user presses Add or Enter.
    expect(host.requests.filter((r) => r.type === 'addPassage')).toEqual([]);
    expect(root.querySelector('.sm-modal-backdrop')).toBeNull();
  });

  it('opens the same batch modal, pre-filled and parsed, when Enter is pressed on typed text naming more than one reference', async () => {
    host.handlers.addPassage = (req) => ({ ok: true, data: { passage: passageFixture({ reference: req.reference }) } });
    const root = renderManage(host, emptyPlan());
    container.appendChild(root);
    const input = root.querySelector<HTMLInputElement>('input')!;

    input.value = 'John 3:16 and Romans 8:28';
    root.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await settle();

    expect(host.requests.filter((r) => r.type === 'addPassage')).toEqual([]);
    expect(batchBackdrop(root).hidden).toBe(false);
    const text = spokenText(batchDialog(root));
    expect(text).toContain('John 3:16');
    expect(text).toContain('Romans 8:28');
  });
});

// ---------------------------------------------------------------------------
// 8. Empty and error states
// ---------------------------------------------------------------------------

describe('empty and error states', () => {
  it('gives an empty plan something to read and something to do', () => {
    const root = renderPlan(host, emptyPlan());
    container.appendChild(root);

    const text = spokenText(root);
    expect(text).not.toBe('');
    expect(text).toContain('Nothing in your plan yet.');
    // Not a dead end: the empty state says what to type, even though (M5) the
    // field itself has moved off this screen to Manage Passages.
    expect(text).toContain('Psalm 1:1-6');

    // Announced as a status rather than left as anonymous text.
    expect(root.querySelector('[role="status"]')).not.toBeNull();
  });

  it('offers one-click add-and-start once the reader has a verse open, even with an empty plan', () => {
    host.activeReference = 'John 3:16';
    const root = renderPlan(host, emptyPlan());
    container.appendChild(root);

    // Task 0004: a first-time user should never see an empty list with
    // nothing to press. With a verse already open, one button both adds it
    // and starts practising it.
    const labels = Array.from(root.querySelectorAll('button')).map((b) => b.textContent);
    expect(labels.some((l) => (l ?? '').includes('Add John 3:16 and start'))).toBe(true);
  });

  it('does not offer a start button at all with an empty plan and nothing being read', () => {
    const root = renderPlan(host, emptyPlan());
    container.appendChild(root);

    // A disabled primary button with no explanation looks broken. The screen
    // points at Manage Passages instead (M5 moved the add field there).
    expect(spokenText(root)).toContain('Add a verse from Manage Passages to get started.');
    const labels = Array.from(root.querySelectorAll('button')).map((b) => b.textContent);
    expect(labels.some((l) => (l ?? '').includes('Start practicing'))).toBe(false);
  });

  it('gives an empty analytics screen a way back rather than a wall of zeroes', () => {
    const root = renderAnalytics(host, emptyAnalytics());
    container.appendChild(root);

    expect(spokenText(root)).toContain('Nothing to show yet.');
    expect(root.querySelectorAll('button').length).toBeGreaterThan(0);
  });

  it('keeps the exercise usable when the surrounding context cannot be fetched', async () => {
    const reason = 'Could not reach the Scripture Memory worker (getContext): Timeout';
    const practice = await mountPractice(
      blanksStep(PSALM_1_1, [5, 9]),
      {},
      { ok: false, error: reason },
    );

    // Not fatal: the step carries everything needed to answer, so the failure
    // is reported and the exercise goes on with the step's own copy of the
    // verse. Replacing the screen with an error here would take away the thing
    // the user pressed a button to do.
    expect(host.announcements).toContain(reason);
    expect(practice.root.querySelectorAll('.sm-blank').length).toBe(2);
    expect(spokenText(workingVerse(practice.root))).toContain('Blessed is the man');
  });

  it('surfaces a rejected submission instead of silently doing nothing', async () => {
    const reason = 'That session has already ended.';
    host.handlers.submitStep = () => ({ ok: false, error: reason });

    const practice = await mountPractice(blanksStep(PSALM_1_2, BLANKED));
    practice.root.querySelector<HTMLButtonElement>('.sm-exercise-actions button')!.click();
    await settle();

    expect(spokenText(practice.root)).toContain(reason);
    expect(practice.root.querySelector('[role="alert"]')).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 8. icon()
// ---------------------------------------------------------------------------

describe('icon()', () => {
  const NAMES: IconName[] = [
    'home',
    'menu',
    'variety',
    'refmatch',
    'ordering',
    'blanks',
    'firstletters',
    'provideref',
  ];

  it('builds a real, namespaced <svg> rather than an HTML element', () => {
    const svg = icon('home');
    expect(svg.tagName).toBe('svg');
    expect(svg.namespaceURI).toBe('http://www.w3.org/2000/svg');
  });

  it('is decorative - aria-hidden, with no accessible name of its own', () => {
    for (const name of NAMES) {
      const svg = icon(name);
      expect(svg.getAttribute('aria-hidden')).toBe('true');
      expect(svg.getAttribute('role')).not.toBe('img');
      expect(svg.hasAttribute('aria-label')).toBe(false);
    }
  });

  it('takes its colour from the surrounding text rather than a fixed one', () => {
    for (const name of NAMES) {
      expect(icon(name).getAttribute('stroke')).toBe('currentColor');
    }
  });

  it('shares one viewBox and stroke width across every name', () => {
    for (const name of NAMES) {
      const svg = icon(name);
      expect(svg.getAttribute('viewBox')).toBe('0 0 24 24');
      expect(svg.getAttribute('stroke-width')).toBe('2');
      // Line icons only - a filled icon here would look like a different set
      // the moment it sat next to the other seven.
      expect(svg.getAttribute('fill')).toBe('none');
    }
  });

  it('draws something - every name renders at least one path', () => {
    for (const name of NAMES) {
      const paths = icon(name).querySelectorAll('path');
      expect(paths.length).toBeGreaterThan(0);
      for (const path of Array.from(paths)) {
        expect(path.getAttribute('d')).toBeTruthy();
      }
    }
  });

  it('draws a different icon for every name - none share their path data', () => {
    const signatures = NAMES.map((name) =>
      Array.from(icon(name).querySelectorAll('path'))
        .map((p) => p.getAttribute('d'))
        .join('|'),
    );
    expect(new Set(signatures).size).toBe(NAMES.length);
  });

  it('renders fresh, unshared nodes on every call', () => {
    const a = icon('menu');
    const b = icon('menu');
    expect(a).not.toBe(b);
    a.setAttribute('data-marker', 'x');
    expect(b.hasAttribute('data-marker')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 9. breadcrumb() - replaces the old toolbar()'s back arrow
// ---------------------------------------------------------------------------

describe('breadcrumb()', () => {
  it('renders a nav landmark labelled Breadcrumb, holding an ordered list', () => {
    const trail = breadcrumb({ crumbs: [{ label: 'Home', onClick: () => {} }, { label: 'Settings' }] });
    container.appendChild(trail);

    expect(trail.tagName).toBe('NAV');
    expect(trail.classList.contains('sm-crumbs')).toBe(true);
    expect(trail.getAttribute('aria-label')).toBe('Breadcrumb');
    expect(trail.querySelector('ol')).not.toBeNull();
  });

  it('renders the final crumb as the screen\'s own <h1>, marked current', () => {
    const trail = breadcrumb({ crumbs: [{ label: 'Home', onClick: () => {} }, { label: 'Analytics' }] });
    container.appendChild(trail);

    const current = trail.querySelector('h1')!;
    expect(current).not.toBeNull();
    expect(current.classList.contains('sm-crumb-current')).toBe(true);
    expect(current.getAttribute('aria-current')).toBe('page');
    expect(spokenText(current)).toBe('Analytics');

    // Exactly one - a second `<h1>` would break `panel.ts#render`'s
    // "focus `main.querySelector('h1')`" contract.
    expect(trail.querySelectorAll('h1').length).toBe(1);
  });

  it('renders every non-final crumb as a real <button>, and clicking one navigates', () => {
    const clicked: string[] = [];
    const crumbs: Crumb[] = [
      { label: 'Home', onClick: () => clicked.push('Home') },
      { label: 'Middle', onClick: () => clicked.push('Middle') },
      { label: 'Current' },
    ];
    const trail = breadcrumb({ crumbs });
    container.appendChild(trail);

    const buttons = Array.from(trail.querySelectorAll<HTMLButtonElement>('button.sm-crumb'));
    expect(buttons.length).toBe(2);
    expect(buttons.every((b) => b.type === 'button')).toBe(true);
    expect(spokenText(buttons[1]!)).toBe('Middle');

    buttons[1]!.click();
    expect(clicked).toEqual(['Middle']);

    buttons[0]!.click();
    expect(clicked).toEqual(['Middle', 'Home']);

    // The final crumb is never itself a button - there is nowhere further to
    // go from the current screen.
    expect(trail.querySelector('h1')!.tagName).not.toBe('BUTTON');
  });

  it('draws crumb 1 as a house glyph plus the word "Home", whether or not it is also the final crumb', () => {
    const linked = breadcrumb({ crumbs: [{ label: 'Home', onClick: () => {} }, { label: 'Settings' }] });
    const homeCrumb = linked.querySelector('.sm-crumb')!;
    expect(homeCrumb.querySelector('svg.sm-icon-home')).not.toBeNull();
    expect(spokenText(homeCrumb)).toBe('Home');

    // The home screen itself: a single crumb that is both crumb 1 and final.
    const sole = breadcrumb({ crumbs: [{ label: 'Home' }] });
    const heading = sole.querySelector('h1')!;
    expect(heading.querySelector('svg.sm-icon-home')).not.toBeNull();
    expect(spokenText(heading)).toBe('Home');
    expect(heading.getAttribute('aria-current')).toBe('page');
  });

  it('separates crumbs with a "›", hidden from assistive tech', () => {
    const trail = breadcrumb({ crumbs: [{ label: 'Home', onClick: () => {} }, { label: 'Settings' }] });
    container.appendChild(trail);

    const sep = trail.querySelector('.sm-crumb-sep')!;
    expect(sep.textContent).toBe('›');
    expect(sep.querySelector('[aria-hidden="true"]')).not.toBeNull();
    // The accessible name of the whole trail skips it entirely.
    expect(spokenText(trail)).not.toContain('›');
  });

  it('places an optional menu slot and action elements where given', () => {
    const menu = document.createElement('button');
    menu.textContent = 'Menu';
    const action = document.createElement('button');
    action.textContent = 'Extra';

    const trail = breadcrumb({ crumbs: [{ label: 'Home' }], menu, actions: [action] });

    expect(trail.contains(menu)).toBe(true);
    expect(trail.contains(action)).toBe(true);
  });

  it('leaves the menu slot out entirely when not given, as every current call site does', () => {
    const trail = breadcrumb({ crumbs: [{ label: 'Home' }] });
    // Nothing beyond the crumb list and the (empty) actions slot.
    expect(trail.children.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// 9b. menu() - the hamburger that fills breadcrumb()'s menu slot (M3)
// ---------------------------------------------------------------------------

describe('menu()', () => {
  function threeItemMenu(): { el: HTMLElement; clicked: string[] } {
    const clicked: string[] = [];
    const el = menuComponent({
      label: 'Menu',
      items: [
        { label: 'Manage Passages', onClick: () => clicked.push('Manage Passages') },
        { label: 'Analytics', onClick: () => clicked.push('Analytics') },
        { label: 'Settings', onClick: () => clicked.push('Settings') },
      ],
    });
    return { el, clicked };
  }

  function trigger(root: HTMLElement): HTMLButtonElement {
    return root.querySelector<HTMLButtonElement>('.sm-menu-btn')!;
  }

  function panel(root: HTMLElement): HTMLElement {
    return root.querySelector<HTMLElement>('[role="menu"]')!;
  }

  function menuItems(root: HTMLElement): HTMLButtonElement[] {
    return Array.from(root.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'));
  }

  it('renders a trigger with aria-haspopup and aria-expanded="false", closed by default', () => {
    const { el } = threeItemMenu();
    container.appendChild(el);

    const btn = trigger(el);
    expect(btn.tagName).toBe('BUTTON');
    expect(btn.type).toBe('button');
    expect(btn.getAttribute('aria-haspopup')).toBe('menu');
    expect(btn.getAttribute('aria-expanded')).toBe('false');
    expect(panel(el).hidden).toBe(true);
  });

  it('clicking the trigger opens the menu with all three items, in order, and flips aria-expanded', () => {
    const { el } = threeItemMenu();
    container.appendChild(el);

    trigger(el).click();

    expect(trigger(el).getAttribute('aria-expanded')).toBe('true');
    expect(panel(el).hidden).toBe(false);
    expect(menuItems(el).map(spokenText)).toEqual(['Manage Passages', 'Analytics', 'Settings']);
    expect(menuItems(el).every((b) => b.getAttribute('role') === 'menuitem')).toBe(true);
  });

  it('clicking the trigger again closes it', () => {
    const { el } = threeItemMenu();
    container.appendChild(el);

    trigger(el).click();
    trigger(el).click();

    expect(trigger(el).getAttribute('aria-expanded')).toBe('false');
    expect(panel(el).hidden).toBe(true);
  });

  it.each([
    ['Manage Passages', 0],
    ['Analytics', 1],
    ['Settings', 2],
  ])('clicking "%s" calls its onClick and closes the menu', (label, index) => {
    const { el, clicked } = threeItemMenu();
    container.appendChild(el);

    trigger(el).click();
    menuItems(el)[index]!.click();

    expect(clicked).toEqual([label]);
    expect(panel(el).hidden).toBe(true);
    expect(trigger(el).getAttribute('aria-expanded')).toBe('false');
  });

  it('Escape closes the menu and returns focus to the trigger', () => {
    const { el } = threeItemMenu();
    container.appendChild(el);

    trigger(el).click();
    expect(document.activeElement).toBe(menuItems(el)[0]);

    menuItems(el)[0]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

    expect(panel(el).hidden).toBe(true);
    expect(trigger(el).getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(trigger(el));
  });

  it('a pointerdown outside the menu (and its trigger) closes it', () => {
    const { el } = threeItemMenu();
    container.appendChild(el);
    const outside = document.createElement('div');
    container.appendChild(outside);

    trigger(el).click();
    expect(panel(el).hidden).toBe(false);

    outside.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));

    expect(panel(el).hidden).toBe(true);
    expect(trigger(el).getAttribute('aria-expanded')).toBe('false');
  });

  it('a pointerdown on an item inside the menu does not close it via the outside handler', () => {
    const { el } = threeItemMenu();
    container.appendChild(el);

    trigger(el).click();
    menuItems(el)[1]!.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));

    // Still open - only the item's own click handler (tested above) closes
    // the menu when an item is the target, not the outside-pointerdown path.
    expect(panel(el).hidden).toBe(false);
  });

  it('Down moves focus to the next item and wraps from the last back to the first', () => {
    const { el } = threeItemMenu();
    container.appendChild(el);

    trigger(el).click();
    const items = menuItems(el);
    expect(document.activeElement).toBe(items[0]);

    items[0]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    expect(document.activeElement).toBe(items[1]);

    items[1]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    expect(document.activeElement).toBe(items[2]);

    items[2]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    expect(document.activeElement).toBe(items[0]);
  });

  it('Up moves focus to the previous item and wraps from the first back to the last', () => {
    const { el } = threeItemMenu();
    container.appendChild(el);

    trigger(el).click();
    const items = menuItems(el);

    items[0]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    expect(document.activeElement).toBe(items[2]);

    items[2]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    expect(document.activeElement).toBe(items[1]);
  });

  it('keeps a roving tabindex: only the focused item sits in the page Tab order', () => {
    const { el } = threeItemMenu();
    container.appendChild(el);

    trigger(el).click();
    const items = menuItems(el);
    expect(items.map((b) => b.tabIndex)).toEqual([0, -1, -1]);

    items[0]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    expect(items.map((b) => b.tabIndex)).toEqual([-1, 0, -1]);
  });
});

// ---------------------------------------------------------------------------
// 9c. modal() - the one modal component for everything (P2)
// ---------------------------------------------------------------------------

describe('modal()', () => {
  /** A modal with one focusable body control and a two-button action row. */
  function buildModal(): {
    handle: ReturnType<typeof modal>;
    input: HTMLInputElement;
    cancelBtn: HTMLButtonElement;
    saveBtn: HTMLButtonElement;
  } {
    const input = document.createElement('input');
    input.type = 'text';
    const cancelBtn = document.createElement('button');
    cancelBtn.textContent = 'Cancel';
    const saveBtn = document.createElement('button');
    saveBtn.textContent = 'Save';

    const handle = modal({
      title: 'Rename passage',
      body: [input],
      actions: [cancelBtn, saveBtn],
    });
    return { handle, input, cancelBtn, saveBtn };
  }

  function dialogOf(handleEl: HTMLElement): HTMLElement {
    return handleEl.querySelector<HTMLElement>('[role="dialog"]')!;
  }

  it('renders a hidden dialog with aria-modal and aria-labelledby pointing at a real title element', () => {
    const { handle } = buildModal();
    container.appendChild(handle.element);

    const dialog = dialogOf(handle.element);
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    const labelledBy = dialog.getAttribute('aria-labelledby');
    expect(labelledBy).toBeTruthy();
    const titleEl = document.getElementById(labelledBy!);
    expect(titleEl).not.toBeNull();
    expect(titleEl!.textContent).toBe('Rename passage');
    // Not in the accessibility tree / interactable until opened.
    expect(handle.element.hidden).toBe(true);
  });

  it('gives each modal instance its own title id, so aria-labelledby is never shared', () => {
    const first = buildModal();
    const second = buildModal();
    container.appendChild(first.handle.element);
    container.appendChild(second.handle.element);

    expect(dialogOf(first.handle.element).getAttribute('aria-labelledby')).not.toBe(
      dialogOf(second.handle.element).getAttribute('aria-labelledby'),
    );
  });

  it('opening un-hides the dialog and moves focus to the first focusable control in body', () => {
    const { handle, input } = buildModal();
    container.appendChild(handle.element);

    handle.open();

    expect(handle.element.hidden).toBe(false);
    expect(document.activeElement).toBe(input);
  });

  it('falls back to the first action button when body has no focusable content', () => {
    const message = document.createElement('p');
    message.textContent = 'Delete this passage? This cannot be undone.';
    const cancelBtn = document.createElement('button');
    cancelBtn.textContent = 'Cancel';
    const deleteBtn = document.createElement('button');
    deleteBtn.textContent = 'Delete';
    const handle = modal({ title: 'Delete passage?', body: [message], actions: [cancelBtn, deleteBtn] });
    container.appendChild(handle.element);

    handle.open();

    expect(document.activeElement).toBe(cancelBtn);
  });

  it('falls back to focusing the dialog itself when neither body nor actions has a focusable control', () => {
    const message = document.createElement('p');
    message.textContent = 'Nothing to focus here.';
    const handle = modal({ title: 'Notice', body: [message], actions: [] });
    container.appendChild(handle.element);

    handle.open();

    expect(document.activeElement).toBe(dialogOf(handle.element));
  });

  it('Escape closes the modal and returns focus to whatever had focus before it opened', () => {
    const { handle, input } = buildModal();
    const opener = document.createElement('button');
    opener.textContent = 'Rename';
    container.appendChild(opener);
    container.appendChild(handle.element);

    opener.focus();
    handle.open();
    expect(document.activeElement).toBe(input);

    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

    expect(handle.element.hidden).toBe(true);
    expect(document.activeElement).toBe(opener);
  });

  it('Tab cycles forward through the focusable elements and wraps from the last back to the first', () => {
    const { handle, input, cancelBtn, saveBtn } = buildModal();
    container.appendChild(handle.element);
    handle.open();
    expect(document.activeElement).toBe(input);

    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    expect(document.activeElement).toBe(cancelBtn);

    cancelBtn.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    expect(document.activeElement).toBe(saveBtn);

    saveBtn.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    expect(document.activeElement).toBe(input);
  });

  it('Shift+Tab cycles backward and wraps from the first element back to the last', () => {
    const { handle, input, cancelBtn, saveBtn } = buildModal();
    container.appendChild(handle.element);
    handle.open();
    expect(document.activeElement).toBe(input);

    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true }));
    expect(document.activeElement).toBe(saveBtn);

    saveBtn.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true }));
    expect(document.activeElement).toBe(cancelBtn);
  });

  it('never lets Tab move focus outside the dialog, even to an element right after it in the DOM', () => {
    const { handle, input } = buildModal();
    const outsideButton = document.createElement('button');
    outsideButton.textContent = 'Outside';
    container.appendChild(outsideButton);
    container.appendChild(handle.element);
    handle.open();

    const dialog = dialogOf(handle.element);
    const seen: (Element | null)[] = [];
    for (let i = 0; i < 6; i++) {
      seen.push(document.activeElement);
      (document.activeElement as HTMLElement).dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }),
      );
    }

    expect(seen.every((activeEl) => activeEl !== null && dialog.contains(activeEl))).toBe(true);
    expect(seen).not.toContain(outsideButton);
    // Two full cycles of the three focusable elements land back where they started.
    expect(document.activeElement).toBe(input);
  });

  it('clicking the backdrop closes the modal', () => {
    const { handle } = buildModal();
    container.appendChild(handle.element);
    handle.open();

    handle.element.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(handle.element.hidden).toBe(true);
  });

  it('clicking inside the dialog box does not close the modal', () => {
    const { handle, input } = buildModal();
    container.appendChild(handle.element);
    handle.open();

    input.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(handle.element.hidden).toBe(false);
  });

  it('close() closes the modal directly, without requiring Escape or a backdrop click', () => {
    const { handle } = buildModal();
    container.appendChild(handle.element);
    handle.open();

    handle.close();

    expect(handle.element.hidden).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 10. The crumb trail on each screen
// ---------------------------------------------------------------------------

describe('the crumb trail on each screen', () => {
  /** The crumbs in document order, read the way a user would. */
  function crumbLabels(root: HTMLElement): string[] {
    return Array.from(root.querySelectorAll('.sm-crumb, .sm-crumb-current')).map(spokenText);
  }

  it('plan (home): a single, unclickable "Home" crumb', () => {
    const root = renderPlan(host, emptyPlan());
    container.appendChild(root);

    expect(crumbLabels(root)).toEqual(['Home']);
    // Nowhere further "home" to go from the home screen itself.
    expect(root.querySelector('button.sm-crumb')).toBeNull();
    const heading = root.querySelector<HTMLElement>('h1.sm-crumb-current')!;
    expect(heading.getAttribute('aria-current')).toBe('page');
  });

  it('plan (home): Manage Passages, Analytics and Settings live only behind the hamburger menu (M3)', () => {
    const root = renderPlan(host, emptyPlan());
    container.appendChild(root);

    // Gone from the breadcrumb's own actions slot - the menu replaces them
    // entirely on this screen (M3 scope, item 5 of its spec). The only place
    // "Analytics" / "Settings" / "Manage Passages" now appear is as
    // `menuitem`s inside the (closed) popover, not as separately clickable
    // buttons sitting in the breadcrumb itself.
    expect(root.querySelector('.sm-crumbs-actions')!.children.length).toBe(0);
    const namedButtons = Array.from(root.querySelectorAll('.sm-crumbs button:not([role="menuitem"])')).map(
      spokenText,
    );
    expect(namedButtons).not.toContain('Analytics');
    expect(namedButtons).not.toContain('Settings');
    expect(namedButtons).not.toContain('Manage Passages');

    const trigger = root.querySelector<HTMLButtonElement>('.sm-menu-btn')!;
    expect(trigger).not.toBeNull();
    trigger.click();

    const items = Array.from(root.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'));
    expect(items.map(spokenText)).toEqual(['Manage Passages', 'Analytics', 'Settings']);

    items[0]!.click();
    expect(host.navigations).toContainEqual({ type: 'goManage' });
    // The click also closed the menu (menu()'s own contract, tested above).
    expect(root.querySelector('[role="menu"]')!.hidden).toBe(true);

    trigger.click();
    Array.from(root.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'))[1]!.click();
    expect(host.navigations).toContainEqual({ type: 'goAnalytics' });

    trigger.click();
    Array.from(root.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'))[2]!.click();
    expect(host.navigations).toContainEqual({ type: 'goSettings' });
  });

  it('passage: Home > the passage\'s own reference, and Home goes to the plan', () => {
    const pv = passageViewFixture({ passage: passageFixture({ reference: 'Psalm 23:1-6' }) });
    const root = renderPassageScreen(host, pv, 'firstLetter');
    container.appendChild(root);

    expect(crumbLabels(root)).toEqual(['Home', 'Psalm 23:1-6']);

    root.querySelector<HTMLButtonElement>('button.sm-crumb')!.click();
    expect(host.navigations).toContainEqual({ type: 'goPlan' });
  });

  it('analytics: Home > Analytics, and Home goes to the plan', () => {
    const root = renderAnalytics(host, emptyAnalytics());
    container.appendChild(root);

    expect(crumbLabels(root)).toEqual(['Home', 'Analytics']);
    root.querySelector<HTMLButtonElement>('button.sm-crumb')!.click();
    expect(host.navigations).toContainEqual({ type: 'goPlan' });
  });

  it('settings: Home > Settings, and Home goes to the plan', () => {
    const root = renderSettings(host, { defaultAnswerMode: 'firstLetter' }, emptyPlan());
    container.appendChild(root);

    expect(crumbLabels(root)).toEqual(['Home', 'Settings']);
    root.querySelector<HTMLButtonElement>('button.sm-crumb')!.click();
    expect(host.navigations).toContainEqual({ type: 'goPlan' });
  });

  it('practice: Home > the passage reference, with the activity NOT a third crumb', async () => {
    const practice = await mountPractice(blanksStep(PSALM_1_2, BLANKED), { rung: 'blanks' });

    expect(crumbLabels(practice.root)).toEqual(['Home', 'Psalm 1:2-3']);
    // The activity is the selected tab, shown elsewhere (the `[role="tab"]`
    // strip under the breadcrumb, see the "activity tab strip" tests below) -
    // naming it again as a crumb would duplicate it, which item 10 rules out
    // explicitly.
    expect(spokenText(practice.root.querySelector('.sm-crumb-list')!)).not.toContain('Fill in the blanks');
  });

  it('practice: the Home crumb ends the session (saving progress) instead of abandoning it', async () => {
    let endSessionCalled = false;
    host.handlers.endSession = () => {
      endSessionCalled = true;
      return { ok: true, data: {} };
    };
    const practice = await mountPractice(blanksStep(PSALM_1_2, BLANKED), { rung: 'blanks' });

    practice.root.querySelector<HTMLButtonElement>('button.sm-crumb')!.click();
    await settle();

    // Not a bare `goPlan`: leaving mid-exercise has to write the resume point
    // first (see `practiceView.ts#endSession`'s own header), and only then
    // does it navigate - to `returnTo` (the plan here), via `sessionEnded`.
    expect(endSessionCalled).toBe(true);
    expect(host.navigations).toContainEqual({ type: 'sessionEnded' });
  });

  it('keeps exactly one <h1> per screen, as the final crumb - what panel.ts#render focuses', async () => {
    const staticScreens = [
      renderPlan(host, emptyPlan()),
      renderPassageScreen(host, passageViewFixture(), 'firstLetter'),
      renderAnalytics(host, emptyAnalytics()),
      renderSettings(host, { defaultAnswerMode: 'firstLetter' }, emptyPlan()),
    ];
    for (const root of staticScreens) {
      const headings = root.querySelectorAll('h1');
      expect(headings.length).toBe(1);
      expect(headings[0]!.classList.contains('sm-crumb-current')).toBe(true);
    }

    const practice = await mountPractice(blanksStep(PSALM_1_2, BLANKED), { rung: 'blanks' });
    const practiceHeadings = practice.root.querySelectorAll('h1');
    expect(practiceHeadings.length).toBe(1);
    expect(practiceHeadings[0]!.classList.contains('sm-crumb-current')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 11. The practice screen's activity tab strip (N5)
// ---------------------------------------------------------------------------

describe("the practice screen's activity tab strip", () => {
  function planWith(pv: PassageView): PlanView {
    return {
      collectionId: 1,
      collectionName: 'My plan',
      totalDue: 0,
      defaultAnswerMode: 'firstLetter',
      sortOrder: 'bible',
      passages: [pv],
    };
  }

  it("renders one tab per applicable activity, with the session's own rung selected", async () => {
    // Same fixture the passage-screen tab-strip tests use: four rungs, one
    // (`refmatch`) inapplicable.
    const pv = passageViewFixture();
    host.handlers.getPlan = () => ({ ok: true, data: planWith(pv) });

    const practice = await mountPractice(blanksStep(PSALM_1_2, BLANKED), {
      rung: 'blanks',
      passageId: pv.passage.id,
    });

    const tabButtons = Array.from(practice.root.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
    expect(tabButtons.map((t) => t.textContent)).toEqual([
      'Put in order',
      'Fill in the blanks',
      'First letters only',
    ]);

    const selected = tabButtons.filter((t) => t.getAttribute('aria-selected') === 'true');
    expect(selected.map((t) => t.textContent)).toEqual(['Fill in the blanks']);
  });

  it('starts the clicked activity for the same passage, without restarting it', async () => {
    const pv = passageViewFixture();
    host.handlers.getPlan = () => ({ ok: true, data: planWith(pv) });

    const practice = await mountPractice(blanksStep(PSALM_1_2, BLANKED), {
      rung: 'blanks',
      passageId: pv.passage.id,
    });

    const orderingTab = Array.from(practice.root.querySelectorAll<HTMLButtonElement>('[role="tab"]')).find(
      (t) => t.textContent === 'Put in order',
    )!;
    orderingTab.click();

    // No `restart` - the design doc is explicit that the resume point of the
    // activity being left is already on disk, so switching tabs loses
    // nothing and must not force a restart.
    expect(host.sessionsStarted).toEqual([{ passageId: pv.passage.id, rung: 'ordering', restart: undefined }]);
  });

  it('degrades to no tab strip, without throwing, when the plan fetch fails', async () => {
    const reason = 'Could not reach the Scripture Memory worker (getPlan): Timeout';
    host.handlers.getPlan = () => ({ ok: false, error: reason });

    const practice = await mountPractice(blanksStep(PSALM_1_2, BLANKED), { rung: 'blanks' });

    expect(practice.root.querySelectorAll('[role="tab"]').length).toBe(0);
    expect(host.announcements).toContain(reason);
    // Not fatal: the exercise itself is unaffected by the missing strip.
    expect(practice.root.querySelectorAll('.sm-blank').length).toBe(2);
  });

  it('draws no tab strip before the plan fetch resolves', () => {
    // No `getPlan` handler registered at all: the request never settles
    // within this synchronous assertion, mirroring how `loadContext`'s own
    // context arrives after the first paint.
    const practice = new PracticeView(host, session(blanksStep(PSALM_1_2, BLANKED), { rung: 'blanks' }));
    practice.mount(container);
    view = practice;

    expect(practice.root.querySelectorAll('[role="tab"]').length).toBe(0);
    // The exercise itself is already usable.
    expect(practice.root.querySelectorAll('.sm-blank').length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// 12. The practice screen's Next button (N6, Decision 4)
// ---------------------------------------------------------------------------

describe("the practice screen's Next button", () => {
  /** The breadcrumb's own action slot, where the Next button lives. */
  function nextButton(root: HTMLElement): HTMLButtonElement | null {
    return Array.from(root.querySelectorAll<HTMLButtonElement>('.sm-crumbs-actions button')).find(
      (b) => b.textContent === 'Next',
    ) ?? null;
  }

  it('is omitted for a passage flow (every call today, and PracticeView\'s own default)', async () => {
    const practice = await mountPractice(blanksStep(PSALM_1_2, BLANKED), { rung: 'blanks' });
    expect(nextButton(practice.root)).toBeNull();
  });

  it('is omitted for an explicit passage flow, mid-exercise and on the summary screen alike', async () => {
    const flow: Flow = { kind: 'passage', passageId: 1 };
    const midExercise = await mountPractice(blanksStep(PSALM_1_2, BLANKED), { rung: 'blanks' }, undefined, flow);
    expect(nextButton(midExercise.root)).toBeNull();

    const onSummary = await mountPractice(null, { rung: 'blanks' }, undefined, flow);
    expect(nextButton(onSummary.root)).toBeNull();
  });

  it('is shown for a variety flow', async () => {
    const flow: Flow = { kind: 'variety' };
    const practice = await mountPractice(blanksStep(PSALM_1_2, BLANKED), { rung: 'blanks' }, undefined, flow);
    expect(nextButton(practice.root)).not.toBeNull();
  });

  it('is shown for an activity flow, including on the summary screen (no step)', async () => {
    const flow: Flow = { kind: 'activity', rung: 'blanks' };
    const practice = await mountPractice(null, { rung: 'blanks' }, undefined, flow);
    expect(nextButton(practice.root)).not.toBeNull();
  });

  it('ends the session, then starts the flow again excluding the passage just left', async () => {
    let endSessionCalled = false;
    host.handlers.endSession = () => {
      endSessionCalled = true;
      return { ok: true, data: { summary: null } };
    };
    const flow: Flow = { kind: 'variety' };
    const practice = await mountPractice(
      blanksStep(PSALM_1_2, BLANKED),
      { rung: 'blanks', passageId: 42 },
      undefined,
      flow,
    );

    nextButton(practice.root)!.click();
    await settle();

    expect(endSessionCalled).toBe(true);
    // The Home crumb's own ending is a `sessionEnded` nav action - Next
    // reuses the exact same `endSession`, so it must go through the same
    // path (preserving the resume point, per the design doc) rather than a
    // bespoke one.
    expect(host.navigations).toContainEqual({ type: 'sessionEnded' });

    expect(host.flowsStarted).toEqual([{ flow, exclude: new Set([42]) }]);
  });

  it('does not throw when the flow it re-runs finds nothing to start', async () => {
    // `startFlow`'s own no-target degrade (announcing and stopping, mirroring
    // `startNextDue`'s handling of the same situation - see `panel.ts`) is
    // the real `PanelHost`'s job, not this view's: PracticeView only has to
    // call `endSession` and hand off to `host.startFlow` without crashing,
    // whatever that call eventually does or does not find. The stub host
    // here does nothing at all in `startFlow`, which is the sharpest version
    // of "found nothing" this view could be handed.
    host.handlers.endSession = () => ({ ok: true, data: { summary: null } });
    const flow: Flow = { kind: 'activity', rung: 'blanks' };
    const practice = await mountPractice(
      blanksStep(PSALM_1_2, BLANKED),
      { rung: 'blanks', passageId: 5 },
      undefined,
      flow,
    );

    expect(() => nextButton(practice.root)!.click()).not.toThrow();
    await settle();

    expect(host.flowsStarted).toEqual([{ flow, exclude: new Set([5]) }]);
  });
});
