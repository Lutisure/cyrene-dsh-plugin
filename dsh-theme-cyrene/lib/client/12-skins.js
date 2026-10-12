/**
 * Skin presets — the eight Mirage sets.
 *
 * ## Why skins are inputs, not colour lists
 *
 * The theme is derived, not written out. `THEME.ink`, `.surface`, `.mask` and so
 * on are blends of a neutral ladder with `THEME.hue` at `THEME.tint`, and the
 * 136 `--dsw-alias-*` tokens are `tint()`s of *those*. Skin data therefore holds
 * the same handful of inputs the original recipe starts from — the ladder, the
 * hue, how much of it to mix, and the accents — and applying one re-runs that
 * derivation. Pasting a list of final token values would mean 136 numbers per
 * skin and would silently fall out of step the moment a token was added.
 *
 * ## Why `applySkin` mutates in place
 *
 * Everything downstream reads the `THEME` and `PALETTE` objects directly, in
 * about ninety places spread across ten files. Rebuilding them as new objects
 * would leave every one of those references pointing at the old skin. So the
 * objects keep their identity and their properties are overwritten — which is
 * also why `skinsCSS` has to exist: whitespace can be re-emitted from the same
 * source, but a value that was already baked into a stylesheet string cannot.
 *
 * ## What a skin deliberately does not touch
 *
 * `neutral` stays the same across all eight. It is the near-black the chrome
 * sits on, and letting it drift would move the interface's *weight* rather than
 * its temperature. The wallpaper, emotes, disc art and pet frames are files, not
 * colours, and are untouched by any of this.
 */

/**
 * The eight presets.
 *
 * `id` is stored in the settings document, so it is part of the saved format and
 * must not be renamed without a migration. `host` is the theme as it shipped.
 */
var SKINS = [
  {
    id: "host",
    name: "薄暮 · 昔涟",
    note: "她的颜色本身，六个深浅",
    hue: "#6d3d8f",
    tint: 0.10,
    pink: "#ffc9e6",
    pinkStrong: "#d946ef",
    pinkSoft: "#ffe9f6",
    purple: "#c9a4ff",
    info: "#b3c3ff"
  },
  {
    id: "mirage",
    name: "蜃景",
    note: "青碧与湖光",
    hue: "#1f4f52",
    tint: 0.28,
    pink: "#a8e6d8",
    pinkStrong: "#2dd4bf",
    pinkSoft: "#d8fff5",
    purple: "#8ed0f0",
    info: "#9fd8ff"
  },
  {
    id: "ember",
    name: "余烬",
    note: "炭火与暖金",
    hue: "#54310f",
    tint: 0.30,
    pink: "#ffcf9e",
    pinkStrong: "#f59e42",
    pinkSoft: "#ffe7cc",
    purple: "#ffb37a",
    info: "#ffd9a0"
  },
  {
    id: "jade",
    name: "青玉",
    note: "苔色与竹影",
    hue: "#254a2f",
    tint: 0.27,
    pink: "#b8e6b0",
    pinkStrong: "#4ade80",
    pinkSoft: "#dcffd8",
    purple: "#a8d8bc",
    info: "#a8e6c0"
  },
  {
    id: "astral",
    name: "星穹",
    note: "深靛与银蓝",
    hue: "#2b2560",
    tint: 0.32,
    pink: "#c4c9ff",
    pinkStrong: "#818cf8",
    pinkSoft: "#e6e8ff",
    purple: "#b0a8ff",
    info: "#a8c0ff"
  },
  {
    id: "coral",
    name: "珊瑚",
    note: "霞粉与海面",
    hue: "#5c2740",
    tint: 0.26,
    pink: "#ffc0cb",
    pinkStrong: "#fb7185",
    pinkSoft: "#ffe4e9",
    purple: "#ffa8c0",
    info: "#ffc0cb"
  },
  {
    id: "ash",
    name: "灰烬",
    note: "近乎无彩",
    hue: "#3a3a40",
    tint: 0.12,
    pink: "#e2ded8",
    pinkStrong: "#b8b0a4",
    pinkSoft: "#f2efe9",
    purple: "#cfc9c0",
    info: "#c8c4bc"
  },
  {
    id: "glacier",
    name: "冰河",
    note: "冷白与霜蓝",
    hue: "#2a4a68",
    tint: 0.24,
    pink: "#bee6ff",
    pinkStrong: "#38bdf8",
    pinkSoft: "#e0f5ff",
    purple: "#a8d4ff",
    info: "#8ed0ff"
  }
];

/**
 * The neutral ladder, shared by every skin — see the note at the top.
 *
 * Kept in step with `THEME.neutral` in `10-constants.js`: that is the value at
 * load, this is the value after the first skin is applied, and if the two
 * disagree the theme changes appearance the first time a skin is touched.
 */
var SKIN_NEUTRAL = {
  deep: "#100c15",
  base: "#1a1220",
  layer1: "#23182c",
  layer2: "#2d1f38",
  layer3: "#392845",
  high: "#463153"
};

/** The accents a skin does not set, so they can be restored on the way back. */
var SKIN_ACCENTS_DEFAULT = {
  success: "#8ee6bd",
  warn: "#ffd9a0",
  danger: "#ff9fb6",
  text: "#f4eef9"
};

/**
 * Look a skin up by id.
 *
 * @param {string} id - the stored id.
 * @returns {object} the skin; the shipped one when the id is unknown, because a
 *   settings file from a future version must not leave the theme half-defined.
 */
function skinById(id) {
  for (var index = 0; index < SKINS.length; index += 1) {
    if (SKINS[index].id === id) return SKINS[index];
  }
  return SKINS[0];
}

/**
 * Overwrite the live theme with a skin's inputs and re-derive everything after.
 *
 * The order matters: the accents first, then the two numbers the chrome blends
 * from, then the chrome itself. `PALETTE` and `TOKENS` are refreshed last
 * because they read the values produced by the steps above.
 *
 * @param {string} id - the skin id.
 * @returns {object} the applied skin.
 */
function applySkin(id) {
  var skin = skinById(id);

  THEME.hue = skin.hue;
  THEME.tint = skin.tint;
  THEME.pink = skin.pink;
  THEME.pinkStrong = skin.pinkStrong;
  THEME.pinkSoft = skin.pinkSoft;
  THEME.purple = skin.purple;
  THEME.info = skin.info;
  // Not per-skin today, but restored explicitly so a future skin that does set
  // them cannot leak them into the next one.
  THEME.success = SKIN_ACCENTS_DEFAULT.success;
  THEME.warn = SKIN_ACCENTS_DEFAULT.warn;
  THEME.danger = SKIN_ACCENTS_DEFAULT.danger;
  THEME.text = SKIN_ACCENTS_DEFAULT.text;

  THEME.neutral = SKIN_NEUTRAL;
  THEME.inkDeep = mix(THEME.neutral.deep, THEME.hue, THEME.tint);
  THEME.ink = mix(THEME.neutral.base, THEME.hue, THEME.tint);
  THEME.surface = mix(THEME.neutral.layer2, THEME.hue, THEME.tint);
  THEME.surfaceHigh = mix(THEME.neutral.layer3, THEME.hue, THEME.tint);
  THEME.mask = mix("#070509", THEME.hue, THEME.tint * 0.6);

  refreshPalette();
  refreshTokens();
  return skin;
}

/** Re-read `PALETTE` from the current theme. */
function refreshPalette() {
  PALETTE.ink = THEME.ink;
  PALETTE.inkDeep = THEME.inkDeep;
  PALETTE.pink = THEME.pink;
  PALETTE.pinkStrong = THEME.pinkStrong;
  PALETTE.pinkSoft = THEME.pinkSoft;
  PALETTE.purple = THEME.purple;
  PALETTE.text = THEME.text;
  PALETTE.success = THEME.success;
  PALETTE.warn = THEME.warn;
  PALETTE.danger = THEME.danger;
  PALETTE.info = THEME.info;
}

/**
 * Re-read `TOKENS` from the current theme.
 *
 * Defers to `refreshTokensFromTheme` when `10-constants.js` has provided one; the
 * fallback keeps this file a no-op on a build where the token table is still a
 * plain constant, so the two files can be edited in either order.
 */
function refreshTokens() {
  if (typeof refreshTokensFromTheme === "function") refreshTokensFromTheme();
}

/**
 * The skin layer: re-emit the sheets a skin change reaches.
 *
 * @param {object} hooks - `{ refresh: () => void }`, called after the theme is
 *   re-derived so the stylesheets can be rebuilt from the new values.
 * @returns {{apply: (settings: object) => void, dispose: () => void}} the layer.
 */
function createSkinLayer(hooks) {
  var refresh = hooks && typeof hooks.refresh === "function" ? hooks.refresh : function () {};
  var current = null;

  return {
    /**
     * Switch to whatever skin a settings document asks for.
     * @param {object} next - the settings document.
     */
    apply: function (next) {
      var wanted = skinById(next !== null && next !== undefined && next.skin !== undefined ? next.skin : "host");
      if (wanted.id === current) return;
      current = wanted.id;
      applySkin(wanted.id);
      // Only now: the sheets read the values produced above.
      refresh();
    }
  };
}
