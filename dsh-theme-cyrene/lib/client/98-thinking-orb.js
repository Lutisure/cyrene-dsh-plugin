/**
 * Thinking orb — a small dotted indicator on the left of the composer.
 *
 * ## What this is, and what the first attempt was
 *
 * The request was for something signalling that she is working, beside the chat
 * input. The first build put a travelling light on the left edge of the whole
 * conversation, which was two mistakes dressed as one.
 *
 * The first was vocabulary. `composer` — the input area — and `thinking
 * indicator` — the thing on the message side — are different patterns, and
 * conflating them is exactly how the effect drifted off the input and onto the
 * conversation. The second was the form: an edge glow frames a column; it does
 * not sit *on* a control, and it says nothing a progress bar would not.
 *
 * What was chosen instead is a **thinking orb**: a small dotted object that
 * animates while she works. Its design follows `thinking-orbs` (Jakub Antalik,
 * MIT) — dot lattices on tilted orbits, monochrome, plain 2D canvas arcs.
 *
 * ## Why it is drawn rather than styled
 *
 * The reference is explicit that its two sizes are *separate designs, not a
 * scale factor*, and that the whole thing is canvas arcs with no filters. Both
 * hold here: the dot count and speed come from a preset keyed to the rendered
 * size, and nothing on this element uses `filter`, `box-shadow` or a gradient.
 * At 22px an orbit is a few pixels across, and a blurred glow is a smudge.
 *
 * ## State
 *
 * On only while something is executing. The reference pauses its instances when
 * the tab is hidden; this one stops the loop outright and resumes in phase,
 * because a requestAnimationFrame loop still running in a background tab is a
 * loop nobody asked for.
 */

/** The host's own marker for "something is executing right now". */
var WORKING_SELECTOR = '[data-state="running"]';

/**
 * How to find the composer.
 *
 * Not by `data-slot`. Every one of the host's slot markers measures 0×0 on the
 * live page — they are hooks for its own logic, not layout boxes — so a build
 * anchored to one of those silently ends up somewhere else. This walks up from
 * the editable element instead, which is certainly laid out.
 */
var COMPOSER_INPUT = '[contenteditable="true"], textarea';

/** A box narrower than this is a wrapper, not the composer. */
var COMPOSER_MIN_BOX = 120;

/** Dot edge, in px. The reference's small preset is 20; this sits beside text. */
var ORB_SIZE = 22;

/** How many rings, and the tilt of each, in radians. */
var ORB_RINGS = [0.34, -0.52, 0.92];

/**
 * Dots per ring, and how fast each ring turns.
 *
 * Keyed to the size rather than derived from it — the reference ships two
 * presets precisely because one formula does not serve both. At 22px the dots
 * are under two pixels across, and few enough that the eye can follow one.
 */
var ORB_DOTS = 5;
var ORB_SPEEDS = [0.9, -0.62, 0.44];

/**
 * Which of the animations to draw.
 *
 * Three of the reference's nine, picked for how they read at 22 pixels rather
 * than at 64. `working` is particles on tilted orbits; `searching` is a scan
 * meridian sweeping a dotted globe; `connecting` is a constellation wiring
 * itself. The names are the reference's own.
 */
var ORB_STATE = "working";

/** Where the constellation's stars sit, in unit coordinates, and how they wire. */
var ORB_STARS = [
  [-0.62, -0.36], [0.44, -0.62], [0.68, 0.12], [0.1, 0.52], [-0.54, 0.44], [0, -0.06]
];
var ORB_WIRES = [[0, 1], [1, 2], [2, 3], [3, 4], [4, 0], [5, 1], [5, 3]];

/**
 * Stylesheet for the orb.
 *
 * @returns {string} the CSS.
 */
function workingOrbCSS() {
  return [
    "/* cyrene: thinking orb */",
    ".cy-think-orb {",
    // Positioned, not inserted.
    //
    // The first version put the canvas inside the composer row, as a sibling of
    // the editable box. That row is rendered by the host's framework, and an
    // injected node there is reconciled away on the next render — the element is
    // created, the code that created it believes it succeeded, and the screen
    // stays empty. Measured: the stylesheet mounted, the state marker was set,
    // and `document.querySelectorAll("canvas")` returned only the theme's own
    // two. So it lives on `body` and is placed over the composer's left edge.
    "  position: fixed;",
    "  left: var(--cy-orb-x, -999px);",
    "  top: var(--cy-orb-y, -999px);",
    "  flex: none;",
    "  width: " + ORB_SIZE + "px;",
    "  height: " + ORB_SIZE + "px;",
    "  pointer-events: none;",
    "  z-index: 4;",
    "  display: none;",
    "}",
    // Faded rather than snapped. A dot lattice appearing between one frame and
    // the next reads as a glitch; the 320ms is long enough to be seen as
    // arriving and short enough not to lag the work it reports.
    "[data-cyrene-working=\"true\"] .cy-think-orb { display: block; animation: cy-orb-in 320ms ease-out both; }",
    "@keyframes cy-orb-in { from { opacity: 0; } to { opacity: 1; } }",
    // A narrow window puts the composer under real pressure, and the input is
    // worth more than the indicator.
    "@media (max-width: 720px) { .cy-think-orb { display: none !important; } }",
    // Reduced motion keeps the information and drops the movement: the orb is
    // replaced by nothing, because a still dot lattice is indistinguishable from
    // a decoration and the text beside it already says what is happening.
    "@media (prefers-reduced-motion: reduce) { .cy-think-orb { display: none !important; } }"
  ].join("\n");
}

/**
 * Create the thinking-orb layer.
 *
 * @returns {{start: Function, stop: Function, dispose: Function}} the layer.
 */
function createWorkingOrbLayer() {
  var unmount = mountStyle(workingOrbCSS(), "thinking-orb");
  var observer = null;
  var node = null;
  var context = null;
  var frame = null;
  var clock = 0;
  var last = 0;
  var running = false;

  /** The composer, found by walking up from the editable element. */
  var findComposer = function () {
    var walk = document.querySelector(COMPOSER_INPUT);
    while (walk !== null && walk !== undefined && walk !== document.body) {
      var rect = walk.getBoundingClientRect();
      if (rect.width > COMPOSER_MIN_BOX && rect.height > 24) return walk;
      walk = walk.parentNode;
    }
    return null;
  };

  /** Particles on tilted orbits. */
  var drawWorking = function (centre, radius) {
    for (var ring = 0; ring < ORB_RINGS.length; ring += 1) {
      var tilt = ORB_RINGS[ring];
      var spin = clock * ORB_SPEEDS[ring];
      // An orbit seen edge-on is an ellipse: each ring is tilted about the
      // horizontal axis, so a dot's depth is its own sine and drives its size
      // and alpha. That depth cue is the whole reason this reads as a sphere
      // rather than as three flat ellipses.
      var minor = radius * Math.abs(Math.cos(tilt));
      for (var dot = 0; dot < ORB_DOTS; dot += 1) {
        var angle = spin + (dot / ORB_DOTS) * Math.PI * 2 + ring * 0.7;
        var depth = Math.sin(angle) * Math.sin(tilt);
        context.globalAlpha = 0.28 + Math.max(0, depth) * 0.62;
        context.beginPath();
        context.arc(
          centre + Math.cos(angle) * radius,
          centre + Math.sin(angle) * minor,
          0.7 + Math.max(0, depth) * 0.9,
          0,
          Math.PI * 2
        );
        context.fill();
      }
    }
  };

  /**
   * A scan meridian sweeping a dotted globe.
   *
   * The dots sit on latitude rings; the meridian is a moving angle, and a dot's
   * brightness is its closeness to that angle. Only the near side is drawn — a
   * dot on the far side of the globe and one on the near side project to the
   * same place, and drawing both makes the sweep read as a flicker.
   */
  var drawSearching = function (centre, radius) {
    var meridian = (clock * 1.5) % (Math.PI * 2);
    var rings = 4;
    for (var ring = 0; ring < rings; ring += 1) {
      var lat = (ring + 0.5) / rings * Math.PI;
      var ringRadius = Math.sin(lat) * radius;
      var y = centre + Math.cos(lat) * radius * 0.62;
      var count = Math.max(5, Math.round(ringRadius * 2.2));
      for (var dot = 0; dot < count; dot += 1) {
        var angle = (dot / count) * Math.PI * 2;
        var facing = Math.sin(angle);
        if (facing < 0) continue;
        var gap = Math.abs(((angle - meridian + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
        var near = Math.max(0, 1 - gap / 0.9);
        context.globalAlpha = 0.22 + near * 0.72;
        context.beginPath();
        context.arc(centre + Math.cos(angle) * ringRadius, y, 0.65 + near * 0.85, 0, Math.PI * 2);
        context.fill();
      }
    }
  };

  /**
   * A constellation wiring itself.
   *
   * The wires appear one at a time and the pattern holds once complete, then
   * starts again. A cycle with nothing to wait for would just be a spinner; the
   * pause at the end is what makes it read as something being assembled.
   */
  var drawConnecting = function (centre, radius) {
    var cycle = 5.4;
    var at = clock % cycle;
    var drawn = Math.min(ORB_WIRES.length, Math.floor((at / (cycle - 1.2)) * (ORB_WIRES.length + 1)));
    context.strokeStyle = tint(THEME.pink, 0.95);
    context.lineWidth = 0.8;
    for (var wire = 0; wire < drawn; wire += 1) {
      var pair = ORB_WIRES[wire];
      var near = ORB_STARS[pair[0]];
      var far = ORB_STARS[pair[1]];
      context.globalAlpha = 0.45;
      context.beginPath();
      context.moveTo(centre + near[0] * radius, centre + near[1] * radius);
      context.lineTo(centre + far[0] * radius, centre + far[1] * radius);
      context.stroke();
    }
    for (var star = 0; star < ORB_STARS.length; star += 1) {
      context.globalAlpha = 0.35 + (star < drawn ? 0.6 : 0);
      context.beginPath();
      context.arc(
        centre + ORB_STARS[star][0] * radius,
        centre + ORB_STARS[star][1] * radius,
        star < drawn ? 1.1 : 0.75,
        0,
        Math.PI * 2
      );
      context.fill();
    }
    context.globalAlpha = 1;
  };

  /** Draw one frame. */
  var draw = function () {
    if (context === null) return;
    var ratio = Math.min(window.devicePixelRatio || 1, 2);
    var centre = ORB_SIZE / 2;
    var radius = centre - 4;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, ORB_SIZE, ORB_SIZE);
    context.fillStyle = tint(THEME.pink, 0.95);

    if (ORB_STATE === "searching") drawSearching(centre, radius);
    else if (ORB_STATE === "connecting") drawConnecting(centre, radius);
    else drawWorking(centre, radius);

    context.globalAlpha = 1;
  };

  /** One animation step. */
  var step = function (now) {
    if (!running) return;
    // Clamped: a tab that was throttled should not jump the orbits forward by
    // however long it was away.
    var delta = last === 0 ? 16 : Math.min(now - last, 64);
    last = now;
    clock += delta / 1000;
    draw();
    frame = requestAnimationFrame(step);
  };

  var startLoop = function () {
    if (running || context === null) return;
    running = true;
    last = 0;
    frame = requestAnimationFrame(step);
  };

  var stopLoop = function () {
    running = false;
    if (frame !== null) cancelAnimationFrame(frame);
    frame = null;
  };

  /**
   * Sit just left of the composer, vertically centred on it.
   *
   * Measured every pass rather than derived: the composer's own row is not the
   * window, and its position moves when the sidebar collapses or a queued
   * message appears above it. A fixed element does not follow its neighbours.
   */
  var place = function () {
    if (node === null) return;
    var composer = findComposer();
    if (composer === null) return;
    var rect = composer.getBoundingClientRect();
    node.style.setProperty("--cy-orb-x", Math.round(rect.left - ORB_SIZE - 8) + "px");
    node.style.setProperty("--cy-orb-y", Math.round(rect.top + (rect.height - ORB_SIZE) / 2) + "px");
  };

  /** Put the orb on the page. Once. */
  var mount = function () {
    if (node !== null && node.parentNode) return true;
    if (findComposer() === null) return false;
    var ratio = Math.min(window.devicePixelRatio || 1, 2);
    node = el("canvas", { class: "cy-think-orb" });
    node.width = Math.round(ORB_SIZE * ratio);
    node.height = Math.round(ORB_SIZE * ratio);
    node.style.width = ORB_SIZE + "px";
    node.style.height = ORB_SIZE + "px";
    context = node.getContext("2d");
    document.body.appendChild(node);
    place();
    draw();
    return true;
  };

  /** Is something executing right now? */
  var isWorking = function () {
    return document.querySelector(WORKING_SELECTOR) !== null;
  };

  /** One batched pass, at most once per frame. */
  var queued = false;
  var schedule = function () {
    if (queued) return;
    queued = true;
    var run = function () {
      queued = false;
      if (node === null && !mount()) return;
      place();
      var on = isWorking() && document.visibilityState !== "hidden";
      if (on) document.documentElement.setAttribute("data-cyrene-working", "true");
      else document.documentElement.removeAttribute("data-cyrene-working");
      if (on) startLoop();
      else stopLoop();
    };
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(run);
    else setTimeout(run, 16);
  };

  /** Stop watching, and put the document marker back. */
  var stop = function () {
    if (observer !== null) observer.disconnect();
    observer = null;
    document.removeEventListener("visibilitychange", schedule);
    document.documentElement.removeAttribute("data-cyrene-working");
    stopLoop();
  };

  return {
    start: function () {
      if (observer !== null) return;
      // Mounted synchronously as well as observed.
      //
      // The observer alone was not enough: the stylesheet was mounted and the
      // document marker was set, which only happens after `mount()` has
      // returned, and yet there was no canvas on the page. Whatever the
      // scheduling chain was losing, a direct attempt at start costs one
      // `querySelector` and removes the question.
      mount();
      if (typeof MutationObserver !== "function") return;
      observer = new MutationObserver(schedule);
      observer.observe(document.body, { childList: true, subtree: true, attributes: true });
      document.addEventListener("visibilitychange", schedule);
      schedule();
    },
    stop: stop,
    /**
     * No `this` anywhere in here, deliberately: the caller registers this with
     * `track(orb.dispose)`, which passes an unbound function.
     */
    dispose: function () {
      stop();
      if (node !== null && node.parentNode) node.parentNode.removeChild(node);
      node = null;
      context = null;
      unmount();
    }
  };
}
