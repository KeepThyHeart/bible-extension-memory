/**
 * Manage passages: the placeholder "lists table" plus the plan's passage
 * list, each with the action this v0 shell actually supports (P1).
 *
 * v0 ships exactly one collection (`db.ts#ensureDefaultCollection`), so the
 * "lists table" below has exactly one row: `plan.collectionName`, with Edit
 * enabled (a real, if tiny, rename - `renameCollection` in the protocol) and
 * Delete disabled with a fixed hint, per Decision 14's own words: "Until P4
 * lands, the table renders the single default list with Edit enabled ... and
 * Delete disabled". P4 (multi-list CRUD) and P5 (the real table) replace this
 * wholesale; nothing here should grow multi-list support in the meantime.
 *
 * The passage list below it reuses `plan.passages` - the same data the home
 * screen already has, so this screen needs no request of its own beyond
 * `getPlan` - and gives each row the same two-step Remove shape as
 * `passageView.ts#renderRemoveControl`, adapted to one row among many rather
 * than a whole screen's own slot.
 */

import type { PassageView, PlanView } from '../types';
import { button, el, focusQuietly, replace } from './dom';
import { breadcrumb, emptyState, errorBanner } from './components';
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

  root.appendChild(renderListsBlock(host, plan));
  root.appendChild(renderPassagesBlock(host, plan));

  return root;
}

// ---------------------------------------------------------------------------
// The lists table (one row until P4)
// ---------------------------------------------------------------------------

function renderListsBlock(host: PanelHost, plan: PlanView): HTMLElement {
  return el('section', { class: 'sm-block' }, [
    el('h2', { class: 'sm-block-title', text: 'Lists' }),
    el('ul', { class: 'sm-list', attrs: { 'aria-label': 'Lists' } }, [renderListRow(host, plan)]),
  ]);
}

function renderListRow(host: PanelHost, plan: PlanView): HTMLElement {
  const row = el('li', { class: 'sm-row' });

  const showView = (): void => {
    replace(row, [
      el('span', { class: 'sm-row-ref', text: plan.collectionName }),
      button('Edit', showEdit, { class: 'sm-btn sm-btn-small sm-btn-quiet' }),
      button('Delete', () => {}, {
        class: 'sm-btn sm-btn-small sm-btn-quiet',
        disabled: true,
        attrs: { title: "Your only list can't be deleted." },
      }),
      el('span', { class: 'sm-hint', text: "Your only list can't be deleted." }),
    ]);
  };

  function showEdit(): void {
    const input = el('input', {
      class: 'sm-input',
      value: plan.collectionName,
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
        collectionId: plan.collectionId,
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
      // `name` to match whatever the worker actually stored.
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

  showView();
  return row;
}

// ---------------------------------------------------------------------------
// The passage list
// ---------------------------------------------------------------------------

function renderPassagesBlock(host: PanelHost, plan: PlanView): HTMLElement {
  if (plan.passages.length === 0) {
    return el('section', { class: 'sm-block' }, [
      el('h2', { class: 'sm-block-title', text: 'Passages' }),
      emptyState('Nothing in your plan yet.', 'Add a passage from the home screen first.'),
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
