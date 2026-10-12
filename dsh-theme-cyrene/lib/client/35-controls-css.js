/**
 * Stylesheet for the plugin's own controls: the collapsible dock, its
 * popovers, the wallpaper grid, the music player, the boot overlay and the
 * emote.
 *
 * Colours derive from {@link THEME}, and the panel surfaces are deliberately
 * near-opaque. A translucent panel sitting on top of another panel makes the
 * text behind it read as ghosting, which is much worse than losing a little
 * translucency — the frosted look comes from the backdrop blur instead.
 */

/**
 * The plugin's own control stylesheet.
 *
 * A function rather than a top-level constant: the rules bake in roughly
 * seventy `THEME` values, and a skin switch replaces those. A constant would
 * have been frozen at load, and the interface would have kept the old palette
 * while the token overrides changed underneath it.
 *
 * @returns {string} the stylesheet text.
 */
function controlsCSS() {
  return [
    /* ---------- 只给读屏用的文字 ---------- */
    /* ⚠️ 这一条 2026-10-11 补的，而它本来就该在这儿。
     *
     * `90-panel.js` 那个 live region 用了 `class: "cy-sr"` —— 名字取得对、语义也对，
     * **但样式里从来没有 `.cy-sr`。** 于是「视觉隐藏」这件事只存在于类名里：
     * 它实际是个普通 div，reorder 的提示语写进去就**一直挂在屏幕上**。
     *
     * 症状是「调完按键位置之后，那句『字体 已移到第 4 位』不消失」。
     *
     * 这类错读代码读不出来 —— **类名看着完全正确。** 只有把用到的类名和样式对一遍才看得见，
     * 所以顺带写了 `tools/audit-client-classes.mjs` 扫全部 75 个类名。
     *
     * 下面这六行是有意冗余的：`clip` 是给老浏览器的，`clip-path` 是现代的，
     * `width/height: 1px` 兜住不支持前两者的。**只留一种会让某些环境里它重新出现。** */
    ".cy-sr {",
    "  position: absolute;",
    "  width: 1px;",
    "  height: 1px;",
    "  margin: -1px;",
    "  padding: 0;",
    "  overflow: hidden;",
    "  clip: rect(0 0 0 0);",
    "  clip-path: inset(50%);",
    "  white-space: nowrap;",
    "  border: 0;",
    "}",

    /* ---------- dock ---------- */
    /* One positioned wrapper holds both states, so folding away does not move
       the control. */
    ".cy-dock-wrap { position: fixed; z-index: 2147483000; }",
    ".cy-dock-wrap[data-collapsed=\"true\"] .cy-dock { display: none; }",
    ".cy-dock-wrap[data-collapsed=\"false\"] .cy-dot { display: none; }",
    ".cy-dock {",
    "  display: flex;",
    "  align-items: center;",
    "  gap: 2px;",
    "  padding: 6px;",
    "  border-radius: 999px;",
    "  background: " + tint(THEME.surface, THEME.alpha.glass) + ";",
    "  border: 1px solid " + tint(THEME.purple, 0.28) + ";",
    "  box-shadow: 0 14px 40px rgba(0,0,0,0.44), inset 0 1px 0 rgba(255,255,255,0.10);",
    // Was a third, independent copy of the material recipe — `blur(20px)
    // saturate(155%)` — while the glass layer set 40px/200% on the same element
    // and the theme layer set 30px/180% on the sidebar. One intent, three
    // numbers, none of them adjustable. The values come from `THEME.blur` now.
    "  backdrop-filter: blur(" + THEME.blur.menu + ") saturate(" + THEME.blur.saturate + ");",
    "  -webkit-backdrop-filter: blur(" + THEME.blur.menu + ") saturate(" + THEME.blur.saturate + ");",
    "  color: " + PALETTE.text + ";",
    "  font-family: inherit;",
    "  user-select: none;",
    "  touch-action: none;",
    "}",
    ".cy-dock-wrap[data-dragging=\"true\"] .cy-dock { cursor: grabbing; }",
    ".cy-dock-handle {",
    "  width: 15px;",
    "  align-self: stretch;",
    "  display: flex;",
    "  align-items: center;",
    "  justify-content: center;",
    "  cursor: grab;",
    "  color: " + tint(THEME.purple, 0.55) + ";",
    "  font-size: 12px;",
    "  letter-spacing: -1px;",
    "}",
    /* The two groups. They are containers rather than one flat row because a
       button keeps its identity across a reorder, and a group node is what makes
       "move it to index 2 of the free slots" a DOM operation instead of a
       coordinate one. */
    ".cy-btn-group { display: flex; align-items: center; gap: 2px; }",
    /* The rule between the fixed slots and the movable ones. Hidden when either
       side is empty: a boundary with nothing beyond it marks a division that is
       not there. */
    ".cy-divider {",
    "  width: 1px;",
    "  align-self: stretch;",
    "  margin: 2px 4px;",
    "  background: " + tint(THEME.purple, 0.34) + ";",
    "}",
    ".cy-divider[data-hidden=\"true\"] { display: none; }",
    /* The insertion point, drawn as a slot-shaped gap. Deliberately a gap and
       not a highlighted tile: the question a reader has mid-drag is where the
       button will land, and a highlight answers a different one — which item
       they are near — differently at the two ends of the group. */
    ".cy-drop {",
    "  width: 36px;",
    "  height: 36px;",
    "  flex: none;",
    "  border-radius: 999px;",
    "  background: " + tint(THEME.pink, 0.16) + ";",
    "  box-shadow: inset 0 0 0 1px " + tint(THEME.pink, 0.45) + ";",
    "}",
    ".cy-btn {",
    "  min-width: 36px;",
    "  height: 36px;",
    "  padding: 0 11px;",
    "  border: 0;",
    "  border-radius: 999px;",
    "  background: transparent;",
    "  color: " + tint(THEME.text, 0.80) + ";",
    "  font: inherit;",
    "  font-size: 12px;",
    "  letter-spacing: 0.03em;",
    "  line-height: 1;",
    "  cursor: pointer;",
    "  display: inline-flex;",
    "  align-items: center;",
    "  justify-content: center;",
    "  gap: 6px;",
    // A drag that starts on a button is the button's own reorder. Without this
    // the browser also begins a text selection from the same press, and the
    // label being unclipped on hover would make that visible.
    "  user-select: none;",
    "  touch-action: none;",
    "  transition: background 160ms ease, color 160ms ease, transform 160ms ease;",
    "}",
    ".cy-btn:hover { background: " + tint(THEME.pink, 0.20) + "; color: " + PALETTE.text + "; }",
    ".cy-btn:active { transform: scale(0.94); }",
    ".cy-btn[data-on=\"true\"] { background: " + tint(THEME.pink, 0.34) + "; color: " + THEME.inkDeep + "; }",
    ".cy-btn:focus-visible { outline: 2px solid " + tint(THEME.pink, 0.80) + "; outline-offset: 2px; }",
    /* The button being carried. Dimmed rather than removed, so the gap that
       travels with it reads as a slot it is about to occupy. */
    ".cy-btn[data-dragging=\"true\"] { opacity: 0.5; cursor: grabbing; }",
    ".cy-ico { width: 16px; height: 16px; flex: none; display: block; pointer-events: none; }",
    /* The word, in the accessibility tree but not on the screen: `clip-path`
       leaves it readable to a screen reader and to `textContent`, where
       `display: none` would take the button's name away with it. Revealed on
       hover, on keyboard focus, and while the button's own panel is open —
       which is when the icon alone stops being unambiguous. */
    ".cy-btn-label {",
    "  position: absolute;",
    "  width: 1px;",
    "  height: 1px;",
    "  padding: 0;",
    "  margin: -1px;",
    "  overflow: hidden;",
    "  white-space: nowrap;",
    "  clip-path: inset(50%);",
    "}",
    /* Hover and focus only — deliberately NOT `[data-on]`.
       An earlier version also expanded the label for a subsystem that was
       switched on, which reads as helpful until you notice what it does to the
       bar: the label is what sets the button's width, so turning the particles
       off made the whole pill narrower and slid every button to its right. The
       bar changed shape every time a setting changed, which is a worse kind of
       clutter than the one the icons were meant to fix.
       `data-on` still colours the button, so which subsystems are running is
       visible at a glance; it just does it without moving anything. */
    /* Keyboard focus only — hovering does NOT expand the label.
       Hover-expand was the first version, on the reasoning that a pointer
       resting on an icon has asked what it is. In use it is the opposite: the
       bar changes width under the cursor as you move along it to reach a
       different slot, so every button between here and there slides sideways and
       the one you were aiming at is no longer under the pointer. The label is
       still the button's accessible name, and the `title` tooltip still answers
       the question after a pause, without moving anything.
       `data-on` is not one of the triggers either — see below for why. */
    ".cy-btn:focus-visible .cy-btn-label {",
    "  position: static;",
    "  width: auto;",
    "  height: auto;",
    "  margin: 0;",
    "  overflow: visible;",
    "  clip-path: none;",
    "}",
    /* The same text, and the same words read aloud: only what is drawn changes. */
    ".cy-btn:focus-visible { padding: 0 12px 0 10px; }",
    /* The one place the bar's size is decided.
       `.cy-btn` is shared with the music transport and the mini player, so a
       change made there for a 40 px play button lands on the dock too. This rule
       is what keeps a dock icon a 32 px circle whatever those do; it was written
       because exactly that leak was about to happen, when the transport grew its
       buttons and the bar quietly grew with them. */
    ".cy-btn-group .cy-btn { min-width: 32px; height: 32px; padding: 0 8px; }",
    ".cy-btn-group .cy-btn:focus-visible { padding: 0 11px 0 9px; }",
    /* ---------- the toolbar rows, in the Scene panel ---------- */
    ".cy-dockrow { display: flex; align-items: center; gap: 6px; margin: 5px 0; }",
    ".cy-dockrow-name { flex: 1; min-width: 0; }",
    ".cy-dockrow .cy-ico { width: 16px; height: 16px; flex: none; color: " + tint(THEME.purple, 0.85) + "; }",
    ".cy-dockrow-btn {",
    "  min-width: 30px; height: 24px; padding: 0 7px; border-radius: 8px; cursor: pointer;",
    "  border: 1px solid " + tint(THEME.purple, 0.32) + "; background: rgba(255,255,255,0.08);",
    "  color: inherit; font: inherit; font-size: 11px; line-height: 1;",
    "}",
    ".cy-dockrow-btn:hover { background: " + tint(THEME.pink, 0.22) + "; }",
    ".cy-dockrow-btn:disabled { opacity: 0.34; cursor: default; }",
    /* The fixed/free toggle reads as a word, not as an icon: which of the two
       states a slot is in is the whole point of the row, and a checkmark does not
       say which state it is describing. */
    ".cy-dockrow-toggle { min-width: 52px; }",
    ".cy-dockrow-toggle[data-fixed=\"true\"] { background: " + tint(THEME.pink, 0.34) + "; border-color: transparent; color: " + THEME.inkDeep + "; }",
    /* The collapsed state: her portrait in a small glowing circle. */
    ".cy-dot-avatar { padding: 0; overflow: hidden; }",
    ".cy-avatar { display: block; width: 100%; height: 100%; object-fit: cover; border-radius: 50%; }",
    ".cy-dot {",
    "  width: 42px;",
    "  height: 42px;",
    "  border-radius: 50%;",
    "  display: grid;",
    "  place-items: center;",
    "  padding: 0;",
    "  border: 1px solid " + tint(THEME.pink, 0.44) + ";",
    "  background: " + tint(THEME.surface, 0.90) + ";",
    "  color: " + THEME.pinkSoft + ";",
    "  font: inherit;",
    "  font-size: 16px;",
    "  cursor: pointer;",
    "  box-shadow: 0 10px 26px rgba(0,0,0,0.44), 0 0 18px " + tint(THEME.pink, 0.30) + ";",
    "  backdrop-filter: blur(18px) saturate(150%);",
    "  -webkit-backdrop-filter: blur(18px) saturate(150%);",
    "  transition: transform 200ms ease, box-shadow 200ms ease;",
    "}",
    ".cy-dot:hover { transform: scale(1.08); box-shadow: 0 12px 30px rgba(0,0,0,0.50), 0 0 26px " + tint(THEME.pink, 0.46) + "; }",
    ".cy-dot:focus-visible { outline: 2px solid " + tint(THEME.pink, 0.80) + "; outline-offset: 3px; }",

    /* ---------- popovers ---------- */
    /* Near-opaque: these stack over dialogs, and translucency here is exactly
       what produced the double-image text. */
    "@keyframes cy-pop-in { from { opacity: 0; transform: translateY(8px) scale(0.94); } to { opacity: 1; transform: none; } }",
    ".cy-pop {",
    "  position: fixed;",
    "  z-index: 2147483001;",
    "  min-width: 250px;",
    "  max-width: min(460px, 92vw);",
    "  padding: 14px;",
    "  border-radius: " + THEME.radius.lg + ";",
    "  background: " + tint(THEME.surfaceHigh, THEME.alpha.glass) + ";",
    "  border: 1px solid " + hairline(THEME.border.l2) + ";",
    "  box-shadow: " + THEME.shadow.panel + ";",
    // The dock lives bottom-left, so the panel grows out of it: anchored at the
    // bottom-left corner, short, and on an Apple-ish curve.
    "  transform-origin: 0 100%;",
    "  animation: cy-pop-in 180ms cubic-bezier(0.32, 0.72, 0, 1);",
    "  backdrop-filter: blur(24px) saturate(160%);",
    "  -webkit-backdrop-filter: blur(24px) saturate(160%);",
    "  color: " + PALETTE.text + ";",
    "  font-family: inherit;",
    "  font-size: 13px;",
    "}",
    ".cy-pop-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 10px; }",
    ".cy-pop-title { font-size: 13px; font-weight: 600; letter-spacing: 0.02em; color: " + THEME.pinkSoft + "; }",
    ".cy-pop-close {",
    "  width: 24px; height: 24px; border: 0; border-radius: 50%;",
    "  background: rgba(255,255,255,0.10); color: inherit; cursor: pointer; font: inherit; line-height: 1;",
    "}",
    ".cy-pop-close:hover { background: " + tint(THEME.pink, 0.30) + "; }",
    ".cy-row { display: flex; align-items: center; gap: 8px; margin: 8px 0; }",
    ".cy-row-label { min-width: 52px; color: " + tint(THEME.text, 0.68) + "; }",
    ".cy-seg { display: inline-flex; padding: 3px; gap: 2px; border-radius: 999px; background: rgba(255,255,255,0.08); }",
    ".cy-seg button {",
    "  border: 0; border-radius: 999px; padding: 5px 11px; background: transparent;",
    "  color: " + tint(THEME.text, 0.76) + "; font: inherit; font-size: 12px; cursor: pointer;",
    "}",
    ".cy-seg button[data-on=\"true\"] { background: " + tint(THEME.pink, 0.38) + "; color: " + THEME.inkDeep + "; }",
    ".cy-input {",
    "  flex: 1; min-width: 0; padding: 6px 10px; border-radius: 10px;",
    "  border: 1px solid " + tint(THEME.purple, 0.30) + "; background: " + tint(THEME.inkDeep, 0.72) + ";",
    "  color: inherit; font: inherit; font-size: 12px;",
    "}",
    ".cy-hint { margin-top: 8px; color: " + tint(THEME.text, 0.52) + "; font-size: 11px; line-height: 1.5; }",

    /* ---------- wallpaper grid ---------- */
    ".cy-grid {",
    "  display: grid;",
    "  grid-template-columns: repeat(3, 1fr);",
    "  gap: 8px;",
    "  max-height: 264px;",
    "  overflow-y: auto;",
    "  padding-right: 4px;",
    "}",
    ".cy-grid::-webkit-scrollbar { width: 8px; }",
    ".cy-grid::-webkit-scrollbar-thumb { background: " + tint(THEME.purple, 0.30) + "; border-radius: 4px; }",
    ".cy-card {",
    "  position: relative;",
    "  aspect-ratio: 1 / 1;",
    "  border-radius: " + THEME.radius.sm + ";",
    "  overflow: hidden;",
    "  cursor: pointer;",
    "  background: rgba(255,255,255,0.07) center/cover no-repeat;",
    "  border: 2px solid transparent;",
    "  transition: border-color 160ms ease, transform 160ms ease;",
    "}",
    ".cy-card:hover { transform: translateY(-2px); }",
    ".cy-card[data-picked=\"true\"] { border-color: " + THEME.pink + "; }",
    ".cy-card[data-current=\"true\"]::before {",
    "  content: \"\\2713\";",
    "  position: absolute; top: 5px; left: 5px; width: 18px; height: 18px;",
    "  display: grid; place-items: center; border-radius: 50%;",
    "  background: " + THEME.pink + "; color: " + THEME.inkDeep + "; font-size: 11px; font-weight: 700;",
    "}",
    ".cy-card[data-video=\"true\"]::after {",
    "  content: \"\\25B6\";",
    "  position: absolute; bottom: 5px; right: 5px; width: 18px; height: 18px;",
    "  display: grid; place-items: center; border-radius: 50%;",
    "  background: rgba(6,4,9,0.78); color: " + THEME.pinkSoft + "; font-size: 9px;",
    "}",
    ".cy-card-name {",
    "  position: absolute; inset: auto 0 0 0; padding: 12px 5px 4px;",
    "  font-size: 10px; line-height: 1.2; color: " + tint(THEME.text, 0.92) + ";",
    "  background: linear-gradient(to top, rgba(6,4,9,0.90), transparent);",
    "  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;",
    "}",
    ".cy-empty { padding: 18px 6px; text-align: center; color: " + tint(THEME.text, 0.54) + "; font-size: 12px; line-height: 1.6; }",

    /* ---------- actions ---------- */
    ".cy-actions { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; }",
    ".cy-act {",
    "  flex: 1 1 auto; padding: 7px 12px; border-radius: 10px; cursor: pointer;",
    "  border: 1px solid " + tint(THEME.purple, 0.32) + "; background: rgba(255,255,255,0.08);",
    "  color: inherit; font: inherit; font-size: 12px; white-space: nowrap;",
    "}",
    ".cy-act:hover { background: " + tint(THEME.pink, 0.22) + "; }",
    ".cy-act[data-primary=\"true\"] { background: " + tint(THEME.pink, 0.40) + "; border-color: transparent; color: " + THEME.inkDeep + "; }",
    ".cy-act[data-danger=\"true\"]:hover { background: " + tint(THEME.danger, 0.30) + "; }",
    ".cy-act:disabled { opacity: 0.42; cursor: default; }",

    /* ---------- music ---------- */
    ".cy-player { width: min(340px, 92vw); }",
    ".cy-disc-row { display: flex; align-items: center; gap: 12px; }",
    ".cy-disc {",
    "  width: 62px; height: 62px; border-radius: 50%; flex: none;",
    "  background: rgba(255,255,255,0.08) center/cover no-repeat;",
    "  border: 1px solid " + tint(THEME.pink, 0.34) + ";",
    "  box-shadow: inset 0 0 0 8px rgba(6,4,9,0.55);",
    "}",
    ".cy-disc[data-spinning=\"true\"] { animation: cy-spin 9s linear infinite; }",
    "@keyframes cy-spin { to { transform: rotate(360deg); } }",
    ".cy-track-name { font-size: 13px; font-weight: 600; }",
    ".cy-track-sub { margin-top: 3px; font-size: 11px; color: " + tint(THEME.text, 0.58) + "; }",
    // The system session block, under the plugin's own player. Deliberately quieter
    // than the player above it: it reads out something the theme does not own, so it
    // should not compete with the transport that it does own.
    ".cy-np {",
    "  margin-top: 12px; padding-top: 10px;",
    "  border-top: 1px solid " + hairline(THEME.border.l1) + ";",
    "}",
    ".cy-np-title { font-size: 12px; color: " + tint(THEME.text, 0.86) + "; }",
    ".cy-np-sub { margin-top: 3px; font-size: 11px; color: " + tint(THEME.text, 0.52) + "; }",
    ".cy-np-bar {",
    "  margin-top: 8px; height: 4px; border-radius: 2px; overflow: hidden;",
    "  background: rgba(255,255,255,0.16);",
    "}",
    ".cy-np-fill {",
    "  height: 100%; width: 0; border-radius: 2px;",
    "  background: " + tint(THEME.pink, 0.9) + ";",
    "  transition: width 240ms linear;",
    "}",
    ".cy-np-bar[data-on=\"false\"] { opacity: 0.4; }",
    ".cy-np-controls { display: flex; gap: 6px; margin-top: 8px; }",
    ".cy-np-controls .cy-act { flex: 1; }",
    ".cy-progress { display: flex; align-items: center; gap: 8px; margin-top: 10px; font-size: 11px; font-variant-numeric: tabular-nums; }",
    ".cy-seek { flex: 1; appearance: none; height: 4px; border-radius: 2px; background: rgba(255,255,255,0.20); cursor: pointer; }",
    ".cy-seek::-webkit-slider-thumb {",
    "  appearance: none; width: 12px; height: 12px; border-radius: 50%;",
    "  background: " + THEME.pink + "; border: 0; cursor: pointer;",
    "}",
    ".cy-transport { display: flex; align-items: center; justify-content: center; gap: 10px; margin-top: 10px; }",
    ".cy-transport .cy-btn { min-width: 40px; height: 40px; font-size: 15px; }",
    ".cy-transport .cy-btn[data-main=\"true\"] { background: " + tint(THEME.pink, 0.40) + "; color: " + THEME.inkDeep + "; min-width: 46px; height: 46px; }",
    // The playlist is a window, not a list: four rows and a scrollbar. A growing
    // panel pushed the dock button off the bottom of the screen once the library
    // got long, and the button is the only way back to the panel.
    //
    // The height is a plain 108px rather than calc(4 * var(--cy-song-h)), which
    // would be 4 * 6.75 = 27px per row. Fractional rows get rounded to whole
    // pixels by the engine, so the round-trip through a variable lands ~2px off
    // and quietly shows a sliver of a fifth row. A fixed number is exact at every
    // zoom level. 108 = 4 rows x (18px line + 6px + 3px padding).
    //
    // One complete rule, not two bare declarations: every entry in this array is a
    // self-contained string, and a declaration with no selector block is silently
    // dropped by the parser. This was two bare lines first, and the height quietly
    // did nothing.
    ":root { --cy-playlist-h: 108px; --cy-song-h: 27px; }",
    ".cy-playlist {",
    "  margin-top: 10px;",
    "  height: var(--cy-playlist-h);",
    "  overflow-y: auto;",
    "  overscroll-behavior: contain;",
    "}",
    // Same 6px webkit scrollbar as the wallpaper grid, so the two lists agree.
    //
    // No `scrollbar-width: thin` here on purpose: measured in this Chromium, thin
    // composes to 10px and *overrides* the pseudo-element width, so asking for a
    // thin standard scrollbar gets a wider one than asking for nothing. The
    // standard properties are the future-proof spelling and lose that fight, so
    // they are left out rather than left in to look modern.
    ".cy-playlist::-webkit-scrollbar { width: 6px; }",
    ".cy-playlist::-webkit-scrollbar-track { background: transparent; }",
    ".cy-playlist::-webkit-scrollbar-thumb { background: " + tint(THEME.purple, 0.34) + "; border-radius: 3px; }",
    ".cy-playlist::-webkit-scrollbar-thumb:hover { background: " + tint(THEME.pink, 0.46) + "; }",
    ".cy-song {",
    "  display: flex; align-items: center; gap: 8px; padding: 6px 8px; border-radius: 8px;",
    // A fixed row height keeps the four-row window honest: no baseline can make a
    // row taller and push the fourth one into the clipped zone.
    "  height: var(--cy-song-h);",
    "  box-sizing: border-box;",
    "  cursor: pointer; font-size: 12px;",
    "}",
    ".cy-song:hover { background: " + tint(THEME.pink, 0.18) + "; }",
    ".cy-song[data-current=\"true\"] { background: " + tint(THEME.pink, 0.30) + "; color: " + THEME.inkDeep + "; }",
    ".cy-song:focus-visible { outline: 2px solid " + tint(THEME.pink, 0.70) + "; outline-offset: -2px; }",
    ".cy-song-name { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }",
    ".cy-mini {",
    "  position: fixed; z-index: 2147483000; width: 176px; padding: 9px; border-radius: " + THEME.radius.md + ";",
    "  background: " + tint(THEME.surface, 0.95) + "; border: 1px solid " + tint(THEME.purple, 0.28) + ";",
    "  box-shadow: 0 16px 40px rgba(0,0,0,0.50);",
    "  backdrop-filter: blur(20px) saturate(150%); -webkit-backdrop-filter: blur(20px) saturate(150%);",
    "  color: " + PALETTE.text + "; font-size: 11px;",
    "}",
    ".cy-mini[data-compact=\"true\"] .cy-disc { display: none; }",
    ".cy-mini-head { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }",
    ".cy-mini .cy-disc { width: 34px; height: 34px; box-shadow: inset 0 0 0 5px rgba(6,4,9,0.55); }",
    ".cy-mini-title { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }",

    /* ---------- transient overlays ---------- */
    ".cy-toasts { position: fixed; right: 18px; bottom: 18px; z-index: 2147483002; display: flex; flex-direction: column; gap: 8px; align-items: flex-end; pointer-events: none; }",
    ".cy-toast {",
    "  max-width: 300px; padding: 9px 13px; border-radius: " + THEME.radius.sm + "; font-size: 12px;",
    "  background: " + tint(THEME.surfaceHigh, 0.97) + "; border: 1px solid " + tint(THEME.purple, 0.32) + ";",
    "  color: " + PALETTE.text + "; box-shadow: 0 12px 30px rgba(0,0,0,0.48);",
    "  opacity: 1; transform: translateY(0); transition: opacity 300ms ease, transform 300ms ease;",
    "}",
    ".cy-toast[data-tone=\"error\"] { border-color: " + tint(THEME.danger, 0.60) + "; }",
    ".cy-toast[data-tone=\"success\"] { border-color: " + tint(THEME.success, 0.60) + "; }",
    ".cy-toast[data-leaving=\"true\"] { opacity: 0; transform: translateY(8px); }",

    ".cy-boot {",
    "  position: fixed; inset: 0; z-index: 2147483003; display: grid; place-items: center;",
    "  background: radial-gradient(120% 100% at 50% 40%, " + tint(THEME.ink, 0.96) + ", " + tint(THEME.inkDeep, 0.99) + ");",
    "  opacity: 0; transition: opacity 480ms ease; cursor: pointer;",
    "}",
    ".cy-boot[data-showing=\"true\"] { opacity: 1; }",
    ".cy-boot-frame { text-align: center; }",
    ".cy-boot img { max-width: min(560px, 74vw); max-height: 62vh; border-radius: " + THEME.radius.lg + "; border: 1px solid " + tint(THEME.pink, 0.50) + "; box-shadow: 0 0 60px " + tint(THEME.pink, 0.28) + "; }",
    ".cy-boot-title { margin-top: 18px; font-size: 15px; letter-spacing: 0.42em; color: " + THEME.pinkSoft + "; text-transform: uppercase; }",
    ".cy-boot-skip { margin-top: 12px; font-size: 11px; color: " + tint(THEME.text, 0.52) + "; }",
    // Cinema: the asset is the title card, so nothing is allowed to frame it. The
    // overlay goes pure black, the image fills the width, and the only chrome left
    // is the skip hint pinned to the bottom.
    ".cy-boot[data-style=\"cinema\"] { background: #000; }",
    ".cy-boot[data-style=\"cinema\"] .cy-boot-frame { display: grid; place-items: center; width: 100%; height: 100%; }",
    ".cy-boot[data-style=\"cinema\"] img { max-width: none; max-height: none; width: 100%; height: auto; border: 0; border-radius: 0; box-shadow: none; }",
    ".cy-boot[data-style=\"cinema\"] .cy-boot-skip { position: fixed; left: 0; right: 0; bottom: 26px; margin: 0; text-align: center; }",
    /* Reveal: deliberately NOT a page of artwork. A flat scrim, with the words and
       the wordmark floating on top of the dimmed application — then the scrim
       lifts and the window is simply there. */
    ".cy-boot[data-style=\"reveal\"] { background: rgba(10, 7, 14, 0.86); }",
    ".cy-boot[data-style=\"reveal\"] .cy-boot-frame { transition: transform 800ms cubic-bezier(0.32, 0.72, 0, 1), opacity 640ms ease; }",
    ".cy-boot[data-style=\"reveal\"][data-showing=\"false\"] { background: rgba(10, 7, 14, 0); }",
    ".cy-boot[data-style=\"reveal\"][data-showing=\"false\"] .cy-boot-frame { transform: scale(1.045); opacity: 0; }",
    ".cy-boot[data-style=\"reveal\"] img { max-width: min(880px, 76vw); max-height: 68vh; border: 0; border-radius: 0; box-shadow: none; }",
    ".cy-boot[data-style=\"reveal\"] .cy-boot-title { display: none; }",
    ".cy-boot[data-style=\"reveal\"] .cy-boot-skip { position: fixed; left: 0; right: 0; bottom: 26px; margin: 0; text-align: center; }",

    ".cy-emote {",
    "  position: fixed; right: 22px; bottom: 92px; z-index: 2147483000;",
    "  width: 148px; border-radius: " + THEME.radius.md + "; pointer-events: none;",
    "  border: 1px solid " + tint(THEME.pink, 0.36) + "; box-shadow: 0 16px 40px rgba(0,0,0,0.52);",
    "  animation: cy-emote-in 420ms cubic-bezier(0.2, 0.9, 0.3, 1.2);",
    "}",
    "@keyframes cy-emote-in { from { opacity: 0; transform: translateY(14px) scale(0.9); } to { opacity: 1; transform: none; } }",
    ".cy-emote[data-leaving=\"true\"] { opacity: 0; transform: translateY(10px); transition: opacity 320ms ease, transform 320ms ease; }",

    /* The pet: her official chat stickers, standing in the corner.
       Bottom-right, opposite the dock, so neither can cover the other. */
    ".cy-pet {",
    "  position: fixed; right: 22px; bottom: 20px; z-index: 2147482998;",
    "  width: 112px; height: 112px; cursor: grab; touch-action: none; user-select: none;",
    "  transition: opacity 320ms ease;",
    "}",
    ".cy-pet[data-placed=\"true\"] { right: auto; bottom: auto; }",
    ".cy-pet[data-hidden=\"true\"] { opacity: 0; pointer-events: none; }",
    ".cy-pet[data-dragging=\"true\"] { cursor: grabbing; }",
    // Two animations of different periods, so the combination does not visibly
    // repeat the way a single looping one would. `scale` and `translate` are
    // standalone properties here, so they compose instead of overwriting.
    ".cy-pet-sprite {",
    "  display: block; width: 100%; height: 100%; object-fit: contain;",
    "  filter: drop-shadow(0 10px 20px rgba(0,0,0,0.46));",
    "  transform-origin: 50% 94%;",
    "  animation: cy-pet-idle 4.6s ease-in-out infinite, cy-pet-drift 11s ease-in-out infinite;",
    "}",
    // The reaction pop lives on the wrapper: the sprite's `scale` already belongs
    // to the breathing animation, and two animations cannot share it.
    ".cy-pet[data-pop=\"true\"] { animation: cy-pet-pop 520ms cubic-bezier(0.32, 0.72, 0, 1); }",
    "@keyframes cy-pet-idle { 0%, 100% { scale: 1 1; } 50% { scale: 1.015 1.03; } }",
    "@keyframes cy-pet-drift { 0%, 100% { translate: 0 0; } 50% { translate: 0 -7px; } }",
    "@keyframes cy-pet-pop { 0% { scale: 1; } 34% { scale: 1.13; } 100% { scale: 1; } }",
    /* ---------- end-of-turn flourish ----------
       Sits in the transcript, after the last node, so it reads as part of the
       reply rather than as a notification. pointer-events:none matters more than
       it looks: this lands where the user may be reaching for a control, and a
       decorative image must never eat the click. */
    ".cy-celebrate {",
    "  pointer-events: none; opacity: 0;",
    "  transition: opacity " + CELEBRATE_FADE_MS + "ms ease, transform " + CELEBRATE_FADE_MS + "ms ease;",
    "  transform: translateY(10px) scale(0.96);",
    "}",
    /* In the flow, below the reply. `clear: both` in case the transcript uses
       floats, and a left margin so it lines up with message text rather than the
       scroll gutter. */
    ".cy-celebrate[data-anchor=\"transcript\"] {",
    "  margin: 6px 0 14px 2px; clear: both;",
    "}",
    /* No transcript to anchor to — a settings surface, say. The corner is worse
       than the flow but much better than nothing. */
    ".cy-celebrate[data-anchor=\"corner\"] {",
    "  position: fixed; right: " + CELEBRATE_MARGIN + "px; bottom: " + CELEBRATE_MARGIN + "px;",
    "  z-index: " + LAYER_CELEBRATE + ";",
    "}",
    ".cy-celebrate[data-showing=\"true\"] { opacity: 1; transform: none; }",
    ".cy-celebrate-art {",
    "  display: block; width: 220px; height: auto; max-width: 42vw;",
    /* No border-radius: the artwork is transparent-backed now, so a radius would
       only clip the shape that is already there. */
    "  filter: drop-shadow(0 8px 20px rgba(6, 4, 9, 0.38));",
    "}",
    "@media (prefers-reduced-motion: reduce) {",
    "  .cy-pet-sprite, .cy-pet[data-pop=\"true\"] { animation: none; }",
    "}",

    "@media (max-width: 640px) {",
    "  .cy-grid { grid-template-columns: repeat(2, 1fr); max-height: 216px; }",
    "  .cy-pop { max-width: 94vw; }",
    "  .cy-mini { width: 148px; }",
    "}",
    "@media (prefers-reduced-motion: reduce) {",
    "  .cy-disc[data-spinning=\"true\"] { animation: none; }",
    "  .cy-emote { animation: none; }",
    "  .cy-celebrate { transition: none; }",
    "  .cy-card:hover { transform: none; }",
    "  .cy-dot { transition: none; }",
    "}"

  ].join("\n");
}

