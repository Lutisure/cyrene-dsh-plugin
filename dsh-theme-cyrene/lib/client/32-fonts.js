/**
 * The font system.
 *
 * ## Why this uses `body` and not `:root`
 *
 * The reconnaissance that preceded this module established the fact the whole
 * design turns on: of the ~29 custom properties the host declares on `:root`,
 * only two are font-related — `--dsw-font-family` and `--ds-font-family-code`.
 * **Every size in the ladder is declared on `body`.** Inheritance loses to a
 * self-declaration, so an override written only on `:root` is inert for the
 * ladder; it has to go on `body` too.
 *
 * ## Why the whole ladder is rebound rather than each size
 *
 * The ladder is written as a `font:` shorthand —
 * `--dsw-font-xs-13: 13px/20px var(--dsw-font-family)` — plus five longhands.
 * CSS variable substitution happens before the shorthand is parsed, so
 * swapping one sub-property in the middle of a `font:` is not a thing that can
 * be done: the declaration simply becomes invalid. A change to family, size or
 * weight therefore has to re-emit the **entire** token with all three parts,
 * which is what `fontToken` does.
 *
 * ## What is deliberately not here
 *
 * `--dsw-font-mono` / `--dsh-font-mono` are not defined by the host at all;
 * only a few components consume them with a fallback. Emitting them would look
 * like it worked and change nothing, so the monospace face goes through
 * `--ds-font-family-code`, which is real.
 */

/**
 * The size ladder, as the host writes it: token suffix → `[size, lineHeight]`.
 *
 * Read from the host's own declaration rather than invented — a size that is
 * not in this table is a token the host does not read, and emitting it would
 * be a silent no-op.
 */
var FONT_LADDER = [
  ["xxxs-11", 11, 18],
  ["xxs-12", 12, 20],
  ["xs-13", 13, 20],
  ["s-14", 14, 22],
  ["base-16", 16, 24],
  ["m-18", 18, 28],
  ["l-20", 20, 30],
  ["xl-24", 24, 36]
];

/**
 * The ladder's baseline: what `--dsh-content-font-size` is before the user
 * touches it. The host derives a delta from this number and shifts the whole
 * markdown step at once, so changing it is not a per-token affair.
 */
var FONT_BASE_SIZE = 14;

/** The markdown faces, as token suffix → the ladder token it tracks. */
var FONT_MARKDOWN = [
  ["--dsw-font-markdown-h1", 24],
  ["--dsw-font-markdown-h2", 20],
  ["--dsw-font-markdown-h3", 18],
  ["--dsw-font-markdown-h4", 16],
  ["--dsw-font-markdown-base", 14],
  ["--dsw-font-markdown-small", 12]
];

/**
 * The monospace consumers this theme can actually reach.
 *
 * `--dsw-font-markdown-code-block` is the one the terminal card reads: the card
 * declares `--dsl-terminal-font: var(--dsw-font-markdown-code-block)` **on
 * itself**, so rebinding `--dsl-terminal-font` from outside loses to that
 * self-declaration. Rebinding the upstream token is the way in.
 */
var FONT_MONO_TOKENS = [
  "--dsw-font-markdown-code",
  "--dsw-font-markdown-code-block",
  "--dsw-font-markdown-code-block-small"
];

/**
 * One `font:` value from its three parts.
 *
 * `lineHeight` is passed through as given — a unitless number is a multiplier
 * and stays correct when the size changes, which a fixed px would not.
 *
 * @param {string} family - a font-family stack.
 * @param {number} size - px.
 * @param {number} lineHeight - px, used as written.
 * @param {number|string} weight - a numeric weight.
 * @returns {string} the shorthand value, without the `font:` prefix.
 */
function fontToken(family, size, lineHeight, weight) {
  return weight + " " + size + "px/" + lineHeight + "px " + family;
}

/**
 * Make a user-typed face safe to concatenate into a declaration.
 *
 * The input is a `font-family` list, which legitimately contains quotes, commas
 * and spaces. It must not contain a semicolon, a brace or a newline: any of
 * those ends the declaration and lets whatever follows become separate rules.
 * The blast radius is only this user's own interface — a `<style>` element
 * cannot execute script — but "a typo silently rewrites unrelated rules" is
 * still a bug worth not shipping, and none of those characters belong in a face
 * name anyway.
 *
 * @param {unknown} value - the raw setting.
 * @returns {string} a single-line declaration value, or `""` for "do not override".
 */
function safeFace(value) {
  if (value === undefined || value === null) return "";
  return String(value)
    .replace(/[;{}\r\n]/g, "")
    .replace(/\/\*/g, "")
    .trim();
}

/**
 * Build the font stylesheet from the user's choices.
 *
 * @param {object} settings - the settings document.
 * @returns {string} CSS text, or an empty string when nothing is customised.
 */
function fontCSS(settings) {
  var body = safeFace(settings.fontBodyFamily);
  var mono = safeFace(settings.fontMonoFamily);
  var scale = Number(settings.fontScale);
  if (!isFinite(scale) || scale <= 0) scale = 1;
  var weight = Number(settings.fontWeight);
  if (!isFinite(weight) || weight < 100) weight = 0;

  // Each of the four knobs is independent, so this is a set of opt-ins rather
  // than one switch: changing only the face must not also re-emit sizes (it
  // would freeze them at today's numbers), and changing only the size must not
  // pin the family.
  var faceChanged = body !== "";
  var sizeChanged = scale !== 1;
  var weightChanged = weight !== 0;
  var monoChanged = mono !== "" || sizeChanged;
  if (!faceChanged && !sizeChanged && !weightChanged && !monoChanged) return "";

  var family = faceChanged ? body : "var(--dsw-font-family)";
  var lines = [];

  // The two tokens the host keeps on `:root`. Written on both scopes: `:root`
  // for anything that reads them before reaching body, `body` because body's
  // own declaration is what the ladder's `var()` resolves against.
  if (faceChanged) {
    lines.push(IDENTITY_SCOPE + ", " + IDENTITY_SCOPE + " body { --dsw-font-family: " + family + " !important; }");
  }
  if (mono !== "") {
    lines.push(IDENTITY_SCOPE + ", " + IDENTITY_SCOPE + " body { --ds-font-family-code: " + mono + " !important; }");
  }

  var declarations = [];

  // The ladder. Every entry is re-emitted whole, because swapping one
  // sub-property inside a `font:` shorthand makes the declaration invalid —
  // substitution happens before the shorthand is parsed.
  if (faceChanged || sizeChanged || weightChanged) {
    for (var index = 0; index < FONT_LADDER.length; index += 1) {
      var step = FONT_LADDER[index];
      var name = "--dsw-font-" + step[0];
      var size = sizeChanged ? Math.round(step[1] * scale * 100) / 100 : step[1];
      var leading = sizeChanged ? Math.round(step[2] * scale * 100) / 100 : step[2];
      // The longhands are emitted with the same values as the shorthand so a
      // component reading a longhand directly cannot keep the old size.
      declarations.push("  " + name + ": " + fontToken(family, size, leading, weightChanged ? weight : 400) + " !important;");
      if (faceChanged) declarations.push("  " + name + "-font-family: " + family + " !important;");
      if (sizeChanged) declarations.push("  " + name + "-font-size: " + size + "px !important;");
      if (weightChanged) declarations.push("  " + name + "-font-weight: " + weight + " !important;");
      if (sizeChanged) declarations.push("  " + name + "-line-height: " + leading + "px !important;");
    }

    // The markdown step rides on one base plus a delta, so the base is what has
    // to move; scaling the tokens alone would leave the delta behind.
    if (sizeChanged) {
      declarations.push("  --dsh-content-font-size: " + Math.round(FONT_BASE_SIZE * scale * 100) / 100 + "px !important;");
    }

    for (var markdown = 0; markdown < FONT_MARKDOWN.length; markdown += 1) {
      var face = FONT_MARKDOWN[markdown];
      var faceSize = sizeChanged ? Math.round(face[1] * scale * 100) / 100 : face[1];
      var faceLeading = Math.round(faceSize * 1.6 * 100) / 100;
      declarations.push("  " + face[0] + ": " + fontToken(family, faceSize, faceLeading, weightChanged ? weight : 400) + " !important;");
    }
  }

  // The monospace consumers, through the upstream token the terminal card
  // reads. Rebinding `--dsl-terminal-font` itself loses to the card's own
  // declaration, which is why that name does not appear here.
  if (monoChanged) {
    var monoFamily = mono !== "" ? mono : "var(--ds-font-family-code)";
    var monoSize = Math.round(11 * scale * 100) / 100;
    for (var token = 0; token < FONT_MONO_TOKENS.length; token += 1) {
      declarations.push("  " + FONT_MONO_TOKENS[token] + ": " + fontToken(monoFamily, monoSize, Math.round(monoSize * 1.7 * 100) / 100, 400) + " !important;");
    }
  }

  if (declarations.length > 0) {
    lines.push(IDENTITY_SCOPE + " body {");
    lines.push(declarations.join("\n"));
    lines.push("}");
  }

  return lines.join("\n");
}

/**
 * Names a preset may not take.
 *
 * `宿主默认` is the one entry in the picker that means "strip everything",
 * so a user preset with that name would be unreachable — clicking it would run
 * the reset instead of applying the saved numbers. `Restore` is refused rather
 * than silently renamed so the reason is visible.
 *
 * @param {string} name - the candidate.
 * @returns {boolean} true when the name collides with the built-in entry.
 */
function isReservedFontName(name) {
  return String(name).trim() === "宿主默认";
}

/**
 * Read the font choices out of a preset-shaped object.
 *
 * Presets and the live settings share these four keys, so applying a preset is
 * a straight copy and a preset is a plain, portable, hand-editable document —
 * which is also what the export writes.
 *
 * @param {object} source - a preset or a settings document.
 * @returns {object} the four font keys, with unusable values dropped.
 */
function fontPick(source) {
  var pick = {};
  if (!isPlainObject(source)) return pick;
  var faces = ["fontBodyFamily", "fontMonoFamily"];
  for (var index = 0; index < faces.length; index += 1) {
    var face = safeFace(source[faces[index]]);
    if (face !== "") pick[faces[index]] = face;
  }
  var scale = Number(source.fontScale);
  if (isFinite(scale) && scale > 0) pick.fontScale = scale;
  var weight = Number(source.fontWeight);
  if (isFinite(weight) && weight >= 100) pick.fontWeight = weight;
  return pick;
}

/**
 * Resolve one caret setting into a declaration value.
 *
 * @param {string} mode - an id from `CARET_COLORS`.
 * @param {string} custom - the picker's value, used by `custom`.
 * @returns {string} a colour, or `""` for "do not override".
 */
function caretValue(mode, custom) {
  var chosen = String(mode === undefined || mode === null ? "auto" : mode);
  if (chosen === "auto") return "";
  if (chosen === "accent") {
    // The token the composer already uses, so "accent" on the global position
    // makes the other fields match the composer rather than differ from it.
    return "var(--dsw-alias-state-business-primary)";
  }
  if (chosen === "custom") return safeFace(custom);
  for (var index = 0; index < CARET_COLORS.length; index += 1) {
    if (CARET_COLORS[index].id === chosen) return CARET_COLORS[index].value;
  }
  return "";
}

/**
 * The caret stylesheet.
 *
 * Written on `html` rather than on a selector per input: `caret-color`
 * inherits, so one declaration reaches every text field the host renders —
 * including the sidebar search box, which has no stable selector of its own
 * (only a build-hashed class name) and therefore cannot be targeted directly.
 * The composer is then the one position worth naming, because it already
 * carries the host's own colour and would otherwise be flattened by the global
 * value.
 *
 * @param {object} settings - the settings document.
 * @returns {string} CSS text, or an empty string when both are left alone.
 */
function caretCSS(settings) {
  var lines = [];

  var global = caretValue(settings.caretColor, settings.caretColorCustom);
  if (global !== "") {
    lines.push(IDENTITY_SCOPE + " { caret-color: " + global + " !important; }");
  }

  var composer = caretValue(settings.caretComposerColor, settings.caretComposerCustom);
  if (composer !== "") {
    // The one stable hook the recon found on the composer; its siblings are
    // build-hashed class names that change every release.
    lines.push(IDENTITY_SCOPE + " [data-composer-input] { caret-color: " + composer + " !important; }");
  }

  return lines.join("\n");
}

/**
 * Create the font layer: one stylesheet, rewritten whenever the settings change.
 *
 * @returns {{apply: (settings: object) => void, dispose: () => void}} the layer API.
 */
function createFontLayer() {
  var unmount = mountStyle("", "fonts");

  return {
    /**
     * Re-emit the sheet for a settings document.
     * @param {object} next - the settings document.
     */
    apply: function (next) {
      unmount();
      // The caret rides in the same sheet as the faces: both are one small
      // block of declarations about how text looks, and two sheets would mean
      // two mount points to keep in step for no gain.
      var css = [caretCSS(next), fontCSS(next)].filter(function (part) {
        return part !== "";
      }).join("\n");
      unmount = mountStyle(css, "fonts");
    },
    dispose: function () {
      unmount();
    }
  };
}
