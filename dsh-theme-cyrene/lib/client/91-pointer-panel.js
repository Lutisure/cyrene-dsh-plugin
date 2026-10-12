/**
 * Pointer-effects settings panel.
 *
 * Lives in `90-panel.js` next to the other popovers rather than in its own
 * build part: the effects themselves are `55-pointer.js`, and a second file
 * just for their three rows of controls would put the two halves of one
 * feature in different places.
 *
 * Every control writes through `applySettings`, which is what persists and
 * re-broadcasts — the panel never touches the canvas directly, so a change made
 * from here behaves exactly like one made from the dock.
 */

/**
 * Build the pointer-effects popover: what a click leaves, what a drag leaves.
 *
 * Each control group carries the setting key it drives in `dataset.key`, so
 * `sync` reads the store by name instead of inferring it from the group's
 * position — a positional mapping silently points at the wrong setting the
 * moment a row is inserted above it.
 *
 * @param {object} hooks - `{ close: () => void }`, called by the head's ×.
 * @returns {HTMLElement} the popover.
 */
function buildPointerPanel(hooks) {
  var close = (hooks && typeof hooks.close === "function") ? hooks.close : function () {};

  /** `{ [key]: value }` — a computed key, which an object literal cannot express. */
  var withKey = function (key, value) {
    var patch = {};
    patch[key] = value;
    return patch;
  };

  /** A `cy-seg` group bound to one setting key. */
  var segment = function (items, key, describe) {
    var group = el("div", { class: "cy-seg", dataset: { key: key } });
    items.forEach(function (item) {
      group.appendChild(el("button", {
        type: "button",
        text: item.label,
        dataset: { option: item.id },
        title: describe === undefined ? item.label : describe(item),
        onclick: function () {
          applySettings(withKey(key, item.id));
          group.dataset.value = item.id;
          sync();
        }
      }));
    });
    group.dataset.value = String(settings[key]);
    return group;
  };

  /** A labelled range row that keeps its own readout in step. */
  var range = function (label, key, from, to, step, scale) {
    var input = el("input", {
      class: "cy-seek",
      type: "range",
      min: String(from),
      max: String(to),
      step: String(step),
      value: String(Math.round(Number(settings[key]) * scale)),
      title: label,
      oninput: function () {
        applySettings(withKey(key, Number(input.value) / scale));
        readout.textContent = input.value + "%";
      }
    });
    var readout = el("span", {
      text: Math.round(Number(settings[key]) * scale) + "%",
      style: { minWidth: "42px", textAlign: "right" }
    });
    return el("div", { class: "cy-row", title: label }, [
      el("span", { text: label, style: { minWidth: "64px" } }),
      input,
      readout
    ]);
  };

  /** A colour swatch, shown only while its colour mode is `custom`. */
  var swatch = function (label, key, fallback) {
    var input = el("input", {
      type: "color",
      value: String(settings[key] || fallback),
      title: label,
      style: { width: "44px", height: "24px", padding: "0", border: "none", background: "none", cursor: "pointer" },
      oninput: function () {
        applySettings(withKey(key, input.value));
      }
    });
    return el("div", { class: "cy-row", dataset: { swatch: key } }, [
      el("span", { text: label, style: { minWidth: "64px" } }),
      input
    ]);
  };

  var panel = el("div", { class: "cy-pop" });

  panel.appendChild(el("div", { class: "cy-pop-head" }, [
    el("span", { class: "cy-pop-title", text: "指针效果" }),
    el("button", { type: "button", class: "cy-pop-close", text: "×", title: "关闭", onclick: close })
  ]));

  panel.appendChild(el("div", { class: "cy-hint", text: "叠加层，不拦指针；关掉即不排帧。" }));

  panel.appendChild(el("div", { class: "cy-row" }, [el("span", { text: "点击", style: { minWidth: "64px" } })]));
  panel.appendChild(segment(CLICK_KINDS, "clickEffect", function (kind) {
    return kind.id === "both" ? "圆环与星火同时出现" : (kind.id === "off" ? "不留下任何东西" : "在落点留下" + kind.label);
  }));
  panel.appendChild(segment(EFFECT_COLOR_MODES, "clickColor"));
  panel.appendChild(swatch("落点取色", "clickColorCustom", "#ff8fd0"));
  panel.appendChild(range("落点浓度", "clickOpacity", 10, 100, 5, 100));

  panel.appendChild(el("div", { class: "cy-row" }, [el("span", { text: "拖尾", style: { minWidth: "64px" } })]));
  panel.appendChild(segment(TRAIL_KINDS, "trailEffect", function (kind) {
    if (kind.id === "off") return "不留下任何东西";
    return kind.id === "comet" ? "一条逐段收细、尾部渐隐的光带" : "按步距留在原地的亮点";
  }));
  panel.appendChild(segment(EFFECT_COLOR_MODES, "trailColor"));
  panel.appendChild(swatch("拖尾取色", "trailColorCustom", "#8fe8ff"));
  panel.appendChild(range("拖尾浓度", "trailOpacity", 10, 100, 5, 100));

  /**
   * Re-read every control from `settings`.
   *
   * The panel is not the only writer — a restored theme pack can change these
   * too — so each control follows the store rather than trusting what it last
   * put there itself.
   */
  function sync() {
    panel.querySelectorAll(".cy-seg").forEach(function (group) {
      var key = group.dataset.key;
      group.dataset.value = String(settings[key]);
    });
    panel.querySelectorAll("[data-swatch]").forEach(function (row) {
      var key = row.dataset.swatch;
      var modeKey = key === "clickColorCustom" ? "clickColor" : "trailColor";
      row.style.display = settings[modeKey] === "custom" ? "" : "none";
    });
    panel.dataset.active = String(settings.clickEffect !== "off" || settings.trailEffect !== "off");
  }

  sync();
  return panel;
}
