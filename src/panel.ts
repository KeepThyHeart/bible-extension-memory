/**
 * The Scripture Memory panel.
 *
 * This file is the only one that knows about the SDK, the clock, or which
 * screen is showing. The four views are handed a `PanelHost` (see
 * `ui/host.ts`) and can do nothing except through it, which keeps the number
 * of places that can start a session or fire a request down to one.
 *
 * Two platform facts shape everything here and are worth restating where
 * someone will read them:
 *
 *   1. This document has no `api.*`. The panel runs on its own sandboxed
 *      `ext-ui://` origin under `default-src 'none'`; every capability it has
 *      belongs to the worker, and `postToWorker` is the only door. That is not
 *      an inconvenience to be routed around - it is the reason a panel cannot
 *      escalate its extension's permissions.
 *   2. Scripts must be external files. `script-src 'self' ext-ui://host` has
 *      no `'unsafe-inline'`, so an inline `<script>` in `ui/index.html` is
 *      dropped silently, with nothing in the console to say so.
 *      `ui/index.html` loads `ui/panel.js`, which esbuild builds from here.
 */

import { BibleExtUI } from '@bible/extension-ui';
import type { ThemeInfo } from '@bible/extension-ui';

import type { PanelReply, PanelRequest, PassageView, RequestMap, Rung } from './types';
import { clear, el } from './ui/dom';
import { errorBanner } from './ui/components';
import { pickFlowTarget } from './ui/format';
import type { PanelHost } from './ui/host';
import { WordMeasurer } from './ui/measure';
import { PracticeView } from './ui/practiceView';
import { renderPlan } from './ui/planView';
import { renderAnalytics } from './ui/analyticsView';
import { renderPassageScreen } from './ui/passageView';
import { renderSettings } from './ui/settingsView';
import { call } from './ui/rpc';
import { INITIAL_NAV, navReduce, sameView } from './ui/state';
import type { Flow, NavAction, NavState } from './ui/state';

const bible = BibleExtUI.init();

// ---------------------------------------------------------------------------
// Shell
// ---------------------------------------------------------------------------

function requireElement(id: string): HTMLElement {
  const node = document.getElementById(id);
  if (!node) {
    // Nothing useful can happen without the shell, and a null check threaded
    // through every view is worse than one loud failure at startup.
    throw new Error(`Panel markup is missing #${id}. ui/index.html and panel.js disagree.`);
  }
  return node;
}

const main = requireElement('sm-main');
const status = requireElement('sm-status');

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let nav: NavState = INITIAL_NAV;
let practice: PracticeView | null = null;
let activeReference: string | null = null;

/**
 * Guards against an out-of-order paint.
 *
 * Every screen fetches its own data, so two quick navigations can leave two
 * requests in flight; without this the slower one wins and paints a screen the
 * user has already left. Each render takes a ticket and discards its result if
 * a newer one has been issued in the meantime.
 */
let renderToken = 0;

const measurer = new WordMeasurer(document);

// ---------------------------------------------------------------------------
// The host handed to every view
// ---------------------------------------------------------------------------

const host: PanelHost = {
  now: () => Date.now(),

  request<R extends PanelRequest>(request: R): Promise<PanelReply<RequestMap[R['type']]>> {
    return call(bible, request);
  },

  go(action: NavAction): void {
    const next = navReduce(nav, action);
    const changed = !sameView(next.view, nav.view) || !sameView(next.returnTo, nav.returnTo);
    nav = next;
    if (changed) void render();
  },

  reload(): void {
    void render();
  },

  measurer,

  get activeReference(): string | null {
    return activeReference;
  },

  async startSession(passageId: number, rung?: Rung, restart?: boolean, flow?: Flow): Promise<void> {
    // Optional keys are omitted entirely rather than sent as `undefined`.
    // `types.ts` requires structured-cloneable JSON, and an explicit
    // `undefined` is the one value that does not survive that trip intact -
    // it would arrive as a missing key on some paths and as `null` on others.
    const request: PanelRequest = {
      type: 'startSession',
      passageId,
      ...(rung !== undefined ? { rung } : {}),
      ...(restart ? { restart: true } : {}),
    };

    const reply = await call(bible, request);
    if (!reply.ok) {
      showError(reply.error);
      return;
    }
    const session = reply.data as RequestMap['startSession'];

    // Every call site today (the passage screen's Practice/Resume/Restart,
    // the practice screen's own tab strip and "Next due") names one specific
    // passage the user was already looking at, not a flow - only `startFlow`
    // below and the practice screen's Next button ever pass one. Defaulting
    // here, rather than in `NavAction`/`navReduce`, keeps `sessionStarted` a
    // plain record of what happened instead of a second place that has to
    // know this default.
    const sessionFlow: Flow = flow ?? { kind: 'passage', passageId: session.passageId };

    host.go({
      type: 'sessionStarted',
      sessionId: session.sessionId,
      passageId: session.passageId,
      rung: session.rung,
      flow: sessionFlow,
    });

    // `render()` deliberately leaves the practice screen alone - that view
    // owns its own DOM and its own lifetime - so the mount happens here.
    practice?.destroy();
    clear(main);
    practice = new PracticeView(host, session, sessionFlow);
    practice.mount(main);
    announce('');
  },

  async startFlow(flow: Flow, exclude?: ReadonlySet<number>): Promise<void> {
    const reply = await host.request({ type: 'getPlan' });
    if (!reply.ok) {
      showError(reply.error);
      return;
    }
    const target = pickFlowTarget(reply.data, flow, host.now(), exclude);
    if (!target) {
      // Same degrade as the summary screen's "Next due" button when nothing
      // is due: say so and stop, rather than starting nothing silently or
      // leaving the caller (the Next button) mid-navigation.
      announce('Nothing else to practice right now.');
      return;
    }
    await host.startSession(target.passageId, target.rung, undefined, flow);
  },

  openInBible(verseId: number): void {
    void call(bible, { type: 'navigateTo', verseId }).then((reply) => {
      if (!reply.ok) showError(reply.error);
    });
  },

  announce,
};

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

async function render(): Promise<void> {
  const token = ++renderToken;

  if (practice !== null && nav.view.name !== 'practice') {
    practice.destroy();
    practice = null;
  }

  // Practice mounts itself in `startSession`. Re-rendering it from here would
  // destroy a half-answered step every time a `planChanged` push arrived.
  if (nav.view.name === 'practice') return;

  const content = await buildScreen();
  if (token !== renderToken) return;

  clear(main);
  main.appendChild(content);

  // Move focus to the new screen's heading, so a keyboard or screen-reader
  // user is not left at the top of the document after every navigation.
  // `tabindex="-1"` makes it focusable without putting it in the tab order.
  const heading = main.querySelector<HTMLElement>('h1');
  if (heading) {
    heading.tabIndex = -1;
    heading.focus({ preventScroll: true });
  }
}

async function buildScreen(): Promise<HTMLElement> {
  switch (nav.view.name) {
    case 'plan': {
      const reply = await host.request({ type: 'getPlan' });
      return reply.ok ? renderPlan(host, reply.data) : failure(reply.error);
    }

    case 'passage': {
      // There is no `getPassage` in the protocol, so this screen reads the
      // plan and picks its passage out of it. That is a larger reply than this
      // screen needs, but it is one request rather than two and it guarantees
      // this screen and the plan can never disagree about a passage's levels.
      const passageId = nav.view.passageId;
      const reply = await host.request({ type: 'getPlan' });
      if (!reply.ok) return failure(reply.error);

      const found: PassageView | undefined = reply.data.passages.find(
        (p) => p.passage.id === passageId,
      );
      if (!found) {
        // Removed elsewhere between the click and the fetch.
        announce('That passage is no longer in your plan.');
        nav = navReduce(nav, { type: 'passageRemoved', passageId });
        return renderPlan(host, reply.data);
      }
      return renderPassageScreen(host, found, reply.data.defaultAnswerMode, nav.view.rung);
    }

    case 'analytics': {
      const reply = await host.request({ type: 'getAnalytics' });
      return reply.ok ? renderAnalytics(host, reply.data) : failure(reply.error);
    }

    case 'settings': {
      const [settingsReply, planReply] = await Promise.all([
        host.request({ type: 'getSettings' }),
        host.request({ type: 'getPlan' }),
      ]);
      if (!settingsReply.ok) return failure(settingsReply.error);
      if (!planReply.ok) return failure(planReply.error);
      return renderSettings(host, settingsReply.data, planReply.data);
    }

    default:
      return failure('Unknown screen.');
  }
}

function failure(message: string): HTMLElement {
  return el('section', { class: 'sm-screen' }, [
    el('h1', { class: 'sm-screen-title', text: 'Scripture Memory' }),
    errorBanner(message),
  ]);
}

// ---------------------------------------------------------------------------
// Status line
// ---------------------------------------------------------------------------

let statusTimer = 0;

/**
 * A transient line at the foot of the panel.
 *
 * `aria-live="polite"` on a region that is always in the document - the same
 * reason as in `practiceView.ts`: a live region created at the same instant as
 * its content is frequently not announced at all.
 */
function announce(message: string): void {
  status.textContent = message;
  status.classList.remove('sm-status-error');
  window.clearTimeout(statusTimer);
  if (message === '') return;
  statusTimer = window.setTimeout(() => {
    status.textContent = '';
  }, 6000);
}

function showError(message: string): void {
  announce(message);
  status.classList.add('sm-status-error');
}

// ---------------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------------

/**
 * Keeping the panel in step with the app's theme.
 *
 * The host serves its design tokens at `ext-ui://host/theme.css` and
 * `ui/index.html` links it. What that sheet contains is a single flattened
 * `:root` block for whichever theme was active *when the panel document
 * loaded*: there is no `data-theme` switching inside it, and
 * `prefers-color-scheme` has nothing to do with it. So a panel that is already
 * open when the user changes theme keeps the old palette until it reloads -
 * which, for a pane docked on the right, could be days.
 *
 * `onThemeChanged` is the only live signal a panel gets, and this is what it
 * is spent on. Two things happen on a change:
 *
 *   1. Any custom properties in `ThemeInfo.colors` are written to the root
 *      element as inline styles, which beat the linked sheet on specificity
 *      and so take effect immediately.
 *   2. The host sheet is re-linked with a cache-busting query, so the newly
 *      flattened block replaces the stale one. It is served `no-store`, so
 *      that is a real round trip rather than a cache hit.
 *
 * The re-link adds the new `<link>` and only removes the old one once the new
 * one has loaded. Swapping in place would leave the panel with no tokens at
 * all for as long as the request took - and permanently, if the query string
 * turned out not to resolve on the host origin.
 */
let themeVersion = 0;

function applyTheme(theme: ThemeInfo, relink: boolean): void {
  document.documentElement.setAttribute('data-theme-mode', theme.mode);

  if (theme.colors) {
    for (const [name, value] of Object.entries(theme.colors)) {
      document.documentElement.style.setProperty(
        name.startsWith('--') ? name : `--${name}`,
        value,
      );
    }
  }

  if (relink) reloadHostTheme();
}

function reloadHostTheme(): void {
  const previous = document.querySelector<HTMLLinkElement>('link[data-host-theme]');
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.setAttribute('data-host-theme', '');
  link.href = `ext-ui://host/theme.css?v=${++themeVersion}`;

  link.addEventListener('load', () => previous?.remove());
  // A 404 - most plausibly because the host does not tolerate the query
  // string - must not cost the panel the tokens it already had.
  link.addEventListener('error', () => link.remove());

  document.head.appendChild(link);
}

// ---------------------------------------------------------------------------
// Worker pushes
// ---------------------------------------------------------------------------

bible.onWorkerMessage((message) => {
  const push = message as { type?: string; count?: number; reference?: string };

  switch (push.type) {
    case 'planChanged':
      // Not while an exercise is open. A push is a hint that something changed
      // elsewhere; it is not worth throwing away a half-typed verse for.
      if (nav.view.name !== 'practice') void render();
      return;

    case 'dueCountChanged':
      if (typeof push.count === 'number' && nav.view.name === 'plan') void render();
      return;

    case 'activeVerse':
      if (typeof push.reference !== 'string') return;
      activeReference = push.reference;
      updateAddPlaceholder(push.reference);
      return;

    default:
      return;
  }
});

/**
 * Retargets the add-passage field's placeholder as the user reads.
 *
 * A surgical DOM poke rather than a re-render, and only when the field is
 * empty and unfocused: redrawing the plan for every verse the user scrolls
 * past would destroy a reference they were halfway through typing, and
 * changing a placeholder under an active caret is its own small rudeness.
 */
function updateAddPlaceholder(reference: string): void {
  const input = document.getElementById('sm-add-reference');
  if (!(input instanceof HTMLInputElement)) return;
  if (input.value !== '' || document.activeElement === input) return;
  input.placeholder = reference;
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

bible.onThemeChanged((theme) => applyTheme(theme, true));

void bible
  .getTheme()
  // No re-link on the first read: `ui/index.html` has already linked the sheet
  // for the theme that was active at load, and this call is only being made to
  // pick up whatever extra custom properties `ThemeInfo.colors` carries.
  .then((theme) => applyTheme(theme, false))
  // The theme is a nicety - the panel is fully usable on the linked sheet and
  // the fallbacks in `styles.css` - so a failure here is logged and no more.
  .catch((err: unknown) => console.warn('Scripture Memory: could not read the host theme', err));

void render();
