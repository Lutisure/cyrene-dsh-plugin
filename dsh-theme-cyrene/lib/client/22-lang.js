/**
 * Interface language.
 *
 * ## How the host's choice is determined
 *
 * Two sources, in order:
 *
 *   1. `document.documentElement.lang`, which the host writes when it has
 *      resolved a language. This is the only signal that reflects the user's
 *      pick rather than their operating system.
 *   2. `navigator.language`, as the fallback for a host that never sets it.
 *
 * ## When the host's choice is read
 *
 * Re-read at the start of every panel build, through `refreshLanguage()`.
 *
 * It is **not** read once at load, which was the first implementation and was
 * wrong. The host writes `lang` when it has resolved a language, and on this
 * host that happens *after* the plugin's parts have run: the document briefly
 * says `lang="en"` and only later becomes `lang="zh-CN"`. Sampling once captured
 * the placeholder and left the whole interface English for the life of the page.
 *
 * Reading per *build* rather than per *string* is what keeps a panel uniform —
 * a re-read midway through would translate the top half and not the bottom.
 * Panels are rebuilt on every open, so the cost is two attribute reads each time.
 *
 * An earlier version of this comment claimed the panels already picked the new
 * value up on open. They did not; nothing recomputed `UI_LANG` after load. The
 * pixel check found it — a screenshot of the live panel, in English, on a host
 * whose own text was Chinese.
 *
 * ## How strings are translated
 *
 * Through the `el()` helper rather than at each call site. Every panel in this
 * plugin builds its labels with `el(tag, {text: …})` / `{title: …}`, and there
 * are ~120 of them; wrapping the one helper covers all of them and leaves the
 * panels reading exactly as they did. A key that is missing from the table is
 * returned unchanged — an untranslated label is a gap, and a gap that still
 * shows Chinese is easier to find than one that shows `panel.title.play`.
 *
 * Strings assembled by concatenation are **not** covered. They are the dynamic
 * ones ("氛围粒子 · 曳光", "已导出 3 个字体集"), and translating them would mean
 * matching patterns rather than literals. That is a real gap, left visible on
 * purpose rather than papered over.
 */

/** Keys are the Simplified Chinese source strings; values are the English. */
var STRINGS_EN = {
  // -- dock and shared chrome --
  "壁纸": "Wallpaper",
  "字体": "Type",
  "指针效果": "Pointer",
  "音乐": "Music",
  "音效": "Sound",
  "关闭": "Close",
  "开": "on",
  "关": "off",

  // -- the dock's own arrangement controls --
  //
  // 固定 / 可排 are the two words the interface uses for a slot's place inside
  // the bar. Deliberately not "pin": `dockPos` already means where the whole bar
  // sits on screen, and one word for two features is how a user ends up
  // describing the wrong one.
  "工具栏": "Toolbar",
  "固定": "Fixed",
  "可排": "Free",
  "上移": "Move up",
  "下移": "Move down",
  "左移": "Move left",
  "右移": "Move right",
  "恢复默认": "Reset to defaults",
  "固定位置，不参与拖动": "Holds its place; does not take part in dragging",
  "在可排队列里自由排序": "Sorts freely among the movable slots",
  "按工具栏里的实际顺序排列": "Listed in the order the bar actually shows",
  "把固定与可排都恢复为出厂排列": "Put both the fixed and the free slots back to how they shipped",

  // -- wallpaper panel --
  "类型": "Kind",
  "亮度": "Brightness",
  "遮罩": "Shade",
  "质感": "Glass",
  "陪伴": "Companion",
  "分钟": "min",
  "对比": "Contrast",
  "饱和": "Saturate",
  "不透明": "Opacity",
  "雾化": "Fog",
  "缩放": "Zoom",
  "玻璃色相": "Glass hue",
  "着色": "Tint",
  "透明度": "Transparency",
  "磨砂": "Frost",
  "选择壁纸": "Choose wallpaper",
  "＋ 添加壁纸": "+ Add wallpaper",
  "随机轮换 · 开": "Shuffle · on",
  "随机轮换 · 关": "Shuffle · off",
  "玻璃质感 · 开": "Liquid glass · on",
  "玻璃质感 · 关": "Liquid glass · off",
  "小昔涟 · 开": "Pet · on",
  "小昔涟 · 关": "Pet · off",
  "1.00 是原图": "1.00 is untouched",
  "壁纸的不透明度": "How opaque the wallpaper is",
  "模糊半径，像素": "Blur radius, px",
  "放大以藏住模糊带进来的软边": "Zoom in to hide the soft edge blur pulls in",
  "中性色里混多少主题色相": "How much of the theme hue is mixed into the neutral",
  "整栈一起变透明；1.00 是出厂配方": "The whole stack together; 1.00 is the shipped recipe",
  "dock 与浮层的背景模糊半径，像素": "Backdrop blur for the dock and popovers, px",
  "混进中性色的色相；浓度调到 0 就是纯灰": "The hue mixed into the neutral; 0 is plain grey",
  "点缩略图立即应用；点卡片右上角圆点可多选，用于移除或设为随机池。": "Click a thumbnail to apply it at once. Use the dot on a card to multi-select, for removing or building a shuffle pool.",

  // -- pointer panel --
  "点击": "Click",
  "拖尾": "Trail",
  "涟漪": "Ripple",
  "星火": "Spark",
  "两者": "Both",
  "彗尾": "Comet",
  "星尘": "Stardust",
  "主题色": "Theme",
  "彩虹": "Rainbow",
  "自定义": "Custom",
  "浓度": "Strength",
  "混合": "Blend",
  "点击落下的形状": "What a click leaves behind",
  "拖尾的质地": "What the pointer leaves behind",
  "颜色来源": "Where the colour comes from",

  // -- font panel --
  "全部输入": "All fields",
  "输入框（单独）": "Composer (separate)",
  "跟随宿主": "Host default",
  "主题强调色": "Accent",
  "粉色": "Pink",
  "紫色": "Violet",
  "青色": "Cyan",
  "琥珀": "Amber",
  "正文": "Body",
  "等宽": "Mono",
  "字号": "Size",
  "字重": "Weight",
  "细": "Light",
  "常规": "Regular",
  "中": "Medium",
  "半粗": "Semibold",
  "粗": "Bold",
  "系统默认（不覆盖）": "System default (no override)",
  "微软雅黑": "Microsoft YaHei",
  "思源宋体 / 宋体": "Source Han Serif / SimSun",
  "楷体": "KaiTi",
  "Inter / 系统无衬线": "Inter / system sans",
  "Georgia / 衬线": "Georgia / serif",
  "圆体": "Rounded",
  "更纱黑体 Mono": "Sarasa Mono",
  "字体集": "Font sets",
  "存为字体集": "Save as set",
  "导出": "Export",
  "导入": "Import",
  "删除": "Delete",
  "确认删除": "Confirm",
  "恢复宿主默认": "Restore host default",
  "全部恢复宿主默认": "Restore everything to the host default",
  "宿主默认": "Host default",
  "柔和圆体": "Soft rounded",
  "紧凑等宽": "Compact mono",
  "新字体集的名字": "Name for the new set",
  "整体字号": "Overall size",
  "全部输入取色": "Colour for all fields",
  "输入框（单独）取色": "Colour for the composer only",
  "保存当前设置为一个字体集": "Save the current settings as a font set",
  "留空 = 不覆盖宿主。改动即时生效。": "Empty means no override. Changes apply at once.",
  "光标": "Caret",
  "生效范围：正文与标题（整套阶梯）、markdown 六级标题、行内代码与代码块。": "Applies to body and headings (the whole ladder), the six markdown heading levels, inline code and code blocks.",
  "终端卡片走它自己的上游 token，一并跟着等宽字族变。": "The terminal card reads its own upstream token and follows the monospace face.",
  "输入框本身在宿主里已经有自己的光标色；这两项不填就保持原样。": "The composer already has its own caret colour; leaving these empty keeps it.",
  "直接填 font-family 列表，例如 ": "Type a font-family list, e.g. ",
  "点播放开始": "Press play to start",

  // -- music panel --
  "未选择曲目": "No track selected",
  "点播放开始": "Press play to start",
  "播放 / 暂停": "Play / pause",
  "上一首": "Previous",
  "下一首": "Next",
  "列表循环": "Repeat all",
  "单曲循环": "Repeat one",
  "随机": "Shuffle",
  "顺序播放": "In order",
  "循环方式": "Repeat mode",
  "音量": "Volume",
  "主题包": "Theme package",
  "导出主题": "Export theme",
  "导入主题": "Import theme",
  "撤销导入": "Undo import",
  "把当前设置存成一个 json": "Save the current settings as a JSON file",
  "读入一个主题包，会先留撤销点": "Read a package; a restore point is kept first",
  "回到上一个导入之前": "Go back to before the last import",
  "系统媒体": "System media",
  "没有正在播放的媒体": "Nothing is playing",
  "读不到系统媒体": "Cannot read the system session",
  "未命名": "Untitled",
  "播放中": "playing",
  "已暂停": "paused",

  // -- emotes and the main panel --
  "表情": "Emotes",
  "发送表情": "Send an emote",
  "收起": "Collapse",
  "展开": "Expand"
};

/** The language the interface is currently being built in. */
var UI_LANG = "zh";

/**
 * Pick the interface language from the host's signals.
 *
 * @returns {string} `"zh"` or `"en"`.
 */
function detectLanguage() {
  var candidates = [];
  try {
    var root = document.documentElement;
    if (root !== null && root !== undefined) {
      var declared = root.getAttribute("lang");
      if (declared) candidates.push(String(declared));
      // The host also mirrors the choice onto `data-lang` in some builds.
      var mirrored = root.getAttribute("data-lang");
      if (mirrored) candidates.push(String(mirrored));
    }
  } catch (error) {
    // A host that exposes neither keeps the navigator fallback below.
  }
  try {
    if (typeof navigator !== "undefined" && navigator.language) candidates.push(String(navigator.language));
  } catch (error) {
    // No navigator, no opinion.
  }

  for (var index = 0; index < candidates.length; index += 1) {
    var tag = candidates[index].toLowerCase();
    if (tag.indexOf("zh") === 0 || tag.indexOf("chinese") >= 0) return "zh";
    if (/^[a-z]{2}/.test(tag)) return "en";
  }
  return "zh";
}

/**
 * Translate one string if there is a translation for it.
 *
 * Exact match first. Then one controlled fallback: a title assembled as
 * `<translated noun>预设` — the face rows build theirs by appending to their
 * label, so a literal table can never hold them. The rule is narrow on purpose
 * (one suffix, both halves must resolve) rather than a general pattern matcher,
 * which would start translating things nobody asked it to.
 *
 * A miss returns the input unchanged, which is what makes an untranslated label
 * a visible gap rather than a runtime error.
 *
 * @param {string} text - the source string.
 * @returns {string} the source or its translation.
 */
function translate(text) {
  if (UI_LANG === "zh") return text;
  if (typeof text !== "string") return text;
  var hit = STRINGS_EN[text];
  if (hit !== undefined) return hit;

  var suffix = "预设";
  if (text.length > suffix.length && text.slice(-suffix.length) === suffix) {
    var head = text.slice(0, -suffix.length);
    var headEn = STRINGS_EN[head];
    if (headEn !== undefined) return headEn + " preset";
  }

  // A tooltip whose tail is a sample value: `直接填…例如 <placeholder>`. The
  // tail is user-visible content (a font stack), so it is passed through as-is.
  var prefix = "直接填 font-family 列表，例如 ";
  if (text.slice(0, prefix.length) === prefix) {
    return "Type a font-family list, e.g. " + text.slice(prefix.length);
  }
  return text;
}

/**
 * The host's declared language, as it stands right now.
 *
 * Only the host's own signals — `lang`, then the `data-lang` some builds mirror
 * it onto. Returns `""` when the host has declared nothing yet, which is a
 * different state from having declared English, and is what lets
 * `refreshLanguage` tell "no opinion yet" from "changed their mind".
 *
 * @returns {string} the raw tag, or `""`.
 */
function hostLanguage() {
  try {
    var root = document.documentElement;
    if (root === null || root === undefined) return "";
    var declared = root.getAttribute("lang");
    if (declared) return String(declared);
    var mirrored = root.getAttribute("data-lang");
    if (mirrored) return String(mirrored);
  } catch (error) {
    // A host that exposes neither keeps the navigator fallback.
  }
  return "";
}

/**
 * Re-read the host's language if it has moved since the last look.
 *
 * Called once per panel build. The check is a string compare against the signal
 * the current value came from, so an unchanged host costs nothing beyond the
 * attribute read, and a changed one re-resolves before anything is rendered.
 *
 * @returns {string} the current `UI_LANG`.
 */
function refreshLanguage() {
  var signal = hostLanguage();
  if (signal === LANG_SIGNAL) return UI_LANG;
  LANG_SIGNAL = signal;
  UI_LANG = detectLanguage();
  return UI_LANG;
}

/** The host signal `UI_LANG` was derived from. */
var LANG_SIGNAL = "";

/** Resolve once up front, so the first build has a value. */
UI_LANG = detectLanguage();
LANG_SIGNAL = hostLanguage();
