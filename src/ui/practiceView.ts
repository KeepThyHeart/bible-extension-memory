/**
 * The exercise runner.
 *
 * Everything else in this panel is a list. This is the part the extension is
 * actually for, and almost every decision in it was made deliberately rather
 * than inherited from a component library, so they are all written down here.
 *
 * LAYOUT. The passage is rendered once, as real scripture, and the exercise
 * happens *inside it*. A blank is an input sitting where its word sits, in its
 * own poetic line; a first-letter slot is the same. There is no answer box
 * below the passage. That arrangement was rejected explicitly, and it is worth
 * being clear about why it is worse than it looks: an answer box detaches what
 * you are typing from the line it belongs to, so the user reads the line, then
 * looks away to type, and the thing being trained - producing the next word
 * while looking at its context - never happens.
 *
 * WIDTHS. Every hidden word is sized to the *measured* width of the word it
 * hides (see `measure.ts`), so revealing it does not move anything. Overtyping
 * grows the input, which can push the rest of that line along; it never
 * repaginates the passage, because the input never gets narrower and the
 * surrounding blocks never change height for a single wrapped line.
 *
 * FEEDBACK. Wrong answers are red with a ✗ beside them, never struck through.
 * Striking through scripture was ruled out, and the reason is a good one - the
 * user's mistake gets a mark, but the words of the verse are not defaced.
 *
 * BLOCKING vs ADVANCING. The picker blocks: a wrong pick is marked so you can
 * see which one you clicked, and the same step comes back. The mark is
 * transient by design - it says "not that one", it does not keep a tally on
 * screen, and it is gone before the retry. The typed exercises do not block;
 * they show what was missed and move on.
 *
 * ## v1: one hidden-word mechanic, two answer modes
 *
 * `blanks` and `firstletters` used to be built out of two unrelated pieces of
 * code - one that showed the initial as a spoiler and asked you to retype it,
 * and one that asked for a whole word behind a Check button. Task 0004's
 * review called the first one out as a bug ("the first letters shouldn't be
 * visible") and asked for the two activities to differ only in *how many*
 * words are hidden, never in *how* a hidden word is answered. So there is now
 * one mechanic, `buildHiddenWordRenderer`, driven by `Step.answerMode`:
 *
 *   - `firstLetter` (the default) - a one-character box per hidden word, never
 *     pre-filled with anything. A correct letter reveals the whole word and
 *     moves on automatically; there is no Check button because there is
 *     nothing left to confirm once every box is resolved.
 *   - `fullWord` - a full-word box per hidden word, graded leniently on
 *     spelling but not on the letters themselves, confirmed with Check - this
 *     is what all of `blanks` looked like in v0.
 */

import type {
  AnswerMode,
  BlanksStep,
  FirstLettersStep,
  OrderingStep,
  PassageContext,
  RefMatchStep,
  SessionSummary,
  SessionView,
  StepAnswer,
  StepResult,
} from '../types';
import { append, button, clear, el, focusQuietly, replace, textNode } from './dom';
import { breadcrumb, errorBanner, levelBoxes } from './components';
import { RUNG_LABEL, formatScore, formatStepProgress, matchesFirstLetter, pickDueTarget } from './format';
import type { PanelHost } from './host';
import { plainWord, renderPassage } from './scripture';
import type { WordRenderer } from './scripture';
import { resolveWrongPositions, revealedWord } from './stepResult';
import type { HiddenWords } from './stepResult';

/** How long a wrong pick stays marked before the picker is handed back clean. */
const WRONG_MARK_MS = 1400;

/** How long a correct pick shows as correct before the next step replaces it. */
const CORRECT_FLASH_MS = 420;

export class PracticeView {
  readonly root: HTMLElement;

  private readonly headEl: HTMLElement;
  private readonly contextEl: HTMLElement;
  private readonly exerciseEl: HTMLElement;
  private readonly feedbackEl: HTMLElement;
  private readonly actionsEl: HTMLElement;

  private session: SessionView;
  private context: PassageContext | null = null;
  private summary: SessionSummary | null = null;

  /** Guards against a second submission while one is in flight. */
  private busy = false;

  /**
   * True once the user has touched the current step.
   *
   * Context arrives after the first paint (see `loadContext`), and slotting it
   * in means rebuilding the passage - which destroys the very inputs the user
   * may already be typing into. On a slow first fetch that is a whole verse of
   * work thrown away for a cosmetic improvement. So the late arrival is only
   * applied to an untouched step; otherwise it waits for the next one.
   */
  private interacted = false;
  private disposed = false;
  private readonly timers = new Set<number>();

  constructor(
    private readonly host: PanelHost,
    session: SessionView,
  ) {
    this.session = session;

    this.headEl = el('header', { class: 'sm-practice-head' });
    this.contextEl = el('div', { class: 'sm-context' });
    this.exerciseEl = el('div', { class: 'sm-exercise' });

    // `aria-live` on a region that is ALWAYS present, never created on demand:
    // a live region inserted at the same moment as its text is frequently not
    // announced at all, because the announcement is triggered by a mutation
    // inside an existing region. It also holds its own minimum height so the
    // passage does not jump when a verdict appears.
    this.feedbackEl = el('div', {
      class: 'sm-feedback',
      attrs: { 'aria-live': 'assertive', role: 'status' },
    });
    this.actionsEl = el('div', { class: 'sm-exercise-actions' });

    this.root = el('section', { class: 'sm-screen sm-practice' }, [
      this.headEl,
      this.contextEl,
      this.exerciseEl,
      this.feedbackEl,
      this.actionsEl,
    ]);
  }

  /**
   * Attaches to the document and draws.
   *
   * Mounting is a method rather than something the caller does with `.root`
   * because width measurement needs a laid-out element: `getComputedStyle` on
   * a detached node returns nothing useful, and a blank measured before mount
   * gets the fallback estimate instead of the real font. Owning the moment of
   * insertion means the measure pass can be guaranteed to run after it.
   */
  mount(container: HTMLElement): void {
    container.appendChild(this.root);
    this.render();
    void this.loadContext();
  }

  destroy(): void {
    this.disposed = true;
    for (const id of this.timers) window.clearTimeout(id);
    this.timers.clear();
    this.root.remove();
  }

  // -------------------------------------------------------------------------
  // Data
  // -------------------------------------------------------------------------

  /**
   * Fetches the surrounding verses.
   *
   * Deliberately not awaited before the first paint. The step itself carries
   * everything needed to start answering, and blocking the exercise behind a
   * context fetch would put a spinner between the user and the thing they
   * pressed a button to do. Context arrives and slots in above.
   */
  private async loadContext(): Promise<void> {
    const reply = await this.host.request({
      type: 'getContext',
      passageId: this.session.passageId,
    });
    if (this.disposed) return;
    if (!reply.ok) {
      // Not fatal: the exercise works without its surroundings, so this is
      // reported quietly rather than replacing the screen with an error.
      this.host.announce(reply.error);
      return;
    }
    this.context = reply.data;

    // The reference (`renderHead`'s title) comes from `this.context` alone -
    // see the header comment - and was otherwise stuck blank in the toolbar
    // until the next unrelated re-render (e.g. the first submitted answer),
    // since nothing here used to touch the head once context arrived. Safe
    // to redraw regardless of `interacted`: unlike `renderContext` below, it
    // never touches the exercise inputs the user may already be typing into.
    this.renderHead();
    if (this.interacted) return;

    this.renderContext();
    this.restoreExerciseFocus();
  }

  /**
   * Puts the caret back after the passage has been rebuilt underneath it.
   *
   * Only reached on an untouched step, so "back" means the first slot - there
   * is no position to preserve, but there is a focus to not lose.
   */
  private restoreExerciseFocus(): void {
    focusQuietly(this.contextEl.querySelector<HTMLInputElement>('.sm-blank, .sm-fl'));
  }

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  private render(): void {
    this.renderHead();
    this.renderContext();
    this.renderExercise();
  }

  private renderHead(): void {
    const step = this.session.step;
    const reference = this.context?.reference ?? '';

    replace(this.headEl, [
      breadcrumb({
        crumbs: [
          {
            label: 'Home',
            // Leaving mid-exercise is not "ending" anything any more: the
            // resume point is written to disk after every verse (see
            // `main.ts`), so going back genuinely does what task 0004 asked
            // for - "a way to go back from an activity to the passage" that
            // picks up later. `endSession` (not a plain `goPlan`) is what
            // saves that resume point and returns to `returnTo` - the plan or
            // the passage screen, whichever this session was started from.
            onClick: () => void this.endSession(),
          },
          // The activity itself (blanks, ordering, ...) is deliberately not a
          // third crumb - it is the selected tab below, and the design doc
          // asks that the activity name not be duplicated beside it.
          { label: reference },
        ],
        actions: step !== null ? [el('span', { class: 'sm-crumbs-meta', text: formatStepProgress(step.stepNumber, step.totalSteps) })] : [],
      }),
      el('div', { class: 'sm-practice-sub' }, [
        el('span', { class: 'sm-practice-rung', text: RUNG_LABEL[this.session.rung] }),
      ]),
      step !== null
        ? el('div', { class: 'sm-practice-progress' }, [
            el(
              'div',
              {
                class: 'sm-bar sm-bar-slim',
                attrs: {
                  role: 'progressbar',
                  'aria-valuemin': '0',
                  'aria-valuemax': String(Math.max(step.totalSteps, step.stepNumber)),
                  'aria-valuenow': String(step.stepNumber),
                },
              },
              [
                el('div', {
                  class: 'sm-bar-fill',
                  style: {
                    width: `${stepFraction(step.stepNumber, step.totalSteps) * 100}%`,
                  },
                }),
              ],
            ),
            el('span', {
              class: 'sm-step-tally',
              text: `${this.session.correctFirst} right first time`,
            }),
          ])
        : null,
    ]);
  }

  /**
   * Draws the scripture above the exercise.
   *
   * What counts as safe context depends entirely on the step, because for two
   * of the four kinds the surrounding text *is* the answer:
   *
   *   - ordering  - only the verses already placed. `PassageContext.verses`
   *     holds the whole passage including the one being guessed, so rendering
   *     it would print the answer directly above the picker.
   *   - refmatch  - the verse alone, and without its chapter:verse label,
   *     which would otherwise answer the question in the margin.
   *   - blanks / firstletters - the real passage, with the working verse
   *     highlighted. Here the surrounding verses give away nothing and are
   *     exactly the context that makes the exercise worth doing.
   *
   * `PassageContext.after` is empty during an exercise by design. Nothing is
   * rendered for it - no placeholder, no ellipsis, no empty bordered box that
   * reads as a failure to load.
   */
  private renderContext(): void {
    clear(this.contextEl);
    // The measurement list points at nodes that have just been discarded.
    // Left in place it would size elements that are no longer in the document,
    // which is harmless but hides real bugs behind writes that go nowhere.
    this.measured = [];
    this.interacted = false;
    const step = this.session.step;

    if (step === null) {
      this.contextEl.hidden = true;
      return;
    }
    this.contextEl.hidden = false;

    const before = this.context?.before ?? [];

    switch (step.kind) {
      case 'ordering':
        append(this.contextEl, renderPassage(before, () => ({ muted: true })));
        if (step.placed.length === 0 && before.length === 0) {
          this.contextEl.appendChild(
            el('p', {
              class: 'sm-context-note',
              text: 'Start of the passage.',
            }),
          );
        }
        append(this.contextEl, renderPassage(step.placed, () => ({})));
        break;

      case 'refmatch':
        // No `before`, no label: both would identify the verse.
        append(
          this.contextEl,
          renderPassage([step.verse], () => ({ current: true, showLabel: false })),
        );
        break;

      case 'blanks':
      case 'firstletters':
        append(this.contextEl, renderPassage(before, () => ({ muted: true })));
        append(this.contextEl, this.renderWorkingPassage(step));
        break;

      default:
        break;
    }

    this.applyMeasuredWidths();
  }

  /**
   * The passage with one verse made interactive.
   *
   * The interactive verse is rendered in its place inside the passage, not
   * lifted out of it. `verses` comes from the context when we have it and
   * falls back to the single verse the step carries, so the exercise is
   * playable in the window before the context request returns.
   */
  private renderWorkingPassage(step: BlanksStep | FirstLettersStep): HTMLElement[] {
    const verses = this.context?.verses ?? [step.verse];
    const target = step.verse.verseId;
    const hidden = hiddenIndicesFor(step);
    const onAllResolved =
      step.answerMode === 'firstLetter'
        ? () => void this.submitHidden(step)
        : undefined;
    const renderWord = this.buildHiddenWordRenderer(hidden, step.answerMode, onAllResolved);

    return renderPassage(
      // Substituting the step's copy of the verse for the context's copy means
      // the word indices the exercise uses always match the words on screen,
      // even if the two arrived from different queries.
      verses.map((v) => (v.verseId === target ? step.verse : v)),
      (verse) =>
        verse.verseId === target
          ? { current: true, renderWord }
          : {},
    );
  }

  private renderExercise(): void {
    clear(this.exerciseEl);
    clear(this.actionsEl);
    this.setFeedback(null);

    if (this.summary !== null && this.session.step === null) {
      this.renderSummary(this.summary);
      return;
    }

    const step = this.session.step;
    if (step === null) {
      this.exerciseEl.appendChild(
        el('p', { class: 'sm-prompt', text: 'Nothing left to do in this session.' }),
      );
      this.actionsEl.appendChild(
        button('Done', () => void this.endSession(), { class: 'sm-btn sm-btn-primary' }),
      );
      return;
    }

    switch (step.kind) {
      case 'ordering':
        this.renderOrdering(step);
        return;
      case 'refmatch':
        this.renderRefMatch(step);
        return;
      case 'blanks':
        this.renderBlanks(step);
        return;
      case 'firstletters':
        this.renderFirstLetters(step);
        return;
      default:
        return;
    }
  }

  // -------------------------------------------------------------------------
  // ordering - the next-verse picker
  // -------------------------------------------------------------------------

  /**
   * Candidates as previews of real text, chosen with one click or one Enter.
   *
   * No submit button. The user has made a choice the moment they press a
   * candidate, and an extra "confirm" step buys nothing except a second place
   * to lose your keyboard focus.
   */
  private renderOrdering(step: OrderingStep): void {
    // The first pick is a real choice now (see `session.ts#prepareStep`), so
    // it gets its own prompt rather than one that presupposes an answer
    // already given.
    const isFirstPick = step.placed.length === 0;
    const prompt = isFirstPick ? 'Which verse comes first?' : 'Which verse comes next?';
    this.exerciseEl.appendChild(el('h2', { class: 'sm-prompt', text: prompt }));

    const list = el('ul', {
      class: 'sm-choices',
      attrs: { 'aria-label': isFirstPick ? 'Choose the first verse' : 'Choose the next verse' },
    });

    const buttons: HTMLButtonElement[] = [];

    step.candidates.forEach((candidate, index) => {
      const choice = el('button', {
        class: 'sm-choice',
        attrs: { 'data-verse-id': String(candidate.verseId) },
      });
      choice.type = 'button';
      append(choice, [
        // The number is the same one a user presses to pick this card - see
        // `attachListKeys` - so it is part of the button's own accessible
        // name, not decorative.
        el('span', { class: 'sm-choice-key', text: String(index + 1) }),
        // The truncation mark is folded straight into the text rather than
        // drawn as a trailing sibling element. A sibling span sits outside the
        // text's own line flow, so on a preview that wraps it can land at the
        // top-right corner of the button looking like an unrelated control -
        // exactly the "faint dots, like a menu?" the task 0004 review flagged.
        el('span', {
          class: 'sm-choice-text',
          text: candidate.truncated ? `${candidate.preview}…` : candidate.preview,
        }),
        el('span', { class: 'sm-choice-mark', attrs: { 'aria-hidden': 'true' } }),
      ]);
      choice.addEventListener('click', () => void this.pickOrdering(step, candidate.verseId, choice));
      buttons.push(choice);
      list.appendChild(el('li', {}, [choice]));
    });

    // Buttons are already reachable with Tab; arrows are added on top because
    // in a list of four or five options Tab is a poor fit - it walks out of the
    // group at the end instead of wrapping, and there is no way back but
    // Shift+Tab. Roving arrows make the group behave like the list it looks
    // like, and Home/End reach the extremes. The number printed on each card
    // (`sm-choice-key`) is also a shortcut: pressing it picks that card
    // directly, without walking the list first.
    attachListKeys(list, buttons);

    this.exerciseEl.appendChild(list);

    // Focus the first card as soon as the step renders. Without this the
    // number/arrow shortcuts above do nothing at all on a fresh step - a
    // keydown only reaches `list`'s listener once focus is somewhere inside
    // it - which is exactly the bug this exists to fix: the visible number on
    // each card implied a shortcut that, with nothing ever focused, could
    // never fire.
    focusQuietly(buttons[0] ?? null);
  }

  private async pickOrdering(
    step: OrderingStep,
    verseId: number,
    choice: HTMLButtonElement,
  ): Promise<void> {
    if (this.busy) return;
    this.busy = true;

    const reply = await this.submit({ kind: 'ordering', verseId });
    if (this.disposed) return;
    this.busy = false;
    if (reply === null) return;

    const { result } = reply;

    if (result.correct) {
      choice.classList.add('sm-choice-correct');
      this.setFeedback('Yes.', 'good');
      // A short pause before the next step so the confirmation is actually
      // seen. Without it the screen changes at the same instant as the click
      // and the user cannot tell whether they were right or the picker simply
      // moved on.
      this.after(CORRECT_FLASH_MS, () => this.advance());
      return;
    }

    // Wrong, and the picker blocks. The DOM is deliberately NOT re-rendered
    // here: re-rendering would replace the very button the mark is on, which
    // is the one piece of information the mark exists to carry.
    choice.classList.add('sm-choice-wrong');
    this.setFeedback('Not that one. Try again.', 'bad');

    this.after(WRONG_MARK_MS, () => {
      choice.classList.remove('sm-choice-wrong');
      this.setFeedback(null);
      // If the retried step is not the same set of candidates after all, the
      // displayed list is stale and has to be rebuilt. Normally it is
      // identical and nothing happens.
      const next = this.session.step;
      if (next !== null && next.kind === 'ordering' && !sameCandidates(step, next)) {
        this.renderAfterStepChange();
      } else {
        focusQuietly(choice);
      }
    });
  }

  // -------------------------------------------------------------------------
  // refmatch - which reference is this?
  // -------------------------------------------------------------------------

  private renderRefMatch(step: RefMatchStep): void {
    this.exerciseEl.appendChild(
      el('h2', { class: 'sm-prompt', text: 'Which reference is this?' }),
    );

    const list = el('ul', {
      class: 'sm-choices sm-choices-compact',
      attrs: { 'aria-label': 'Choose the reference' },
    });
    const buttons: HTMLButtonElement[] = [];

    step.candidates.forEach((candidate) => {
      const choice = el('button', { class: 'sm-choice' });
      choice.type = 'button';
      append(choice, [
        el('span', { class: 'sm-choice-text', text: candidate.reference }),
        el('span', { class: 'sm-choice-mark', attrs: { 'aria-hidden': 'true' } }),
      ]);
      choice.addEventListener('click', () =>
        void this.pickRefMatch(candidate.passageId, choice),
      );
      buttons.push(choice);
      list.appendChild(el('li', {}, [choice]));
    });

    attachListKeys(list, buttons);
    this.exerciseEl.appendChild(list);
  }

  private async pickRefMatch(passageId: number, choice: HTMLButtonElement): Promise<void> {
    if (this.busy) return;
    this.busy = true;

    const reply = await this.submit({ kind: 'refmatch', passageId });
    if (this.disposed) return;
    this.busy = false;
    if (reply === null) return;

    if (reply.result.correct) {
      choice.classList.add('sm-choice-correct');
      this.setFeedback('Yes.', 'good');
      this.after(CORRECT_FLASH_MS, () => this.advance());
      return;
    }

    choice.classList.add('sm-choice-wrong');
    this.setFeedback('Not that one. Try again.', 'bad');
    this.after(WRONG_MARK_MS, () => {
      choice.classList.remove('sm-choice-wrong');
      this.setFeedback(null);
      focusQuietly(choice);
    });
  }

  // -------------------------------------------------------------------------
  // blanks / firstletters - one hidden-word mechanic, per `Step.answerMode`
  // -------------------------------------------------------------------------

  /** Every element whose width is measured, paired with the text to measure. */
  private measured: { node: HTMLElement; text: string }[] = [];

  /** Answers gathered so far, indexed by `verse.words` position (both modes). */
  private hiddenAnswers: string[] = [];
  /** How many hidden slots are still unresolved, in `firstLetter` mode. */
  private hiddenPending = 0;
  /** Live `<input>` elements, in ascending word-index order, in `fullWord` mode. */
  private hiddenInputs: HTMLInputElement[] = [];

  /**
   * Builds the per-word renderer shared by `blanks` and `firstletters`.
   *
   * `hidden` is the set of word indices this step hid - a subset for
   * `blanks`, every index for `firstletters`. `onAllResolved` is provided only
   * in `firstLetter` mode, where there is no Check button: the step submits
   * itself the instant the last hidden word is decided.
   */
  private buildHiddenWordRenderer(
    hidden: HiddenWords,
    answerMode: AnswerMode,
    onAllResolved: (() => void) | undefined,
  ): WordRenderer {
    const hiddenSet = new Set(hidden.hiddenIndices);
    this.hiddenAnswers = [];
    this.hiddenPending = hidden.hiddenIndices.length;
    this.hiddenInputs = [];
    this.measured = [];

    return (word, index) => {
      if (!hiddenSet.has(index)) {
        this.hiddenAnswers[index] = word;
        return plainWord(word);
      }

      // A token with no letters or digits at all - a lone dash, a stray
      // bracket - has no initial to ask for and nothing to type. Printing it
      // outright is better than presenting a box that cannot be answered.
      if (word.trim() === '' || firstLetterMissing(word)) {
        this.hiddenAnswers[index] = word;
        this.hiddenPending -= 1;
        return plainWord(word);
      }

      const position = hidden.hiddenIndices.indexOf(index);
      const label = `Missing word ${position + 1} of ${hidden.hiddenIndices.length}`;

      if (answerMode === 'firstLetter') {
        const input = el('input', {
          class: 'sm-fl',
          type: 'text',
          attrs: {
            maxlength: '1',
            autocomplete: 'off',
            autocapitalize: 'off',
            autocorrect: 'off',
            spellcheck: 'false',
            'aria-label': label,
            'data-word-index': String(index),
          },
          // Deliberately no `placeholder`: v0 showed the initial here, which
          // made this a copy exercise rather than a recall one - see the file
          // header and the task 0004 review, point 1. The box stays empty
          // until the user types into it.
        });
        this.measured.push({ node: input, text: word });

        input.addEventListener('input', () => {
          this.interacted = true;
          if (input.value === '') return;
          const correct = matchesFirstLetter(input.value, word);
          this.hiddenAnswers[index] = correct ? word : input.value;
          const next = nextSlotAfter(input);
          input.replaceWith(correct ? correctWord(word, index) : missedWord(word, input.value));
          this.hiddenPending -= 1;
          this.setFeedback(correct ? null : `Missed: ${word}`, 'bad');
          if (this.hiddenPending > 0) {
            focusQuietly(next);
            return;
          }
          onAllResolved?.();
        });
        input.addEventListener('keydown', (ev) => {
          // Enter with nothing typed skips forward rather than submitting an
          // empty answer for a word the user is still thinking about.
          if (ev.key === 'Enter' && input.value === '') {
            ev.preventDefault();
            focusQuietly(nextSlotAfter(input));
          }
        });
        return input;
      }

      // `fullWord`: a normal text box, confirmed by the Check button.
      const input = el('input', {
        class: 'sm-blank',
        type: 'text',
        attrs: {
          autocomplete: 'off',
          autocapitalize: 'off',
          autocorrect: 'off',
          spellcheck: 'false',
          enterkeyhint: 'next',
          'aria-label': label,
          'data-word-index': String(index),
        },
      });
      this.measured.push({ node: input, text: word });
      this.hiddenInputs.push(input);

      input.addEventListener('input', () => {
        this.interacted = true;
        this.growBlank(input, word);
      });
      input.addEventListener('keydown', (ev) => this.onFullWordKey(ev, input));
      return input;
    };
  }

  private renderBlanks(step: BlanksStep): void {
    const count = step.blankIndices.length;
    this.exerciseEl.appendChild(
      el('h2', {
        class: 'sm-prompt',
        text:
          step.answerMode === 'firstLetter'
            ? `Type the first letter of each missing ${count === 1 ? 'word' : 'word'}.`
            : `Type the missing ${count === 1 ? 'word' : 'words'} in the highlighted verse.`,
      }),
    );

    if (step.answerMode === 'firstLetter') {
      this.exerciseEl.appendChild(
        el('p', {
          class: 'sm-hint',
          text: 'A correct letter reveals the word and moves on.',
        }),
      );
      focusQuietly(this.contextEl.querySelector<HTMLInputElement>('.sm-fl'));
      return;
    }

    this.exerciseEl.appendChild(
      el('p', {
        class: 'sm-hint',
        text: 'Enter moves to the next blank; Enter on the last one checks your answer.',
      }),
    );
    this.actionsEl.appendChild(
      button('Check', () => void this.submitHidden(step), { class: 'sm-btn sm-btn-primary' }),
    );
    focusQuietly(this.hiddenInputs[0] ?? null);
  }

  private renderFirstLetters(step: FirstLettersStep): void {
    if (step.answerMode === 'firstLetter') {
      this.exerciseEl.appendChild(
        el('h2', {
          class: 'sm-prompt',
          text: `Type the first letter of each word (${step.verse.words.length} in this verse).`,
        }),
      );
      this.exerciseEl.appendChild(
        el('p', {
          class: 'sm-hint',
          text: 'A correct letter reveals the whole word. There is one attempt per word.',
        }),
      );
      focusQuietly(this.contextEl.querySelector<HTMLInputElement>('.sm-fl'));
      return;
    }

    this.exerciseEl.appendChild(
      el('h2', {
        class: 'sm-prompt',
        text: `Type every word in the verse (${step.verse.words.length} words).`,
      }),
    );
    this.exerciseEl.appendChild(
      el('p', {
        class: 'sm-hint',
        text: 'Enter moves to the next word; Enter on the last one checks your answer.',
      }),
    );
    this.actionsEl.appendChild(
      button('Check', () => void this.submitHidden(step), { class: 'sm-btn sm-btn-primary' }),
    );
    focusQuietly(this.hiddenInputs[0] ?? null);
  }

  /**
   * Enter walks the full-word inputs; Enter on the last one submits.
   *
   * Tab already does the walking, so this is not the only way through - it is
   * the way that does not require the user to know that a passage full of
   * inline inputs is a tab sequence. Shift+Enter goes back for symmetry.
   */
  private onFullWordKey(ev: KeyboardEvent, input: HTMLInputElement): void {
    if (ev.key !== 'Enter') return;
    ev.preventDefault();

    const index = this.hiddenInputs.indexOf(input);
    const step = this.session.step;
    if (index < 0 || step === null || (step.kind !== 'blanks' && step.kind !== 'firstletters')) return;

    if (ev.shiftKey) {
      focusQuietly(this.hiddenInputs[index - 1] ?? input);
      return;
    }
    const next = this.hiddenInputs[index + 1];
    if (next) {
      focusQuietly(next);
      return;
    }
    void this.submitHidden(step);
  }

  /**
   * Grows an input that has been overtyped past the width of its word.
   *
   * Only ever grows, and only this input: `blankWidthFor` is a max against the
   * word's own measured width, so backspacing does not shrink the box back and
   * shuffle the line about while the user is still typing in it.
   */
  private growBlank(input: HTMLInputElement, word: string): void {
    const wanted = Math.max(
      this.host.measurer.blankWidth(word),
      this.host.measurer.blankWidth(input.value),
    );
    const current = Number.parseFloat(input.style.width) || 0;
    if (wanted > current) input.style.width = `${wanted}px`;
  }

  /**
   * Submits a hidden-word step, in either answer mode.
   *
   * In `fullWord` mode this is called from the Check button; in `firstLetter`
   * mode it is called automatically once every slot has resolved, and by then
   * `this.hiddenAnswers` is already complete because each slot writes into it
   * as it resolves.
   */
  private async submitHidden(step: BlanksStep | FirstLettersStep): Promise<void> {
    if (this.busy) return;
    this.busy = true;

    if (step.answerMode === 'fullWord') {
      for (const input of this.hiddenInputs) {
        const index = Number(input.dataset['wordIndex']);
        this.hiddenAnswers[index] = input.value.trim();
      }
    }

    const hidden = hiddenIndicesFor(step);
    const words =
      step.kind === 'blanks'
        ? step.blankIndices.map((i) => this.hiddenAnswers[i] ?? '')
        : step.verse.words.map((_, i) => this.hiddenAnswers[i] ?? '');

    const reply = await this.submit(
      step.kind === 'blanks' ? { kind: 'blanks', words } : { kind: 'firstletters', words },
    );
    if (this.disposed) return;
    this.busy = false;
    if (reply === null) return;

    const wrong = resolveWrongPositions(reply.result, hidden.hiddenIndices);

    if (step.answerMode === 'fullWord') {
      // Live `<input>`s are still on screen; replace each with its verdict.
      this.hiddenInputs.forEach((input, position) => {
        const wordIndex = hidden.hiddenIndices[position] ?? -1;
        const answer = revealedWord(reply.result, hidden, position, wordIndex, step.verse.words);
        const typed = input.value.trim();
        const missed = wrong.has(position);
        input.replaceWith(missed ? missedWord(answer, typed) : correctWord(answer, wordIndex));
      });
      this.hiddenInputs = [];
    } else {
      // `firstLetter` mode already replaced every slot as it resolved. The
      // worker's verdict is authoritative even where the panel already drew a
      // conclusion: if it marks a word wrong that the local first-letter check
      // accepted - a homograph, a normalisation difference - the display is
      // corrected to agree with the score the user is about to be given.
      wrong.forEach((position) => {
        const wordIndex = hidden.hiddenIndices[position] ?? -1;
        const node = this.contextEl.querySelector<HTMLElement>(
          `.sm-word-ok[data-word-index="${wordIndex}"]`,
        );
        const word = step.verse.words[wordIndex];
        if (node && word !== undefined) {
          node.replaceWith(missedWord(word, this.hiddenAnswers[wordIndex] ?? ''));
        }
      });
    }

    this.reportTyped(wrong.size, hidden.hiddenIndices.length, reply.summary);
  }

  // -------------------------------------------------------------------------
  // Shared submit / advance machinery
  // -------------------------------------------------------------------------

  private async submit(
    answer: StepAnswer,
  ): Promise<{ result: StepResult; summary: SessionSummary | null } | null> {
    // Covers the two pickers, whose only interaction is the click that submits.
    // A late-arriving context must not rebuild the list out from under a mark
    // that is currently showing which candidate was wrong.
    this.interacted = true;

    const reply = await this.host.request({
      type: 'submitStep',
      sessionId: this.session.sessionId,
      answer,
    });
    if (this.disposed) return null;

    if (!reply.ok) {
      replace(this.feedbackEl, [errorBanner(reply.error)]);
      return null;
    }

    this.session = reply.data.session;
    this.summary = reply.data.summary;
    this.renderHead();
    return { result: reply.data.result, summary: reply.data.summary };
  }

  /**
   * The verdict line for a typed exercise, plus the button that moves on.
   *
   * Typed steps do not auto-advance the way the picker does. The user has just
   * been shown which words they missed, in place, inside the verse - taking
   * that away after a fixed delay would be taking away the only part of the
   * exercise that teaches anything.
   */
  private reportTyped(missed: number, total: number, summary: SessionSummary | null): void {
    const right = Math.max(0, total - missed);
    this.setFeedback(
      missed === 0 ? `All ${total} correct.` : `${right} of ${total} correct.`,
      missed === 0 ? 'good' : 'bad',
    );

    clear(this.actionsEl);
    const label = summary !== null ? 'Finish' : 'Next';
    const next = button(
      label,
      () => {
        if (summary !== null) {
          this.renderExercise();
          return;
        }
        this.advance();
      },
      { class: 'sm-btn sm-btn-primary' },
    );
    this.actionsEl.appendChild(next);
    focusQuietly(next);
  }

  /** Draws whatever the session now says the current step is. */
  private advance(): void {
    if (this.disposed) return;
    this.renderAfterStepChange();
  }

  private renderAfterStepChange(): void {
    this.renderHead();
    this.renderContext();
    this.renderExercise();
  }

  private renderSummary(summary: SessionSummary): void {
    this.contextEl.hidden = true;

    this.exerciseEl.appendChild(
      el('div', { class: 'sm-summary' }, [
        el('h2', { class: 'sm-summary-title', text: `${RUNG_LABEL[summary.rung]} — done` }),
        el('div', { class: 'sm-summary-level' }, [
          levelBoxes(summary.level),
          el('span', { class: 'sm-summary-level-text', text: `${summary.level}/5` }),
        ]),
        el('p', {
          class: 'sm-summary-detail',
          text: `${summary.correctFirst} of ${summary.totalSteps} right first time (${formatScore(summary.score)}).`,
        }),
        summary.passageWellLearned
          ? el('p', { class: 'sm-summary-good', text: 'This passage is well learned.' })
          : null,
        el('p', {
          class: 'sm-summary-detail',
          text:
            summary.nextDueAt !== null
              ? `Next review ${new Date(summary.nextDueAt).toLocaleDateString()}.`
              : 'No further review scheduled.',
        }),
      ]),
    );

    this.actionsEl.appendChild(
      button('Done', () => void this.endSession(), { class: 'sm-btn sm-btn-primary' }),
    );
    this.actionsEl.appendChild(
      button(
        'Practice again',
        () => void this.host.startSession(this.session.passageId, this.session.rung),
        { class: 'sm-btn' },
      ),
    );
    // The wider plan can hold far more than one screenful of passages (task
    // 0004's review raised a plan of 250 individual verses); this is the
    // "just keep going" path so the user is never forced back through the
    // plan list to find whatever else is due.
    this.actionsEl.appendChild(
      button('Next due', () => void this.startNextDue(), { class: 'sm-btn sm-btn-quiet' }),
    );
  }

  private async startNextDue(): Promise<void> {
    const reply = await this.host.request({ type: 'getPlan' });
    if (this.disposed) return;
    if (!reply.ok) {
      this.host.announce(reply.error);
      return;
    }
    const target = pickDueTarget(reply.data, this.host.now());
    if (!target) {
      this.host.announce('Nothing else is due right now.');
      void this.endSession();
      return;
    }
    void this.host.startSession(target.passageId, target.rung);
  }

  private async endSession(): Promise<void> {
    // The reply is not inspected: the user pressed Back, and the screen has to
    // change whether or not the worker had a summary to give. A failure here
    // is announced rather than trapping them in a session that is already over
    // as far as they are concerned. Progress up to the last completed verse is
    // already saved - see `main.ts#submitStep` - so this does not lose work.
    const reply = await this.host.request({
      type: 'endSession',
      sessionId: this.session.sessionId,
    });
    if (this.disposed) return;
    if (!reply.ok) this.host.announce(reply.error);
    this.host.go({ type: 'sessionEnded' });
  }

  // -------------------------------------------------------------------------
  // Measurement and feedback plumbing
  // -------------------------------------------------------------------------

  /**
   * Sizes every input to its word, in the font the passage is actually drawn
   * in.
   *
   * Runs after the passage is in the document, and adopts the font from the
   * highlighted verse rather than from `document.body`: the scripture face and
   * size come from the host's `--bible-font-*` tokens and are nothing like the
   * panel chrome's, so a measurement taken in the UI font would be wrong for
   * every hidden word by the same misleading-looking constant.
   */
  private applyMeasuredWidths(): void {
    if (this.measured.length === 0) return;

    const source =
      this.contextEl.querySelector<HTMLElement>('.sm-verse-current') ?? this.contextEl;
    this.host.measurer.adoptFontFrom(source);

    for (const { node, text } of this.measured) {
      node.style.width = `${this.host.measurer.blankWidth(text)}px`;
    }
  }

  private setFeedback(message: string | null, tone: 'good' | 'bad' = 'good'): void {
    clear(this.feedbackEl);
    this.feedbackEl.className = `sm-feedback${message === null ? '' : ` sm-feedback-${tone}`}`;
    if (message === null) return;
    append(this.feedbackEl, [
      tone === 'bad'
        ? el('span', { class: 'sm-mark sm-mark-bad', text: '✗', attrs: { 'aria-hidden': 'true' } })
        : null,
      textNode(message),
    ]);
  }

  /** A cancellable timeout that is cleaned up if the view goes away first. */
  private after(ms: number, fn: () => void): void {
    const id = window.setTimeout(() => {
      this.timers.delete(id);
      if (!this.disposed) fn();
    }, ms);
    this.timers.add(id);
  }
}

// ---------------------------------------------------------------------------
// Free functions
// ---------------------------------------------------------------------------

function stepFraction(stepNumber: number, totalSteps: number): number {
  if (totalSteps <= 0) return 0;
  return Math.max(0, Math.min(1, (stepNumber - 1) / totalSteps));
}

function firstLetterMissing(word: string): boolean {
  return word.replace(/[^\p{L}\p{N}]/gu, '') === '';
}

/** Which word indices a `blanks` or `firstletters` step hid, and the verse's length. */
function hiddenIndicesFor(step: BlanksStep | FirstLettersStep): HiddenWords {
  return step.kind === 'blanks'
    ? { verseWordCount: step.verse.words.length, hiddenIndices: step.blankIndices }
    : {
        verseWordCount: step.verse.words.length,
        hiddenIndices: step.verse.words.map((_, i) => i),
      };
}

function sameCandidates(a: OrderingStep, b: OrderingStep): boolean {
  if (a.candidates.length !== b.candidates.length) return false;
  return a.candidates.every((c, i) => c.verseId === b.candidates[i]?.verseId);
}

/**
 * A correct word, put back into the passage.
 *
 * `data-word-index` is carried so a later correction from the worker can find
 * the node again - see `submitHidden`.
 */
function correctWord(word: string, wordIndex?: number): HTMLElement {
  return el('span', {
    class: 'sm-word sm-word-ok',
    text: word,
    attrs: wordIndex === undefined ? {} : { 'data-word-index': String(wordIndex) },
  });
}

/**
 * A missed word: the right words in the passage, the wrong answer beside them.
 *
 * The verse itself is left intact and readable. What is marked is the *answer*
 * - red, with a ✗ - and it sits next to the word rather than on top of it.
 * There is no strike-through anywhere in this panel, on scripture or on
 * anything else; it was ruled out and it is not a style choice that gets
 * quietly reintroduced by a later tweak.
 */
function missedWord(answer: string, typed: string): HTMLElement {
  const shown = typed.trim();
  return el('span', { class: 'sm-word sm-word-missed' }, [
    el('span', { class: 'sm-word-answer', text: answer }),
    el('span', { class: 'sm-word-wrong' }, [
      // The ✗ is hidden from assistive tech and replaced by words. Read aloud,
      // a bare cross is either skipped or announced as "multiplication sign",
      // and the sighted reading - "here is the answer, here is what you put" -
      // has to be reconstructed in language for anyone not seeing the colour.
      el('span', { class: 'sm-mark sm-mark-bad', text: '✗', attrs: { 'aria-hidden': 'true' } }),
      shown === ''
        ? el('span', { class: 'sm-sr-only', text: '(missed)' })
        : el('span', { class: 'sm-sr-only', text: '(missed, you typed' }),
      shown === '' ? null : el('span', { class: 'sm-word-typed', text: shown }),
      shown === '' ? null : el('span', { class: 'sm-sr-only', text: ')' }),
    ]),
  ]);
}

/** The next unanswered slot after `input`, if there is one. */
function nextSlotAfter(input: HTMLInputElement): HTMLInputElement | null {
  const root = input.closest('.sm-context') ?? input.ownerDocument.body;
  const slots = Array.from(root.querySelectorAll<HTMLInputElement>('.sm-fl, .sm-blank'));
  const index = slots.indexOf(input);
  return index >= 0 ? (slots[index + 1] ?? null) : null;
}

/**
 * Arrow-key navigation over a group of buttons.
 *
 * The picker has to be fully operable without a mouse, and Tab alone is a
 * clumsy way to move inside a list of options: it never wraps, and it walks
 * straight out of the group past the last item. Up/Down (and Left/Right, since
 * the list is a single column that becomes a row on a wide pane) move within
 * the group and wrap; Home and End jump to the ends.
 */
function attachListKeys(list: HTMLElement, buttons: HTMLButtonElement[]): void {
  if (buttons.length === 0) return;

  list.addEventListener('keydown', (ev) => {
    // The number printed on each card (`sm-choice-key`) picks it outright -
    // the same as a click, not just a focus move - so it works the instant
    // the step renders. Checked before the roving-focus keys below and
    // independent of which button currently has focus.
    const digit = /^[1-9]$/.exec(ev.key)?.[0];
    if (digit !== undefined) {
      const picked = buttons[Number(digit) - 1];
      if (picked && !picked.disabled) {
        ev.preventDefault();
        picked.click();
      }
      return;
    }

    const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (current < 0) return;

    let target = -1;
    switch (ev.key) {
      case 'ArrowDown':
      case 'ArrowRight':
        target = (current + 1) % buttons.length;
        break;
      case 'ArrowUp':
      case 'ArrowLeft':
        target = (current - 1 + buttons.length) % buttons.length;
        break;
      case 'Home':
        target = 0;
        break;
      case 'End':
        target = buttons.length - 1;
        break;
      default:
        return;
    }

    ev.preventDefault();
    focusQuietly(buttons[target] ?? null);
  });
}
