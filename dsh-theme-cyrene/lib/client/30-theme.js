/**
 * The identity layer: design tokens, the transparency that lets a wallpaper
 * through, and the fixed background stack.
 *
 * Every token and transparency rule is scoped to
 * `html[data-cyrene-theme="on"]`. That attribute is the single switch for the
 * whole visual identity: when the user picks another theme, `theme/change`
 * clears it and this plugin's `!important` token block stops applying, so a
 * later-loaded theme can win. The reference plugin writes its tokens
 * unconditionally and has to fight for precedence forever.
 */

/** Render {@link TOKENS} as CSS declarations. */
function tokenDeclarations() {
  var lines = [];
  for (var name in TOKENS) {
    if (!Object.prototype.hasOwnProperty.call(TOKENS, name)) continue;
    lines.push("  " + name + ": " + TOKENS[name] + " !important;");
  }
  return lines.join("\n");
}

/** The scope selector that gates the whole identity. */
var IDENTITY_SCOPE = 'html[data-cyrene-theme="on"]';

/**
 * The readability gradient over the wallpaper.
 *
 * The left side stays a little deeper so text sitting directly on the image
 * (the sidebar) has something to rest on; the right is almost clear. The whole
 * thing is far lighter than a typical wallpaper theme, because readability now
 * comes from the near-opaque surfaces instead of from darkening the image.
 *
 * @param {number} value - 0..0.9, the user's "shade" setting.
 * @returns {string} a CSS `linear-gradient(...)` value.
 */
function shadeGradient(value) {
  var top = clamp(Number(value) || 0, 0, 0.9);
  var left = 0.10 + top * 0.62;
  var mid = 0.03 + top * 0.34;
  var right = top * 0.12;
  return "linear-gradient(100deg, " + tint(THEME.mask, left.toFixed(3)) +
    " 0%, " + tint(THEME.mask, mid.toFixed(3)) +
    " 46%, " + tint(THEME.mask, right.toFixed(3)) + " 100%)";
}

/** The gradient the stylesheet ships with, before any saved setting applies. */
var SHADE_DEFAULT = shadeGradient(THEME.shade);

/** The scope for the Liquid Glass layer; the 景 panel switches it off. */
var GLASS_SCOPE = 'html[data-cyrene-theme="on"][data-cyrene-glass="on"]';

/**
 * The noise tile.
 *
 * A big blurred gradient bands visibly on an 8-bit display, and banding is what
 * gives blurred glass away. A few percent of fractal noise dithers the steps
 * away. This is the one piece of "grain" that is functional rather than
 * decorative.
 */
var GRAIN_URI = "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' " +
  "width='160' height='160'%3E%3Cfilter id='g'%3E%3CfeTurbulence type='fractalNoise' " +
  "baseFrequency='0.9' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E" +
  "%3Crect width='160' height='160' filter='url(%23g)'/%3E%3C/svg%3E\")";

/**
 * The Liquid Glass layer.
 *
 * Be clear about what this is and is not. Apple's version *refracts*: it bends
 * what is behind it near the edges, in real time, with a shader.
 * `backdrop-filter` samples the backdrop but cannot displace it, so CSS cannot
 * reproduce that. What it can do, and what carries most of the impression:
 *
 *  - **a specular rim** — a gradient border that is bright where a light would
 *    catch the edge (top-left) and dark opposite. This is the single most
 *    load-bearing trick: an edge reads as glass because of how it catches
 *    light, not because it is transparent;
 *  - **grain** — see {@link GRAIN_URI};
 *  - **a stronger, more saturated backdrop blur**, so the glass visibly picks
 *    colour up from what is behind it.
 *
 * Only the plugin's own surfaces get the rim. The host's dialogs and menus are
 * styled through `--dsw-*` tokens, and a pseudo-element cannot be injected into
 * markup this plugin does not own.
 *
 * @returns {string} the stylesheet text.
 */
function glassCSS() {
  var rim = [
    "  content: \"\";",
    "  position: absolute;",
    "  inset: 0;",
    "  border-radius: inherit;",
    "  padding: 1px;",
    "  pointer-events: none;",
    // Bright top-left, near-transparent through the middle, a faint bounce at
    // the bottom-right. The asymmetry is what reads as a light source.
    "  background: linear-gradient(145deg,",
    "    rgba(255,255,255,0.40) 0%,",
    "    rgba(255,255,255,0.10) 24%,",
    "    rgba(255,255,255,0.02) 52%,",
    "    rgba(255,255,255,0.05) 78%,",
    "    rgba(255,255,255,0.20) 100%);",
    // Show only the border band: the content-box mask minus the full mask.
    "  -webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);",
    "  -webkit-mask-composite: xor;",
    "  mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);",
    "  mask-composite: exclude;"
  ].join("\n");

  // The floating control layer only. `.cy-card` is content and is deliberately
  // absent — a translucent material on the thing the reader is reading blurs the
  // text rather than the background.
  var surfaces = [".cy-dock", ".cy-pop", ".cy-dot"];
  var lines = ["/* cyrene: liquid glass */"];

  // The grain sits above everything: it has to dither every blurred layer, not
  // just the ones below it. Pointer-transparent, and only ~3 %.
  lines.push(GLASS_SCOPE + "::before {");
  lines.push("  content: \"\";");
  lines.push("  position: fixed;");
  lines.push("  inset: 0;");
  lines.push("  z-index: 2147483600;");
  lines.push("  pointer-events: none;");
  lines.push("  background-image: " + GRAIN_URI + ";");
  lines.push("  background-size: 160px 160px;");
  lines.push("  opacity: 0.03;");
  lines.push("  mix-blend-mode: overlay;");
  lines.push("}");

  lines.push(GLASS_SCOPE + " .cy-dock, " + GLASS_SCOPE + " .cy-pop {");
  lines.push("  backdrop-filter: blur(" + THEME.blur.menu + ") saturate(" + THEME.blur.saturate + ");");
  lines.push("  -webkit-backdrop-filter: blur(" + THEME.blur.menu + ") saturate(" + THEME.blur.saturate + ");");
  lines.push("}");

  // The host's own sidebar, which the token layer only *colours*. Without this it
  // gets the theme's translucent fill and none of the material — so the left edge
  // reads as a flat panel while everything the plugin draws itself reads as glass.
  //
  // `[data-slot="sidebar"]` is the hook the host's slot system provides, and it is
  // the stable one: the sidebar's own class names carry build hashes. The blur is
  // deliberately the softer `mask` value rather than `menu` — the sidebar is a
  // large surface, and the menu-grade blur across a full-height column costs a
  // lot of fill for very little visual difference.
  lines.push(GLASS_SCOPE + " [data-slot=\"sidebar\"] {");
  lines.push("  backdrop-filter: blur(" + THEME.blur.mask + ") saturate(" + THEME.blur.saturate + ");");
  lines.push("  -webkit-backdrop-filter: blur(" + THEME.blur.mask + ") saturate(" + THEME.blur.saturate + ");");
  lines.push("}");
  // The sidebar and the header sit over the wallpaper rather than over content,
  // so for them the blur is a tint rather than a lens — measured: the dock reads
  // identically at blur 0 and blur 40 because there is no detail behind it to
  // lose. They still have to give way to a reader who has asked the system to
  // stop showing translucent surfaces.
  lines.push("@media (prefers-reduced-transparency: reduce) {");
  lines.push("  " + GLASS_SCOPE + " [data-slot=\"sidebar\"] {");
  lines.push("    backdrop-filter: none;");
  lines.push("    -webkit-backdrop-filter: none;");
  lines.push("    background: " + tint(THEME.surfaceHigh, 0.94) + " !important;");
  lines.push("  }");
  lines.push("}");

  for (var index = 0; index < surfaces.length; index += 1) {
    lines.push(GLASS_SCOPE + " " + surfaces[index] + "::after {");
    lines.push(rim);
    lines.push("}");
  }

  return lines.join("\n");
}

/** Stylesheet text for the identity layer. */
function identityCSS() {
  return [
    "/* cyrene: identity */",
    IDENTITY_SCOPE + " { color-scheme: dark !important; background: " + PALETTE.inkDeep + " !important; }",
    IDENTITY_SCOPE + " body {",
    "  background-color: transparent !important;",
    "  color: " + PALETTE.text + " !important;",
    tokenDeclarations(),
    "}",
    IDENTITY_SCOPE + " ::selection { background: " + tint(THEME.pink, 0.36) + "; color: " + THEME.inkDeep + "; }",
    "",
    "/* The background stack. One fixed container at a negative z-index; its",
    "   children stack by DOM order, which avoids depending on nested z-index",
    "   inside a stacking context. */",
    ".cy-layer-root { position: fixed; inset: 0; z-index: -2; pointer-events: none; display: none; }",
    IDENTITY_SCOPE + " .cy-layer-root { display: block; }",
    ".cy-layer-root > * { position: absolute; inset: 0; }",
    "/* The wallpaper is lifted with a filter rather than a lighter overlay: a",
    "   translucent white wash would grey the shadows out, a filter keeps the",
    "   image's own contrast. The values travel as custom properties, written on",
    "   the root element by `setWallTuning`: the filter has to land on all three",
    "   layers, and a variable lets this rule decide that rather than three inline",
    "   styles — which would also fight this declaration for the video element. */",
    ".cy-wall {",
    "  background-position: center;",
    "  background-size: cover;",
    "  background-repeat: no-repeat;",
    "  filter: var(--cy-wall-filter, brightness(" + THEME.wallBrightness + ") saturate(" + THEME.wallSaturate + ") contrast(1));",
    "  transform: scale(var(--cy-wall-scale, 1));",
    "  opacity: 0;",
    "  transition: opacity 620ms ease;",
    "}",
    ".cy-wall[data-active=\"true\"] { opacity: var(--cy-wall-opacity, 1); }",
    ".cy-wall-video { opacity: 0; transition: opacity 620ms ease; overflow: hidden; }",
    ".cy-wall-video[data-active=\"true\"] { opacity: var(--cy-wall-opacity, 1); }",
    ".cy-wall-video video {",
    "  width: 100%; height: 100%; object-fit: cover; display: block;",
    "  filter: var(--cy-wall-filter, brightness(" + THEME.wallBrightness + ") saturate(" + THEME.wallSaturate + ") contrast(1))",
    "          blur(var(--cy-wall-blur, 0px));",
    "  transform: scale(var(--cy-wall-scale, 1));",
    "}",
    "/* Kept light on purpose: readability now comes from the near-opaque",
    "   surfaces, so this only needs to seat the wallpaper behind the text. */",
    ".cy-shade { background: " + SHADE_DEFAULT + "; }",
    ".cy-particles { opacity: 0; transition: opacity 900ms ease; }",
    ".cy-particles[data-active=\"true\"] { opacity: 1; }",
    "/* The pointer layer never fades in: a burst is instantaneous, and a 900ms",
    "   opacity ramp would swallow the first frames of every click. */",
    ".cy-pointer { pointer-events: none; }",
    "",
    "/* A faint pink-purple bloom in the corner, under the surfaces. */",
    IDENTITY_SCOPE + " body::before {",
    "  content: \"\";",
    "  position: fixed;",
    "  inset: 0;",
    "  z-index: -1;",
    "  background: radial-gradient(120% 90% at 78% 8%, " + tint(THEME.purple, 0.16) + ", transparent 58%);",
    "  pointer-events: none;",
    "}",
    "",
    "@media (prefers-reduced-motion: reduce) {",
    "  .cy-wall, .cy-wall-video, .cy-particles { transition: none !important; }",
    "}"
  ].join("\n");
}

/**
 * Build the fixed background stack and return handles for it.
 *
 * @returns {{root: HTMLElement, canvas: HTMLCanvasElement, pointer: HTMLCanvasElement,
 *   video: HTMLVideoElement,
 *   setWallpaper: (entry: object|null) => void,
 *   setShade: (value: number) => void,
 *   setVideo: (entry: object|null) => void,
 *   dispose: () => void}} the layer API.
 */
function createLayerRoot() {
  var wallA = el("div", { class: "cy-wall", dataset: { slot: "a" } });
  var wallB = el("div", { class: "cy-wall", dataset: { slot: "b" } });
  var video = el("video", { muted: true, loop: true, playsinline: true, preload: "metadata" });
  var videoWrap = el("div", { class: "cy-wall-video" }, [video]);
  var shade = el("div", { class: "cy-shade" });
  var canvas = el("canvas", { class: "cy-particles" });
  // Appended after the ambient field so pointer effects read on top of it; the
  // root already swallows pointer events, so this inherits that and cannot
  // intercept a click meant for the UI.
  var pointer = el("canvas", { class: "cy-pointer" });
  var root = el("div", { class: "cy-layer-root", dataset: { plugin: PLUGIN_ID } }, [
    wallA, wallB, videoWrap, shade, canvas, pointer
  ]);

  var front = wallA;
  var back = wallB;
  var lastUrl = null;

  /** Crossfade to a new still image by swapping which slot is visible. */
  var setWallpaper = function (entry) {
    if (entry === null || entry === undefined) {
      front.dataset.active = "false";
      back.dataset.active = "false";
      lastUrl = null;
      return;
    }
    var url = entry.url;
    if (url === lastUrl) {
      front.dataset.active = "true";
      return;
    }
    lastUrl = url;
    var incoming = back;
    var outgoing = front;
    incoming.style.backgroundImage = 'url("' + url.replace(/"/g, "%22") + '")';
    // Force a style flush so the browser applies the image before fading in.
    void incoming.offsetWidth;
    incoming.dataset.active = "true";
    outgoing.dataset.active = "false";
    front = incoming;
    back = outgoing;
  };

  var setVideo = function (entry) {
    if (entry === null || entry === undefined) {
      videoWrap.dataset.active = "false";
      try {
        video.pause();
        video.removeAttribute("src");
        video.load();
      } catch (error) {
        /* element already torn down */
      }
      return;
    }
    if (video.getAttribute("src") !== entry.url) {
      video.setAttribute("src", entry.url);
      try {
        video.load();
      } catch (error) {
        /* ignore */
      }
    }
    videoWrap.dataset.active = "true";
    var playing = video.play();
    if (playing && typeof playing.catch === "function") {
      // Autoplay can be refused until the first gesture; the poster behind the
      // video still shows, so this is not worth surfacing.
      playing.catch(function () {});
    }
  };

  /**
   * Apply the readability gradient.
   * @param {number} value - 0..0.9, the user's shade setting.
   */
  var setShade = function (value) {
    shade.style.background = shadeGradient(value);
  };

  /**
   * Apply every wallpaper-tuning knob at once.
   *
   * One setter rather than six, because the knobs interact: blur widens the
   * image beyond the viewport, so a zoom has to compensate; opacity and border
   * are the same declaration on the same two elements; and splitting them would
   * mean six call sites in the settings subscriber that each have to remember
   * the full list.
   *
   * Values travel as CSS custom properties set on the root element, not as
   * inline styles on each of the three layers: the filter is one declaration
   * that has to land on all three, and a variable means the *rule* decides
   * which elements read it. Inline styles would also fight the stylesheet's own
   * `filter` for the video element.
   *
   * @param {object} tuning - `{brightness, saturate, contrast, opacity, blurFog, scale}`.
   */
  var setWallTuning = function (tuning) {
    var next = isPlainObject(tuning) ? tuning : {};
    var brightness = clamp(Number(next.brightness) || THEME.wallBrightness, 0.4, 2.2);
    var saturate = clamp(Number(next.saturate) || THEME.wallSaturate, 0.2, 2.4);
    var contrast = clamp(Number(next.contrast) || 1, 0.4, 2.2);
    var opacity = clamp(Number(next.opacity) === 0 ? 0 : (Number(next.opacity) || 1), 0, 1);
    var blur = clamp(Number(next.blurFog) || 0, 0, 40);
    var scale = clamp(Number(next.scale) || 1, 1, 1.4);

    var root = document.documentElement;
    root.style.setProperty("--cy-wall-filter",
      "brightness(" + brightness.toFixed(2) + ") saturate(" + saturate.toFixed(2) + ") contrast(" + contrast.toFixed(2) + ")");
    root.style.setProperty("--cy-wall-opacity", opacity.toFixed(3));
    // `blur` is what the requirement calls 雾化; `scale` keeps the blurred image
    // from showing soft edges inside the viewport.
    root.style.setProperty("--cy-wall-blur", blur.toFixed(1) + "px");
    root.style.setProperty("--cy-wall-scale", scale.toFixed(3));
  };

  /**
   * Switch the Liquid Glass layer on or off.
   *
   * Only an attribute changes; both stylesheets are always mounted and the glass
   * rules are gated on the attribute, so this is a repaint rather than a
   * re-mount and cannot leave the DOM half-torn-down.
   *
   * @param {boolean} value - true to enable.
   */
  var setGlass = function (value) {
    if (value === false) delete document.documentElement.dataset.cyreneGlass;
    else document.documentElement.dataset.cyreneGlass = "on";
  };

  var dispose = function () {
    try {
      video.pause();
      video.removeAttribute("src");
      video.load();
    } catch (error) {
      /* ignore */
    }
    if (root.parentNode) root.parentNode.removeChild(root);
  };

  return {
    root: root,
    canvas: canvas,
    pointer: pointer,
    video: video,
    setWallpaper: setWallpaper,
    setVideo: setVideo,
    setShade: setShade,
    setWallTuning: setWallTuning,
    setGlass: setGlass,
    dispose: dispose
  };
}

/**
 * Register the theme, mount the identity stylesheet, and install the
 * background stack.
 *
 * @param {object} ctx - the Cordis context carrying `theme`.
 * @param {HTMLElement} mountPoint - the node the background stack is appended to.
 * @param {{onSwitch?: (active: boolean) => void}} [hooks] - notified when the
 *   active theme changes to or away from this plugin's theme.
 * @returns {{layers: object, dispose: () => void, isActive: () => boolean}} the identity handle.
 */
function applyIdentity(ctx, mountPoint, hooks) {
  var disposers = [];

  /**
   * One remountable stylesheet.
   *
   * Both sheets bake the current theme's values into their text at build time, so
   * a skin switch has to rebuild them — there is no way to re-colour a string.
   * Keeping each behind a controller means `refresh` is one call rather than a
   * list of pairs that would drift apart as sheets are added.
   *
   * @param {Function} build - returns the CSS text.
   * @param {string} name - the sheet's name, as `mountStyle` records it.
   * @returns {{refresh: Function, dispose: Function}} the controller.
   */
  var remountable = function (build, name) {
    var unmount = null;
    var mount = function () {
      if (unmount !== null) unmount();
      unmount = mountStyle(build(), name);
    };
    mount();
    return {
      refresh: mount,
      dispose: function () {
        if (unmount !== null) unmount();
        unmount = null;
      }
    };
  };

  var identitySheet = remountable(identityCSS, "identity.css");
  var glassSheet = remountable(glassCSS, "glass.css");
  disposers.push(identitySheet.dispose);
  disposers.push(glassSheet.dispose);

  /** Rebuild both sheets from the current theme. Called after a skin change. */
  var refreshSheets = function () {
    identitySheet.refresh();
    glassSheet.refresh();
  };

  var layers = createLayerRoot();
  mountPoint.appendChild(layers.root);
  disposers.push(layers.dispose);

  var registered = false;
  var active = false;

  /** Mark the identity on or off; the stylesheet keys entirely off this. */
  var setActive = function (next) {
    if (active === next) return;
    active = next;
    if (next) document.documentElement.dataset.cyreneTheme = "on";
    else delete document.documentElement.dataset.cyreneTheme;
    if (hooks && typeof hooks.onSwitch === "function") {
      try {
        hooks.onSwitch(next);
      } catch (error) {
        console.error(PLUGIN_ID + ": identity switch hook failed", error);
      }
    }
  };

  var disposeTheme = null;
  if (ctx.theme && typeof ctx.theme.register === "function") {
    try {
      disposeTheme = ctx.theme.register({ id: THEME_ID, colorScheme: "dark", tokens: TOKENS });
      registered = true;
    } catch (error) {
      // A previous mount of this plugin may still own the id; activation below
      // is what matters, so this is not fatal.
      console.warn(PLUGIN_ID + ": theme id already registered, reusing it", error);
    }
  }
  if (ctx.theme && typeof ctx.theme.setTheme === "function") {
    try {
      ctx.theme.setTheme(THEME_ID);
    } catch (error) {
      console.warn(PLUGIN_ID + ": could not activate the theme", error);
    }
  }
  setActive(true);

  if (disposeTheme !== null) {
    disposers.push(function () {
      try {
        disposeTheme();
      } catch (error) {
        /* already disposed */
      }
    });
  }

  /**
   * Follow the host's theme changes.
   *
   * Only a *different third-party theme* takes precedence. The built-in
   * `light` / `dark` / `system` are colour-scheme preferences, not competing
   * themes — `dsh-client-ui-theme` persists one of them and re-publishes it on
   * every boot, so treating it as a takeover turned the whole identity off on
   * restart. That was the bug behind "美化重启后不生效".
   */
  if (typeof ctx.on === "function") {
    var handler = function (snapshot) {
      var id = themeIdOf(snapshot);
      if (id === null) return; // unreadable shape: keep our own theme rather than guess
      if (isBuiltinScheme(id)) return; // a colour scheme never displaces the identity
      setActive(id === THEME_ID);
    };
    try {
      disposers.push(ctx.on("theme/change", handler) || function () {});
    } catch (error) {
      console.warn(PLUGIN_ID + ": could not observe theme changes", error);
    }
  }

  return {
    layers: layers,
    isActive: function () {
      return active;
    },
    /**
     * Rebuild the stylesheets from the current theme.
     *
     * Exposed because a skin change re-derives `THEME` in place and the sheets
     * carry the previous values as text. The caller is `12-skins.js`, which has
     * no other way to reach them.
     */
    refreshSheets: refreshSheets,
    dispose: function () {
      setActive(false);
      for (var index = disposers.length - 1; index >= 0; index -= 1) {
        try {
          disposers[index]();
        } catch (error) {
          console.error(PLUGIN_ID + ": identity disposer failed", error);
        }
      }
      if (registered) {
        document.documentElement.removeAttribute("data-cyrene-theme");
      }
    }
  };
}

/**
 * The colour schemes the built-in theme plugin owns. These persist across
 * restarts and are re-published on every boot, so they must never be read as a
 * competing theme id.
 */
var BUILTIN_SCHEMES = { light: true, dark: true, system: true };

/**
 * Whether an id names a built-in colour scheme rather than a registered theme.
 * @param {string} id - the candidate id.
 * @returns {boolean} true for light, dark, or system.
 */
function isBuiltinScheme(id) {
  return BUILTIN_SCHEMES[id] === true;
}

/**
 * Best-effort read of a theme id out of a `theme/change` payload, whose exact
 * shape is not part of the documented contract.
 *
 * `preference` is deliberately not a candidate: it carries `light` / `dark` /
 * `system`, and reading it here is what let a boot-time preference change
 * switch the identity off.
 *
 * @param {unknown} snapshot - the event payload.
 * @returns {string|null} the id, or null when it cannot be determined.
 */
function themeIdOf(snapshot) {
  if (typeof snapshot === "string") return snapshot;
  if (!isPlainObject(snapshot)) return null;
  var candidates = [snapshot.theme, snapshot.id, snapshot.active, snapshot.current];
  for (var index = 0; index < candidates.length; index += 1) {
    var value = candidates[index];
    if (typeof value === "string" && value !== "") return value;
    if (isPlainObject(value) && typeof value.id === "string") return value.id;
  }
  return null;
}
