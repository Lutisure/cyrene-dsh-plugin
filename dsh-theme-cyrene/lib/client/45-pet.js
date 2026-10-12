/**
 * The pet: Cyrene standing in the corner of the window.
 *
 * Her expressions are the five official chat stickers, so the artwork is hers
 * rather than something assembled from crops.
 *
 * A pet reads as alive or as decoration depending on three things, and all three
 * are about restraint:
 *
 *  - **Idle has to keep moving, but never in a loop you can spot.** A slow
 *    breath, a small drift, and a rare blink at an irregular interval.
 *  - **It has to notice you.** Typing, sending, hovering, clicking and being
 *    ignored for a long time each get a different answer.
 *  - **Every reaction is one-shot.** A pet that stays on one expression is a
 *    bug, not a mood, so each reaction returns to idle on its own.
 */

/** How long a reaction expression is held. */
var PET_REACT_MS = 1400;

/** Typing is continuous; this is the floor between two typing reactions. */
var PET_TYPING_GAP_MS = 9000;

/** Ignored for this long and she nudges you, once. */
var PET_LONELY_MS = 75000;

/** Blinks happen on their own, at an interval jittered around this. */
var PET_BLINK_MS = 5200;

/**
 * Build the pet.
 *
 * @param {object[]} entries - expression entries, each `{ role, label, url }`.
 * @param {{position?: object, onMove?: Function, onInteract?: Function}} [hooks] - persistence and idle-reset hooks.
 * @returns {{root: HTMLElement, show: Function, hide: Function, setPosition: Function, dispose: Function}|null} the pet.
 */
function createPet(entries, hooks) {
  if (!Array.isArray(entries) || entries.length === 0) return null;

  var byRole = {};
  for (var index = 0; index < entries.length; index += 1) {
    byRole[entries[index].role] = entries[index];
  }
  // `happy` is the face she wears by default: eyes closed and smiling, which
  // reads as content rather than as mid-expression the way a wink would.
  var resting = byRole.happy || entries[0];

  var image = el("img", {
    class: "cy-pet-sprite",
    src: resting.url,
    alt: "昔涟",
    draggable: "false"
  });
  var root = el("div", { class: "cy-pet", dataset: { plugin: PLUGIN_ID } }, [image]);

  var held = null;
  var blinkTimer = null;
  var lonelyTimer = null;
  var lastTyping = 0;
  var lonelyDone = false;

  /**
   * Show one expression, then go back to resting.
   * @param {string} role - the expression role.
   * @param {number} [holdMs] - how long to hold it.
   */
  var react = function (role, holdMs) {
    var entry = byRole[role];
    if (entry === undefined) return;
    image.setAttribute("src", entry.url);
    root.dataset.role = role;
    // Restart the pop animation even when the same role fires twice.
    root.dataset.pop = "false";
    void root.offsetWidth;
    root.dataset.pop = "true";
    if (held !== null) clearTimeout(held);
    held = setTimeout(function () {
      held = null;
      image.setAttribute("src", resting.url);
      root.dataset.role = resting.role;
    }, holdMs === undefined ? PET_REACT_MS : holdMs);
  };

  /** She is being paid attention to, so stop counting the silence. */
  var touch = function () {
    lonelyDone = false;
    if (lonelyTimer !== null) clearTimeout(lonelyTimer);
    lonelyTimer = setTimeout(function () {
      if (!lonelyDone) {
        lonelyDone = true;
        react("smug", 2200);
      }
    }, PET_LONELY_MS);
    if (hooks !== undefined && typeof hooks.onInteract === "function") hooks.onInteract();
  };

  var scheduleBlink = function () {
    // Jittered, so the blink never lands on a beat the eye can predict.
    var wait = PET_BLINK_MS * (0.6 + Math.random() * 0.9);
    blinkTimer = setTimeout(function () {
      if (held === null) react("wink", 260);
      scheduleBlink();
    }, wait);
  };

  var onKeyDown = function (event) {
    if (event.isComposing === true || event.key === "Process") return;
    touch();
    if (event.key === "Enter") {
      react("happy", 900);
      return;
    }
    if (event.key === "Backspace" || typeof event.key !== "string" || event.key.length !== 1) return;
    var now = Date.now();
    if (now - lastTyping < PET_TYPING_GAP_MS) return;
    lastTyping = now;
    react(Math.random() < 0.5 ? "sparkle" : "surprised", 900);
  };

  var onEnter = function () {
    touch();
    react("surprised", 700);
  };
  var onClick = function (event) {
    // The pet sits above the shell; a click must not reach whatever is behind
    // it, or clicking her would also close a popover.
    event.stopPropagation();
    touch();
    react("sparkle", 1600);
  };

  document.addEventListener("keydown", onKeyDown, true);
  root.addEventListener("pointerenter", onEnter);
  root.addEventListener("click", onClick);

  /** Position the pet from a saved bottom-right offset, in pixels. */
  var setPosition = function (position) {
    if (position === null || position === undefined) {
      root.style.left = "";
      root.style.top = "";
      root.dataset.placed = "false";
      return;
    }
    root.style.left = position.left + "px";
    root.style.top = position.top + "px";
    root.dataset.placed = "true";
  };

  // A drag that is not a drag: the pet is a small target, so only a deliberate
  // movement moves her, and a click that barely travels stays a click.
  var dragging = false;
  var startX = 0;
  var startY = 0;
  var originX = 0;
  var originY = 0;

  var onPointerDown = function (event) {
    dragging = true;
    startX = event.clientX;
    startY = event.clientY;
    var box = root.getBoundingClientRect();
    originX = box.left;
    originY = box.top;
    root.dataset.dragging = "true";
  };
  var onPointerMove = function (event) {
    if (!dragging) return;
    var dx = event.clientX - startX;
    var dy = event.clientY - startY;
    if (Math.abs(dx) < 4 && Math.abs(dy) < 4) return;
    setPosition({
      left: Math.max(0, Math.min(window.innerWidth - 120, originX + dx)),
      top: Math.max(0, Math.min(window.innerHeight - 120, originY + dy))
    });
  };
  var onPointerUp = function () {
    if (!dragging) return;
    dragging = false;
    root.dataset.dragging = "false";
    if (root.dataset.placed === "true" && hooks !== undefined && typeof hooks.onMove === "function") {
      hooks.onMove({ left: parseFloat(root.style.left) || 0, top: parseFloat(root.style.top) || 0 });
    }
  };

  root.addEventListener("pointerdown", onPointerDown);
  window.addEventListener("pointermove", onPointerMove);
  window.addEventListener("pointerup", onPointerUp);

  return {
    root: root,
    show: function () {
      root.dataset.hidden = "false";
      touch();
      if (blinkTimer === null) scheduleBlink();
    },
    hide: function () {
      root.dataset.hidden = "true";
      if (blinkTimer !== null) clearTimeout(blinkTimer);
      blinkTimer = null;
    },
    setPosition: setPosition,
    /** The expression roles actually available, for the tests and the panel. */
    roles: Object.keys(byRole),
    dispose: function () {
      if (held !== null) clearTimeout(held);
      if (blinkTimer !== null) clearTimeout(blinkTimer);
      if (lonelyTimer !== null) clearTimeout(lonelyTimer);
      document.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      if (root.parentNode) root.parentNode.removeChild(root);
    }
  };
}
