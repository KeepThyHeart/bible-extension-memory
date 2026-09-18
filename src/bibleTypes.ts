/**
 * Type-only aliases for the host API surface.
 *
 * Every import here is `import type`, so the whole file is erased at build
 * time. That matters for two reasons: the bundle stays pure first-party code
 * with no `@bible/core` runtime dependency (and so no licence entanglement),
 * and the realm - which has no module system - never sees a `require` for a
 * package that would not resolve inside it.
 *
 * Collecting the aliases in one file rather than importing `Extensions.*`
 * at every use site means the API version this extension is written against
 * is visible in exactly one place when it needs to move.
 */

import type { Extensions } from '@bible/core';

export type BibleExtensionAPI = Extensions.BibleExtensionAPI;
export type IExtensionDatabase = Extensions.IExtensionDatabase;
export type BibleVerseDto = Extensions.BibleVerseDto;
export type DisposableHandle = Extensions.DisposableHandle;
