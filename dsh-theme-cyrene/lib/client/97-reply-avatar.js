/**
 * Reply avatar — a portrait leading each of her answers.
 *
 * ## Where it attaches
 *
 * Not to a class name. The conversation's own classes are CSS-module hashes
 * (`xz4KEq_root`), which are regenerated on every host build — an avatar hung on
 * one would disappear one morning with no error and nothing in this repo to
 * blame. The host also publishes a semantic layer, and that is what this uses:
 *
 *   `data-chat-flow-kind="assistant-step"` — one of her replies, and the thing
 *   the avatar is meant to introduce.
 *
 * `data-chat-flow-kind` also carries `user`, `turn-process`, `tool-call` and
 * `turn-tail`, so the same hook distinguishes them. Only `assistant-step` is
 * decorated: a portrait next to the reader's own words says nothing, and next to
 * a tool call it would say the wrong thing.
 *
 * ## Why absolute, not flowed
 *
 * The portrait sits in the gutter to the left of the reply, positioned rather
 * than inserted into the flow. Inserting it would change the text column's
 * measure — her answer would be narrower than the reader's question directly
 * above it, which reads as a mistake rather than as a design.
 *
 * ## Why the observer is cheap
 *
 * The conversation re-renders continuously while a reply streams. A naive
 * observer would re-scan the whole document on every token. This one batches
 * through `requestAnimationFrame`, scans only for the selector, and marks every
 * node it has touched — so a pass over a long conversation costs one attribute
 * read per node and no work at all after the first.
 */

/** Set on a node once it has a portrait, so a re-scan is idempotent. */
var REPLY_AVATAR_MARK = "cyreneReplyAvatar";

/** One of her replies. See the note above for why this hook and not a class. */
var REPLY_SELECTOR = '[data-chat-flow-kind="assistant-step"]';

/** The default edge, in px. Sits between the dock portrait and a favicon. */
var REPLY_AVATAR_SIZE = 32;

/**
 * This node's own portrait, or null.
 *
 * The host nests a reply inside a reply, so a plain descendant search would find
 * a nested one and remove the wrong image. Checking the parent is the direct way
 * to say "mine, not a child's" without needing a `:scope` selector.
 *
 * @param {HTMLElement} node - a reply node.
 * @returns {HTMLElement|null} its own portrait.
 */
function ownAvatar(node) {
  var found = node.querySelector(".cy-reply-avatar");
  return found !== null && found.parentNode === node ? found : null;
}

/**
 * Stylesheet for the portrait and the stage it floats over.
 *
 * @returns {string} the CSS.
 */
function replyAvatarCSS() {
  return [
    "/* cyrene: reply avatar */",
    // The anchor. `position: relative` on a host element is a real change to it,
    // but a contained one: it establishes a box and sets nothing else, so the
    // host's own layout inside is untouched.
    REPLY_SELECTOR + " { position: relative; }",
    ".cy-reply-avatar {",
    "  position: absolute;",
    "  left: calc(-1 * (" + REPLY_AVATAR_SIZE + "px + 12px));",
    "  top: 0;",
    "  width: " + REPLY_AVATAR_SIZE + "px;",
    "  height: " + REPLY_AVATAR_SIZE + "px;",
    "  border-radius: 50%;",
    "  object-fit: cover;",
    "  object-position: 50% 22%;",
    "  pointer-events: none;",
    "  user-select: none;",
    // The ring reads as a portrait rather than as a stray image dropped into the
    // margin, and the shared shadow keeps it on the same material as the rest of
    // the floating layer.
    "  box-shadow: 0 0 0 1px " + tint(THEME.pink, 0.30) + ", 0 4px 14px rgba(0,0,0,0.40);",
    "  background: " + tint(THEME.surfaceHigh, 0.92) + ";",
    "  animation: cy-reply-avatar-in 260ms cubic-bezier(0.32, 0.72, 0, 1) both;",
    "}",
    "@keyframes cy-reply-avatar-in {",
    "  from { opacity: 0; transform: translateY(-3px) scale(0.92); }",
    "  to { opacity: 1; transform: none; }",
    "}",
    // The gutter is not wide enough on a narrow window, and a portrait clipped by
    // the viewport edge is worse than no portrait. Below this the reply simply
    // goes without one.
    "@media (max-width: 900px) { .cy-reply-avatar { display: none; } }",
    // Motion is already a preference here; the entrance is decoration and has
    // nothing to say to a reader who has asked for still frames.
    "@media (prefers-reduced-motion: reduce) { .cy-reply-avatar { animation: none; } }"
  ].join("\n");
}

/**
 * Create the reply-avatar layer.
 *
 * @returns {{apply: (settings: object) => void, dispose: () => void}} the layer.
 */
function createReplyAvatarLayer() {
  var unmount = mountStyle(replyAvatarCSS(), "reply-avatar");
  var observer = null;
  var queued = false;
  var url = "";
  var wanted = false;

  /** Attach a portrait to every reply that does not have one yet. */
  var decorate = function () {
    if (!wanted || url === "") return;
    var nodes = document.querySelectorAll(REPLY_SELECTOR);
    for (var index = 0; index < nodes.length; index += 1) {
      var node = nodes[index];
      if (node.getAttribute(REPLY_AVATAR_MARK) === url) continue;
      var existing = ownAvatar(node);
      if (existing !== null) node.removeChild(existing);
      var image = el("img", {
        class: "cy-reply-avatar",
        src: url,
        alt: "",
        draggable: "false"
      });
      // `insertBefore(firstChild)` rather than `prepend`: the same thing, on an
      // API that every DOM — including the one the test harness builds — already
      // has. A portrait is the first thing in the block, ahead of the reply.
      node.insertBefore(image, node.firstChild);
      node.setAttribute(REPLY_AVATAR_MARK, url);
    }
  };

  /** Take every portrait back off. */
  var strip = function () {
    var nodes = document.querySelectorAll("[" + REPLY_AVATAR_MARK + "]");
    for (var index = 0; index < nodes.length; index += 1) {
      var node = nodes[index];
      var image = ownAvatar(node);
      if (image !== null) node.removeChild(image);
      node.removeAttribute(REPLY_AVATAR_MARK);
    }
  };

  /**
   * Run one pass, at most once per frame.
   *
   * A streaming reply mutates the conversation many times a second; without this
   * the scan would run on every one of those mutations.
   */
  var schedule = function () {
    if (queued) return;
    queued = true;
    var run = function () {
      queued = false;
      decorate();
    };
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(run);
    else setTimeout(run, 16);
  };

  return {
    /**
     * Apply a settings document.
     * @param {object} next - the settings document.
     */
    apply: function (next) {
      var on = next.replyAvatar !== false;
      var resolved = on ? avatarURL(next) : "";
      if (resolved === url && on === wanted) return;
      var wasOn = wanted;
      wanted = on;
      url = resolved;

      if (!on) {
        strip();
      } else if (wasOn && url === "") {
        // Only the portrait changed, and to nothing.
        strip();
      } else {
        // A new portrait has to replace the old one, so everything is re-marked.
        strip();
        decorate();
      }
      schedule();
    },
    /** Read the current portrait back, for tests and for the panel's preview. */
    url: function () {
      return url;
    },
    dispose: function () {
      if (observer !== null) observer.disconnect();
      observer = null;
      strip();
      unmount();
    },
    /** Start watching. Called once, after the first `apply`. */
    start: function () {
      if (observer !== null) return;
      if (typeof MutationObserver !== "function") return;
      observer = new MutationObserver(schedule);
      observer.observe(document.body, { childList: true, subtree: true });
      schedule();
    }
  };
}
