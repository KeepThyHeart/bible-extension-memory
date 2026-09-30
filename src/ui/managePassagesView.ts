/**
 * Manage Passages: add, remove, move between lists, and list management
 * itself (create/rename/delete), plus the suggested-lists gallery.
 *
 * T10 moved the add-passage form (input, paste-batch confirm,
 * `dropContainedRanges` consolidation) off the home screen entirely, on the
 * understanding that this screen would keep it. The form below is that same
 * code, carried over in behaviour rather than rewritten - see `addBatch` and
 * `renderAddPassage`, and their doc comments, which are the originals from
 * `planView.ts`'s history with the minimum change needed to be reusable from
 * two places on this screen (the field itself, and a suggested list's "Copy
 * references" button).
 *
 * The add-passage input keeps the id `sm-add-reference` on purpose:
 * `panel.ts#updateAddPlaceholder` pokes that id directly on every
 * `activeVerse` push, and matching the id here is what keeps that wiring
 * working now that the field lives on this screen instead of the plan.
 */

import type { ListSummary, Passage, PassageView, PlanView } from '../types';
import { append, button, el, focusQuietly, replace } from './dom';
import { emptyState, errorBanner, listSelector, modal, toolbar } from './components';
import type { ListSelectorOption } from './components';
import { countLabel } from './format';
import { dropContainedRanges, extractReferenceCandidates } from './referenceInput';
import { SUGGESTED_LISTS } from '../suggestedLists';
import type { SuggestedList } from '../suggestedLists';
import type { PanelHost } from './host';

export function renderManagePassages(host: PanelHost, plan: PlanView): HTMLElement {
  const root = el('section', { class: 'sm-screen sm-screen-manage-passages' });

  root.appendChild(toolbar({ title: 'Manage Passages', onBack: () => host.go({ type: 'goPlan' }) }));

  root.appendChild(renderListManagement(host, plan));

  const addPassage = renderAddPassage(host);
  root.appendChild(addPassage.element);

  root.appendChild(renderPassageList(host, plan));

  root.appendChild(renderSuggestedLists(host, plan, addPassage.offerBatch));

  return root;
}

// ---------------------------------------------------------------------------
// List management: which list is selected, create, rename, delete
// ---------------------------------------------------------------------------

function renderListManagement(host: PanelHost, plan: PlanView): HTMLElement {
  const wrap = el('div', { class: 'sm-manage-lists' });

  // "Viewing" - the same all-lists/one-list scope the home screen's picker
  // drives, shown here unconditionally (unlike the home screen, which hides
  // it for a single-list plan) because choosing a list is this screen's job.
  const options: ListSelectorOption[] = [
    { id: 'all', name: 'All Lists' },
    ...plan.lists.map((list) => ({ id: list.id, name: list.name })),
  ];
  const viewingSelect = listSelector(options, plan.scope, (id) => {
    void host
      .request({ type: 'setScope', scope: id === 'all' ? { kind: 'all' } : { kind: 'list', id } })
      .then((reply) => {
        if (reply.ok) host.reload();
        else host.announce(reply.error);
      });
  });
  viewingSelect.id = 'sm-manage-viewing';
  wrap.appendChild(
    el('div', { class: 'sm-manage-lists-row' }, [
      el('label', { class: 'sm-label', text: 'Viewing', attrs: { for: 'sm-manage-viewing' } }),
      viewingSelect,
    ]),
  );

  wrap.appendChild(renderCreateList(host));

  wrap.appendChild(
    el(
      'ul',
      { class: 'sm-list sm-manage-list-rows', attrs: { 'aria-label': 'Your lists' } },
      plan.lists.map((list) => renderListRow(host, plan, list)),
    ),
  );

  return wrap;
}

function renderCreateList(host: PanelHost): HTMLElement {
  const input = el('input', {
    class: 'sm-input',
    id: 'sm-create-list-name',
    type: 'text',
    placeholder: 'e.g. Memory verses for Advent',
    attrs: { autocomplete: 'off', autocapitalize: 'words', spellcheck: 'false', enterkeyhint: 'done' },
  }) as HTMLInputElement;
  const errorSlot = el('div', { class: 'sm-error-slot', attrs: { 'aria-live': 'polite' } });
  const submit = el('button', { class: 'sm-btn', text: 'Create' }) as HTMLButtonElement;
  submit.type = 'submit';

  const form = el('form', { class: 'sm-add' }, [
    el('label', { class: 'sm-label', text: 'Create a list', attrs: { for: 'sm-create-list-name' } }),
    el('div', { class: 'sm-add-row' }, [input, submit]),
    errorSlot,
  ]) as HTMLFormElement;

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const name = input.value.trim();
    if (!name) {
      replace(errorSlot, [errorBanner('Type a name for the new list first.')]);
      focusQuietly(input);
      return;
    }
    submit.disabled = true;
    input.disabled = true;
    void host.request({ type: 'createList', name }).then((reply) => {
      submit.disabled = false;
      input.disabled = false;
      if (!reply.ok) {
        replace(errorSlot, [errorBanner(reply.error)]);
        focusQuietly(input);
        return;
      }
      input.value = '';
      host.announce(`Created ${name}.`);
      host.reload();
    });
  });

  return form;
}

function renderListRow(host: PanelHost, plan: PlanView, list: ListSummary): HTMLElement {
  const row = el('li', { class: 'sm-row sm-manage-list-row' });

  const showIdle = (): void => {
    const renameBtn = button('Rename', showRenameForm, { class: 'sm-btn sm-btn-quiet sm-btn-small' });
    const deleteBtn = button('Delete', handleDelete, {
      class: 'sm-btn sm-btn-quiet sm-btn-small sm-btn-danger-quiet',
      attrs: { 'aria-label': `Delete ${list.name}` },
    }) as HTMLButtonElement;
    // Resolved D2: a plan with zero lists is a state nothing else in this
    // extension can describe, so deleting the only list left is refused
    // before the request is even sent (the worker would refuse it too - see
    // `store.ts#deleteCollection` - this just saves the round trip).
    if (plan.lists.length <= 1) deleteBtn.disabled = true;

    replace(row, [
      el('span', { class: 'sm-row-ref', text: list.name }),
      el('span', { class: 'sm-row-meta', text: countLabel(list.passageCount, 'passage') }),
      el('span', { class: 'sm-manage-list-actions' }, [renameBtn, deleteBtn]),
    ]);
  };

  function showRenameForm(): void {
    const input = el('input', { class: 'sm-input', type: 'text' }) as HTMLInputElement;
    input.value = list.name;
    const errorSlot = el('div', { class: 'sm-error-slot', attrs: { 'aria-live': 'polite' } });

    const save = (): void => {
      const name = input.value.trim();
      if (!name) {
        replace(errorSlot, [errorBanner('A list needs a name.')]);
        return;
      }
      void host.request({ type: 'renameList', id: list.id, name }).then((reply) => {
        if (!reply.ok) {
          replace(errorSlot, [errorBanner(reply.error)]);
          return;
        }
        host.announce(`Renamed to ${name}.`);
        host.reload();
      });
    };

    replace(row, [
      el('div', { class: 'sm-manage-list-rename' }, [
        input,
        button('Save', save, { class: 'sm-btn sm-btn-small' }),
        button('Cancel', showIdle, { class: 'sm-btn sm-btn-small sm-btn-quiet' }),
        errorSlot,
      ]),
    ]);
    focusQuietly(input);
  }

  function doDelete(movePassagesTo: number): void {
    void host.request({ type: 'deleteList', id: list.id, movePassagesTo }).then((reply) => {
      if (!reply.ok) {
        host.announce(reply.error);
        return;
      }
      host.announce(`Deleted ${list.name}.`);
      host.reload();
    });
  }

  function handleDelete(): void {
    if (plan.lists.length <= 1) return;
    const others = plan.lists.filter((l) => l.id !== list.id);
    // Resolved D2: deleting a list with passages asks where to move them,
    // defaulting to Default; deleting an already-empty list needs no
    // question, so it goes straight through - `movePassagesTo` is still
    // required by the protocol even though nothing will actually move.
    if (list.passageCount === 0) {
      const fallback = others.find((l) => l.name === 'Default') ?? others[0]!;
      doDelete(fallback.id);
      return;
    }
    showDeleteConfirm(others);
  }

  function showDeleteConfirm(others: ListSummary[]): void {
    const defaultTarget = others.find((l) => l.name === 'Default') ?? others[0]!;
    let chosen = defaultTarget.id;

    const select = listSelector(
      others.map((l) => ({ id: l.id, name: l.name })),
      chosen,
      (id) => {
        if (id !== 'all') chosen = id;
      },
    );

    const confirmButton = button(
      `Delete and move ${countLabel(list.passageCount, 'passage')}`,
      () => {
        doDelete(chosen);
        closeModal();
      },
      { class: 'sm-btn sm-btn-danger sm-btn-small' },
    );

    const backdrop = modal({
      title: `Delete "${list.name}"?`,
      content: [
        el('p', {
          class: 'sm-hint',
          text: `This list has ${countLabel(list.passageCount, 'passage')}. Choose another list to move ${
            list.passageCount === 1 ? 'it' : 'them'
          } to first.`,
        }),
        select,
        el('div', { class: 'sm-batch-actions' }, [confirmButton]),
      ],
      onClose: () => backdrop.remove(),
    });
    document.body.appendChild(backdrop);

    function closeModal(): void {
      backdrop.remove();
    }
  }

  showIdle();
  return row;
}

// ---------------------------------------------------------------------------
// The passage list: remove and move-to-list
// ---------------------------------------------------------------------------

function renderPassageList(host: PanelHost, plan: PlanView): HTMLElement {
  if (plan.passages.length === 0) {
    return emptyState(
      'No passages here yet.',
      'Add one above with a reference, or start from a suggested list below.',
    );
  }
  return el(
    'ul',
    { class: 'sm-list', attrs: { 'aria-label': 'Passages in this list' } },
    plan.passages.map((pv) => renderPassageRow(host, plan, pv)),
  );
}

function renderPassageRow(host: PanelHost, plan: PlanView, pv: PassageView): HTMLElement {
  const moveOptions: ListSelectorOption[] = plan.lists.map((list) => ({ id: list.id, name: list.name }));
  const moveSelect = listSelector(moveOptions, pv.passage.collectionId, (id) => {
    if (id === 'all') return;
    void host.request({ type: 'movePassage', passageId: pv.passage.id, collectionId: id }).then((reply) => {
      if (!reply.ok) {
        host.announce(reply.error);
        return;
      }
      host.reload();
    });
  });
  moveSelect.setAttribute('aria-label', `Move ${pv.passage.reference} to a different list`);

  return el('li', { class: 'sm-row sm-manage-passage-row' }, [
    el('span', { class: 'sm-row-ref', text: pv.passage.reference }),
    moveSelect,
    renderRemoveControl(host, pv),
  ]);
}

/**
 * Removal, carried over from `passageView.ts#renderRemoveControl`'s own
 * rule: only ask for confirmation when the passage has history
 * (`bestLevel > 0`) - a never-attempted passage has nothing a confirmation
 * step would be protecting. T12 removes the original from the passage
 * screen; this is its new, only home.
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
      host.reload();
    });
  }

  const showIdle = (): void => {
    replace(slot, [
      button('Remove…', hasHistory ? showConfirm : doRemove, {
        class: 'sm-btn sm-btn-small sm-btn-danger-quiet',
        attrs: { 'aria-label': `Remove ${pv.passage.reference} from the plan` },
      }),
    ]);
  };

  function showConfirm(): void {
    replace(slot, [
      el('span', { class: 'sm-remove-confirm', attrs: { role: 'alert' } }, [
        el('span', { class: 'sm-hint', text: 'Remove this passage and its history?' }),
        button('Yes, remove', doRemove, { class: 'sm-btn sm-btn-small sm-btn-danger' }),
        button('Cancel', showIdle, { class: 'sm-btn sm-btn-small sm-btn-quiet' }),
      ]),
    ]);
  }

  showIdle();
  return slot;
}

// ---------------------------------------------------------------------------
// Adding a passage
// ---------------------------------------------------------------------------

/**
 * Adds one or more references, in order, consolidates any that overlap
 * within this same batch, and reports what happened.
 *
 * Moved out of the form-building function below so the suggested-lists
 * section's "Create this list" can call the exact same sequential-add,
 * overlap-consolidating logic against a different target list, rather than
 * re-implementing it - see that section for how it is used.
 *
 * Sequential, not `Promise.all` - these become real database rows and a race
 * between them buys nothing while risking an interleaving no one asked for.
 *
 * A repeat within the batch, or a reference already present in the target
 * list, is not a failure: `store.addPassage` (via the worker's `addPassage`
 * reply) returns the *existing* row for either case, so it lands in `added`
 * exactly like a fresh one and is never reported alongside `failed`.
 */
async function addBatch(
  host: PanelHost,
  references: string[],
): Promise<{ added: Passage[]; failed: { reference: string; error: string }[]; dropped: Passage[] }> {
  const addedPassages: Passage[] = [];
  const failed: { reference: string; error: string }[] = [];

  for (const reference of references) {
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

  return { added: kept, failed, dropped };
}

/**
 * Collapses a batch of `addPassage` replies to one entry per underlying
 * passage row, first occurrence wins. See `addBatch`'s own comment for why -
 * carried over verbatim from `planView.ts`'s history.
 */
function dedupeById(passages: Passage[]): Passage[] {
  const byId = new Map<number, Passage>();
  for (const p of passages) {
    if (!byId.has(p.id)) byId.set(p.id, p);
  }
  return [...byId.values()];
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
 * **Pasting several references at once**, **confirming a batch**, and
 * **sprinkled references / consolidating overlaps** all work exactly as they
 * did on the plan screen before T10 moved this form here - see the git
 * history of `planView.ts` for the full account of each round of review that
 * shaped this. Nothing about the behaviour changed in the move.
 *
 * Returns both the field's element and `offerBatch`, which the suggested
 * lists section's "Copy references" button calls to drop a whole list's
 * references into the same confirm-before-adding flow a multi-reference
 * paste already goes through - reusing it rather than building a second
 * summary UI for the same "add several, see them first" idea.
 */
function renderAddPassage(host: PanelHost): { element: HTMLElement; offerBatch: (lines: string[]) => void } {
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

  async function addReferences(references: string[]): Promise<void> {
    submit.disabled = true;
    input.disabled = true;
    replace(errorSlot, []);

    const { added, failed, dropped } = await addBatch(host, references);

    submit.disabled = false;
    input.disabled = false;

    const addedRefs = added.map((p) => p.reference);

    if (addedRefs.length > 0) {
      input.value = '';
      const mergedNote =
        dropped.length > 0
          ? ` ${countLabel(dropped.length, 'reference')} already covered by another passage in this batch.`
          : '';
      host.announce(
        addedRefs.length === 1 && failed.length === 0 && dropped.length === 0
          ? `Added ${addedRefs[0]}.`
          : failed.length === 0
            ? `Added ${countLabel(addedRefs.length, 'passage')}.${mergedNote}`
            : `Added ${countLabel(addedRefs.length, 'passage')}; ${failed.length} failed.${mergedNote}`,
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

  const element = el('div', { class: 'sm-add-wrapper' }, [form, batchConfirmSlot]);

  return { element, offerBatch: showBatchConfirm };
}

// ---------------------------------------------------------------------------
// Suggested lists
// ---------------------------------------------------------------------------

function renderSuggestedLists(
  host: PanelHost,
  plan: PlanView,
  offerBatch: (lines: string[]) => void,
): HTMLElement {
  return el('section', { class: 'sm-suggested-lists' }, [
    el('h2', { class: 'sm-suggested-lists-title', text: 'Suggested lists' }),
    el(
      'ul',
      { class: 'sm-list sm-suggested-lists-rows', attrs: { 'aria-label': 'Suggested lists' } },
      SUGGESTED_LISTS.map((list) => renderSuggestedListRow(host, plan, list, offerBatch)),
    ),
  ]);
}

/**
 * One suggested list: name, blurb, reference count, and two ways to use it.
 *
 * "Create this list" reuses an existing list of the exact same name rather
 * than making a second list with the same label every time it is pressed -
 * the policy chosen so that pressing it twice is idempotent (the task's own
 * "done when" requirement): the second press finds the list `renderListRow`
 * already built, targets that instead of creating a duplicate, and lands on
 * `addBatch`'s ordinary duplicate handling (`addPassage` returns the
 * existing row for a reference already in the target list) to make sure nothing
 * is added twice within it either.
 */
function renderSuggestedListRow(
  host: PanelHost,
  plan: PlanView,
  list: SuggestedList,
  offerBatch: (lines: string[]) => void,
): HTMLElement {
  const statusSlot = el('div', { class: 'sm-error-slot', attrs: { 'aria-live': 'polite' } });

  const createButton = button('Create this list', () => void handleCreate(), {
    class: 'sm-btn sm-btn-small',
  }) as HTMLButtonElement;
  const copyButton = button('Copy references', () => offerBatch([...list.references]), {
    class: 'sm-btn sm-btn-small sm-btn-quiet',
  });

  async function handleCreate(): Promise<void> {
    createButton.disabled = true;
    replace(statusSlot, []);

    const existing = plan.lists.find((l) => l.name === list.name);
    let targetId: number;
    if (existing) {
      targetId = existing.id;
    } else {
      const created = await host.request({ type: 'createList', name: list.name });
      if (!created.ok) {
        createButton.disabled = false;
        replace(statusSlot, [errorBanner(created.error)]);
        return;
      }
      const newList = created.data.lists.find((l) => l.name === list.name);
      if (!newList) {
        createButton.disabled = false;
        replace(statusSlot, [errorBanner('Could not find the list that was just created.')]);
        return;
      }
      targetId = newList.id;
    }

    // `addPassage` always lands on the currently scoped list (see
    // `main.ts#resolveAddTargetCollectionId`), so the references have to be
    // added through that same door: point scope at the target list first,
    // then run the ordinary batch-add logic against it.
    const scoped = await host.request({ type: 'setScope', scope: { kind: 'list', id: targetId } });
    if (!scoped.ok) {
      createButton.disabled = false;
      replace(statusSlot, [errorBanner(scoped.error)]);
      return;
    }

    const { added, failed } = await addBatch(host, [...list.references]);
    createButton.disabled = false;

    if (failed.length > 0) {
      replace(
        statusSlot,
        failed.map((f) => errorBanner(`${f.reference}: ${f.error}`)),
      );
    }

    host.announce(
      failed.length === 0
        ? `Created ${list.name} with ${countLabel(added.length, 'passage')}.`
        : `Created ${list.name}: ${countLabel(added.length, 'passage')} added, ${countLabel(failed.length, 'reference')} failed.`,
    );
    host.reload();
  }

  const row = el('li', { class: 'sm-row sm-suggested-list-row' });
  append(row, [
    el('div', { class: 'sm-suggested-list-info' }, [
      el('span', { class: 'sm-row-ref', text: list.name }),
      el('p', { class: 'sm-hint', text: list.blurb }),
      el('span', { class: 'sm-row-meta', text: countLabel(list.references.length, 'reference') }),
    ]),
    el('div', { class: 'sm-suggested-list-actions' }, [createButton, copyButton]),
    statusSlot,
  ]);

  return row;
}
