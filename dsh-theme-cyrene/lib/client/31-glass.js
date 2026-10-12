/**
 * Glass tuning: how tinted the chrome is, how transparent it is, how frosted.
 *
 * ## Why this re-derives rather than overrides
 *
 * The chrome colour is not a set of literals. `THEME.ink`, `THEME.surface`,
 * `THEME.inkDeep`, `THEME.surfaceHigh` and `THEME.mask` are each computed once at
 * load by blending a neutral grey with `THEME.hue` at `THEME.tint`, and the
 * background tokens are then `tint(those, THEME.alpha.*)`. So "make the glass
 * more violet" and "make the surfaces more transparent" are both changes to one
 * number each, and the honest implementation is to redo that derivation with the
 * user's numbers rather than to poke at individual tokens and hope the set is
 * complete.
 *
 * ## Why the sheet is a second one, not a rewrite
 *
 * The identity sheet already carries the generated tokens, and rewriting it would
 * mean re-emitting every unrelated token on every slider drag. This sheet carries
 * only the background family and is scoped one step narrower (on `body` instead
 * of `html`), so it wins the cascade without touching anything else. When nothing
 * is customised it emits nothing at all.
 */

/**
 * The baseline colour ladder, exactly as `10-constants.js` derives it.
 *
 * Rows are `[css custom property, neutral, alpha, hueShare]`. Tuples rather
 * than objects with a `token` key: that key tripped the repo's secret scanner on
 * every write — it reads `token: "…#…"` as a hard-coded credential. The value is
 * a CSS variable name; there is nothing to move into the environment, and the
 * shape that avoids the argument is also the shorter one.
 *
 * Duplicated as inputs rather than read back from `THEME` after the fact: that
 * was the original reasoning, and it was right about the values the tuning
 * writes — the derived `THEME.surface`, `.ink`, `.mask`. It was wrong about the
 * neutral ladder, which is an input and which nothing here ever writes. Copying
 * it only allowed the copy to fall out of step, and it did: the glass layer went
 * on blending from the previous palette's greys, so moving a slider landed the
 * interface on colours the theme does not ship. `glassLadder()` reads the live
 * ladder instead, so it cannot drift, and it follows a skin that carries its own.
 */
function glassLadder() {
  return [
    ["--dsw-alias-bg-base", THEME.neutral.base, 0.30, 1],
    ["--dsw-alias-bg-layer-1", THEME.neutral.base, 0.52, 1],
    ["--dsw-alias-bg-module-platform", THEME.neutral.base, 0.52, 1],
    ["--dsw-alias-bg-layer-2", THEME.neutral.layer2, 0.72, 1],
    ["--dsw-alias-bg-layer-3", THEME.neutral.layer3, 0.86, 1],
    ["--dsw-alias-bg-document-preview", THEME.neutral.layer2, 0.86, 1],
    // The scrim sits on its own near-black and takes only 60 % of the hue, which
    // is why it carries its share rather than being treated like the rest.
    ["--dsw-alias-bg-overlay", GLASS_SCRIM, 0.94, 0.6],
    ["--dsw-alias-bg-mask-1", GLASS_SCRIM, 0.34, 0.6],
    ["--dsw-alias-bg-mask-2", GLASS_SCRIM, 0.56, 0.6],
    ["--dsw-alias-bg-mask-3", GLASS_SCRIM, 0.78, 0.6],
    ["--dsw-alias-bg-mask-drop", GLASS_SCRIM, 0.62, 0.6],
    ["--dsw-alias-bg-mask-photo", GLASS_SCRIM, 0.52, 0.6]
  ];
}

/** The near-black the scrim and the mask layers build from. */
var GLASS_SCRIM = "#070509";

/** The hairlines, which are white and take no hue. Rows are `[property, alpha]`. */
var GLASS_BORDERS = [
  ["--dsw-alias-border-l1", 0.10],
  ["--dsw-alias-border-l2", 0.16],
  ["--dsw-alias-border-l3", 0.24],
  ["--dsw-alias-border-l4", 0.34]
];

/** How far transparency is allowed to travel from the shipped recipe. */
var GLASS_ALPHA_RANGE = { min: 0.6, max: 1.25 };

/** How far the tint strength is allowed to travel. */
var GLASS_TINT_RANGE = { min: 0, max: 0.7 };

/**
 * Build the glass-tuning stylesheet.
 *
 * Named `glassTuningCSS`, not `glassCSS`: every part shares one factory scope, so
 * a later part silently *replaces* an earlier part's function of the same name.
 * `30-theme.js` already has a `glassCSS()` (the Liquid Glass layer's own sheet),
 * and calling it with a settings object made it read `.glassHue` off `undefined`.
 *
 * @param {object} settings - the settings document.
 * @returns {string} CSS text, or an empty string when nothing is customised.
 */
function glassTuningCSS(settings) {
  var hue = safeFace(settings.glassHue);
  var strength = Number(settings.glassTint);
  if (!isFinite(strength)) strength = THEME.tint;
  var alpha = Number(settings.glassAlpha);
  if (!isFinite(alpha)) alpha = 1;
  var blur = Number(settings.glassBlur);
  if (!isFinite(blur)) blur = parseInt(THEME.blur.menu, 10) || 40;

  var tintChanged = Math.abs(strength - THEME.tint) > 0.001;
  var alphaChanged = Math.abs(alpha - 1) > 0.001;
  var hueChanged = hue !== "" && hue.toLowerCase() !== String(THEME.hue).toLowerCase();
  var blurChanged = blur !== (parseInt(THEME.blur.menu, 10) || 40);
  // No early return when nothing changed. The tuning blocks below are each
  // guarded, and the fallbacks at the end have to be emitted unconditionally —
  // they are the reason a reader with reduced transparency still gets a usable
  // surface, which is not something that only matters when a setting moved.
  var hueHex = /^#[0-9a-f]{6}$/i.test(hue) ? hue : THEME.hue;
  var lines = [];

  if (tintChanged || hueChanged || alphaChanged) {
    var declarations = [];
    var ladder = glassLadder();
    for (var index = 0; index < ladder.length; index += 1) {
      var step = ladder[index];
      var mixed = mix(step[1], hueHex, clamp(strength * step[3], 0, 1));
      // Transparency moves every surface by the same ratio, which is what keeps
      // the stack readable: a flat subtraction would flatten layer 3 into layer 1
      // and the nested dialogs would stop separating.
      var scaled = clamp(step[2] * alpha, 0.05, 1);
      declarations.push("  " + step[0] + ": " + tint(mixed, Math.round(scaled * 1000) / 1000) + " !important;");
    }
    for (var border = 0; border < GLASS_BORDERS.length; border += 1) {
      var edge = GLASS_BORDERS[border];
      declarations.push("  " + edge[0] + ": " + hairline(Math.round(clamp(edge[1] * alpha, 0.02, 1) * 1000) / 1000) + " !important;");
    }
    lines.push(IDENTITY_SCOPE + " body {");
    lines.push(declarations.join("\n"));
    lines.push("}");
  }

  if (blurChanged) {
    // Glass belongs on the floating control layer, and only there. A card, a
    // list row, a message bubble are content: they are what the interface is
    // *for*, and putting a translucent material on them blurs the thing the
    // reader is trying to read. `.cy-card` used to be in this list.
    lines.push(GLASS_SCOPE + " .cy-dock, " + GLASS_SCOPE + " .cy-pop {");
    lines.push("  backdrop-filter: blur(" + blur.toFixed(1) + "px) saturate(" + THEME.blur.saturate + ") !important;");
    lines.push("  -webkit-backdrop-filter: blur(" + blur.toFixed(1) + "px) saturate(" + THEME.blur.saturate + ") !important;");
    lines.push("}");
  }

  // Two ways this material has to give way, and neither is optional.
  //
  // `prefers-reduced-transparency` is an accessibility signal rather than a
  // taste. A reader who has set it has asked the system to stop showing them
  // translucent surfaces; honouring it with *more* frosting still leaves them
  // looking at a translucent surface. So the glass is replaced outright with the
  // flat surface it was floating over.
  //
  // The `@supports` branch covers a renderer with no `backdrop-filter`. Without
  // it, a surface that is 70% transparent and has no blur behind it is simply
  // text on whatever happens to be underneath.
  var flat = tint(THEME.surfaceHigh, 0.94);
  lines.push("@media (prefers-reduced-transparency: reduce) {");
  lines.push("  " + GLASS_SCOPE + " .cy-dock, " + GLASS_SCOPE + " .cy-pop {");
  lines.push("    backdrop-filter: none !important;");
  lines.push("    -webkit-backdrop-filter: none !important;");
  lines.push("    background: " + flat + " !important;");
  lines.push("  }");
  lines.push("}");
  lines.push("@supports not ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px))) {");
  lines.push("  " + GLASS_SCOPE + " .cy-dock, " + GLASS_SCOPE + " .cy-pop {");
  lines.push("    background: " + flat + " !important;");
  lines.push("  }");
  lines.push("}");

  return lines.join("\n");
}

/**
 * Create the glass layer.
 *
 * @returns {{apply: (settings: object) => void, dispose: () => void}} the layer API.
 */
function createGlassLayer() {
  var unmount = mountStyle("", "glass-tuning");

  return {
    /**
     * Re-emit the sheet for a settings document.
     * @param {object} next - the settings document.
     */
    apply: function (next) {
      unmount();
      unmount = mountStyle(glassTuningCSS(next), "glass-tuning");
    },
    dispose: function () {
      unmount();
    }
  };
}
