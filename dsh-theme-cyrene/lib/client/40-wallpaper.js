/**
 * Wallpaper subsystem: selection, random rotation, uploads and soft-delete.
 *
 * The picker applies a wallpaper on click and exposes a separate selection
 * toggle for the bulk actions (remove / random pool), so "try this one" and
 * "choose several" never fight over the same gesture.
 */

/** Wallpaper kinds, in segmented-control order. */
var WALLPAPER_TYPES = [
  { id: "video", label: "动态" },
  { id: "image", label: "静态" }
];

/**
 * Own the current wallpaper and its rotation.
 * @param {object} layers - the background layer API from `createLayerRoot`.
 * @returns {object} the controller.
 */
function createWallpaperController(layers) {
  var rotationTimer = null;
  var pool = [];

  /** All wallpapers of the active type that are not hidden. */
  var ofType = function (type) {
    return visible("wallpapers").filter(function (entry) {
      return entry.kind === type;
    });
  };

  /** Apply one wallpaper entry and remember it. */
  var select = function (entry) {
    if (entry === null || entry === undefined) {
      layers.setWallpaper(null);
      layers.setVideo(null);
      applySettings({ wallpaper: null });
      return;
    }
    if (entry.kind === "video") {
      layers.setWallpaper(null);
      layers.setVideo(entry);
    } else {
      layers.setVideo(null);
      layers.setWallpaper(entry);
    }
    applySettings({ wallpaper: entry.id, wallpaperType: entry.kind });
  };

  /** The entry currently applied, if the catalog still holds it. */
  var current = function () {
    if (settings.wallpaper === null || settings.wallpaper === undefined) return null;
    return findEntry("wallpapers", settings.wallpaper);
  };

  /** The first entry flagged `default`, used to seed a fresh install. */
  var defaultEntry = function (type) {
    var list = ofType(type);
    for (var index = 0; index < list.length; index += 1) {
      if (list[index]["default"] === true) return list[index];
    }
    return list.length > 0 ? list[0] : null;
  };

  /** Pick the next wallpaper, honouring the random pool when rotation is on. */
  var advance = function () {
    var source = pool.length > 0 ? pool : ofType(settings.wallpaperType);
    if (source.length === 0) {
      source = visible("wallpapers");
    }
    if (source.length === 0) return;
    var candidates = source.filter(function (entry) {
      return entry.id !== settings.wallpaper;
    });
    var chosen = candidates.length > 0 ? candidates[Math.floor(Math.random() * candidates.length)] : source[0];
    select(chosen);
  };

  /** (Re)arm the rotation timer from the current settings. */
  var reschedule = function () {
    if (rotationTimer !== null) {
      clearInterval(rotationTimer);
      rotationTimer = null;
    }
    if (!settings.randomOn) return;
    var minutes = clamp(Number(settings.randomMinutes) || 5, 1, 720);
    rotationTimer = setInterval(advance, minutes * 60 * 1000);
  };

  /** Adopt the saved state, falling back to the default wallpaper. */
  var restore = function () {
    var entry = current();
    if (entry === null || entry.kind !== settings.wallpaperType) {
      var fallback = defaultEntry(settings.wallpaperType) || defaultEntry("image") || visible("wallpapers")[0] || null;
      if (fallback !== null) select(fallback);
      else {
        layers.setWallpaper(null);
        layers.setVideo(null);
      }
    } else {
      select(entry);
    }
    layers.setShade(settings.shade);
    reschedule();
  };

  /** Set the random pool from the picker's selection. */
  var setPool = function (ids) {
    pool = ids.map(function (id) {
      return findEntry("wallpapers", id);
    }).filter(Boolean);
  };

  return {
    select: select,
    current: current,
    advance: advance,
    restore: restore,
    reschedule: reschedule,
    setPool: setPool,
    ofType: ofType,
    dispose: function () {
      if (rotationTimer !== null) clearInterval(rotationTimer);
      rotationTimer = null;
    }
  };
}

/**
 * Build the wallpaper settings popover.
 * @param {object} controller - the wallpaper controller.
 * @param {object} hooks - `{ openGrid: () => void, addFiles: () => void,
 *   dock: object }`. The dock is the same object the mount path renders the bar
 *   from, so the rows below reorder the real thing rather than a copy of it.
 * @returns {HTMLElement} the popover.
 */
function buildWallpaperPanel(controller, hooks) {
  /** `{ [key]: value }` — a computed key an object literal cannot express. */
  var withKey = function (key, value) {
    var patch = {};
    patch[key] = value;
    return patch;
  };

  /**
   * The skin picker.
   *
   * Placed at the top because it recolours everything below it, and built here
   * rather than as its own dock button because it is a property of the whole
   * interface — the same class of thing as the wallpaper and the glass, which
   * already live in this panel.
   */
  var skinSeg = el("div", { class: "cy-seg", dataset: { skins: "true" } });
  SKINS.forEach(function (skin) {
    skinSeg.appendChild(el("button", {
      type: "button",
      text: skin.name,
      title: skin.note,
      dataset: { skin: skin.id },
      "data-on": String(settings.skin === skin.id),
      onclick: function () {
        applySettings({ skin: skin.id });
        sync();
      }
    }));
  });

  var typeSeg = el("div", { class: "cy-seg" });
  WALLPAPER_TYPES.forEach(function (type) {
    typeSeg.appendChild(el("button", {
      type: "button",
      text: type.label,
      dataset: { type: type.id },
      "data-on": String(settings.wallpaperType === type.id),
      onclick: function () {
        applySettings({ wallpaperType: type.id });
        controller.restore();
        sync();
      }
    }));
  });

  var interval = el("input", {
    class: "cy-input",
    type: "number",
    min: "1",
    max: "720",
    value: String(settings.randomMinutes),
    onchange: function () {
      var minutes = clamp(Number(interval.value) || 5, 1, 720);
      interval.value = String(minutes);
      applySettings({ randomMinutes: minutes });
      controller.reschedule();
    }
  });

  var randomToggle = el("button", {
    type: "button",
    class: "cy-act",
    text: "随机轮换",
    onclick: function () {
      applySettings({ randomOn: !settings.randomOn });
      controller.reschedule();
      if (settings.randomOn) controller.advance();
      sync();
    }
  });

  // Live look controls. Tuning the image by eye is faster than editing the
  // palette and reloading, so both knobs apply as they are dragged.
  var brightness = el("input", {
    class: "cy-seek",
    type: "range",
    min: "60",
    max: "200",
    value: String(Math.round((settings.wallBrightness ?? THEME.wallBrightness) * 100)),
    title: "壁纸亮度",
    oninput: function () {
      applySettings({ wallBrightness: Number(brightness.value) / 100 });
      brightnessLabel.textContent = brightness.value + "%";
    }
  });
  var brightnessLabel = el("span", { text: brightness.value + "%", style: { minWidth: "38px", textAlign: "right" } });

  var shade = el("input", {
    class: "cy-seek",
    type: "range",
    min: "0",
    max: "70",
    value: String(Math.round((settings.shade ?? THEME.shade) * 100)),
    title: "遮罩浓度",
    oninput: function () {
      applySettings({ shade: Number(shade.value) / 100 });
      shadeLabel.textContent = shade.value + "%";
    }
  });
  var shadeLabel = el("span", { text: shade.value + "%", style: { minWidth: "38px", textAlign: "right" } });

  /**
   * A tuning row that writes one wallpaper setting.
   *
   * The panel no longer touches the layers directly: every knob writes through
   * `applySettings`, and the layer re-reads the whole set on the next
   * subscription tick. That is what keeps a slider, a restored backup and a
   * hand-edited settings file on the same path.
   *
   * @param {string} label - the row's name.
   * @param {string} key - the setting it writes.
   * @param {number} from - slider minimum, in the display unit.
   * @param {number} to - slider maximum, in the display unit.
   * @param {number} unit - divisor from display units to the stored value.
   * @param {string} hint - tooltip.
   * @returns {HTMLElement} the row.
   */
  var tuningRow = function (label, key, from, to, unit, hint) {
    var input = el("input", {
      class: "cy-seek",
      type: "range",
      min: String(from),
      max: String(to),
      value: String(Math.round(Number(settings[key]) * unit)),
      title: label + " · " + hint,
      oninput: function () {
        applySettings(withKey(key, Number(input.value) / unit));
        out.textContent = input.value;
      }
    });
    var out = el("span", {
      text: String(Math.round(Number(settings[key]) * unit)),
      style: { minWidth: "38px", textAlign: "right" }
    });
    return el("div", { class: "cy-row", dataset: { tuning: key } }, [
      el("span", { text: label, style: { minWidth: "52px" } }),
      input,
      out
    ]);
  };

  // 对比 / 饱和 / 透明度 / 雾化 / 缩放. Brightness and the shade gradient have
  // their own sliders above, with their own ranges and labels. Collected into an
  // array here because the panel is built in one expression below — appending
  // first would run before the container exists.
  var tuningRows = [
    tuningRow("对比", "wallContrast", 45, 165, 100, "1.00 是原图"),
    tuningRow("饱和", "wallSaturate", 30, 190, 100, "1.00 是原图"),
    tuningRow("不透明", "wallOpacity", 5, 100, 100, "壁纸的不透明度"),
    tuningRow("雾化", "wallFog", 0, 24, 1, "模糊半径，像素"),
    tuningRow("缩放", "wallScale", 100, 130, 100, "放大以藏住模糊带进来的软边")
  ];

  // ---- 玻璃 ----
  //
  // Three numbers and a colour, all starting at the shipped recipe, so an
  // untouched install derives exactly the same tokens it did before these
  // existed. The colour is a picker rather than a slider because "which hue"
  // is a choice, not a quantity.
  var hueInput = el("input", {
    type: "color",
    value: String(settings.glassHue === undefined ? THEME.hue : settings.glassHue),
    title: "混进中性色的色相；浓度调到 0 就是纯灰",
    style: { width: "40px", height: "24px", padding: "0", border: "none", background: "none", cursor: "pointer" },
    oninput: function () {
      applySettings({ glassHue: safeFace(hueInput.value) });
    }
  });

  var glassRows = [
    el("div", { class: "cy-row", dataset: { glass: "hue" } }, [
      el("span", { class: "cy-row-label", text: "玻璃色相" }),
      hueInput
    ]),
    tuningRow("着色", "glassTint", 0, 70, 100, "中性色里混多少主题色相"),
    tuningRow("透明度", "glassAlpha", 60, 125, 100, "整栈一起变透明；1.00 是出厂配方"),
    tuningRow("磨砂", "glassBlur", 0, 80, 1, "dock 与浮层的背景模糊半径，像素")
  ];

  // ---- 主题包 ----
  //
  // Export, import, and one-step undo. The undo is the part that matters: the
  // failure mode this covers is "I tried someone else's theme and want mine
  // back", and a snapshot taken before the import answers it without any version
  // history to maintain.
  var packageFile = el("input", {
    type: "file",
    accept: ".json,application/json",
    style: { display: "none" },
    onchange: function () {
      var file = packageFile.files && packageFile.files[0];
      if (file === undefined || file === null) return;
      readPackageFile(file).then(function (text) {
        adoptPackage(text);
        packageFile.value = "";
      });
    }
  });

  /** Export the current document. */
  var exportPackage = function () {
    var text = buildPackage(settings);
    try {
      var blob = new Blob([text], { type: "application/json" });
      var url = URL.createObjectURL(blob);
      var link = el("a", { href: url, download: "cyrene-theme.json" });
      document.body.appendChild(link);
      link.click();
      if (link.parentNode) link.parentNode.removeChild(link);
      // Revoked on a later tick: doing it synchronously races the download in
      // some engines and produces an empty file.
      setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
      toast("已导出主题包");
    } catch (error) {
      toast("导出失败，已改为复制到剪贴板", "warn");
      copyText(text);
    }
  };

  /**
   * Validate a package and, if it holds up, adopt it.
   *
   * The snapshot is taken before anything is written, and the whole validated
   * document is applied in one `applySettings` call so the live interface never
   * sees a half-imported state.
   */
  var adoptPackage = function (text) {
    var parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      toast("这个文件不是有效的 JSON", "warn");
      return;
    }

    var verdict = validatePackage(parsed, text.length);
    if (verdict.ok !== true) {
      // The caller gets the first error by name; the rest would not fit.
      toast("导入被拒：" + verdict.errors[0], "warn");
      return;
    }
    if (Object.keys(verdict.settings).length === 0) {
      toast("包里没有可用的设置", "warn");
      return;
    }

    var kept = keepUndoSnapshot(settings);
    applySettings(verdict.settings);
    sync();
    var note = verdict.warnings.length > 0 ? "（" + verdict.warnings.length + " 项被跳过）" : "";
    toast("已导入主题包" + note + (kept ? "，可以撤销" : "，但没能留下撤销点"), kept ? "info" : "warn");
  };

  /** Put the pre-import document back. */
  var undoPackage = function () {
    var snapshot = readUndoSnapshot();
    if (snapshot === null) {
      toast("没有可撤销的导入", "warn");
      return;
    }
    applySettings(snapshot.settings);
    clearUndoSnapshot();
    sync();
    toast("已回到导入前");
  };

  var packageRows = [
    el("div", { class: "cy-actions", dataset: { themePackage: "true" } }, [
      el("button", { type: "button", class: "cy-act", text: "导出主题", title: "把当前设置存成一个 json", onclick: exportPackage }),
      el("button", { type: "button", class: "cy-act", text: "导入主题", title: "读入一个主题包，会先留撤销点", onclick: function () { packageFile.click(); } }),
      el("button", { type: "button", class: "cy-act", text: "撤销导入", title: "回到上一个导入之前", onclick: undoPackage })
    ]),
    packageFile
  ];

  // ---- 头像 ----
  //
  // The one avatar surface this theme owns is the collapsed dock dot. The picked
  // image is downscaled and kept in the settings document as a data URL, because
  // the host's upload route has no avatar bucket and a 40-pixel circle does not
  // justify changing the host half of the plugin.
  var avatarFile = el("input", {
    type: "file",
    accept: "image/*",
    style: { display: "none" },
    onchange: function () {
      var file = avatarFile.files && avatarFile.files[0];
      if (file === undefined || file === null) return;
      readAvatarFile(file).then(function (result) {
        if (result.ok !== true) {
          toast(result.reason || "这个文件用不了", "warn");
          return;
        }
        applySettings({ avatarSource: "custom", avatarCustom: result.url });
        toast("头像已更换");
      });
      avatarFile.value = "";
    }
  });

  var avatarRows = [
    el("div", { class: "cy-row", dataset: { avatar: "controls" } }, [
      el("span", { class: "cy-row-label", text: "头像" }),
      el("button", {
        type: "button",
        class: "cy-act",
        text: "选择图片",
        title: "会缩到 160 像素再保存，跟着设置一起走",
        onclick: function () { avatarFile.click(); }
      }),
      el("button", {
        type: "button",
        class: "cy-act",
        text: "回复默认",
        title: "换回插件自带的肖像",
        onclick: function () {
          applySettings({ avatarSource: "builtin" });
          sync();
        }
      }),
      el("button", {
        type: "button",
        class: "cy-act",
        text: "不要头像",
        title: "收起后只显示一个圆点",
        onclick: function () {
          applySettings({ avatarSource: "none" });
          sync();
        }
      }),
      // Separate from the three above, which choose *which* portrait she has.
      // This one decides whether a portrait leads each of her replies at all —
      // someone may want the face on the folded dot and a plain conversation,
      // and folding the two into one control would take that choice away.
      el("button", {
        type: "button",
        class: "cy-act",
        dataset: { replyAvatar: "true" },
        text: "回复头像 · 开",
        title: "每条回复左边要不要她的肖像",
        onclick: function () {
          applySettings({ replyAvatar: settings.replyAvatar === false });
          sync();
        }
      }),
      avatarFile
    ])
  ];

  // The Liquid Glass layer. It is decorative on top of the material system, so
  // it is a switch rather than a number — and it lives here because this is the
  // one panel that already carries live look controls.
  var glassToggle = el("button", {
    type: "button",
    class: "cy-act",
    text: "玻璃质感 · 开",
    title: "苹果式 Liquid Glass：噪点、镜面边缘、更强的磨砂",
    onclick: function () {
      applySettings({ glass: settings.glass === false });
      // Re-read through sync() rather than setting the label here, so the
      // button, the flag and the settings can never disagree.
      sync();
    }
  });

  // The pet. Like the glass layer it is a companion feature rather than a
  // material setting, so it is a switch, and it belongs where the other look
  // controls already live.
  var petToggle = el("button", {
    type: "button",
    class: "cy-act",
    text: "小昔涟 · 开",
    title: "角落的小昔涟：待机呼吸、打字与发送有反应，可以拖动",
    onclick: function () {
      applySettings({ petOn: settings.petOn === false });
      sync();
    }
  });

  // ---- 工具栏 ----
  //
  // Every arrangement control there is, in one place. The alternative — a
  // 固定 / 可排 toggle in each of the six panels, plus the drag in the bar —
  // would put the same setting in seven places, and six of them would be the
  // wrong panel: you would go to the particle panel to stop the particle button
  // from moving.
  //
  // It lives in this panel because this is where the look-and-arrangement
  // controls already are, and because the wallpaper slot is fixed by default —
  // so the panel that can un-fix it is the one you can always reach.
  //
  // The rows are built from `dock.resolve()`, the same answer the bar renders
  // from, so a repaired arrangement shows as repaired here too instead of this
  // panel politely disagreeing with the bar beside it.
  var dockRows = [];
  var dockList = el("div", { class: "cy-dockrows", dataset: { dockList: "true" } });

  var buildDockGroup = function () {
    var split = hooks.dock.resolve();
    // The rows follow the bar: free slots in their saved order, then the fixed
    // ones in their canonical order. A list that ran in some third order would
    // be a second, quieter statement about the arrangement.
    split.free.concat(split.fixed).forEach(function (id) {
      var state = el("span", {
        class: "cy-dockrow-state",
        dataset: { dockState: id },
        style: { minWidth: "34px", textAlign: "right", fontSize: "11px", opacity: "0.7" }
      });
      var toggle = el("button", {
        type: "button",
        class: "cy-dockrow-btn cy-dockrow-toggle",
        onclick: function () {
          var now = hooks.dock.resolve();
          var inFixed = now.fixed.indexOf(id) !== -1;
          // A toggle writes both arrays at once. Writing one and re-deriving the
          // other is how a slot ends up in neither list and disappears.
          if (inFixed) {
            applySettings({
              dockFixed: now.fixed.filter(function (slot) { return slot !== id; }),
              dockOrder: now.free.concat([id])
            });
          } else {
            applySettings({
              dockFixed: now.fixed.concat([id]),
              dockOrder: now.free.filter(function (slot) { return slot !== id; })
            });
          }
        }
      });
      var up = el("button", {
        type: "button",
        class: "cy-dockrow-btn",
        text: "\u2191",
        dataset: { dockMove: "up", dockFor: id },
        onclick: function () { hooks.dock.moveSlot(id, -1); }
      });
      var down = el("button", {
        type: "button",
        class: "cy-dockrow-btn",
        text: "\u2193",
        dataset: { dockMove: "down", dockFor: id },
        onclick: function () { hooks.dock.moveSlot(id, 1); }
      });
      dockRows.push({ id: id, state: state, toggle: toggle, up: up, down: down });
      var row = el("div", { class: "cy-dockrow", dataset: { dockRow: id } }, [
        // The icon first, then the name: the row is read left to right the way
        // the bar is, so matching a row to a slot in the bar is a glance rather
        // than a lookup.
        dockIcon(id),
        // The English word the button shows, plus the Chinese name the interface
        // uses for it — because the lock button says 固定 / 可排 while the bar
        // itself says `Scene`, and matching them up should not take a guess.
        el("span", { class: "cy-dockrow-name", text: dockLabelOf(id) + " · " + dockName(id) }),
        state,
        toggle,
        up,
        down
      ]);
      dockList.appendChild(row);
    });
  };

  /** Reflect the arrangement in the rows. */
  var syncDockRows = function () {
    var split = hooks.dock.resolve();
    for (var index = 0; index < dockRows.length; index += 1) {
      var row = dockRows[index];
      var inFixed = split.fixed.indexOf(row.id) !== -1;
      var movable = split.free.indexOf(row.id);
      // Through `translate` explicitly, and not only through `el()`. A word set
      // from inside a sync runs *after* the build, so the helper never saw it —
      // which left an English interface with two Chinese words on its most
      // important new control.
      row.toggle.textContent = translate(inFixed ? "固定" : "可排");
      row.toggle.setAttribute("data-fixed", String(inFixed));
      row.toggle.setAttribute("aria-pressed", String(inFixed));
      row.toggle.title = translate(inFixed ? "固定位置，不参与拖动" : "在可排队列里自由排序");
      row.state.textContent = inFixed ? "" : String(movable + 1) + "/" + split.free.length;
      // `disabled` rather than hidden: a control that vanishes when it cannot be
      // used makes the row jump, and a greyed one says the slot is at the end of
      // its range instead of that the feature is missing.
      row.up.disabled = inFixed || movable <= 0;
      row.down.disabled = inFixed || movable === -1 || movable >= split.free.length - 1;
    }
  };

  buildDockGroup();

  var dockReset = el("button", {
    type: "button",
    class: "cy-act",
    text: "恢复默认",
    title: "把固定与可排都恢复为出厂排列",
    onclick: function () {
      applySettings({
        dockFixed: DEFAULT_SETTINGS.dockFixed.slice(),
        dockOrder: DEFAULT_SETTINGS.dockOrder.slice()
      });
    }
  });

  // The group lives behind a disclosure: it is nine more rows than a
  // 340-pixel panel can show at once, and this panel's own subject is still the
  // wallpaper.
  var dockDetails = el("details", { class: "cy-more", dataset: { dockGroup: "true" } }, [
    el("summary", { text: "工具栏" }),
    el("div", { class: "cy-hint", text: "按工具栏里的实际顺序排列。拖住一个可排的图标就能给它换位置，也可以在这里点箭头。" }),
    dockList,
    el("div", { class: "cy-actions" }, [dockReset])
  ]);

  var panel = el("div", { class: "cy-pop" }, [
    el("div", { class: "cy-pop-head" }, [
      el("div", { class: "cy-pop-title", text: "壁纸" }),
      el("button", { type: "button", class: "cy-pop-close", text: "\u2014", onclick: function () { closeTopPopover(); } })
    ]),    el("div", { class: "cy-row" }, [el("span", { class: "cy-row-label", text: "配色" }), skinSeg]),
    el("div", { class: "cy-row" }, [el("span", { class: "cy-row-label", text: "类型" }), typeSeg]),
    el("div", { class: "cy-row" }, [el("span", { class: "cy-row-label", text: "亮度" }), brightness, brightnessLabel]),
    el("div", { class: "cy-row" }, [el("span", { class: "cy-row-label", text: "遮罩" }), shade, shadeLabel]),
  ].concat(tuningRows).concat([
    el("div", { class: "cy-row" }, [el("span", { class: "cy-row-label", text: "质感" }), glassToggle]),
  ]).concat(glassRows).concat(avatarRows).concat(packageRows).concat([
    el("div", { class: "cy-row" }, [el("span", { class: "cy-row-label", text: "陪伴" }), petToggle]),
    el("div", { class: "cy-row" }, [randomToggle, interval, el("span", { text: "分钟" })]),
    el("div", { class: "cy-actions" }, [
      el("button", { type: "button", class: "cy-act", text: "选择壁纸", onclick: function () { hooks.openGrid(); } }),
      el("button", { type: "button", class: "cy-act", text: "＋ 添加壁纸", onclick: function () { hooks.addFiles(); } })
    ]),
    dockDetails,
    el("div", { class: "cy-hint", text: "点缩略图立即应用；点卡片右上角圆点可多选，用于移除或设为随机池。" })
  ]));

  /** Reflect the current settings in the popover's controls. */  function sync() {
    var buttons = typeSeg.querySelectorAll("button");
    for (var index = 0; index < buttons.length; index += 1) {
      buttons[index].setAttribute("data-on", String(buttons[index].dataset.type === settings.wallpaperType));
    }
    var skinButtons = skinSeg.querySelectorAll("button");
    for (var skinIndex = 0; skinIndex < skinButtons.length; skinIndex += 1) {
      skinButtons[skinIndex].setAttribute("data-on", String(skinButtons[skinIndex].dataset.skin === settings.skin));
    }
    randomToggle.textContent = settings.randomOn ? "随机轮换 · 开" : "随机轮换 · 关";
    randomToggle.setAttribute("data-primary", String(settings.randomOn));
    glassToggle.textContent = settings.glass === false ? "玻璃质感 · 关" : "玻璃质感 · 开";
    glassToggle.setAttribute("data-primary", String(settings.glass !== false));
    petToggle.textContent = settings.petOn === false ? "小昔涟 · 关" : "小昔涟 · 开";
    petToggle.setAttribute("data-primary", String(settings.petOn !== false));
    // Found by attribute rather than held in a variable: the buttons are built
    // inside an array literal and `sync` runs both before and after that array
    // exists, so a captured reference would be undefined on the first pass.
    var replyToggle = panel.querySelector('[data-reply-avatar="true"]');
    if (replyToggle !== null) {
      var replyOn = settings.replyAvatar !== false;
      replyToggle.textContent = replyOn ? "回复头像 · 开" : "回复头像 · 关";
      replyToggle.setAttribute("data-primary", String(replyOn));
    }
    interval.value = String(settings.randomMinutes);
    syncDockRows();
  }

  // The opening hook is for a reorder that happens somewhere else *while this
  // panel is open* — dragging a button in the bar, or the reset button, which is
  // in this panel but is a settings write like any other. The hook is read off
  // the node by attribute rather than kept in a module-level variable, because a
  // panel is built, closed and rebuilt, and a stale reference would update a
  // detached node while the visible one stayed wrong.
  panel.__syncDock = syncDockRows;

  // Subscribed as well as exposed.
  //
  // The hook above is push-shaped: it works only if whoever changed the setting
  // knows which panels care. A drag in the bar is not the only writer — the
  // fixed/free toggles, the arrows and the reset all write the same two keys —
  // and each of them would have to remember to look for open panels. Subscribing
  // inverts that: the panel knows about itself, and a panel with no opinion
  // simply does not subscribe.
  //
  // The unsubscribe is owned here and released on close. Without that, every
  // open would leave a listener behind for the life of the page, each one
  // holding a detached panel alive and rewriting a node nobody can see.
  var releaseDockSync = onSettings(function () {
    syncDockRows();
  });
  var closePanel = panel.__onClose;
  panel.__onClose = function () {
    releaseDockSync();
    if (typeof closePanel === "function") closePanel();
  };

  sync();
  return panel;
}

/**
 * Build the wallpaper grid popover.
 * @param {object} controller - the wallpaper controller.
 * @param {object} hooks - `{ addFiles: () => void, refresh: () => void }`.
 * @returns {HTMLElement} the popover.
 */
function buildWallpaperGrid(controller, hooks) {
  var grid = el("div", { class: "cy-grid" });
  var selection = {};
  var hint = el("div", { class: "cy-hint" });

  var removeButton = el("button", {
    type: "button",
    class: "cy-act",
    text: "移除",
    onclick: function () {
      var ids = Object.keys(selection).filter(function (id) { return selection[id]; });
      if (ids.length === 0) {
        toast("先勾选要移除的壁纸");
        return;
      }
      removeWallpapers(ids, controller, render);
    }
  });

  var randomButton = el("button", {
    type: "button",
    class: "cy-act",
    text: "随机池",
    onclick: function () {
      var ids = Object.keys(selection).filter(function (id) { return selection[id]; });
      if (ids.length === 0) {
        toast("先勾选作为随机池的壁纸");
        return;
      }
      controller.setPool(ids);
      applySettings({ randomOn: true, randomPool: ids });
      controller.reschedule();
      controller.advance();
      toast("已设为随机池 · " + ids.length + " 张", "success");
    }
  });

  var panel = el("div", { class: "cy-pop" }, [
    el("div", { class: "cy-pop-head" }, [
      el("div", { class: "cy-pop-title", text: "选择壁纸" }),
      el("button", { type: "button", class: "cy-pop-close", text: "\u2014", onclick: function () { closeTopPopover(); } })
    ]),
    grid,
    el("div", { class: "cy-actions" }, [
      removeButton,
      randomButton,
      el("button", { type: "button", class: "cy-act", text: "＋ 添加", onclick: function () { hooks.addFiles(); } }),
      el("button", { type: "button", class: "cy-act", "data-primary": "true", text: "确定", onclick: function () { closeTopPopover(); } })
    ]),
    hint
  ]);

  /** Rebuild the grid from the catalog. */
  function render() {
    clear(grid);
    var list = visible("wallpapers").slice().sort(function (left, right) {
      return Number(right.kind === "video") - Number(left.kind === "video");
    });
    if (list.length === 0) {
      grid.appendChild(el("div", { class: "cy-empty", text: "还没有壁纸。\n点「＋ 添加」从本机导入图片或视频。" }));
      hint.textContent = "";
      return;
    }
    list.forEach(function (entry) {
      var picked = selection[entry.id] === true;
      var media;
      if (entry.kind === "video") {
        // `preload="metadata"` costs two small range requests, which the host
        // half answers with 206 — the whole video is never downloaded here.
        media = el("video", {
          src: entry.url,
          muted: true,
          preload: "metadata",
          playsinline: true,
          style: { width: "100%", height: "100%", objectFit: "cover", display: "block" }
        });
      } else {
        media = el("div", {
          style: {
            width: "100%",
            height: "100%",
            backgroundImage: 'url("' + entry.url.replace(/"/g, "%22") + '")',
            backgroundSize: "cover",
            backgroundPosition: "center"
          }
        });
      }
      var card = el("div", {
        class: "cy-card",
        title: entry.label,
        dataset: {
          picked: String(picked),
          current: String(settings.wallpaper === entry.id),
          video: String(entry.kind === "video")
        },
        onclick: function () {
          controller.select(entry);
          render();
        }
      }, [media, el("div", { class: "cy-card-name", text: entry.label })]);
      card.appendChild(el("span", {
        title: "选中以用于移除 / 随机池",
        style: {
          position: "absolute", top: "5px", right: "5px", width: "18px", height: "18px",
          borderRadius: "50%", border: "1px solid rgba(255,255,255,0.6)",
          background: picked ? PALETTE.pink : "rgba(6,4,9,0.5)", cursor: "pointer"
        },
        onclick: function (event) {
          event.stopPropagation();
          selection[entry.id] = !picked;
          render();
        }
      }));
      grid.appendChild(card);
    });
    var count = Object.keys(selection).filter(function (id) { return selection[id]; }).length;
    hint.textContent = count === 0
      ? "点卡片立即应用；点右上角圆点勾选。当前：" + (controller.current() ? controller.current().label : "无")
      : "已勾选 " + count + " 张";
  }

  render();
  return panel;
}

/**
 * Hide bundled wallpapers, or delete uploaded ones into the trash.
 * @param {string[]} ids - wallpaper ids to remove.
 * @param {object} controller - the wallpaper controller.
 * @param {() => void} done - called after the catalog settles.
 * @returns {void}
 */
function removeWallpapers(ids, controller, done) {
  var hidden = (settings.hidden && settings.hidden.wallpapers) || [];
  var pending = [];

  ids.forEach(function (id) {
    var entry = findEntry("wallpapers", id);
    if (entry === null) return;
    if (entry.source === "builtin") {
      if (hidden.indexOf(id) === -1) hidden.push(id);
      return;
    }
    pending.push(del("wallpapers", entry.name));
  });

  var finish = function () {
    applySettings({ hidden: { wallpapers: hidden } });
    if (settings.wallpaper !== null && hidden.indexOf(settings.wallpaper) !== -1) {
      applySettings({ wallpaper: null });
    }
    if (controller.current() === null) controller.restore();
    toast(pending.length > 0 ? "已移除 " + ids.length + " 张（可在回收站恢复）" : "已隐藏 " + ids.length + " 张");
    done();
  };

  if (pending.length === 0) {
    finish();
    return;
  }
  Promise.all(pending).then(finish, function (error) {
    toast("移除失败：" + error.message, "error");
    finish();
  });
}

/**
 * Open a file dialog and upload the chosen files.
 * @param {string} kind - the upload kind.
 * @param {string} accept - the `accept` attribute.
 * @param {{multiple?: boolean}} [options] - selection options.
 * @returns {Promise<File[]>} the chosen files, or an empty list when cancelled.
 */
function chooseFiles(kind, accept, options) {
  return new Promise(function (resolve) {
    var input = el("input", {
      type: "file",
      accept: accept,
      multiple: (options && options.multiple) !== false,
      style: { position: "fixed", top: "-1000px", opacity: "0" },
      onchange: function () {
        var files = input.files ? Array.prototype.slice.call(input.files) : [];
        if (input.parentNode) input.parentNode.removeChild(input);
        resolve(files);
      }
    });
    document.body.appendChild(input);
    input.click();
    // A cancelled dialog fires no event; do not leave the node behind forever.
    setTimeout(function () {
      if (input.parentNode) input.parentNode.removeChild(input);
      resolve([]);
    }, 120000);
  });
}

/**
 * Upload files for a kind, reporting progress, and refresh the catalog after.
 * @param {string} kind - the upload kind.
 * @param {File[]} files - the chosen files.
 * @returns {Promise<number>} how many were stored.
 */
function uploadAll(kind, files) {
  if (files.length === 0) return Promise.resolve(0);
  toast("正在上传 " + files.length + " 个文件…");
  var chain = Promise.resolve(0);
  files.forEach(function (file) {
    chain = chain.then(function (count) {
      return uploadFile(kind, file).then(function () {
        return count + 1;
      });
    });
  });
  return chain.then(function (count) {
    return refreshManifest().then(function () {
      toast("已添加 " + count + " 个文件", "success");
      return count;
    });
  }, function (error) {
    toast("上传失败：" + error.message, "error");
    return 0;
  });
}
