/**
 * Pointer effects: what a click and a moving cursor leave behind.
 *
 * These are event-driven, which is what separates them from the ambient field
 * next door — the fireflies drift whether or not anyone is here, these exist
 * only because someone moved. So they live in the same canvas but in their own
 * list, with their own clock.
 *
 * Three properties are non-negotiable and are the reason the code looks the way
 * it does:
 *
 *   1. **It never intercepts the pointer.** The canvas is `pointer-events:
 *      none` and every listener is registered `passive: true`. `preventDefault`
 *      is called nowhere in this file, so scrolling and text selection keep
 *      working even mid-burst.
 *   2. **It is bounded.** A held-down pointer or a mouse left on one pixel can
 *      otherwise emit a burst per frame forever; `EFFECT_LIMITS` caps both the
 *      live click count and the live trail length, oldest shed first.
 *   3. **It costs nothing when idle.** The loop stops as soon as both lists
 *      drain, so an idle window runs no frames from this file at all.
 *
 * Colour is baked per instance rather than read from a custom property: a
 * `rainbow` burst is many hues at once, and one token cannot express that.
 */

/**
 * Create the pointer-effects layer.
 *
 * @param {HTMLCanvasElement} canvas - the target canvas.
 * @returns {{apply: (options: object) => void, dispose: () => void}} the layer API.
 */
function createPointerEffects(canvas) {
  var context = canvas.getContext("2d");
  if (context === null) {
    return { apply: function () {}, dispose: function () {} };
  }

  /** The user's choices, replaced wholesale on every `apply`. */
  var options = {
    click: "off",
    clickColor: "theme",
    clickColorCustom: "#ff8fd0",
    clickOpacity: 0.85,
    clickBlend: "screen",
    trail: "off",
    trailColor: "theme",
    trailColorCustom: "#8fe8ff",
    trailOpacity: 0.7,
    trailBlend: "screen"
  };

  /**
   * Settings key → the local name this module uses.
   *
   * The two vocabularies differ on purpose: `DEFAULT_SETTINGS` says
   * `clickEffect` / `trailEffect` because that is what a *setting* is, while the
   * module says `click` / `trail` because that is what a *layer* is. Something
   * has to translate, and doing it here — rather than naming both sides the same
   * — keeps the stored document readable. `apply` iterates this table, so a key
   * missing from it is silently ignored; that is exactly the bug the pointer
   * tests caught the first time they ran.
   */
  var KEYS = {
    clickEffect: "click",
    clickColor: "clickColor",
    clickColorCustom: "clickColorCustom",
    clickOpacity: "clickOpacity",
    clickBlend: "clickBlend",
    trailEffect: "trail",
    trailColor: "trailColor",
    trailColorCustom: "trailColorCustom",
    trailOpacity: "trailOpacity",
    trailBlend: "trailBlend"
  };

  var clicks = [];
  var trail = [];
  var frame = null;
  var width = 0;
  var height = 0;
  var dpr = 1;
  var lastX = null;
  var lastY = null;
  var hueCursor = Math.random() * 360;
  var reduced = prefersReducedMotion();

  /** Match the backing store to the viewport, capped so 4K does not melt. */
  var resize = function () {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    width = window.innerWidth;
    height = window.innerHeight;
    canvas.width = Math.floor(width * dpr);
    canvas.height = Math.floor(height * dpr);
    canvas.style.width = width + "px";
    canvas.style.height = height + "px";
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
  };

  /**
   * Resolve the colour a new instance should be born with.
   * @param {string} mode - `theme`, `rainbow`, or `custom`.
   * @param {string} custom - the custom picker's value, used by `custom`.
   * @param {number} hueShift - degrees to add when the mode is `rainbow`.
   * @returns {{h: number, s: number, l: number, literal: string|null}} the colour.
   */
  var pickColor = function (mode, custom, hueShift) {
    if (mode === "custom") {
      return { h: 0, s: 0, l: 0, literal: custom };
    }
    if (mode === "rainbow") {
      return { h: (hueCursor + hueShift) % 360, s: 100, l: 78, literal: null };
    }
    // `theme` keeps the palette's pink family, which is what the ambient field
    // uses, so a burst reads as part of the theme rather than an addition to it.
    return { h: 330, s: 96, l: 80, literal: null };
  };

  /** One expanding ring. */
  var makeRipple = function (x, y, color) {
    return {
      kind: "ripple",
      x: x,
      y: y,
      age: 0,
      life: 640,
      radius: 6 + Math.random() * 5,
      growth: 0.085 + Math.random() * 0.05,
      lineWidth: 1.6 + Math.random() * 1.4,
      color: color
    };
  };

  /** One spark flying outward. */
  var makeSpark = function (x, y, color) {
    var angle = Math.random() * Math.PI * 2;
    var speed = 0.7 + Math.random() * 2.4;
    return {
      kind: "spark",
      x: x,
      y: y,
      age: 0,
      life: 420 + Math.random() * 460,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      radius: 0.9 + Math.random() * 1.5,
      color: color
    };
  };

  /** One dot dropped along the path. */
  var makeSpeck = function (x, y, color) {
    return {
      kind: "speck",
      x: x,
      y: y,
      age: 0,
      life: TRAIL_FADE_MS + Math.random() * 320,
      radius: 0.6 + Math.random() * 1.4,
      drift: Math.random() * Math.PI * 2,
      driftRate: 0.01 + Math.random() * 0.03,
      rise: 0.06 + Math.random() * 0.16,
      color: color
    };
  };

  /** Shed the oldest entries so a held pointer cannot grow the lists forever. */
  var bound = function (list, limit) {
    if (list.length > limit) list.splice(0, list.length - limit);
  };

  /**
   * @returns {string} a CSS colour for one instance at one alpha.
   *
   * Defined before the two functions that call it: these are `var`
   * assignments, not hoisted declarations, so calling `strokeOf` from `tick`
   * while it is still `undefined` would throw on the first frame.
   */
  var strokeOf = function (color, alpha) {
    if (color.literal !== null) {
      // A custom colour arrives as the picker's `#rrggbb`; the alpha rides on
      // top of it so one picker can still drive an opacity slider.
      return withAlpha(color.literal, alpha);
    }
    return "hsla(" + color.h.toFixed(0) + ", " + color.s + "%, " + color.l + "%, " + alpha.toFixed(3) + ")";
  };

  /** Begin the animation loop. Defined before `burst` / `emit` call it. */
  var start = function () {
    if (frame !== null) return;
    if (document.hidden) return;
    frame = window.requestAnimationFrame(tick);
  };

  /** Begin a click burst at a viewport position. */
  var burst = function (x, y) {
    if (options.click === "off") return;
    var base = pickColor(options.clickColor, options.clickColorCustom, 0);
    if (options.click === "ripple" || options.click === "both") {
      clicks.push(makeRipple(x, y, base));
      clicks.push(makeRipple(x, y, base));
    }
    if (options.click === "spark" || options.click === "both") {
      var count = reduced ? 5 : EFFECT_LIMITS.sparksPerClick;
      for (var index = 0; index < count; index += 1) {
        // Spread the sparks across a slice of the wheel so one burst is a small
        // gradient rather than a single flat colour.
        var spread = options.clickColor === "rainbow" ? (index / count) * 64 : 0;
        clicks.push(makeSpark(x, y, pickColor(options.clickColor, options.clickColorCustom, spread)));
      }
      hueCursor = (hueCursor + 37) % 360;
    }
    bound(clicks, EFFECT_LIMITS.clicks);
    start();
  };

  /** Drop specks between two points, spaced roughly evenly. */
  var emit = function (fromX, fromY, toX, toY) {
    if (options.trail === "off") return;
    var dx = toX - fromX;
    var dy = toY - fromY;
    var distance = Math.sqrt(dx * dx + dy * dy);
    if (distance < 2) return;

    if (options.trail === "comet") {
      // A comet is one head per frame; the head's own fade draws the tail.
      var head = pickColor(options.trailColor, options.trailColorCustom, 0);
      trail.push(makeSpeck(toX, toY, head));
      trail[trail.length - 1].radius = 1.4 + Math.random() * 1.8;
      trail[trail.length - 1].life = TRAIL_FADE_MS;
    } else {
      // Stardust keeps the droplets at a fixed spacing, so speed changes the
      // density of the trail rather than the size of the steps.
      var step = 9;
      var steps = Math.min(14, Math.floor(distance / step));
      for (var index = 0; index <= steps; index += 1) {
        var ratio = index / Math.max(1, steps);
        var x = fromX + dx * ratio;
        var y = fromY + dy * ratio;
        var hue = options.trailColor === "rainbow" ? (index / Math.max(1, steps)) * 90 : 0;
        trail.push(makeSpeck(x, y, pickColor(options.trailColor, options.trailColorCustom, hue)));
      }
    }
    bound(trail, EFFECT_LIMITS.trail);
    start();
  };

  /** Draw one tick of both lists, then stop if nothing is left. */
  var tick = function () {
    frame = null;
    context.clearRect(0, 0, width, height);

    var alive = false;
    var index;

    context.globalCompositeOperation = options.clickBlend || "screen";
    for (index = clicks.length - 1; index >= 0; index -= 1) {
      var click = clicks[index];
      click.age += 16;
      if (click.age >= click.life) {
        clicks.splice(index, 1);
        continue;
      }
      alive = true;
      var progress = click.age / click.life;
      var fade = 1 - progress;
      var alpha = fade * fade * options.clickOpacity;

      if (click.kind === "ripple") {
        click.radius += click.radius * click.growth + 0.55;
        context.strokeStyle = strokeOf(click.color, alpha);
        context.lineWidth = click.lineWidth * fade;
        context.beginPath();
        context.arc(click.x, click.y, click.radius, 0, Math.PI * 2);
        context.stroke();
      } else {
        // Sparks slow down and fall a little, which reads as weight.
        click.vx *= 0.955;
        click.vy = click.vy * 0.955 + 0.055;
        click.x += click.vx;
        click.y += click.vy;
        context.fillStyle = strokeOf(click.color, alpha);
        context.beginPath();
        context.arc(click.x, click.y, click.radius * fade, 0, Math.PI * 2);
        context.fill();
      }
    }

    context.globalCompositeOperation = options.trailBlend || "screen";
    for (index = trail.length - 1; index >= 0; index -= 1) {
      var speck = trail[index];
      speck.age += 16;
      if (speck.age >= speck.life) {
        trail.splice(index, 1);
        continue;
      }
      alive = true;
      var life = 1 - speck.age / speck.life;
      speck.drift += speck.driftRate;
      speck.y -= speck.rise;
      context.fillStyle = strokeOf(speck.color, life * options.trailOpacity);
      context.beginPath();
      context.arc(speck.x + Math.sin(speck.drift) * 0.7, speck.y, speck.radius * life, 0, Math.PI * 2);
      context.fill();
    }

    context.globalCompositeOperation = "source-over";

    if (alive) frame = window.requestAnimationFrame(tick);
    else context.clearRect(0, 0, width, height);
  };

  var onPointerDown = function (event) {
    if (event.button !== undefined && event.button !== 0) return;
    burst(event.clientX, event.clientY);
  };

  var onPointerMove = function (event) {
    if (options.trail === "off") {
      lastX = event.clientX;
      lastY = event.clientY;
      return;
    }
    if (lastX === null) {
      lastX = event.clientX;
      lastY = event.clientY;
      return;
    }
    emit(lastX, lastY, event.clientX, event.clientY);
    lastX = event.clientX;
    lastY = event.clientY;
  };

  var onLeave = function () {
    lastX = null;
    lastY = null;
  };

  var onVisibility = function () {
    if (document.hidden) {
      // Nothing is watching; drop the mid-flight frames rather than resume them.
      if (frame !== null) {
        window.cancelAnimationFrame(frame);
        frame = null;
      }
      context.clearRect(0, 0, width, height);
      clicks.length = 0;
      trail.length = 0;
    }
  };

  resize();
  window.addEventListener("resize", resize);
  window.addEventListener("pointerdown", onPointerDown, { passive: true });
  window.addEventListener("pointermove", onPointerMove, { passive: true });
  window.addEventListener("pointerleave", onLeave, { passive: true });
  document.addEventListener("visibilitychange", onVisibility);

  return {
    /**
     * Replace the user's choices. Called on every settings change; starting from
     * `off` also drops whatever is already in flight, so turning an effect off
     * looks immediate instead of trailing for half a second.
     *
     * @param {object} next - the effect-related settings.
     */
    apply: function (next) {
      if (!isPlainObject(next)) return;
      var wasOff = options.click === "off" && options.trail === "off";
      for (var key in KEYS) {
        if (!Object.prototype.hasOwnProperty.call(KEYS, key)) continue;
        var value = next[key];
        if (value === undefined || value === null) continue;
        options[KEYS[key]] = value;
      }
      if (options.click === "off") clicks.length = 0;
      if (options.trail === "off") trail.length = 0;
      if (wasOff && (options.click !== "off" || options.trail !== "off")) start();
    },
    dispose: function () {
      if (frame !== null) window.cancelAnimationFrame(frame);
      frame = null;
      window.removeEventListener("resize", resize);
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerleave", onLeave);
      document.removeEventListener("visibilitychange", onVisibility);
    }
  };
}

/**
 * Put an alpha on a `#rrggbb` string.
 *
 * Kept here rather than reaching for `color-mix()`: the picker guarantees a
 * six-digit hex, and a plain `rgba()` is understood by every engine we support
 * without a feature test.
 *
 * @param {string} hex - `#rrggbb`.
 * @param {number} alpha - 0..1.
 * @returns {string} an `rgba()` string.
 */
function withAlpha(hex, alpha) {
  var match = /^#([0-9a-f]{6})$/i.exec(String(hex).trim());
  if (match === null) return "rgba(255, 143, 208, " + alpha.toFixed(3) + ")";
  var value = parseInt(match[1], 16);
  var red = (value >> 16) & 255;
  var green = (value >> 8) & 255;
  var blue = value & 255;
  return "rgba(" + red + ", " + green + ", " + blue + ", " + alpha.toFixed(3) + ")";
}
