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
import { button, el } from './dom';
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
      return 'Matching a reference needs other passages to tell it apart from.';
    default:
      return 'This activity does not apply to this passage.';
  }
}
