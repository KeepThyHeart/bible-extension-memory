/**
 * Which of the five screens is showing, and how we got there.
 *
 * There is no router and no history. A panel is a docked pane inside another
 * application; pushing entries onto the iframe's history would put a Back
 * gesture in a place the user has no reason to expect one, and popping it
 * would fight the host's own navigation. So view state is an ordinary value
 * and this module is an ordinary reducer over it - which has the pleasant side
 * effect that "where does leaving an activity return to?" is a pure function
 * with a unit test rather than a variable someone forgot to reset.
 *
 * DOM-free on purpose; see the note at the top of `format.ts`.
 */

/**
 * The six screens.
 *
 * Practice carries the session id rather than the session: the worker owns the
 * session, and a copy of it stored here would be a second source of truth that
 * goes stale the moment a step is submitted.
 */
export type View =
  | { name: 'plan' }
  | { name: 'passage'; passageId: number }
  | { name: 'analytics' }
  | { name: 'settings' }
  | { name: 'managePassages' }
  | { name: 'practice'; sessionId: string };

export interface NavState {
  view: View;
  /**
   * Where leaving an activity (Back, or finishing it) goes back to.
   *
   * A session started from the plan should return to the plan; one started
   * from a passage screen should return to that passage screen, because the
   * user was in the middle of working through one passage and dumping them
   * back at the top level loses their place. This is the entire reason the
   * reducer exists rather than a bare `view` variable.
   */
  returnTo: View;
}

export type NavAction =
  | { type: 'goPlan' }
  | { type: 'goAnalytics' }
  | { type: 'goSettings' }
  | { type: 'goManagePassages' }
  | { type: 'goPassage'; passageId: number }
  | { type: 'sessionStarted'; sessionId: string }
  | { type: 'sessionEnded' }
  /**
   * The passage the current view is about has gone away - removed here, or
   * removed in another panel and announced by a `planChanged` push. Any view
   * pinned to it has to be abandoned rather than left rendering a stale
   * reference that no longer resolves to anything.
   */
  | { type: 'passageRemoved'; passageId: number };

export const INITIAL_NAV: NavState = {
  view: { name: 'plan' },
  returnTo: { name: 'plan' },
};

export function navReduce(state: NavState, action: NavAction): NavState {
  switch (action.type) {
    case 'goPlan':
      return { view: { name: 'plan' }, returnTo: { name: 'plan' } };

    case 'goAnalytics':
      // Analytics is a leaf: it starts no sessions, so it is never a return
      // target. Leaving `returnTo` alone would strand a later session there.
      return { view: { name: 'analytics' }, returnTo: { name: 'plan' } };

    case 'goSettings':
      return { view: { name: 'settings' }, returnTo: { name: 'plan' } };

    case 'goManagePassages':
      // Also a leaf, for the same reason as Analytics and Settings above: it
      // starts no sessions, so it must not become a return target.
      return { view: { name: 'managePassages' }, returnTo: { name: 'plan' } };

    case 'goPassage':
      return {
        view: { name: 'passage', passageId: action.passageId },
        returnTo: { name: 'passage', passageId: action.passageId },
      };

    case 'sessionStarted':
      // `returnTo` is deliberately *not* recomputed here. Whatever view asked
      // for the session already set it, and practice must not become its own
      // return target or leaving it would land back in the finished session.
      return {
        view: { name: 'practice', sessionId: action.sessionId },
        returnTo: state.view.name === 'practice' ? state.returnTo : state.view,
      };

    case 'sessionEnded':
      if (state.view.name !== 'practice') return state;
      return { view: state.returnTo, returnTo: state.returnTo };

    case 'passageRemoved': {
      const stranded =
        (state.view.name === 'passage' && state.view.passageId === action.passageId) ||
        (state.returnTo.name === 'passage' && state.returnTo.passageId === action.passageId);
      if (!stranded) return state;
      // A practice session on a removed passage is left alone deliberately:
      // the worker still owns it and will end it, and yanking the screen out
      // from under someone mid-answer is worse than one stale header. Only the
      // destination is repaired.
      if (state.view.name === 'practice') {
        return { view: state.view, returnTo: { name: 'plan' } };
      }
      return { view: { name: 'plan' }, returnTo: { name: 'plan' } };
    }

    default:
      return state;
  }
}

/** True when the two views would render the same screen. */
export function sameView(a: View, b: View): boolean {
  if (a.name !== b.name) return false;
  if (a.name === 'passage' && b.name === 'passage') return a.passageId === b.passageId;
  if (a.name === 'practice' && b.name === 'practice') return a.sessionId === b.sessionId;
  return true;
}
