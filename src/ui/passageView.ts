/**
 * One passage: its activities, laid out as an aligned table, each always
 * practisable.
 *
 * Task 0004 dropped every lock: there is no "not yet unlocked" and no
 * "replay - this will not count" qualifier left to draw, because every
 * attempt on every activity is a live one. What replaced the ladder's gating
 * is a single "Suggested" badge (`suggestedRungFor`) plus, on this screen, a
 * "Practice Passage" link that always starts it.
 *
 * T12 rebuilt this screen around a real grid (see `ui/styles.css`'s
 * "Passage overview" section) so every row's name, tier pips, level boxes,
 * schedule/progress note and play target line up across rows - the previous
 * flex-row cards did not guarantee that, since each row's own content
 * decided how wide its pieces were. Each row is a single `<button>`
 * spanning the grid (never a `<button>` nested inside a `<button>`), with
 * the play glyph as a decorative, `aria-hidden` `<span>` inside it: the
 * whole row is the click target, not just the glyph.
 *
 * Resume/Restart choices no longer live here - clicking a row always calls
 * `host.startSession` without `restart`, which resumes a paused activity on
 * its own; the activity/practice screen is where a deliberate restart lives
 * now. Removal moved to Manage Passages (T11) and is not offered here at
 * all. The per-passage answer-mode override and "Reset progress for this
 * passage" (T4's `resetPassageProgress`) live together behind the gear icon,
 * in one `components.ts#modal` rather than an inline reveal.
 */

import type { AnswerMode, PassageView, Rung, RungView } from '../types';
import { button, el, replace } from './dom';
import {
  errorBanner,
  inapplicabilityNote,
  levelBoxes,
  modal,
  suggestedBadge,
  tierPips,
  toolbar,
} from './components';
import { RUNG_LABEL, countLabel, formatDue, formatScore, inLadderOrder, isDue, suggestedRungFor } from './format';
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

  const settingsToggle = button('⚙', () => openSettingsModal(host, pv, defaultAnswerMode), {
    class: 'sm-btn sm-btn-quiet sm-btn-small sm-icon-btn',
    attrs: { 'aria-label': 'Passage settings', title: 'Passage settings' },
  });

  root.appendChild(
    toolbar({
      title: pv.passage.reference,
      onBack: () => host.go({ type: 'goPlan' }),
      actions: [
        button('Show in Bible', () => host.openInBible(pv.passage.startVerseId), {
          class: 'sm-btn sm-btn-quiet sm-btn-small',
        }),
        settingsToggle,
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

  const practiceLink = renderPracticeLink(host, pv, suggested);
  if (practiceLink) root.appendChild(practiceLink);

  root.appendChild(
    el(
      'div',
      { class: 'sm-activity-table' },
      inLadderOrder(pv.rungs).map((rv) => renderActivityRow(host, pv, rv, rv.rung === suggested, now)),
    ),
  );

  return root;
}

// ---------------------------------------------------------------------------
// The primary action
// ---------------------------------------------------------------------------

/**
 * A plain text link, "Practice Passage", that always starts the activity
 * `suggestedRungFor` points at - the same rule the "Suggested" badge below
 * uses, so the link and the badge never disagree about what happens next.
 *
 * A second review round pushed back on the per-activity rows alone: "we
 * never want the user to not practice for lack of decisiveness on *what* to
 * practice." Deliberately chrome-free (a real `<button>` styled as a link,
 * not a bordered callout) to match the home screen's own "Practice" control
 * (`planView.ts`) at the scale of one passage - this screen's action is a
 * secondary path next to the table, not competing with it for weight.
 */
function renderPracticeLink(host: PanelHost, pv: PassageView, suggested: Rung | null): HTMLElement | null {
  if (suggested === null) return null; // No applicable activity at all - unreachable in practice.

  return button('Practice Passage', () => void host.startSession(pv.passage.id, suggested), {
    class: 'sm-btn sm-btn-quiet sm-passage-practice-link',
  });
}

// ---------------------------------------------------------------------------
// The activity table
// ---------------------------------------------------------------------------

/**
 * What the schedule/progress cell reads.
 *
 * An untried activity (`attempts === 0`) shows nothing here at all - the
 * empty level boxes already say "not tried yet"; repeating that in words was
 * the exact text a review round asked to drop. A paused activity shows a
 * compact `stepsDone/totalSteps` indicator instead of a sentence, since this
 * is a single grid cell, not a paragraph. Anything else falls back to the
 * due date, plus the last score when one exists.
 */
function progressText(rv: RungView, now: number): string {
  if (rv.resume) return `${rv.resume.stepsDone}/${rv.resume.totalSteps}`;
  if (rv.attempts === 0) return '';
  const parts = [formatDue(rv.dueAt, now)];
  if (rv.lastScore !== null) parts.push(`Last score ${formatScore(rv.lastScore)}`);
  return parts.join(' · ');
}

/**
 * One row of the aligned activity table.
 *
 * An inapplicable activity is still shown - a ladder with a missing step
 * reads like a bug - but as a plain `<div>`, not a `<button>`: there is
 * nothing to start, and it must not be reachable by click or by Tab as if
 * there were. `inapplicabilityNote` supplies the reason inline, which for
 * the two reference activities now names the verse-count gate
 * (`ladder.ts#MIN_VERSES_FOR_REFERENCE_ACTIVITIES`).
 *
 * An applicable activity is one `<button>` spanning the whole grid row, its
 * accessible name set explicitly via `aria-label` rather than left to
 * accumulate from its children - the tier pips and level boxes are their own
 * `role="img"` elements with their own labels, and letting all of that
 * concatenate into the button's name would read as noise to a screen reader
 * rather than as "Practice Fill in the blanks".
 */
function renderActivityRow(
  host: PanelHost,
  pv: PassageView,
  rv: RungView,
  isSuggested: boolean,
  now: number,
): HTMLElement {
  if (!rv.applicable) {
    return el('div', { class: 'sm-activity-row sm-activity-row-na' }, [
      el('span', { class: 'sm-activity-row-name', text: RUNG_LABEL[rv.rung] }),
      el('span', { class: 'sm-activity-row-note', text: inapplicabilityNote(rv.rung) }),
    ]);
  }

  const due = isDue(rv, now);
  const classes = ['sm-activity-row'];
  if (due) classes.push('sm-activity-row-due');

  const nameCell = el('span', { class: 'sm-activity-row-name' }, [
    RUNG_LABEL[rv.rung],
    isSuggested ? suggestedBadge() : null,
  ]);

  const label = rv.resume ? `Resume ${RUNG_LABEL[rv.rung]}` : `Practice ${RUNG_LABEL[rv.rung]}`;

  return el(
    'button',
    {
      class: classes.join(' '),
      attrs: { type: 'button', 'aria-label': label },
      on: { click: () => void host.startSession(pv.passage.id, rv.rung) },
    },
    [
      nameCell,
      tierPips(rv.tiersPassed, rv.tiers),
      levelBoxes(rv.level, { due }),
      el('span', { class: 'sm-activity-row-progress', text: progressText(rv, now) }),
      el('span', { class: 'sm-activity-row-play', attrs: { 'aria-hidden': 'true' }, text: '▶' }),
    ],
  );
}

// ---------------------------------------------------------------------------
// Settings modal: answer-mode override, reset progress
// ---------------------------------------------------------------------------

/**
 * The gear icon's target: a `components.ts#modal` holding the per-passage
 * answer-mode override and "Reset progress for this passage" together.
 *
 * Both actions end in `host.reload()`, which re-fetches and re-renders the
 * whole screen (`panel.ts` re-runs `getPassageView`) - so both close the
 * modal *first*. The modal's backdrop is appended to `document.body`, not to
 * this screen's own root, and a reload only replaces the panel's main
 * content; an open modal left unclosed would survive that swap as an orphan.
 */
function openSettingsModal(host: PanelHost, pv: PassageView, defaultAnswerMode: AnswerMode): void {
  function closeModal(): void {
    backdrop.remove();
  }

  const answerRow = renderAnswerModeControl(host, pv, defaultAnswerMode, closeModal);
  const resetProgress = renderResetProgress(host, pv, closeModal);

  const backdrop = modal({
    title: 'Passage settings',
    content: [answerRow, resetProgress],
    onClose: () => backdrop.remove(),
  });
  document.body.appendChild(backdrop);
}

/**
 * "Answer with: Default (first letter) [v]" - the per-passage override of the
 * global answer-mode setting (task 0004 review, point 11), now always visible
 * inside the settings modal rather than behind its own inline reveal.
 */
function renderAnswerModeControl(
  host: PanelHost,
  pv: PassageView,
  defaultAnswerMode: AnswerMode,
  closeModal: () => void,
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

  const errorSlot = el('div', { class: 'sm-answer-row-error' });

  select.addEventListener('change', () => {
    const mode = select.value === '' ? null : (select.value as AnswerMode);
    select.disabled = true;
    void host
      .request({ type: 'setPassageAnswerMode', passageId: pv.passage.id, mode })
      .then((reply) => {
        select.disabled = false;
        if (!reply.ok) {
          replace(errorSlot, [errorBanner(reply.error)]);
          return;
        }
        closeModal();
        host.reload();
      });
  });

  return el('div', { class: 'sm-answer-row' }, [
    el('label', { class: 'sm-label-inline', text: 'Answer with', attrs: { for: 'sm-answer-mode' } }),
    select,
    errorSlot,
  ]);
}

/**
 * "Reset progress for this passage" - the only way any displayed level goes
 * down (D1(a)), behind a confirmation step for the same reason the old
 * remove control had one: this throws away real history, and a `confirm()`
 * dialog can be silently suppressed in a sandboxed iframe (see
 * `components.ts#modal`'s own header). Dispatches T4's `resetPassageProgress`
 * request.
 */
function renderResetProgress(host: PanelHost, pv: PassageView, closeModal: () => void): HTMLElement {
  const slot = el('div', { class: 'sm-reset-progress' });

  const showIdle = (): void => {
    replace(slot, [
      button('Reset progress for this passage', showConfirm, {
        class: 'sm-btn sm-btn-small sm-btn-danger-quiet',
        attrs: { 'aria-label': `Reset all progress for ${pv.passage.reference}` },
      }),
    ]);
  };

  function showConfirm(): void {
    replace(slot, [
      el('span', { class: 'sm-remove-confirm', attrs: { role: 'alert' } }, [
        el('span', { class: 'sm-hint', text: 'Reset all progress on this passage? This cannot be undone.' }),
        button('Yes, reset', doReset, { class: 'sm-btn sm-btn-small sm-btn-danger' }),
        button('Cancel', showIdle, { class: 'sm-btn sm-btn-small sm-btn-quiet' }),
      ]),
    ]);
  }

  function doReset(): void {
    void host.request({ type: 'resetPassageProgress', passageId: pv.passage.id }).then((reply) => {
      if (!reply.ok) {
        replace(slot, [errorBanner(reply.error)]);
        return;
      }
      host.announce(`Reset progress for ${pv.passage.reference}.`);
      closeModal();
      host.reload();
    });
  }

  showIdle();
  return slot;
}
