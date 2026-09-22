/**
 * One passage: its activities, one at a time behind a tab strip, each always
 * practisable.
 *
 * "Linearly" is still the point behind the strip's order - the applicable
 * activities are a suggested progression (`format.ts#inLadderOrder`), and any
 * layout that shuffled the tabs would lose the one fact worth communicating:
 * that blanks comes after ordering and before first-letters in difficulty,
 * even though nothing here enforces that order any more.
 *
 * Task 0004 dropped every lock: there is no "not yet unlocked" and no
 * "replay - this will not count" qualifier left to draw, because every
 * attempt on every activity is a live one. What replaced the ladder's gating
 * is `suggestedRungFor` - naming the tab selected by default and the one big
 * Practice button's own target - and, per activity, a Restart/Resume pair
 * when the user left one mid-way instead of finishing it.
 */

import type { AnswerMode, PassageView, Rung, RungView } from '../types';
import { button, el, replace } from './dom';
import {
  breadcrumb,
  errorBanner,
  inapplicabilityNote,
  levelBoxes,
  scheduleLine,
  tabs,
} from './components';
import { RUNG_LABEL, applicableRungs, countLabel, inLadderOrder, isDue, suggestedRungFor } from './format';
import type { PanelHost } from './host';

/**
 * Named `renderPassageScreen` rather than `renderPassage`, deliberately: that
 * name is `scripture.ts#renderPassage`, which renders a run of verses as DOM
 * and is used throughout this file's sibling `practiceView.ts`. The two are
 * easy to reach for interchangeably by name alone, and only one of them
 * knows what a `PassageView` is.
 */
export function renderPassageScreen(
  host: PanelHost,
  pv: PassageView,
  defaultAnswerMode: AnswerMode,
  /**
   * Which activity tab is showing - `state.ts#View`'s own `rung`, `null`
   * meaning "suggested" (resolved below via `suggestedRungFor`, the same rule
   * that already picks the Practice callout's target and the old "Suggested"
   * badge). Optional and defaulting to `null` so every existing call in this
   * file's own test suite, which predates N3's `rung` and has no view state
   * to pass, keeps behaving exactly as it did.
   */
  viewRung: Rung | null = null,
): HTMLElement {
  const now = host.now();
  const root = el('section', { class: 'sm-screen sm-screen-passage' });

  // The per-passage answer-mode override, tucked behind a gear icon rather
  // than shown open on the screen (a review round: "hide the 'first letter'
  // setting behind a Settings icon for cleanliness" - it is a one-time,
  // rarely-touched preference, not something this screen needs to lead
  // with). The panel and its toggle button are built together, here, so the
  // click handler can flip the one DOM node without a separate lookup.
  const answerPanel = renderAnswerModeRow(host, pv, defaultAnswerMode);
  answerPanel.hidden = true;
  const answerToggle = button(
    '⚙',
    () => {
      answerPanel.hidden = !answerPanel.hidden;
      answerToggle.setAttribute('aria-expanded', String(!answerPanel.hidden));
    },
    {
      class: 'sm-btn sm-btn-quiet sm-btn-small sm-icon-btn',
      attrs: { 'aria-label': 'Answer mode settings', 'aria-expanded': 'false', title: 'Answer mode settings' },
    },
  );

  root.appendChild(
    breadcrumb({
      crumbs: [
        { label: 'Home', onClick: () => host.go({ type: 'goPlan' }) },
        { label: pv.passage.reference },
      ],
      actions: [
        button('Show in Bible', () => host.openInBible(pv.passage.startVerseId), {
          class: 'sm-btn sm-btn-quiet sm-btn-small',
        }),
        answerToggle,
      ],
    }),
  );

  root.appendChild(
    el('p', { class: 'sm-subhead' }, [
      el('span', { text: countLabel(pv.passage.verseCount, 'verse') }),
      pv.wellLearned
        ? el('span', { class: 'sm-badge sm-badge-learned', text: 'Well learned' })
        : null,
    ]),
  );

  const suggested = suggestedRungFor(pv.rungs, now);

  const callout = renderPracticeCallout(host, pv, suggested);
  if (callout) root.appendChild(callout);

  const applicable = applicableRungs(pv.rungs);
  if (applicable.length > 0) {
    // `viewRung ?? suggested` - an explicit tab wins; otherwise the same
    // suggestion the callout above already names. `suggested` is only `null`
    // when nothing is applicable at all, which `applicable.length > 0` here
    // rules out, but the fallback to the strip's first tab keeps this correct
    // even if a stale `viewRung` ever named a rung no longer applicable.
    const active = applicable.find((rv) => rv.rung === (viewRung ?? suggested)) ?? applicable[0]!;

    root.appendChild(
      tabs({
        items: applicable.map((rv) => ({ value: rv.rung, label: RUNG_LABEL[rv.rung] })),
        selected: active.rung,
        onSelect: (rung) => host.go({ type: 'goPassage', passageId: pv.passage.id, rung }),
        ariaLabel: 'Activity',
      }),
    );

    root.appendChild(el('div', { class: 'sm-activities' }, [renderActivityDetail(host, pv, active, now)]));
  }

  for (const rv of inLadderOrder(pv.rungs).filter((r) => !r.applicable)) {
    root.appendChild(
      el('p', { class: 'sm-activity-blurb' }, [
        el('strong', { text: RUNG_LABEL[rv.rung] }),
        `: ${inapplicabilityNote(rv.rung)}`,
      ]),
    );
  }

  root.appendChild(answerPanel);
  root.appendChild(renderRemoveControl(host, pv));

  return root;
}

// ---------------------------------------------------------------------------
// The primary action
// ---------------------------------------------------------------------------

/**
 * A big "Practice" button that decides for the user, mirroring the home
 * screen's "Start practicing" (`planView.ts#renderStartPracticing`) at the
 * scale of one passage.
 *
 * A second review round pushed back on the per-activity cards alone: "we
 * never want the user to not practice for lack of decisiveness on *what* to
 * practice." This button always starts `suggested` - the same activity the
 * tab strip below selects by default - so a visitor who does not want to
 * choose a tab first never has to. It says "Resume" instead of "Practice"
 * when that activity was left mid-way, since `host.startSession` without
 * `restart` already resumes it; the button's label should not disagree with
 * what pressing it does.
 */
function renderPracticeCallout(host: PanelHost, pv: PassageView, suggested: Rung | null): HTMLElement | null {
  if (suggested === null) return null; // No applicable activity at all - unreachable in practice.

  const rv = pv.rungs.find((r) => r.rung === suggested) ?? null;
  const label = rv?.resume ? 'Resume practicing' : 'Practice';

  const action = button(label, () => void host.startSession(pv.passage.id, suggested), {
    class: 'sm-btn sm-btn-primary sm-btn-block sm-btn-large',
  });

  return el('div', { class: 'sm-callout sm-callout-action' }, [
    action,
    el('p', { class: 'sm-callout-text', text: RUNG_LABEL[suggested] }),
  ]);
}

// ---------------------------------------------------------------------------
// One activity
// ---------------------------------------------------------------------------

/**
 * The selected tab's own activity: level boxes, the paused-or-schedule note,
 * and the action button(s) - what used to be one row of a stacked list of
 * every activity's card (`renderActivityCard`, task 0004's "more tabular,
 * compact" review) is now the single card the tab strip above is choosing
 * between (Decision 2 of the nav/chrome redesign). The activity's name is not
 * repeated here: the selected tab already names it, and a "Suggested" badge
 * that used to sit beside that name is dropped for the same reason - the
 * Practice callout above already says which activity is suggested, in words,
 * whether or not it is the one currently selected.
 */
function renderActivityDetail(host: PanelHost, pv: PassageView, rv: RungView, now: number): HTMLElement {
  const due = isDue(rv, now);
  const classes = ['sm-activity-card'];
  if (due) classes.push('sm-activity-due');

  const level = el('div', { class: 'sm-activity-level-row' }, [
    levelBoxes(rv.level, { due }),
    el('span', {
      class: 'sm-activity-level-text',
      text: rv.level === 0 ? 'Not tried yet' : `${rv.level}/5`,
    }),
  ]);

  const status = rv.resume
    ? el('p', {
        class: 'sm-activity-paused',
        text: `Paused at verse ${rv.resume.stepsDone} of ${rv.resume.totalSteps}`,
      })
    : scheduleLine(rv, now);

  const actions = rv.resume
    ? el('div', { class: 'sm-activity-actions' }, [
        button('Restart', () => void host.startSession(pv.passage.id, rv.rung, true), {
          class: 'sm-btn sm-btn-small sm-btn-quiet',
        }),
        button('Resume', () => void host.startSession(pv.passage.id, rv.rung), {
          class: 'sm-btn sm-btn-small sm-btn-primary',
        }),
      ])
    : el('div', { class: 'sm-activity-actions' }, [
        button('Practice', () => void host.startSession(pv.passage.id, rv.rung), {
          class: 'sm-btn sm-btn-small sm-btn-primary',
        }),
      ]);

  return el('div', { class: classes.join(' ') }, [level, status, actions]);
}

// ---------------------------------------------------------------------------
// Answer mode override
// ---------------------------------------------------------------------------

/**
 * "Answer with: Default (first letter) [v]" - the per-passage override of the
 * global answer-mode setting (task 0004 review, point 11).
 */
function renderAnswerModeRow(
  host: PanelHost,
  pv: PassageView,
  defaultAnswerMode: AnswerMode,
): HTMLElement {
  const select = el('select', {
    class: 'sm-select',
    id: 'sm-answer-mode',
    attrs: { 'aria-label': 'Answer with' },
  }) as HTMLSelectElement;

  const defaultLabel = defaultAnswerMode === 'fullWord' ? 'full word' : 'first letter';
  const options: { value: '' | AnswerMode; label: string }[] = [
    { value: '', label: `Default (${defaultLabel})` },
    { value: 'firstLetter', label: 'First letter' },
    { value: 'fullWord', label: 'Full word, exact spelling' },
  ];

  for (const opt of options) {
    const optionEl = el('option', { value: opt.value, text: opt.label });
    if ((pv.passage.answerMode ?? '') === opt.value) optionEl.selected = true;
    select.appendChild(optionEl);
  }

  select.addEventListener('change', () => {
    const mode = select.value === '' ? null : (select.value as AnswerMode);
    select.disabled = true;
    void host
      .request({ type: 'setPassageAnswerMode', passageId: pv.passage.id, mode })
      .then((reply) => {
        select.disabled = false;
        if (!reply.ok) {
          host.announce(reply.error);
          return;
        }
        host.reload();
      });
  });

  return el('div', { class: 'sm-answer-row' }, [
    el('label', { class: 'sm-label-inline', text: 'Answer with', attrs: { for: 'sm-answer-mode' } }),
    select,
  ]);
}

// ---------------------------------------------------------------------------
// Removal
// ---------------------------------------------------------------------------

/**
 * Remove - behind an inline confirmation step, but only when there is
 * something a confirmation is for.
 *
 * A second review round asked that removal stay "easy", with confirmation
 * required only "if they have already been successfully practiced". A
 * passage nobody has ever attempted (`pv.bestLevel === 0` - no rung has ever
 * scored anything) has no attempt history to lose, so "Remove passage…"
 * removes it immediately there; a passage with any practice behind it still
 * gets the confirmation step, since that is the one thing removal actually
 * throws away.
 *
 * Not `window.confirm` for the confirming case: a sandboxed iframe can have
 * modal dialogs suppressed entirely, in which case `confirm()` returns false
 * and the button appears to do nothing at all. Swapping the control for its
 * own confirmation is both more visible and impossible to suppress.
 */
function renderRemoveControl(host: PanelHost, pv: PassageView): HTMLElement {
  const slot = el('div', { class: 'sm-remove' });
  const hasHistory = pv.bestLevel > 0;

  function doRemove(): void {
    void host.request({ type: 'removePassage', passageId: pv.passage.id }).then((reply) => {
      if (!reply.ok) {
        replace(slot, [errorBanner(reply.error)]);
        return;
      }
      host.announce(`Removed ${pv.passage.reference}.`);
      host.go({ type: 'passageRemoved', passageId: pv.passage.id });
    });
  }

  const showIdle = (): void => {
    replace(slot, [
      button('Remove passage…', hasHistory ? showConfirm : doRemove, {
        class: 'sm-btn sm-btn-small sm-btn-danger-quiet',
        attrs: { 'aria-label': `Remove ${pv.passage.reference} from the plan` },
      }),
    ]);
  };

  function showConfirm(): void {
    replace(slot, [
      el('span', { class: 'sm-remove-confirm', attrs: { role: 'alert' } }, [
        el('span', { class: 'sm-hint', text: 'Remove this passage and its history?' }),
        button(
          'Yes, remove',
          doRemove,
          { class: 'sm-btn sm-btn-small sm-btn-danger' },
        ),
        button('Cancel', showIdle, { class: 'sm-btn sm-btn-small sm-btn-quiet' }),
      ]),
    ]);
  }

  showIdle();
  return slot;
}
