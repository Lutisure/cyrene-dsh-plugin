/**
 * Identity, the tunable theme block, and the derived design-token map.
 *
 * Everything visual derives from `THEME`, so changing the look is a handful of
 * numbers rather than a hunt through 120 token strings. `TOKENS` is used twice
 * on purpose: once as the argument to `ctx.theme.register()`, and again — with
 * `!important` — inside the plugin's own stylesheet. Registration alone does
 * not reliably beat the shipped sheet, so the second copy is what makes the
 * values stick.
 */

/**
 * Plugin id — **must equal `package.json`'s `name`, exactly.**
 *
 * Two independent mechanisms compare this string, and getting it wrong fails
 * differently in each:
 *
 *   1. the client module loader registers the browser half under the package
 *      name, so a registration whose `id` disagrees makes it install the same
 *      file twice and the entire web boot dies with
 *      `duplicate factory registration for "..."`;
 *   2. the host claims — and later removes — the plugin's `<style>` tags by
 *      matching `style[data-plugin]` against that same id (the runtime's
 *      `claimStyles(id)` / `removeOwnedStyles(id)`). Tag a sheet with anything
 *      else and the host concludes the plugin owns no styles, so HMR and
 *      uninstall leak them.
 *
 * DSH's own client plugins tag their sheets with the scoped package name
 * (`tag.dataset.plugin = "@deepseek-ai/dsh-client-locale"`), which is the
 * convention this follows.
 *
 * `lib/client/00-prologue.js` carries the loader copy of the value, and
 * `build.mjs` asserts it matches `package.json` before writing the bundle — so
 * a rename that misses one of the two fails the build instead of the boot.
 */
var PLUGIN_ID = "@lutisure/dsh-theme-cyrene";

/** Theme id handed to the theme service. */
var THEME_ID = "cyrene";

/** The single route prefix the host half owns. */
var ROUTE = "/theme-cyrene-assets";

/**
 * localStorage key for the instant-boot mirror of the settings.
 *
 * Deliberately **not** derived from `PLUGIN_ID`. This is persisted user data:
 * re-scoping it would silently reset every setting the user has, for no gain —
 * only the host matches ids, and it never reads our storage keys.
 *
 * `UNDO_KEY`, `BOOT_SESSION_KEY`, `PACKAGE_KIND` and the fontset document kind
 * keep their historical prefixes for the same reason. They name on-disk
 * *formats* and storage slots, which have to outlive a rename; `PLUGIN_ID` is
 * the only identifier that has to keep up with one.
 */
var STORAGE_KEY = "dsh-theme-cyrene:settings";

/** The background stack sits behind every shell surface. */
/** Above the shell, matching the emote and the pet. */
var LAYER_CELEBRATE = 6;

/** Corner offset of the end-of-turn flourish, aligned with the dock. */
var CELEBRATE_MARGIN = 22;

/** Fade length. Counted inside the overlay total, so visible time is unchanged. */
var CELEBRATE_FADE_MS = 320;

var LAYER_WALLPAPER = -2;
var LAYER_SHADE = -1;

/**
 * The one place the look is defined.
 *
 * The palette follows Apple's material system, which is mostly a discipline of
 * **restraint** — and the previous version broke it in four specific ways:
 *
 *  - **Chrome is near-neutral.** Apple's dark surfaces are greys (#1C1C1E,
 *    #2C2C2E, #3A3A3C) and colour is reserved for accents. The old palette
 *    tinted every surface ~40 % purple, so the pink accent had nothing to sit
 *    against and the whole window read as one flat wash. The hue now only
 *    *leaks* into the neutrals, at `tint` — which makes "how purple is the UI"
 *    a single number you can dial.
 *  - **Edges are neutral hairlines plus a specular top highlight**, not coloured
 *    outlines. That inner light is what makes a surface read as a material
 *    rather than a rectangle.
 *  - **Shadows are wide, soft and near-black.** Tinted purple shadows at 0.5
 *    opacity read as a glow, not as depth.
 *  - **Blur is stronger and saturated** (Apple's recipe); that is what separates
 *    a translucent layer from a smudge.
 *
 * The type metrics and font stack shipped by `dsh-client-ui-theme` are already
 * Apple-calibrated (`-apple-system` first, Microsoft YaHei for Windows CJK, 16/24
 * body), so this theme deliberately does not touch them.
 *
 * Depth stays conservative: stacked surfaces remain close to opaque because a
 * settings dialog that lets the dialog behind it read through shows visible
 * text ghosting, which is far worse than losing a little translucency.
 */
var THEME = {
  /* ---- the neutral ladder: a violet near-black, rising by luminance ----
   *
   * Elevation on a dark interface is expressed by getting **lighter**, not by
   * casting a shadow — a shadow on a dark surface has nothing to darken. So the
   * ladder is the elevation language, and the steps are the whole mechanism.
   *
   * This is the 薄暮 ladder: every step already carries a little of the hue, so
   * the interface reads as one colour at six depths rather than as grey with a
   * coloured accent bolted on.
   */
  neutral: {
    deep: "#100c15",
    base: "#1a1220",
    layer1: "#23182c",
    layer2: "#2d1f38",
    layer3: "#392845",
    high: "#463153"
  },
  /** The colour mixed into the neutrals, and how much. 0 = pure grey. */
  hue: "#6d3d8f",
  tint: 0.10,

  /* ---- accents: the identity lives here, not in the chrome ----
   *
   * `pinkStrong` is borrowed from Cyrene-xl/DSH-Cyrene's published recipe
   * (MIT), whose `dsh-dream-skin:accent` is `#f472b6`. Their value is far more
   * saturated than the pale pink this theme shipped with, so it is used where
   * emphasis belongs — hover, focus, the active nav marker — while `pink` and
   * `pinkSoft` stay soft for large fills. Adopting it everywhere would have
   * turned the theme neon and cost the 淡粉 identity.
   */
  pink: "#ffc9e6",
  pinkStrong: "#d946ef",
  pinkSoft: "#ffe9f6",
  purple: "#c9a4ff",
  text: "#f4eef9",
  success: "#8ee6bd",
  warn: "#ffd9a0",
  danger: "#ff9fb6",
  info: "#b3c3ff",

  /* ---- surface opacity ----
   *
   * Three bands, and they are not interchangeable:
   *
   *   - **content** (`bubble`, `input`, `card`, `panel`) is solid. These surfaces
   *     carry text the reader is reading. A translucent one puts the text below
   *     and the text on top in the same place, which is the double-image bug this
   *     theme already shipped once.
   *   - **base** stays open, so the wallpaper is still the point.
   *   - **glass** is the floating control layer: the dock and the popovers. This
   *     one has to be low enough that the blurred backdrop is what you are
   *     looking at, because otherwise the material is just paint. It was 0.93 and
   *     0.97 at the two call sites — opaque enough that `backdrop-filter` was
   *     present and doing nothing, which is exactly how it looked.
   */
  alpha: {
    base: 0.30,
    layer1: 0.52,
    layer2: 0.72,
    layer3: 0.86,
    panel: 0.94,
    scrim: 0.72,
    bubble: 0.80,
    input: 0.88,
    card: 0.86,
    glass: 0.62
  },

  /* ---- hairlines: white, so they read as edges rather than as colour ---- */
  border: { hairline: 0.07, l1: 0.10, l2: 0.16, l3: 0.24, l4: 0.34, accent: 0.44 },

  /** The inner top light that makes a surface read as a material. */
  specular: "inset 0 0.5px 0 rgba(255,255,255,0.10), inset 0 0 0 0.5px rgba(255,255,255,0.06)",
  specularColor: "rgba(255,255,255,0.10)",

  /* ---- elevation: wide, soft, near-black ---- */
  shadow: {
    soft: "0 1px 2px rgba(0,0,0,0.28), 0 6px 20px rgba(0,0,0,0.22)",
    panel: "0 2px 6px rgba(0,0,0,0.30), 0 20px 56px rgba(0,0,0,0.44)",
    prominent: "0 4px 12px rgba(0,0,0,0.34), 0 32px 80px rgba(0,0,0,0.56)",
    lv1: "0 1px 2px rgba(0,0,0,0.24), 0 4px 12px rgba(0,0,0,0.18)",
    lv2: "0 2px 6px rgba(0,0,0,0.28), 0 12px 32px rgba(0,0,0,0.28)",
    lv3: "0 4px 10px rgba(0,0,0,0.32), 0 24px 60px rgba(0,0,0,0.44)"
  },

  /* ---- wallpaper treatment ---- */
  wallBrightness: 1.22,
  wallSaturate: 1.10,
  /** Default darkness of the readability gradient; much lighter than before. */
  shade: 0.14,

  /* ---- shape: the shipped 4/8/12/16/20 scale, which is already geometric ---- */
  radius: { xs: "5px", sm: "8px", md: "12px", lg: "16px", xl: "20px", panel: "22px" },
  /**
   * The material, by the numbers rather than by eye.
   *
   * `backdrop-filter` costs real frames — measured at 15–30% on device — so the
   * blur is kept inside the range where it reads as frosting instead of as a
   * smear, and the saturation inside the range where it lifts the backdrop
   * without turning it into a colour cast. `saturate` is a value here rather
   * than a literal at each call site, which is what it used to be: 200% was
   * hard-coded in the glass layer and 180% in the theme layer, two different
   * numbers for one intent, neither of them adjustable.
   */
  blur: { mask: "14px", menu: "14px", saturate: "150%" }
};

/**
 * `#rrggbb` + alpha → an `rgba()` string.
 * @param {string} hex - a six-digit hex colour.
 * @param {number} alpha - 0..1.
 * @returns {string} the rgba() value.
 */
function tint(hex, alpha) {
  var value = parseInt(hex.slice(1), 16);
  var r = (value >> 16) & 255;
  var g = (value >> 8) & 255;
  var b = value & 255;
  return "rgba(" + r + "," + g + "," + b + "," + alpha + ")";
}

/**
 * Blend two `#rrggbb` colours channel by channel.
 * @param {string} from - the colour at `t = 0`.
 * @param {string} to - the colour at `t = 1`.
 * @param {number} t - the mix amount, 0..1.
 * @returns {string} the blended `#rrggbb`.
 */
function mix(from, to, t) {
  var a = parseInt(from.slice(1), 16);
  var b = parseInt(to.slice(1), 16);
  var out = 0;
  for (var shift = 16; shift >= 0; shift -= 8) {
    var value = Math.round((((a >> shift) & 255) * (1 - t)) + (((b >> shift) & 255) * t));
    out |= Math.max(0, Math.min(255, value)) << shift;
  }
  return "#" + (out >>> 0).toString(16).padStart(6, "0");
}

/**
 * A white hairline. Neutral on purpose: Apple's separators are light catching a
 * surface edge, not a coloured stroke.
 * @param {number} alpha - 0..1.
 * @returns {string} the rgba() value.
 */
function hairline(alpha) {
  return "rgba(255,255,255," + alpha + ")";
}

/**
 * The chrome surfaces. Derived rather than written out so that one number —
 * {@link THEME.tint} — controls how much of the theme hue the chrome carries.
 */
THEME.inkDeep = mix(THEME.neutral.deep, THEME.hue, THEME.tint);
THEME.ink = mix(THEME.neutral.base, THEME.hue, THEME.tint);
THEME.surface = mix(THEME.neutral.layer2, THEME.hue, THEME.tint);
THEME.surfaceHigh = mix(THEME.neutral.layer3, THEME.hue, THEME.tint);
/** Scrims sit on their own near-black, darker than the base surface. */
THEME.mask = mix("#070509", THEME.hue, THEME.tint * 0.6);

/** The palette the rest of the plugin reads. */
var PALETTE = {
  ink: THEME.ink,
  inkDeep: THEME.inkDeep,
  pink: THEME.pink,
  pinkStrong: THEME.pinkStrong,
  pinkSoft: THEME.pinkSoft,
  purple: THEME.purple,
  text: THEME.text,
  success: THEME.success,
  warn: THEME.warn,
  danger: THEME.danger,
  info: THEME.info
};

/** The `--dsw-*` overrides, derived from {@link THEME}. */
/**
 * The `--dsw-*` overrides.
 *
 * Built by a function rather than written out, because a skin switch replaces
 * every value derived from the theme. `TOKENS` keeps its identity so the
 * ~ninety places that read it see the new skin without being touched.
 *
 * @returns {void}
 */
function refreshTokensFromTheme() {
  var next = {
    /* ---- base surfaces: the only ones open enough to read the wallpaper through ---- */
    "--dsw-alias-bg-base": tint(THEME.ink, THEME.alpha.base),
    "--dsw-alias-bg-layer-1": tint(THEME.ink, THEME.alpha.layer1),
    "--dsw-alias-bg-layer-2": tint(THEME.surface, THEME.alpha.layer2),
    "--dsw-alias-bg-layer-3": tint(THEME.surface, THEME.alpha.layer3),
    /* Dialogs and sheets: near-opaque on purpose, so a nested dialog cannot ghost. */
    "--dsw-alias-bg-overlay": tint(THEME.mask, THEME.alpha.panel),
    "--dsw-alias-bg-module-platform": tint(THEME.ink, THEME.alpha.layer1),
    "--dsw-alias-bg-document-preview": tint(THEME.surface, 0.86),
    "--dsw-alias-bg-document-selection": tint(THEME.purple, 0.26),
    "--dsw-alias-bg-multi-select": tint(THEME.purple, 0.20),
    "--dsw-alias-bg-skeleton": tint(THEME.pinkSoft, 0.12),
    "--dsw-alias-bg-mask-1": tint(THEME.mask, 0.34),
    "--dsw-alias-bg-mask-2": tint(THEME.mask, 0.56),
    "--dsw-alias-bg-mask-3": tint(THEME.mask, 0.78),
    "--dsw-alias-bg-mask-drop": tint(THEME.mask, 0.62),
    "--dsw-alias-bg-mask-photo": tint(THEME.mask, 0.52),

    /* ---- text: a wider ladder than before, which was too flat to read as hierarchy ---- */
    "--dsw-alias-label-primary": THEME.text,
    "--dsw-alias-label-secondary": tint(THEME.text, 0.72),
    "--dsw-alias-label-tertiary": tint(THEME.text, 0.50),
    "--dsw-alias-label-dimmed": tint(THEME.text, 0.34),
    "--dsw-alias-label-caption": tint(THEME.text, 0.44),
    "--dsw-alias-label-primary-inverted": THEME.inkDeep,
    "--dsw-alias-label-primary-foreground": THEME.inkDeep,
    "--dsw-alias-label-primary-dimmed": tint(THEME.text, 0.68),
    "--dsw-alias-label-primary-bluish": "#ded7ff",
    "--dsw-alias-label-document-preview": tint(THEME.text, 0.74),
    "--dsw-alias-label-shimmer": tint(THEME.pinkSoft, 0.26),
    "--dsw-alias-label-deep-diving": THEME.pinkSoft,
    "--dsw-alias-label-deep-diving-shimmer": tint(THEME.pinkSoft, 0.36),

    /* ---- brand & links ---- */
    "--dsw-alias-brand-primary": THEME.pink,
    "--dsw-alias-brand-primary-invert": THEME.inkDeep,
    "--dsw-alias-brand-text": THEME.inkDeep,
    "--dsw-alias-link": THEME.purple,

    /* ---- borders: white hairlines; colour is reserved for the accent ---- */
    "--dsw-alias-border-l1": hairline(THEME.border.l1),
    "--dsw-alias-border-l2": hairline(THEME.border.l2),
    "--dsw-alias-border-l2-darkmode-thin": hairline(THEME.border.hairline),
    "--dsw-alias-border-l3": hairline(THEME.border.l3),
    "--dsw-alias-border-l4": hairline(THEME.border.l4),
    "--dsw-alias-border-inverted": "rgba(255,255,255,0.26)",
    "--dsw-alias-border-inverted2": "rgba(255,255,255,0.36)",

    /* ---- interactive states: a neutral fill, with colour for the chosen thing ---- */
    "--dsw-alias-interactive-bg-hover": hairline(0.07),
    "--dsw-alias-interactive-bg-hover-solid": hairline(0.12),
    "--dsw-alias-interactive-bg-active": hairline(0.16),
    "--dsw-alias-interactive-bg-hover-accent": tint(THEME.purple, 0.24),
    "--dsw-alias-interactive-bg-hover-danger": tint(THEME.danger, 0.24),

    /* ---- specific surfaces: chat bubbles and the composer were the ghosting pair ---- */
    "--dsw-specific-sidebar-fill": tint(THEME.ink, THEME.alpha.layer1),
    "--dsw-specific-sidebar-nav-item-hover": hairline(0.07),
    "--dsw-specific-sidebar-nav-item-active": tint(THEME.pink, 0.18),
    "--dsw-specific-sidebar-nav-item-active-accent": THEME.pink,
    "--dsw-specific-menu": tint(THEME.surface, THEME.alpha.panel),
    "--dsw-specific-bubble": tint(THEME.surface, THEME.alpha.bubble),
    "--dsw-specific-bubble-highlight": tint(THEME.pink, 0.20),
    "--dsw-specific-input-major": tint(THEME.surface, THEME.alpha.input),
    "--dsw-specific-login-input": tint(THEME.surface, THEME.alpha.input),
    "--dsw-specific-selector": tint(THEME.surface, THEME.alpha.panel),
    "--dsw-specific-tip": tint(THEME.pinkSoft, 0.16),

    /* ---- menus, cards, toasts ---- */
    "--dsw-menu-surface-fill": tint(THEME.surfaceHigh, THEME.alpha.panel),
    "--dsw-alias-menu-group-header-fill": tint(THEME.purple, 0.10),
    "--dsw-alias-menu-icon": tint(THEME.text, 0.74),
    "--dsw-alias-settings-card-fill": tint(THEME.surface, THEME.alpha.card),
    "--dsw-alias-settings-card-stroke": hairline(THEME.border.l2),
    "--dsw-alias-toast-bg": tint(THEME.surfaceHigh, 0.95),
    "--dsw-alias-toast-label": THEME.text,
    "--dsw-alias-tooltip-bg": tint(THEME.inkDeep, 0.96),
    "--dsw-alias-tooltip-key-bg": tint(THEME.purple, 0.18),

    /* ---- buttons ---- */
    "--dsw-alias-button-primary-fill": THEME.pink,
    "--dsw-alias-button-primary-hover": THEME.pinkStrong,
    "--dsw-alias-button-primary-dimmed": tint(THEME.pink, 0.50),
    "--dsw-alias-button-contrast-fill": "rgba(255,255,255,0.94)",
    "--dsw-alias-button-elevated-fill": tint(THEME.surface, 0.84),
    "--dsw-alias-button-floating-fill": tint(THEME.surfaceHigh, 0.90),
    "--dsw-alias-button-floating-hover": tint(THEME.surfaceHigh, 0.96),
    "--dsw-alias-button-ghost-active-fill": tint(THEME.pink, 0.24),
    "--dsw-alias-button-ghost-active-hover": tint(THEME.pink, 0.32),
    "--dsw-alias-button-ghost-active-border": tint(THEME.pink, 0.48),
    "--dsw-alias-button-info-fill": tint(THEME.info, 0.26),
    "--dsw-alias-button-info-hover": tint(THEME.info, 0.34),
    "--dsw-alias-button-tool-bar-fill": tint(THEME.surface, 0.74),
    "--dsw-alias-button-tool-bar-fill-invisible": tint(THEME.surface, 0),
    "--dsw-alias-button-tool-bar-hover": hairline(0.10),

    /* ---- markdown & code ---- */
    "--dsw-alias-markdown-code-block": tint(THEME.inkDeep, 0.80),
    "--dsw-alias-markdown-code-block-banner": tint(THEME.surface, 0.88),
    "--dsw-alias-markdown-inline-code": tint(THEME.pink, 0.18),
    "--dsw-alias-markdown-citation": tint(THEME.pinkSoft, 0.20),
    "--dsw-alias-markdown-placeholder": tint(THEME.text, 0.42),
    "--dsw-alias-markdown-tag": tint(THEME.purple, 0.24),
    "--dsw-alias-markdown-code-segment-selected": tint(THEME.purple, 0.28),
    "--dsw-alias-markdown-code-segment-unselected": tint(THEME.text, 0.08),

    /* ---- diffs ---- */
    "--dsw-alias-code-diff-added": tint(THEME.success, 0.18),
    "--dsw-alias-code-diff-deleted": tint(THEME.danger, 0.18),
    "--dsw-alias-file-diff-added-bg": tint(THEME.success, 0.14),
    "--dsw-alias-file-diff-added-gutter": tint(THEME.success, 0.24),
    "--dsw-alias-file-diff-added-marker": THEME.success,
    "--dsw-alias-file-diff-deleted-bg": tint(THEME.danger, 0.14),
    "--dsw-alias-file-diff-deleted-gutter": tint(THEME.danger, 0.24),
    "--dsw-alias-file-diff-deleted-marker": THEME.danger,

    /* ---- scrollbars: neutral, so they recede ---- */
    "--dsw-alias-scrollbar-bg-l1": hairline(0.10),
    "--dsw-alias-scrollbar-bg-l2": hairline(0.14),
    "--dsw-alias-scrollbar-hover-l1": hairline(0.22),
    "--dsw-alias-scrollbar-hover-l2": hairline(0.28),

    /* ---- semantic states ---- */
    "--dsw-alias-state-error-primary": THEME.danger,
    "--dsw-alias-state-error-secondary": tint(THEME.danger, 0.26),
    "--dsw-alias-state-success-primary": THEME.success,
    "--dsw-alias-state-success-secondary": tint(THEME.success, 0.22),
    "--dsw-alias-state-success-tertiary": tint(THEME.success, 0.14),
    "--dsw-alias-state-warn-primary": THEME.warn,
    "--dsw-alias-state-warn-secondary": tint(THEME.warn, 0.22),
    "--dsw-alias-state-warn-tertiary": tint(THEME.warn, 0.14),
    "--dsw-alias-state-warn-label": "#3a2a10",
    "--dsw-alias-state-business-primary": THEME.info,
    "--dsw-alias-state-business-tertiary": tint(THEME.info, 0.16),
    "--dsw-alias-state-idle-primary": tint(THEME.text, 0.46),
    "--dsw-alias-switch-thumb": "#fffafd",
    "--dsw-alias-turn-trigger-bg": tint(THEME.pink, 0.18),
    "--dsw-alias-turn-trigger-bg-hover": tint(THEME.pink, 0.28),

    /* ---- onboarding ---- */
    "--dsw-alias-onboarding-accent": THEME.pink,
    "--dsw-alias-onboarding-card-fill": tint(THEME.surface, 0.84),
    "--dsw-alias-onboarding-secondary-fill": tint(THEME.surface, 0.72),
    "--dsw-alias-onboarding-checkbox-border": tint(THEME.purple, 0.32),

    /* ---- shape, blur, depth ---- */
    "--dsw-radius-xs": THEME.radius.xs,
    "--dsw-radius-sm": THEME.radius.sm,
    "--dsw-radius-md": THEME.radius.md,
    "--dsw-radius-lg": THEME.radius.lg,
    "--dsw-radius-xl": THEME.radius.xl,
    "--dsw-radius-panel": THEME.radius.panel,
    // `--dsw-corner-shape` is deliberately NOT overridden. The shipped sheet sets
    // it to `superellipse(1.5)` — Apple's continuous corner — and the previous
    // `round` here threw away the most recognisably Apple thing in the whole
    // stylesheet.
    "--dsw-mask-blur": THEME.blur.mask,
    "--dsw-menu-backdrop-filter": "blur(" + THEME.blur.menu + ") saturate(" + THEME.blur.saturate + ")",
    "--dsw-elevation-soft": THEME.shadow.soft,
    "--dsw-elevation-panel": THEME.shadow.panel,
    "--dsw-elevation-prominent": THEME.shadow.prominent,
    "--dsw-elevation-stroke": THEME.specular,
    "--dsw-elevation-stroke-color": THEME.specularColor,
    "--dsw-shadow-lv1": THEME.shadow.lv1,
    "--dsw-shadow-lv2": THEME.shadow.lv2,
    "--dsw-shadow-lv3": THEME.shadow.lv3,
    "--dsw-focus-ring-color": tint(THEME.pink, 0.72),
    "--dsw-focus-ring-width": "3px"
  };
  for (var key in next) {
    if (Object.prototype.hasOwnProperty.call(next, key)) TOKENS[key] = next[key];
  }
}

/** The `--dsw-*` overrides, derived from the current {@link THEME}. */
var TOKENS = {};
refreshTokensFromTheme();


/**
 * Asset manifests, substituted at build time. Each entry is
 * `{ id, name, label, kind, mime, url, source }`; music entries also carry
 * `cover`, wallpapers carry `default`.
 */
var WALLPAPERS = /*__CYRENE_WALLPAPERS__*/;
var COVERS = /*__CYRENE_COVERS__*/;
var MUSIC = /*__CYRENE_MUSIC__*/;
var BOOT_ANIMATIONS = /*__CYRENE_BOOT__*/;
var EMOTES = /*__CYRENE_EMOTES__*/;

/**
 * Her portrait for the collapsed dock dot, or null when `brand/` has none.
 * Served from the `brand` bucket so it is never offered as a wallpaper.
 */
var AVATAR = /*__CYRENE_AVATAR__*/;

/** Fallback artwork for the music disc, used when a track has no cover. */
var DISC_ART = /*__CYRENE_DISC__*/;

/**
 * The end-of-turn flourish: `{ art, last, ms }` or null when no artwork is
 * installed. `ms` is how long the animation itself runs; the overlay holds `last`
 * for the remainder of its total.
 */
var CELEBRATE = /*__CYRENE_CELEBRATE__*/;

/**
 * The pet's expressions: the official chat stickers, paired with the role a
 * human read off `docs/pet-assets.png`. Empty when `brand/pet/` has none.
 */
var PET = /*__CYRENE_PET__*/;

/** Particle tiers: id, label, count. */
var PARTICLE_TIERS = [
  { id: "off", label: "关", count: 0 },
  { id: "star", label: "星点", count: 12 },
  { id: "trail", label: "曳光", count: 28 },
  { id: "swarm", label: "流萤", count: 80 }
];

/**
 * What a click leaves behind. `both` fires the two together; the ring carries
 * the moment and the sparks give it direction.
 */
var CLICK_KINDS = [
  { id: "off", label: "关" },
  { id: "ripple", label: "涟漪" },
  { id: "spark", label: "星火" },
  { id: "both", label: "两者" }
];

/** What the pointer leaves behind as it moves. */
var TRAIL_KINDS = [
  { id: "off", label: "关" },
  { id: "comet", label: "彗尾" },
  { id: "stardust", label: "星尘" }
];

/**
 * Where the colour comes from. `rainbow` gives every instance its own hue and
 * lets that hue drift, so a burst is never one flat colour; it is the only mode
 * that cannot be a single token, which is why the effects bake colour per
 * instance instead of reading a custom property.
 */
var EFFECT_COLOR_MODES = [
  { id: "theme", label: "主题色" },
  { id: "rainbow", label: "彩虹" },
  { id: "custom", label: "自定义" }
];

/** How long the trail keeps drawing after the pointer stops. */
var TRAIL_FADE_MS = 520;

/** Effects sharing the ambient canvas: one layer, so they cannot dirty a second. */
var EFFECT_LIMITS = { clicks: 24, sparksPerClick: 14, trail: 90 };

/** Faces worth suggesting; every one is used verbatim, none is assumed present. */
var FONT_PRESET_KEYS = ["fontBodyFamily", "fontMonoFamily", "fontScale", "fontWeight"];

/**
 * The avatar's longest edge, in pixels, before it is stored.
 *
 * The dot renders at 42 px and on a 2× display that is 84 physical pixels, so
 * 160 leaves headroom without keeping a camera-sized original in the settings
 * document.
 */
var AVATAR_MAX_EDGE = 160;

/** How hard the stored avatar is compressed. */
var AVATAR_QUALITY = 0.86;

/**
 * The caret presets.
 *
 * `auto` means "leave the host alone" and is the default, because the composer
 * already carries a deliberate colour today: it uses
 * `--dsw-alias-state-business-primary`, which this theme rebinds to its own
 * accent. `accent` is therefore the same colour spelled out for the other input
 * positions, which is why it exists as a separate entry rather than being the
 * default — the two mean different things even when they resolve alike.
 */
var CARET_COLORS = [
  { id: "auto", label: "跟随宿主", value: "" },
  { id: "accent", label: "主题强调色", value: "" },
  { id: "pink", label: "粉色", value: "#f2a7d5" },
  { id: "violet", label: "紫色", value: "#b9a6f2" },
  { id: "cyan", label: "青色", value: "#8fe8ff" },
  { id: "amber", label: "琥珀", value: "#ffcf8f" },
  { id: "custom", label: "自定义", value: "" }
];

/**
 * The factory presets, shipped as a starting point rather than a default.
 *
 * The first entry is deliberately *empty*: a fresh install must not re-emit the
 * ladder, because re-emitting it with today's numbers freezes the sizes against
 * a future host update. `宿主默认` is the built-in "strip everything" entry and
 * its name is reserved — a user preset may not shadow it.
 */
var FONT_BUILTIN_PRESETS = [
  {
    id: "host",
    name: "宿主默认",
    values: { fontBodyFamily: "", fontMonoFamily: "", fontScale: 1, fontWeight: 0 }
  },
  {
    id: "soft",
    name: "柔和圆体",
    values: { fontBodyFamily: '"Yuanti SC", "Quicksand", "Nunito", sans-serif', fontMonoFamily: "", fontScale: 1.05, fontWeight: 0 }
  },
  {
    id: "compact",
    name: "紧凑等宽",
    values: { fontBodyFamily: "", fontMonoFamily: '"JetBrains Mono", "Cascadia Code", Consolas, monospace', fontScale: 0.95, fontWeight: 0 }
  }
];

/** Music loop modes, in cycle order. */
var LOOP_MODES = [
  { id: "list", label: "列表循环", icon: "\u21BB" },
  { id: "single", label: "单曲循环", icon: "\u21BA" },
  { id: "shuffle", label: "随机播放", icon: "\u21C4" }
];

/** How long the dock stays open with no interaction before it folds away. */
var DOCK_IDLE_MS = 4200;

/**
 * How far a press on a dock button has to travel before it counts as a reorder.
 *
 * A press that opens a panel and a press that starts a drag begin with the same
 * pointerdown, so the two have to be told apart by distance. Four pixels is under
 * any deliberate movement and over the jitter of a hand resting on a mouse, which
 * is what keeps "click the button" working for someone who is not perfectly
 * still. Every value from about 3 to 8 would work; 4 is the point where a pointer
 * that wobbled still opens the panel it was aiming at.
 */
var DOCK_DRAG_THRESHOLD = 4;

/** Default settings; every read is merged over this, so a partial document is fine. */
var DEFAULT_SETTINGS = {
  // ⚠️ 2026-10-11 从 `null` 改成显式的内置壁纸 —— **他点名要的**：
  //    「壁纸也是用我目前的」。
  //
  //    原文是 `null`，意思是「没有选中任何一张」；客户端那边
  //    `if (settings.wallpaper === null) return null;` 会直接返回空。
  //
  // ## 这张壁纸随包发
  //
  //    `assets/Default_cyrene-bg.webm` 是 16.5 MB 的游戏视频，手工提取的。
  //    **它随分享副本一起发**（见 NOTICE.md 第一节之二），所以收件人首次安装
  //    就能看到它 —— 文件名里的 `Default` 就是靠这一点生效的。
  //
  //    而它不适用本项目的 MIT：版权属于米哈游 / HoYoverse，只做个人使用。
  //    收件人不想要的话，换成自己的壁纸就行（丢进 `assets/`，或界面里直接导入）。
  //
  //    好在**降级是干净的**：`WALLPAPERS` 由 `build.mjs` 从 `assets/` 现生成，
  //    收件人的 `assets/` 是空的，于是 `findEntry('wallpapers', …)` 返回 `null`，
  //    表现和改动前的 `null` 一样 —— **没有壁纸，但不报错**。
  //
  //    所以这一行的实际效果是：**在他自己这台机器上锁定了那张动态壁纸**；
  //    收件人那边等价于原来的行为。要给他同一张，得另想办法（不能走这个仓库）。
  wallpaper: "builtin:assets/Default_cyrene-bg.webm",
  // A fresh install opens on the dynamic wallpaper, which is what the theme
  // was built around. Switching to 静态 in the 景 panel costs one click and
  // saves the continuous decode, so the choice stays with the user.
  wallpaperType: "video",
  randomOn: false,
  randomPool: [],
  randomMinutes: 5,
  shade: THEME.shade,
  wallBrightness: THEME.wallBrightness,
  // The rest of the wallpaper tuning. Defaults come from THEME rather than being
  // written twice, so the stylesheet's own fallback and the initial setting can
  // never disagree about what "unmodified" means.
  wallSaturate: THEME.wallSaturate,
  wallContrast: 1,
  wallOpacity: 1,
  wallFog: 0,
  // Zoom only ever grows. The point of it is to hide the soft edge that blur
  // pulls inside the viewport, and cropping *in* is the only direction that does.
  wallScale: 1,
  // The Liquid Glass layer: grain, specular rims, a stronger saturated blur.
  // It is decorative on top of the material system, so it is a switch rather
  // than a set of numbers.
  glass: true,
  particles: "trail",
  // Pointer effects. Both default off: they are additive decoration, and the
  // ambient field already carries the theme when nobody has asked for more.
  clickEffect: "off",
  clickColor: "theme",
  clickColorCustom: "#ff8fd0",
  clickOpacity: 0.85,
  clickBlend: "screen",
  trailEffect: "off",
  trailColor: "theme",
  trailColorCustom: "#8fe8ff",
  trailOpacity: 0.7,
  trailBlend: "screen",
  // Typography. Every field defaults to "leave the host alone": an empty face
  // means "keep whatever the host chose", scale 1 and weight 0 mean "do not
  // re-emit the ladder". Re-emitting it with today's numbers would freeze the
  // sizes against a future host update, which is the opposite of the goal.
  fontBodyFamily: "",
  fontMonoFamily: "",
  fontScale: 1,
  fontWeight: 0,
  // Named font sets. The four keys above are always the live values; a preset is
  // a saved copy of them, so applying one is a plain overwrite and the whole
  // library travels inside the settings document (which the host already
  // persists), leaving nothing to keep in sync separately.
  fontSets: [],
  fontActiveSet: "host",
  // The caret. Two positions rather than one: the composer already has the
  // host's deliberate colour, while every other text field (the sidebar search
  // box included) computes `caret-color` to the text colour. A single global
  // value would either override the deliberate one or leave the plain ones
  // untouched, so they are separate settings that share a default.
  caretColor: "auto",
  caretColorCustom: "#f2a7d5",
  caretComposerColor: "auto",
  caretComposerCustom: "#f2a7d5",
  // Glass tuning. Defaults are the shipped recipe, so an untouched install
  // derives exactly the same tokens it did before these knobs existed.
  glassHue: THEME.hue,
  glassTint: THEME.tint,
  glassAlpha: 1,
  // The tuning layer's own copy of the blur, and it wins over `THEME.blur.menu`
  // on the dock and the popovers. Left at the previous palette's 40 while the
  // material went to 14, a fresh install would have shipped a 3x blur that only
  // appeared once someone opened the panel. Derived from the theme so the two
  // cannot disagree again.
  glassBlur: parseInt(THEME.blur.menu, 10) || 14,
  // The avatar. `builtin` is the portrait the build found in `brand/`; `custom`
  // is whatever the user picked, stored as a data URL rather than a route URL.
  //
  // Storing the bytes rather than a path is deliberate: the host's upload route
  // has no avatar bucket, and adding one would change the host half of the plugin
  // for a 40-pixel circle. A data URL also travels with the settings document, so
  // an exported theme carries its own face instead of a link into someone else's
  // asset folder. The cost is that the document grows, which is why the image is
  // downscaled before it is stored.
  // ⚠️ 2026-10-11：作者要求把他的头像做成**出厂默认**，原话是
  //    「贴纸也要一起发，能让别人装上就能用」。
  //
  // **来源（他本人口述）：那张图是他自己截的。**
  //    这句话写在这里，是为了以后有人问「这张图哪来的」时有答案，
  //    而不是只能去翻聊天记录。
  //
  // **它和本项目那条线的关系**：素材现在随包发（见 `NOTICE.md` 第一节之二），
  //    所以这一项不再是例外 —— 它属于同一类，同样的说明也在那儿。
  //    版权仍属米哈游 / HoYoverse，收到副本的人只做个人使用。
  //
  // **要撤掉**：把下面两行改回 `avatarSource: "builtin"` 和 `avatarCustom: ""`。
  //    那样会退回 `brand/cyrene-avatar.webp` 那张（也随包发）。
  //
  // 5619 字节。工具：`node tools/derive-theme-defaults.mjs --write
  //    --include-avatar --avatar-origin "<来源>"`（它也会把别的差异一起写，
  //    所以那次之后手工把不需要的撤回过）。
  avatarSource: "custom",
  avatarCustom: "data:image/webp;base64,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",
  // Whether each of her replies in the conversation is led by a portrait.
  // Whether each of her replies in the conversation is led by a portrait.
  // Separate from `avatarSource`: the dock's collapsed dot is always her, and
  // someone who wants the bar plain should not lose the face on the dot, nor the
  // other way round.
  replyAvatar: true,
  // Which preset palette the whole theme is derived from. Part of the saved
  // format: the id is written to disk, so renaming one would need a migration.
  skin: "host",
  sound: false,
  musicOn: false,
  trackId: null,
  loop: "list",
  volume: 0.6,
  // Renamed from panelPos/panelCollapsed so a stale saved corner from an
  // earlier build does not override the new bottom-left default.
  dockPos: null,
  dockCollapsed: false,
  // Slots inside the bar. `dockFixed` are the ones that hold their place; the
  // rest reorder among themselves in the order listed in `dockOrder`. Distinct
  // from `dockPos`, which is where the whole bar sits on screen — that one is
  // "moving the bar", these are "arranging the bar", and conflating them is how
  // a UI ends up with two features under one name.
  //
  // `music` (the identity panel) and `wallpaper` (which now holds the toolbar
  // controls) lead, because both are how you reach everything else.
  dockFixed: ["music", "wallpaper"],
  dockOrder: ["sound", "fonts", "particles", "pointer"],
  hidden: { wallpapers: [], music: [] },
  bootSeen: false,
  // `reveal` floats the opening asset on a flat scrim and then lifts it to show
  // the window; `cinema` fills the screen with the asset; `card` boxes it for a
  // small upload. The bundled clip is transparent, so reveal is the default.
  bootStyle: "reveal",
  // The pet: her official stickers standing in the corner. On by default,
  // because a pet nobody notices is not worth shipping.
  petOn: true,
  petPos: null
};
