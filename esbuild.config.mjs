import { build, context } from 'esbuild';

/**
 * Extensions load as ONE self-contained file. The host evaluates it inside a
 * sandboxed QuickJS realm that has no module system at all — `require` exists
 * only to throw a message telling you to bundle — so anything your entry point
 * imports has to be inlined here at build time.
 */
const options = {
  entryPoints: ['src/main.ts'],
  outfile: 'dist/main.js',
  bundle: true,

  // CommonJS, NOT ESM. The host wraps your bundle in
  // `(function (exports, module, require) { … })`, so `export` syntax is a
  // parse error inside the realm. Author in ESM; ship CJS.
  format: 'cjs',

  // 'neutral' is a tripwire, and the most useful line in this file: it makes
  // `import fs from 'fs'` fail at BUILD time with "Could not resolve", instead
  // of at runtime inside a realm that has no filesystem. If a dependency of
  // yours needs Node built-ins, it cannot run as an extension.
  platform: 'neutral',
  mainFields: ['module', 'main'],
  conditions: ['import', 'default'],

  target: 'es2020',
  sourcemap: true,
  logLevel: 'info',
};

/**
 * The panel is a SEPARATE build with different rules. It runs in an ordinary
 * browser iframe, so it gets platform: 'browser' and the DOM — and it must be
 * an external file, because the panel document is served under
 * `script-src 'self' ext-ui://host` with no 'unsafe-inline'. An inline
 * <script> in ui/index.html is blocked with no visible error.
 *
 * @bible/extension-ui is bundled in here rather than loaded from the host:
 * nothing serves the SDK from the ext-ui://host origin, so the only way a
 * panel can use it is inlined into a file inside the extension package.
 */
const panelOptions = {
  entryPoints: ['src/panel.ts'],
  outfile: 'ui/panel.js',
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2020',
  sourcemap: true,
  logLevel: 'info',
};

if (process.argv.includes('--watch')) {
  const ctxs = await Promise.all([context(options), context(panelOptions)]);
  await Promise.all(ctxs.map((c) => c.watch()));
  console.log('esbuild: watching for changes…');
} else {
  await Promise.all([build(options), build(panelOptions)]);
}
