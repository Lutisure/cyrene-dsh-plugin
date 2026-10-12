/**
 * Ambient particle layer: soft pink fireflies drifting behind the UI.
 *
 * Drawn on a canvas rather than as DOM nodes so a hundred of them cost one
 * composited layer. Each particle keeps its own size, brightness, drift and
 * breathing phase, so the field never reads as a repeating pattern.
 */

/**
 * Create the particle field.
 * @param {HTMLCanvasElement} canvas - the target canvas.
 * @returns {{setCount: (count: number) => void, dispose: () => void}} the field API.
 */
function createParticles(canvas) {
  var context = canvas.getContext("2d");
  if (context === null) {
    return { setCount: function () {}, dispose: function () {} };
  }

  var particles = [];
  var target = 0;
  var frame = null;
  var width = 0;
  var height = 0;
  var dpr = 1;
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

  /** One firefly. */
  var make = function () {
    return {
      x: Math.random() * width,
      y: Math.random() * height,
      radius: 0.7 + Math.random() * 1.9,
      speedX: (Math.random() - 0.5) * 0.24,
      speedY: -0.08 - Math.random() * 0.26,
      drift: Math.random() * Math.PI * 2,
      driftRate: 0.004 + Math.random() * 0.010,
      phase: Math.random() * Math.PI * 2,
      phaseRate: 0.012 + Math.random() * 0.028,
      hue: 330 + Math.random() * 22
    };
  };

  /** Grow or shrink the field toward the requested count. */
  var setCount = function (count) {
    target = Math.max(0, Number(count) || 0);
    if (reduced) target = Math.min(target, 10);
    while (particles.length < target) particles.push(make());
    if (particles.length > target) particles.length = target;
    if (target > 0 && frame === null) start();
    if (target === 0 && frame !== null) stop();
    canvas.dataset.active = String(target > 0);
  };

  /** Draw one tick. */
  var tick = function () {
    context.clearRect(0, 0, width, height);
    for (var index = 0; index < particles.length; index += 1) {
      var particle = particles[index];
      particle.drift += particle.driftRate;
      particle.phase += particle.phaseRate;
      particle.x += particle.speedX + Math.sin(particle.drift) * 0.22;
      particle.y += particle.speedY;

      // Wrap rather than respawn, so the field has no visible seams.
      if (particle.y < -12) {
        particle.y = height + 12;
        particle.x = Math.random() * width;
      }
      if (particle.x < -12) particle.x = width + 12;
      if (particle.x > width + 12) particle.x = -12;

      var breathe = 0.42 + 0.58 * (0.5 + 0.5 * Math.sin(particle.phase));
      var alpha = breathe * 0.7;
      var radius = particle.radius * (0.85 + 0.3 * breathe);

      var glow = context.createRadialGradient(particle.x, particle.y, 0, particle.x, particle.y, radius * 6);
      glow.addColorStop(0, "hsla(" + particle.hue + ", 100%, 82%, " + alpha.toFixed(3) + ")");
      glow.addColorStop(0.4, "hsla(" + particle.hue + ", 100%, 74%, " + (alpha * 0.36).toFixed(3) + ")");
      glow.addColorStop(1, "hsla(" + particle.hue + ", 100%, 70%, 0)");
      context.fillStyle = glow;
      context.beginPath();
      context.arc(particle.x, particle.y, radius * 6, 0, Math.PI * 2);
      context.fill();

      context.fillStyle = "hsla(" + particle.hue + ", 100%, 92%, " + alpha.toFixed(3) + ")";
      context.beginPath();
      context.arc(particle.x, particle.y, radius, 0, Math.PI * 2);
      context.fill();
    }
    frame = window.requestAnimationFrame(tick);
  };

  var start = function () {
    if (frame !== null) return;
    frame = window.requestAnimationFrame(tick);
  };

  var stop = function () {
    if (frame === null) return;
    window.cancelAnimationFrame(frame);
    frame = null;
    context.clearRect(0, 0, width, height);
  };

  /** Stop animating while the tab is hidden; nobody is watching. */
  var onVisibility = function () {
    if (document.hidden) stop();
    else if (target > 0) start();
  };

  resize();
  window.addEventListener("resize", resize);
  document.addEventListener("visibilitychange", onVisibility);

  return {
    setCount: setCount,
    dispose: function () {
      stop();
      window.removeEventListener("resize", resize);
      document.removeEventListener("visibilitychange", onVisibility);
    }
  };
}
