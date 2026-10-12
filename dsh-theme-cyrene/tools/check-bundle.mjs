// Validate that the browser-half parts actually form runnable JavaScript.
//
// The build only concatenates lib/client/*.js and fills eight JSON placeholders;
// nothing parses the result until a browser loads it, so a syntax error there
// ships silently and shows up as "the theme does not mount". This checks the
// same concatenation the build produces, using Node's own parser.
//
//   node tools/check-bundle.mjs

import vm from "node:vm";
import { loadParts } from "./lib/parts.mjs";

const { code, parts } = loadParts();

// 1. Parse only — `new vm.Script` compiles without running anything.
try {
  new vm.Script(code, { filename: "lib/client.js (concatenated parts)" });
} catch (error) {
  console.log(`parse   FAILED  (${parts.length} parts)`);
  console.log(String((error && error.stack) || error));
  process.exit(1);
}
console.log(`parse   OK      (${parts.length} parts, ${code.length} chars)`);

// 2. Run it under a minimal window/document stub. The parts touch the DOM at
// module scope, so a recording stub is what lets execution reach the end.
const calls = [];
const node = () => ({
  style: {},
  dataset: {},
  appendChild() {},
  removeChild() {},
  insertBefore() {},
  setAttribute() {},
  addEventListener() {},
  removeEventListener() {},
  querySelector: () => null,
  querySelectorAll: () => [],
  classList: { add() {}, remove() {}, toggle() {} },
});

const sandbox = {
  console,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  Math,
  Date,
  JSON,
  String,
  Number,
  Boolean,
  Array,
  Object,
  RegExp,
  Error,
  Promise,
  Map,
  Set,
  isFinite,
  parseFloat,
  parseInt,
};
sandbox.globalThis = sandbox;
sandbox.window = {
  __ModuleLoader__: { load: (spec) => calls.push(spec && spec.id) },
  addEventListener() {},
  removeEventListener() {},
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  localStorage: { getItem: () => null, setItem() {} },
  sessionStorage: { getItem: () => null, setItem() {} },
  innerWidth: 1400,
  innerHeight: 900,
  devicePixelRatio: 1,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
};
sandbox.document = {
  body: node(),
  head: node(),
  documentElement: node(),
  createElement: node,
  createElementNS: node,
  getElementById: () => null,
  querySelector: () => null,
  querySelectorAll: () => [],
  addEventListener() {},
  removeEventListener() {},
};
sandbox.window.document = sandbox.document;

try {
  vm.createContext(sandbox);
  new vm.Script(code, { filename: "lib/client.js (concatenated parts)" }).runInContext(sandbox);
} catch (error) {
  console.log("execute FAILED");
  console.log(String((error && error.stack) || error));
  process.exit(1);
}
console.log(`execute OK      registered: ${calls.length ? calls.join(", ") : "(none)"}`);
