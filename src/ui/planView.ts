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

import type { Passage, PassageSortOrder, PassageView, PlanView } from '../types';
import { append, button, el, focusQuietly, replace } from './dom';
import { activitySquares, breadcrumb, dueBadge, emptyState, errorBanner, icon, menu, modal } from './components';
import { RUNG_LABEL, activityAvailability, countLabel, pickStartTarget, sortPassagesByNeed } from './format';
import { dropContainedRanges, extractReferenceCandidates } from './referenceInput';
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
  root.appendChild(renderAddPassage(host));

  if (plan.passages.length === 0) {
    // `format.ts#activityAvailability`'s own note: an empty plan replaces the
    // whole tile grid with this empty state, rather than showing six
    // disabled tiles beside it - the empty state already offers the one
    // thing to do next.
    root.appendChild(
      emptyState(
        'Nothing in your plan yet.',
        'Add a reference above - a single verse, or a range like "Psalm 1:1-6" - and its activities will be built for you.',
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
 * What `addReferences` reports back once every add (and any overlap
 * consolidation) has settled. Deliberately thin: it says only what happened,
 * not what a caller's own UI should do about it - see `addReferences`'s own
 * note for why.
 */
export interface AddReferencesOutcome {
  /** References that ended up added, after this batch's own overlap consolidation. Original wording, not the worker's. */
  added: string[];
  /** One entry per reference that failed, each with the worker's own message. */
  failed: { reference: string; error: string }[];
}

/**
 * Adds one or more references, in order, consolidates any that overlap within
 * this same batch, and announces + reloads on any success - the one code path
 * both the single-line field and the "add several at once" modal call, so the
 * overlap consolidation and the announced wording are the same regardless of
 * which UI a reference came in through (P3, lifted out of what was a closure
 * inside `renderAddPassage`).
 *
 * A single reference keeps the original wording ("Added John 3:16.") so the
 * common case reads exactly as it always has. A batch reports counts rather
 * than naming every passage - the plan list is about to show them all anyway.
 *
 * This is deliberately decoupled from any one form's DOM: it does not touch
 * `submit.disabled`/`input.disabled`/an error slot/`input.value` the way the
 * old closure did, because two different UIs (a single-line input, a modal's
 * textarea-then-confirm) each own that furniture differently. Instead it
 * returns an `AddReferencesOutcome` with enough information - which
 * references actually ended up added, and which failed with what message -
 * for each caller to update its own inputs, its own error slot and its own
 * focus. `host.announce` and `host.reload()` stay here rather than moving to
 * callers because the wording and the "reload only on any success" rule are
 * shared, not per-UI.
 */
export async function addReferences(host: PanelHost, references: string[]): Promise<AddReferencesOutcome> {
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
  // John 3:16 separately should be ignored" - task 0004's review). A passage
  // id repeated in `addedPassages` (the same reference pasted twice, or two
  // spellings that resolved to the same range) is collapsed to one entry
  // first, so the range check below never mistakes "the same row twice" for
  // "one range containing another" and removes the passage the user is
  // trying to keep.
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

  const added = kept.map((p) => p.reference);

  if (added.length > 0) {
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

  return { added, failed };
}

/**
 * The message a caller shows for one failed reference: the worker's reason
 * verbatim for a lone reference, or prefixed with the reference itself when
 * it was one line among several - the same rule `addReferences`'s old inline
 * closure applied, now shared by both of its callers below.
 */
function addFailureMessage(references: string[], failure: { reference: string; error: string }): string {
  return references.length === 1 ? failure.error : `${failure.reference}: ${failure.error}`;
}

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
 * **The "add several at once" modal (P3).** A pasted or typed batch, and the
 * "Add several passages at once…" link below the field, all open the same
 * modal (`openBatchModal` below): a `<textarea>` plus "Find references",
 * which swaps to a confirm view - the parsed list plus "Add N passages" /
 * "Back" - built from the same markup shape the old inline confirm slot used.
 * A paste or an Enter press that names more than one reference pre-fills the
 * textarea with what was pasted/typed and runs "Find references"
 * immediately, landing straight on the confirm view exactly as the old
 * inline slot did; opening the modal from the link starts blank instead,
 * since there is nothing yet to parse. "Back" returns to the textarea with
 * its text untouched, so nothing already typed has to be retyped.
 *
 * A fresh `modal()` is built on every open (`components.ts#modal`'s own
 * note): `batchModalSlot` holds at most one at a time, and opening again -
 * from the link, or from another paste - replaces whatever was there,
 * letting the previous instance and its listeners go rather than reusing one
 * long-lived dialog across unrelated sessions. Within one open session,
 * though, "Find references" and "Back" swap the same modal's body in place
 * (`showEntry`/`showConfirm` below both `replace()` the same `body` element)
 * rather than closing and reopening - that swap would be a jarring way to
 * answer one click.
 *
 * **Sprinkled references, and consolidating overlaps.** A further round asked
 * for two more things: pasting "lots of text with random verse references
 * sprinkled in" rather than a clean one-per-line list, and de-duplicating a
 * batch that names both a range and one of its own verses ("if John 3:16-17
 * is in there, John 3:16 separately should be ignored"). The first is
 * `extractReferenceCandidates`'s job; the second happens after every
 * candidate has been added, in `addReferences` above, since only the worker
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

  // Holds the batch modal while it is open - at most one at a time (see the
  // header note above for why a fresh `modal()` replaces whatever is here on
  // every open rather than one instance being reused).
  const batchModalSlot = el('div', { class: 'sm-batch-modal-slot' });

  const addSeveralLink = button('Add several passages at once…', () => openBatchModal(''), {
    class: 'sm-btn sm-btn-quiet sm-btn-small sm-link-btn',
  });

  const form = el('form', { class: 'sm-add' }, [
    el('label', { class: 'sm-label', text: 'Add passage', attrs: { for: 'sm-add-reference' } }),
    el('div', { class: 'sm-add-row' }, [input, submit]),
    errorSlot,
    el('p', {
      class: 'sm-hint',
      text: 'Paste a list to add several at once - one reference per line.',
    }),
    addSeveralLink,
  ]) as HTMLFormElement;

  /**
   * Runs the lifted `addReferences` against this form's own field: disables
   * it for the duration, and reports the outcome exactly as the old closure
   * did - the field is cleared on any success, and a failure is shown in this
   * form's own error slot with focus sent back to the field.
   */
  async function runAdd(references: string[]): Promise<void> {
    submit.disabled = true;
    input.disabled = true;
    replace(errorSlot, []);

    const outcome = await addReferences(host, references);

    submit.disabled = false;
    input.disabled = false;

    if (outcome.added.length > 0) input.value = '';

    if (outcome.failed.length > 0) {
      replace(errorSlot, outcome.failed.map((f) => errorBanner(addFailureMessage(references, f))));
      focusQuietly(input);
    }
  }

  /**
   * Opens the "add several at once" modal - see the header note above for the
   * overall shape. `prefill` is the pasted or typed text to seed the textarea
   * with; a non-empty `prefill` also runs "Find references" immediately, so a
   * paste or Enter naming several references lands straight on the confirm
   * view the way the old inline slot did. The link's own call passes `''`
   * and gets the blank textarea view instead.
   */
  function openBatchModal(prefill: string): void {
    const textarea = el('textarea', {
      class: 'sm-textarea',
      id: 'sm-batch-textarea',
      attrs: { rows: '8' },
    }) as HTMLTextAreaElement;
    textarea.value = prefill;

    // Swapped in place between the textarea-entry view and the confirm view -
    // see the header note above for why this happens within one modal
    // instance rather than by closing and reopening.
    const body = el('div', { class: 'sm-modal-batch-body' });
    const handle = modal({ title: 'Add several passages at once', body: [body], actions: [] });

    function showEntry(): void {
      const entryErrorSlot = el('div', { class: 'sm-error-slot', attrs: { 'aria-live': 'polite' } });
      const cancelBtn = button('Cancel', () => handle.close(), { class: 'sm-btn sm-btn-quiet' });
      const findBtn = button(
        'Find references',
        () => {
          const candidates = extractReferenceCandidates(textarea.value);
          if (candidates.length === 0) {
            replace(entryErrorSlot, [errorBanner('Type or paste at least one reference first.')]);
            focusQuietly(textarea);
            return;
          }
          showConfirm(candidates);
        },
        { class: 'sm-btn sm-btn-primary' },
      );

      replace(body, [
        el('label', { class: 'sm-label', text: 'References', attrs: { for: 'sm-batch-textarea' } }),
        textarea,
        el('p', {
          class: 'sm-hint',
          text: 'Paste a list of references, or any text that has references in it, and they will be auto-detected.',
        }),
        entryErrorSlot,
        el('div', { class: 'sm-modal-actions' }, [cancelBtn, findBtn]),
      ]);
      focusQuietly(textarea);
    }

    function showConfirm(lines: string[]): void {
      const confirmErrorSlot = el('div', { class: 'sm-error-slot', attrs: { 'aria-live': 'polite' } });
      // "Back", not "Cancel" - this view returns to the textarea (its text
      // preserved, since `textarea` is the same element throughout) rather
      // than closing the modal, unlike the old inline confirm's "Cancel".
      const backBtn = button('Back', () => showEntry(), { class: 'sm-btn sm-btn-quiet' });
      const addBtn = button(
        `Add ${countLabel(lines.length, 'passage')}`,
        () => {
          addBtn.disabled = true;
          backBtn.disabled = true;
          void addReferences(host, lines).then((outcome) => {
            if (outcome.failed.length === 0) {
              // A clean success closes the modal - the plan list below is
              // about to show the result, mirroring the single-line field
              // clearing itself on success rather than staying open on a
              // stale form. A *partial* success (below) keeps the modal open
              // instead, since there is still something on screen worth the
              // user's attention: which lines failed and why.
              handle.close();
              return;
            }
            addBtn.disabled = false;
            backBtn.disabled = false;
            replace(confirmErrorSlot, outcome.failed.map((f) => errorBanner(addFailureMessage(lines, f))));
          });
        },
        { class: 'sm-btn sm-btn-primary' },
      );

      replace(body, [
        el('p', { class: 'sm-hint', text: `Add ${countLabel(lines.length, 'passage')}?` }),
        el(
          'ul',
          { class: 'sm-batch-list' },
          lines.map((line) => el('li', { class: 'sm-batch-list-item', text: line })),
        ),
        confirmErrorSlot,
        el('div', { class: 'sm-modal-actions' }, [backBtn, addBtn]),
      ]);
    }

    replace(batchModalSlot, [handle.element]);
    handle.open();

    if (prefill.trim().length > 0) showConfirm(extractReferenceCandidates(prefill));
    else showEntry();
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
      // batch opens the modal, pre-filled and already parsed, rather than
      // going straight to the worker.
      event.preventDefault();
      openBatchModal(text);
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
    // Romans 8:28"); it gets the same modal treatment as a pasted batch
    // rather than adding several passages on one Enter press unseen.
    if (references.length > 1) {
      openBatchModal(input.value);
      return;
    }

    void runAdd(references);
  });

  return el('div', { class: 'sm-add-wrapper' }, [form, batchModalSlot]);
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
