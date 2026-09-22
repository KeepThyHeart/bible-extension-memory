/**
 * The suggested-lists catalogue (P7).
 *
 * DOM-free, per the note at the top of `format.ts` and matching
 * `activities.ts`'s own shape (M1): a small, typed, easy-to-extend table
 * rather than one hand-written UI per list, so a second entry later is a data
 * change here, not a UI change in `manageView.ts`.
 *
 * Item 19 ("move suggested lists out of the current inline/messy section
 * into its own popup") was investigated in the design doc's Decision 18,
 * which found nothing in the codebase to move - no suggested-list/starter-
 * list/preset/verse-pack code anywhere - and recommended deferring the whole
 * feature, building only the modal component (needed for item 20 anyway).
 * The human overrode that: build the plumbing now, seeded with exactly one
 * curated list, more to be added later by hand to this table.
 *
 * No verse *text* is bundled here, only references - the host app supplies
 * the actual text via `addReferences`, the same parser and RPC path a manual
 * paste already uses, so a reference here is exactly what an entry in a
 * pasted list would be.
 */

/** One curated, ready-made list a user can add in one press. */
export interface SuggestedList {
  id: string;
  /** Becomes the created collection's name. */
  name: string;
  /** Shown in the picker, under the name. */
  description: string;
  /** Passed through `addReferences` - the same parser manual paste uses. */
  references: string[];
}

/**
 * The catalogue itself. Exactly one entry today (the human's own words:
 * "one token list of the Romans Road for now... I will fill in the actual
 * lists later") - the classic, well-known "Romans Road" reference set, in
 * its traditional order. Public domain and reference-only; do not add verse
 * text here.
 */
export const SUGGESTED_LISTS: readonly SuggestedList[] = [
  {
    id: 'romans-road',
    name: 'Romans Road',
    description:
      'Five verses from Romans, traditionally used to walk through the message of salvation.',
    references: ['Romans 3:23', 'Romans 6:23', 'Romans 5:8', 'Romans 10:9-10', 'Romans 10:13'],
  },
];
