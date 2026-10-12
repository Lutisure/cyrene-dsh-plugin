/**
 * The celebration: she appears just below the reply that finished.
 *
 * ## The signal
 *
 * Not the DOM, and not a guess. The session controller relays the host's running
 * bit as a remote event:
 *
 *     ctx.remote.$on('api-session/status', (sessionId, running) => { … });
 *
 * `running` going **true → false** is a turn ending. Watching for the edge rather
 * than the value matters: the event also fires for sessions that were never
 * running, and reacting to `running === false` alone would fire on every session
 * the controller learns about.
 *
 * ## Where it goes
 *
 * In the transcript, after the last node — not pinned to a corner. The chat
 * exposes no slot for that: `conversation.chat.node` is keyed by entry kind and
 * exists so a plugin can render a *new kind* of node, not so it can append to an
 * existing one. So this anchors to the transcript directly.
 *
 * It anchors on **`data-chat-node-key`**, not on a class name. The chat's own CSS
 * classes are hashed per build (`xz4KEq_flowItem`), so a class-based selector
 * breaks on the next release; the `data-chat-*` attributes are there precisely to
 * be addressed from outside. If none is found — a different surface, a future
 * layout — it falls back to the corner rather than not appearing at all.
 *
 * ## Playing it once and holding the last frame
 *
 * A GIF loops, and the count is baked into the file, so an `<img>` cannot be told
 * to stop. The reliable way to end on the last frame is to *have* the last frame
 * as its own still and swap to it once the animation's own duration has elapsed.
 * Both files and the duration come from the build, so replacing the artwork needs
 * no code change.
 *
 * The animation plays at its own pace — no slot, no scaling, no dropped frames —
 * and the still then rests for `CELEBRATE_HOLD_MS` before the fade. A fixed rest
 * rather than "however much is left of N seconds": with a cap, an animation longer
 * than the cap gets no rest at all and snaps straight into the fade, which loses
 * the very thing the rest is for.
 */

/** How long the last frame rests before the fade begins. */
var CELEBRATE_HOLD_MS = 700;

/** The overlay element, or null when it is not mounted. */
var celebrateNode = null;
var celebrateTimer = null;
var celebrateFadeTimer = null;

/** Re-inserts the node if the transcript re-renders underneath it. */
var celebrateGuard = null;

/** The session whose running bit is currently true, per the host stream. */
var runningSessions = {};

/**
 * The transcript's last node, or null when there is none to anchor to.
 *
 * The last match in document order is the bottom of the conversation. Collected
 * with `querySelectorAll` rather than a `:last-of-type` selector because the
 * attribute sits on sibling wrappers whose element type varies with node kind.
 *
 * @returns {Element|null} the node to insert after.
 */
function transcriptTail() {
  var nodes = document.querySelectorAll("[data-chat-node-key]");
  if (nodes.length === 0) return null;
  var last = nodes[nodes.length - 1];
  // A node with no parent cannot be inserted after; treated as absent.
  return last.parentNode === null ? null : last;
}

/**
 * Place the overlay: in the transcript when there is one, in the corner when not.
 *
 * @param {HTMLElement} node - the overlay.
 * @returns {boolean} true when it was anchored to the transcript.
 */
function placeCelebrate(node) {
  var tail = transcriptTail();
  if (tail === null) {
    node.dataset.anchor = "corner";
    if (node.parentNode !== document.body) document.body.appendChild(node);
    return false;
  }
  node.dataset.anchor = "transcript";
  var parent = tail.parentNode;
  // `nextSibling` may be null, which `insertBefore` reads as "append" — correct
  // when the finished reply is the last child.
  if (node.parentNode !== parent || node.previousSibling !== tail) {
    parent.insertBefore(node, tail.nextSibling);
  }
  return true;
}

/**
 * Build the overlay element.
 * @returns {HTMLElement} the node, detached.
 */
function buildCelebrate() {
  var img = el("img", {
    class: "cy-celebrate-art",
    alt: "",
    // Decorative, and announced twice otherwise: the pet already carries her, and
    // a screen reader saying "image" after every turn is noise.
    "aria-hidden": "true",
    draggable: "false"
  });
  img.src = CELEBRATE.art;
  var root = el("div", { class: "cy-celebrate", dataset: { plugin: PLUGIN_ID } }, [img]);
  root.__art = img;
  return root;
}

/**
 * Stop watching for the transcript re-rendering under the overlay.
 * @returns {void}
 */
function releaseGuard() {
  if (celebrateGuard !== null) {
    celebrateGuard.disconnect();
    celebrateGuard = null;
  }
}

/**
 * Play the celebration once.
 *
 * Restarting mid-flight is deliberate: two turns finishing close together should
 * read as two events, so the animation rewinds rather than being ignored.
 *
 * @returns {void}
 */
function playCelebrate() {
  if (CELEBRATE.art === null || CELEBRATE.art === "") return;

  if (celebrateNode === null) celebrateNode = buildCelebrate();

  if (celebrateTimer !== null) clearTimeout(celebrateTimer);
  if (celebrateFadeTimer !== null) clearTimeout(celebrateFadeTimer);
  releaseGuard();

  var node = celebrateNode;
  var art = node.__art;

  // Rewind: assigning the same src is a no-op, so clear it first. Without this the
  // second and later turns would show the still and never animate.
  art.src = "";
  art.src = CELEBRATE.art;
  node.dataset.showing = "true";
  node.dataset.holding = "false";

  placeCelebrate(node);

  // React re-renders the flow when the next turn starts, which would take the node
  // with it and leave a half-faded flourish behind. Cheaper to re-insert than to
  // explain.
  if (typeof MutationObserver === "function") {
    celebrateGuard = new MutationObserver(function () {
      if (celebrateNode === null || celebrateNode.dataset.showing !== "true") return;
      if (celebrateNode.parentNode === null) placeCelebrate(celebrateNode);
    });
    celebrateGuard.observe(document.body, { childList: true, subtree: true });
  }

  var animation = CELEBRATE.ms > 0 ? CELEBRATE.ms : 0;
  var hold = CELEBRATE_HOLD_MS;

  // Swap to the still before the fade, so the animation is never cut off.
  celebrateTimer = setTimeout(function () {
    celebrateTimer = null;
    if (celebrateNode === null) return;
    if (CELEBRATE.last !== null && CELEBRATE.last !== "") {
      art.src = CELEBRATE.last;
      node.dataset.holding = "true";
    }
    celebrateFadeTimer = setTimeout(function () {
      celebrateFadeTimer = null;
      releaseGuard();
      if (celebrateNode !== null) celebrateNode.dataset.showing = "false";
    }, hold);
  }, animation);
}

/**
 * Watch the session running bit and celebrate each falling edge.
 *
 * `remote` is declared in the epilogue's `inject` list. There is no client-side
 * `ctx.inject` — that is a host-only API, and reaching for it here threw and took
 * the entire theme down with it. Declaring the dependency is the only mechanism
 * the browser half has, and `remote` is as fundamental to this app as `theme`.
 *
 * @param {object} ctx - the plugin context, with `remote` already resolved.
 * @param {(fn: () => void) => void} track - registers a disposer.
 * @returns {void}
 */
function mountCelebrate(ctx, track) {
  var remotes = ctx.remote;
  if (remotes === null || remotes === void 0 || typeof remotes.$on !== "function") return;

  var off = remotes.$on("api-session/status", function (sessionId, running) {
    var was = runningSessions[sessionId] === true;
    if (running === true) {
      runningSessions[sessionId] = true;
      return;
    }
    delete runningSessions[sessionId];
    // The falling edge only. Without this the first status event for every session
    // the controller learns about would set off the animation.
    if (was) playCelebrate();
  });

  track(function () {
    if (typeof off === "function") off();
    if (celebrateTimer !== null) clearTimeout(celebrateTimer);
    if (celebrateFadeTimer !== null) clearTimeout(celebrateFadeTimer);
    celebrateTimer = null;
    celebrateFadeTimer = null;
    releaseGuard();
    if (celebrateNode !== null) {
      if (celebrateNode.parentNode !== null) celebrateNode.parentNode.removeChild(celebrateNode);
      celebrateNode = null;
    }
  });
}
