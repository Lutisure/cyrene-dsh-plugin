/**
 * Typography settings panel, including the font-set library.
 *
 * Three groups, matching how the host's tokens are actually layered:
 *
 *   1. **底座** — the two faces and the two global numbers, mapped onto
 *      `--dsw-font-family`, `--ds-font-family-code` and the size ladder.
 *   2. **分档** — the roles those numbers reach. Only roles the host declares
 *      tokens for appear; inventing one would produce a control that changes
 *      nothing.
 *   3. **字体集** — named sets: apply, save the current one, rename, delete,
 *      export, import.
 *
 * Faces are text fields rather than a picker: a web page cannot enumerate the
 * system's fonts, and a hard-coded list would be wrong on every machine but the
 * builder's. The suggestions are a convenience and anything typed is used
 * verbatim as a `font-family` stack.
 *
 * Export and import are done in the browser (`Blob` + `<a download>`, and a
 * hidden `<input type=file>`). The theme's host route offers only GET and POST,
 * so routing a settings document through it would mean inventing a second
 * storage area for data the settings document already carries.
 */

/** Faces worth suggesting; every one is used verbatim, none is assumed present. */
var FONT_SUGGESTIONS = [
  { id: "system", label: "系统默认（不覆盖）", value: "" },
  { id: "cjk-sans", label: "微软雅黑", value: '"Microsoft YaHei", "PingFang SC", sans-serif' },
  { id: "cjk-serif", label: "思源宋体 / 宋体", value: '"Source Han Serif SC", "SimSun", serif' },
  { id: "cjk-kai", label: "楷体", value: '"KaiTi", "STKaiti", serif' },
  { id: "inter", label: "Inter / 系统无衬线", value: 'Inter, -apple-system, "Segoe UI", sans-serif' },
  { id: "serif-en", label: "Georgia / 衬线", value: 'Georgia, "Times New Roman", serif' },
  { id: "rounded", label: "圆体", value: '"Yuanti SC", "Quicksand", "Nunito", sans-serif' }
];

/** Monospace faces worth suggesting. */
var MONO_SUGGESTIONS = [
  { id: "system", label: "系统默认（不覆盖）", value: "" },
  { id: "jetbrains", label: "JetBrains Mono", value: '"JetBrains Mono", Consolas, monospace' },
  { id: "cascadia", label: "Cascadia Code", value: '"Cascadia Code", "Cascadia Mono", Consolas, monospace' },
  { id: "sarasa", label: "更纱黑体 Mono", value: '"Sarasa Mono SC", Consolas, monospace' },
  { id: "consolas", label: "Consolas", value: "Consolas, monospace" }
];

/** The scale steps, as multipliers. */
var FONT_SCALES = [0.85, 0.9, 0.95, 1, 1.05, 1.1, 1.15, 1.2, 1.3];

/** The weights the host's ladder uses, plus one below it. */
var FONT_WEIGHTS = [
  { id: 0, label: "默认" },
  { id: 300, label: "细" },
  { id: 400, label: "常规" },
  { id: 500, label: "中" },
  { id: 600, label: "半粗" },
  { id: 700, label: "粗" }
];

/**
 * Build the typography popover.
 *
 * @param {object} hooks - `{ close: () => void }`, called by the head's ×.
 * @returns {HTMLElement} the popover.
 */
function buildFontPanel(hooks) {
  var close = (hooks && typeof hooks.close === "function") ? hooks.close : function () {};
  var panel = el("div", { class: "cy-pop" });

  /**
   * `{ [key]: value }` — a computed key an object literal cannot express.
   *
   * Defined before the builders below: these are `var` assignments, not hoisted
   * declarations, so a builder closing over it would capture `undefined`.
   */
  var withKey = function (key, value) {
    var patch = {};
    patch[key] = value;
    return patch;
  };

  /** The four font values as they stand right now. */
  var currentValues = function () {
    return {
      fontBodyFamily: safeFace(settings.fontBodyFamily),
      fontMonoFamily: safeFace(settings.fontMonoFamily),
      fontScale: Number(settings.fontScale) || 1,
      fontWeight: Number(settings.fontWeight) || 0
    };
  };

  /** The built-in entries plus the user's, in one list. */
  var allSets = function () {
    var user = Array.isArray(settings.fontSets) ? settings.fontSets : [];
    return FONT_BUILTIN_PRESETS.concat(user.filter(function (set) {
      return isPlainObject(set) && typeof set.id === "string" && typeof set.name === "string";
    }));
  };

  /** Put the four saved values into the live settings. */
  var applySet = function (values) {
    var patch = fontPick(values);
    // Every key is written, including the empty ones: a preset that means
    // "host default" has to be able to *clear* a face, which a merge that skips
    // empty strings would silently refuse to do.
    patch.fontBodyFamily = patch.fontBodyFamily === undefined ? "" : patch.fontBodyFamily;
    patch.fontMonoFamily = patch.fontMonoFamily === undefined ? "" : patch.fontMonoFamily;
    patch.fontScale = patch.fontScale === undefined ? 1 : patch.fontScale;
    patch.fontWeight = patch.fontWeight === undefined ? 0 : patch.fontWeight;
    applySettings(patch);
    sync();
  };

  panel.appendChild(el("div", { class: "cy-pop-head" }, [
    el("span", { class: "cy-pop-title", text: "字体" }),
    el("button", { type: "button", class: "cy-pop-close", text: "×", title: "关闭", onclick: close })
  ]));

  /** One face row: a text field plus a suggestion select. */
  var faceRow = function (label, key, suggestions, placeholder) {
    var input = el("input", {
      class: "cy-input",
      type: "text",
      value: String(settings[key] === undefined ? "" : settings[key]),
      placeholder: placeholder,
      title: "直接填 font-family 列表，例如 " + placeholder,
      onchange: function () {
        applySettings(withKey(key, safeFace(input.value)));
        sync();
      }
    });

    var pick = el("select", {
      class: "cy-input",
      title: label + "预设",
      onchange: function () {
        var chosen = suggestions[Number(pick.value)];
        input.value = chosen.value;
        applySettings(withKey(key, chosen.value));
        sync();
      }
    });
    suggestions.forEach(function (item, index) {
      pick.appendChild(el("option", { text: item.label, value: String(index), selected: index === 0 }));
    });

    return el("div", { class: "cy-row", dataset: { face: key } }, [
      el("span", { text: label, style: { minWidth: "52px" } }),
      input,
      pick
    ]);
  };

  panel.appendChild(el("div", { class: "cy-hint", text: "留空 = 不覆盖宿主。改动即时生效。" }));

  panel.appendChild(el("div", { class: "cy-row" }, [el("span", { text: "底座", style: { minWidth: "52px" } })]));
  panel.appendChild(faceRow("正文", "fontBodyFamily", FONT_SUGGESTIONS, "Inter, sans-serif"));
  panel.appendChild(faceRow("等宽", "fontMonoFamily", MONO_SUGGESTIONS, "Consolas, monospace"));

  var scaleRow = el("div", { class: "cy-row" }, [
    el("span", { text: "字号", style: { minWidth: "52px" } })
  ]);
  var scaleOut = el("span", { style: { minWidth: "42px", textAlign: "right" } });
  var scale = el("input", {
    class: "cy-seek",
    type: "range",
    min: "0",
    max: String(FONT_SCALES.length - 1),
    step: "1",
    title: "整体字号",
    oninput: function () {
      applySettings({ fontScale: FONT_SCALES[Number(scale.value)] });
      sync();
    }
  });
  scaleRow.appendChild(scale);
  scaleRow.appendChild(scaleOut);
  panel.appendChild(scaleRow);

  var weightRow = el("div", { class: "cy-row" }, [
    el("span", { text: "字重", style: { minWidth: "52px" } })
  ]);
  var weightGroup = el("div", { class: "cy-seg", dataset: { key: "fontWeight" } });
  FONT_WEIGHTS.forEach(function (item) {
    weightGroup.appendChild(el("button", {
      type: "button",
      text: item.label,
      dataset: { weight: String(item.id) },
      title: item.id === 0 ? "沿用宿主各自声明的字重" : "整条阶梯统一为 " + item.id,
      onclick: function () {
        applySettings({ fontWeight: item.id });
        sync();
      }
    }));
  });
  weightRow.appendChild(weightGroup);
  panel.appendChild(weightRow);

  panel.appendChild(el("div", { class: "cy-hint", text: "生效范围：正文与标题（整套阶梯）、markdown 六级标题、行内代码与代码块；终端卡片跟着它的上游 token 一并变。" }));

  // ---- 光标 ----
  panel.appendChild(el("div", { class: "cy-row" }, [el("span", { text: "光标", style: { minWidth: "52px" } })]));

  /**
   * One caret row: a mode select plus a colour swatch.
   *
   * A select rather than a `cy-seg` group: seven options would overflow the
   * popover's width, and the faces above already established the select idiom.
   *
   * @param {string} label - the row's name.
   * @param {string} modeKey - which setting holds the mode.
   * @param {string} customKey - which setting holds the picker's value.
   * @returns {HTMLElement} the row.
   */
  var caretRow = function (label, modeKey, customKey) {
    var swatch = el("input", {
      type: "color",
      value: String(settings[customKey] === undefined ? "#f2a7d5" : settings[customKey]),
      title: label + "取色",
      style: { width: "40px", height: "24px", padding: "0", border: "none", background: "none", cursor: "pointer" },
      oninput: function () {
        applySettings(withKey(customKey, safeFace(swatch.value)));
      }
    });

    var pick = el("select", {
      class: "cy-input",
      title: label,
      onchange: function () {
        var chosen = CARET_COLORS[Number(pick.value)];
        applySettings(withKey(modeKey, chosen.id));
        sync();
      }
    });
    CARET_COLORS.forEach(function (item, index) {
      pick.appendChild(el("option", { text: item.label, value: String(index) }));
    });

    return el("div", { class: "cy-row", dataset: { caret: modeKey } }, [
      el("span", { text: label, style: { minWidth: "52px" } }),
      pick,
      swatch
    ]);
  };

  panel.appendChild(caretRow("全部输入", "caretColor", "caretColorCustom"));
  panel.appendChild(caretRow("输入框（单独）", "caretComposerColor", "caretComposerCustom"));
  panel.appendChild(el("div", {
    class: "cy-hint",
    text: "输入框本身在宿主里已经有自己的光标色；这两项不填就保持原样。"
  }));

  // ---- 字体集 ----
  panel.appendChild(el("div", { class: "cy-row" }, [el("span", { text: "字体集", style: { minWidth: "52px" } })]));

  var list = el("div", { class: "cy-list", dataset: { fontSets: "true" } });
  panel.appendChild(list);

  /**
   * Which row is waiting for its confirmation, or null.
   *
   * Panel-scoped, for the reason spelled out on `renderSets`: a rebuild replaces
   * every row, so this cannot live in a row's closure.
   */
  var armedDeleteId = null;
  var disarmTimer = null;

  var nameInput = el("input", {
    class: "cy-input",
    type: "text",
    placeholder: "新字体集的名字",
    title: "保存当前设置为一个字体集",
    onkeydown: function (event) {
      if (event.key === "Enter") saveCurrent();
    }
  });

  /** Save the live values under the typed name, replacing a same-named set. */
  var saveCurrent = function () {
    var name = String(nameInput.value).trim();
    if (name === "") { toast("先给字体集起个名字", "warn"); return; }
    if (isReservedFontName(name)) { toast("「宿主默认」这个名字不能占用", "warn"); return; }

    var user = (Array.isArray(settings.fontSets) ? settings.fontSets : []).slice();
    var existing = null;
    for (var index = 0; index < user.length; index += 1) {
      if (user[index].name === name) { existing = user[index]; break; }
    }
    if (existing === null) {
      user.push({ id: "set-" + uid(), name: name, values: currentValues() });
    } else {
      // Overwriting rather than appending a duplicate: two sets with one name
      // would both be reachable and neither would be the one you meant.
      existing.values = currentValues();
    }
    applySettings({ fontSets: user, fontActiveSet: existing === null ? user[user.length - 1].id : existing.id });
    nameInput.value = "";
    sync();
    toast(existing === null ? "已保存字体集「" + name + "」" : "已更新字体集「" + name + "」");
  };

  var saveButton = el("button", {
    type: "button",
    class: "cy-act",
    text: "存为字体集",
    onclick: saveCurrent
  });
  panel.appendChild(el("div", { class: "cy-row" }, [nameInput, saveButton]));

  var exportButton = el("button", {
    type: "button",
    class: "cy-act",
    text: "导出",
    title: "下载一个 .json，里面有全部字体集",
    onclick: function () {
      exportFontSets();
    }
  });

  var importInput = el("input", {
    type: "file",
    accept: ".json,application/json",
    style: { display: "none" },
    onchange: function () {
      importFontSets(importInput);
    }
  });

  var importButton = el("button", {
    type: "button",
    class: "cy-act",
    text: "导入",
    title: "读入一个导出的 .json",
    onclick: function () {
      importInput.click();
    }
  });

  var resetButton = el("button", {
    type: "button",
    class: "cy-act",
    text: "恢复宿主默认",
    onclick: function () {
      applySettings({ fontBodyFamily: "", fontMonoFamily: "", fontScale: 1, fontWeight: 0, fontActiveSet: "host" });
      sync();
      toast("字体已恢复宿主默认");
    }
  });

  panel.appendChild(el("div", { class: "cy-actions" }, [exportButton, importButton, resetButton]));
  panel.appendChild(importInput);

  /** Write every set into a downloadable JSON document. */
  var exportFontSets = function () {
    var user = Array.isArray(settings.fontSets) ? settings.fontSets : [];
    var payload = {
      kind: "dsh-theme-cyrene-fontsets",
      version: 1,
      sets: FONT_BUILTIN_PRESETS.concat(user)
    };
    var text = JSON.stringify(payload, null, 2);
    try {
      var blob = new Blob([text], { type: "application/json" });
      var url = URL.createObjectURL(blob);
      var link = el("a", { href: url, download: "cyrene-fontsets.json" });
      document.body.appendChild(link);
      link.click();
      if (link.parentNode) link.parentNode.removeChild(link);
      // Revoked on a later tick: revoking synchronously races the download in
      // some engines and produces an empty file.
      setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
      toast("已导出 " + payload.sets.length + " 个字体集");
    } catch (error) {
      toast("导出失败，已改为复制到剪贴板", "warn");
      copyText(text);
    }
  };

  /**
   * Read a chosen file and merge its sets in.
   *
   * Nothing is applied directly: an import adds to the library so the user can
   * look at what arrived before it changes how the interface renders.
   */
  var importFontSets = function (input) {
    var file = input.files && input.files[0];
    if (file === undefined || file === null) return;
    var reader = new FileReader();
    reader.onload = function () {
      var parsed = null;
      try {
        parsed = JSON.parse(String(reader.result));
      } catch (error) {
        parsed = null;
      }
      if (parsed === null) { toast("这个文件不是有效的 JSON", "warn"); return; }
      var incoming = isPlainObject(parsed) ? parsed.sets : parsed;
      if (!Array.isArray(incoming)) { toast("文件里没有字体集列表", "warn"); return; }

      var user = (Array.isArray(settings.fontSets) ? settings.fontSets : []).slice();
      var taken = {};
      for (var index = 0; index < user.length; index += 1) taken[user[index].name] = true;
      for (var builtin = 0; builtin < FONT_BUILTIN_PRESETS.length; builtin += 1) taken[FONT_BUILTIN_PRESETS[builtin].name] = true;

      var added = 0;
      var skipped = 0;
      for (var entry = 0; entry < incoming.length; entry += 1) {
        var candidate = incoming[entry];
        if (!isPlainObject(candidate)) { skipped += 1; continue; }
        var name = String(candidate.name === undefined ? "" : candidate.name).trim();
        var values = fontPick(candidate.values === undefined ? candidate : candidate.values);
        if (name === "" || isReservedFontName(name) || taken[name] === true || Object.keys(values).length === 0) {
          skipped += 1;
          continue;
        }
        user.push({ id: "set-" + uid(), name: name, values: values });
        taken[name] = true;
        added += 1;
      }
      applySettings({ fontSets: user });
      sync();
      toast(added === 0 ? "没有可导入的字体集" : "导入 " + added + " 个" + (skipped > 0 ? "，跳过 " + skipped + " 个" : ""), added === 0 ? "warn" : "info");
      input.value = "";
    };
    reader.onerror = function () {
      toast("读不了这个文件", "warn");
      input.value = "";
    };
    reader.readAsText(file);
  };

  /**
   * Rebuild the set list.
   *
   * Rebuilt whole rather than patched: the list is short, and a row that has to
   * rename or delete its own entry is much easier to get right when every row is
   * built from the current document.
   *
   * The armed-delete state lives **here**, not inside the row's handler, and is
   * re-applied on every rebuild. Keeping it in a closure looked right and was
   * not: the first click changes a label, `sync()` rebuilds the list from the
   * document, and the armed button is thrown away along with its closure — so
   * the second click landed on a fresh, unarmed button and nothing was ever
   * deleted.
   */
  var renderSets = function () {
    while (list.firstChild) list.removeChild(list.firstChild);
    var sets = allSets();
    var active = String(settings.fontActiveSet === undefined ? "" : settings.fontActiveSet);

    for (var index = 0; index < sets.length; index += 1) {
      var set = sets[index];
      var builtin = index < FONT_BUILTIN_PRESETS.length;

      var applyButton = el("button", {
        type: "button",
        class: "cy-act",
        text: set.name,
        title: builtin ? "内置字体集" : "点一下应用这个字体集",
        "data-on": String(set.id === active),
        onclick: function (chosen) {
          return function () {
            applySet(chosen.values);
            applySettings({ fontActiveSet: chosen.id });
            sync();
          };
        }(set)
      });

      var row = el("div", { class: "cy-row", dataset: { setRow: set.id } }, [applyButton]);

      if (!builtin) {
        var removeButton = el("button", {
          type: "button",
          class: "cy-act",
          text: armedDeleteId === set.id ? "确认删除" : "删除",
          "data-armed": String(armedDeleteId === set.id),
          title: "删除这个字体集"
        });
        // Wired with `addEventListener` rather than `button.onclick = …`: the
        // test harness (like any listener-list implementation) dispatches only
        // to registered listeners, so an assigned `onclick` property is a
        // handler no click ever reaches. Assigning the property was how this
        // read naturally, and it made the delete button inert.
        removeButton.addEventListener("click", function (chosen) {
          return function () {
            if (armedDeleteId !== chosen.id) {
              // Two-step rather than `confirm()`: a native dialog blocks the
              // page, and this panel lives inside the app's own window.
              armedDeleteId = chosen.id;
              if (disarmTimer !== null) clearTimeout(disarmTimer);
              disarmTimer = setTimeout(function () {
                armedDeleteId = null;
                disarmTimer = null;
                renderSets();
              }, 3000);
              renderSets();
              return;
            }
            if (disarmTimer !== null) clearTimeout(disarmTimer);
            disarmTimer = null;
            armedDeleteId = null;
            var remaining = (Array.isArray(settings.fontSets) ? settings.fontSets : []).filter(function (candidate) {
              return candidate.id !== chosen.id;
            });
            applySettings({
              fontSets: remaining,
              fontActiveSet: settings.fontActiveSet === chosen.id ? "host" : settings.fontActiveSet
            });
            sync();
            toast("已删除「" + chosen.name + "」");
          };
        }(set));
        row.appendChild(removeButton);
      }

      list.appendChild(row);
    }

    var user = Array.isArray(settings.fontSets) ? settings.fontSets.length : 0;
    if (user === 0) {
      list.appendChild(el("div", { class: "cy-hint", text: "还没有自定义字体集。调好上面几项，起个名字存下来。" }));
    }
  };

  /** Re-read every control from the store. */
  function sync() {
    panel.querySelectorAll("[data-face]").forEach(function (row) {
      var key = row.dataset.face;
      var input = row.querySelectorAll("input")[0];
      if (input !== undefined) input.value = String(settings[key] === undefined ? "" : settings[key]);
    });

    var index = FONT_SCALES.indexOf(Number(settings.fontScale));
    scale.value = String(index < 0 ? 3 : index);
    scaleOut.textContent = Math.round(Number(settings.fontScale) * 100) + "%";

    panel.querySelectorAll(".cy-seg").forEach(function (group) {
      group.dataset.value = String(settings[group.dataset.key]);
      group.querySelectorAll("button").forEach(function (button) {
        if (button.dataset.weight === undefined) return;
        button.dataset.on = String(Number(button.dataset.weight) === Number(settings.fontWeight));
      });
    });

    panel.querySelectorAll("[data-caret]").forEach(function (row) {
      var modeKey = row.dataset.caret;
      var customKey = modeKey === "caretColor" ? "caretColorCustom" : "caretComposerCustom";
      var pick = row.querySelectorAll("select")[0];
      var swatch = row.querySelectorAll("input")[0];
      if (pick !== undefined) {
        var at = CARET_COLORS.findIndex(function (item) {
          return item.id === String(settings[modeKey]);
        });
        pick.value = String(at < 0 ? 0 : at);
      }
      // The picker is only meaningful for `custom`, so it hides otherwise
      // rather than sitting there looking editable.
      if (swatch !== undefined) {
        swatch.style.display = String(settings[modeKey]) === "custom" ? "" : "none";
      }
    });

    renderSets();
  }

  sync();
  return panel;
}
