/**
 * The plan: "just go" and a quiet list of what is underway.
 *
 * This is the default screen and, for a user in the habit, the only one they
 * need: open the panel, press Practice, work, close it. Task 0004's review
 * asked for this explicitly - "it should be possible, and easy, for the user
 * to just go" - and the one-click add-and-start path below for an empty plan
 * is the sharpest form of that: a brand new user should never see an empty
 * list with nothing to press.
 *
 * T10 reworked this screen: the title is now the literal string "Bible
 * Memory" rather than the current list's name (`PlanView.collectionName` no
 * longer drives it - see that field's own doc comment in `types.ts`), the
 * bordered "Start practicing" button is gone in favour of a chrome-free
 * `Practice` text control with an activity picker beside it, and the full
 * add-passage form (paste-batch flow included) has moved to the Manage
 * Passages screen (T11) - this file keeps only `renderAddAndStart`, the
 * one-press shortcut for a plan with nothing in it yet.
 */

import type { PassageView, PlanView, Rung } from '../types';
import { append, button, el, replace } from './dom';
import { activitySquares, dueBadge, emptyState, iconButton, listSelector, toolbar } from './components';
import type { ListSelectorOption } from './components';
import { RUNG_LABEL } from './format';
import { listTargets, pickShuffledTarget } from './suggest';
import type { PracticeTarget as SuggestTarget } from './suggest';
import { MIN_VERSES_FOR_REFERENCE_ACTIVITIES } from '../ladder';
import type { PanelHost } from './host';

export function renderPlan(host: PanelHost, plan: PlanView): HTMLElement {
  const now = host.now();
  const root = el('section', { class: 'sm-screen sm-screen-plan' });

  root.appendChild(
    toolbar({
      title: 'Bible Memory',
      actions: [
        button('Analytics', () => host.go({ type: 'goAnalytics' }), { class: 'sm-btn sm-btn-quiet sm-btn-small' }),
        button('Settings', () => host.go({ type: 'goSettings' }), { class: 'sm-btn sm-btn-quiet sm-btn-small' }),
      ],
    }),
  );

  if (plan.lists.length > 1) {
    root.appendChild(renderListPicker(host, plan));
  }

  if (plan.passages.length === 0) {
    root.appendChild(renderAddAndStart(host));
    root.appendChild(renderManagePassagesLink(host));
    root.appendChild(
      emptyState(
        'Nothing in your plan yet.',
        'Add a reference above - a single verse, or a range like "Psalm 1:1-6" - and its activities will be built for you.',
      ),
    );
    return root;
  }

  root.appendChild(renderPracticeSection(host, plan, now));
  root.appendChild(renderManagePassagesLink(host));

  root.appendChild(
    el(
      'ul',
      { class: 'sm-list', attrs: { 'aria-label': 'Passages in this plan' } },
      plan.passages.map((pv) => renderPassageRow(host, pv)),
    ),
  );

  return root;
}

// ---------------------------------------------------------------------------
// Practice: activity picker, the chrome-free Practice control, and the
// shuffled recommendation
// ---------------------------------------------------------------------------

/** What the activity `<select>` offers, in the order the task asked for. */
const ACTIVITY_OPTIONS: { value: Rung | 'next'; label: string }[] = [
  { value: 'next', label: 'Next steps' },
  { value: 'refmatch', label: 'Match references' },
  { value: 'ordering', label: 'Put in order' },
  { value: 'blanks', label: 'Fill in the blanks' },
  { value: 'firstletters', label: 'First letters' },
  { value: 'refprovide', label: 'Provide reference' },
];

const ACTIVITY_LABEL: Readonly<Record<Rung | 'next', string>> = Object.fromEntries(
  ACTIVITY_OPTIONS.map((opt) => [opt.value, opt.label]),
) as Record<Rung | 'next', string>;

/** The two activities gated behind `plan.referenceActivitiesUnlocked`. */
function isReferenceActivity(value: Rung | 'next'): boolean {
  return value === 'refmatch' || value === 'refprovide';
}

function sameSuggestTarget(a: SuggestTarget, b: SuggestTarget): boolean {
  return a.passageId === b.passageId && a.rung === b.rung;
}

/** Every applicable (passage, activity) pair the current picker choice offers. */
function poolFor(plan: PlanView, now: number, activity: Rung | 'next'): SuggestTarget[] {
  const all = listTargets(plan, now);
  return activity === 'next' ? all : all.filter((t) => t.rung === activity);
}

/**
 * Picks a target for whatever the activity picker currently says.
 *
 * "Next steps" defers to `pickShuffledTarget` (the plan's own 30/70
 * due-weighted draw). A specific activity narrows the pool to that rung
 * first - `pickShuffledTarget` has no rung filter of its own, and duplicating
 * its due-weighting for a single-rung pool would be more machinery than a
 * "shuffle within one activity" control needs - then draws uniformly from
 * whatever is left once `exclude` is removed, falling back to the whole
 * narrowed pool (which may just be `exclude` itself) rather than returning
 * nothing when there is genuinely only one applicable target.
 *
 * `rng` is passed in deliberately, the same discipline `suggest.ts` uses -
 * this is the one place in the panel proper that wants real unpredictability
 * (the "shuffle" affordance), so it is `Math.random` at the call site rather
 * than a value read off the clock, but it still never gets called from
 * inside this function so a test can substitute it.
 */
function pickTargetFor(
  plan: PlanView,
  now: number,
  activity: Rung | 'next',
  rng: () => number,
  exclude?: SuggestTarget,
): SuggestTarget | null {
  if (activity === 'next') return pickShuffledTarget(plan, now, rng, exclude);

  const pool = poolFor(plan, now, activity);
  if (pool.length === 0) return null;

  const candidates = exclude ? pool.filter((t) => !sameSuggestTarget(t, exclude)) : pool;
  const chosen = candidates.length > 0 ? candidates : pool;
  const idx = Math.min(Math.floor(rng() * chosen.length), chosen.length - 1);
  return chosen[Math.max(idx, 0)]!;
}

function targetLineContent(target: SuggestTarget | null, activity: Rung | 'next'): HTMLElement {
  if (!target) {
    return el('p', {
      class: 'sm-callout-text',
      text: `Nothing to practise for ${ACTIVITY_LABEL[activity]} yet.`,
    });
  }
  return el('p', { class: 'sm-callout-text', text: `${target.reference} — ${RUNG_LABEL[target.rung]}` });
}

/**
 * The Practice control: the activity picker, the chrome-free `Practice`
 * button, the persistent lock hint (when reference activities are not
 * unlocked), and the recommended target with its shuffle button.
 *
 * The picker, the button and the target line all close over the same
 * `activity`/`current` pair rather than being three independently-rendered
 * pieces, because picking a new activity has to change what both the button
 * and the target line do - there is exactly one "what should Practice start
 * right now" fact and everything here reads it from the same place.
 */
function renderPracticeSection(host: PanelHost, plan: PlanView, now: number): HTMLElement {
  let activity: Rung | 'next' = 'next';
  let current: SuggestTarget | null = pickTargetFor(plan, now, activity, Math.random);

  const targetSlot = el('div', { class: 'sm-practice-target' }, [targetLineContent(current, activity)]);

  function repaint(target: SuggestTarget | null, forActivity: Rung | 'next'): void {
    current = target;
    replace(targetSlot, [targetLineContent(target, forActivity)]);
  }

  const practiceButton = button(
    'Practice',
    () => {
      if (!current) {
        host.announce(`Nothing to practise for ${ACTIVITY_LABEL[activity]} yet.`);
        return;
      }
      void host.startSession(current.passageId, current.rung);
    },
    { class: 'sm-btn sm-btn-quiet sm-practice-btn' },
  );

  const select = el('select', {
    class: 'sm-select sm-activity-picker',
    attrs: { 'aria-label': 'Activity' },
  }) as HTMLSelectElement;
  for (const opt of ACTIVITY_OPTIONS) {
    const locked = isReferenceActivity(opt.value) && !plan.referenceActivitiesUnlocked;
    select.appendChild(el('option', { value: opt.value, text: opt.label, disabled: locked }));
  }
  select.addEventListener('change', () => {
    activity = (select.value as Rung | 'next') || 'next';
    repaint(pickTargetFor(plan, now, activity, Math.random), activity);
  });

  const shuffleButton = iconButton('🔀', 'Shuffle suggestion', () => {
    const pool = poolFor(plan, now, activity);
    const others = current ? pool.filter((t) => !sameSuggestTarget(t, current!)) : pool;
    if (others.length === 0) {
      // Not broken - there is simply nothing else applicable to offer right
      // now (an empty plan never reaches here; this is the "exactly one
      // target" case).
      host.announce('Nothing else to practise right now.');
      return;
    }
    repaint(pickTargetFor(plan, now, activity, Math.random, current ?? undefined), activity);
  });

  const children: (HTMLElement | null)[] = [
    el('div', { class: 'sm-practice-row' }, [select, practiceButton]),
    plan.referenceActivitiesUnlocked ? null : renderReferenceHint(host, plan),
    el('div', { class: 'sm-practice-target-row' }, [targetSlot, shuffleButton]),
  ];

  return el('div', { class: 'sm-practice-section' }, children);
}

/**
 * The persistent explanation under the activity picker while the two
 * reference activities are locked - a `title` on a disabled `<option>` is
 * not reliably shown by any browser, so this line is what actually carries
 * the "why", plus a real way to fix it.
 */
function renderReferenceHint(host: PanelHost, plan: PlanView): HTMLElement {
  const needed = MIN_VERSES_FOR_REFERENCE_ACTIVITIES;
  const short = Math.max(0, needed - plan.scopeVerseCount);
  return el('p', { class: 'sm-hint sm-reference-hint' }, [
    `Match references and Provide reference need ${needed} verses in this list - ` +
      `${short} more to go (${plan.scopeVerseCount} so far). `,
    button('Manage Passages', () => host.go({ type: 'goManagePassages' }), {
      class: 'sm-btn sm-btn-quiet sm-btn-small',
    }),
  ]);
}

function renderManagePassagesLink(host: PanelHost): HTMLElement {
  return button('Manage Passages', () => host.go({ type: 'goManagePassages' }), {
    class: 'sm-btn sm-btn-quiet sm-btn-small sm-manage-passages-link',
  });
}

function renderListPicker(host: PanelHost, plan: PlanView): HTMLElement {
  const options: ListSelectorOption[] = [
    { id: 'all', name: 'All Lists' },
    ...plan.lists.map((list) => ({ id: list.id, name: list.name })),
  ];
  // `selected` is always read from `plan.scope`, never from local state - the
  // worker owns scope, so a `planChanged` push that rebuilds this whole
  // screen still shows the right selection rather than silently resetting to
  // "All Lists".
  return listSelector(options, plan.scope, (id) => {
    void host
      .request({ type: 'setScope', scope: id === 'all' ? { kind: 'all' } : { kind: 'list', id } })
      .then((reply) => {
        if (reply.ok) host.reload();
        else host.announce(reply.error);
      });
  });
}

// ---------------------------------------------------------------------------
// The one-click empty-plan shortcut
// ---------------------------------------------------------------------------

/**
 * On an empty plan, "Practice" becomes a one-click "Add <verse> and start",
 * using whatever the host says the reader is currently looking at. That is
 * the whole point of the worker pushing `activeVerse` in the first place:
 * someone who has just read a verse and reached for this panel should not
 * have to type it back in before they can begin. The full add-passage form
 * (batches, paste handling) lives on the Manage Passages screen now; this is
 * the one thing a brand-new user must still have to press.
 */
function renderAddAndStart(host: PanelHost): HTMLElement {
  const reference = host.activeReference;

  if (!reference) {
    return el('div', { class: 'sm-callout' }, [
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
