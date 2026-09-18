/**
 * Activation wiring.
 *
 * These tests answer one question the unit suites cannot: **does this
 * extension actually attach itself to the host?** Every other test here
 * exercises a function directly. Nothing else checks that `activate` reaches
 * the end, that the panel is registered, or - the expensive one to get wrong -
 * that each `handlerEndpoint` named in `extension.json` is bound to a real
 * function.
 *
 * That last one deserves its own note. A `handlerEndpoint` is a *name*, not a
 * function; a function cannot survive the RPC hop from the worker to the host.
 * The host calls back with that name when the user runs the command, and if
 * nothing bound it, the command still appears in the palette and the Tools
 * menu and silently does nothing. There is no error, no warning, and no way to
 * tell it apart from a handler that ran and had nothing to do. It is the most
 * common mistake in this platform and it is invisible without a test.
 *
 * So the manifest is read from disk rather than restated here. A command added
 * to `extension.json` and never bound fails this file automatically, which is
 * the only version of this test worth having - one with the endpoint names
 * hard-coded would pass forever after the manifest moved on.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMockApi, getMockRuntimeEndpoints } from '@bible/extension-testing';

import { activate, deactivate } from '../src/main';

interface Manifest {
  id: string;
  permissions: string[];
  contributes?: {
    commands?: { id: string; handlerEndpoint: string }[];
    panelTypes?: { id: string }[];
  };
}

const manifest: Manifest = JSON.parse(
  readFileSync(join(__dirname, '..', 'extension.json'), 'utf8'),
) as Manifest;

/**
 * `activate` keeps module-level state, and the module is only evaluated once
 * per test file. Re-activating onto a fresh mock is what keeps one test's
 * registrations from being counted by the next.
 */
beforeEach(() => {
  vi.clearAllMocks();
});

describe('activation', () => {
  it('completes against a mock host', async () => {
    const api = createMockApi();
    await expect(activate(api)).resolves.toBeUndefined();
  });

  it('binds a handler for every command in extension.json', async () => {
    const api = createMockApi();
    await activate(api);

    const bound = getMockRuntimeEndpoints(api).list();
    const declared = (manifest.contributes?.commands ?? []).map((c) => c.handlerEndpoint);

    expect(declared.length).toBeGreaterThan(0);
    for (const endpoint of declared) {
      expect(bound).toContain(endpoint);
    }
  });

  it('registers every declared command with the host registry', async () => {
    // Binding the endpoint is only half of it. Nothing in the host reads
    // `contributes.commands`, so a command that is exposed but never
    // registered exists nowhere the user can reach: not the palette, not the
    // Tools menu, and not as the target of a context-menu item - which then
    // dangles, pointing at an id no registry knows.
    //
    // This extension had exactly that bug: both endpoints bound, neither
    // command registered.
    const register = vi.fn().mockResolvedValue({ dispose: vi.fn() });
    const api = createMockApi({ commands: { register } });

    await activate(api);

    const registered = register.mock.calls.map(
      (call) => (call[0] as { id: string }).id,
    );
    for (const command of manifest.contributes?.commands ?? []) {
      expect(registered).toContain(command.id);
    }
  });

  it('gives each registered command the endpoint its manifest declares', async () => {
    // A registration whose `handlerEndpoint` does not match what
    // `runtime.expose` bound invokes nothing, and looks identical to a
    // command that ran and had nothing to do.
    const register = vi.fn().mockResolvedValue({ dispose: vi.fn() });
    const api = createMockApi({ commands: { register } });

    await activate(api);

    const byId = new Map(
      register.mock.calls.map((call) => {
        const reg = call[0] as { id: string; handlerEndpoint: string };
        return [reg.id, reg.handlerEndpoint];
      }),
    );
    const bound = getMockRuntimeEndpoints(api).list();

    for (const command of manifest.contributes?.commands ?? []) {
      expect(byId.get(command.id)).toBe(command.handlerEndpoint);
      expect(bound).toContain(command.handlerEndpoint);
    }
  });

  it('declares a command id under its own extension id', async () => {
    // The registry rejects any extension command whose id does not start with
    // `<extensionId>.`, and until recently it built that prefix by prepending
    // a second `ext.` - so a correctly named command was refused and no
    // extension could register one at all. Cheap to assert, and it pins the
    // shape an author has to write.
    for (const command of manifest.contributes?.commands ?? []) {
      expect(command.id.startsWith(`${manifest.id}.`)).toBe(true);
    }
  });

  it('registers its panel type with the short id, not the qualified one', async () => {
    // The host composes the content type as `ext:<extensionId>.<id>`, so
    // passing the fully-qualified id here yields `ext:ext.a.b.ext.a.b.panel`.
    const registerPanelType = vi.fn().mockResolvedValue({ dispose: vi.fn() });
    const api = createMockApi({ ui: { registerPanelType } });

    await activate(api);

    expect(registerPanelType).toHaveBeenCalledTimes(1);
    const def = registerPanelType.mock.calls[0]?.[0] as { id: string; uiEntry: string };
    expect(def.id).toBe('panel');
    expect(def.id).not.toContain(manifest.id);
    expect(def.uiEntry).toBe('ui/index.html');
  });

  it('subscribes to active verse changes', async () => {
    const subscribe = vi.fn().mockResolvedValue({ dispose: vi.fn() });
    const api = createMockApi({ bible: { onDidChangeActiveVerse: { subscribe } } });

    await activate(api);

    expect(subscribe).toHaveBeenCalled();
  });

  it('contributes a verse context menu item pointing at a bound command', async () => {
    const registerContextMenu = vi.fn().mockResolvedValue({ dispose: vi.fn() });
    const api = createMockApi({ ui: { registerContextMenu } });

    await activate(api);

    expect(registerContextMenu).toHaveBeenCalledWith(
      'verse',
      expect.objectContaining({ command: `${manifest.id}.addActiveVerse` }),
    );

    // The menu item is useless if the command it names is not bound - the item
    // appears, the user clicks it, nothing happens.
    expect(getMockRuntimeEndpoints(api).list()).toContain('addActiveVerse');
  });

  it('deactivates without throwing', () => {
    expect(() => deactivate()).not.toThrow();
  });
});

describe('permission failure', () => {
  it('does not throw when storage is refused, and registers nothing', async () => {
    // Only `bible:read` and `commands:register` are auto-granted, and
    // sideloading - which includes "Load unpacked extension" - grants ONLY
    // those regardless of what the manifest declares. So a refused
    // `openDatabase` is the single most likely thing to happen on a first run.
    //
    // Throwing here would have the host report a broken extension, which is
    // misleading: nothing is broken, a permission is simply missing. The
    // extension has to come up inert and say so.
    const registerPanelType = vi.fn().mockResolvedValue({ dispose: vi.fn() });
    const api = createMockApi({
      storage: {
        openDatabase: vi.fn().mockRejectedValue(new Error('PermissionDenied: storage:database')),
      },
      ui: { registerPanelType },
    });

    await expect(activate(api)).resolves.toBeUndefined();
    expect(registerPanelType).not.toHaveBeenCalled();
  });
});

describe('the manifest itself', () => {
  it('declares every permission the code relies on', () => {
    // Drift between what the code calls and what the manifest asks for is
    // silent until a user hits the one code path that needs the missing grant.
    for (const permission of [
      'bible:read',
      'storage:database',
      'ui:contribute-pane',
      'ui:context-menu',
      'ui:status-bar',
      'ui:notification',
      'commands:register',
    ]) {
      expect(manifest.permissions).toContain(permission);
    }
  });
});
