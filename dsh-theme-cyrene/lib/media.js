/**
 * Now Playing: the system's media session, read and driven.
 *
 * ## What this talks to
 *
 * Windows exposes every media app through GSMTC — the Global System Media
 * Transport Controls session manager — so one reader covers QQ音乐, Edge, and
 * anything else that registers, with no per-player integration. That was worth
 * verifying before building on it, and the reconnaissance did.
 *
 * ## The two traps, both hit during that reconnaissance
 *
 * 1. **PowerShell 5.1 cannot await a WinRT operation.** `RequestAsync()`
 *    returns an `IAsyncOperation`, and calling `.GetResults()` on it directly
 *    fails with "does not contain a method named GetResults". The desktop idiom
 *    is to reflect `[WindowsRuntimeSystemExtensions]::AsTask` into a generic
 *    method, invoke it, and read `.Result` — which is what `AWAIT_HELPER` does.
 *    It is also why the script has to run under `powershell.exe` rather than
 *    `pwsh`: the interop assembly is a .NET Framework one.
 * 2. **Output encoding.** PowerShell writes to its console in the console's code
 *    page, so a Chinese track title reaches Node as mojibake. `[Console]::OutputEncoding`
 *    has to be set to UTF-8 *before* anything is written.
 *
 * The script travels as `-EncodedCommand` (UTF-16LE, base64). A `.ps1` file would
 * be read as ANSI by PowerShell 5.1, which mangles the same Chinese text again —
 * and the execution policy would refuse it anyway.
 */

import { execFileSync } from 'node:child_process';

/** How long a single PowerShell invocation may take. */
const MEDIA_TIMEOUT_MS = 8000;

/**
 * How long a query result is reused.
 *
 * Each invocation spawns a process — measured at roughly 400 ms — and the client
 * polls. Caching turns a poll every second into one process every two seconds
 * without making the display feel stale, because the only thing that moves
 * between polls is the playhead, and the client advances that itself.
 */
const CACHE_MS = 1800;

/** The reflected-await preamble plus the manager lookup, shared by both scripts. */
const AWAIT_HELPER = String.raw`
$ErrorActionPreference = 'Stop'
# Powershell writes to the console in the console's code page; without this a
# Chinese track title arrives at Node as mojibake.
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Runtime.WindowsRuntime | Out-Null

$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation` + '`' + String.raw`1'
})[0]

function Await($operation, $resultType) {
  $asTask = $asTaskGeneric.MakeGenericMethod($resultType)
  $task = $asTask.Invoke($null, @($operation))
  $task.Wait(-1) | Out-Null
  return $task.Result
}

[Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media, ContentType = WindowsRuntime] | Out-Null
$managerType = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]
$manager = Await ($managerType::RequestAsync()) $managerType
$session = $manager.GetCurrentSession()
if ($null -eq $session) { Write-Output '{"session":false}'; exit 0 }
`;

/** Read the current session's metadata, transport state and playhead. */
const QUERY_SCRIPT = AWAIT_HELPER + String.raw`
$propsType = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties]
$props = Await ($session.TryGetMediaPropertiesAsync()) $propsType
$timeline = $session.GetTimelineProperties()
$info = $session.GetPlaybackInfo()
$controls = $info.Controls
$payload = [ordered]@{
  session  = $true
  app      = $session.SourceAppUserModelId
  title    = $props.Title
  artist   = $props.Artist
  album    = $props.AlbumTitle
  subtitle = $props.Subtitle
  status   = [string]$info.PlaybackStatus
  canNext  = $controls.IsNextEnabled
  canPrev  = $controls.IsPreviousEnabled
  canSeek  = $controls.IsPlaybackPositionEnabled
  position = $timeline.Position.TotalSeconds
  duration = $timeline.EndTime.TotalSeconds
}
$payload | ConvertTo-Json -Compress
`;

/**
 * The transport actions, as GSMTC spells them.
 *
 * ⚠️ They live on the **session**, not on `PlaybackInfo.Controls`. That object
 * carries capability flags (`IsNextEnabled` and friends) and nothing else — the
 * first version of this file called `$controls.TryTogglePlayPauseAsync()` and
 * failed with "does not contain a method named", which is how the split was
 * found. Do not move these back onto `$controls`.
 *
 * `TryChangePlaybackPositionAsync` takes a tick count (100 ns), not a time.
 */
const ACTIONS = {
  play: { method: 'TryPlayAsync', args: '', label: '播放' },
  pause: { method: 'TryPauseAsync', args: '', label: '暂停' },
  toggle: { method: 'TryTogglePlayPauseAsync', args: '', label: '播放 / 暂停' },
  next: { method: 'TrySkipNextAsync', args: '', label: '下一首' },
  previous: { method: 'TrySkipPreviousAsync', args: '', label: '上一首' },
  stop: { method: 'TryStopAsync', args: '', label: '停止' }
};

/**
 * The spawn function, injectable for tests.
 *
 * Tests replace this rather than letting the module run PowerShell: the control
 * actions would otherwise start and pause whatever the machine is playing, which
 * is an unacceptable side effect for a unit test and would make the suite depend
 * on the presence of a media session.
 */
let spawn = execFileSync;

/**
 * Replace the spawn function. Test-only.
 * @param {Function} next - the replacement.
 */
export function __setSpawn(next) {
  spawn = next;
  cache = { at: 0, payload: null };
}

/**
 * Run a PowerShell script and read its JSON line back.
 *
 * @param {string} script - the script text.
 * @returns {object|null} the parsed payload, or null when nothing usable came back.
 */
function runScript(script) {
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  let out;
  try {
    out = spawn('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy', 'Bypass',
      '-EncodedCommand', encoded
    ], { encoding: 'utf8', timeout: MEDIA_TIMEOUT_MS, windowsHide: true, maxBuffer: 1 << 20 });
  } catch (error) {
    // A machine without GSMTC, a locked-down policy, or a session that vanished
    // mid-call: all of them mean "no reading", never a thrown route.
    return null;
  }

  const trimmed = String(out).trim();
  if (trimmed === '') return null;
  // Take the last non-empty line: `Add-Type` and friends can emit warnings above
  // the payload, and the JSON is always the final write.
  const lines = trimmed.split(/\r?\n/u).filter((line) => line.trim() !== '');
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const parsed = JSON.parse(lines[index]);
      if (parsed !== null && typeof parsed === 'object') return parsed;
    } catch (error) {
      // Not the JSON line; keep walking up.
    }
  }
  return null;
}

/** The cached payload and when it was taken. */
let cache = { at: 0, payload: null };

/**
 * Read the current media session, reusing a recent reading.
 *
 * @param {boolean} [force] - skip the cache.
 * @returns {object} `{ok, session, …}`; never throws.
 */
export function readMedia(force = false) {
  const now = Date.now();
  if (!force && cache.payload !== null && now - cache.at < CACHE_MS) {
    return { ok: true, cached: true, media: cache.payload };
  }

  const payload = runScript(QUERY_SCRIPT);
  if (payload === null) {
    return { ok: false, media: null, reason: '读不到系统媒体会话（这台机器可能没有可用的播放器）' };
  }

  const media = payload.session === true ? {
    app: String(payload.app ?? ''),
    title: String(payload.title ?? ''),
    artist: String(payload.artist ?? ''),
    album: String(payload.album ?? ''),
    subtitle: String(payload.subtitle ?? ''),
    status: String(payload.status ?? 'Closed'),
    canNext: payload.canNext === true,
    canPrev: payload.canPrev === true,
    canSeek: payload.canSeek === true,
    position: Number(payload.position) || 0,
    duration: Number(payload.duration) || 0
  } : null;

  cache = { at: now, payload: media };
  // An action invalidates the reading rather than patching it: the player is the
  // authority on what happened, and a guess here would be shown as fact.
  return { ok: true, cached: false, media };
}

/**
 * Drive the current session's transport.
 *
 * @param {string} action - one of the keys of `ACTIONS`.
 * @returns {object} `{ok, action, accepted, reason?}`; never throws.
 */
export function controlMedia(action) {
  const entry = ACTIONS[action];
  if (entry === undefined) {
    return { ok: false, action: String(action), reason: '不认识的操作' };
  }

  // The client sends a key, and the method name comes from the table above — the
  // value is never interpolated into the script, so an unexpected action cannot
  // become arbitrary PowerShell.
  const script = AWAIT_HELPER + String.raw`
$result = Await ($session.` + entry.method + String.raw`()) ([bool])
$payload = [ordered]@{ ok = [bool]$result }
$payload | ConvertTo-Json -Compress
`;

  const payload = runScript(script);
  // Anything that changes the transport invalidates the cached reading.
  cache = { at: 0, payload: null };

  if (payload === null) {
    return { ok: false, action, reason: '控制通道读不到会话' };
  }
  return {
    ok: true,
    action,
    label: entry.label,
    // The player is allowed to refuse: a session with no next track answers
    // `false` rather than throwing, and that is worth showing rather than
    // reporting as a success.
    accepted: payload.ok === true
  };
}

/** Forget the cached reading; used when the route is torn down. */
export function resetMediaCache() {
  cache = { at: 0, payload: null };
}
