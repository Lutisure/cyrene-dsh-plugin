/**
 * Cinematic extras: the opening animation and the emote easter egg.
 *
 * Both degrade to nothing when the corresponding media is absent, which is the
 * expected state for an install that ships no GIFs. Nothing here hard-fails on
 * an empty directory — the reference plugin's build exits non-zero when its GIF
 * folder is empty, which makes an asset-less install impossible.
 */

/** Emote label → the words that trigger it. Filenames are the contract. */
var EMOTE_TRIGGERS = [
  { label: "开心", words: ["谢谢", "太好了", "太棒", "厉害", "绝了", "感谢", "辛苦"] },
  { label: "得意", words: ["搞定", "完成", "成功了", "已解决", "通过了"] },
  { label: "没错", words: ["没错", "正是", "确实", "对的", "就是这样"] },
  { label: "期待", words: ["发我", "提供", "给我", "发一下", "贴一下"] },
  { label: "疑惑", words: ["确认一下", "要我", "可以吗", "是否", "确定吗"] }
];

/** Sending this word replays the opening animation. */
var BOOT_KEYWORDS = ["SAM", "昔涟", "CYRENE"];

/**
 * How long the opening animation stays up when it is not a GIF.
 *
 * Must cover the bundled clip or it is cut off mid-beat: that animation is 4.2 s
 * (`tools/render-boot.py` → `DURATION`), plus the ~800 ms reveal. If you
 * re-render it longer, raise this too.
 */
var BOOT_FALLBACK_MS = 5200;

/**
 * How long a GIF opening stays up.
 *
 * A GIF's own length is not knowable from here, so it gets a longer budget
 * rather than none. The earlier code set no timer at all for a GIF, which left
 * a looping animation covering the whole window until it was clicked.
 */
var BOOT_GIF_MS = 6000;

/**
 * Build the opening overlay.
 * @param {object[]} entries - boot animation entries, newest contract first.
 * @param {{onFinished?: () => void}} [hooks] - notified once it closes.
 * @returns {{show: () => void, dispose: () => void} | null} the overlay, or null when nothing to show.
 */
function createBootOverlay(entries, hooks) {
  if (!Array.isArray(entries) || entries.length === 0) return null;

  var entry = entries[0];
  var isGif = /\.gif$/iu.test(entry.name);
  // The style is carried through verbatim, because the stylesheet keys off it —
  // `reveal` floats the asset on a flat scrim, `cinema` fills the screen with
  // it, `card` boxes it for a small upload. Collapsing the value into a boolean
  // here would make every non-card style render as `cinema` and leave the
  // `reveal` rules dead.
  var style = hooks !== undefined && typeof hooks.style === "string" ? hooks.style : "reveal";
  var unchromed = style !== "card";
  var image = el("img", { src: entry.url, alt: entry.label });
  var body = [image];
  if (!unchromed) body.push(el("div", { class: "cy-boot-title", text: "C Y R E N E" }));
  body.push(el("div", { class: "cy-boot-skip", text: "点击任意处跳过" }));
  var root = el("div", {
    class: "cy-boot",
    dataset: { plugin: PLUGIN_ID, style: style },
    onclick: function () { dismiss(); }
  }, [
    el("div", { class: "cy-boot-frame" }, body)
  ]);

  var timer = null;
  var finished = false;

  /** Fade out and remove. */
  var dismiss = function () {
    if (finished) return;
    finished = true;
    if (timer !== null) clearTimeout(timer);
    root.dataset.showing = "false";
    setTimeout(function () {
      if (root.parentNode) root.parentNode.removeChild(root);
    }, 820);
    if (hooks && typeof hooks.onFinished === "function") hooks.onFinished();
  };

  return {
    show: function () {
      if (prefersReducedMotion()) return;
      finished = false;
      document.body.appendChild(root);
      // Force a frame so the fade-in transition actually runs.
      void root.offsetWidth;
      root.dataset.showing = "true";
      // Every boot asset gets a timer. A GIF cannot report its own length, so it
      // gets a longer budget instead of none.
      timer = setTimeout(dismiss, isGif ? BOOT_GIF_MS : BOOT_FALLBACK_MS);
    },
    dispose: function () {
      if (timer !== null) clearTimeout(timer);
      if (root.parentNode) root.parentNode.removeChild(root);
    }
  };
}

/**
 * Watch the transcript for trigger words and show the matching emote.
 *
 * Entries are read through `entriesOf` on every evaluation rather than
 * captured once, so an emote uploaded mid-session starts working without a
 * reload. Text is matched against the emote filenames, so dropping
 * `GIF/emotes/开心.gif` into place is all it takes to enable that reaction.
 *
 * @param {() => object[]} entriesOf - returns the current emote entries.
 * @param {() => void} [onKeyword] - called when a boot keyword is sent.
 * @returns {{dispose: () => void}} the watcher.
 */
function createEmoteWatcher(entriesOf, onKeyword) {
  /** Read the current emote entries defensively. */
  var readEntries = function () {
    try {
      var list = typeof entriesOf === "function" ? entriesOf() : entriesOf;
      return Array.isArray(list) ? list : [];
    } catch (error) {
      return [];
    }
  };

  var buffer = "";
  var timer = null;
  var shownThisTurn = false;
  var current = null;

  /** Remove the visible emote. */
  var clearEmote = function () {
    if (current === null) return;
    var node = current;
    current = null;
    node.dataset.leaving = "true";
    setTimeout(function () {
      if (node.parentNode) node.parentNode.removeChild(node);
    }, 340);
  };

  /** Show one emote. */
  var showEmote = function (entry) {
    clearEmote();
    var node = el("img", {
      class: "cy-emote",
      src: entry.url,
      alt: entry.label,
      dataset: { plugin: PLUGIN_ID }
    });
    current = node;
    document.body.appendChild(node);
    setTimeout(function () {
      if (current === node) clearEmote();
    }, 5200);
  };

  /** Decide what the accumulated text deserves. */
  var evaluate = function () {
    var text = buffer;
    buffer = "";
    if (text === "") return;

    var trimmed = text.trim();
    if (trimmed.length <= 24 && typeof onKeyword === "function") {
      for (var index = 0; index < BOOT_KEYWORDS.length; index += 1) {
        if (trimmed.toUpperCase().indexOf(BOOT_KEYWORDS[index].toUpperCase()) !== -1) {
          onKeyword();
          return;
        }
      }
    }

    if (shownThisTurn) return;

    var entries = readEntries();
    if (entries.length === 0) return;
    var byLabel = {};
    for (var index = 0; index < entries.length; index += 1) {
      byLabel[entries[index].label] = entries[index];
    }

    for (var rule = 0; rule < EMOTE_TRIGGERS.length; rule += 1) {
      var trigger = EMOTE_TRIGGERS[rule];
      var entry = byLabel[trigger.label];
      if (entry === undefined) continue;
      for (var word = 0; word < trigger.words.length; word += 1) {
        if (text.indexOf(trigger.words[word]) !== -1) {
          shownThisTurn = true;
          showEmote(entry);
          return;
        }
      }
    }
  };

  /** Collect text from added nodes, ignoring the plugin's own DOM. */
  var harvest = function (mutations) {
    var touched = false;
    for (var index = 0; index < mutations.length; index += 1) {
      var added = mutations[index].addedNodes;
      for (var node = 0; node < added.length; node += 1) {
        var element = added[node];
        if (element.nodeType === 1) {
          if (element.dataset && element.dataset.plugin !== undefined) continue;
          if (element.closest && element.closest("[data-plugin]") !== null) continue;
          buffer += " " + (element.textContent || "");
          touched = true;
        } else if (element.nodeType === 3) {
          buffer += " " + (element.nodeValue || "");
          touched = true;
        }
      }
    }
    if (!touched) return;
    if (buffer.length > 6000) buffer = buffer.slice(-6000);
    if (timer !== null) clearTimeout(timer);
    // Wait for the turn to stop streaming before judging it.
    timer = setTimeout(function () {
      timer = null;
      evaluate();
      shownThisTurn = false;
    }, 1200);
  };

  var observer = new MutationObserver(harvest);
  observer.observe(document.body, { childList: true, subtree: true });

  return {
    dispose: function () {
      observer.disconnect();
      if (timer !== null) clearTimeout(timer);
      clearEmote();
    }
  };
}
