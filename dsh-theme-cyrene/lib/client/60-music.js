/**
 * Music subsystem: playlist, transport, seek bar, covers and a mini player.
 *
 * Seeking relies on the host half's Range support — a `200`-only server makes
 * every seek a full refetch, which is exactly the bug the reference plugin
 * shipped. Looping is done by seeking back to zero rather than by re-requesting
 * the file, so a long track does not re-download on every repeat.
 */

/**
 * Create the music controller.
 * @returns {object} the controller.
 */
function createMusicController() {
  var audio = el("audio", { preload: "metadata" });
  audio.volume = clamp(Number(settings.volume) || 0.6, 0, 1);

  var listeners = [];
  var shuffleBag = [];

  /** Notify subscribers that playback state changed. */
  var announce = function () {
    for (var index = 0; index < listeners.length; index += 1) {
      try {
        listeners[index]();
      } catch (error) {
        console.error(PLUGIN_ID + ": music listener failed", error);
      }
    }
  };

  /** The playable tracks, minus hidden ones. */
  var tracks = function () {
    return visible("music");
  };

  /** The track currently loaded. */
  var currentTrack = function () {
    return findEntry("music", settings.trackId);
  };

  /** Cover URL for a track, falling back to the first available cover. */
  var coverOf = function (track) {
    if (track !== null && typeof track.cover === "string" && track.cover !== "") return track.cover;
    var covers = visible("covers");
    return covers.length > 0 ? covers[0].url : null;
  };

  /**
   * The disc's background image.
   *
   * A track's own cover wins when there is one. There never is: the covers bucket
   * ships empty, so this fell through to an empty string on every track and the
   * disc rendered as a bare circle with its groove ring — which is exactly what it
   * looked like, and exactly why it looked like nothing.
   *
   * @param {string|null} cover - the track's cover URL, or null.
   * @returns {string} a CSS url(...) value, or "" for the empty circle.
   */
  var discArt = function (cover) {
    var art = cover !== null && cover !== void 0 && cover !== "" ? cover : DISC_ART;
    if (art === null || art === void 0 || art === "") return "";
    return 'url("' + art.replace(/"/g, "%22") + '")';
  };

  /** Load a track into the audio element without forcing playback. */
  var load = function (track) {
    if (track === null) {
      audio.removeAttribute("src");
      return;
    }
    audio.src = track.url;
    applySettings({ trackId: track.id });
  };

  /** Play, resolving the autoplay promise so a refusal is not an unhandled rejection. */
  var play = function () {
    var promise = audio.play();
    if (promise && typeof promise.catch === "function") {
      promise.catch(function () {
        applySettings({ musicOn: false }, { local: true });
        announce();
      });
    }
  };

  /** Toggle playback, loading the remembered or first track as needed. */
  var toggle = function () {
    var track = currentTrack();
    if (track === null) {
      var list = tracks();
      if (list.length === 0) {
        toast("曲库是空的，点「＋ 添加歌曲」导入音乐");
        return;
      }
      track = list[0];
      load(track);
    }
    if (audio.paused) {
      applySettings({ musicOn: true }, { local: true });
      play();
    } else {
      audio.pause();
      applySettings({ musicOn: false }, { local: true });
    }
    announce();
  };

  /** Pick the next track index for the active loop mode. */
  var nextIndex = function (step) {
    var list = tracks();
    if (list.length === 0) return -1;
    var at = -1;
    for (var index = 0; index < list.length; index += 1) {
      if (list[index].id === settings.trackId) at = index;
    }
    if (settings.loop === "shuffle") {
      if (shuffleBag.length === 0) {
        shuffleBag = list.map(function (entry) { return entry.id; });
        for (var shuffle = shuffleBag.length - 1; shuffle > 0; shuffle -= 1) {
          var pick = Math.floor(Math.random() * (shuffle + 1));
          var held = shuffleBag[shuffle];
          shuffleBag[shuffle] = shuffleBag[pick];
          shuffleBag[pick] = held;
        }
      }
      var nextId = shuffleBag.pop();
      if (nextId === settings.trackId && shuffleBag.length > 0) nextId = shuffleBag.pop();
      for (var scan = 0; scan < list.length; scan += 1) {
        if (list[scan].id === nextId) return scan;
      }
      return 0;
    }
    if (at === -1) return 0;
    return (at + step + list.length) % list.length;
  };

  /** Move to the next or previous track and keep playing if we were playing. */
  var step = function (direction) {
    var list = tracks();
    if (list.length === 0) return;
    var wasPlaying = !audio.paused;
    var at = nextIndex(direction);
    if (at === -1) return;
    load(list[at]);
    if (wasPlaying || settings.musicOn) play();
    announce();
  };

  audio.addEventListener("ended", function () {
    if (settings.loop === "single") {
      try {
        audio.currentTime = 0;
        play();
      } catch (error) {
        /* ignore */
      }
      return;
    }
    step(1);
  });
  audio.addEventListener("play", announce);
  audio.addEventListener("pause", announce);
  audio.addEventListener("loadedmetadata", announce);
  audio.addEventListener("timeupdate", announce);
  audio.addEventListener("error", function () {
    if (audio.getAttribute("src") === null) return;
    toast("这首曲子播放失败，已跳到下一首", "error");
    step(1);
  });

  return {
    audio: audio,
    tracks: tracks,
    currentTrack: currentTrack,
    coverOf: coverOf,
    discArt: discArt,
    load: load,
    play: play,
    toggle: toggle,
    next: function () { step(1); },
    previous: function () { step(-1); },
    cycleLoop: function () {
      var at = 0;
      for (var index = 0; index < LOOP_MODES.length; index += 1) {
        if (LOOP_MODES[index].id === settings.loop) at = index;
      }
      var next = LOOP_MODES[(at + 1) % LOOP_MODES.length];
      applySettings({ loop: next.id });
      announce();
      return next;
    },
    setVolume: function (value) {
      var volume = clamp(Number(value) || 0, 0, 1);
      audio.volume = volume;
      applySettings({ volume: volume }, { local: true });
      pushSettings({ volume: volume });
      announce();
    },
    seekTo: function (seconds) {
      if (!isFinite(audio.duration) || audio.duration <= 0) return;
      try {
        audio.currentTime = clamp(Number(seconds) || 0, 0, audio.duration);
      } catch (error) {
        /* not seekable yet */
      }
      announce();
    },
    subscribe: function (fn) {
      listeners.push(fn);
      return function () {
        var at = listeners.indexOf(fn);
        if (at !== -1) listeners.splice(at, 1);
      };
    },
    /** Adopt the saved state: load the remembered track and resume if asked. */
    restore: function () {
      var track = currentTrack();
      if (track === null || track === undefined) {
        var list = tracks();
        track = list.length > 0 ? list[0] : null;
      }
      if (track !== null) load(track);
      if (settings.musicOn && track !== null) play();
      announce();
    },
    dispose: function () {
      try {
        audio.pause();
        audio.removeAttribute("src");
      } catch (error) {
        /* ignore */
      }
      if (audio.parentNode) audio.parentNode.removeChild(audio);
    }
  };
}

/**
 * Build the full music popover.
 * @param {object} controller - the music controller.
 * @param {object} hooks - `{ addFiles: () => void, collapse: () => void }`.
 * @returns {HTMLElement} the popover.
 */
function buildMusicPanel(controller, hooks) {
  var nowPlaying = buildNowPlaying();
  var disc = el("div", { class: "cy-disc" });
  var title = el("div", { class: "cy-track-name", text: "未选择曲目" });
  var subtitle = el("div", { class: "cy-track-sub", text: "点播放开始" });

  var seek = el("input", {
    class: "cy-seek",
    type: "range",
    min: "0",
    max: "1000",
    value: "0",
    oninput: function () {
      var duration = controller.audio.duration;
      if (!isFinite(duration) || duration <= 0) return;
      controller.seekTo((Number(seek.value) / 1000) * duration);
    }
  });

  var elapsed = el("span", { text: "0:00" });
  var total = el("span", { text: "0:00" });

  var playButton = el("button", {
    type: "button",
    class: "cy-btn",
    "data-main": "true",
    title: "播放 / 暂停",
    text: "\u25B6",
    onclick: function () { controller.toggle(); }
  });

  var loopButton = el("button", {
    type: "button",
    class: "cy-btn",
    title: "循环模式",
    text: "\u21BB",
    onclick: function () {
      var mode = controller.cycleLoop();
      loopButton.textContent = mode.icon;
      toast(mode.label);
    }
  });

  var volume = el("input", {
    class: "cy-seek",
    type: "range",
    min: "0",
    max: "100",
    value: String(Math.round(controller.audio.volume * 100)),
    title: "音量",
    oninput: function () { controller.setVolume(Number(volume.value) / 100); }
  });

  var playlist = el("div", { class: "cy-playlist" });

  /**
   * Bring the playing song into view.
   *
   * The list is a four-row window, so with a real library the current track is
   * usually below the fold. Only the current row scrolls: doing this on every
   * sync would yank the window back while the user is scrolling through it, and
   * sync runs on every playback event.
   */
  var revealCurrent = function () {
    var row = playlist.querySelector('.cy-song[data-current="true"]');
    if (row === null || typeof row.scrollIntoView !== "function") return;
    row.scrollIntoView({ block: "nearest" });
  };

  /** The song whose row is currently marked as playing, or null. */
  var markedTrack = function () {
    var row = playlist.querySelector('.cy-song[data-current="true"]');
    return row === null ? null : row.getAttribute("data-track");
  };

  var panel = el("div", { class: "cy-pop cy-player" }, [
    el("div", { class: "cy-pop-head" }, [
      el("div", { class: "cy-pop-title", text: "Cyrene" }),
      el("div", { style: { display: "flex", gap: "4px" } }, [
        el("button", { type: "button", class: "cy-pop-close", title: "收起为迷你播放器", text: "\u2193", onclick: function () { hooks.collapse(); } }),
        el("button", { type: "button", class: "cy-pop-close", text: "\u2014", onclick: function () { closeTopPopover(); } })
      ])
    ]),
    el("div", { class: "cy-disc-row" }, [disc, el("div", { style: { minWidth: "0", flex: "1" } }, [title, subtitle])]),
    el("div", { class: "cy-progress" }, [elapsed, seek, total]),
    el("div", { class: "cy-transport" }, [
      el("button", { type: "button", class: "cy-btn", title: "上一首", text: "\u23EE", onclick: function () { controller.previous(); } }),
      playButton,
      el("button", { type: "button", class: "cy-btn", title: "下一首", text: "\u23ED", onclick: function () { controller.next(); } }),
      loopButton
    ]),
    el("div", { class: "cy-row" }, [el("span", { class: "cy-row-label", text: "音量" }), volume]),
    playlist,
    // The system's own session, under the plugin's own player. They are separate
    // things on purpose: this one reads and drives whatever the machine is
    // playing, through the host route, with no per-application integration.
    nowPlaying.node,
    el("div", { class: "cy-actions" }, [
      el("button", { type: "button", class: "cy-act", text: "＋ 添加歌曲", onclick: function () { hooks.addFiles(); } })
    ])
  ]);

  /** Rebuild the playlist rows. */
  var renderList = function () {
    clear(playlist);
    var list = controller.tracks();
    if (list.length === 0) {
      playlist.appendChild(el("div", { class: "cy-empty", text: "曲库为空。\n点「＋ 添加歌曲」导入 mp3 / flac / m4a。" }));
      return;
    }
    list.forEach(function (track) {
      playlist.appendChild(el("div", {
        class: "cy-song",
        // The id rides on the row so sync can find it directly. Matching rows to
        // tracks by label instead was O(n^2) and wrong for two files that share a
        // name — both rows lit up as playing at once.
        dataset: { current: String(settings.trackId === track.id), track: track.id },
        onclick: function () {
          controller.load(track);
          controller.play();
        }
      }, [el("span", { class: "cy-song-name", text: track.label })]));
    });
  };

  /** Reflect playback state in the panel. */
  var sync = function () {
    var track = controller.currentTrack();
    title.textContent = track === null ? "未选择曲目" : track.label;
    var cover = controller.coverOf(track);
    disc.style.backgroundImage = controller.discArt(cover);
    disc.dataset.spinning = String(!controller.audio.paused);
    playButton.textContent = controller.audio.paused ? "\u25B6" : "\u23F8";
    var duration = controller.audio.duration;
    elapsed.textContent = formatTime(controller.audio.currentTime);
    total.textContent = formatTime(isFinite(duration) ? duration : 0);
    seek.value = String(isFinite(duration) && duration > 0 ? Math.round((controller.audio.currentTime / duration) * 1000) : 0);
    for (var index = 0; index < LOOP_MODES.length; index += 1) {
      if (LOOP_MODES[index].id === settings.loop) loopButton.textContent = LOOP_MODES[index].icon;
    }
    // Only touch the rows when the playing track actually changed. sync runs on
    // every playback event, and a seek fires it many times a second.
    var playing = settings.trackId === undefined ? null : settings.trackId;
    if (playing !== markedTrack()) {
      var rows = playlist.querySelectorAll(".cy-song");
      for (var row = 0; row < rows.length; row += 1) {
        rows[row].setAttribute("data-current", String(rows[row].getAttribute("data-track") === playing));
      }
      revealCurrent();
    }
    volume.value = String(Math.round(controller.audio.volume * 100));
  };

  // Hand the caller a disposer so a rebuilt panel releases its subscription.
  panel.__dispose = controller.subscribe(sync);
  // The panel is built detached and appended by openPopover, so scrolling has to
  // wait for the mount: a node outside the document has no scrollable box yet.
  panel.__onMounted = function () {
    renderList();
    sync();
    revealCurrent();
  };
  renderList();
  sync();
  // The Now Playing block polls the host only while the panel is open, and its
  // lifecycle hooks have to reach the root for `togglePopover` to call them.
  bubblePopoverHooks(panel, nowPlaying.node);
  return panel;
}

/**
 * Build the compact mini player shown when the full panel is collapsed.
 * @param {object} controller - the music controller.
 * @param {object} hooks - `{ expand: () => void }`.
 * @returns {HTMLElement} the mini player.
 */
function buildMiniPlayer(controller, hooks) {
  var disc = el("div", { class: "cy-disc" });
  var title = el("div", { class: "cy-mini-title", text: "未选择曲目" });
  var seek = el("input", {
    class: "cy-seek",
    type: "range",
    min: "0",
    max: "1000",
    value: "0",
    oninput: function () {
      var duration = controller.audio.duration;
      if (!isFinite(duration) || duration <= 0) return;
      controller.seekTo((Number(seek.value) / 1000) * duration);
    }
  });

  var root = el("div", { class: "cy-mini", dataset: { plugin: PLUGIN_ID } }, [
    el("div", { class: "cy-mini-head" }, [
      disc,
      title,
      el("button", { type: "button", class: "cy-btn", title: "展开", text: "\u2191", onclick: function () { hooks.expand(); } })
    ]),
    seek
  ]);

  var sync = function () {
    var track = controller.currentTrack();
    title.textContent = track === null ? "未选择曲目" : track.label;
    var cover = controller.coverOf(track);
    disc.style.backgroundImage = controller.discArt(cover);
    disc.dataset.spinning = String(!controller.audio.paused);
    var duration = controller.audio.duration;
    seek.value = String(isFinite(duration) && duration > 0 ? Math.round((controller.audio.currentTime / duration) * 1000) : 0);
  };

  root.__dispose = controller.subscribe(sync);
  sync();
  return root;
}
