/**
 * One passage: its activities, laid out linearly, each always practisable.
 *
 * "Linearly" is still the point - the three activities are a suggested
 * progression, and any layout that puts them in a grid or a ring loses the
 * one fact worth communicating: that blanks comes after ordering and before
 * first-letters in difficulty, even though nothing here enforces that order
 * any more.
 *
 * Task 0004 dropped every lock: there is no "not yet unlocked" and no
 * "replay - this will not count" qualifier left to draw, because every
 * attempt on every activity is a live one. What replaced the ladder's gating
 * is a single "Suggested" badge (`suggestedRungFor`) and, per activity, a
 * Restart/Resume pair when the user left one mid-way instead of finishing it.
 */

import type { AnswerMode, PassageView, Rung, RungView } from '../types';
import { button, el, replace } from './dom';
import {
  breadcrumb,
  errorBanner,
  inapplicabilityNote,
  levelBoxes,
  scheduleLine,
  suggestedBadge,
} from './components';
import { RUNG_LABEL, countLabel, inLadderOrder, isDue, suggestedRungFor } from './format';
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

  root.appendChild(
    el(
      'div',
      { class: 'sm-activities' },
      inLadderOrder(pv.rungs).map((rv) => renderActivityCard(host, pv, rv, rv.rung === suggested, now)),
    ),
  );

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
 * "Suggested" badge below points at - so a visitor who does not want to read
 * three activity rows never has to. It says "Resume" instead of "Practice"
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
 * One activity, drawn as a single compact, tabular row rather than a small
 * stack of its own lines - a follow-up review round asked the activity list
 * to be "more tabular, compact", the same complaint as the plan row's. Name
 * and badge on the left, level on the right of that, the paused-or-schedule
 * note taking the remaining space, and the action button(s) pinned to the
 * far right - one line at the panel's usual desktop width; `.sm-activity-card`
 * wraps at the narrow, docked width (see `styles.css`'s responsive block)
 * rather than trying to hold four columns in a pane a phone-sized fraction
 * of that.
 */
function renderActivityCard(
  host: PanelHost,
  pv: PassageView,
  rv: RungView,
  isSuggested: boolean,
  now: number,
): HTMLElement {
  const due = isDue(rv, now);
  const classes = ['sm-activity-card'];
  if (!rv.applicable) classes.push('sm-activity-na');
  if (due) classes.push('sm-activity-due');

  const head = el('div', { class: 'sm-activity-head' }, [
    el('h2', { class: 'sm-activity-title', text: RUNG_LABEL[rv.rung] }),
    isSuggested && rv.applicable ? suggestedBadge() : null,
  ]);

  if (!rv.applicable) {
    return el('div', { class: classes.join(' ') }, [
      head,
      el('p', { class: 'sm-activity-blurb', text: inapplicabilityNote(rv.rung) }),
    ]);
  }

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

  return el('div', { class: classes.join(' ') }, [head, level, status, actions]);
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
