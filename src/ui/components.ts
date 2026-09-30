/**
 * The small, repeated pieces: the toolbar, level boxes, bars, empty states.
 *
 * Collected here rather than repeated in each view so that a level box means
 * one thing everywhere. The plan row's boxes and the passage screen's boxes
 * are the same claim about the same card, and two implementations of it would
 * drift the first time one of them was adjusted.
 *
 * Everything returns a detached element. Nothing here reads state, schedules
 * work, or touches the worker.
 *
 * ## Toolbar styling
 *
 * The host gives extension panels colour and font tokens only - no button,
 * toolbar or back-icon styles (see `styles.css`'s header note). Task 0004
 * asked this panel to look like the rest of the app in the meantime: a
 * full-width toolbar band, a plain back arrow at the left, and small flat
 * buttons rather than v0's rounded filled ones and text-link "Back to plan".
 * `toolbar()` and `.sm-toolbar*` in `styles.css` are that local approximation.
 * The proper fix is a shared stylesheet from the host (`ext-ui://host/controls.css`,
 * raised as a separate Bible-repo task per that review) that this panel would
 * then consume instead of maintaining its own copy.
 */

import type { Rung, RungView } from '../types';
import { append, button, el, focusQuietly } from './dom';
import { MIN_VERSES_FOR_REFERENCE_ACTIVITIES } from '../ladder';
import {
  MASTERED_LEVEL,
  RUNG_LABEL,
  carriesDownFrom,
  clampPercent,
  countLabel,
  formatDue,
  formatScore,
  inLadderOrder,
} from './format';

/**
 * The toolbar band at the top of every screen.
 *
 * `onBack` is omitted only on the home screen, which is the one place there
 * is nowhere further back to go.
 */
export function toolbar(opts: {
  title: string;
  onBack?: () => void;
  actions?: (HTMLElement | null)[];
}): HTMLElement {
  return el('header', { class: 'sm-toolbar' }, [
    opts.onBack
      ? button('←', opts.onBack, { class: 'sm-back', attrs: { 'aria-label': 'Back' } })
      : el('span', { class: 'sm-toolbar-spacer', attrs: { 'aria-hidden': 'true' } }),
    el('h1', { class: 'sm-toolbar-title', text: opts.title }),
    el('div', { class: 'sm-toolbar-actions' }, opts.actions ?? []),
  ]);
}

/**
 * The "there is nothing here yet" panel.
 *
 * Takes an action because an empty state without one is a dead end: the plan
 * screen with no passages is the first thing a new user sees, and telling them
 * it is empty without telling them what to do about it wastes the only screen
 * that has their full attention.
 */
export function emptyState(
  message: string,
  detail?: string,
  action?: HTMLElement,
): HTMLElement {
  return el('div', { class: 'sm-empty', attrs: { role: 'status' } }, [
    el('p', { class: 'sm-empty-message', text: message }),
    detail !== undefined ? el('p', { class: 'sm-empty-detail', text: detail }) : null,
    action ?? null,
  ]);
}

/**
 * An error the user is meant to read and act on.
 *
 * `role="alert"` because these appear in response to something the user just
 * did - most often a reference that would not parse - and a message that
 * appears silently beside the field is a message a screen reader user never
 * learns about.
 */
export function errorBanner(message: string): HTMLElement {
  return el('p', {
    class: 'sm-error',
    text: message,
    attrs: { role: 'alert' },
  });
}

/** The count of due activities on a passage, or nothing at all when none are. */
export function dueBadge(dueCount: number): HTMLElement | null {
  if (dueCount <= 0) return null;
  return el('span', {
    class: 'sm-badge sm-badge-due',
    text: String(dueCount),
    attrs: { 'aria-label': `${countLabel(dueCount, 'activity', 'activities')} due` },
  });
}

/** "Suggested" - the badge on the activity `suggestedRungFor` picked. */
export function suggestedBadge(): HTMLElement {
  return el('span', { class: 'sm-badge sm-badge-suggested', text: 'Suggested' });
}

// ---------------------------------------------------------------------------
// Level boxes
// ---------------------------------------------------------------------------

/** How many boxes an activity's level is drawn with - always five. */
export const LEVEL_MAX = 5;
/** The level at and above which a box is drawn green rather than yellow. */
const GREEN_AT = MASTERED_LEVEL;

/**
 * The five-box level indicator: grey for not-yet-reached, yellow at levels
 * 1-3, green at 4-5, and faded green when a mastered activity has come due
 * for review again - the spaced repetition schedule keeps running underneath,
 * and the fade is the only sign of it the user needs.
 */
export function levelBoxes(level: number, opts: { due?: boolean } = {}): HTMLElement {
  const boxes: HTMLElement[] = [];
  const faded = Boolean(opts.due) && level >= GREEN_AT;

  for (let i = 1; i <= LEVEL_MAX; i += 1) {
    const filled = i <= level;
    const classes = ['sm-level-box'];
    if (filled) classes.push(level >= GREEN_AT ? 'sm-level-box-green' : 'sm-level-box-yellow');
    if (filled && faded) classes.push('sm-level-box-faded');
    boxes.push(el('span', { class: classes.join(' '), attrs: { 'aria-hidden': 'true' } }));
  }

  const label =
    level === 0
      ? 'not tried yet'
      : `level ${level} of ${LEVEL_MAX}${opts.due ? ', due for review' : ''}`;

  return el(
    'span',
    { class: `sm-level-boxes${opts.due && level < GREEN_AT ? ' sm-level-boxes-due' : ''}`, attrs: { role: 'img', 'aria-label': label } },
    boxes,
  );
}

/**
 * A single word describing an activity square's status, for its title and
 * accessible label.
 */
function squareStatusWord(rv: RungView, carried: boolean): string {
  if (rv.level >= MASTERED_LEVEL) return 'well learned';
  if (carried) return 'learned via a harder activity';
  if (rv.level > 0) return 'in progress';
  return 'not started';
}

/**
 * The compact per-passage status strip for a plan row: one small square per
 * applicable activity rather than a labelled five-box strip per activity, so
 * a plan of many passages reads as a glance rather than a scroll (task 0004
 * review, point 1: "a lot more compact... a single row of squares").
 *
 * Colour follows the review's own scheme: greyed grey = not started, orange
 * = attempted but not yet mastered, green = mastered on this activity
 * itself, light green = not mastered *here* but the passage's overall
 * "well learned" status already carries down from a harder activity (see
 * `carriesDownFrom`).
 */
export function activitySquares(rungs: RungView[]): HTMLElement {
  const applicable = inLadderOrder(rungs).filter((r) => r.applicable);

  return el(
    'span',
    { class: 'sm-activity-squares', attrs: { role: 'img', 'aria-label': squaresLabel(applicable, rungs) } },
    applicable.map((rv) => {
      const carried = rv.level < MASTERED_LEVEL && carriesDownFrom(rungs, rv.rung);
      const status =
        rv.level >= MASTERED_LEVEL ? 'done' : carried ? 'carried' : rv.level > 0 ? 'partial' : 'new';
      return el('span', {
        class: `sm-activity-square sm-activity-square-${status}`,
        title: `${RUNG_LABEL[rv.rung]}: ${squareStatusWord(rv, carried)}`,
        attrs: { 'aria-hidden': 'true' },
      });
    }),
  );
}

// ---------------------------------------------------------------------------
// Icon buttons
// ---------------------------------------------------------------------------

/**
 * A button whose visible content is a glyph rather than a word, given an
 * accessible name through `aria-label` (and, for a mouse user, `title` as a
 * tooltip). Mirrors the pattern `passageView.ts`'s answer-mode gear (`⚙`)
 * already uses inline - `.sm-btn .sm-btn-quiet .sm-btn-small .sm-icon-btn` -
 * factored out here so later screens do not each re-type that class list.
 */
export function iconButton(glyph: string, label: string, onClick: () => void): HTMLButtonElement {
  return button(glyph, onClick, {
    class: 'sm-btn sm-btn-quiet sm-btn-small sm-icon-btn',
    title: label,
    attrs: { 'aria-label': label },
  });
}

// ---------------------------------------------------------------------------
// Modal
// ---------------------------------------------------------------------------

/** What `modal()` needs to build and behave. */
export interface ModalOptions {
  /** Heading text, also used to build the dialog's accessible name. */
  title: string;
  /** The modal's body. A single element or a list of children. */
  content: HTMLElement | (HTMLElement | string)[];
  /**
   * Called once, the moment the modal is closed by the user - Esc, a
   * backdrop click, or the built-in close button - never called for a close
   * the caller drives itself. The caller owns what happens next (usually
   * nothing further: `modal()` already removes its own DOM and restores
   * focus before this fires).
   */
  onClose: () => void;
}

let modalIdSeq = 0;

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

function focusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (node) => node.offsetParent !== null || node.getClientRects().length > 0 || !node.hidden,
  );
}

/**
 * A hand-rolled overlay dialog - never `<dialog>.showModal()`, never
 * `window.confirm`. Both are off the table for this panel: a sandboxed iframe
 * can suppress native modal dialogs outright (see `passageView.ts`'s inline
 * remove-confirmation for the same reasoning applied to `confirm()`), and
 * jsdom's `<dialog>` support is unreliable in tests. This is an ordinary pair
 * of `div`s (`role="dialog"`, `aria-modal="true"`) with the modal behaviour -
 * focus trap, Esc, backdrop click, focus restore - implemented by hand.
 *
 * Returns the backdrop element, detached. **The caller must insert it into
 * the document itself** (typically `document.body.appendChild(...)`), and
 * must do so synchronously after calling `modal()` - the element the trigger
 * had focus on is captured at call time, and initial focus is moved into the
 * modal on the next microtask (after `queueMicrotask`), which assumes the
 * node is already connected by then. Tests can flush that microtask the same
 * way the rest of this codebase settles a promise queue.
 *
 * On close (Esc, a backdrop click, or the built-in `✕` button) the backdrop
 * removes itself from its parent, focus returns to whatever had it before the
 * modal opened, and `onClose` runs last.
 */
export function modal(opts: ModalOptions): HTMLElement {
  const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const titleId = `sm-modal-title-${(modalIdSeq += 1)}`;

  const container = el('div', {
    class: 'sm-modal',
    attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId, tabindex: '-1' },
  });

  function close(): void {
    backdrop.remove();
    focusQuietly(previouslyFocused);
    opts.onClose();
  }

  const closeButton = iconButton('✕', 'Close', close);
  const header = el('div', { class: 'sm-modal-header' }, [
    el('h2', { id: titleId, class: 'sm-modal-title', text: opts.title }),
    closeButton,
  ]);
  const body = el('div', { class: 'sm-modal-body' }, Array.isArray(opts.content) ? opts.content : [opts.content]);
  append(container, [header, body]);

  container.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') {
      ev.stopPropagation();
      close();
      return;
    }
    if (ev.key !== 'Tab') return;

    const focusables = focusableElements(container);
    if (focusables.length === 0) {
      ev.preventDefault();
      return;
    }
    const first = focusables[0]!;
    const last = focusables[focusables.length - 1]!;
    if (ev.shiftKey && document.activeElement === first) {
      ev.preventDefault();
      focusQuietly(last);
    } else if (!ev.shiftKey && document.activeElement === last) {
      ev.preventDefault();
      focusQuietly(first);
    }
  });

  const backdrop = el('div', { class: 'sm-modal-backdrop' }, [container]);
  backdrop.addEventListener('mousedown', (ev) => {
    if (ev.target === backdrop) close();
  });

  queueMicrotask(() => {
    if (!backdrop.isConnected) return; // Caller never inserted it, or already closed.
    const focusables = focusableElements(container);
    focusQuietly(focusables[0] ?? container);
  });

  return backdrop;
}

// ---------------------------------------------------------------------------
// Tier pips
// ---------------------------------------------------------------------------

/**
 * Small dot-per-tier progress, e.g. for a passage-overview row: `tiers` pips,
 * `tiersPassed` of them marked passed. Colour is never the only signal - the
 * whole thing carries a text `aria-label` with the count, the way
 * `levelBoxes` does for its five boxes.
 */
export function tierPips(tiersPassed: number, tiers: number): HTMLElement {
  const pips: HTMLElement[] = [];
  for (let i = 1; i <= tiers; i += 1) {
    const passed = i <= tiersPassed;
    pips.push(
      el('span', {
        class: `sm-tier-pip${passed ? ' sm-tier-pip-passed' : ''}`,
        attrs: { 'aria-hidden': 'true' },
      }),
    );
  }
  return el(
    'span',
    {
      class: 'sm-tier-pips',
      attrs: { role: 'img', 'aria-label': `${tiersPassed} of ${countLabel(tiers, 'tier')} passed` },
    },
    pips,
  );
}

// ---------------------------------------------------------------------------
// List selector
// ---------------------------------------------------------------------------

/** One choice in `listSelector` - `'all'` for the "All lists" option. */
export interface ListSelectorOption {
  id: number | 'all';
  name: string;
}

/**
 * A `<select>`-based "All lists"/per-list picker. Deliberately minimal - T10
 * is what wires this into the home screen's header and decides how it looks
 * there; this just gets a working, accessible control in place.
 */
export function listSelector(
  options: ListSelectorOption[],
  selected: number | 'all',
  onChange: (id: number | 'all') => void,
): HTMLSelectElement {
  const select = el('select', {
    class: 'sm-select sm-list-selector',
    attrs: { 'aria-label': 'List' },
  }) as HTMLSelectElement;

  for (const opt of options) {
    const optionEl = el('option', { value: String(opt.id), text: opt.name });
    if (opt.id === selected) optionEl.selected = true;
    select.appendChild(optionEl);
  }

  select.addEventListener('change', () => {
    const match = options.find((opt) => String(opt.id) === select.value);
    if (match) onChange(match.id);
  });

  return select;
}

// ---------------------------------------------------------------------------
// Activity row
// ---------------------------------------------------------------------------

/** What one `activityRow` needs. */
export interface ActivityRowOptions {
  rung: Rung;
  /** 0-5, same scale as `levelBoxes`. */
  level: number;
  /** How many difficulty tiers this activity has. See `ladder.ts#TIERS`. */
  tiers: number;
  tiersPassed: number;
  /** Whether this activity is due now - passed through to `levelBoxes`. */
  due?: boolean;
  /** The schedule/progress slot, e.g. `scheduleLine`'s text - left blank if omitted. */
  scheduleText?: string;
  onPlay: () => void;
  /** Accessible name for the play icon. Defaults to "Practice <activity>". */
  playLabel?: string;
}

/**
 * One row of an aligned activity table: name, tier pips, level boxes, a
 * schedule/progress slot, and a play icon - in that order, as plain flex
 * children rather than a real `<table>` (matching `.sm-activity-card`'s own
 * approach elsewhere in this file). Deliberately minimal/generic: T12 builds
 * the actual passage-overview grid on top of this and owns the polish.
 */
export function activityRow(opts: ActivityRowOptions): HTMLElement {
  return el('div', { class: 'sm-activity-row' }, [
    el('span', { class: 'sm-activity-row-name', text: RUNG_LABEL[opts.rung] }),
    tierPips(opts.tiersPassed, opts.tiers),
    levelBoxes(opts.level, { due: opts.due }),
    el('span', { class: 'sm-activity-row-schedule', text: opts.scheduleText ?? '' }),
    iconButton('▶', opts.playLabel ?? `Practice ${RUNG_LABEL[opts.rung]}`, opts.onPlay),
  ]);
}

function squaresLabel(applicable: RungView[], allRungs: RungView[]): string {
  return applicable
    .map((rv) => {
      const carried = rv.level < MASTERED_LEVEL && carriesDownFrom(allRungs, rv.rung);
      return `${RUNG_LABEL[rv.rung]}: ${squareStatusWord(rv, carried)}`;
    })
    .join('; ');
}

/**
 * A labelled horizontal bar, drawn in CSS.
 *
 * No chart library: there is nothing to load one from, and a handful of bars
 * do not justify one anyway. `role="img"` with a complete label, because the
 * visual is the whole content and a bare div conveys none of it.
 */
export function bar(fraction: number, label: string): HTMLElement {
  const percent = clampPercent(fraction);
  return el(
    'div',
    { class: 'sm-bar', attrs: { role: 'img', 'aria-label': label } },
    [el('div', { class: 'sm-bar-fill', style: { width: `${percent}%` } })],
  );
}

/** A number with a caption under it. */
export function statTile(value: string, caption: string): HTMLElement {
  return el('div', { class: 'sm-stat' }, [
    el('div', { class: 'sm-stat-value', text: value }),
    el('div', { class: 'sm-stat-caption', text: caption }),
  ]);
}

/** "Due in 3 days · last score 82%" - the line under a passage-screen activity. */
export function scheduleLine(rung: { dueAt: number | null; lastScore: number | null; streak: number }, now: number): HTMLElement {
  const parts: string[] = [formatDue(rung.dueAt, now)];
  if (rung.lastScore !== null) parts.push(`Last score ${formatScore(rung.lastScore)}`);
  if (rung.streak > 0) parts.push(countLabel(rung.streak, 'pass', 'passes') + ' in a row');
  return el('p', { class: 'sm-schedule', text: parts.join(' · ') });
}

/**
 * A short caption naming an activity that does not apply and why.
 *
 * Non-applicable activities are shown rather than hidden. A ladder with a
 * missing step reads like a bug, and the reason a single verse cannot be
 * reordered is interesting enough to be worth one line of explanation.
 */
export function inapplicabilityNote(rung: Rung): string {
  switch (rung) {
    case 'ordering':
      return 'Putting verses in order needs more than one verse.';
    case 'refmatch':
      return `Matching a reference needs ${MIN_VERSES_FOR_REFERENCE_ACTIVITIES} verses in this list to tell references apart.`;
    case 'refprovide':
      return `Naming a reference needs ${MIN_VERSES_FOR_REFERENCE_ACTIVITIES} verses in this list to tell references apart.`;
    default:
      return 'This activity does not apply to this passage.';
  }
}
