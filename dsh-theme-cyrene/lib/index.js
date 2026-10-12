/**
 * Host half of `dsh-theme-cyrene`.
 *
 * Responsibilities:
 * - serve the theme's bundled media (`assets/`, `music/`, `GIF/`) and the
 *   user's uploaded media over one prefix route, with real HTTP Range support
 *   so audio seeking, video looping and `preload="metadata"` thumbnails work;
 * - accept uploads with a free-disk-derived cap, written atomically;
 * - soft-delete into a trash directory that can be restored;
 * - persist the theme's preferences as one validated JSON document.
 *
 * Deliberately dependency-free (node builtins only) so no version gate can
 * reject the bundle, and so nothing is resolved out of the installation.
 *
 * @module dsh-theme-cyrene
 */

import { closeSync, createReadStream, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, statfsSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  acceptsUpload,
  contain,
  humanBytes,
  kindFor,
  mimeFor,
  parseRange,
  safeName,
  uniqueName,
  uploadCap,
  verifyRegularFile
} from './assets.js';
import { controlMedia, readMedia } from './media.js';

/**
 * Diagnostic prefix and plugin identifier.
 *
 * The scoped package name, to match `PLUGIN_ID` in the browser half. Nothing
 * compares the two today — the client no longer reads the `plugin` field of the
 * manifest envelope — but this is the value that identifies the plugin in a
 * response body and in the logs, and an identity string that has drifted from
 * the package name is how the loader-id bug started. Keep it equal.
 */
const NAME = '@lutisure/dsh-theme-cyrene';

/** The single route prefix this plugin owns. */
const PREFIX = '/theme-cyrene-assets';

/** Package directory: `<pkg>/lib/index.js` → `<pkg>`. */
const PKG_ROOT = fileURLToPath(new URL('..', import.meta.url));

/** Bundled, read-only asset buckets inside the package. */
const PKG_BUCKETS = new Set(['assets', 'music', 'GIF', 'brand']);

/** Writable buckets under the DSH home directory. */
const USER_BUCKETS = new Set(['wallpapers', 'music', 'covers', 'emotes', 'boot']);

/** Upload kind → destination bucket. */
const UPLOAD_BUCKET = Object.freeze({
  wallpaper: 'wallpapers',
  music: 'music',
  cover: 'covers',
  emote: 'emotes',
  boot: 'boot'
});

/** Cap on the persisted preference document. */
const STATE_LIMIT = 256 * 1024;

/** Refuse to buffer an upload larger than this in a single write pass. */
const UPLOAD_HARD_LIMIT = 8 * 1024 * 1024 * 1024;

/** Per-bucket extension allow-list, used when enumerating a directory. */
const MEDIA_EXT = new Set([
  '.jpg', '.jpeg', '.png', '.webp', '.avif', '.gif',
  '.mp4', '.webm', '.mov',
  '.mp3', '.m4a', '.flac', '.ogg', '.oga', '.opus', '.wav'
]);

/**
 * The DSH home directory, following the documented precedence
 * (explicit override, then `$DSH_HOME`, then `~/.dsh`).
 * @returns {string} the absolute home directory.
 */
function dshHome() {
  const override = process.env.DSH_HOME?.trim();
  return override !== undefined && override !== '' ? resolve(override) : join(homedir(), '.dsh');
}

/** Everything this theme owns on disk, under one directory. */
const HOME_DIR = join(dshHome(), 'theme-cyrene');
const USER_DIR = join(HOME_DIR, 'uploads');
const TRASH_DIR = join(HOME_DIR, 'trash');
const STATE_FILE = join(HOME_DIR, 'state.json');
const TMP_DIR = join(HOME_DIR, 'tmp');

/**
 * Create the writable directories, tolerating an already-existing tree.
 * @returns {void}
 */
function ensureDirs() {
  for (const dir of [HOME_DIR, USER_DIR, TRASH_DIR, TMP_DIR]) {
    mkdirSync(dir, { recursive: true });
  }
}

/** Directory for one bucket, creating it on demand. */
function userBucketDir(bucket) {
  const dir = join(USER_DIR, bucket);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * List readable regular files in a directory (one level), sorted for stable
 * output. Unreadable or absent directories yield an empty list.
 * @param {string} dir - the directory to list.
 * @returns {string[]} file names.
 */
function listFiles(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => (entry.isFile() || entry.isSymbolicLink()) && MEDIA_EXT.has(extname(entry.name).toLowerCase()))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right, 'zh-Hans-CN'));
}

/**
 * Build one manifest entry.
 *
 * Wallpaper entries carry the same `default` flag the build script computes, so
 * the two manifest sources agree: whichever one the client ends up believing,
 * a fresh install still seeds itself with the intended wallpaper. Files added
 * while the plugin is already installed only ever reach the client through
 * this path, so the flag has to exist here too.
 *
 * @param {object} spec - entry fields; `wallpaper: true` adds the seed flag.
 * @returns {object} the manifest record.
 */
function entry(spec) {
  // ⚠️ The bucket and the served path are **not** the same thing, and conflating
  // them shipped a live bug. Emotes carry the bucket `emotes` — that is the user
  // upload directory, and the key the client filters on — but the bundled ones
  // live at `GIF/emotes/` on disk. The URL therefore said `pkg/emotes/…`, which
  // the route does not serve: every emote 404d in the running app while the tests
  // stayed green, because the test fixture hard-coded the correct path rather
  // than the one the host actually produced. `covers` had the same latent bug
  // (`covers` bucket, `music/figure` on disk) with nothing in it yet.
  const served = spec.path ?? spec.bucket;
  const record = {
    id: `${spec.source}:${spec.bucket}/${spec.name}`,
    name: spec.name,
    label: spec.label ?? spec.name.replace(/\.[^.]+$/u, ''),
    kind: kindFor(spec.name) ?? 'file',
    mime: mimeFor(spec.name),
    url: `${PREFIX}/${spec.source === 'builtin' ? 'pkg' : 'user'}/${served}/${encodeURIComponent(spec.name)}`,
    source: spec.source
  };
  if (spec.wallpaper === true) record.default = DEFAULT_WALLPAPER.test(spec.name);
  return record;
}

/** A wallpaper whose name marks it as the seed for a fresh install. */
const DEFAULT_WALLPAPER = /default/iu;

/**
 * Collect every asset the client can choose from: bundled media plus uploads.
 *
 * Exported so the URL contract is testable. It was not before, and the gap cost a
 * live bug: the fixtures hard-coded the URL the tests expected instead of the one
 * this function produces, so nothing compared the two.
 *
 * @returns {object} the manifest document.
 */
export function buildManifest() {
  const bundled = {
    assets: listFiles(join(PKG_ROOT, 'assets')),
    music: listFiles(join(PKG_ROOT, 'music')),
    covers: listFiles(join(PKG_ROOT, 'music', 'figure')),
    GIF: listFiles(join(PKG_ROOT, 'GIF')),
    emotes: listFiles(join(PKG_ROOT, 'GIF', 'emotes'))
  };
  const builtin = (bucket, files, servedPath) => files.map((name) => entry({
    source: 'builtin',
    bucket,
    path: servedPath,
    name,
    wallpaper: bucket === 'assets'
  }));
  const uploaded = (bucket) => listFiles(join(USER_DIR, bucket)).map((name) => entry({
    source: 'user',
    bucket,
    name,
    wallpaper: bucket === 'wallpapers'
  }));

  const wallpapers = [
    ...builtin('assets', bundled.assets),
    ...uploaded('wallpapers')
  ];
  const covers = [
    ...builtin('covers', bundled.covers, 'music/figure'),
    ...uploaded('covers')
  ];

  return {
    plugin: NAME,
    generatedAt: new Date().toISOString(),
    wallpapers,
    music: [...builtin('music', bundled.music), ...uploaded('music')],
    covers,
    boot: [...builtin('GIF', bundled.GIF), ...uploaded('boot')],
    emotes: [...builtin('emotes', bundled.emotes, 'GIF/emotes'), ...uploaded('emotes')],
    state: readState(),
    limits: limits()
  };
}

/**
 * Current upload headroom, derived from the free space of the uploads volume.
 * @returns {{uploadCap: number, uploadCapLabel: string, free: number, freeLabel: string}} limits.
 */
function limits() {
  const override = Number.parseInt(process.env.DSH_THEME_CYRENE_UPLOAD_CAP ?? '', 10);
  if (Number.isSafeInteger(override) && override > 0) {
    let free = 0;
    try {
      free = uploadCap(statfsSync(USER_DIR)).free;
    } catch {
      /* the override stands on its own */
    }
    return {
      uploadCap: override,
      uploadCapLabel: humanBytes(override),
      free,
      freeLabel: humanBytes(free)
    };
  }

  let stats = { bavail: 0, bsize: 0 };
  try {
    ensureDirs();
    stats = statfsSync(USER_DIR);
  } catch {
    /* A filesystem without statfs falls back to the floor. */
  }
  const { cap, free } = uploadCap(stats);
  return {
    uploadCap: Math.min(cap, UPLOAD_HARD_LIMIT),
    uploadCapLabel: humanBytes(Math.min(cap, UPLOAD_HARD_LIMIT)),
    free,
    freeLabel: humanBytes(free)
  };
}

/**
 * Read the persisted preference document, always returning a plain object so
 * a corrupt file degrades to defaults instead of breaking the plugin.
 * @returns {Record<string, unknown>} the state document.
 */
export function readState() {
  try {
    const text = readFileSync(STATE_FILE, 'utf8');
    if (text.length > STATE_LIMIT) return {};
    const parsed = JSON.parse(text);
    return isPlainObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Replace the persisted document atomically (temp file + rename), so a crash
 * or a concurrent reader never observes a half-written file.
 * @param {Record<string, unknown>} value - the document to store.
 * @returns {void}
 */
export function writeState(value) {
  ensureDirs();
  const text = `${JSON.stringify(value, undefined, 2)}\n`;
  if (text.length > STATE_LIMIT) throw new Error(`${NAME}: state document exceeds ${STATE_LIMIT} bytes`);
  const temp = join(TMP_DIR, `state-${process.pid}-${Date.now()}.json`);
  writeFileSync(temp, text, { encoding: 'utf8', mode: 0o600 });
  renameSync(temp, STATE_FILE);
}

/**
 * Shallow-merge a patch into the stored document.
 * @param {Record<string, unknown>} patch - the incoming partial document.
 * @returns {Record<string, unknown>} the merged document.
 */
function mergeState(patch) {
  const merged = { ...readState(), ...patch };
  writeState(merged);
  return merged;
}

/**
 * Whether a value is a non-array, non-null object.
 * @param {unknown} value - the candidate.
 * @returns {boolean} true for plain objects.
 */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Hosts this DSH instance trusts for cross-origin requests, read lazily so a
 * late change is honoured. Absent or unavailable services yield an empty set.
 * @param {object} ctx - the injected context carrying `connection`.
 * @returns {Set<string>} lower-cased trusted hosts.
 */
function trustedHosts(ctx) {
  try {
    const connection = ctx?.connection ?? ctx?.get?.('connection');
    const raw = typeof connection?.trustedHosts === 'function' ? connection.trustedHosts() : connection?.trustedHosts;
    if (raw === undefined || raw === null) return new Set();
    if (raw instanceof Set) return new Set([...raw].map((host) => String(host).toLowerCase()));
    if (Array.isArray(raw)) return new Set(raw.map((host) => String(host).toLowerCase()));
    if (isPlainObject(raw)) return new Set(Object.keys(raw).map((host) => host.toLowerCase()));
    return new Set();
  } catch {
    return new Set();
  }
}

/**
 * Same-origin fence for state-changing requests.
 *
 * The Desktop shell proxies the UI through `dsh-app://app` and **strips**
 * `host`, `origin`, `cookie` and `sec-fetch-site`, so an absent `Origin` must
 * mean *allow* — a naive `Origin === Host` test would lock the whole Desktop
 * app out of its own upload endpoint. Present-but-mismatched, empty and
 * literal `null` origins all fail closed.
 *
 * @param {import('node:http').IncomingMessage} req - the request.
 * @param {object} ctx - the context used to read trusted hosts.
 * @returns {boolean} true when the request may mutate state.
 */
export function sameOriginOk(req, ctx) {
  const origin = req.headers.origin;
  const host = req.headers.host;

  if (origin === undefined) return true; // no CORS context: navigation, same-origin fetch, or the Desktop proxy
  if (Array.isArray(origin)) return false; // duplicated header: fail closed
  if (origin === '' || origin === 'null') return false;

  let originHost;
  try {
    originHost = new URL(origin).host.toLowerCase();
  } catch {
    return false;
  }
  if (originHost === '') return false;
  if (typeof host === 'string' && host !== '' && originHost === host.toLowerCase()) return true;
  return trustedHosts(ctx).has(originHost);
}

/**
 * Write a JSON response, honouring `HEAD`.
 * @param {import('node:http').ServerResponse} res - the response.
 * @param {import('node:http').IncomingMessage} req - the request.
 * @param {unknown} body - the JSON-serialisable payload.
 * @param {number} [status] - the status code.
 * @returns {void}
 */
function sendJson(res, req, body, status = 200) {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(Buffer.byteLength(text)),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff'
  });
  if ((req.method ?? 'GET').toUpperCase() === 'HEAD') res.end();
  else res.end(text);
}

/**
 * Write a short plain-text response.
 * @param {import('node:http').ServerResponse} res - the response.
 * @param {number} status - the status code.
 * @param {string} message - the body.
 * @returns {void}
 */
function sendStatus(res, status, message) {
  res.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'content-length': String(Buffer.byteLength(message)),
    'cache-control': 'no-store'
  });
  res.end(message);
}

/**
 * Serve a file with full Range support.
 *
 * A `Range` request answered with `200` makes browsers treat the resource as
 * unseekable, so an unsatisfiable or malformed range answers `416` with a
 * `bytes *​/total` hint rather than falling back to the whole body.
 *
 * @param {import('node:http').IncomingMessage} req - the request.
 * @param {import('node:http').ServerResponse} res - the response.
 * @param {string} file - absolute path of a verified regular file.
 * @returns {void}
 */
export function serveFile(req, res, file) {
  let size;
  try {
    size = statSync(file).size;
  } catch {
    sendStatus(res, 404, 'not found');
    return;
  }

  const method = (req.method ?? 'GET').toUpperCase();
  const base = {
    'content-type': mimeFor(file),
    'accept-ranges': 'bytes',
    'x-content-type-options': 'nosniff'
  };
  const range = parseRange(req.headers.range, size);

  if (range.kind === 'none') {
    res.writeHead(200, {
      ...base,
      'content-length': String(size),
      'cache-control': 'private, max-age=0, must-revalidate'
    });
    if (method === 'HEAD') res.end();
    else createReadStream(file).pipe(res);
    return;
  }

  if (range.kind === 'invalid' || range.kind === 'unsatisfiable') {
    res.writeHead(416, { ...base, 'content-range': `bytes */${size}` });
    res.end();
    return;
  }

  res.writeHead(206, {
    ...base,
    'content-range': `bytes ${range.start}-${range.end}/${size}`,
    'content-length': String(range.end - range.start + 1),
    'cache-control': 'private, max-age=0, must-revalidate'
  });
  if (method === 'HEAD') res.end();
  else createReadStream(file, { start: range.start, end: range.end }).pipe(res);
}

/**
 * Decode request path segments into a safe relative path.
 *
 * Each segment is decoded separately and rejected if decoding reveals a
 * separator, a NUL, or a traversal part — the reference implementation
 * decoded the whole path unguarded, which lets `%2e%2e%2f` through the
 * lexical check.
 *
 * @param {string[]} segments - raw, still-encoded path segments.
 * @returns {string|null} a relative path, or null when unsafe.
 */
export function safeRelPath(segments) {
  if (!Array.isArray(segments) || segments.length === 0) return null;
  const parts = [];
  for (const raw of segments) {
    let part;
    try {
      part = decodeURIComponent(raw);
    } catch {
      return null;
    }
    if (part === '' || part === '.' || part === '..') return null;
    if (part.includes('/') || part.includes('\\') || part.includes('\0')) return null;
    if (part.startsWith('.')) return null;
    parts.push(part);
  }
  return parts.join('/');
}

/**
 * Resolve a request for a bundled asset and serve it if it is a real file.
 * @param {import('node:http').IncomingMessage} req - the request.
 * @param {import('node:http').ServerResponse} res - the response.
 * @param {string[]} segments - path segments after `/pkg/`.
 * @returns {void}
 */
function serveBundled(req, res, segments) {
  const bucket = segments[0];
  if (!PKG_BUCKETS.has(bucket)) {
    sendStatus(res, 404, 'unknown bucket');
    return;
  }
  const relative = safeRelPath(segments.slice(1));
  if (relative === null) {
    sendStatus(res, 400, 'bad path');
    return;
  }
  const root = join(PKG_ROOT, bucket);
  const candidate = contain(root, relative);
  if (candidate === null) {
    sendStatus(res, 403, 'forbidden');
    return;
  }
  const verdict = verifyRegularFile(root, candidate, lstatSync, realpathSync);
  if (!verdict.ok) {
    sendStatus(res, verdict.reason === 'missing' ? 404 : 403, verdict.reason);
    return;
  }
  serveFile(req, res, verdict.path);
}

/**
 * Resolve a request for an uploaded asset and serve it if it is a real file.
 * @param {import('node:http').IncomingMessage} req - the request.
 * @param {import('node:http').ServerResponse} res - the response.
 * @param {string[]} segments - path segments after `/user/`.
 * @returns {void}
 */
function serveUploaded(req, res, segments) {
  const bucket = segments[0];
  if (!USER_BUCKETS.has(bucket)) {
    sendStatus(res, 404, 'unknown bucket');
    return;
  }
  const relative = safeRelPath(segments.slice(1));
  if (relative === null) {
    sendStatus(res, 400, 'bad path');
    return;
  }
  const root = join(USER_DIR, bucket);
  const candidate = contain(root, relative);
  if (candidate === null) {
    sendStatus(res, 403, 'forbidden');
    return;
  }
  const verdict = verifyRegularFile(root, candidate, lstatSync, realpathSync);
  if (!verdict.ok) {
    sendStatus(res, verdict.reason === 'missing' ? 404 : 403, verdict.reason);
    return;
  }
  serveFile(req, res, verdict.path);
}

/**
 * Read a request body up to a byte limit.
 * @param {import('node:http').IncomingMessage} req - the request.
 * @param {number} limit - the maximum accepted bytes.
 * @returns {Promise<{ok: true, text: string} | {ok: false, reason: 'too-large'}>} the body.
 */
function readBody(req, limit) {
  return new Promise((settle) => {
    const chunks = [];
    let total = 0;
    let overflow = false;
    req.on('data', (chunk) => {
      if (overflow) return;
      total += chunk.length;
      if (total > limit) {
        overflow = true;
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });
    // Settle only once the request has been fully read: answering while the
    // client is still sending resets the connection and poisons keep-alive.
    req.on('end', () => {
      if (overflow) settle({ ok: false, reason: 'too-large' });
      else settle({ ok: true, text: Buffer.concat(chunks).toString('utf8') });
    });
    req.on('error', () => settle({ ok: false, reason: 'too-large' }));
  });
}

/**
 * Handle `POST /state`: merge a partial preference document.
 * @param {import('node:http').IncomingMessage} req - the request.
 * @param {import('node:http').ServerResponse} res - the response.
 * @param {object} ctx - the plugin context.
 * @returns {Promise<void>} completion.
 */
async function routeState(req, res, ctx) {
  if (!sameOriginOk(req, ctx)) {
    sendStatus(res, 403, 'cross-origin rejected');
    return;
  }
  const body = await readBody(req, STATE_LIMIT);
  if (!body.ok) {
    sendStatus(res, 413, 'state too large');
    return;
  }
  let patch;
  try {
    patch = JSON.parse(body.text);
  } catch {
    sendStatus(res, 400, 'invalid json');
    return;
  }
  if (!isPlainObject(patch)) {
    sendStatus(res, 400, 'state must be an object');
    return;
  }
  try {
    sendJson(res, req, { ok: true, state: mergeState(patch) });
  } catch (error) {
    sendStatus(res, 500, String(error?.message ?? error));
  }
}

/**
 * Handle `POST /upload?kind=&name=`: stream the body to a temp file, then move
 * it into place.
 *
 * The cap comes from the free space of the uploads volume, and can be pinned
 * with `DSH_THEME_CYRENE_UPLOAD_CAP` for testing or for an operator who wants
 * a hard ceiling. Because the webserver has no body limit of its own, this
 * plugin is the only thing standing between a request and the disk.
 *
 * @param {import('node:http').IncomingMessage} req - the request.
 * @param {import('node:http').ServerResponse} res - the response.
 * @param {URL} url - the parsed request URL.
 * @param {object} ctx - the plugin context.
 * @returns {Promise<void>} completion.
 */
async function routeUpload(req, res, url, ctx) {
  if (!sameOriginOk(req, ctx)) {
    sendStatus(res, 403, 'cross-origin rejected');
    return;
  }
  const kind = url.searchParams.get('kind') ?? '';
  const bucket = UPLOAD_BUCKET[kind];
  if (bucket === undefined) {
    sendStatus(res, 400, 'unknown kind');
    return;
  }
  const display = String(url.searchParams.get('name') ?? '').slice(0, 300);
  const name = safeName(display);
  if (!acceptsUpload(kind, name)) {
    sendStatus(res, 415, `unsupported file type for ${kind}`);
    return;
  }

  ensureDirs();
  const dir = userBucketDir(bucket);
  const { uploadCap: cap } = limits();

  const temp = join(TMP_DIR, `up-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  let handle;
  try {
    handle = openSync(temp, 'w');
  } catch (error) {
    sendStatus(res, 500, `cannot open temp file: ${String(error?.message ?? error)}`);
    return;
  }

  const discard = () => {
    try {
      closeSync(handle);
    } catch {
      /* already closed */
    }
    try {
      unlinkSync(temp);
    } catch {
      /* already gone */
    }
  };

  // Read the whole request before answering. A refusal that responds while the
  // client is still sending resets the connection, and the Desktop reverse
  // proxy pools those sockets — one reset makes every later upload fail with
  // EPIPE/408/502. So an oversized body is drained first, then refused.
  let total = 0;
  let overflow = false;
  let failure = null;
  await new Promise((settle) => {
    req.on('data', (chunk) => {
      if (overflow || failure !== null) return;
      total += chunk.length;
      if (total > cap) {
        overflow = true;
        return;
      }
      try {
        writeSync(handle, chunk);
      } catch (error) {
        failure = error;
      }
    });
    req.on('end', () => settle());
    req.on('error', (error) => {
      failure ??= error;
      settle();
    });
    req.on('aborted', () => {
      failure ??= new Error('client aborted the upload');
      settle();
    });
  });

  if (overflow) {
    discard();
    sendStatus(res, 413, `exceeds the ${humanBytes(cap)} upload limit`);
    return;
  }
  if (failure !== null) {
    discard();
    sendStatus(res, 400, `upload failed: ${String(failure?.message ?? failure)}`);
    return;
  }

  try {
    fsyncSync(handle);
  } catch {
    /* fsync is best effort on some volumes */
  }
  try {
    closeSync(handle);
  } catch {
    /* already closed */
  }

  const finalName = uniqueName(listFiles(dir), name);
  try {
    renameSync(temp, join(dir, finalName));
  } catch (error) {
    try {
      unlinkSync(temp);
    } catch {
      /* already gone */
    }
    sendStatus(res, 500, `cannot store upload: ${String(error?.message ?? error)}`);
    return;
  }
  sendJson(res, req, {
    ok: true,
    bucket,
    name: finalName,
    label: display === '' ? finalName : display,
    size: total,
    sizeLabel: humanBytes(total)
  });
}

/**
 * Handle `POST /delete`: move an uploaded file into the trash directory.
 * Bundled assets are hidden (not deleted) and that is a state change, so it
 * travels through `/state` instead.
 * @param {import('node:http').IncomingMessage} req - the request.
 * @param {import('node:http').ServerResponse} res - the response.
 * @param {object} ctx - the plugin context.
 * @returns {Promise<void>} completion.
 */
async function routeDelete(req, res, ctx) {
  if (!sameOriginOk(req, ctx)) {
    sendStatus(res, 403, 'cross-origin rejected');
    return;
  }
  const body = await readBody(req, 64 * 1024);
  if (!body.ok) {
    sendStatus(res, 413, 'request too large');
    return;
  }
  let request;
  try {
    request = JSON.parse(body.text);
  } catch {
    sendStatus(res, 400, 'invalid json');
    return;
  }
  const bucket = String(request?.bucket ?? '');
  if (!USER_BUCKETS.has(bucket)) {
    sendStatus(res, 400, 'unknown bucket');
    return;
  }
  const name = safeName(request?.name);
  const root = join(USER_DIR, bucket);
  const candidate = contain(root, name);
  if (candidate === null) {
    sendStatus(res, 403, 'forbidden');
    return;
  }
  const verdict = verifyRegularFile(root, candidate, lstatSync, realpathSync);
  if (!verdict.ok) {
    sendStatus(res, verdict.reason === 'missing' ? 404 : 403, verdict.reason);
    return;
  }
  const trashBucket = join(TRASH_DIR, bucket);
  mkdirSync(trashBucket, { recursive: true });
  const trashed = uniqueName(listFiles(trashBucket), name);
  try {
    renameSync(verdict.path, join(trashBucket, trashed));
  } catch (error) {
    sendStatus(res, 500, `cannot move to trash: ${String(error?.message ?? error)}`);
    return;
  }
  sendJson(res, req, { ok: true, bucket, name, trashed });
}

/**
 * Handle `GET /trash` and `POST /restore`.
 * @param {import('node:http').IncomingMessage} req - the request.
 * @param {import('node:http').ServerResponse} res - the response.
 * @param {object} ctx - the plugin context.
 * @returns {Promise<void>} completion.
 */
async function routeTrash(req, res, ctx) {
  const method = (req.method ?? 'GET').toUpperCase();

  if (method === 'GET' || method === 'HEAD') {
    const items = [];
    for (const bucket of USER_BUCKETS) {
      for (const name of listFiles(join(TRASH_DIR, bucket))) {
        let size = 0;
        try {
          size = statSync(join(TRASH_DIR, bucket, name)).size;
        } catch {
          /* raced with a removal */
        }
        items.push({ bucket, name, size, sizeLabel: humanBytes(size) });
      }
    }
    sendJson(res, req, { ok: true, items });
    return;
  }

  if (method !== 'POST') {
    sendStatus(res, 405, 'method not allowed');
    return;
  }
  if (!sameOriginOk(req, ctx)) {
    sendStatus(res, 403, 'cross-origin rejected');
    return;
  }
  const body = await readBody(req, 64 * 1024);
  if (!body.ok) {
    sendStatus(res, 413, 'request too large');
    return;
  }
  let request;
  try {
    request = JSON.parse(body.text);
  } catch {
    sendStatus(res, 400, 'invalid json');
    return;
  }
  const bucket = String(request?.bucket ?? '');
  if (!USER_BUCKETS.has(bucket)) {
    sendStatus(res, 400, 'unknown bucket');
    return;
  }
  const name = safeName(request?.name);
  const trashRoot = join(TRASH_DIR, bucket);
  const candidate = contain(trashRoot, name);
  if (candidate === null) {
    sendStatus(res, 403, 'forbidden');
    return;
  }
  const verdict = verifyRegularFile(trashRoot, candidate, lstatSync, realpathSync);
  if (!verdict.ok) {
    sendStatus(res, verdict.reason === 'missing' ? 404 : 403, verdict.reason);
    return;
  }
  const dir = userBucketDir(bucket);
  const restored = uniqueName(listFiles(dir), name);
  try {
    renameSync(verdict.path, join(dir, restored));
  } catch (error) {
    sendStatus(res, 500, `cannot restore: ${String(error?.message ?? error)}`);
    return;
  }
  sendJson(res, req, { ok: true, bucket, name: restored });
}

/**
 * Handle `GET /trash/empty`-style maintenance: permanently clear the trash.
 * @param {import('node:http').IncomingMessage} req - the request.
 * @param {import('node:http').ServerResponse} res - the response.
 * @param {object} ctx - the plugin context.
 * @returns {Promise<void>} completion.
 */
async function routeTrashEmpty(req, res, ctx) {
  if (!sameOriginOk(req, ctx)) {
    sendStatus(res, 403, 'cross-origin rejected');
    return;
  }
  try {
    rmSync(TRASH_DIR, { recursive: true, force: true });
    mkdirSync(TRASH_DIR, { recursive: true });
  } catch (error) {
    sendStatus(res, 500, `cannot empty trash: ${String(error?.message ?? error)}`);
    return;
  }
  sendJson(res, req, { ok: true });
}

/**
 * Dispatch one request under {@link PREFIX}.
 * @param {import('node:http').IncomingMessage} req - the request.
 * @param {import('node:http').ServerResponse} res - the response.
 * @param {object} ctx - the plugin context.
 * @returns {Promise<void>} completion.
 */
export async function route(req, res, ctx) {
  const method = (req.method ?? 'GET').toUpperCase();
  let url;
  try {
    url = new URL(req.url ?? '/', 'http://localhost');
  } catch {
    sendStatus(res, 400, 'bad request url');
    return;
  }

  const rest = url.pathname.startsWith(PREFIX) ? url.pathname.slice(PREFIX.length) : url.pathname;
  const segments = rest.split('/').filter((part) => part !== '');
  const head = segments[0];

  if (head === undefined) {
    sendJson(res, req, { plugin: NAME, prefix: PREFIX });
    return;
  }

  if (head === 'manifest' && (method === 'GET' || method === 'HEAD')) {
    sendJson(res, req, buildManifest());
    return;
  }
  if (head === 'state') {
    if (method === 'GET' || method === 'HEAD') {
      sendJson(res, req, { ok: true, state: readState() });
      return;
    }
    if (method === 'POST') {
      await routeState(req, res, ctx);
      return;
    }
  }
  if (head === 'upload' && method === 'POST') {
    await routeUpload(req, res, url, ctx);
    return;
  }
  if (head === 'delete' && method === 'POST') {
    await routeDelete(req, res, ctx);
    return;
  }
  if (head === 'trash') {
    if (segments[1] === 'empty' && method === 'POST') {
      await routeTrashEmpty(req, res, ctx);
      return;
    }
    await routeTrash(req, res, ctx);
    return;
  }
  if (head === 'restore' && method === 'POST') {
    await routeTrash(req, res, ctx);
    return;
  }
  if (head === 'pkg' && segments.length > 1) {
    serveBundled(req, res, segments.slice(1));
    return;
  }
  if (head === 'user' && segments.length > 1) {
    serveUploaded(req, res, segments.slice(1));
    return;
  }
  if (head === 'media') {
    if (method === 'GET' || method === 'HEAD') {
      // `?fresh=1` skips the short cache, for a manual refresh.
      sendJson(res, req, readMedia(url.searchParams.get('fresh') === '1'));
      return;
    }
    if (method === 'POST') {
      // A media action is a few dozen bytes; the cap is a formality, but an
      // uncapped reader is how a stray POST turns into unbounded memory.
      const body = await readBody(req, 8 * 1024);
      if (!body.ok) {
        sendStatus(res, 413, 'media request too large');
        return;
      }
      let payload;
      try {
        payload = body.text === '' ? {} : JSON.parse(body.text);
      } catch {
        // A malformed body is a client bug, not a reason to touch the player.
        sendStatus(res, 400, 'bad media request');
        return;
      }
      sendJson(res, req, controlMedia(String(payload?.action ?? '')));
      return;
    }
  }

  sendStatus(res, 404, 'not found');
}

/**
 * Mount the asset route. The registration disposer is handed to `ctx.effect`,
 * so disabling the plugin (or an HMR recomposition) actually releases the
 * route instead of leaking it.
 * @param {object} ctx - the plugin context.
 * @returns {void}
 */
export function apply(ctx) {
  ctx.inject(['webServer'], (webCtx) => {
    const webServer = webCtx?.webServer ?? webCtx?.get?.('webServer');
    if (typeof webServer?.register !== 'function') return;
    webCtx.effect(() => webServer.register({
      kind: 'prefix',
      path: PREFIX,
      handler: (req, res) => {
        route(req, res, webCtx).catch((error) => {
          try {
            sendStatus(res, 500, String(error?.message ?? error));
          } catch {
            /* headers already sent */
          }
        });
      }
    }), `${NAME}: assets`);
  });
}

export { PREFIX, PKG_ROOT, HOME_DIR, USER_DIR, TRASH_DIR, STATE_FILE };
