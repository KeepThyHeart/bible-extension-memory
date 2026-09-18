/**
 * `versesFromMenuArgs`: reading what the host says was right-clicked.
 *
 * The verse context menu used to reach the worker with no verse at all, so
 * the handler fell back to the active verse - which a right-click does not
 * change. Hosts now merge `verse` into the command's args; these pin how that
 * is read, and that anything else falls back rather than guessing.
 */

import { describe, it, expect } from 'vitest';

import { versesFromMenuArgs } from '../src/main';

describe('versesFromMenuArgs', () => {
  it('reads a single clicked verse and its translation', () => {
    expect(
      versesFromMenuArgs({ verse: { verseId: 43003016, verseIds: [43003016], module: 'KJV' } }),
    ).toEqual({ start: 43003016, end: 43003016, module: 'KJV' });
  });

  it('turns a contiguous selection within one chapter into a range', () => {
    expect(
      versesFromMenuArgs({
        verse: { verseId: 19023002, verseIds: [19023003, 19023001, 19023002], module: 'ASV' },
      }),
    ).toEqual({ start: 19023001, end: 19023003, module: 'ASV' });
  });

  it('falls back to the first verse for a gapped or cross-chapter selection', () => {
    expect(
      versesFromMenuArgs({ verse: { verseId: 19023001, verseIds: [19023001, 19023004] } }),
    ).toEqual({ start: 19023001, end: 19023001 });
    expect(
      versesFromMenuArgs({ verse: { verseId: 19022031, verseIds: [19022031, 19023001] } }),
    ).toEqual({ start: 19022031, end: 19022031 });
  });

  it('returns null when the host sent no verse', () => {
    expect(versesFromMenuArgs(undefined)).toBeNull();
    expect(versesFromMenuArgs({})).toBeNull();
    expect(versesFromMenuArgs('palette')).toBeNull();
    expect(versesFromMenuArgs({ verse: { verseId: 'nope' } })).toBeNull();
  });
});
