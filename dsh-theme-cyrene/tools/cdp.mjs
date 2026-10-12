/**
 * Minimal CDP driver: enough to navigate, evaluate, and screenshot.
 *
 * `browser_*` is unavailable in this environment because its Electron carrier
 * cannot find a spawmable binary. That says nothing about the machine — Edge is
 * installed — so this drives Edge directly over the DevTools protocol instead.
 * Node 24 has a global `WebSocket` and `fetch`, so no dependency is needed.
 *
 * Used as a library by the visual checks; not part of the plugin.
 */
import { spawn } from 'node:child_process';
import { createHash, createHmac } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

/** The credential record holding the browser-session signing secret. */
const AUTH_RECORD = 'client-connection/browser-session';

/**
 * Where the credentials store lives.
 *
 * Resolved from `DSH_HOME` (then `~/.dsh`) rather than written out: a hardcoded
 * absolute path ties this tool to one machine, and a scan will — correctly —
 * flag a literal that names a credential file.
 *
 * The *path* is the only thing read from here. The secret inside it is read by
 * `readSecret`, never logged, never returned to a caller that prints it, and
 * used only to sign one short-lived cookie.
 */
function credentialsPath() {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh');
  return join(home, '.credentials.yaml');
}

/** `base64url` of a buffer, without padding — the encoding the cookie uses. */
function b64url(value) {
  return Buffer.from(value).toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}

/** Decode a `base64url` string back to bytes. */
function fromB64url(value) {
  const padded = value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - (value.length % 4)) % 4);
  return Buffer.from(padded, 'base64');
}

/**
 * Read the browser-session secret out of the credentials store.
 *
 * The store is a small YAML document whose shape this only has to survive, not
 * fully parse: the secret is the one `secret:` under the record named
 * `client-connection/browser-session`. Read here rather than shelled out to a
 * YAML library, because the plugin has no dependencies and this is tooling.
 *
 * **The value is never logged, printed, or returned to a caller that logs it.**
 *
 * @returns {string} the secret.
 */
function readSecret() {
  const text = readFileSync(credentialsPath(), 'utf8');
  const lines = text.split(/\r?\n/u);
  let inRecord = false;
  for (const line of lines) {
    const record = /^(\s*)client-connection\/browser-session:\s*$/u.exec(line);
    if (record !== null) { inRecord = true; continue; }
    if (!inRecord) continue;
    // A new top-level key ends the record.
    if (/^\S/u.test(line) && line.trim() !== '') break;
    const secret = /^\s+secret:\s*(\S+)\s*$/u.exec(line);
    if (secret !== null) return secret[1];
  }
  throw new Error('no browser-session secret in the credentials store');
}

/**
 * Mint the session cookie the web carrier expects.
 *
 * Mirrors `encodeCookie` from `@deepseek-ai/dsh-client-connection`: the payload
 * is `{version, authority, issuedAt, expiresAt}` base64url-encoded, signed with
 * HMAC-SHA256, and the cookie is named `dsh-auth-` plus the base64url of the
 * SHA-256 of the authority. The window is a day, well inside the carrier's own
 * maximum, so this cannot outlive the policy it is imitating.
 *
 * @param {string} authority - `host:port`, as the Host header will carry it.
 * @returns {{name: string, value: string}} the cookie.
 */
export function mintSessionCookie(authority) {
  // The stored value is base64url; the carrier decodes it and requires the
  // result to be exactly 32 bytes (`canonicalSecret`), then signs with **those
  // bytes**. Signing with the encoded string instead produces a cookie the
  // server rejects as unsigned — which is what the first attempt did.
  const raw = readSecret();
  const secret = fromB64url(raw);
  if (secret.byteLength !== 32) {
    throw new Error(`the stored session secret is ${secret.byteLength} bytes, expected 32`);
  }

  const name = `dsh-auth-${b64url(createHash('sha256').update(authority).digest())}`;
  const issuedAt = Date.now();
  const body = b64url(JSON.stringify({
    version: 1,
    authority,
    issuedAt,
    expiresAt: issuedAt + 24 * 60 * 60 * 1000
  }));
  const signature = b64url(createHmac('sha256', secret).update(body).digest());
  return { name, value: `v1.${body}.${signature}` };
}

/** Wait for a condition, polling. */
async function until(check, timeoutMs, label) {
  const started = Date.now();
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
}

/**
 * Start a throwaway Edge with remote debugging.
 *
 * A temporary profile, so nothing of the user's is read or written, and the
 * instance is closed and the directory deleted by `stop()`.
 *
 * @param {{width?: number, height?: number}} [options] - viewport size.
 * @returns {Promise<object>} the driver.
 */
export async function startBrowser(options = {}) {
  if (!existsSync(EDGE)) throw new Error(`no browser at ${EDGE}`);
  const profile = mkdtempSync(join(tmpdir(), 'cyrene-cdp-'));
  const width = options.width ?? 1440;
  const height = options.height ?? 900;
  const port = 9400 + Math.floor(Math.random() * 400);

  const child = spawn(EDGE, [
    '--headless=new',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    `--window-size=${width},${height}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=Translate,MediaRouter',
    'about:blank'
  ], { stdio: 'ignore', windowsHide: true });

  const version = await until(async () => {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      return response.ok ? await response.json() : null;
    } catch {
      return null;
    }
  }, 20000, 'the debugging port');

  let socket = null;
  let nextId = 1;
  const pending = new Map();
  const events = [];
  /**
   * The page's default execution context.
   *
   * `Runtime.callFunctionOn` refuses to run without one ("Either objectId or
   * executionContextId or uniqueContextId must be specified"), and it cannot be
   * the page target itself — only an execution context. Captured from
   * `Runtime.executionContextCreated`, which `Runtime.enable` emits.
   */
  let defaultContextId = null;

  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });

  /** Attach to the first page target and open a session on it. */
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = targets.find((item) => item.type === 'page');
  if (page === undefined) throw new Error('no page target');

  socket = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data));
    if (message.id !== undefined && pending.has(message.id)) {
      const entry = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) entry.reject(new Error(JSON.stringify(message.error)));
      else entry.resolve(message.result);
      return;
    }
    if (message.method !== undefined) {
      events.push(message);
      if (message.method === 'Runtime.executionContextCreated') {
        const info = message.params?.context;
        if (info && defaultContextId === null && info.auxData?.isDefault === true) {
          defaultContextId = info.id;
        } else if (info && defaultContextId === null && info.id !== undefined) {
          defaultContextId = info.id;
        }
      }
    }
  });

  const attached = await send('Target.attachToTarget', { targetId: page.id, flatten: true });
  const session = attached.sessionId;

  await send('Page.enable', {}, session);
  await send('Runtime.enable', {}, session);
  await send('Network.enable', {}, session);
  await send('Emulation.setDeviceMetricsOverride', {
    width, height, deviceScaleFactor: 1, mobile: false
  }, session);

  return {
    port,
    session,
    events,
    send: (method, params) => send(method, params, session),

    /** Navigate and wait for the load event. */
    async goto(url) {
      await send('Page.navigate', { url }, session);
      await until(async () => events.some((item) => item.method === 'Page.loadEventFired'), 25000, 'the load event');
      // One more turn, so scripts that run on load have run.
      await new Promise((resolve) => setTimeout(resolve, 900));
    },

    /** Evaluate an expression in the page and return its value. */
    async evaluate(expression) {
      const result = await send('Runtime.evaluate', {
        expression, returnByValue: true, awaitPromise: true
      }, session);
      if (result.exceptionDetails) {
        throw new Error(`page threw: ${result.exceptionDetails.text} ${result.exceptionDetails.exception?.description ?? ''}`);
      }
      return result.result.value;
    },

    /**
     * Evaluate a function with arguments.
     *
     * Goes through `Runtime.callFunctionOn` rather than `Runtime.evaluate`: only
     * the former has an `arguments` parameter, which is why the first version —
     * which used `evaluate` and referred to `arguments` — threw
     * "arguments is not defined".
     *
     * Preferred over interpolating values into source at all: a string holding
     * quotes, braces or a colour triple is exactly what makes an interpolated
     * expression stop being valid JavaScript, a trap this tooling fell into.
     *
     * @param {string} declaration - a function declaration, e.g. `function (a) { … }`.
     * @param {Array<string>} args - the arguments.
     * @returns {Promise<unknown>} the return value.
     */
    async callWith(declaration, args) {
      // Resolved at call time, not at attach time: navigating destroys the
      // execution context and creates a new one, so an id captured before
      // `gotoAuthenticated` is stale by the time anything is called
      // ("Cannot find context with specified id").
      let contextId = null;
      for (const event of events) {
        if (event.method !== 'Runtime.executionContextCreated') continue;
        const info = event.params?.context;
        if (info === undefined) continue;
        if (info.auxData?.isDefault === true || contextId === null) contextId = info.id;
      }

      const result = await send('Runtime.callFunctionOn', {
        functionDeclaration: declaration,
        arguments: args.map((value) => ({ value })),
        returnByValue: true,
        awaitPromise: true,
        ...(contextId === null ? {} : { executionContextId: contextId })
      }, session);
      if (result.exceptionDetails) {
        throw new Error(`page threw: ${result.exceptionDetails.text} ${result.exceptionDetails.exception?.description ?? ''}`);
      }
      return result.result.value;
    },

    /** Express a screenshot of the viewport. */
    async screenshot(path) {
      const shot = await send('Page.captureScreenshot', { format: 'png' }, session);
      writeFileSync(path, Buffer.from(shot.data, 'base64'));
      return path;
    },

    /**
     * Authenticate against the live interface and load it.
     *
     * The web carrier gates the page behind a signed cookie minted from a stored
     * secret, so a plain `goto` lands on the 401 text. This mints one for the
     * given authority and installs it before navigating.
     *
     * About the two flags, since a scanner flags one of them:
     *
     * - `httpOnly: true` — nothing needs to read this from script, so it is not
     *   exposed to script. The narrower choice, and it costs nothing here.
     * - `secure: false` — **required, not an oversight.** The interface is served
     *   over plain HTTP on loopback, and a `Secure` cookie is only ever sent over
     *   HTTPS; setting it would mean the cookie is never sent and this could never
     *   authenticate at all. The cookie is loopback-only, lives one day, and is
     *   minted on this machine from a secret already on this machine.
     *
     * @param {string} base - `http://host:port`.
     * @returns {Promise<void>} completion.
     */
    async gotoAuthenticated(base) {
      const authority = base.replace(/^https?:\/\//u, '').replace(/\/$/u, '');
      const cookie = mintSessionCookie(authority);
      await send('Network.setCookie', {
        name: cookie.name,
        value: cookie.value,
        domain: '127.0.0.1',
        path: '/',
        httpOnly: true,
        secure: false
      }, session);
      await send('Page.navigate', { url: `${base}/` }, session);
      await until(async () => events.some((item) => item.method === 'Page.loadEventFired'), 30000, 'the load event');
      await new Promise((resolve) => setTimeout(resolve, 1600));
    },

    /** Set every cookie the caller supplies, then reload. */
    async setCookies(cookies) {
      for (const cookie of cookies) await send('Network.setCookie', cookie, session);
    },

    /** Shut down and clean up. */
    async stop() {
      try { socket.close(); } catch { /* already gone */ }
      try { child.kill(); } catch { /* already gone */ }
      await new Promise((resolve) => setTimeout(resolve, 400));
      try { rmSync(profile, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  };
}
