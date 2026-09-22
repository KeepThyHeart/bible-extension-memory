/**
 * The small, repeated pieces: the breadcrumb, level boxes, bars, empty states.
 *
 * Collected here rather than repeated in each view so that a level box means
 * one thing everywhere. The plan row's boxes and the passage screen's boxes
 * are the same claim about the same card, and two implementations of it would
 * drift the first time one of them was adjusted.
 *
 * Everything returns a detached element. Nothing here reads state, schedules
 * work, or touches the worker.
 *
 * ## Breadcrumb styling
 *
 * The host gives extension panels colour and font tokens only - no button,
 * toolbar or back-icon styles (see `styles.css`'s header note). Task 0004
 * asked this panel to look like the rest of the app in the meantime: a
 * full-width band and small flat controls rather than v0's rounded filled
 * ones and text-link "Back to plan". `breadcrumb()` and `.sm-crumbs*` in
 * `styles.css` are that local approximation. The proper fix is a shared
 * stylesheet from the host (`ext-ui://host/controls.css`, raised as a
 * separate Bible-repo task per that review) that this panel would then
 * consume instead of maintaining its own copy.
 *
 * `breadcrumb()` itself replaced an earlier `toolbar()` with a plain back
 * arrow (Decision 1 of the nav/chrome redesign): a breadcrumb satisfies both
 * "a back control that matches the app's visual language" and "a
 * breadcrumb" with one control, and needs no icon shared from the host repo
 * since Home is drawn locally with `icon('home')` below.
 */

import type { Rung, RungView } from '../types';
import { append, button, el } from './dom';
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

/** One entry in a `breadcrumb()` trail. */
export interface Crumb {
  label: string;
  /** Omitted on the final crumb - it is the current screen, not a link. */
  onClick?: () => void;
}

/**
 * The breadcrumb band at the top of every screen, replacing the old
 * `toolbar()`'s back arrow.
 *
 * Every non-final crumb is a real `<button>`; the final one is the screen's
 * own `<h1>`, given `aria-current="page"` instead of a click handler - there
 * is nowhere further to go from the current screen, and `panel.ts#render`
 * keeps focusing `main.querySelector('h1')` after every navigation without
 * needing to know that heading now lives inside a crumb trail.
 *
 * Crumb 1 is always Home - a house glyph (`icon('home')`) plus the word
 * "Home" - whether or not it is also the final crumb (the home screen itself
 * has a single, unclickable "Home" crumb).
 *
 * `menu` is a left-most slot for the hamburger the home screen will get
 * later (item 16); it is unused by every call site today and exists only so
 * that a later change does not have to touch this signature. `actions`
 * mirrors `toolbar()`'s own slot, e.g. the passage screen's "Show in Bible"
 * and answer-mode gear, or the plan screen's "Analytics" / "Settings" links.
 */
export function breadcrumb(opts: {
  crumbs: Crumb[];
  menu?: HTMLElement;
  actions?: (HTMLElement | null)[];
}): HTMLElement {
  const list = el('ol', { class: 'sm-crumb-list' });

  opts.crumbs.forEach((crumb, index) => {
    const isFirst = index === 0;
    const isLast = index === opts.crumbs.length - 1;
    const content: (Node | string)[] = isFirst ? [icon('home'), crumb.label] : [crumb.label];

    const crumbEl: HTMLElement = isLast
      ? el('h1', { class: 'sm-crumb-current', attrs: { 'aria-current': 'page' } })
      : button(crumb.label, crumb.onClick ?? (() => {}), { class: 'sm-crumb', text: '' });
    append(crumbEl, content);

    list.appendChild(el('li', { class: 'sm-crumb-item' }, [crumbEl]));

    if (!isLast) {
      list.appendChild(
        el('li', { class: 'sm-crumb-sep' }, [
          el('span', { attrs: { 'aria-hidden': 'true' } }, ['›']),
        ]),
      );
    }
  });

  return el('nav', { class: 'sm-crumbs', attrs: { 'aria-label': 'Breadcrumb' } }, [
    opts.menu ?? null,
    list,
    el('div', { class: 'sm-crumbs-actions' }, opts.actions ?? []),
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

// ---------------------------------------------------------------------------
// Icons
// ---------------------------------------------------------------------------

/**
 * The names `icon()` knows how to draw.
 *
 * `home` and `menu` are chrome, not activities. The other six are activity
 * icons: `ordering`, `refmatch`, `blanks` and `firstletters` name the
 * existing rungs (see `Rung` in `types.ts`); `variety` and `provideref` are
 * two more the design doc introduces ahead of any rung or exercise of their
 * own, which is why this is its own union rather than `Rung` plus two - this
 * file should not have to change again the day their exercises land.
 */
export type IconName =
  | 'home'
  | 'menu'
  | 'variety'
  | 'refmatch'
  | 'ordering'
  | 'blanks'
  | 'firstletters'
  | 'provideref';

/**
 * The strokes each icon is built from, one `<path>` per entry.
 *
 * All eight share a 24x24 viewBox and a 2px round-capped stroke so that
 * mixing them in one row (the nav, an activity tile grid) never reads as two
 * icon sets. A couple of names could not be told apart by shape alone at this
 * size, so the choices are deliberate: `variety`'s crossing diagonals read as
 * "shuffle/mix" where `refmatch`'s two opposing horizontal arrows read as
 * "match this to that"; `ordering`'s up/down arrow beside ranked lines reads
 * as "put these in order" where plain `menu` is three even, unranked ones.
 */
const ICON_PATHS: Readonly<Record<IconName, readonly string[]>> = {
  // A house: roof, walls, and a door - the one non-abstract icon here, since
  // it names a screen ("Home") rather than an activity.
  home: ['M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z', 'M9 22V12h6v10'],
  // Three even bars - the nav's own "more" affordance, unranked on purpose so
  // it never doubles as a fourth activity icon.
  menu: ['M3 6h18', 'M3 12h18', 'M3 18h18'],
  // A shuffle glyph: two crossing diagonals, each with its own arrowhead.
  variety: ['M16 3h5v5', 'M4 20L21 3', 'M21 16v5h-5', 'M15 15l6 6', 'M4 4l5 5'],
  // Two arrows pointing at each other, top-right and bottom-left - matching
  // one thing to another rather than a single directional move.
  refmatch: ['M3 7h11', 'M10 3l4 4-4 4', 'M21 17H10', 'M14 13l-4 4 4 4'],
  // A vertical up/down arrow beside three lines of increasing length - lines
  // that have a rank, and an affordance for moving one up or down it.
  ordering: ['M4 5v14', 'M2 8l2-3 2 3', 'M2 16l2 3 2-3', 'M10 6h8', 'M10 12h10', 'M10 18h6'],
  // Two short word-strokes with a longer underline between them - the blank
  // sitting where a word has been removed.
  blanks: ['M3 9h4', 'M9 14h6', 'M17 9h4'],
  // A capital "A", stroked rather than set as text so it is one more path
  // among equals rather than a font dependency.
  firstletters: ['M4 19L10 4L16 19', 'M6.5 13h7'],
  // A bookmark - the passage's own place kept, which is what "provide the
  // reference" is asking the user to recall.
  provideref: ['M6 3h12v18l-6-4-6 4z'],
};

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * A small inline icon, built with `createElementNS` rather than a markup
 * string - `dom.ts`'s header explains why there is no `innerHTML` path
 * anywhere in this bundle, and an icon set is not worth being the exception.
 *
 * `stroke="currentColor"` so an icon always matches the text colour of
 * whatever control it sits in without a per-caller override, and
 * `aria-hidden="true"` because every call site pairs an icon with visible
 * text (a toolbar title, an activity label) - the icon is decoration, and a
 * screen reader announcing "home icon, Home" on top of that text would be
 * noise, not help.
 */
export function icon(name: IconName): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '1em');
  svg.setAttribute('height', '1em');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', `sm-icon sm-icon-${name}`);

  for (const d of ICON_PATHS[name]) {
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', d);
    svg.appendChild(path);
  }

  return svg;
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
