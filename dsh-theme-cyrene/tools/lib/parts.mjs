// Turn the raw browser-half parts into something that can actually be run.
//
// build.mjs fills eight placeholders with generated JSON manifests, each written
// as a comment so the un-built parts still look like valid source:
//
//   var WALLPAPERS = /*__CYRENE_WALLPAPERS__*/;
//
// They are NOT valid JavaScript on their own. Any tool that reassembles the
// parts outside the build — a probe, a syntax check — has to substitute them
// first, or it dies on "Unexpected token ';'" at 10-constants.js and reports a
// bug that does not exist in the shipped bundle.

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(HERE, "..", "..");
export const PARTS_DIR = join(ROOT, "lib", "client");

/** The markers that carry a list, in build.mjs order. */
export const MARKERS = [
  "WALLPAPERS",
  "COVERS",
  "MUSIC",
  "BOOT",
  "EMOTES",
  "PET",
];

/**
 * The markers that carry a single value or nothing, not a list.
 *
 * `AVATAR` and `DISC` are URL strings, `CELEBRATE` is `{art, last, ms}`, and
 * each is null when its asset is missing — `build.mjs` writes them with
 * `JSON.stringify`. Filling them with `[]`, which is what happens if every
 * marker is treated alike, parses fine but hands an *array* to `avatar.src`;
 * the probe then reports a broken portrait for a bundle that is fine.
 *
 * This list, and `MARKERS` above, must stay in step with `build.mjs`'s `MARKERS`
 * — a marker missing from both is not caught by the substitution loop, and the
 * failure surfaces later as "Unexpected token ';'" from a tool that was working
 * a minute ago.
 */
export const SCALAR_MARKERS = ["AVATAR", "DISC", "CELEBRATE"];

/** Part filenames in build order (filename order, same as build.mjs). */
export function partNames() {
  return readdirSync(PARTS_DIR)
    .filter((name) => name.endsWith(".js"))
    .sort((left, right) => left.localeCompare(right));
}

/**
 * Substitute every placeholder with a JSON literal.
 * @param {string} code - concatenated part source.
 * @param {Record<string, string>} [values] - marker name to JSON text.
 * @returns {string} code with no placeholders left.
 */
export function fillMarkers(code, values = {}) {
  let out = code;
  for (const name of [...MARKERS, ...SCALAR_MARKERS]) {
    const marker = `/*__CYRENE_${name}__*/`;
    const fallback = SCALAR_MARKERS.includes(name) ? "null" : "[]";
    const json = values[name] ?? fallback;
    if (!out.includes(marker)) continue;
    out = out.split(marker).join(json);
  }
  return out;
}

/**
 * Concatenate the parts the way build.mjs does, with placeholders filled.
 * @param {Record<string, string>} [values] - marker overrides.
 * @returns {{code: string, parts: string[]}} runnable source and part names.
 */
export function loadParts(values = {}) {
  const parts = partNames();
  const raw = parts.map((name) => readFileSync(join(PARTS_DIR, name), "utf8")).join("\n");
  return { code: fillMarkers(raw, values), parts };
}

/**
 * Unwrap the assembled code down to the factory body.
 *
 * `buildMusicPanel` and friends are locals inside the factory passed to
 * `window.__ModuleLoader__.load(...)`, so they are unreachable from outside it —
 * a probe cannot call them without either running the factory or reaching into
 * its body. This returns that body, ready to be dropped into a scope of our own.
 *
 * Mirrors what test/harness.mjs does for the same reason.
 *
 * @param {string} code - assembled part source.
 * @returns {string} the factory body, without its wrapper or trailing return.
 */
export function factoryBody(code) {
  const start = code.indexOf("factory:");
  if (start === -1) throw new Error("no `factory:` in the assembled code");
  const open = code.indexOf("{", code.indexOf("=>", start));
  if (open === -1) throw new Error("no factory body after `=>`");
  const end = code.lastIndexOf("return module.exports;");
  if (end === -1 || end < open) throw new Error("no `return module.exports;` closing the factory");
  return code.slice(open + 1, end);
}

