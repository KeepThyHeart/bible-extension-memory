/**
 * Manage passages: the lists table, the add-passage form and the plan's
 * passage list, each with the action this screen supports (P1/P4/P5, M5).
 *
 * **The lists table (P5).** One row per `CollectionView` from `getCollections`
 * - every list, not just the active one `plan` is scoped to - with Edit
 * (rename) and Delete per row, plus a "+ New list" control. This replaces
 * P1's placeholder wholesale: that shell rendered exactly one hardcoded row
 * (`plan.collectionName`) with Edit enabled and Delete permanently disabled,
 * per Decision 14's "until P4 lands" wording. P4 built the real multi-list
 * CRUD (`getCollections`/`createCollection`/`deleteCollection` alongside the
 * already-existing `renameCollection`); this file is P5, the screen that
 * actually uses it.
 *
 * Delete is a real, immediate delete (`deleteCollection`) - not the
 * soft-delete P6 will later add for individual *passages*, a different
 * screen entirely. Decision 15's two-step confirmation is the interesting
 * part: a list with no practice anywhere in it gets a plain
 * `Delete "name"?`, but a list where any passage has `bestLevel > 0` gets a
 * stronger warning naming exactly how much history is at stake, and requires
 * typing the list's name before the delete button enables - see
 * `renderListRow`'s own note for why the practice check is a lazy,
 * per-row-on-press fetch (`getCollectionPracticeStats`) rather than eager for
 * every row on table load.
 *
 * The add-passage form (M5, moved here from `planView.ts#renderPlan` per
 * Decision 10 - "renderAddPassage and its batch paste UI move off this
 * screen [home] entirely to Manage Passages") is `renderAddPassageBlock`
 * below, with `addReferences` moved alongside it since this screen is now
 * its only caller.
 *
 * The passage list below it reuses `plan.passages` - the same data the home
 * screen already has, so that block needs no request of its own beyond
 * `getPlan` - and gives each row the same two-step Remove shape as
 * `passageView.ts#renderRemoveControl`, adapted to one row among many rather
 * than a whole screen's own slot.
 */

import type { CollectionView, Passage, PassageView, PlanView } from '../types';
import { button, el, focusQuietly, replace } from './dom';
import { breadcrumb, emptyState, errorBanner, modal } from './components';
import { countLabel } from './format';
import { dropContainedRanges, extractReferenceCandidates } from './referenceInput';
import type { PanelHost } from './host';

export function renderManage(host: PanelHost, plan: PlanView): HTMLElement {
  const root = el('section', { class: 'sm-screen sm-screen-manage' });

  root.appendChild(
    breadcrumb({
      crumbs: [
        { label: 'Home', onClick: () => host.go({ type: 'goPlan' }) },
        { label: 'Manage passages' },
      ],
    }),
  );

  root.appendChild(renderListsBlock(host));
  root.appendChild(renderAddPassageBlock(host));
  root.appendChild(renderPassagesBlock(host, plan));

  return root;
}

// ---------------------------------------------------------------------------
// The lists table (P5)
// ---------------------------------------------------------------------------

/**
 * The lists table itself: one row per `CollectionView`, fetched fresh on
 * every render (there is no per-list data on `plan` to reuse, since `plan` is
 * scoped to the active list alone) plus the "+ New list" control underneath.
 *
 * The `<ul>` starts empty and is filled once `getCollections` replies -
 * `renderManage` and this function both stay synchronous (nothing else on
 * this screen has ever awaited a request before its first paint), so a
 * loading gap of one microtask is the tradeoff, the same one `TestHost`'s own
 * `settle()` helper exists for in the test suite.
 */
function renderListsBlock(host: PanelHost): HTMLElement {
  const listEl = el('ul', { class: 'sm-list', attrs: { 'aria-label': 'Lists' } });
  const errorSlot = el('div', { class: 'sm-error-slot', attrs: { 'aria-live': 'polite' } });

  async function loadCollections(): Promise<void> {
    const reply = await host.request({ type: 'getCollections' });
    if (!reply.ok) {
      replace(errorSlot, [errorBanner(reply.error)]);
      return;
    }
    replace(errorSlot, []);
    replace(listEl, reply.data.map((c) => renderListRow(host, c, loadCollections)));
  }

  void loadCollections();

  return el('section', { class: 'sm-block' }, [
    el('h2', { class: 'sm-block-title', text: 'Lists' }),
    listEl,
    errorSlot,
    renderNewListControl(host, loadCollections),
  ]);
}

/**
 * One row: the list's name, Edit (rename) and Delete - generalised from P1's
 * single hardcoded row to take any `CollectionView` rather than reading
 * `plan.collectionName`/`plan.collectionId` directly. `reload` is
 * `renderListsBlock`'s own `loadCollections`, passed down so a rename or
 * delete can refresh the table itself in place, the same immediate feedback
 * `host.reload()` gives the rest of the screen - both are called together
 * below, matching every other setter on this screen (`renameCollection`'s own
 * former note, still true here: trust the reload, not the locally-typed
 * value, to match whatever the worker actually stored).
 */
function renderListRow(host: PanelHost, collection: CollectionView, reload: () => void): HTMLElement {
  const row = el('li', { class: 'sm-row' });

  const showView = (): void => {
    replace(row, [
      el('span', { class: 'sm-row-ref', text: collection.name }),
      button('Edit', showEdit, { class: 'sm-btn sm-btn-small sm-btn-quiet' }),
      button('Delete', showDeleteChecking, {
        class: 'sm-btn sm-btn-small sm-btn-danger-quiet',
        attrs: { 'aria-label': `Delete ${collection.name}` },
      }),
    ]);
  };

  function showEdit(): void {
    const input = el('input', {
      class: 'sm-input',
      value: collection.name,
      attrs: { 'aria-label': 'List name' },
    }) as HTMLInputElement;

    const errorSlot = el('div', { class: 'sm-error-slot', attrs: { 'aria-live': 'polite' } });

    const save = button('Save', () => void doSave(), { class: 'sm-btn sm-btn-small sm-btn-primary' });
    const cancel = button('Cancel', showView, { class: 'sm-btn sm-btn-small sm-btn-quiet' });

    async function doSave(): Promise<void> {
      const name = input.value.trim();
      if (name === '') {
        replace(errorSlot, [errorBanner('Give the list a name.')]);
        return;
      }
      input.disabled = true;
      save.disabled = true;
      cancel.disabled = true;
      const reply = await host.request({
        type: 'renameCollection',
        collectionId: collection.id,
        name,
      });
      if (!reply.ok) {
        input.disabled = false;
        save.disabled = false;
        cancel.disabled = false;
        replace(errorSlot, [errorBanner(reply.error)]);
        return;
      }
      host.announce(`Renamed to ${name}.`);
      // Persisted - reload to see the real state, same pattern as every other
      // setter on this panel (`renderPassageListHeader`'s sort order,
      // `renderAnswerModeRow`'s answer mode), rather than trusting the local
      // `name` to match whatever the worker actually stored. Both this row's
      // own table (in case another row's data shifted too) and the rest of
      // the screen (the breadcrumb reads nothing from this, but a renamed
      // *active* list would - see `host.reload()`'s own doc) are refreshed.
      reload();
      host.reload();
    }

    // Enter-to-save, mirroring the plain-input controls elsewhere in this
    // panel (e.g. the add-passage field) - a `<form>` is not used here since
    // this row already swaps its own contents in place, the same way
    // `renderRemoveControl`'s confirm step does.
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        void doSave();
      }
    });

    replace(row, [input, save, cancel, errorSlot]);
    focusQuietly(input);
    input.select();
  }

  // ---------------------------------------------------------------------
  // Delete (Decision 15): a lazy practice-history check, then one of two
  // confirmation shapes.
  // ---------------------------------------------------------------------

  /**
   * Delete is pressed: check this one list's own practice history before
   * deciding which confirmation to show, rather than fetching it for every
   * row up front (a table of many lists would otherwise mean many
   * `getCollectionPracticeStats` requests for rows nobody is about to
   * delete). A brief "Checking…" replaces the row while the request is in
   * flight - `TestHost`'s stub replies are immediate but still a microtask
   * away, and a real worker round-trip is slower still, so the row would
   * otherwise sit showing its old Edit/Delete buttons as if the press had
   * done nothing.
   */
  function showDeleteChecking(): void {
    replace(row, [
      el('span', { class: 'sm-row-ref', text: collection.name }),
      el('span', { class: 'sm-hint', text: 'Checking…' }),
    ]);
    void loadStatsAndConfirm();
  }

  async function loadStatsAndConfirm(): Promise<void> {
    const reply = await host.request({ type: 'getCollectionPracticeStats', collectionId: collection.id });
    if (!reply.ok) {
      replace(row, [
        el('span', { class: 'sm-row-ref', text: collection.name }),
        errorBanner(reply.error),
        button('Cancel', showView, { class: 'sm-btn sm-btn-small sm-btn-quiet' }),
      ]);
      return;
    }
    if (reply.data.practiced > 0) showDeleteConfirmWithHistory(reply.data.total, reply.data.practiced);
    else showDeleteConfirmSimple();
  }

  /** No passage in this list has ever been practised: `Delete "name"? [Yes, delete] [Cancel]`. */
  function showDeleteConfirmSimple(): void {
    replace(row, [
      el('span', { class: 'sm-remove-confirm', attrs: { role: 'alert' } }, [
        el('span', { class: 'sm-hint', text: `Delete "${collection.name}"?` }),
        button('Yes, delete', doDelete, { class: 'sm-btn sm-btn-small sm-btn-danger' }),
        button('Cancel', showView, { class: 'sm-btn sm-btn-small sm-btn-quiet' }),
      ]),
    ]);
  }

  /**
   * At least one passage has real history: the stronger warning, with the
   * exact N-of-M wording Decision 15 specifies, and a name-typed gate on
   * "Yes, delete" - the only place in the panel that asks for typing, which
   * is itself the signal (Decision 15's own words). The match is exact
   * (case-sensitive, untrimmed): this is a deliberate speed bump, not a form
   * field, so it should not be easier to clear than actually typing the name.
   */
  function showDeleteConfirmWithHistory(total: number, practiced: number): void {
    const input = el('input', {
      class: 'sm-input',
      attrs: { 'aria-label': `Type "${collection.name}" to confirm deleting it` },
    }) as HTMLInputElement;

    const confirmBtn = button('Yes, delete', doDelete, {
      class: 'sm-btn sm-btn-small sm-btn-danger',
      disabled: true,
    });
    const cancelBtn = button('Cancel', showView, { class: 'sm-btn sm-btn-small sm-btn-quiet' });

    input.addEventListener('input', () => {
      confirmBtn.disabled = input.value !== collection.name;
    });
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !confirmBtn.disabled) {
        event.preventDefault();
        doDelete();
      }
    });

    replace(row, [
      el('span', { class: 'sm-remove-confirm', attrs: { role: 'alert' } }, [
        el('p', {
          class: 'sm-hint',
          text: `This list has practice history on ${practiced} of ${total} passages. Deleting it removes that history.`,
        }),
        input,
        confirmBtn,
        cancelBtn,
      ]),
    ]);
    focusQuietly(input);
  }

  function doDelete(): void {
    void host.request({ type: 'deleteCollection', collectionId: collection.id }).then((reply) => {
      if (!reply.ok) {
        replace(row, [
          el('span', { class: 'sm-row-ref', text: collection.name }),
          errorBanner(reply.error),
          button('Cancel', showView, { class: 'sm-btn sm-btn-small sm-btn-quiet' }),
        ]);
        return;
      }
      host.announce(`Deleted ${collection.name}.`);
      // `deleteCollection` itself moves the active-list setting off a
      // deleted active list before returning (`main.ts`'s own handler) - so
      // the next `getPlan` this triggers (via `host.reload()`) already
      // reflects a real survivor, not the row just removed. `reload()` also
      // re-fetches this table, since the deleted row is otherwise still
      // sitting in `listEl` until something asks `getCollections` again.
      reload();
      host.reload();
    });
  }

  showView();
  return row;
}

/**
 * "+ New list": the create affordance the table needs but Decision 15 itself
 * does not mention (item 18's own wording does - "Replace the current
 * 'Create a list' section with a table..." - a table plus a way to still
 * create one). A fresh `modal()` per open, matching every other modal caller
 * on this screen (`components.ts#modal`'s own note on why).
 */
function renderNewListControl(host: PanelHost, reload: () => void): HTMLElement {
  const modalSlot = el('div', { class: 'sm-new-list-modal-slot' });

  function openNewListModal(): void {
    const input = el('input', {
      class: 'sm-input',
      id: 'sm-new-list-name',
      attrs: { 'aria-label': 'List name' },
    }) as HTMLInputElement;
    const errorSlot = el('div', { class: 'sm-error-slot', attrs: { 'aria-live': 'polite' } });

    const cancelBtn = button('Cancel', () => handle.close(), { class: 'sm-btn sm-btn-quiet' });
    const createBtn = button('Create', () => void doCreate(), { class: 'sm-btn sm-btn-primary' });

    const handle = modal({
      title: 'New list',
      body: [
        el('label', { class: 'sm-label', text: 'List name', attrs: { for: 'sm-new-list-name' } }),
        input,
        errorSlot,
      ],
      actions: [cancelBtn, createBtn],
    });

    async function doCreate(): Promise<void> {
      const name = input.value.trim();
      if (name === '') {
        replace(errorSlot, [errorBanner('Give the list a name.')]);
        return;
      }
      input.disabled = true;
      createBtn.disabled = true;
      cancelBtn.disabled = true;
      const reply = await host.request({ type: 'createCollection', name });
      if (!reply.ok) {
        input.disabled = false;
        createBtn.disabled = false;
        cancelBtn.disabled = false;
        replace(errorSlot, [errorBanner(reply.error)]);
        return;
      }
      handle.close();
      host.announce(`Created ${reply.data.name}.`);
      reload();
      host.reload();
    }

    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        void doCreate();
      }
    });

    replace(modalSlot, [handle.element]);
    handle.open();
  }

  const openBtn = button('+ New list', openNewListModal, {
    class: 'sm-btn sm-btn-quiet sm-btn-small sm-link-btn',
  });

  return el('div', { class: 'sm-new-list' }, [openBtn, modalSlot]);
}

// ---------------------------------------------------------------------------
// Adding a passage (M5, moved from planView.ts#renderPlan - Decision 10)
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
 * inside the old home-screen `renderAddPassage`; moved here in M5 since this
 * screen is now its only caller).
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
 *
 * **M5.** Moved here from `planView.ts#renderPlan` (Decision 10: the add
 * form and its batch paste UI move off the home screen entirely, to this
 * screen) - unchanged in behaviour, only in which screen renders it.
 * `panel.ts#updateAddPlaceholder` still finds this field by the same
 * `#sm-add-reference` id, so it needs no change of its own: it already
 * null-checks for the field being absent (a no-op while any other screen is
 * showing) and simply starts finding it only when Manage is showing.
 */
function renderAddPassageBlock(host: PanelHost): HTMLElement {
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

  return el('section', { class: 'sm-block' }, [
    el('h2', { class: 'sm-block-title', text: 'Add a passage' }),
    el('div', { class: 'sm-add-wrapper' }, [form, batchModalSlot]),
  ]);
}

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

// ---------------------------------------------------------------------------
// The passage list
// ---------------------------------------------------------------------------

function renderPassagesBlock(host: PanelHost, plan: PlanView): HTMLElement {
  if (plan.passages.length === 0) {
    return el('section', { class: 'sm-block' }, [
      el('h2', { class: 'sm-block-title', text: 'Passages' }),
      emptyState('Nothing in your plan yet.', 'Add a passage above to get started.'),
    ]);
  }

  return el('section', { class: 'sm-block' }, [
    el('h2', { class: 'sm-block-title', text: 'Passages' }),
    el(
      'ul',
      { class: 'sm-list', attrs: { 'aria-label': 'Passages in this plan' } },
      plan.passages.map((pv) => renderPassageRow(host, pv)),
    ),
  ]);
}

/**
 * One passage row: its reference, plus a two-step Remove control matching
 * `passageView.ts#renderRemoveControl`'s own shape (idle button → inline
 * "Remove this passage and its history? / Yes, remove / Cancel" → the
 * `removePassage` RPC). Unlike that screen's own slot, a successful remove
 * here calls `host.reload()` rather than `host.go({type:'passageRemoved'})` -
 * this row is one of several on a screen that is not itself about to be
 * navigated away from, so a full re-fetch of the plan (mirroring M4's own
 * "persisted a change, now reload" pattern) is what puts the *rest* of the
 * list back in a correct, up-to-date state too.
 */
function renderPassageRow(host: PanelHost, pv: PassageView): HTMLElement {
  const row = el('li', { class: 'sm-row' });

  const showIdle = (): void => {
    replace(row, [
      el('span', { class: 'sm-row-ref', text: pv.passage.reference }),
      button('Remove passage…', showConfirm, {
        class: 'sm-btn sm-btn-small sm-btn-danger-quiet',
        attrs: { 'aria-label': `Remove ${pv.passage.reference} from the plan` },
      }),
    ]);
  };

  function showConfirm(): void {
    replace(row, [
      el('span', { class: 'sm-row-ref', text: pv.passage.reference }),
      el('span', { class: 'sm-remove-confirm', attrs: { role: 'alert' } }, [
        el('span', { class: 'sm-hint', text: 'Remove this passage and its history?' }),
        button('Yes, remove', doRemove, { class: 'sm-btn sm-btn-small sm-btn-danger' }),
        button('Cancel', showIdle, { class: 'sm-btn sm-btn-small sm-btn-quiet' }),
      ]),
    ]);
  }

  function doRemove(): void {
    void host.request({ type: 'removePassage', passageId: pv.passage.id }).then((reply) => {
      if (!reply.ok) {
        replace(row, [
          el('span', { class: 'sm-row-ref', text: pv.passage.reference }),
          errorBanner(reply.error),
        ]);
        return;
      }
      host.announce(`Removed ${pv.passage.reference}.`);
      host.reload();
    });
  }

  showIdle();
  return row;
}
