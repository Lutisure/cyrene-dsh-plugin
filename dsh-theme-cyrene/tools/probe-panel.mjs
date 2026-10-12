// Measure the music panel in a real layout engine.
//
// The unit-test harness is a hand-rolled DOM with no layout engine, so it can
// answer "is the class there" but never "how tall is that box", and the
// question here is exactly a height question. This builds a standalone page
// that reassembles the browser-half parts the way build.mjs does, mounts the
// panel with a known playlist, and prints the numbers a real engine computed.
//
//   node tools/probe-panel.mjs                  # 6 songs
//   CYRENE_SONGS=20 node tools/probe-panel.mjs  # a long playlist
//
// The page writes its measurements into the document, so it is also the
// screenshot evidence. Render it in any Chromium and read the numbers off:
//   msedge --headless=new --screenshot=out.png --window-size=760,900 <url>

import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { factoryBody, loadParts } from "./lib/parts.mjs";

// Outside the repo on purpose: this page is a disposable intermediate, and the
// only artifact worth committing is the figure derived from it
// (tools/render-playlist-window.py writes docs/playlist-window.png).
const OUT = process.env.CYRENE_PROBE_OUT ?? join(tmpdir(), "cyrene-probe-panel.html");
const SONGS = Number(process.env.CYRENE_SONGS ?? 6);

const { code, parts } = loadParts();
// The panel builder is a local of the factory, so the probe has to live inside
// the factory body to see it.
const body = factoryBody(code);

const PROBE = `
;module.exports.__probe = function () {
  var host = document.createElement("div");
  host.id = "probe-host";
  document.body.appendChild(host);
  mountStyle(CONTROL_CSS, "controls.css");

  var controller = createMusicController();
  controller.tracks = function () {
    var list = [];
    for (var i = 1; i <= ${SONGS}; i += 1) {
      list.push({ id: "t" + i, label: "music_知更鸟 _ HOYO-MiX _ Chevy - 使一颗心免于哀伤 " + i });
    }
    return list;
  };
  controller.currentTrack = function () { return controller.tracks()[3]; };
  controller.coverOf = function () { return null; };
  controller.discArt = function () { return "none"; };
  controller.subscribe = function () { return function () {}; };

  var panel = buildMusicPanel(controller, { addFiles: function () {}, collapse: function () {} });
  // position:fixed is right for the real dock, but static keeps the panel in the
  // page flow so one screenshot shows all of it.
  panel.style.position = "static";
  panel.style.animation = "none";
  panel.style.margin = "16px auto";
  host.appendChild(panel);

  var list = panel.querySelector(".cy-playlist");
  var rows = list.querySelectorAll(".cy-song");
  var row0 = rows.length ? rows[0].getBoundingClientRect() : { height: 0 };
  var rowStyle = rows.length ? getComputedStyle(rows[0]) : null;
  var listStyle = getComputedStyle(list);

  return {
    songsInPlaylist: rows.length,
    rowHeight: Math.round(row0.height * 100) / 100,
    rowPaddingY: rowStyle ? parseFloat(rowStyle.paddingTop) + parseFloat(rowStyle.paddingBottom) : null,
    listMaxHeight: listStyle.maxHeight,
    listOverflowY: listStyle.overflowY,
    listClientHeight: list.clientHeight,
    listScrollHeight: list.scrollHeight,
    rowsFitting: row0.height > 0 ? Math.floor(list.clientHeight / row0.height) : 0,
    scrolls: list.scrollHeight > list.clientHeight + 1,
    scrollbarWidth: list.offsetWidth - list.clientWidth,
    panelHeight: Math.round(panel.getBoundingClientRect().height)
  };
};
`;

const page = `<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><title>dsh-theme-cyrene · 音乐面板探针</title>
<style>
  html, body { margin: 0; padding: 0; background: #17131c; color: #e8e2ee;
    font-family: system-ui, "Segoe UI", "Microsoft YaHei", sans-serif; }
  h1 { margin: 16px 16px 0; font-size: 14px; font-weight: 600; color: #f7c9da; }
  pre { margin: 16px; padding: 14px 16px; border-radius: 12px; background: #0f0c13;
    border: 1px solid #2c2434; font-size: 13px; line-height: 1.6; white-space: pre-wrap; }
</style></head>
<body>
<h1>dsh-theme-cyrene · 音乐面板 · ${SONGS} 首</h1>
<script>
window.__ModuleLoader__ = { load: function () {} };
// The panel path does not fetch, but a stub keeps a stray call from throwing
// where the failure would be invisible.
window.fetch = function () { return Promise.reject(new Error("probe stub")); };
var __stub = {
  token: function () { return ""; },
  service: function () { return {}; },
  remote: function () { return function () {}; }
};
(function () {
  var module = { exports: {} };
  var exports = module.exports;
  var require = function () { return __stub; };
  var result;
  try {
${body}
${PROBE}
    result = module.exports.__probe();
  } catch (error) {
    result = { error: String((error && error.stack) || error) };
  }
  window.__RESULT__ = result;
  var out = document.createElement("pre");
  out.id = "measurements";
  out.textContent = JSON.stringify(result, null, 2);
  document.body.appendChild(out);
})();
</script>
</body></html>`;

writeFileSync(OUT, page, "utf8");
console.log(`wrote ${OUT}`);
console.log(`parts (${parts.length}) · songs ${SONGS}`);
