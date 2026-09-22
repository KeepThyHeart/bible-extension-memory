/**
 * The plan: "just go" and a quiet list of what is underway.
 *
 * This is the default screen and, for a user in the habit, the only one they
 * need: open the panel, press Start practicing, work, close it. Task 0004's
 * review asked for this explicitly - "it should be possible, and easy, for
 * the user to just go" - and the one-click add-and-start path below for an
 * empty plan is the sharpest form of that: a brand new user should never see
 * an empty list with nothing to press.
 */

import type { PassageSortOrder, PassageView, PlanView } from '../types';
import { append, button, el } from './dom';
import { activitySquares, breadcrumb, dueBadge, emptyState, icon, menu } from './components';
import { RUNG_LABEL, activityAvailability, pickStartTarget, sortPassagesByNeed } from './format';
import { ACTIVITY_TILES, type ActivityTile } from './activities';
import type { Flow } from './state';
import type { PanelHost } from './host';

export function renderPlan(host: PanelHost, plan: PlanView): HTMLElement {
  const now = host.now();
  const root = el('section', { class: 'sm-screen sm-screen-plan' });

  root.appendChild(
    breadcrumb({
      // The home screen's own crumb trail is just "Home" - a single,
      // unclickable crumb (design doc's crumb-trail table) - not the plan's
      // own name, which nothing else on this screen shows either.
      crumbs: [{ label: 'Home' }],
      // The hamburger (M3, decision 11): Manage Passages, Analytics and
      // Settings folded into one menu in the breadcrumb's left slot, on this
      // screen only, rather than as separate `actions` buttons.
      menu: menu({
        label: 'Menu',
        items: [
          { label: 'Manage Passages', onClick: () => host.go({ type: 'goManage' }) },
          { label: 'Analytics', onClick: () => host.go({ type: 'goAnalytics' }) },
          { label: 'Settings', onClick: () => host.go({ type: 'goSettings' }) },
        ],
      }),
      actions: [],
    }),
  );

  root.appendChild(renderStartPracticing(host, plan, now));

  if (plan.passages.length === 0) {
    // `format.ts#activityAvailability`'s own note: an empty plan replaces the
    // whole tile grid with this empty state, rather than showing six
    // disabled tiles beside it - the empty state already offers the one
    // thing to do next.
    //
    // M5: the add-passage field used to sit right above this (Decision 10
    // moved it, and its batch-paste UI, to Manage Passages), so the hint
    // points there now rather than "above" - there is no field on this
    // screen for a plan with no active reference to point at.
    root.appendChild(
      emptyState(
        'Nothing in your plan yet.',
        'Add a reference from Manage Passages - a single verse, or a range like "Psalm 1:1-6" - and its activities will be built for you.',
      ),
    );
    return root;
  }

  root.appendChild(renderActivityTiles(host, plan, now));

  root.appendChild(renderPassageListHeader(host, plan));

  // 'bible' is `plan.passages`'s own order already - `store.ts#listPassages`'s
  // `ORDER BY start_verse_id` - so only 'need' asks `sortPassagesByNeed` (M1)
  // to do anything.
  const sortedPassages = plan.sortOrder === 'need' ? sortPassagesByNeed(plan.passages, now) : plan.passages;

  root.appendChild(
    el(
      'ul',
      { class: 'sm-list', attrs: { 'aria-label': 'Passages in this plan' } },
      sortedPassages.map((pv) => renderPassageRow(host, pv)),
    ),
  );

  return root;
}

// ---------------------------------------------------------------------------
// Passage list heading and sort control (M4, decisions 10 and 12)
// ---------------------------------------------------------------------------

/**
 * "Practice by Passage" heading plus the Bible-order / Needs-practice sort
 * `<select>`, in one header row right above the passage list.
 *
 * The choice persists (a since-answered open question in decision 12's own
 * text reversed the original "panel memory only" call): it rides on
 * `PlanView.sortOrder`, set via the `setPassageSortOrder` RPC, mirroring how
 * `passageView.ts#renderAnswerModeRow` persists its own per-passage answer
 * mode. `host.reload()` re-fetches `getPlan` rather than re-sorting
 * client-side, so what is shown always matches what a reload would show.
 */
function renderPassageListHeader(host: PanelHost, plan: PlanView): HTMLElement {
  const select = el('select', {
    class: 'sm-select',
    id: 'sm-passage-sort',
    attrs: { 'aria-label': 'Sort passages' },
  }) as HTMLSelectElement;

  const options: { value: PassageSortOrder; label: string }[] = [
    { value: 'bible', label: 'Bible order' },
    { value: 'need', label: 'Needs practice' },
  ];

  for (const opt of options) {
    const optionEl = el('option', { value: opt.value, text: opt.label });
    if (plan.sortOrder === opt.value) optionEl.selected = true;
    select.appendChild(optionEl);
  }

  select.addEventListener('change', () => {
    const order = select.value as PassageSortOrder;
    select.disabled = true;
    void host.request({ type: 'setPassageSortOrder', order }).then((reply) => {
      select.disabled = false;
      if (!reply.ok) {
        host.announce(reply.error);
        return;
      }
      host.reload();
    });
  });

  return el('div', { class: 'sm-list-header' }, [
    el('h2', { class: 'sm-block-title', text: 'Practice by Passage' }),
    select,
  ]);
}

// ---------------------------------------------------------------------------
// The primary action
// ---------------------------------------------------------------------------

/**
 * "Start practicing" - always one press away from doing something useful.
 *
 * On an empty plan this becomes a one-click "Add <verse> and start", using
 * whatever the host says the reader is currently looking at. That is the
 * whole point of the worker pushing `activeVerse` in the first place: someone
 * who has just read a verse and reached for this panel should not have to
 * type it back in before they can begin.
 */
function renderStartPracticing(host: PanelHost, plan: PlanView, now: number): HTMLElement {
  if (plan.passages.length === 0) {
    return renderAddAndStart(host);
  }

  const target = pickStartTarget(plan, now);
  if (target === null) {
    // Unreachable in practice - every applicable passage always has a
    // suggested activity now that nothing is locked - but kept as an honest
    // fallback rather than a silent no-op button.
    return el('div', { class: 'sm-callout' }, [
      el('p', { class: 'sm-callout-text', text: 'Add a passage to get started.' }),
    ]);
  }

  const action = button(
    'Start practicing',
    () => void host.startSession(target.passageId, target.rung),
    { class: 'sm-btn sm-btn-primary sm-btn-block sm-btn-large' },
  );

  return el('div', { class: 'sm-callout sm-callout-action' }, [
    action,
    el('p', {
      class: 'sm-callout-text',
      text: `${target.reference} — ${RUNG_LABEL[target.rung]}`,
    }),
  ]);
}

function renderAddAndStart(host: PanelHost): HTMLElement {
  const reference = host.activeReference;

  if (!reference) {
    return el('div', { class: 'sm-callout' }, [
      // "below" used to point at this screen's own add-passage field,
      // which M5 moved to Manage Passages - this empty case (no active
      // verse pushed yet) now has to name where to go instead.
      el('p', { class: 'sm-callout-text', text: 'Add a verse from Manage Passages to get started.' }),
    ]);
  }

  const action = button(
    `Add ${reference} and start`,
    () => {
      action.disabled = true;
      void host
        .request({ type: 'addPassage', reference })
        .then((reply) => {
          if (!reply.ok) {
            action.disabled = false;
            host.announce(reply.error);
            return;
          }
          void host.startSession(reply.data.passage.id);
        });
    },
    { class: 'sm-btn sm-btn-primary sm-btn-block sm-btn-large' },
  );

  return el('div', { class: 'sm-callout sm-callout-action' }, [action]);
}

// ---------------------------------------------------------------------------
// Activity tiles (round-2 UI review, decisions 6-8)
// ---------------------------------------------------------------------------

/**
 * "Practice by Activity" - the six-tile grid, one tile per
 * `activities.ts#ACTIVITY_TILES` entry in catalogue order.
 *
 * Only reached with a non-empty plan - see the note at its call site in
 * `renderPlan` for why an empty plan shows `emptyState()` instead.
 */
function renderActivityTiles(host: PanelHost, plan: PlanView, now: number): HTMLElement {
  return el('section', { class: 'sm-tile-section' }, [
    el('h2', { class: 'sm-block-title', text: 'Practice by Activity' }),
    el(
      'div',
      { class: 'sm-tile-grid' },
      ACTIVITY_TILES.map((tile) => renderActivityTile(host, plan, tile, now)),
    ),
  ]);
}

/**
 * One tile: icon, title, subtext and - when the tile is not available right
 * now - a third warning line, per decision 7. The tile stays visible and
 * merely disabled rather than being hidden, so a gap in the grid never reads
 * as a bug.
 *
 * `provideref` needs no special case here: `activityAvailability` already
 * reports it as always unavailable (M7 has not landed the exercise), and that
 * falls out of calling it uniformly for every tile.
 */
function renderActivityTile(host: PanelHost, plan: PlanView, tile: ActivityTile, now: number): HTMLElement {
  const availability = activityAvailability(plan, tile, now);

  const tileButton = button(
    tile.title,
    () => {
      // `variety` has no `Rung` of its own (see `ActivityTile.rung`'s note);
      // every other tile's `rung` is non-null by construction, and this
      // handler only ever runs on an available tile, so `provideref` (also
      // `rung: null`) can never reach it - `disabled` keeps it unpressable.
      const flow: Flow = tile.id === 'variety' ? { kind: 'variety' } : { kind: 'activity', rung: tile.rung! };
      void host.startFlow(flow);
    },
    { class: 'sm-tile', text: '', disabled: !availability.available },
  );

  append(tileButton, [
    icon(tile.id),
    el('span', { class: 'sm-tile-title', text: tile.title }),
    el('span', { class: 'sm-tile-sub', text: tile.subtext }),
    availability.available || availability.warning === null
      ? null
      : el('span', { class: 'sm-tile-warning', text: availability.warning }),
  ]);

  return tileButton;
}

// ---------------------------------------------------------------------------
// One passage
// ---------------------------------------------------------------------------

/**
 * A plan row: one compact, tabular line - reference and due badge on the
 * left, activity squares on the right - rather than a labelled strip per
 * activity, per the task 0004 review ("a lot more compact... a single row of
 * squares"). Row-level actions (Practice, Show in Bible) are gone too - the
 * review asked for them to stay hidden until a passage is actually selected,
 * and opening the passage screen already puts both one click away.
 *
 * A follow-up review round asked for the row to be tighter still: the verse
 * count ("6 verses") is dropped as extraneous once the reference itself often
 * says the same thing ("Psalm 23:1-6"), and so is the separate "Well
 * learned" text pill - an all-green square row already says exactly that,
 * and a second label for the same fact was the extraneous one, not the due
 * badge, which stays.
 *
 * The whole row is a real `<button>`, so it is reachable by Tab and
 * activates on Enter and Space without any of that being reimplemented.
 */
function renderPassageRow(host: PanelHost, pv: PassageView): HTMLElement {
  const main = button(
    pv.passage.reference,
    () => host.go({ type: 'goPassage', passageId: pv.passage.id }),
    { class: 'sm-row-main', text: '' },
  );
  append(main, [
    el('span', { class: 'sm-row-title' }, [
      el('span', { class: 'sm-row-ref', text: pv.passage.reference }),
      dueBadge(pv.dueCount),
    ]),
    activitySquares(pv.rungs),
  ]);

  return el('li', { class: 'sm-row' }, [main]);
}
