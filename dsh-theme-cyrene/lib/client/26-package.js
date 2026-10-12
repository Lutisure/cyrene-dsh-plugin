/**
 * Theme packages: validation, adoption, and undo.
 *
 * ## Why validation is a separate concern
 *
 * A theme package is a file the user got from somewhere else. Everything in it
 * is untrusted input that ends up in a settings document which is then applied
 * to the live interface — so it is checked before any of it is believed, and the
 * check reports *why* rather than a bare refusal.
 *
 * ## Two policies, and they are different
 *
 * - **Rejected**: something that makes the document structurally unusable, or
 *   that would point the theme at a resource it should not follow. A `javascript:`
 *   URL in the avatar, an unknown schema version, a settings value that is not
 *   the type the theme expects. These are errors; the caller gets a list.
 * - **Stripped**: values that are legitimate in *someone's* document but bind to
 *   *their* machine — an absolute `http://…` wallpaper, a route path that only
 *   exists in one installation. These are dropped with a note, because refusing
 *   the whole package over them would make every shared theme unusable.
 *
 * ## Undo rather than a version history
 *
 * One snapshot of the settings document is kept before an import, and the panel
 * offers to put it back. That covers the actual failure mode — "I tried someone
 * else's theme and want mine back" — without the bookkeeping of a history that
 * nothing would ever rotate.
 */

/** What a package says it is. A mismatch means it is not one of ours. */
var PACKAGE_KIND = "dsh-theme-cyrene";

/** The schema version this build writes and the highest it will read. */
var PACKAGE_VERSION = 1;

/** A package is a few kilobytes of settings; anything far past that is not one. */
var PACKAGE_MAX_BYTES = 256 * 1024;

/** Where the pre-import snapshot lives. */
var UNDO_KEY = "dsh-theme-cyrene:undo";

/**
 * The settings keys a package may carry.
 *
 * An allow-list rather than a deny-list: a document that arrives with a key this
 * build has never heard of should be ignored, not applied and hoped for. A
 * deny-list would silently accept the next dangerous key somebody invents.
 */
var PACKAGE_KEYS = {
  skin: "string",
  glass: "boolean",
  glassHue: "string",
  glassTint: "number",
  glassAlpha: "number",
  glassBlur: "number",
  caretColor: "string",
  caretColorCustom: "string",
  caretComposerColor: "string",
  caretComposerCustom: "string",
  fontBodyFamily: "string",
  fontMonoFamily: "string",
  fontScale: "number",
  fontWeight: "number",
  fontSets: "array",
  fontActiveSet: "string",
  clickEffect: "string",
  clickColor: "string",
  clickColorCustom: "string",
  clickOpacity: "number",
  clickBlend: "string",
  trailEffect: "string",
  trailColor: "string",
  trailColorCustom: "string",
  trailOpacity: "number",
  trailBlend: "string",
  particles: "string",
  shade: "number",
  wallBrightness: "number",
  wallSaturate: "number",
  wallContrast: "number",
  wallOpacity: "number",
  wallFog: "number",
  wallScale: "number",
  wallpaperType: "string",
  randomMinutes: "number",
  petOn: "boolean"
};

/**
 * Settings that name a resource, and what counts as one worth keeping.
 *
 * A local path (`/theme-cyrene-assets/…`) resolves inside this installation and
 * is fine. Anything with a scheme — `http:`, `data:`, `javascript:`, `blob:` —
 * is either someone else's server or an inline payload, and neither belongs in a
 * document being adopted from a file.
 */
var PACKAGE_PATH_KEYS = ["wallpaper", "avatarSource", "avatarCustom", "trackId", "wallpaperId"];

/** True for a value that names a resource inside this installation. */
function isLocalAssetPath(value) {
  if (typeof value !== "string") return false;
  if (value === "") return true;
  // A scheme is `word:` before any slash; a local path starts with `/` or is a
  // bare `builtin:…` / `uploaded:…` id, which the theme resolves itself.
  if (/^(builtin|uploaded):/u.test(value)) return true;
  if (/^[a-z][a-z0-9+.-]*:/iu.test(value)) return false;
  return true;
}

/**
 * Check one value against the type the allow-list expects.
 *
 * @param {unknown} value - the candidate.
 * @param {string} kind - `string`, `number`, `boolean` or `array`.
 * @returns {boolean} whether it may be adopted.
 */
function valueFitsKind(value, kind) {
  if (kind === "string") return typeof value === "string" && value.length <= 4096;
  if (kind === "number") return typeof value === "number" && isFinite(value);
  if (kind === "boolean") return typeof value === "boolean";
  if (kind === "array") return Array.isArray(value) && value.length <= 200;
  return false;
}

/**
 * Validate a parsed package.
 *
 * @param {unknown} parsed - the decoded JSON.
 * @param {number} [bytes] - the encoded size, when known.
 * @returns {{ok: boolean, settings?: object, errors: string[], warnings: string[]}} the verdict.
 */
function validatePackage(parsed, bytes) {
  const errors = [];
  const warnings = [];

  if (typeof bytes === "number" && bytes > PACKAGE_MAX_BYTES) {
    return { ok: false, errors: ["文件太大，不像是一个主题包"], warnings };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, errors: ["内容不是一个主题包"], warnings };
  }
  if (parsed.kind !== PACKAGE_KIND) {
    return { ok: false, errors: ["这个文件的 kind 不是 " + PACKAGE_KIND], warnings };
  }

  const version = parsed.version;
  if (version !== PACKAGE_VERSION) {
    // Forward compatibility is refused rather than attempted: a newer package
    // may carry settings whose meaning this build would silently misread.
    return {
      ok: false,
      errors: ["版本 " + String(version) + " 读不了（这个版本只认 " + PACKAGE_VERSION + "）"],
      warnings
    };
  }
  if (parsed.settings === null || typeof parsed.settings !== "object" || Array.isArray(parsed.settings)) {
    return { ok: false, errors: ["包里没有 settings"], warnings };
  }

  const settings = {};
  const incoming = parsed.settings;
  const pathKeys = {};
  for (const key of PACKAGE_PATH_KEYS) pathKeys[key] = true;

  for (const key of Object.keys(incoming)) {
    // Path keys are handled by the second loop, which knows what a usable path
    // looks like. Skipping them here rather than treating them as unknown keeps
    // each key owned by exactly one rule.
    if (pathKeys[key] === true) continue;

    const kind = PACKAGE_KEYS[key];
    if (kind === undefined) {
      warnings.push("跳过了不认识的设置：" + key);
      continue;
    }
    const value = incoming[key];
    if (value === null || value === undefined) continue;
    if (!valueFitsKind(value, kind)) {
      errors.push(key + " 的类型不对（应该是 " + kind + "）");
      continue;
    }
    settings[key] = value;
  }

  for (const key of PACKAGE_PATH_KEYS) {
    const value = incoming[key];
    if (value === null || value === undefined) continue;
    if (typeof value !== "string") {
      errors.push(key + " 应该是路径字符串");
      continue;
    }
    if (!isLocalAssetPath(value)) {
      // Cleared, not merely omitted. `applySettings` merges, so leaving the key
      // out would *keep* whatever path was already there — and an imported
      // document that asks for a remote resource must end up with no resource,
      // not with the previous one by accident.
      //
      // An empty path is the right "nothing" for all of these: the theme already
      // treats `""` as "no wallpaper" and falls back to the built-in portrait.
      settings[key] = "";
      warnings.push("去掉了指向外部的 " + key);
      continue;
    }
    settings[key] = value;
  }

  if (errors.length > 0) return { ok: false, errors, warnings };
  return { ok: true, settings, errors, warnings };
}

/**
 * Store the current document so it can be put back.
 *
 * @param {object} settings - the live settings document.
 * @returns {boolean} whether a snapshot was kept.
 */
function keepUndoSnapshot(settings) {
  try {
    localStorage.setItem(UNDO_KEY, JSON.stringify({
      at: new Date().toISOString(),
      settings: settings
    }));
    return true;
  } catch (error) {
    // Quota, or storage disabled. Not fatal: the import still works, it just
    // cannot be undone, and the caller says so.
    return false;
  }
}

/**
 * Read the snapshot back.
 *
 * @returns {object|null} `{at, settings}`, or null when there is none.
 */
function readUndoSnapshot() {
  try {
    const raw = localStorage.getItem(UNDO_KEY);
    if (raw === null) return null;
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object") return null;
    if (parsed.settings === null || typeof parsed.settings !== "object") return null;
    return parsed;
  } catch (error) {
    return null;
  }
}

/** Forget the snapshot. */
function clearUndoSnapshot() {
  try {
    localStorage.removeItem(UNDO_KEY);
  } catch (error) {
    /* nothing to do */
  }
}

/**
 * Read a chosen file as text.
 *
 * Separated from the adoption path so the reader and the validator can each be
 * exercised: the reader has one failure mode (the file will not come back) and
 * the validator has many.
 *
 * @param {File} file - the chosen file.
 * @returns {Promise<string>} the text; empty when it could not be read.
 */
function readPackageFile(file) {
  return new Promise(function (resolve) {
    var reader = new FileReader();
    reader.onload = function () {
      resolve(String(reader.result === null || reader.result === undefined ? "" : reader.result));
    };
    reader.onerror = function () {
      resolve("");
    };
    reader.readAsText(file);
  });
}

/**
 * Build the document this build writes out.
 *
 * @param {object} settings - the live settings document.
 * @returns {string} pretty-printed JSON.
 */
function buildPackage(settings) {
  const picked = {};
  for (const key of Object.keys(PACKAGE_KEYS)) {
    if (settings[key] !== undefined && settings[key] !== null) picked[key] = settings[key];
  }
  return JSON.stringify({
    kind: PACKAGE_KIND,
    version: PACKAGE_VERSION,
    exportedAt: new Date().toISOString(),
    settings: picked
  }, null, 2);
}
