/**
 * Pure helpers for the host half: HTTP Range parsing, path containment,
 * filename sanitisation and media typing.
 *
 * Deliberately free of `node:fs` side effects so every rule here is unit
 * testable — these are the parts where a mistake is either a security hole
 * (traversal) or a silently broken feature (no seeking in the music player).
 *
 * @module dsh-theme-cyrene/assets
 */

import { basename, extname, resolve, sep } from 'node:path';

/** Extension → MIME type for everything this theme serves. */
export const MIME = Object.freeze({
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.avif': 'image/avif',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.flac': 'audio/flac',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.opus': 'audio/opus',
  '.wav': 'audio/wav',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8'
});

/** Extension → coarse media kind used by the client's pickers. */
const KIND = Object.freeze({
  '.jpg': 'image',
  '.jpeg': 'image',
  '.png': 'image',
  '.webp': 'image',
  '.gif': 'image',
  '.avif': 'image',
  '.mp4': 'video',
  '.webm': 'video',
  '.mov': 'video',
  '.mp3': 'audio',
  '.m4a': 'audio',
  '.flac': 'audio',
  '.ogg': 'audio',
  '.oga': 'audio',
  '.opus': 'audio',
  '.wav': 'audio'
});

/** Extensions accepted per upload kind. */
export const ACCEPTED = Object.freeze({
  wallpaper: Object.freeze(['.jpg', '.jpeg', '.png', '.webp', '.avif', '.mp4', '.webm']),
  music: Object.freeze(['.mp3', '.m4a', '.flac', '.ogg', '.oga', '.opus', '.wav']),
  cover: Object.freeze(['.jpg', '.jpeg', '.png', '.webp']),
  emote: Object.freeze(['.gif', '.png', '.webp']),
  boot: Object.freeze(['.gif', '.webp', '.png'])
});

/**
 * MIME type for a filename, falling back to a non-sniffable binary type.
 * @param {string} file - filename or path.
 * @returns {string} a MIME type.
 */
export function mimeFor(file) {
  return MIME[extname(String(file)).toLowerCase()] ?? 'application/octet-stream';
}

/**
 * Coarse media kind (`image` / `video` / `audio`) for a filename.
 * @param {string} file - filename or path.
 * @returns {string|undefined} the kind, or undefined when unsupported.
 */
export function kindFor(file) {
  return KIND[extname(String(file)).toLowerCase()];
}

/**
 * Whether a filename is accepted for an upload kind.
 * @param {string} kind - one of {@link ACCEPTED}'s keys.
 * @param {string} file - the candidate filename.
 * @returns {boolean} true when the extension is allowed for that kind.
 */
export function acceptsUpload(kind, file) {
  const allowed = ACCEPTED[kind];
  if (allowed === undefined) return false;
  return allowed.includes(extname(String(file)).toLowerCase());
}

/**
 * Parse a `Range` request header against a known resource size.
 *
 * Returns a discriminated result rather than throwing, so the caller decides
 * the status code:
 * - `none`          → no usable Range header; serve `200` with the whole body.
 * - `invalid`       → syntactically unusable (multi-range, garbage); answer `416`.
 * - `unsatisfiable` → well-formed but outside the resource; answer `416`.
 * - `satisfiable`   → `start`/`end` inclusive byte offsets; answer `206`.
 *
 * The suffix form `bytes=-N` is supported because media elements use it to
 * read an MP4 `moov` atom from the tail and to reach the last frames when
 * looping.
 *
 * @param {unknown} header - the raw `Range` header value.
 * @param {number} size - the resource size in bytes.
 * @returns {{kind: 'none'}
 *   | {kind: 'invalid'}
 *   | {kind: 'unsatisfiable'}
 *   | {kind: 'satisfiable', start: number, end: number}} the parsed range.
 */
export function parseRange(header, size) {
  if (typeof header !== 'string') return { kind: 'none' };
  const text = header.trim();
  if (text === '') return { kind: 'none' };
  if (!Number.isSafeInteger(size) || size < 0) return { kind: 'invalid' };

  const match = /^bytes=(\d*)-(\d*)$/.exec(text);
  if (match === null) return { kind: 'invalid' };

  const rawStart = match[1];
  const rawEnd = match[2];
  if (rawStart === '' && rawEnd === '') return { kind: 'invalid' };
  if (size === 0) return { kind: 'unsatisfiable' };

  if (rawStart === '') {
    // Suffix form: the last N bytes.
    const suffix = Number(rawEnd);
    if (!Number.isSafeInteger(suffix)) return { kind: 'invalid' };
    if (suffix <= 0) return { kind: 'unsatisfiable' };
    return { kind: 'satisfiable', start: Math.max(0, size - suffix), end: size - 1 };
  }

  const start = Number(rawStart);
  if (!Number.isSafeInteger(start)) return { kind: 'invalid' };
  if (rawEnd === '') {
    if (start >= size) return { kind: 'unsatisfiable' };
    return { kind: 'satisfiable', start, end: size - 1 };
  }

  const end = Number(rawEnd);
  if (!Number.isSafeInteger(end)) return { kind: 'invalid' };
  if (start > end || start >= size) return { kind: 'unsatisfiable' };
  return { kind: 'satisfiable', start, end: Math.min(end, size - 1) };
}

/**
 * Lexically confine a request-relative path inside `base`.
 *
 * Mirrors what the traversal defence must reject: absolute paths, drive
 * letters, `..` escapes and NUL bytes. This is the *cheap* first gate; the
 * caller must still refuse symlinks and re-verify the real path, because a
 * lexical check alone cannot see a junction pointing outside.
 *
 * @param {string} base - the directory the result must stay inside.
 * @param {string} relative - the untrusted relative path.
 * @returns {string|null} the resolved absolute path, or null when it escapes.
 */
export function contain(base, relative) {
  if (typeof relative !== 'string' || relative === '') return null;
  if (relative.includes('\0')) return null;
  const root = resolve(base);
  const target = resolve(root, relative);
  if (target === root) return null;
  return target.startsWith(root + sep) ? target : null;
}

/**
 * Sanitise an untrusted upload filename into a safe base name.
 *
 * Strips directory structure, control characters, characters Windows rejects,
 * leading dots (hidden/relative names) and trailing dots/spaces, refuses
 * reserved device names, and caps the length while keeping the extension.
 *
 * @param {unknown} name - the client-supplied filename.
 * @returns {string} a safe, non-empty base name.
 */
export function safeName(name) {
  let text = typeof name === 'string' ? name : '';
  // Drop any path structure from either separator convention.
  text = text.replaceAll('\\', '/');
  text = text.split('/').pop() ?? '';
  // Remove characters the filesystem or Windows forbids, plus controls.
  // eslint-disable-next-line no-control-regex
  text = text.replace(/[\u0000-\u001f\u007f<>:"|?*]/gu, '');
  text = text.replace(/\s+/gu, ' ').trim();
  // Leading dots would create hidden or relative names.
  text = text.replace(/^\.+/u, '').replace(/[. ]+$/u, '');
  if (text === '') return 'file';

  const ext = extname(text);
  const stem = ext === '' ? text : text.slice(0, -ext.length);
  const safeStem = RESERVED.has(stem.toUpperCase()) ? `${stem}_` : stem;
  const maxStem = Math.max(1, 120 - ext.length);
  return `${safeStem.slice(0, maxStem)}${ext.slice(0, 16)}`;
}

/** Windows reserved device names, which cannot be used as a file stem. */
const RESERVED = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
  'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9'
]);

/**
 * Pick a name not already present in a set, appending ` (n)` before the
 * extension when needed.
 * @param {Iterable<string>} taken - names already in use (case-insensitive).
 * @param {string} name - the sanitised candidate name.
 * @returns {string} a unique name.
 */
export function uniqueName(taken, name) {
  const used = new Set([...taken].map((item) => item.toLowerCase()));
  if (!used.has(name.toLowerCase())) return name;
  const ext = extname(name);
  const stem = ext === '' ? name : name.slice(0, -ext.length);
  for (let index = 1; index < 10_000; index += 1) {
    const candidate = `${stem} (${index})${ext}`;
    if (!used.has(candidate.toLowerCase())) return candidate;
  }
  return `${stem}-${Date.now()}${ext}`;
}

/**
 * Largest upload accepted, derived from the free space on the target volume.
 *
 * The floor keeps a nearly-full disk from rejecting everything, and the 80 %
 * share keeps one upload from filling the volume. Returns the cap and the
 * free bytes so the caller can report both.
 *
 * @param {{bavail: number, bsize: number}} stats - a `statfsSync` result.
 * @param {{share?: number, floor?: number}} [options] - share of free space, and the floor.
 * @returns {{cap: number, free: number}} the byte cap and the observed free bytes.
 */
export function uploadCap(stats, options = {}) {
  const share = options.share ?? 0.8;
  const floor = options.floor ?? 512 * 1024 * 1024;
  const free = Math.max(0, Number(stats?.bavail ?? 0) * Number(stats?.bsize ?? 0));
  return { cap: Math.max(floor, Math.floor(free * share)), free };
}

/**
 * Format a byte count for logs and diagnostics.
 * @param {number} bytes - the byte count.
 * @returns {string} a human-readable size.
 */
export function humanBytes(bytes) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = Number(bytes) || 0;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 && unit > 0 ? value.toFixed(1) : Math.round(value)}${units[unit]}`;
}

/**
 * Assert that a path is a regular file reached without following a link, and
 * that its real location is still inside `root`.
 *
 * @param {string} root - the directory the file must really live in.
 * @param {string} target - the absolute candidate path.
 * @param {(path: string) => {isSymbolicLink: () => boolean, isFile: () => boolean}} lstat - a `lstatSync`-compatible reader.
 * @param {(path: string) => string} realpath - a `realpathSync`-compatible reader.
 * @returns {{ok: true, path: string} | {ok: false, reason: string}} the verdict.
 */
export function verifyRegularFile(root, target, lstat, realpath) {
  let stats;
  try {
    stats = lstat(target);
  } catch {
    return { ok: false, reason: 'missing' };
  }
  if (stats.isSymbolicLink()) return { ok: false, reason: 'symlink' };
  if (!stats.isFile()) return { ok: false, reason: 'not-a-file' };

  const realRoot = realpath(root);
  const realTarget = realpath(target);
  if (realTarget !== realRoot && !realTarget.startsWith(realRoot + sep)) {
    return { ok: false, reason: 'escapes-root' };
  }
  return { ok: true, path: realTarget };
}

/** Convenience re-export so callers do not need `node:path` directly. */
export { basename };
