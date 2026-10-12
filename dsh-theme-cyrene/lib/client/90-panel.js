/**
 * The control dock: a draggable frosted bar with one button per subsystem, and
 * the popover stack its buttons open.
 *
 * Only one popover is open at a time; `Escape` closes the top one. Dragging is
 * bound to the dock but ignores presses that start on a button, so "grab
 * anywhere" and "click a button" do not conflict.
 */

/** Open popovers, bottom of the stack first. */
var popoverStack = [];

/**
 * Position a popover above its anchor, kept inside the viewport.
 * @param {HTMLElement} node - the popover.
 * @param {HTMLElement} anchor - the button it belongs to.
 * @returns {void}
 */
function placePopover(node, anchor) {
  var rect = anchor.getBoundingClientRect();
  node.style.visibility = "hidden";
  node.style.left = "0px";
  node.style.top = "0px";
  var width = node.offsetWidth;
  var height = node.offsetHeight;
  var margin = 10;
  var left = clamp(rect.left + rect.width / 2 - width / 2, margin, Math.max(margin, window.innerWidth - width - margin));
  var top = rect.top - height - 12;
  if (top < margin) top = Math.min(rect.bottom + 12, Math.max(margin, window.innerHeight - height - margin));
  node.style.left = Math.round(left) + "px";
  node.style.top = Math.round(top) + "px";
  node.style.visibility = "";
}

/** Re-place every open popover, after a drag or a resize. */
function repositionAllPopovers() {
  for (var index = 0; index < popoverStack.length; index += 1) {
    var frame = popoverStack[index];
    if (frame.node.parentNode) placePopover(frame.node, frame.anchor);
  }
}

/**
 * Tell every open panel that the bar's arrangement changed.
 *
 * The bar and the Scene panel are two views of one setting, and a drag in the
 * bar writes it without the panel knowing. A panel that kept showing the old
 * positions would be quietly lying about the thing it controls, which is worse
 * than showing nothing.
 *
 * Read off the node rather than kept anywhere, for the reason the hook itself
 * documents: a panel is built, closed and rebuilt, and a stored reference would
 * update a detached node while the visible one stayed wrong. Panels that have
 * no opinion simply do not define it.
 */
function syncOpenPanels(frames) {
  var list = frames === undefined ? popoverStack.slice() : frames;
  for (var index = 0; index < list.length; index += 1) {
    var node = list[index].node;
    if (typeof node.__syncDock === "function") node.__syncDock();
  }
}

/**
 * Close the topmost popover.
 * @returns {boolean} true when one was closed.
 */
function closeTopPopover() {
  var frame = popoverStack.pop();
  if (frame === undefined) return false;
  if (frame.node.parentNode) frame.node.parentNode.removeChild(frame.node);
  if (typeof frame.onClose === "function") {
    try {
      frame.onClose();
    } catch (error) {
      console.error(PLUGIN_ID + ": popover close hook failed", error);
    }
  }
  return true;
}

/** Close every open popover. */
function closeAllPopovers() {
  while (closeTopPopover()) {
    /* keep popping */
  }
}

/**
 * Open a popover above an anchor, closing whatever was open.
 * @param {HTMLElement} node - the popover element.
 * @param {HTMLElement} anchor - the button it belongs to.
 * @param {{onClose?: () => void, onMounted?: () => void}} [options] - close hook,
 *   plus a hook run after the node is in the document. A panel is built detached,
 *   so anything that needs real layout — measuring, scrolling — belongs there,
 *   not in the builder.
 * @returns {HTMLElement} the popover.
 */
function openPopover(node, anchor, options) {
  closeAllPopovers();
  document.body.appendChild(node);
  placePopover(node, anchor);
  popoverStack.push({ node: node, anchor: anchor, onClose: options && options.onClose });
  if (options && typeof options.onMounted === "function") options.onMounted();
  return node;
}

/** Whether a popover from this plugin is currently open. */
function hasOpenPopover() {
  return popoverStack.length > 0;
}

/**
 * Lift a descendant's mounted/close hooks onto the panel root.
 *
 * `togglePopover` reads the hooks off the node it is handed, which is the panel
 * root. A panel whose *part* needs to start and stop work — the Now Playing block
 * polls the host while it is visible — therefore has to have that part's hooks
 * reach the root, or they are never called. Found by a test: the block rendered
 * and never asked the host anything.
 *
 * **Composed, not assigned.** The music panel already used `__onMounted` for its
 * own purpose (scrolling the playlist to the playing track), and a plain
 * assignment silently replaced it — which a different test caught immediately.
 * The root's existing hook, if any, runs first: it is the panel's own work, and
 * should happen before a child starts polling.
 *
 * @param {HTMLElement} root - the panel node handed to `togglePopover`.
 * @param {HTMLElement} child - the descendant carrying `__onMounted` / `__onClose`.
 * @returns {void}
 */
function bubblePopoverHooks(root, child) {
  if (root === null || root === undefined || child === null || child === undefined) return;

  var childMounted = child.__onMounted;
  if (typeof childMounted === "function") {
    var rootMounted = root.__onMounted;
    root.__onMounted = typeof rootMounted === "function"
      ? function () { rootMounted(); childMounted(); }
      : childMounted;
  }

  var childClose = child.__onClose;
  if (typeof childClose === "function") {
    var rootClose = root.__onClose;
    // Reversed for teardown: a child stops its own work before the panel does
    // anything else, so nothing it owns is running while its container is torn
    // down.
    root.__onClose = typeof rootClose === "function"
      ? function () { childClose(); rootClose(); }
      : childClose;
  }
}

/* ------------------------------------------------------------------ *
 * The dock's icons and the slots they fill
 * ------------------------------------------------------------------ */

/**
 * Which subsystem each dock slot controls, and what it is called.
 *
 * The dock's buttons are no longer declared one after another at the mount site:
 * they are rendered from this list, every time the fixed/free split changes. So
 * this is the registry of what a slot *is*, and the mount site supplies only what
 * it *does* (its click).
 *
 * `id` is the key every other part of the feature uses — the settings arrays, the
 * button's `data-id`, and the management rows in the wallpaper panel. It is part
 * of the saved format and must not be renamed without a migration.
 *
 * `label` is the English word the bar has always shown, and is what stays in the
 * button's `textContent` so it stays the button's accessible name. `name` is the
 * Chinese name the management rows and the reorder announcements use.
 *
 * A function rather than a constant because `10-constants.js` declares the two
 * default arrays this order has to agree with, and the two files are concatenated
 * into one scope where only function declarations are safely shared.
 *
 * @returns {Array<{id: string, label: string, name: string}>} the six slots.
 */
function dockPieces() {
  return [
    { id: "sound", label: "Sound", name: "音效" },
    { id: "fonts", label: "Type", name: "字体" },
    { id: "particles", label: "Particles", name: "粒子" },
    { id: "pointer", label: "Trace", name: "指针" },
    { id: "wallpaper", label: "Scene", name: "场景" },
    { id: "music", label: "Cyrene", name: "昔涟" }
  ];
}

/** The display name of a slot, falling back to its id for an unknown one. */
function dockName(id) {
  var pieces = dockPieces();
  for (var index = 0; index < pieces.length; index += 1) {
    if (pieces[index].id === id) return pieces[index].name;
  }
  return id;
}

/** The English label of a slot, or the id when it is not one this build knows. */
function dockLabelOf(id) {
  var pieces = dockPieces();
  for (var index = 0; index < pieces.length; index += 1) {
    if (pieces[index].id === id) return pieces[index].label;
  }
  return id;
}

/** Every slot id this build knows, in declaration order. */
function dockIds() {
  return dockPieces().map(function (piece) {
    return piece.id;
  });
}

/**
 * Decide the fixed/free split, and repair it if the saved document has to be.
 *
 * ## Why this repairs rather than trusts
 *
 * `dockFixed` and `dockOrder` come out of a settings document that a user can
 * edit by hand, that an exported theme from an older build can carry, and that a
 * future version can leave stale by adding or retiring a slot. Every id has to
 * render exactly once, and the failure mode is not symmetric: a slot rendered
 * twice is merely odd, while a slot rendered zero times is a button that has
 * left the interface with no way to bring it back — the only control that could
 * have restored it was the one that went missing.
 *
 * So a document that does not partition exactly is replaced wholesale by the
 * defaults, rather than merged. A merge sounds useful and is not: given a stored
 * `["sound", "fonts"]` there is no evidence of where the missing two were meant
 * to go, and any guess about it puts a slot somewhere the user never asked for
 * while looking like it obeyed them. "Unknown document, restore the default" is
 * a rule a user can predict from the result.
 *
 * ## The check is a partition, not two membership tests
 *
 * `["sound", "sound", "particles", "pointer"]` is the input that decided the
 * shape of this. It is the right length and every id in it is real, so a check
 * that asked "are these ids known" and "is this list long enough" would accept
 * it — and render `sound` twice while `fonts` disappeared. Counting is the only
 * test that catches it, so the rule is the one the invariant actually states:
 * concatenate the two arrays, and each known id has to appear in it exactly once.
 *
 * @param {string[]|undefined} fixed - the saved fixed list.
 * @param {string[]|undefined} free - the saved free list.
 * @param {string[]} known - every slot id this build knows.
 * @returns {{fixed: string[], free: string[], repaired: boolean}} the split.
 */
function resolveDockSplit(fixed, free, known) {
  var accepted = Array.isArray(fixed) ? fixed : null;
  var ordered = Array.isArray(free) ? free : null;

  if (accepted !== null && ordered !== null) {
    var seen = accepted.concat(ordered);
    var complete = seen.length === known.length;
    for (var index = 0; index < known.length && complete; index += 1) {
      var count = 0;
      for (var at = 0; at < seen.length; at += 1) {
        if (seen[at] === known[index]) count += 1;
      }
      complete = count === 1;
    }
    if (complete) return { fixed: accepted.slice(), free: ordered.slice(), repaired: false };
  }

  // The defaults are read from the settings declaration rather than copied in a
  // second time here, which is how two lists quietly stop agreeing.
  console.warn(PLUGIN_ID + ": the saved dock arrangement does not list each slot once — restoring the default arrangement");
  return {
    fixed: DEFAULT_SETTINGS.dockFixed.slice(),
    free: DEFAULT_SETTINGS.dockOrder.slice(),
    repaired: true
  };
}

/**
 * One icon, drawn as strokes rather than shipped as a font or a sprite.
 *
 * Hand-written paths in a 16×16 box, `currentColor`, 1.5 px strokes with round
 * caps — the same weight as the rest of the chrome, and inheriting the button's
 * colour means a hover, a focus ring and an active slot need no separate icon
 * states.
 *
 * `aria-hidden` because the button already carries the word in its
 * `textContent`; a drawn icon read out as well would say everything twice.
 *
 * @param {string} body - the inner markup.
 * @returns {Element} the `<svg>`.
 */
function dockIconSVG(body) {
  var svg = svgEl("svg", {
    class: "cy-ico",
    viewBox: "0 0 16 16",
    width: "16",
    height: "16",
    // `fill: none` in the CSS and as an attribute, because a browser's default
    // for an SVG root is black fill and an unstyled frame is exactly the failure
    // that is invisible in a headless test.
    fill: "none",
    stroke: "currentColor",
    "stroke-width": "1.5",
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
    "aria-hidden": "true",
    focusable: "false"
  });
  var parts = body.split("|");
  for (var index = 0; index < parts.length; index += 1) {
    var part = parts[index].trim();
    if (part === "") continue;
    var space = part.indexOf(" ");
    var tag = space === -1 ? part : part.slice(0, space);
    var value = space === -1 ? "" : part.slice(space + 1);
    svg.appendChild(svgEl(tag, tag === "circle"
      ? { cx: value.split(" ")[0], cy: value.split(" ")[1], r: value.split(" ")[2] }
      : { d: value }));
  }
  return svg;
}

/**
 * The six icons.
 *
 * Each `d` is written against the 16×16 box by hand, so the shapes are read here
 * rather than derived — a generator for six shapes costs more than six strings
 * and hides the numbers that have to be looked at when one is redrawn.
 *
 * @param {string} id - the slot id.
 * @returns {Element|null} the icon, or null for an id this build does not draw.
 */
function dockIcon(id) {
  if (id === "sound") {
    // A speaker: box, cone, and two waves. The waves stop short of the box's
    // right edge so the widest of them still lands inside the frame.
    return dockIconSVG(
      "path M2.9 6.1 h1.9 L7.4 3.7 v8.6 L4.8 9.9 H2.9 Z" +
      "|path M9.8 6.3 a2.6 2.6 0 0 1 0 3.4" +
      "|path M11.7 4.6 a4.9 4.9 0 0 1 0 6.8"
    );
  }
  if (id === "fonts") {
    // A capital A and a lowercase a, side by side: two letters, not the word
    // "Aa" — the letterforms are what say "typeface" at 16 px.
    return dockIconSVG(
      "path M0.9 11.4 L3.3 4.6 L5.7 11.4" +
      "|path M1.9 9 H4.7" +
      "|circle 10.7 8.65 2.3" +
      "|path M13 6.35 V11.4"
    );
  }
  if (id === "particles") {
    // Three four-pointed sparkles at three sizes: one reading as the subject and
    // two as its field, which is what the ambient layer actually looks like.
    return dockIconSVG(
      "path M5.2 1.9 C5.5 4.1 6.3 4.9 8.5 5.2 C6.3 5.5 5.5 6.3 5.2 8.5" +
      " C4.9 6.3 4.1 5.5 1.9 5.2 C4.1 4.9 4.9 4.1 5.2 1.9 Z" +
      "|path M11.8 4.2 C11.95 5.6 12.4 6.05 13.8 6.2 C12.4 6.35 11.95 6.8 11.8 8.2" +
      " C11.65 6.8 11.2 6.35 9.8 6.2 C11.2 6.05 11.65 5.6 11.8 4.2 Z" +
      "|path M7.1 9.9 C7.2 10.8 7.5 11.1 8.4 11.2 C7.5 11.3 7.2 11.6 7.1 12.5" +
      " C7 11.6 6.7 11.3 5.8 11.2 C6.7 11.1 7 10.8 7.1 9.9 Z"
    );
  }
  if (id === "pointer") {
    // A comet: the head, then a tail that tapers and curls away from it. The
    // pointer leaves a trace, which is what the button's word means.
    return dockIconSVG(
      "circle 11.1 4.9 2.4" +
      "|path M8.6 6.5 C6.5 8.3 4.4 9.6 1.9 10.6" +
      "|path M7.9 9.8 C6.6 10.7 5.3 11.3 3.7 11.7"
    );
  }
  if (id === "wallpaper") {
    // A framed picture: a rounded frame, a dot for a moon, and two mountains.
    return dockIconSVG(
      "rect x 1.8 y 3.2 width 12.4 height 9.6 rx 1.8" +
      "|path M3.9 10.9 L6.9 7.7 L9.9 10.9" +
      "|path M8.8 10.9 L11 8.6 L13.1 10.9" +
      "|circle 11.2 5.9 0.85"
    );
  }
  if (id === "music") {
    // A crescent, for the identity slot. Two arcs meeting at the tips: the
    // `a` at 6.5,8 to 9.5,8 then 9.5,8 back to 6.5,8 makes one closed lens
    // whose left side is the moon's outer edge.
    return dockIconSVG("path M6.5 8 A3.9 3.9 0 1 0 9.5 8 A3.1 3.1 0 1 1 6.5 8 Z");
  }
  return null;
}

/*
 * Reordering, in one place.
 *
 * Both the drag drop and the Alt+Arrow key run through the dock's own `moveSlot`
 * and `moveTo`, so "which way does a swap go" is decided once. There is
 * deliberately no path that moves a fixed slot: that is what 固定 means, and
 * letting a drag across the divider reorder one would be a different feature
 * under the same word.
 */

/**
 * Build the dock.
 *
 * ## Two groups, one bar
 *
 * Left to right: the grip, the fixed group, a rule, the free group, the fold
 * control. Fixed slots hold their declared order and cannot be dragged or
 * reordered — that is the literal reading of 固定, and the reason a drag never
 * crosses the rule. Free slots reorder among themselves by dragging one, or by
 * `Alt`+arrow from the keyboard.
 *
 * Every id renders exactly once. `resolveDockSplit` is what guarantees it, and
 * `renderDock` writes the accepted split back to the settings document, so a
 * repaired arrangement is the one that survives the next reload rather than
 * being re-derived from a stale document on every mount.
 *
 * The dock lives inside a positioned wrapper so the collapsed dot and the open
 * bar share one anchor: folding away must not move the control. It folds
 * itself after a few idle seconds, but never while a popover is open — pulling
 * the anchor out from under an open panel is worse than staying on screen.
 *
 * @returns {{root: HTMLElement, addButton: Function, renderDock: Function,
 *   resolve: Function, buttonFor: Function, setOn: Function,
 *   moveSlot: Function, moveTo: Function, announce: Function,
 *   isOpen: (id: string) => boolean, markClosed: Function, closeAll: () => void,
 *   setCollapsed: Function, isCollapsed: () => boolean,
 *   setVisible: (visible: boolean) => void, destroy: () => void}} the dock API.
 */
function createDock() {
  var wrap = el("div", { class: "cy-dock-wrap", dataset: { plugin: PLUGIN_ID, collapsed: "false" } });
  var dock = el("div", {
    class: "cy-dock",
    // A toolbar is a set of controls in a fixed strip, which is exactly what
    // this is. The name is what tells a screen reader user what the strip is
    // for; without it the bar is an anonymous run of buttons.
    role: "toolbar",
    "aria-label": "工具栏",
    dataset: { dock: "true" }
  });
  // The collapsed state is her portrait, not the 昔 glyph: at 42 px a face is
  // more recognisable than a character, and it keeps the character present even
  // when the bar is folded away. A missing portrait degrades to a plain circle
  // rather than an empty button.
  //
  // The body of this button is owned by `createAvatar`, which can swap the face
  // at runtime and re-applies the same fallbacks. Building the markup here as
  // well would give two writers for one node.
  var dot = el("button", {
    type: "button",
    class: "cy-dot",
    title: "展开控制面板",
    text: "\u25CF",
    onclick: function (event) {
      event.stopPropagation();
      // The release that ends a drag also produces a click, and this dot is a
      // drag grip as well as a button. Unfolding the bar after being moved
      // would be the opposite of what the gesture asked for.
      if (swallowDotClick) {
        swallowDotClick = false;
        return;
      }
      setCollapsed(false);
    }
  });
  var avatar = createAvatar(dot);
  var handle = el("div", { class: "cy-dock-handle", text: "\u22EE\u22EE", title: "按住拖动" });
  // The two groups are permanent containers, not rebuilt per render: a button
  // that keeps its identity across a reorder keeps everything attached to it,
  // and a rebuilt node would also drop focus mid-keyboard-reorder.
  var fixedGroup = el("div", { class: "cy-btn-group", dataset: { group: "fixed" } });
  // A gap, not a highlighted item. The research this borrows from is explicit
  // that jumping to the *destination* and drawing a slot there is the only thing
  // a reader can predict; highlighting an item leaves them guessing whether the
  // drop lands before it or after it.
  var divider = el("div", { class: "cy-divider", dataset: { divider: "true" } });
  var freeGroup = el("div", { class: "cy-btn-group", dataset: { group: "free" } });
  // A manual fold, so waiting out the idle timer is not the only way. Kept as
  // the last child of the bar, after the free group.
  var foldButton = el("button", {
    type: "button",
    class: "cy-btn cy-fold",
    title: "收起",
    text: "\u2039",
    onclick: function (event) {
      event.stopPropagation();
      setCollapsed(true);
    }
  });
  // A reorder does not move focus — the button stays put and its neighbours
  // move past it — so a keyboard user gets no feedback at all from the change
  // itself. This is where that feedback comes from.
  var live = el("div", {
    class: "cy-sr",
    role: "status",
    "aria-live": "polite",
    "aria-atomic": "true",
    dataset: { live: "dock" }
  });
  append(dock, [handle, fixedGroup, divider, freeGroup, foldButton, live]);
  append(wrap, [dot, dock]);

  var buttons = {};
  var specs = {};
  var openId = null;
  var dragging = null;
  var drag = null;
  var idleTimer = null;

  /** Apply the remembered position, or the default in the bottom-left corner. */
  var position = function () {
    var pos = settings.dockPos;
    if (pos && isFinite(pos.left) && isFinite(pos.top)) {
      wrap.style.left = clamp(pos.left, 6, Math.max(6, window.innerWidth - 80)) + "px";
      wrap.style.top = clamp(pos.top, 6, Math.max(6, window.innerHeight - 60)) + "px";
      wrap.style.right = "auto";
      wrap.style.bottom = "auto";
    } else {
      // Bottom-left: the controls sit under the sidebar, away from the composer
      // and from the reply that is still streaming.
      wrap.style.left = "18px";
      wrap.style.bottom = "22px";
      wrap.style.right = "auto";
      wrap.style.top = "auto";
    }
  };
  position();

  var clearIdle = function () {
    if (idleTimer !== null) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
  };

  /** Arm the fold-away timer; a no-op while collapsed or mid-drag. */
  var scheduleIdle = function () {
    clearIdle();
    idleTimer = setTimeout(function () {
      idleTimer = null;
      if (wrap.dataset.collapsed === "true") return;
      if (dragging !== null) return;
      if (drag !== null) return;
      if (hasOpenPopover()) return;
      setCollapsed(true);
    }, DOCK_IDLE_MS);
  };

  /**
   * Fold or unfold.
   * @param {boolean} next - true to collapse to the dot.
   * @param {{persist?: boolean}} [options] - `persist: false` skips the write,
   *   used while restoring the saved state during mount.
   */
  var setCollapsed = function (next, options) {
    var collapsed = next === true;
    wrap.dataset.collapsed = String(collapsed);
    if (collapsed) {
      closeAllPopovers();
      openId = null;
      clearIdle();
    } else {
      scheduleIdle();
    }
    if (options === undefined || options.persist !== false) {
      applySettings({ dockCollapsed: collapsed });
    }
  };

  var onPointerDown = function (event) {
    if (event.button !== 0) return;
    // A fresh press makes any pending swallow stale.
    //
    // The flag exists so the click a browser sends after a drag does not also
    // unfold a bar that was just moved. It was cleared only by the click it
    // belonged to — and a drag does not always produce one, so a single drag
    // could leave it set and swallow the *next* genuine press instead. That is
    // "I click and nothing happens", arriving one gesture late.
    swallowDotClick = false;
    // `.cy-btn` still never moves the bar: those have their own drag, for
    // reordering slots, and one press must not mean two things.
    //
    // The dot is different, and it used to be excluded alongside them. That was
    // wrong in a way you feel immediately: the dot is the *only* thing on screen
    // once the bar folds, so excluding it left the bar impossible to move in
    // exactly the state where moving it is the only thing you can do. It is a
    // button as well as a grip, so the same 4 px threshold the slots use
    // separates the two readings.
    if (event.target !== null && event.target.closest && event.target.closest(".cy-btn") !== null) return;
    // Measured from the *wrap*, which is the element the position is written to.
    //
    // This read `dock.getBoundingClientRect()` — `.cy-dock`, the pill inside the
    // wrap — and that was harmless only for as long as the bar could not be
    // dragged while folded. A folded `.cy-dock` is `display: none`, so its box is
    // 0×0 at the origin: the grab offset came out as the pointer's own
    // coordinates, `clientX - dx` cancelled to zero on the first move, and the
    // bar snapped to the top-left corner instead of following the pointer.
    var rect = wrap.getBoundingClientRect();
    dragging = {
      dx: event.clientX - rect.left,
      dy: event.clientY - rect.top,
      startX: event.clientX,
      startY: event.clientY,
      moved: false,
      // Whether the press began on the dot, so a release that never moved can
      // still be left to the button's own click.
      onDot: event.target !== null && event.target.closest
        ? event.target.closest(".cy-dot") !== null
        : false
    };
    wrap.dataset.dragging = "true";
    clearIdle();
    // Neither `setPointerCapture` nor `preventDefault` happens here, and both for
    // the same reason: they are parts of *dragging*, and a press is not a drag
    // until the threshold says so. Doing either at the press changes what the
    // browser does next — capture redirects the follow-up `click` to the wrap
    // instead of the dot, and cancelling the default suppresses it outright — so
    // the dot could be dragged but never unfolded. Both moved to the threshold.
  };

  var onPointerMove = function (event) {
    if (dragging === null) return;
    if (!dragging.moved) {
      var dx = event.clientX - dragging.startX;
      var dy = event.clientY - dragging.startY;
      // Below the threshold this is still a press on the dot, which means
      // "unfold". Moving the bar a pixel or two on the way would be a visible
      // wobble for a gesture that was never a drag.
      if (Math.sqrt(dx * dx + dy * dy) < DOCK_DRAG_THRESHOLD) return;
      dragging.moved = true;
      // Everything that belongs to a drag, here rather than at the press.
      //
      // `preventDefault` would otherwise take the follow-up `click` with it, and
      // capture would retarget that click to the wrap — so the dot, whose whole
      // job is to be clicked, would stop unfolding the moment it could be moved.
      if (typeof event.preventDefault === "function") event.preventDefault();
      if (typeof wrap.setPointerCapture === "function") {
        try {
          wrap.setPointerCapture(event.pointerId);
        } catch (error) {
          /* capture is optional */
        }
      }
    }
    var width = wrap.offsetWidth;
    var height = wrap.offsetHeight;
    var left = clamp(event.clientX - dragging.dx, 6, Math.max(6, window.innerWidth - width - 6));
    var top = clamp(event.clientY - dragging.dy, 6, Math.max(6, window.innerHeight - height - 6));
    wrap.style.left = Math.round(left) + "px";
    wrap.style.top = Math.round(top) + "px";
    wrap.style.right = "auto";
    wrap.style.bottom = "auto";
  };

  var onPointerUp = function () {
    if (dragging === null) return;
    var finished = dragging;
    dragging = null;
    delete wrap.dataset.dragging;
    if (!finished.moved) {
      // A press that never travelled. Nothing moved, so there is nothing to
      // persist, and the dot's own click still runs.
      scheduleIdle();
      return;
    }
    // A drag that started on the dot must not also unfold it on release. The
    // flag is cleared by the click it belongs to, so a drag cannot swallow the
    // *next* press as well.
    if (finished.onDot) swallowDotClick = true;
    var rect = wrap.getBoundingClientRect();
    applySettings({ dockPos: { left: Math.round(rect.left), top: Math.round(rect.top) } });
    repositionAllPopovers();
    scheduleIdle();
  };

  /** Set by a drag that began on the dot; cleared by the click it belongs to. */
  var swallowDotClick = false;

  var onPointerEnter = function () {
    // Reaching for the controls cancels a pending fold.
    if (wrap.dataset.collapsed === "false") scheduleIdle();
  };

  var onWindowResize = function () {
    position();
    repositionAllPopovers();
  };

  wrap.addEventListener("pointerdown", onPointerDown);
  wrap.addEventListener("pointerenter", onPointerEnter);
  window.addEventListener("pointermove", onPointerMove);
  window.addEventListener("pointerup", onPointerUp);
  window.addEventListener("pointercancel", onPointerUp);
  // The safety net for a released button drag.
  //
  // The button's own `pointerup` ends the gesture, but only when the release
  // happens *over the button*. Drag one and let go past its edge — which is what
  // a quick drag does — and that listener never fires, so the gap it drew stays
  // in the bar with nothing to remove it. Four of them had piled up in the dock
  // by the time this was noticed, and they read as empty pills among the icons.
  //
  // `onButtonPointerUp` is idle when no button drag is in progress, so calling
  // it from here costs a null check on every other release on the page.
  window.addEventListener("pointerup", function () { onButtonPointerUp(); });
  window.addEventListener("pointercancel", function () { onButtonPointerUp(); });
  window.addEventListener("resize", onWindowResize);

  /**
   * Say one line in the live region.
   *
   * Written through a timer rather than directly, and cleared first: a screen
   * reader announces a *change* to a live region, so writing the same message
   * twice in a row is silence. The clear and the write are separate tasks for
   * the same reason — the mutation observer behind `aria-live` has to see both.
   *
   * @param {string} message - what to announce.
   * @returns {void}
   */
  var announce = function (message) {
    live.textContent = "";
    setTimeout(function () {
      live.textContent = message;
    }, 0);
  };

  /**
   * Reorder a free slot, and remember it.
   * @param {string} id - the slot to move.
   * @param {number} step - `-1` for its left neighbour, `+1` for its right.
   * @returns {boolean} whether anything moved.
   */
  var moveSlot = function (id, step) {
    var accepted = resolveDockSplit(settings.dockFixed, settings.dockOrder, dockIds());
    var list = accepted.free.slice();
    var at = list.indexOf(id);
    if (at === -1) return false;
    var to = at + (step < 0 ? -1 : 1);
    if (to < 0 || to >= list.length) return false;
    var held = list[at];
    list[at] = list[to];
    list[to] = held;
    // Straight to the settings document, which is what re-renders the bar: one
    // write path, so a moved slot and a slot moved twice cannot disagree.
    applySettings({ dockOrder: list });
    announce(dockName(held) + " 已移到第 " + (to + 1) + " 位，共 " + list.length + " 个可排位置");
    return true;
  };

  /**
   * Move a free slot to an index in the free group, and remember it.
   * @param {string} id - the slot to move.
   * @param {number} index - its new index, clamped to the group.
   * @returns {boolean} whether anything moved.
   */
  var moveTo = function (id, index) {
    var accepted = resolveDockSplit(settings.dockFixed, settings.dockOrder, dockIds());
    var list = accepted.free.slice();
    var at = list.indexOf(id);
    if (at === -1) return false;
    var to = clamp(Math.round(index), 0, list.length - 1);
    if (to === at) return false;
    list.splice(at, 1);
    list.splice(to, 0, id);
    applySettings({ dockOrder: list });
    announce(dockName(id) + " 已移到第 " + (to + 1) + " 位，共 " + list.length + " 个可排位置");
    return true;
  };

  /**
   * Where the dragged button belongs, as an index into the *other* slots.
   *
   * `0` is "before all of them" and `candidates.length` is "after all of them",
   * so the value is a slot in the group as it would look with this button lifted
   * out — which is exactly the index `showGap` puts it back in.
   *
   * The answer is a count: how many of the other slots the button has been
   * carried past. Each one is counted when the button's own centre has reached
   * that slot's centre, which is the moment a person doing this by hand would say
   * the button is *there* rather than merely next to it. Counting, rather than
   * asking "which box is the pointer inside", is what makes both ends fall out of
   * the same rule: before every centre is `0`, past all of them is
   * `candidates.length`, with no comparison against a particular slot needed to
   * decide an answer about all of them.
   *
   * **It is the button that moves, not the pointer.** The pointer is wherever the
   * user grabbed the button, which is not its centre and not even a fixed offset
   * from it, so measuring the pointer against a slot edge puts the threshold
   * wherever the press happened to land. What is carried is the button: its box
   * at the moment of the press, translated by however far the pointer has since
   * travelled. That translation is the only part of this that the drag changes,
   * so the comparison is between two things the user can see — the button, and
   * the slot it is being carried towards.
   *
   * Because the answer is derived from where the button *is* rather than from how
   * it got there, the drag reads the same in both directions; a comparison
   * against the neighbouring slot is the version of this that works one way and
   * silently does nothing the other.
   *
   * The boxes are deliberately *not* measured live: as the button is carried
   * across its neighbours the DOM order changes under it, so a live measurement
   * of "which slot am I in" would be taken from a layout the drag itself had just
   * rearranged, and the insertion point would be able to chase its own tail.
   * `drag.candidates` is the snapshot taken once, at the threshold, and every
   * move is answered from it.
   *
   * A slot on another row is skipped rather than counted. The bar is one row, so
   * this only decides anything if a future skin wraps it — and a slot the button
   * is nowhere near is not one it has been carried past.
   *
   * @param {number} clientX - the pointer's horizontal position.
   * @param {number} clientY - the pointer's vertical position, for the row test.
   * @returns {number} the slot to insert at, in `[0, candidates.length]`.
   */
  var gapBefore = function (clientX, clientY) {
    // The button's centre as it is being carried: where it was when the press
    // started, moved by the distance the pointer has covered since. Taking the
    // movement rather than the pointer's own position is what keeps the answer
    // independent of where inside the button the user happened to press.
    var carriedCentre = drag.anchor.left + drag.anchor.width / 2 + (clientX - drag.startX);
    if (globalThis.__gapProbe) globalThis.__gapProbe(clientX, drag.startX, drag.anchor, drag.candidates);
    var passed = 0;
    for (var index = 0; index < drag.candidates.length; index += 1) {
      var box = drag.candidates[index].rect;
      // The carried button has *entered* this slot — its centre is past the
      // slot's left edge — rather than reached the slot's centre.
      //
      // Three rules were tried here before this one. `clientX <= box.right`
      // answered "before this slot" from anywhere inside it, including its far
      // edge, so a drag of one whole slot changed nothing. The slot's centre
      // fixed that but overshot: with a slot pitch of 40 and a button 30 wide,
      // the neighbours' centres are a full pitch apart, so a 30 px drag — which
      // is plainly far enough to have arrived next door — still counted as
      // nothing, and a gesture that visibly moved the button reordered nothing.
      // The slot's left edge is the reading the gesture actually has: the button
      // has left its own slot and arrived in the next.
      //
      // Measured against the carried centre rather than the pointer, so the
      // answer does not depend on where inside the button the press landed.
      if (clientY >= box.top && clientY <= box.bottom && carriedCentre >= box.left) {
        passed += 1;
      }
    }
    return passed;
  };

  /** The index of a node inside the free group's buttons, or -1. */
  var freeIndex = function (node) {
    var slots = queryAll(freeGroup, ".cy-btn");
    for (var index = 0; index < slots.length; index += 1) {
      if (slots[index] === node) return index;
    }
    return -1;
  };

  /** The free order the settings document currently resolves to. */
  var acceptedOrder = function () {
    return resolveDockSplit(settings.dockFixed, settings.dockOrder, dockIds()).free;
  };

  /** Remember the free group's current DOM order. */
  var persistFreeOrder = function () {
    var order = [];
    var slots = queryAll(freeGroup, ".cy-btn");
    for (var index = 0; index < slots.length; index += 1) {
      if (slots[index].dataset.id !== undefined) order.push(slots[index].dataset.id);
    }
    applySettings({ dockOrder: order });
  };

  var onButtonPointerDown = function (id, button, event) {
    if (event.button !== 0) return;
    // Same reasoning as the bar's: a drag that produced no click would otherwise
    // leave this set, and the next press on any slot would be swallowed.
    swallowClick = false;
    // A press that started on something else inside the button is not a grab.
    if (event.target !== null && event.target.closest && event.target.closest(".cy-btn") !== button) return;
    drag = {
      id: id,
      button: button,
      startX: event.clientX,
      startY: event.clientY,
      // The slot the button was in when the gesture started. Every crossing test
      // measures from here, so the threshold belongs to the slot rather than to
      // wherever inside the button the user happened to press.
      anchor: button.getBoundingClientRect(),
      moved: false,
      candidates: [],
      spacer: null,
      // The insertion point drawn last pass, so `showGap` can skip a redraw that
      // would produce the same picture. `-1` cannot collide with a real index.
      lastGap: -1
    };
    clearIdle();
  };

  var onButtonPointerMove = function (event) {
    if (drag === null) return;
    if (!drag.moved) {
      var dx = event.clientX - drag.startX;
      var dy = event.clientY - drag.startY;
      // The threshold, and the reason it exists: a press that opens a panel and a
      // press that starts a reorder begin with the identical pointerdown, and a
      // mouse on a real desk jitters a pixel or two between the two. Four pixels
      // is below deliberate movement and above hand tremor, so a click that
      // wobbled still opens the panel.
      if (Math.sqrt(dx * dx + dy * dy) < DOCK_DRAG_THRESHOLD) return;

      // Past the threshold: this is a drag, not a click. Everything below this
      // line happens once — the capture, the marker, the snapshot of the other
      // slots' boxes.
      drag.moved = true;
      if (typeof drag.button.setPointerCapture === "function") {
        try {
          drag.button.setPointerCapture(event.pointerId);
        } catch (error) {
          /* capture is optional */
        }
      }
      drag.button.dataset.dragging = "true";
      // The button's own drag must never also move the *bar*: the two gestures are
      // unrelated, and the wrapper's handler cannot see this one because it starts
      // on a `.cy-btn`. Cancelling here additionally stops the browser's own
      // text-selection drag from starting on top of it.
      if (typeof event.preventDefault === "function") event.preventDefault();

      drag.candidates = [];
      var slots = queryAll(freeGroup, ".cy-btn");
      for (var index = 0; index < slots.length; index += 1) {
        if (slots[index] === drag.button) continue;
        drag.candidates.push({ button: slots[index], rect: slots[index].getBoundingClientRect() });
      }
      drag.startIndex = freeIndex(drag.button);
    }

    // Re-answered on every move, not only on the first one past the threshold.
    //
    // The guard above used to read `if (drag === null || drag.moved) return;`,
    // which set `moved` once and then swallowed every subsequent move. The
    // insertion point was therefore computed exactly once — from the first
    // position that cleared four pixels, which is a few pixels from where the
    // press started and still inside the button's own slot. Carrying the button
    // across its neighbours then changed nothing at all, so a reorder was
    // impossible however far the drag went.
    showGap(gapBefore(event.clientX, event.clientY), drag.anchor);
  };
  /**
   * Draw the insertion point, with the dragged button inside it.
   *
   * This is the whole of the drag's feedback: the gap *is* where the button
   * already is, and because it already is there, the drop has nothing left to
   * decide. An earlier version kept the button in place and drew a separate
   * marker where it *would* land, which meant the drop and the preview were two
   * independent calculations — and they disagreed, in both directions, the
   * moment a drag crossed its own starting slot.
   *
   * The order is rebuilt in one pass rather than by moving the button and the gap
   * separately through the DOM. Two moves read well and are wrong whenever the
   * button's own slot is before its target: moving the gap first shifts the
   * button's index, and the second move puts the button back where it already
   * was, so the drag showed feedback and the drop reordered nothing.
   *
   * **`gap` is the index of the slot the button belongs in, among the *other*
   * slots — not among all of them.** The two differ by whether the button is
   * counted where it started, and conflating them moves the button one place the
   * wrong way, silently. `gapBefore` answers in the same terms, so the derivation
   * happens once, there.
   *
   * Only the nodes named by the snapshot are touched. Anything else that happens
   * to be in the group is left where it is, which is what keeps this independent
   * of whatever state the previous move left behind.
   *
   * @param {number} gap - the slot to insert at, from `gapBefore`.
   * @param {{width: number}} rect - the dragged button's box.
   * @returns {void}
   */
  var showGap = function (gap, rect) {
    // Nothing to redraw when the insertion point has not moved.
    //
    // This runs on every `pointermove`, and a real drag emits well over a
    // hundred of them while the slot under the pointer changes perhaps once or
    // twice. Each call rebuilt the whole group — four `appendChild` moves plus a
    // spacer reposition, every one of them forcing layout — for a gap that was
    // already drawn in the right place. That is where the drag's heaviness came
    // from, and it is the cheapest thing here to skip.
    if (drag.spacer !== null && drag.lastGap === gap) return;
    drag.lastGap = gap;

    var order = [];
    var next = null;
    for (var index = 0; index < drag.candidates.length; index += 1) {
      if (index === gap) {
        order.push(drag.button);
        next = drag.button;
      }
      order.push(drag.candidates[index].button);
    }
    // Past the last candidate, the button belongs at the end of the group.
    if (gap >= drag.candidates.length) {
      order.push(drag.button);
      next = drag.button;
    }
    for (var each = 0; each < order.length; each += 1) freeGroup.appendChild(order[each]);

    var spacer = drag.spacer;
    if (spacer === null) {
      spacer = el("div", { class: "cy-drop", dataset: { drop: "true" } });
      spacer.style.width = Math.round(rect.width) + "px";
      drag.spacer = spacer;
    }
    // The gap goes immediately before whatever is at the insertion point, which
    // is the button itself. `moveBefore` and not `appendChild`: this runs on
    // every move, so the gap has to be repositioned rather than only placed.
    moveBefore(freeGroup, spacer, next);
  };

  var onButtonPointerUp = function () {
    if (drag === null) return;
    var finished = drag;
    drag = null;
    if (!finished.moved) return;
    delete finished.button.dataset.dragging;
    if (finished.spacer !== null && finished.spacer.parentNode) finished.spacer.parentNode.removeChild(finished.spacer);

    var from = acceptedOrder().indexOf(finished.id);
    // The open panels are captured *before* the write, not read after it.
    // `persistFreeOrder` goes through `applySettings`, which notifies every
    // listener in the plugin; anything that closes a popover in response — the
    // idle pass folding the bar, say — would leave the stack empty and the sync
    // with nothing to sync. The panel is only read from, so a frame taken a
    // moment earlier is still the right one.
    var watching = popoverStack.slice();
    persistFreeOrder();
    // The panel may be open on top of the bar, showing the arrangement this
    // gesture just changed.
    syncOpenPanels(watching);
    var landed = acceptedOrder();
    var to = landed.indexOf(finished.id);
    if (from !== -1 && to !== -1 && from !== to) {
      announce(dockName(finished.id) + " 已移到第 " + (to + 1) + " 位，共 " + landed.length + " 个可排位置");
    }
    // The drop ends the gesture. The click that follows the pointerup of a
    // button that has just moved is not a press the user ever made, so the next
    // one is swallowed — otherwise every reorder would also open a panel.
    swallowClick = true;
    scheduleIdle();
  };

  /** Set by the end of a drag; cleared by the click it belongs to. */
  var swallowClick = false;

  var onButtonKeyDown = function (id, event) {
    if (event.altKey !== true) return;
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    // The keyboard path is a swap with the neighbour, not a pick-up/drop model:
    // a whole drag-and-drop state machine reachable only by arrow keys is a lot
    // of machinery for an arrangement with four movable slots in it.
    var moved = moveSlot(id, event.key === "ArrowLeft" ? -1 : 1);
    if (moved && typeof event.preventDefault === "function") event.preventDefault();
  };

  /**
   * Add one button.
   *
   * The bar is icons. The word stays inside the button as a `cy-btn-label` span
   * and is only unclipped on hover, on focus, or while the button's own panel is
   * open — which is what makes six slots fit where six English words did not.
   *
   * **The span is what `button.textContent` returns**, deliberately. It was the
   * label the button rendered before icons existed, and roughly twenty tests
   * find their button with `.find(n => n.textContent === 'Scene')`. Drawing the
   * icon as well cannot push it out of the tree: an `<svg>` carries no text. So
   * the word is the accessible name *and* the test handle, and the CSS hides it
   * with `clip-path` rather than `display: none` so it stays in the
   * accessibility tree where that name is read from.
   *
   * @param {{id: string, label: string, title: string, onClick: Function}} spec - the button.
   * @returns {HTMLButtonElement} the button.
   */
  var addButton = function (spec) {
    specs[spec.id] = spec;
    var icon = dockIcon(spec.id);
    var button = el("button", {
      type: "button",
      class: "cy-btn",
      title: spec.title,
      // The drawn icon replaced the word, so without this the button's name
      // would be the word `Sound` — which is not a translation of it. The label
      // span is in the accessibility tree too, but a button with both a name and
      // hidden text is read twice.
      "aria-label": spec.label,
      dataset: { id: spec.id },
      // `pointerdown` is where a drag begins, and it has to stop here: with the
      // browser's default image/text drag the browser starts its own gesture on
      // top of ours.
      onpointerdown: function (event) { onButtonPointerDown(spec.id, button, event); },
      onpointermove: onButtonPointerMove,
      onpointerup: onButtonPointerUp,
      onkeydown: function (event) { onButtonKeyDown(spec.id, event); },
      onclick: function () {
        // A press that turned into a reorder is not also a press that opens the
        // panel. The two are the same gesture up to the 4 px threshold, and only
        // one of them is what the user meant.
        if (swallowClick) {
          swallowClick = false;
          return;
        }
        spec.onClick(button);
        scheduleIdle();
      }
    });
    if (icon !== null) {
      button.appendChild(icon);
      button.appendChild(el("span", { class: "cy-btn-label", text: spec.label }));
    } else {
      // A slot with no icon is one this build does not draw. Showing its word is
      // the only readable option, and it is better than an empty button.
      button.textContent = spec.label;
    }
    buttons[spec.id] = button;
    return button;
  };

  /**
   * Render the bar from the fixed/free split.
   *
   * Every button is re-appended rather than moved conditionally. `appendChild`
   * on a node that is already in the right place is a no-op in effect, and a
   * render that has to be told *what changed* is the thing that goes stale the
   * first time a new way of changing it appears.
   *
   * A split that names a slot this build has no button for is skipped rather
   * than invented here — `resolveDockSplit` has already replaced any such
   * document wholesale, so reaching that branch means the registry and the
   * settings declaration disagree, which is a build error rather than a state.
   *
   * @param {{fixed: string[], free: string[]}} split - the accepted split.
   * @returns {void}
   */
  var renderDock = function (split) {
    for (var index = 0; index < split.fixed.length; index += 1) {
      var fixedButton = buttons[split.fixed[index]];
      if (fixedButton !== undefined) fixedGroup.appendChild(fixedButton);
    }
    for (var free = 0; free < split.free.length; free += 1) {
      var freeButton = buttons[split.free[free]];
      if (freeButton !== undefined) freeGroup.appendChild(freeButton);
    }
    // A rule with nothing on one side of it marks a boundary that is not there.
    var bothSided = split.fixed.length > 0 && split.free.length > 0;
    divider.dataset.hidden = String(!bothSided);
    // The lit state is applied on every render rather than only when it changes,
    // so a button keeps its meaning after a reorder without anyone having to
    // remember to re-apply it. `aria-pressed` says the same thing aloud: a toggle
    // that looks pressed but does not say so is worse than one that never lights.
    setButtonOn(buttons.sound, settings.sound === true);
    setButtonOn(buttons.particles, settings.particles !== "off");
    setButtonOn(buttons.music, settings.musicOn === true);
  };

  /** Set one button's lit state, in both places it is expressed. */
  var setButtonOn = function (button, value) {
    if (button === undefined) return;
    button.setAttribute("data-on", String(value === true));
    button.setAttribute("aria-pressed", String(value === true));
  };

  return {
    root: wrap,
    addButton: addButton,
    renderDock: renderDock,
    /**
     * The split the settings document resolves to, repaired if it has to be.
     * Exposed so the mount path can write the accepted answer back once, rather
     * than every reader doing its own repair and disagreeing.
     */
    resolve: function () {
      return resolveDockSplit(settings.dockFixed, settings.dockOrder, dockIds());
    },
    moveSlot: moveSlot,
    moveTo: moveTo,
    announce: announce,
    /**
     * The collapsed dot's portrait controller.
     *
     * Returned rather than applied here: `createDock` runs before the settings
     * document has been read, so the first `apply` has to come from the mount
     * path that owns the settings.
     */
    avatar: avatar,
    buttonFor: function (id) {
      return buttons[id] === undefined ? null : buttons[id];
    },
    setOn: function (id, on) {
      if (buttons[id] !== undefined) setButtonOn(buttons[id], on);
    },
    /**
     * Toggle a popover for a button, remembering which one is open.
     *
     * `build` returns the node; it may carry an `__onMounted` hook, which runs
     * once the node is in the document, and an `__onClose` hook, which runs when
     * it is removed. The pair exists so a panel can start and stop work that is
     * only worth doing while it is visible — the Now Playing block polls the host
     * while it is open and must not keep doing so afterwards.
     */
    togglePopover: function (id, anchor, build) {
      if (openId === id) {
        closeAllPopovers();
        openId = null;
        scheduleIdle();
        return null;
      }
      closeAllPopovers();
      // Re-read the host's language before building. This host sets `lang` after
      // the plugin's parts have run, so a single read at load can capture the
      // placeholder and leave every panel in the wrong language. Doing it here —
      // once per build, not per string — also keeps one panel uniform.
      refreshLanguage();
      var node = build();
      openPopover(node, anchor, {
        onClose: function () {
          if (openId === id) openId = null;
          scheduleIdle();
          if (node !== null && node !== undefined && typeof node.__onClose === "function") {
            try {
              node.__onClose();
            } catch (error) {
              console.error(PLUGIN_ID + ": popover close hook failed", error);
            }
          }
        },
        onMounted: node !== null && node !== undefined ? node.__onMounted : null
      });
      openId = id;
      clearIdle();
      return node;
    },
    isOpen: function (id) {
      return openId === id;
    },
    markClosed: function () {
      openId = null;
      scheduleIdle();
    },
    closeAll: function () {
      closeAllPopovers();
      openId = null;
      scheduleIdle();
    },
    setCollapsed: setCollapsed,
    isCollapsed: function () {
      return wrap.dataset.collapsed === "true";
    },
    setVisible: function (visible) {
      wrap.style.display = visible ? "" : "none";
    },
    destroy: function () {
      clearIdle();
      closeAllPopovers();
      wrap.removeEventListener("pointerdown", onPointerDown);
      wrap.removeEventListener("pointerenter", onPointerEnter);
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerUp);
      window.removeEventListener("resize", onWindowResize);
      if (wrap.parentNode) wrap.parentNode.removeChild(wrap);
    }
  };
}

/**
 * Track which popover is open from outside the dock, so the dock can clear its
 * remembered id when a popover closes for another reason.
 * @param {object} dock - the dock API.
 * @returns {() => void} a disposer removing the listener.
 */
function wirePopoverTracking(dock) {
  var onKeyDown = function (event) {
    if (event.key !== "Escape") return;
    if (!hasOpenPopover()) return;
    closeTopPopover();
    if (!hasOpenPopover()) dock.markClosed();
  };
  document.addEventListener("keydown", onKeyDown, true);
  return function () {
    document.removeEventListener("keydown", onKeyDown, true);
  };
}
