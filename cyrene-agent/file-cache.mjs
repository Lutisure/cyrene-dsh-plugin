/**
 * A file reader that re-reads only when the file has actually changed.
 *
 * Two plugins need the same thing: data that lives in a file, is read once per
 * turn, and should reflect an edit without a DSH restart. Writing that twice
 * means writing the mtime-cache bug twice, so it lives here.
 *
 * The contract, and why each clause exists:
 *
 *  - **Never throws.** Every caller runs inside the model loop, where a throw
 *    takes down the whole turn. A broken data file must cost the data, not the
 *    conversation.
 *  - **Keeps the last good value.** If a file becomes unreadable after having
 *    been read successfully, returning the previous value keeps the feature
 *    alive instead of blanking it. A half-written file during an edit is the
 *    common case, and it should not cost a turn its persona.
 *  - **Warns once.** These readers run every turn; a warning per turn would bury
 *    the real error under its own repetition.
 *  - **`null` when it has never succeeded**, so the caller decides what an
 *    absent file means — an empty worldbook and an empty persona are different
 *    things, and neither is the loader's business.
 */

import { readFileSync, statSync } from 'node:fs';

/**
 * Build a cached reader for one file.
 *
 * @param {string|null} file - the path, or null when it could not be resolved.
 * @param {(text: string) => any} parse - turns the file's text into the value.
 * @param {{label?: string, warn?: (message: string) => void}} [options] - diagnostics.
 * @returns {() => any} the reader, returning `null` until a read succeeds.
 */
export function createCachedReader(file, parse, options = {}) {
  const label = options.label ?? 'file';
  const warn = typeof options.warn === 'function' ? options.warn : () => {};

  let cached = null;
  let stamp = null;
  let lastGood = null;
  let warned = false;

  return function read() {
    if (file === null) return lastGood;
    try {
      const stat = statSync(file);
      // Size is part of the key as well as mtime: two writes inside the same
      // millisecond share an mtime, and an editor that rewrites a file in place
      // can land both within one tick.
      const key = `${stat.mtimeMs}:${stat.size}`;
      if (cached !== null && key === stamp) return cached;

      const value = parse(readFileSync(file, 'utf8'));
      cached = value;
      stamp = key;
      lastGood = value;
      // A successful read clears the warning latch, so a later break is reported
      // rather than swallowed by the first one having been reported already.
      warned = false;
      return value;
    } catch (error) {
      if (!warned) {
        warned = true;
        warn(`${label} 读取失败（${file}）：${String(error?.message ?? error)}`);
      }
      return lastGood;
    }
  };
}

/**
 * Write one diagnostic line to stderr, if there is one.
 *
 * Detached from the reader so the tests can capture messages instead of letting
 * them escape to the terminal.
 *
 * @param {string} scope - the plugin name to prefix with.
 * @returns {(message: string) => void} the writer.
 */
export function stderrWriter(scope) {
  return (message) => {
    try {
      process.stderr.write(`[${scope}] ${message}\n`);
    } catch {
      /* 连 stderr 都写不了就只能放弃 */
    }
  };
}
