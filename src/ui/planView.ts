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

import type { Passage, PassageView, PlanView } from '../types';
import { append, button, el, focusQuietly, replace } from './dom';
import { activitySquares, breadcrumb, dueBadge, emptyState, errorBanner } from './components';
import { RUNG_LABEL, countLabel, pickStartTarget } from './format';
import { dropContainedRanges, extractReferenceCandidates } from './referenceInput';
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
      actions: [
        button('Analytics', () => host.go({ type: 'goAnalytics' }), { class: 'sm-btn sm-btn-quiet sm-btn-small' }),
        button('Settings', () => host.go({ type: 'goSettings' }), { class: 'sm-btn sm-btn-quiet sm-btn-small' }),
      ],
    }),
  );

  root.appendChild(renderStartPracticing(host, plan, now));
  root.appendChild(renderAddPassage(host));

  if (plan.passages.length === 0) {
    root.appendChild(
      emptyState(
        'Nothing in your plan yet.',
        'Add a reference above - a single verse, or a range like "Psalm 1:1-6" - and its activities will be built for you.',
      ),
    );
    return root;
  }

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
      el('p', { class: 'sm-callout-text', text: 'Add a verse below to get started.' }),
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
// Adding a passage
// ---------------------------------------------------------------------------

/**
 * The add-passage field.
 *
 * The error slot below the field is populated with whatever the worker said,
 * verbatim. A reference that does not parse is the ordinary case here, not an
 * exceptional one - "Jn 3.16", "1 Jn 1", "Psalm 151" - and the worker's own
 * message is the only thing that can say which of those went wrong. Replacing
 * it with a generic "Could not add passage" would be throwing away the only
 * useful information in the reply.
 *
 * A `<form>` rather than an input plus a click handler, because a form gives
 * Enter-to-submit and a properly associated label for nothing. The panel CSP
 * sets `form-action 'none'`, so the submit is inert beyond the handler below -
 * which is what we want, since the handler always calls `preventDefault`.
 *
 * **Pasting several references at once.** Task 0004's review pointed out that
 * a plan can hold far more passages than anyone will type in one at a time,
 * and asked for the smallest fix: paste a list, one reference per line. The
 * field stays a single-line input - Enter still adds one passage and gets out
 * of the way - but a paste is inspected before it lands in the field. More
 * than one candidate reference (see `referenceInput.ts#extractReferenceCandidates`)
 * is treated as a batch and never touches the input's value at all, so the
 * field never ends up holding a jumble of concatenated text.
 *
 * **Confirming a batch.** A follow-up review round asked that a pasted batch
 * be "auto-parsed and added in bulk (after confirmation)" rather than added
 * the instant the paste lands - a paste can carry far more than the intended
 * references (a whole verse list copied with a heading, say), and adding
 * every line unseen is the one place in this form that cannot be undone with
 * Ctrl+Z. So a multi-candidate paste shows the parsed list and waits for "Add
 * all" (or "Cancel") rather than calling the worker immediately.
 *
 * **Sprinkled references, and consolidating overlaps.** A further round asked
 * for two more things: pasting "lots of text with random verse references
 * sprinkled in" rather than a clean one-per-line list, and de-duplicating a
 * batch that names both a range and one of its own verses ("if John 3:16-17
 * is in there, John 3:16 separately should be ignored"). The first is
 * `extractReferenceCandidates`'s job; the second happens after every
 * candidate has been added, in `addReferences` below, since only the worker
 * knows each reference's real verse range.
 */
function renderAddPassage(host: PanelHost): HTMLElement {
  const input = el('input', {
    class: 'sm-input',
    id: 'sm-add-reference',
    type: 'text',
    placeholder: host.activeReference ?? 'e.g. Psalm 23:1-6',
    attrs: {
      autocomplete: 'off',
      autocapitalize: 'words',
      spellcheck: 'false',
      enterkeyhint: 'done',
    },
  }) as HTMLInputElement;

  // The error region is always in the DOM, empty, holding its own height. If
  // it were created on demand the whole list below would jump down a line the
  // moment a reference failed to parse - which is exactly when the user is
  // looking at something else on the screen.
  const errorSlot = el('div', {
    class: 'sm-error-slot',
    attrs: { 'aria-live': 'polite' },
  });

  const submit = el('button', { class: 'sm-btn', text: 'Add' }) as HTMLButtonElement;
  submit.type = 'submit';

  // Populated only while a pasted batch is awaiting "Add all" / "Cancel".
  // Kept outside the `<form>` so it survives independently of a submit or
  // reset the form might otherwise trigger.
  const batchConfirmSlot = el('div', { class: 'sm-batch-confirm-slot' });

  const form = el('form', { class: 'sm-add' }, [
    el('label', { class: 'sm-label', text: 'Add passage', attrs: { for: 'sm-add-reference' } }),
    el('div', { class: 'sm-add-row' }, [input, submit]),
    errorSlot,
    el('p', {
      class: 'sm-hint',
      text: 'Paste a list to add several at once - one reference per line.',
    }),
  ]) as HTMLFormElement;

  /**
   * Adds one or more references, in order, consolidates any that overlap
   * within this same batch, and reports the outcome.
   *
   * A single reference keeps the original wording ("Added John 3:16.") so the
   * common case reads exactly as it always has. A batch reports counts rather
   * than naming every passage - the plan list below is about to show them all
   * anyway - and any failures are listed individually, each with the worker's
   * own message, so a batch of twenty that missed one bad line does not force
   * a search for which one.
   */
  async function addReferences(references: string[]): Promise<void> {
    submit.disabled = true;
    input.disabled = true;
    replace(errorSlot, []);

    const addedPassages: Passage[] = [];
    const failed: { reference: string; error: string }[] = [];

    for (const reference of references) {
      // Sequential, not `Promise.all` - these become real database rows and a
      // race between them buys nothing while risking an interleaving no one
      // asked for.
      const reply = await host.request({ type: 'addPassage', reference });
      if (reply.ok) addedPassages.push(reply.data.passage);
      else failed.push({ reference, error: reply.error });
    }

    // Consolidate this batch's own overlaps ("if John 3:16-17 is in there,
    // John 3:16 separately should be ignored" - task 0004's review). A
    // passage id repeated in `addedPassages` (the same reference pasted
    // twice, or two spellings that resolved to the same range) is collapsed
    // to one entry first, so the range check below never mistakes "the same
    // row twice" for "one range containing another" and removes the passage
    // the user is trying to keep.
    const distinct = dedupeById(addedPassages);
    const { kept: survivors, dropped: subsumed } = dropContainedRanges(distinct);
    const kept = [...survivors];
    const dropped: Passage[] = [];
    for (const passage of subsumed) {
      // If removal itself fails - the passage disappeared already, a stray
      // storage error - it is left counted as kept rather than reported gone
      // while still sitting in the plan.
      const reply = await host.request({ type: 'removePassage', passageId: passage.id });
      if (reply.ok) dropped.push(passage);
      else kept.push(passage);
    }

    submit.disabled = false;
    input.disabled = false;

    const added = kept.map((p) => p.reference);

    if (added.length > 0) {
      input.value = '';
      const mergedNote =
        dropped.length > 0
          ? ` ${countLabel(dropped.length, 'reference')} already covered by another passage in this batch.`
          : '';
      host.announce(
        added.length === 1 && failed.length === 0 && dropped.length === 0
          ? `Added ${added[0]}.`
          : failed.length === 0
            ? `Added ${countLabel(added.length, 'passage')}.${mergedNote}`
            : `Added ${countLabel(added.length, 'passage')}; ${failed.length} failed.${mergedNote}`,
      );
      host.reload();
    }

    if (failed.length > 0) {
      replace(
        errorSlot,
        failed.map((f) => errorBanner(references.length === 1 ? f.error : `${f.reference}: ${f.error}`)),
      );
      focusQuietly(input);
    }
  }

  /**
   * Shows the parsed batch and waits for the user to confirm or cancel it,
   * rather than adding it the instant the paste lands.
   */
  function showBatchConfirm(lines: string[]): void {
    input.disabled = true;
    submit.disabled = true;

    const cancel = (): void => {
      replace(batchConfirmSlot, []);
      input.disabled = false;
      submit.disabled = false;
      focusQuietly(input);
    };

    replace(batchConfirmSlot, [
      el('div', { class: 'sm-batch-confirm', attrs: { role: 'alert' } }, [
        el('p', { class: 'sm-hint', text: `Add ${countLabel(lines.length, 'passage')}?` }),
        el(
          'ul',
          { class: 'sm-batch-list' },
          lines.map((line) => el('li', { class: 'sm-batch-list-item', text: line })),
        ),
        el('div', { class: 'sm-batch-actions' }, [
          button(
            `Add ${countLabel(lines.length, 'passage')}`,
            () => {
              replace(batchConfirmSlot, []);
              input.disabled = false;
              submit.disabled = false;
              void addReferences(lines);
            },
            { class: 'sm-btn sm-btn-primary sm-btn-small' },
          ),
          button('Cancel', cancel, { class: 'sm-btn sm-btn-small sm-btn-quiet' }),
        ]),
      ]),
    ]);
  }

  input.addEventListener('paste', (event: ClipboardEvent) => {
    const text = event.clipboardData?.getData('text/plain') ?? '';
    const candidates = extractReferenceCandidates(text);
    if (candidates.length > 1) {
      // More than one candidate - whether that is several lines, or several
      // references sprinkled through one line of prose - take over the paste
      // entirely rather than let the browser drop it into a single-line
      // field, which - depending on the browser - can silently strip
      // newlines and concatenate references into unparseable garbage. The
      // batch itself waits for confirmation (above) rather than going
      // straight to the worker.
      event.preventDefault();
      showBatchConfirm(candidates);
    }
  });

  form.addEventListener('submit', (event) => {
    event.preventDefault();

    const candidates = extractReferenceCandidates(input.value);
    // An empty field falls back to whatever the main window is showing. This
    // is why the worker pushes `activeVerse` at all: pressing Add with the
    // placeholder showing does the obvious thing.
    const references = candidates.length > 0 ? candidates : host.activeReference ? [host.activeReference.trim()] : [];
    if (references.length === 0) {
      replace(errorSlot, [errorBanner('Type a reference first, for example "John 3:16-18".')]);
      focusQuietly(input);
      return;
    }

    // Typed text can also name more than one reference ("John 3:16 and
    // Romans 8:28"); it gets the same confirm-first treatment as a pasted
    // batch rather than adding several passages on one Enter press unseen.
    if (references.length > 1) {
      showBatchConfirm(references);
      return;
    }

    void addReferences(references);
  });

  return el('div', { class: 'sm-add-wrapper' }, [form, batchConfirmSlot]);
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

// ---------------------------------------------------------------------------
// Batch add helpers
// ---------------------------------------------------------------------------

/**
 * Collapses a batch of `addPassage` replies to one entry per underlying
 * passage row, first occurrence wins.
 *
 * `store.addPassage` returns the *existing* row, unchanged, for an exact
 * repeat within the batch (the same reference pasted twice, or two spellings
 * that resolve to the same range) - so two entries in `passages` can be the
 * same row under two different array slots. Without this, `dropContainedRanges`
 * would see that "row" as containing itself and remove the very passage the
 * batch was trying to add, since a range check alone cannot tell "the same
 * passage twice" apart from "one range containing another".
 */
function dedupeById(passages: Passage[]): Passage[] {
  const byId = new Map<number, Passage>();
  for (const p of passages) {
    if (!byId.has(p.id)) byId.set(p.id, p);
  }
  return [...byId.values()];
}
