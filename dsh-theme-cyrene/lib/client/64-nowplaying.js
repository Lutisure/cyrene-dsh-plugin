/**
 * Now Playing: the system media session, shown and driven.
 *
 * This is a different thing from the theme's own music player. That one plays
 * files out of `music/` through an `<audio>` element the plugin owns. This one
 * talks to whatever the *system* is playing — QQ音乐, a browser tab, anything
 * that registers with GSMTC — through the host route in `lib/media.js`.
 *
 * ## Polling
 *
 * The host caches a reading for just under two seconds, so polling faster would
 * only burn a request per tick for the same answer. The playhead is advanced
 * locally between polls and snapped back to the host's value whenever a fresh
 * reading arrives, which is what keeps the bar moving smoothly without a process
 * spawn per frame.
 *
 * Polling only runs while the panel is open: there is no reason to ask the
 * system about playback when nobody is looking at the answer.
 */

/** How often the host is asked, in milliseconds. Matched to the host's cache. */
var NOW_PLAYING_INTERVAL = 2000;

/** Ask the host for the current session. */
function fetchNowPlaying(fresh) {
  return api("/media" + (fresh === true ? "?fresh=1" : "")).then(function (payload) {
    return payload;
  }).catch(function (error) {
    // A host without PowerShell, or a session that vanished: both are "nothing
    // to show". The reason is kept so the panel can say why rather than looking
    // like it simply has no data.
    return { ok: false, media: null, reason: String(error && error.message ? error.message : error) };
  });
}

/** Send a transport action. */
function sendMediaAction(action) {
  return api("/media", { method: "POST", body: { action: action } }).catch(function (error) {
    return { ok: false, accepted: false, reason: String(error && error.message ? error.message : error) };
  });
}

/**
 * Build the Now Playing block.
 *
 * @param {object} hooks - `{ onActivity: () => void }`, called after a control so
 *   the surrounding player can avoid fighting over the same session.
 * @returns {{node: HTMLElement, start: () => void, stop: () => void}} the block.
 */
function buildNowPlaying(hooks) {
  var onActivity = hooks && typeof hooks.onActivity === "function" ? hooks.onActivity : function () {};

  var title = el("div", { class: "cy-np-title", text: "系统媒体" });
  var artist = el("div", { class: "cy-np-sub", text: "" });
  // A seek strip rather than a range input: the host reports the position and
  // seeking through GSMTC is a tick count, so an input would promise dragging
  // that this layer does not implement.
  var progress = el("div", { class: "cy-np-bar" }, [el("div", { class: "cy-np-fill" })]);
  var times = el("div", { class: "cy-np-sub", text: "" });

  /** The playhead, advanced locally between host readings. */
  var state = { position: 0, duration: 0, status: "Closed", at: 0 };

  var button = function (label, action, hint) {
    return el("button", {
      type: "button",
      class: "cy-act",
      text: label,
      title: hint,
      dataset: { media: action },
      onclick: function () {
        sendMediaAction(action).then(function (result) {
          // Re-read straight away: the player is the authority on what the
          // action did, and a guess here would be shown as fact.
          poll(true);
          onActivity(result);
        });
      }
    });
  };

  var controls = el("div", { class: "cy-np-controls" }, [
    button("⏮", "previous", "上一首"),
    button("⏯", "toggle", "播放 / 暂停"),
    button("⏭", "next", "下一首")
  ]);

  var node = el("div", { class: "cy-np", dataset: { nowPlaying: "true" } }, [
    title,
    artist,
    progress,
    times,
    controls
  ]);

  /** Paint one reading. */
  var render = function (media, reason) {
    if (media === null || media === undefined) {
      title.textContent = reason === undefined ? "没有正在播放的媒体" : "读不到系统媒体";
      artist.textContent = reason === undefined ? "" : reason;
      times.textContent = "";
      progress.dataset.on = "false";
      controls.querySelectorAll("button").forEach(function (item) {
        item.disabled = true;
      });
      state = { position: 0, duration: 0, status: "Closed", at: 0 };
      return;
    }

    var name = media.title === "" ? "未命名" : media.title;
    title.textContent = name;
    artist.textContent = [media.artist, media.album].filter(function (part) {
      return part !== "" && part !== undefined;
    }).join(" · ");

    var parts = [media.status === "Playing" ? "播放中" : "已暂停"];
    // `app` is a package identifier; the tail after the last dot is the readable
    // part, and showing the whole thing is noise.
    if (media.app !== "") parts.push(String(media.app).split(".").pop());
    artist.textContent = artist.textContent === "" ? parts.join(" · ") : artist.textContent + " · " + parts.join(" · ");

    state = { position: media.position, duration: media.duration, status: media.status, at: Date.now() };
    paint();

    controls.querySelectorAll("button").forEach(function (item) {
      var action = item.dataset.media;
      if (action === "previous") item.disabled = media.canPrev !== true;
      else if (action === "next") item.disabled = media.canNext !== true;
      else item.disabled = false;
    });
    progress.dataset.on = "true";
  };

  /** Draw the playhead from the last reading plus the time since it arrived. */
  var paint = function () {
    if (state.duration <= 0) {
      times.textContent = "";
      progress.querySelectorAll("div")[0].style.width = "0%";
      return;
    }
    var elapsed = state.status === "Playing" ? (Date.now() - state.at) / 1000 : 0;
    var at = Math.min(state.duration, state.position + elapsed);
    progress.querySelectorAll("div")[0].style.width = ((at / state.duration) * 100).toFixed(2) + "%";
    times.textContent = formatTime(at) + " / " + formatTime(state.duration);
  };

  /** One round trip. */
  var poll = function (fresh) {
    return fetchNowPlaying(fresh === true).then(function (payload) {
      render(payload.ok === true ? payload.media : null, payload.ok === true ? undefined : payload.reason);
    });
  };

  var timer = null;
  var ticker = null;

  /** Begin polling; safe to call twice. */
  var start = function () {
    if (timer !== null) return;
    poll(true);
    timer = setInterval(function () { poll(false); }, NOW_PLAYING_INTERVAL);
    // The local paint runs faster than the host is asked, so the bar moves
    // smoothly instead of stepping once every two seconds.
    ticker = setInterval(paint, 250);
  };

  /** Stop polling; safe to call twice. */
  var stop = function () {
    if (timer !== null) { clearInterval(timer); timer = null; }
    if (ticker !== null) { clearInterval(ticker); ticker = null; }
  };

  // Polling is tied to visibility through the popover's own lifecycle hooks: the
  // block starts asking when it is mounted and stops when it is removed, so a
  // closed panel costs nothing. Wired here, after both are defined — assigning
  // them into a literal that also defines `start` would capture `undefined`.
  node.__onMounted = start;
  node.__onClose = stop;

  return { node: node, start: start, stop: stop };
}
