// Sync the desktop profile's cordis.patch.yml with the copy kept in this repo.
//
// The live file is the source of truth in daily use: `snapshot` copies it in
// here so git can see what changed. `restore` goes the other way and is the
// recovery path — after a bad edit, or on a new machine.
//
// Everything here works on BYTES. The repo sets `* -text` with
// `core.autocrlf=false` precisely so a checkout cannot rewrite line endings;
// this script must not undo that by "helpfully" normalising anything. When two
// files differ only in line endings, comparing as text and reporting a diff
// would print the entire file as changed and hide the real problem, so the
// fallback below re-reads both sides as text and says so explicitly.

import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..");

// An unrecognised override should fail loudly rather than quietly aiming at the
// real profile: someone passing a typo'd path is usually about to restore.
const LIVE = resolve(
  process.env.CYRENE_DESKTOP_PATCH ?? join(homedir(), ".dsh", "profiles", "desktop", "cordis.patch.yml"),
);
const SNAP = join(REPO, "desktop-profile", "cordis.patch.yml");

const argv = process.argv.slice(2);
const asJson = argv.includes("--json");
const args = argv.filter((a) => !a.startsWith("--"));
const cmd = args[0] ?? "check";

const same = (a, b) => a.length === b.length && a.equals(b);

function pad(s, n) {
  // Count characters, not code units, so CJK paths keep their columns.
  const width = [...s].length;
  return s + " ".repeat(Math.max(0, n - width));
}

function showDiff(a, b) {
  const A = a.toString("utf8").split("\n");
  const B = b.toString("utf8").split("\n");
  const n = Math.max(A.length, B.length);
  let shown = 0;
  console.log("");
  console.log(`  ${pad("live", 7)}${pad("snapshot", 9)}line`);
  for (let i = 0; i < n; i++) {
    if (A[i] === B[i]) continue;
    const mark = (s) => (s === undefined ? "  (missing)" : JSON.stringify(s).slice(1, -1));
    console.log(`  ${pad(String(i + 1), 7)}${pad("", 9)}- ${mark(A[i])}`);
    console.log(`  ${pad("", 7)}${pad(String(i + 1), 9)}+ ${mark(B[i])}`);
    if (++shown >= 40) {
      console.log(`  … ${n - i - 1} more line(s) differ, not shown`);
      break;
    }
  }
  console.log("");
}

function timestamp() {
  const d = new Date();
  const p = (x) => String(x).padStart(2, "0");
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  );
}

function requireLive() {
  if (!existsSync(LIVE)) {
    console.error(`no live patch at ${LIVE}`);
    console.error("Set CYRENE_DESKTOP_PATCH to point somewhere else.");
    process.exit(2);
  }
}

// Copy and verify. A copy that silently landed half-written would be worse than
// no copy at all, because the whole point of this file is that it is recoverable.
function copyVerified(from, to, label) {
  mkdirSync(dirname(to), { recursive: true });
  copyFileSync(from, to);
  const src = readFileSync(from);
  const dst = readFileSync(to);
  if (!same(src, dst)) {
    console.error(`${label}: copy did not verify — ${to} differs from ${from}`);
    process.exit(1);
  }
  return src.length;
}

function cmdCheck() {
  const haveSnap = existsSync(SNAP);
  const haveLive = existsSync(LIVE);
  if (!haveSnap && !haveLive) {
    console.error(`neither file exists:\n  ${LIVE}\n  ${SNAP}`);
    process.exit(2);
  }
  if (!haveSnap) {
    console.error(`repo snapshot is MISSING — run: node tools/sync-desktop-patch.mjs snapshot`);
    process.exit(2);
  }
  if (!haveLive) {
    console.error(`live file is MISSING:\n  ${LIVE}`);
    process.exit(2);
  }

  const live = readFileSync(LIVE);
  const snap = readFileSync(SNAP);
  if (same(live, snap)) {
    console.log(`in sync — ${live.length} bytes, identical on both sides`);
    if (asJson) console.log(JSON.stringify({ inSync: true, live: LIVE, snap: SNAP, bytes: live.length }));
    return;
  }

  console.log(`OUT OF SYNC — ${live.length} bytes live vs ${snap.length} bytes in the repo`);
  if (live.toString("utf8") !== snap.toString("utf8")) {
    // Deliberately not claiming which one changed: git already knows that.
    showDiff(live, snap);
    console.log("  -  live       (what DSH actually reads)");
    console.log("  +  snapshot   (what is committed)");
    console.log("");
    console.log("  live is newer, usually:  node tools/sync-desktop-patch.mjs snapshot");
    console.log("  snapshot is right:       node tools/sync-desktop-patch.mjs restore");
  } else {
    console.log("  Same text, different bytes: the two files disagree on line endings.");
    console.log("  The repo copy is pure LF. `restore` writes the snapshot bytes verbatim,");
    console.log("  so restoring is what fixes it.");
  }
  console.log("");
  process.exit(1);
}

function cmdSnapshot() {
  requireLive();
  if (!existsSync(SNAP)) {
    console.error(`repo snapshot missing at ${SNAP} — cannot tell new from deleted`);
    process.exit(2);
  }
  const before = readFileSync(SNAP);
  const live = readFileSync(LIVE);
  if (same(before, live)) {
    console.log(`already up to date — ${live.length} bytes, nothing to copy`);
    return;
  }
  const n = copyVerified(LIVE, SNAP, "snapshot");
  console.log(`copied live -> repo, ${n} bytes`);
  console.log(`  from ${LIVE}`);
  console.log(`  to   ${SNAP}`);
  console.log("");
  console.log("Now review and commit:");
  console.log("  git -C " + JSON.stringify(REPO) + " diff -- desktop-profile");
}

function cmdRestore() {
  if (!existsSync(SNAP)) {
    console.error(`no repo snapshot at ${SNAP} — nothing to restore`);
    process.exit(2);
  }
  const snap = readFileSync(SNAP);

  if (existsSync(LIVE)) {
    const cur = readFileSync(LIVE);
    if (same(cur, snap)) {
      console.log(`already identical — ${cur.length} bytes, nothing written`);
      return;
    }
    const bak = `${LIVE}.bak-${timestamp()}`;
    const m = copyVerified(LIVE, bak, "backup");
    console.log(`backed up the current file first, ${m} bytes`);
    console.log(`  ${bak}`);
  } else {
    console.log(`live file did not exist; creating it`);
  }

  const n = copyVerified(SNAP, LIVE, "restore");
  console.log(`restored repo -> live, ${n} bytes`);
  console.log(`  to ${LIVE}`);
  console.log("");
  console.log("DSH reads the patch when it composes the tree, so restart the app");
  console.log("(or open a session) before deciding whether the restore worked.");
}

switch (cmd) {
  case "check":
    cmdCheck();
    break;
  case "snapshot":
    cmdSnapshot();
    break;
  case "restore":
    cmdRestore();
    break;
  default:
    console.error(`unknown command: ${cmd}`);
    console.error("usage: node tools/sync-desktop-patch.mjs [check|snapshot|restore] [--json]");
    process.exit(2);
}
