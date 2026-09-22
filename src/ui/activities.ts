/**
 * The six activity tiles, as one declarative table.
 *
 * DOM-free, per the note at the top of `format.ts`: this is the copy the
 * home screen's tile grid (M2) will render, and keeping it as data rather
 * than markup means a test can assert the catalogue's shape and wording
 * directly, without a browser.
 *
 * `id` doubles as the key `components.ts#icon()` already expects - its
 * `IconName` union (minus the two chrome names `home`/`menu`) is exactly
 * these six, so a tile and its icon are always looked up the same way.
 *
 * `rung` is `null` for exactly one tile now: `variety` is not one activity
 * but a mix of them, so no single `Rung` names it. Every other tile - M7
 * landed `provideref` as a real `Rung` (`types.ts`) - names its own.
 * `format.ts#activityAvailability` is what decides whether a tile can be
 * pressed right now - this table only says what the tile is called and what
 * it does.
 */

import type { Rung } from '../types';

/** The six tile ids - see the file header for why `variety` is not a `Rung`. */
export type ActivityId = 'variety' | 'refmatch' | 'ordering' | 'blanks' | 'firstletters' | 'provideref';

/** One row of the tile catalogue. */
export interface ActivityTile {
  id: ActivityId;
  /** The `Rung` this tile starts, or `null` for `variety` (see above). */
  rung: Rung | null;
  title: string;
  subtext: string;
}

/**
 * The tile catalogue, in the order the design doc's table lists them and the
 * grid (M2) is expected to draw them.
 *
 * Copy is verbatim from the design doc - do not paraphrase it here even for
 * a small consistency fix; change the doc first.
 */
export const ACTIVITY_TILES: readonly ActivityTile[] = [
  {
    id: 'variety',
    rung: null,
    title: 'Variety',
    subtext: "A mix of activities based on what's next in better learning your verse list.",
  },
  {
    id: 'refmatch',
    rung: 'refmatch',
    title: 'Match References',
    subtext: "Match a passage's text to its reference.",
  },
  {
    id: 'ordering',
    rung: 'ordering',
    title: 'Put in Order',
    subtext: 'A passage has its verses shuffled, and you put them in order.',
  },
  {
    id: 'blanks',
    rung: 'blanks',
    title: 'Fill in the Blanks',
    subtext: 'A passage is shown with blanks, and you provide the first letter or the entire word for each blank.',
  },
  {
    id: 'firstletters',
    rung: 'firstletters',
    title: 'First Letters',
    subtext: 'A passage reference is given, and you type the first letter of each word, in order.',
  },
  {
    id: 'provideref',
    rung: 'provideref',
    title: 'Provide Reference',
    subtext: 'The passage text is shown, and you type its reference.',
  },
];
