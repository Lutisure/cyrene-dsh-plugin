/**
 * The plugin's identity, in one place, read from `package.json`.
 *
 * The host keys three separate things on this exact string: the client module
 * loader registers the browser half under it, `claimStyles(id)` /
 * `removeOwnedStyles(id)` claim and drop the plugin's `<style>` tags by
 * matching `style[data-plugin]` against it, and the manifest envelope names the
 * plugin with it.
 *
 * Tests used to spell the bare `dsh-theme-cyrene` out at every one of those
 * sites. That worked right up until the package gained its `@lutisure/` scope —
 * at which point the id and the package name really had drifted apart, and 183
 * assertions failed while pointing at nothing. Reading the name here means a
 * rename is a one-line change in `package.json` and the tests follow.
 *
 * This is a separate module rather than an export of `harness.mjs` so the
 * host-side tests — which never touch the browser harness — can use it too.
 */
import { readFileSync } from 'node:fs';

export const PLUGIN_ID = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8')
).name;

/**
 * Storage keys and on-disk format markers, which deliberately keep the
 * historical bare prefix.
 *
 * They are persisted data, not identity: re-scoping them would reset the user's
 * settings and make already-exported theme packages un-importable, for no gain,
 * because the host never reads them.
 */
export const STORAGE_KEY = 'dsh-theme-cyrene:settings';
export const UNDO_KEY = 'dsh-theme-cyrene:undo';
export const PACKAGE_KIND = 'dsh-theme-cyrene';
export const FONTSET_KIND = 'dsh-theme-cyrene-fontsets';
