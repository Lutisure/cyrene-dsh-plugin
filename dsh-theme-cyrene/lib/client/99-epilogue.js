/**
 * Assembly: mount every subsystem as one effect, so disabling the plugin (or an
 * HMR recomposition) releases all of it — DOM, observers, timers, audio and the
 * theme registration alike. The reference plugin drops several of these
 * disposers, which is why re-enabling it throws and leaves a stray stylesheet.
 */

/** Particle count for a tier id. */
function countForTier(id) {
  for (var index = 0; index < PARTICLE_TIERS.length; index += 1) {
    if (PARTICLE_TIERS[index].id === id) return PARTICLE_TIERS[index].count;
  }
  return 0;
}

/** Human label for a tier id. */
function tierLabel(id) {
  for (var index = 0; index < PARTICLE_TIERS.length; index += 1) {
    if (PARTICLE_TIERS[index].id === id) return PARTICLE_TIERS[index].label;
  }
  return id;
}

/** The tier after the current one, wrapping around. */
function nextTier(id) {
  for (var index = 0; index < PARTICLE_TIERS.length; index += 1) {
    if (PARTICLE_TIERS[index].id === id) return PARTICLE_TIERS[(index + 1) % PARTICLE_TIERS.length].id;
  }
  return PARTICLE_TIERS[0].id;
}

/** sessionStorage key guarding the once-per-session opening animation. */
var BOOT_SESSION_KEY = "dsh-theme-cyrene:booted";

/** Read a sessionStorage flag without throwing in a locked-down context. */
function sessionFlag(key) {
  try {
    return window.sessionStorage.getItem(key) === "1";
  } catch (error) {
    return true; // treat an unreadable store as "already shown" rather than replaying
  }
}

/** Set a sessionStorage flag without throwing. */
function setSessionFlag(key) {
  try {
    window.sessionStorage.setItem(key, "1");
  } catch (error) {
    /* nothing to do */
  }
}

/**
 * Mount the theme.
 * @param {object} ctx - the Cordis context, with `theme` injected.
 * @returns {void}
 */
function apply(ctx) {
  ctx.effect(function () {
    var disposers = [];
    var track = function (candidate) {
      if (typeof candidate === "function") disposers.push(candidate);
    };

    loadSettings();
    primeCatalog();

    /**
     * The plugin's own stylesheet, remountable.
     *
     * Like the identity and glass sheets, it bakes the theme's colours into its
     * text at build time, so a skin switch has to rebuild it. Kept behind the
     * same refresh call as the other two.
     */
    var controlsSheet = (function () {
      var unmount = mountStyle(controlsCSS(), "controls.css");
      return {
        refresh: function () {
          unmount();
          unmount = mountStyle(controlsCSS(), "controls.css");
        },
        dispose: function () { unmount(); }
      };
    }());
    track(controlsSheet.dispose);

    var toastHost = el("div", { class: "cy-toasts", id: PLUGIN_ID + "-toasts", dataset: { plugin: PLUGIN_ID } });
    document.body.appendChild(toastHost);
    track(function () {
      if (toastHost.parentNode) toastHost.parentNode.removeChild(toastHost);
    });

    var identity = applyIdentity(ctx, document.body, {});
    track(identity.dispose);

    // The skin layer, and the one place both stylesheet sets are rebuilt from the
    // re-derived theme. `applySkin` runs before this, so the sheets that exist at
    // this point already carry the stored skin's values.
    var skinLayer = createSkinLayer({
      refresh: function () {
        identity.refreshSheets();
        controlsSheet.refresh();
      }
    });
    applySkin(settings.skin);

    var particles = createParticles(identity.layers.canvas);
    track(particles.dispose);

    var pointer = createPointerEffects(identity.layers.pointer);
    track(pointer.dispose);

    var fonts = createFontLayer();
    track(fonts.dispose);

    var glassTuning = createGlassLayer();
    track(glassTuning.dispose);

    // The portrait that leads each of her replies. Started here rather than in
    // `apply` because it owns a document-wide observer, and one of those should
    // exist for exactly as long as the plugin does.
    var replyAvatar = createReplyAvatarLayer();
    track(replyAvatar.dispose);
    replyAvatar.start();

    // The dotted orb beside the composer while something is executing.
    var thinkingOrb = createWorkingOrbLayer();
    track(thinkingOrb.dispose);
    thinkingOrb.start();

    var typing = createTypingSound();
    typing.setEnabled(settings.sound === true);
    track(typing.dispose);

    var music = createMusicController();
    document.body.appendChild(music.audio);
    track(music.dispose);

    var dock = createDock();
    document.body.appendChild(dock.root);
    track(dock.destroy);
    track(wirePopoverTracking(dock));

    // The pet lives outside the dock: it is a companion, not a control, and
    // folding the control bar must not fold her away too.
    //
    // She is mounted only once the catalog is settled. Creating her from the
    // build-time list looked identical with bundled stickers and was wrong: a
    // sticker added after the last build exists only in the host's manifest, so
    // she would silently ignore it.
    var pet = null;
    var mountPet = function () {
      if (pet !== null) return;
      pet = createPet(visible("pet"), {
        onMove: function (position) {
          applySettings({ petPos: position });
        }
      });
      if (pet === null) return;
      document.body.appendChild(pet.root);
      pet.setPosition(settings.petPos);
      if (settings.petOn === false) pet.hide();
      else pet.show();
      track(pet.dispose);
    };

    var wallpaper = createWallpaperController(identity.layers);

    /** Open a file dialog and store the picked wallpapers. */
    var addWallpapers = function () {
      chooseFiles("wallpaper", ".jpg,.jpeg,.png,.webp,.avif,.mp4,.webm").then(function (files) {
        return uploadAll("wallpaper", files);
      }).then(function (count) {
        if (count > 0) wallpaper.restore();
      });
    };

    /** Open a file dialog and store the picked music. */
    var addMusic = function () {
      chooseFiles("music", ".mp3,.m4a,.flac,.ogg,.oga,.opus,.wav").then(function (files) {
        return uploadAll("music", files);
      });
    };

    /** The wallpaper settings popover, with a path into the grid. */
    var openWallpaperSettings = function (anchor) {
      var panel = buildWallpaperPanel(wallpaper, {
        addFiles: addWallpapers,
        // The arrangement controls are the same dock object that renders the
        // bar, not a second copy of the arrangement kept in the panel: a panel
        // that reordered its own list is a panel whose buttons stop matching the
        // bar the moment anything else moves one.
        dock: dock,
        openGrid: function () {
          var grid = buildWallpaperGrid(wallpaper, { addFiles: addWallpapers });
          openPopover(grid, anchor, { onClose: function () { dock.markClosed(); } });
        }
      });
      return panel;
    };

    /**
     * Re-render the bar from the current arrangement, and remember a repair.
     *
     * Two jobs, and the second is easy to miss. The render is the visible one.
     * The repair is the one that matters a reload later: `dock.resolve()` answers
     * with the *default* arrangement when the saved document cannot be read, and
     * a mount that only rendered that answer would lose it again on the next
     * load — the document still holding the broken arrays, still logging the same
     * warning, forever. So a repair is written back, which makes the corrected
     * arrangement the saved one.
     *
     * The write-back is found by asking the resolver a second time rather than by
     * comparing serialised documents: a repaired document resolves to itself, so
     * the check is "is this answer still the default because it had to be".
     *
     * Also re-syncs the Scene panel's rows when that panel is the open one, so a
     * drag in the bar and a press of ↑ in the panel cannot leave the two showing
     * different arrangements. It runs after the write-back, because the rows read
     * the settings document and would otherwise sync against the broken one.
     */
    var refreshDock = function () {
      var split = dock.resolve();
      dock.renderDock(split);
      // Asked a second time rather than compared as serialised documents: once
      // the repair has landed the resolver returns what it was just given, so
      // this is a no-op — no flag to keep in sync, and no way to loop, because a
      // repaired document resolves to itself.
      var settled = dock.resolve();
      if (settled.repaired === true) {
        applySettings({ dockFixed: settled.fixed, dockOrder: settled.free });
      }
      var panel = document.querySelector(".cy-pop [data-dock-group='true']");
      if (panel !== null && panel !== undefined && panel.parentNode !== null && typeof panel.parentNode.__syncDock === "function") {
        panel.parentNode.__syncDock();
      }
    };

    var musicPanelNode = null;
    var miniPlayerNode = null;

    /** Release a music view: unsubscribe its listeners, then detach it. */
    var disposeNode = function (node) {
      if (node === null) return;
      if (typeof node.__dispose === "function") {
        try {
          node.__dispose();
        } catch (error) {
          console.error(PLUGIN_ID + ": music view dispose failed", error);
        }
      }
      if (node.parentNode) node.parentNode.removeChild(node);
    };

    /** Collapse the full player into the dock-side mini player. */
    var collapseToMini = function () {
      dock.closeAll();
      dock.setVisible(false);
      if (miniPlayerNode === null || !miniPlayerNode.isConnected) {
        disposeNode(miniPlayerNode);
        miniPlayerNode = buildMiniPlayer(music, { expand: expandFromMini });
        document.body.appendChild(miniPlayerNode);
      }
    };

    /** Bring the full player back from the mini player. */
    var expandFromMini = function () {
      disposeNode(miniPlayerNode);
      miniPlayerNode = null;
      dock.setVisible(true);
      var anchor = dock.buttonFor("music");
      if (anchor !== null) dock.togglePopover("music", anchor, buildMusic);
    };

    /**
     * Build the music popover. Each build replaces the previous one and
     * releases its subscription, so opening the panel repeatedly does not
     * accumulate listeners.
     */
    var buildMusic = function () {
      disposeNode(musicPanelNode);
      musicPanelNode = buildMusicPanel(music, { addFiles: addMusic, collapse: collapseToMini });
      return musicPanelNode;
    };

    // ---- dock buttons ----
    //
    // Declared here, rendered by `renderDock` from the settings document. This
    // site owns what each slot *does*; which group it is in and where it sits are
    // the user's, so the six registrations are a lookup keyed by id rather than
    // six `addButton` calls in the order they happen to appear. Ordering the bar
    // by call order is exactly the thing this feature exists to replace.
    //
    // The bar is labelled in English throughout: single hanzi named the *medium*
    // (sound, particles, scene, music), which is not what this dock is for — it
    // controls the theme, and one of them is the character herself. `Trace` keeps
    // that convention (the pointer leaves a trace) rather than spelling out
    // 点击/拖尾 on a button whose label is now a hover reveal.
    var dockActions = {
      sound: {
        title: "打字音效 开 / 关",
        onClick: function () {
          applySettings({ sound: !(settings.sound === true) });
          toast(settings.sound ? "打字音效 已开启" : "打字音效 已关闭");
        }
      },
      fonts: {
        title: "字体 · 字族与字号",
        onClick: function (anchor) {
          dock.togglePopover("fonts", anchor, function () {
            return buildFontPanel({ close: function () { dock.closeAll(); } });
          });
        }
      },
      particles: {
        title: "氛围粒子分档",
        onClick: function () {
          applySettings({ particles: nextTier(settings.particles) });
          toast("氛围粒子 · " + tierLabel(settings.particles));
        }
      },
      pointer: {
        title: "指针效果 · 点击与拖尾",
        onClick: function (anchor) {
          dock.togglePopover("pointer", anchor, function () {
            return buildPointerPanel({ close: function () { dock.closeAll(); } });
          });
        }
      },
      wallpaper: {
        title: "壁纸设置",
        onClick: function (anchor) {
          dock.togglePopover("wallpaper", anchor, function () { return openWallpaperSettings(anchor); });
        }
      },
      music: {
        title: "昔涟 · 背景音乐",
        onClick: function (anchor) {
          // Opening a panel must not start playback. It used to `music.toggle()`
          // here, on the reasoning that opening is the gesture browsers want before
          // audio may play — which is true, and beside the point: it made *looking*
          // at the panel an instruction to play. Reaching for the button to check
          // the title, or to stop the music, started it instead.
          //
          // The transport inside the panel is a click too, and a much better
          // gesture: it means what it says, and it is where a reader looks to
          // change playback. Nothing here needs the gesture, so nothing here takes
          // it.
          dock.togglePopover("music", anchor, buildMusic);
        }
      }
    };

    dockPieces().forEach(function (piece) {
      var action = dockActions[piece.id];
      if (action === undefined) return;
      dock.addButton({
        id: piece.id,
        label: piece.label,
        title: action.title,
        onClick: action.onClick
      });
    });

    var showBoot = function () {
      var entries = visible("boot");
      var overlay = createBootOverlay(entries, {
        style: settings.bootStyle,
        onFinished: function () {
          if (overlay !== null) overlay.dispose();
        }
      });
      if (overlay !== null) overlay.show();
    };

    var watcher = createEmoteWatcher(function () {
      return visible("emotes");
    }, showBoot);
    track(watcher.dispose);

    /**
     * Play the opening once per browser session.
     *
     * Called only after the catalog has settled. Running it at mount read the
     * *build-time* list, which happened to work while the theme bundled an
     * opening of its own — and would have silently ignored any upload, because
     * an upload exists only in the host's manifest. Same trap as the pet.
     */
    var bootOnce = function () {
      if (sessionFlag(BOOT_SESSION_KEY)) return;
      setSessionFlag(BOOT_SESSION_KEY);
      showBoot();
    };

    // ---- react to setting changes from anywhere ----
    track(onSettings(function (next) {
      particles.setCount(countForTier(next.particles));
      pointer.apply(next);
      fonts.apply(next);
      glassTuning.apply(next);
      skinLayer.apply(next);
      replyAvatar.apply(next);
      dock.avatar.apply(next);
      typing.setEnabled(next.sound === true);
      identity.layers.setShade(next.shade);
      identity.layers.setWallTuning({
        brightness: next.wallBrightness,
        saturate: next.wallSaturate,
        contrast: next.wallContrast,
        opacity: next.wallOpacity,
        blurFog: next.wallFog,
        scale: next.wallScale
      });
      identity.layers.setGlass(next.glass !== false);
      if (pet !== null) {
        if (next.petOn === false) pet.hide();
        else pet.show();
      }
      dock.setOn("sound", next.sound === true);
      dock.setOn("particles", next.particles !== "off");
      dock.setOn("music", next.musicOn === true);
      // The bar is re-rendered on every change rather than only when a dock key
      // moved. Re-appending six nodes to two groups is cheap and idempotent, and
      // the alternative is a diff — which has to be right about *every* path that
      // can change the arrangement: a drag in the bar, an Alt+Arrow press, the
      // ↑/↓ rows in the Scene panel, a 固定 toggle, the reset button, and a theme
      // package imported over the top of all of them. The last one never calls a
      // dock writer at all, which is what a diff would have missed.
      refreshDock();
    }));

    // ---- initial paint ----
    particles.setCount(countForTier(settings.particles));
    pointer.apply(settings);
    fonts.apply(settings);
    glassTuning.apply(settings);
    replyAvatar.apply(settings);
    dock.avatar.apply(settings);
    identity.layers.setShade(settings.shade);
    identity.layers.setWallTuning({
      brightness: settings.wallBrightness,
      saturate: settings.wallSaturate,
      contrast: settings.wallContrast,
      opacity: settings.wallOpacity,
      blurFog: settings.wallFog,
      scale: settings.wallScale
    });
    identity.layers.setGlass(settings.glass !== false);
    // The first render *is* the write-back: a document whose two arrays do not
    // list each slot exactly once is repaired by `renderDock`, and the repaired
    // arrangement is then saved, so the next mount starts from an arrangement
    // that is already whole. Doing it here rather than in the resolver also keeps
    // the repair visible in the DOM, which is the only place a person can see it.
    refreshDock();
    // Restoring the folded state must not write it back, or a mount would look
    // like a user action and defeat the auto-fold timer.
    dock.setCollapsed(settings.dockCollapsed === true, { persist: false });

    wallpaper.restore();
    music.restore();

    refreshManifest().then(function () {
      // Bundled assets are in the build-time manifests, but uploads from an
      // earlier session only exist in the host's manifest, which lands after
      // the first paint. Re-resolve now that the catalog is complete —
      // otherwise a saved wallpaper that only the host knows about is lost on
      // every reload.
      if (wallpaper.current() === null) wallpaper.restore();
      if (music.currentTrack() === null) music.restore();
      mountPet();
      mountCelebrate(ctx, track);
      bootOnce();
    }).catch(function (error) {
      console.warn(PLUGIN_ID + ": could not read the asset manifest", error);
      // A failed manifest must not cost her the pet, nor the opening.
      mountPet();
      mountCelebrate(ctx, track);
      bootOnce();
    });

    track(function () {
      disposeNode(musicPanelNode);
      disposeNode(miniPlayerNode);
      musicPanelNode = null;
      miniPlayerNode = null;
    });

    return function () {
      for (var index = disposers.length - 1; index >= 0; index -= 1) {
        try {
          disposers[index]();
        } catch (error) {
          console.error(PLUGIN_ID + ": disposer failed", error);
        }
      }
    };
  }, PLUGIN_ID + ": apply");
}

// `remote` carries the session running bit the celebration watches. Declared
// here rather than fetched lazily: the browser half has no optional-injection
// mechanism, so a dependency either appears in this list or is not available.
exports.inject = ["theme", "remote"];
exports.apply = apply;

/**
 * The settings writer, on the module's own surface.
 *
 * Exists for the headless harness. `applySettings` is inside the factory scope,
 * so a test has no way to reach it — and driving every setting through whichever
 * control happens to write it turns a test about what a setting *does* into a
 * test about that control. This is the same function the panels call, so the
 * subscribers, the host push and the local mirror all still run.
 *
 * Harmless in the browser: the module object is the plugin's own, and nothing
 * there reads this key.
 *
 * @param {object} patch - the partial settings document.
 * @returns {void}
 */
exports.__applySettings = function (patch) {
  applySettings(patch);
};
return module.exports;
  }
});
