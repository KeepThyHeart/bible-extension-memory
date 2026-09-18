/**
 * The typed edge of `postToWorker`.
 *
 * `BibleExtUI.postToWorker<T>(message: unknown)` is deliberately untyped on
 * the host side - it has no idea what protocol any given extension speaks. The
 * cost of that is a panel where every call site independently asserts what
 * came back, and where a typo in a `type` string is a runtime mystery rather
 * than a compile error. This module spends thirty lines to buy the whole panel
 * a checked protocol: pass a `PanelRequest` and the reply's `data` is narrowed
 * to the matching entry of `RequestMap` by the request's own `type`.
 *
 * It also flattens the two very different ways a call can fail into the one
 * shape the UI has to render.
 */

import type { PanelReply, PanelRequest, RequestMap } from '../types';

/** The only thing this module needs from the SDK - keeps it easy to fake. */
export interface WorkerPoster {
  postToWorker<T = unknown>(message: unknown): Promise<T>;
}

/**
 * Sends a request and always resolves - never rejects.
 *
 * There are two failure modes and the user cannot tell them apart, so neither
 * should be allowed to reach a `catch` that a call site might forget:
 *
 *   - The worker answered with `{ ok: false, error }`. This is the *expected*
 *     failure: "John 3:99 is not a verse". `types.ts` routes these as data
 *     specifically because an exception across the boundary arrives as an
 *     opaque RPC error with the useful part stripped off.
 *   - The transport itself failed - extension inactive, handler unregistered,
 *     over 256 KB, or ten seconds with no reply. `postToWorker` rejects.
 *
 * Both come back here as `{ ok: false, error }` so that every screen has
 * exactly one error path to render and no screen can silently swallow one.
 */
export async function call<R extends PanelRequest>(
  poster: WorkerPoster,
  request: R,
): Promise<PanelReply<RequestMap[R['type']]>> {
  try {
    const reply = await poster.postToWorker<PanelReply<RequestMap[R['type']]>>(request);

    // A worker that answered with something other than the agreed envelope is
    // a bug, but it must not crash the panel: an undefined `.ok` would sail
    // through as falsy and be rendered as an error with no message at all.
    if (!reply || typeof reply !== 'object' || typeof (reply as { ok?: unknown }).ok !== 'boolean') {
      return { ok: false, error: `The extension sent a malformed reply to "${request.type}".` };
    }
    return reply;
  } catch (err) {
    return { ok: false, error: describeTransportFailure(request.type, err) };
  }
}

/**
 * Turns a rejected `postToWorker` into something worth reading.
 *
 * The bare message is usually "Timeout" or "Extension not active", neither of
 * which tells the user what to do. Naming the request at least says which part
 * of the screen is broken, which is the difference between a bug report and a
 * shrug.
 */
function describeTransportFailure(type: string, err: unknown): string {
  const detail = err instanceof Error ? err.message : String(err);
  return `Could not reach the Scripture Memory worker (${type}): ${detail}`;
}
