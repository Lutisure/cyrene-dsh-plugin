/**
 * Headless harness for the browser half.
 *
 * A minimal DOM/browser shim, just wide enough to run the real bundle. This is
 * the only way to catch the class of bug that `node --check` cannot see: a
 * mistyped helper, a disposer that leaks, a panel that is built but never
 * mounted. Everything here is deliberately hand-rolled — no jsdom — so the
 * test has no dependency a reviewer has to install.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

/**
 * 要跑的那份 bundle。
 *
 * ⚠️ **可以用 `CYRENE_BUNDLE` 指到别处** —— 这不是为了方便，是为了能测
 * **收件人那份**。
 *
 * 导出物里的 `client.js` 是在**空的 `assets/`** 下建出来的，
 * 于是 `WALLPAPERS` / `MUSIC` / `EMOTES` 全空。而这一整套测试平时跑的是本机那份
 * **带素材**的 bundle —— **收件人的那个状态一天都没被挂载过。**
 *
 *     CYRENE_BUNDLE=/path/to/export/dsh-theme-cyrene/lib/client.js \
 *       node --test test/*.test.mjs
 */
const BUNDLE = process.env.CYRENE_BUNDLE ?? fileURLToPath(new URL('../lib/client.js', import.meta.url));

/* ------------------------------------------------------------------ *
 * DOM
 * ------------------------------------------------------------------ */

/** Convert a `data-foo-bar` attribute name to its dataset key. */
function datasetKey(name) {
  return name.slice(5).replace(/-([a-z])/gu, (_match, letter) => letter.toUpperCase());
}

/** The inverse: `somethingElse` back to `something-else`. */
function kebab(key) {
  return String(key).replace(/[A-Z]/gu, (letter) => `-${letter.toLowerCase()}`);
}

/** `data-foo-bar` to the camelCase key dataset exposes. */
function camel(name) {
  return name.replace(/-([a-z])/gu, (_match, letter) => letter.toUpperCase());
}

/**
 * Split a selector list (`a, b`) into its branches, respecting brackets and
 * quotes so a comma inside `[x="a,b"]` is not a separator.
 *
 * @param {string} selector - the selector, possibly a list.
 * @returns {string[]} one entry per branch.
 */
function selectorBranches(selector) {
  const branches = [];
  let current = '';
  let depth = 0;
  let quote = null;
  for (const char of String(selector)) {
    if (quote !== null) {
      current += char;
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }
    if (char === '[' || char === '(') depth += 1;
    if (char === ']' || char === ')') depth -= 1;
    if (char === ',' && depth === 0) {
      if (current.trim() !== '') branches.push(current.trim());
      current = '';
      continue;
    }
    current += char;
  }
  if (current.trim() !== '') branches.push(current.trim());
  return branches;
}

/**
 * Match one simple selector against a node.
 *
 * Handles what this plugin actually writes: a type, an id, a class, or an
 * attribute test, with or without a value.
 */
function matchesSimple(node, selector) {
  if (selector.startsWith('#')) return node.attributes.id === selector.slice(1);
  if (selector.startsWith('.')) {
    return String(node.attributes.class ?? '').split(/\s+/u).includes(selector.slice(1));
  }
  if (selector.startsWith('[')) {
    const body = selector.slice(1, selector.indexOf(']'));
    const equals = body.indexOf('=');
    if (equals === -1) return node.attributes[body] !== undefined;
    const name = body.slice(0, equals);
    const wanted = body.slice(equals + 1).replace(/^["']|["']$/gu, '');
    return node.attributes[name] === wanted;
  }
  return node.tagName === selector.toUpperCase();
}

/**
 * Match a node against one compound selector — simple selectors with no
 * whitespace between them, e.g. `.cy-song[data-current="true"]`.
 *
 * Reading only the first character meant a compound selector matched on its
 * first half alone, which is how `.cy-song[...]` passed for every row.
 *
 * @param {object} node - the candidate node.
 * @param {string} compound - the compound selector.
 * @returns {boolean} whether every simple selector in it matches.
 */
function matches(node, compound) {
  if (node.nodeType !== 1) return false;
  const simples = compound.match(/[a-zA-Z][\w-]*|#[^.#\s\[]+|\.[^.#\s\[]+|\[[^\]]*\]/gu);
  if (simples === null) return false;
  return simples.every((simple) => matchesSimple(node, simple));
}

/**
 * Split a selector into its compound parts on whitespace, but only whitespace
 * that is really a descendant combinator.
 *
 * A naive `split(/\s+/)` also cuts inside brackets, so `.cy-song[data-current=
 * "true"]` became two tokens and then silently matched nothing — the query
 * returned null, the guard that called it skipped its work, and the test looked
 * like it was asserting something when it was not.
 *
 * @param {string} selector - the selector to split.
 * @returns {string[]} compound selectors, outermost ancestor first.
 */
function compoundParts(selector) {
  const parts = [];
  let current = '';
  let depth = 0;
  let quote = null;
  for (const char of selector.trim()) {
    if (quote !== null) {
      current += char;
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }
    if (char === '[' || char === '(') depth += 1;
    if (char === ']' || char === ')') depth -= 1;
    if (depth === 0 && /\s/u.test(char)) {
      if (current !== '') parts.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  if (current !== '') parts.push(current);
  return parts;
}

/**
 * Match a node against a selector, including a selector list and the descendant
 * combinator used by a few of this plugin's queries (`.cy-transport .cy-btn`).
 */
function matchesSelector(node, selector) {
  const branches = selectorBranches(selector);
  if (branches.length === 0) return false;
  if (branches.length > 1) return branches.some((branch) => matchesSelector(node, branch));
  const parts = compoundParts(branches[0]);
  if (parts.length === 0) return false;
  if (parts.length === 1) return matches(node, parts[0]);
  let index = parts.length - 1;
  if (!matches(node, parts[index])) return false;
  index -= 1;
  let current = node.parentNode;
  while (index >= 0 && current !== null && current !== undefined && current.nodeType === 1) {
    if (matches(current, parts[index])) index -= 1;
    current = current.parentNode;
  }
  return index < 0;
}

class ShimNode {
  constructor(tag, nodeType = 1) {
    this.tagName = nodeType === 1 ? String(tag).toUpperCase() : '#text';
    this.nodeType = nodeType;
    this.childNodes = [];
    this.parentNode = null;
    this.attributes = {};
    /**
     * The attributes that a real DOM reflects back as properties.
     *
     * `image.src = url` updates the `src` attribute in a browser; without that,
     * a test reading `getAttribute('src')` sees `null` and blames the code. The
     * two directions are kept in step rather than only one, because both are
     * used in the bundle and a mismatch is invisible until something asserts it.
     */
    for (const reflected of ['src', 'href', 'alt', 'value', 'id', 'type', 'name']) {
      Object.defineProperty(this, reflected, {
        configurable: true,
        enumerable: true,
        get: () => {
          const stored = this.attributes[reflected];
          return stored === undefined ? '' : stored;
        },
        set: (next) => { this.attributes[reflected] = String(next); }
      });
    }
    /**
     * A style object with the two methods the bundle actually calls.
     *
     * A bare `{}` was enough while every writer assigned a plain property
     * (`node.style.filter = …`) and stopped being enough the moment something
     * wrote a custom property (`style.setProperty('--x', …)`) — which is the
     * normal way to hand a value to a stylesheet.
     *
     * Both traps write to the plain object *and* to a separate `__props` map, so
     * a plain assignment and a `setProperty` are readable the same two ways.
     * Routing plain writes only into `__props` looked tidier and broke every
     * read-back (`style.display` came out `undefined`), which is what a real
     * CSSStyleDeclaration never does.
     */
    this.style = new Proxy({ __props: {} }, {
      get: (target, key) => {
        if (key === 'setProperty') {
          return (name, value) => {
            target.__props[name] = String(value);
            target[name] = String(value);
          };
        }
        if (key === 'removeProperty') {
          return (name) => {
            delete target.__props[name];
            delete target[name];
          };
        }
        if (key === 'getPropertyValue') {
          return (name) => {
            const value = target.__props[name];
            return value === undefined ? '' : value;
          };
        }
        return target[key];
      },
      set: (target, key, value) => {
        target[key] = value;
        if (typeof key === 'string') target.__props[key] = value;
        return true;
      }
    });
    // `attributes` is the single store: dataset is a view onto the data-*
    // entries, exactly like the real DOM. Keeping two mirrored objects meant the
    // two write paths disagreed — `node.dataset.track = x` left getAttribute
    // returning null — which is a difference the real platform does not have.
    this.dataset = new Proxy({}, {
      get: (target, key) => {
        if (typeof key !== 'string') return target[key];
        const value = this.attributes[`data-${kebab(key)}`];
        return value === undefined ? undefined : value;
      },
      set: (target, key, value) => {
        if (value === undefined || value === null) delete this.attributes[`data-${kebab(key)}`];
        else this.attributes[`data-${kebab(key)}`] = String(value);
        return true;
      },
      deleteProperty: (target, key) => {
        delete this.attributes[`data-${kebab(key)}`];
        return true;
      },
      has: (target, key) => typeof key === 'string' && `data-${kebab(key)}` in this.attributes,
      ownKeys: () => Object.keys(this.attributes)
        .filter((name) => name.startsWith('data-'))
        .map((name) => camel(name.slice('data-'.length))),
      getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true })
    });
    // `this.style` is assigned above, as a Proxy. It used to be a bare `{}` set
    // here, which silently undid the proxy — the two assignments were a few
    // lines apart and the later one won.
    this.listeners = new Map();
    this._text = nodeType === 3 ? String(tag) : '';
    this.offsetWidth = 40;
    this.offsetHeight = 40;
    // Media element surface, so the music player and video wallpaper paths run.
    this.paused = true;
    this.currentTime = 0;
    this.duration = Number.NaN;
  }

  /**
   * Record a scroll request instead of performing it.
   *
   * The shim has no layout, so there is nothing to scroll — but "which element
   * asked to be scrolled into view" is exactly the observable a test needs, and
   * without this method the production guard (`typeof node.scrollIntoView ===
   * 'function'`) skips the call and the test would pass vacuously.
   */
  scrollIntoView(options) {
    globalThis.__scrolls?.push({
      track: this.getAttribute('data-track'),
      current: this.getAttribute('data-current'),
      block: options?.block ?? null
    });
  }

  get className() {
    return this.attributes.class ?? '';
  }

  set className(value) {
    this.attributes.class = String(value);
    this._syncClassList();
  }

  get classList() {
    if (this._classList === undefined) this._syncClassList();
    return this._classList;
  }

  _syncClassList() {
    const read = () => String(this.attributes.class ?? '').split(/\s+/u).filter(Boolean);
    const write = (list) => {
      this.attributes.class = list.join(' ');
    };
    this._classList = {
      contains: (name) => read().includes(name),
      add: (name) => {
        if (!read().includes(name)) write([...read(), name]);
      },
      remove: (name) => write(read().filter((item) => item !== name))
    };
  }

  get textContent() {
    if (this.nodeType === 3) return this._text;
    return this.childNodes.map((child) => child.textContent).join('');
  }

  set textContent(value) {
    if (this.nodeType === 3) {
      this._text = String(value);
      return;
    }
    this.childNodes = [];
    if (value !== '') this.appendChild(new ShimNode(String(value), 3));
  }

  set innerHTML(value) {
    this.childNodes = [];
    this._text = String(value);
  }

  get firstChild() {
    return this.childNodes.length > 0 ? this.childNodes[0] : null;
  }

  get isConnected() {
    let node = this;
    while (node.parentNode !== null) node = node.parentNode;
    return node === globalThis.__document || node === globalThis.__document?.body;
  }

  appendChild(node) {
    if (node === null || node === undefined) return node;
    if (node.parentNode !== null) node.parentNode.removeChild(node);
    node.parentNode = this;
    this.childNodes.push(node);
    globalThis.__notifyMutation?.(this, node);
    return node;
  }

  /**
   * Insert `node` before `reference`.
   *
   * The index is computed **after** the node being moved has been detached from
   * its old position, not before. A real `Node.insertBefore` is defined in terms
   * of removing and inserting, and the shortcut of reading the reference's index
   * first is wrong in the one case that matters: when the reference sits before
   * the node being moved, detaching shifts it one place left and the insertion
   * lands one slot too far right — which put a dragged element *before* the gap it
   * was supposed to follow, silently, with no error anywhere.
   *
   * @param {object} node - the node to insert.
   * @param {object} reference - the node to insert it before.
   * @returns {object} the inserted node.
   */
  insertBefore(node, reference) {
    if (globalThis.__traceDom) {
      globalThis.__traceDom('enter node=' + (node.dataset?.id ?? node.attributes?.class)
        + ' hasParent=' + (node.parentNode !== null && node.parentNode !== undefined)
        + ' parentHasNode=' + (node.parentNode !== null && node.parentNode !== undefined
          ? node.parentNode.childNodes.indexOf(node) : 'n/a'));
    }
    if (reference === null || reference === undefined) return this.appendChild(node);
    if (node.parentNode !== null) node.parentNode.removeChild(node);
    const at = this.childNodes.indexOf(reference);
    if (globalThis.__traceDom) {
      globalThis.__traceDom('PROBE isArray=' + Array.isArray(this.childNodes) + ' len=' + this.childNodes.length
        + ' at=' + at + ' refIsNull=' + (reference === null) + ' refTag=' + String(reference)
        + ' refInList=' + (this.childNodes.indexOf(reference) !== -1)
        + ' list=' + JSON.stringify(this.childNodes.map((n) => n.dataset?.id ?? n.attributes?.class)));
    }
    if (at === -1) return this.appendChild(node);
    node.parentNode = this;
    const live = this.childNodes;
    if (globalThis.__traceDom) {
      globalThis.__traceDom('HARNESS at=' + at + ' live[at]=' + (live[at]?.dataset?.id ?? live[at]?.attributes?.class)
        + ' live=' + live.map((n) => n.dataset?.id ?? n.attributes?.class).join('|')
        + ' indexOfMoving=' + live.indexOf(node) + ' indexOfRef=' + live.indexOf(reference));
    }
    live.splice(at, 0, node);
    if (globalThis.__traceDom) {
      globalThis.__traceDom('HARNESS after live=' + live.map((n) => n.dataset?.id ?? n.attributes?.class).join('|')
        + ' movingAt=' + live.indexOf(node));
    }
    globalThis.__notifyMutation?.(this, node);
    return node;
  }

  removeChild(node) {
    const at = this.childNodes.indexOf(node);
    if (at !== -1) this.childNodes.splice(at, 1);
    if (globalThis.__traceDom) {
      globalThis.__traceDom('removeChild ' + (node.dataset?.id ?? node.attributes?.class) + ' at=' + at
        + ' -> ' + JSON.stringify(this.childNodes.map((n) => n.dataset?.id ?? n.attributes?.class)));
    }
    node.parentNode = null;
    return node;
  }
  remove() {
    if (this.parentNode !== null) this.parentNode.removeChild(this);
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value);
  }

  getAttribute(name) {
    return this.attributes[name] === undefined ? null : this.attributes[name];
  }

  removeAttribute(name) {
    delete this.attributes[name];
  }

  hasAttribute(name) {
    return this.attributes[name] !== undefined;
  }

  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(listener);
  }

  removeEventListener(type, listener) {
    const list = this.listeners.get(type);
    if (list === undefined) return;
    const at = list.indexOf(listener);
    if (at !== -1) list.splice(at, 1);
  }

  dispatchEvent(event) {
    const list = this.listeners.get(event.type) ?? [];
    for (const listener of [...list]) listener.call(this, event);
    // Honour stopPropagation: the wallpaper grid relies on it so the corner
    // selection circle does not also apply the wallpaper.
    if (event.__stopped === true) return true;
    if (this.parentNode !== null) {
      this.parentNode.dispatchEvent(event);
      return true;
    }
    // Bubbling continues out of the document and into the window, which is a
    // different object with its own listeners — the pointer effects, the dock's
    // own bar drag and the window `resize` hook all live there. Stopping at the
    // document meant every one of those was unreachable from a test: a dispatched
    // `pointermove` reached the target and then went nowhere, so a drag looked
    // like a press that never moved.
    if (this.nodeType === 9 && typeof globalThis.__windowDispatch === 'function') {
      globalThis.__windowDispatch(event);
    }
    return true;
  }

  contains(node) {
    let current = node;
    while (current !== null && current !== undefined) {
      if (current === this) return true;
      current = current.parentNode;
    }
    return false;
  }

  closest(selector) {
    // A selector list is any-of, so each branch is tried separately. Passing the
    // whole list to a single-selector matcher is how `[contenteditable="true"],
    // [contenteditable=""]` quietly stopped matching anything.
    const branches = selectorBranches(selector);
    let node = this;
    while (node !== null && node !== undefined && node.nodeType === 1) {
      for (const branch of branches) {
        if (matchesSelector(node, branch)) return node;
      }
      node = node.parentNode;
    }
    return null;
  }

  querySelectorAll(selector) {
    const found = [];
    const walk = (node) => {
      for (const child of node.childNodes) {
        if (matchesSelector(child, selector)) found.push(child);
        walk(child);
      }
    };
    walk(this);
    return found;
  }

  querySelector(selector) {
    const all = this.querySelectorAll(selector);
    return all.length > 0 ? all[0] : null;
  }

  /**
   * The element's box.
   *
   * There is no layout engine here, so the numbers are synthetic — but they are
   * per-node rather than global, and they carry a gap between siblings. Returning
   * one fixed rectangle for every element made geometry-based code untestable in
   * a way that was invisible: a drag that asks "which neighbour has the pointer
   * crossed" got identical answers for all of them.
   *
   * The geometry is also the reason the slot box is 30 px in a 40 px pitch. That
   * is the shape the stylesheet draws — a round button with a little air around
   * it — and it decides whether a given drag crosses a boundary. With no gap at
   * all, adjacent slots touch, and the smallest move that enters the next slot
   * is an entire button-width; with a gap, a deliberate nudge is enough.
   */
  getBoundingClientRect() {
    if (this.__rect === undefined) {
      let index = 0;
      const parent = this.parentNode;
      if (parent !== null && parent !== undefined) {
        for (let at = 0; at < parent.childNodes.length; at += 1) {
          if (parent.childNodes[at] === this) break;
          if (parent.childNodes[at].nodeType === 1) index += 1;
        }
      }
      this.__rect = {
        left: 400 + index * 40,
        top: 600,
        width: 30,
        height: 30
      };
      this.__rect.right = this.__rect.left + this.__rect.width;
      this.__rect.bottom = this.__rect.top + this.__rect.height;
      this.__rect.x = this.__rect.left;
      this.__rect.y = this.__rect.top;
    }
    return this.__rect;
  }

  setPointerCapture() {}
  releasePointerCapture() {}
  focus() {}
  blur() {}
  select() {}
  /**
   * Canvas serialisation.
   *
   * The returned data URL encodes this canvas' own width and height, so a test
   * can read back the size an image was downscaled to rather than only that
   * *some* data URL came out. Without this method the avatar path threw, and a
   * test that only checked for "a data URL" would have measured the fallback.
   */
  toDataURL(type = 'image/webp') {
    return `data:${type};base64,W${this.width}H${this.height}`;
  }
  /**
   * Canvas support: the particle field and the pointer effects both need a 2D
   * context. The context is attached to the node as `__ctx` so a test can read
   * back what was drawn — drawing is otherwise unobservable from the DOM.
   */
  getContext() {
    const context = makeCanvasContext();
    this.__ctx = context;
    return context;
  }
  /** Media element support for `<audio>` and `<video>`. */
  play() {
    this.paused = false;
    this.dispatchEvent({ type: 'play', target: this });
    return Promise.resolve();
  }
  pause() {
    this.paused = true;
    this.dispatchEvent({ type: 'pause', target: this });
  }
  load() {
    this.dispatchEvent({ type: 'loadedmetadata', target: this });
  }
  click() {
    const event = {
      type: 'click',
      target: this,
      __stopped: false,
      preventDefault() {},
      stopPropagation() {
        event.__stopped = true;
      }
    };
    this.dispatchEvent(event);
  }
}

/* ------------------------------------------------------------------ *
 * Browser environment
 * ------------------------------------------------------------------ */

/** A 2D context stub: enough for the particle field to actually run. */
function makeCanvasContext() {
  /**
   * Every call that puts ink on the canvas, in order.
   *
   * A test asserts on this rather than on a pixel: the stub has no rasteriser,
   * so "did the burst draw" is exactly "did `arc` + `stroke`/`fill` get called
   * after the pointer event" — which is the contract that matters and is
   * stable across engines.
   */
  const calls = [];
  return {
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    globalCompositeOperation: 'source-over',
    setTransform() {},
    clearRect() {
      calls.push('clearRect');
    },
    beginPath() {},
    arc(x, y, radius) {
      calls.push('arc');
      void x; void y; void radius;
    },
    fill() {
      calls.push('fill');
    },
    stroke() {
      calls.push('stroke');
    },
    createRadialGradient() {
      return { addColorStop() {} };
    },
    /**
     * Blit, recorded.
     *
     * The destination size is what the avatar downscale is judged on: the stub
     * has no rasteriser, so "the stored image is at most 160 px" is exactly "the
     * canvas was sized that way and `drawImage` was told to fill it".
     */
    drawImage(image, dx, dy, width, height) {
      calls.push('drawImage');
      this.__drawn = { image, dx, dy, width, height };
    },
    /** Test-only handle; nothing in the bundle reads it. */
    __calls: calls
  };
}

/**
 * A Web Audio stub: enough for the typing synth to actually run, and it counts
 * the voices requested so a test can prove sound was produced rather than only
 * that nothing threw.
 * @param {{oscillators: number}} stats - incremented per created voice.
 */
function makeAudioContext(stats) {
  const gain = () => ({
    gain: {
      setValueAtTime() {},
      linearRampToValueAtTime() {},
      exponentialRampToValueAtTime() {}
    },
    connect() {},
    disconnect() {}
  });
  const source = () => ({ connect() {}, start() {}, stop() {} });
  return {
    state: 'running',
    currentTime: 0,
    sampleRate: 48000,
    destination: {},
    createGain: gain,
    createOscillator: () => {
      stats.oscillators += 1;
      return {
        type: '',
        frequency: { setValueAtTime() {}, exponentialRampToValueAtTime() {} },
        connect() {},
        start() {},
        stop() {}
      };
    },
    createBuffer: (_channels, frames) => ({ getChannelData: () => new Float32Array(frames) }),
    createBufferSource: source,
    createBiquadFilter: () => ({ type: '', frequency: { value: 0 }, Q: { value: 0 }, connect() {} }),
    resume() {
      return Promise.resolve();
    },
    close() {
      return Promise.resolve();
    }
  };
}

/** A storage stub. */
function makeStorage() {
  const map = new Map();
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
    clear: () => map.clear(),
    get size() {
      return map.size;
    }
  };
}

/**
 * Build a fresh sandbox with the shim installed.
 * @returns {object} the sandbox, with `document`, `fetch` and helpers attached.
 */
export function createEnvironment() {
  const document = new ShimNode('#document');
  document.head = new ShimNode('head');
  document.body = new ShimNode('body');
  document.documentElement = new ShimNode('html');
  // What the host declares about its own language. Defaults to `zh-CN`, matching
  // this deployment; a test can point it elsewhere to exercise the language
  // layer, which reads exactly these two signals.
  document.documentElement.attributes.lang = 'zh-CN';
  document.appendChild(document.head);
  document.appendChild(document.body);
  document.nodeType = 9;
  document.hidden = false;
  document.execCommand = () => true;
  document.createElement = (tag) => new ShimNode(tag);
  /**
   * Namespaced element creation, which is what an inline SVG needs.
   *
   * `createElement('svg')` makes an `HTMLUnknownElement` in a real document,
   * which is laid out as nothing — an icon that draws nowhere and throws nowhere.
   * A browser distinguishes the two by namespace and so has to this shim, or the
   * tests would pass against markup that renders as an empty gap.
   *
   * @param {string} namespace - the namespace URI.
   * @param {string} tag - the element's local name.
   * @returns {object} the shim node, with its namespace recorded.
   */
  document.createElementNS = (namespace, tag) => {
    const node = new ShimNode(tag);
    node.namespaceURI = String(namespace);
    return node;
  };
  document.createTextNode = (text) => new ShimNode(String(text), 3);
  document.getElementById = (id) => document.body.querySelectorAll(`#${id}`).length > 0
    ? document.body.querySelectorAll(`#${id}`)[0]
    : null;

  const frames = [];
  const timers = new Map();
  let timerId = 0;
  /** Blobs handed to `URL.createObjectURL`, so a test can read what was exported. */
  const downloads = [];
  const observers = [];

  globalThis.__document = document;
  // Scroll requests land here, so tests can assert that the list moved (see
  // ShimNode.scrollIntoView). It hangs off the outer global for the same reason
  // __document does: the shim runs outside the sandbox, so this is the `globalThis`
  // its methods actually see.
  globalThis.__scrolls = [];
  globalThis.__notifyMutation = (parent, added) => {
    for (const observer of observers) observer._feed(parent, added);
  };

  /** A mutation record observer over the shim. */
  class ShimMutationObserver {
    constructor(callback) {
      this.callback = callback;
      this.targets = [];
      observers.push(this);
    }

    observe(target) {
      this.targets.push(target);
    }

    disconnect() {
      const at = observers.indexOf(this);
      if (at !== -1) observers.splice(at, 1);
      this.targets = [];
    }

    _feed(parent, added) {
      const relevant = this.targets.some((target) => target === parent || target.contains(parent));
      if (!relevant) return;
      this.callback([{ type: 'childList', target: parent, addedNodes: [added], removedNodes: [] }], this);
    }
  }

  const fetchLog = [];
  const audioStats = { oscillators: 0 };
  /** A controllable clock: the typing synth throttles on `performance.now()`. */
  let clock = 1_700_000_000_000;
  const responses = new Map();
  const fetchImpl = (url, options) => {
    const path = String(url);
    fetchLog.push({ path, method: (options && options.method) || 'GET' });
    const canned = responses.get(path.split('?')[0]);
    const body = canned === undefined ? { plugin: 'dsh-theme-cyrene', wallpapers: [], music: [], covers: [], boot: [], emotes: [], state: {}, limits: {} } : canned;
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve(body),
      text: () => Promise.resolve(JSON.stringify(body))
    });
  };

  /**
   * Window-level listeners, keyed by type.
   *
   * Declared outside the sandbox literal because the accessors below close over
   * it and would otherwise read `undefined` — the sandbox is built in one pass,
   * so a `let` inside it is not yet initialised when its own methods are defined.
   */
  let listeners;

  const sandbox = {
    console,
    setTimeout: (fn, ms) => {
      timerId += 1;
      timers.set(timerId, { fn, ms });
      return timerId;
    },
    clearTimeout: (id) => timers.delete(id),
    setInterval: (fn, ms) => {
      timerId += 1;
      timers.set(timerId, { fn, ms, repeating: true });
      return timerId;
    },
    clearInterval: (id) => timers.delete(id),
    requestAnimationFrame: (fn) => {
      frames.push(fn);
      return frames.length;
    },
    cancelAnimationFrame: (id) => {
      frames[id - 1] = null;
    },
    fetch: fetchImpl,
    performance: { now: () => clock },
    navigator: {},
    MutationObserver: ShimMutationObserver,
    Node: ShimNode,
    document,
    /**
     * The three browser APIs the font-set export and import need.
     *
     * Stubbed rather than omitted so the download and the file read can be
     * asserted at all: without them the panel silently takes its `catch` path
     * (export) and its `FileReader` is undefined (import), and a test would be
     * measuring the fallback instead of the feature.
     */
    Blob: function BlobStub(parts, options) {
      this.parts = parts;
      this.type = options && options.type;
      this.text = () => Promise.resolve(parts.join(''));
    },
    /**
     * `new Image()`, which is an `<img>` plus an implicit decode.
     *
     * A real `Image` fires `load` once the bytes are in; this one fires it on the
     * next tick so the code that waits for it can be exercised at all. The
     * dimensions are the shim's own, which is what the avatar downscale reads to
     * decide its scale factor.
     */
    Image: function ImageStub() {
      const image = new ShimNode('img');
      image.width = 1200;
      image.height = 600;
      let assigned = '';
      Object.defineProperty(image, 'src', {
        configurable: true,
        get: () => assigned,
        set: (next) => {
          assigned = String(next);
          image.attributes.src = assigned;
          setImmediate(() => {
            if (typeof image.onload === 'function') image.onload({ target: image });
          });
        }
      });
      return image;
    },
    URL: {
      createObjectURL(blob) {
        downloads.push(blob);
        return 'blob:stub/' + downloads.length;
      },
      revokeObjectURL() {}
    },
    FileReader: function FileReaderStub() {
      const reader = this;
      this.result = null;
      this.onload = null;
      this.onerror = null;
      reader.readAsText = (file) => {
        reader.result = file.__text === undefined ? '' : file.__text;
        if (typeof reader.onload === 'function') reader.onload({ target: reader });
      };
    },
    __downloads: downloads,
    __readFile(text) {
      return { __text: text, name: 'cyrene-fontsets.json', type: 'application/json' };
    },
    innerWidth: 1440,
    innerHeight: 900,
    devicePixelRatio: 2,
    localStorage: makeStorage(),
    sessionStorage: makeStorage(),
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    AudioContext: function AudioContextStub() {
      return makeAudioContext(audioStats);
    },
    /**
     * Window-level listeners, recorded rather than dropped.
     *
     * The pointer effects listen on `window`, so a test that wants to prove
     * "a click draws" has to be able to fire one. `__dispatch` is the test-only
     * door; nothing in the bundle sees it.
     */
    addEventListener(type, listener) {
      if (listeners === undefined) listeners = new Map();
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(listener);
    },
    removeEventListener(type, listener) {
      if (listeners === undefined) return;
      const list = listeners.get(type);
      if (list === undefined) return;
      const at = list.indexOf(listener);
      if (at >= 0) list.splice(at, 1);
    },
    dispatchEvent() {
      return true;
    },
    /** Fire every listener registered for `type`; the test-only entry point. */
    __dispatch(type, event) {
      if (listeners === undefined) return 0;
      const list = [...(listeners.get(type) ?? [])];
      for (const listener of list) listener.call(sandbox, { type, ...event });
      return list.length;
    },
    /**
     * Deliver one already-constructed event to the window's listeners.
     *
     * Not `__dispatch`, which builds a fresh event from a type and a bag of
     * properties — a test-only shortcut that would lose the `target` and the
     * `preventDefault` a real bubbling event carries, and those are exactly what
     * a drag handler reads.
     */
    __dispatchNode(event) {
      if (listeners === undefined) return 0;
      const list = [...(listeners.get(event.type) ?? [])];
      for (const listener of list) listener.call(sandbox, event);
      return list.length;
    },
    /** How many listeners are live for a type, so a test can prove cleanup. */
    __listenerCount(type) {
      if (listeners === undefined) return 0;
      return (listeners.get(type) ?? []).length;
    },
    __loaderCalls: [],
    __frames: frames,
    __timers: timers,
    __fetchLog: fetchLog,
    __responses: responses,
    /** How many audio voices the synth has created. */
    __audio: audioStats,
    /** Move the virtual clock forward, so throttled work can be re-triggered. */
    __advance(milliseconds) {
      clock += milliseconds;
    },
    /** Run pending animation frames a bounded number of times. */
    __flushFrames(times = 1) {
      for (let round = 0; round < times; round += 1) {
        const pending = frames.splice(0, frames.length);
        for (const fn of pending) if (fn !== null) fn(round * 16);
      }
    },
    /** Run every pending timer callback regardless of its delay. */
    __flushTimers() {
      const pending = [...timers.entries()];
      for (const [id, timer] of pending) {
        if (!timer.repeating) timers.delete(id);
        timer.fn();
      }
    },
    /** Count scheduled timers, for leak assertions. */
    __timerCount() {
      return timers.size;
    }
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;
  // The far end of event bubbling. `globalThis` here is the harness's own realm,
  // which is the `globalThis` a shim node's methods actually see (the same reason
  // `__document` and `__scrolls` hang off it), so this is how a bubbled event
  // reaches listeners registered on the window.
  globalThis.__windowDispatch = (event) => sandbox.__dispatchNode(event);
  sandbox.window.__ModuleLoader__ = {
    load(spec) {
      sandbox.__loaderCalls.push(spec);
    }
  };
  return sandbox;
}

/**
 * Run the built bundle in a fresh environment and mount it.
 * @param {{responses?: Map<string, object>}} [options] - canned host responses,
 *   installed before `apply` runs so the mount-time manifest fetch sees them.
 * @returns {Promise<object>} the harness.
 */
export async function mountPlugin(options = {}) {
  const code = readFileSync(BUNDLE, 'utf8');
  /** Where the plugin mirrors its settings; spelled here so a test can seed it. */
  const LOCAL_SETTINGS_KEY = 'dsh-theme-cyrene:settings';
  const sandbox = createEnvironment();
  if (options.language !== undefined) {
    // The two signals the language layer reads: the host's declaration, and the
    // navigator fallback for a host that never declares one.
    sandbox.document.documentElement.attributes.lang = String(options.language);
    sandbox.navigator.language = String(options.language);
    // `withoutLangAttribute` drops the first signal, so the fallback path can be
    // exercised on its own — otherwise both are always set and the fallback is
    // never the thing under test.
    if (options.withoutLangAttribute === true) {
      delete sandbox.document.documentElement.attributes.lang;
    }
  }
  if (options.settings !== undefined) {
    // Seed the stored document before the plugin reads it, so a test can start
    // from a state the user would have reached through the panel — restoring a
    // custom avatar, for instance — without driving a file picker first.
    sandbox.localStorage.setItem(LOCAL_SETTINGS_KEY, JSON.stringify(options.settings));
  }
  if (options.responses !== undefined) {
    for (const [path, body] of options.responses) sandbox.__responses.set(path, body);
  }
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: 'client.js' });

  if (sandbox.__loaderCalls.length !== 1) {
    throw new Error(`the bundle must call __ModuleLoader__.load exactly once, saw ${sandbox.__loaderCalls.length}`);
  }
  const spec = sandbox.__loaderCalls[0];
  if (spec.id !== 'dsh-theme-cyrene') throw new Error(`loader id must be the package name, saw ${spec.id}`);

  const plugin = spec.factory(() => {
    throw new Error('the browser half must not require() anything');
  });
  if (typeof plugin.apply !== 'function') throw new Error('the plugin must export apply()');
  if (!Array.isArray(plugin.inject) || !plugin.inject.includes('theme')) {
    throw new Error('the plugin must inject the theme service');
  }

  const registered = [];
  const activated = [];
  const disposers = [];
  const themeListeners = [];
  const ctx = {
    theme: {
      register(definition) {
        registered.push(definition);
        return () => {
          disposers.push('theme');
        };
      },
      setTheme(id) {
        activated.push(id);
      }
    },
    on(event, handler) {
      if (event === 'theme/change') themeListeners.push(handler);
      return () => {
        const at = themeListeners.indexOf(handler);
        if (at !== -1) themeListeners.splice(at, 1);
      };
    },
    effect(factory, label) {
      const dispose = factory();
      disposers.push({ label, dispose });
      return () => {};
    }
  };

  plugin.apply(ctx);
  // Let the manifest fetch and its continuation settle.
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  /**
   * A test's door onto the settings document.
   *
   * `applySettings` lives inside the factory's scope, so there is no way to call
   * it from out here — and driving every setting through the control that writes
   * it means a test about *what a setting does* has to first be a test about the
   * control. It goes through the bundle's own function rather than writing
   * `localStorage` directly, so subscribers, the host push and the local mirror
   * all run exactly as they do in the browser.
   */
  sandbox.__applySettings = (patch) => {
    const hook = plugin.__applySettings;
    if (typeof hook !== 'function') throw new Error('the bundle no longer exposes __applySettings');
    hook(patch);
  };

  return { sandbox, plugin, registered, activated, disposers, themeListeners };
}

export { BUNDLE, ShimNode };
