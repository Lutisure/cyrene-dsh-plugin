/**
 * DOM, storage and HTTP helpers shared by every subsystem.
 *
 * The settings model is deliberately layered: an in-memory document, mirrored
 * to `localStorage` for an instant, flicker-free boot, and synced to the host
 * half's `state.json` so the choice survives a different browser or profile.
 */

/** The SVG namespace. `createElement` cannot build an icon; this can. */
var SVG_NS = "http://www.w3.org/2000/svg";

/**
 * Create an element.
 * @param {string} tag - tag name.
 * @param {object} [props] - attributes; `class`, `text`, `html`, `style`,
 *   `dataset` and `on<Event>` are handled specially, `false`/`null`/`undefined`
 *   attributes are skipped.
 * @param {Array|Node|string} [children] - child nodes or text.
 * @returns {HTMLElement} the new element.
 */
function el(tag, props, children) {
  var node = document.createElement(tag);
  if (props) {
    for (var key in props) {
      if (!Object.prototype.hasOwnProperty.call(props, key)) continue;
      var value = props[key];
      if (value === undefined || value === null || value === false) continue;
      if (key === "class") node.className = value;
      // `translate` lives in `22-lang.js`, which loads after this file but before
      // anything calls `el()` — the panels are only built at mount. Routing the
      // user-facing text through here rather than at each of the ~120 call sites
      // is what keeps the language layer from being a rewrite of every panel.
      else if (key === "text") node.textContent = translate(value);
      else if (key === "title") node.setAttribute("title", translate(value));
      else if (key === "placeholder") node.setAttribute("placeholder", translate(value));
      else if (key === "aria-label") node.setAttribute("aria-label", translate(value));
      else if (key === "html") node.innerHTML = value;
      else if (key === "style" && typeof value === "object") {
        for (var prop in value) node.style[prop] = value[prop];
      } else if (key === "dataset" && typeof value === "object") {
        for (var data in value) node.dataset[data] = value[data];
      } else if (key.slice(0, 2) === "on" && typeof value === "function") {
        node.addEventListener(key.slice(2).toLowerCase(), value);
      } else {
        node.setAttribute(key, value === true ? "" : String(value));
      }
    }
  }
  append(node, children);
  return node;
}

/**
 * Append children of any supported shape.
 * @param {Node} node - the parent.
 * @param {Array|Node|string|number} [children] - the children.
 * @returns {Node} the parent.
 */
function append(node, children) {
  if (children === undefined || children === null || children === false) return node;
  if (Array.isArray(children)) {
    for (var index = 0; index < children.length; index += 1) append(node, children[index]);
    return node;
  }
  if (children instanceof Node) node.appendChild(children);
  else node.appendChild(document.createTextNode(String(children)));
  return node;
}

/** Remove every child of a node. */
function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

/** Clamp a number into an inclusive range. */
function clamp(value, min, max) {
  return value < min ? min : value > max ? max : value;
}

/**
 * Create one element in the SVG namespace.
 *
 * `el()` cannot do this: `document.createElement("svg")` makes an HTMLUnknownElement
 * that a browser lays out as nothing at all, which is precisely how a drawn icon
 * turns into an invisible button without an error anywhere. The icon factory
 * below is the only place that needs it.
 *
 * @param {string} tag - SVG tag name, e.g. `path`.
 * @param {object} [attributes] - attributes to set verbatim.
 * @returns {Element} the SVG element.
 */
function svgEl(tag, attributes) {
  var node = document.createElementNS(SVG_NS, tag);
  if (attributes) {
    for (var key in attributes) {
      if (Object.prototype.hasOwnProperty.call(attributes, key)) {
        node.setAttribute(key, String(attributes[key]));
      }
    }
  }
  return node;
}

/**
 * Every element under `root` matching a selector, as a real array.
 *
 * The DOM returns a `NodeList`; everything in this plugin wants `map`, `filter`
 * and `forEach`, and converting at each of the dozen call sites is the sort of
 * thing that gets forgotten once and throws only in the browser.
 *
 * @param {Node} root - the subtree root (excluded itself).
 * @param {string} selector - the selector.
 * @returns {Element[]} matches, in document order.
 */
function queryAll(root, selector) {
  return Array.prototype.slice.call(root.querySelectorAll(selector));
}

/**
 * Two nodes that must share one parent, with `mover` placed before `anchor`.
 *
 * Used by both reorder paths — the drag drop and the Alt+Arrow key — so the two
 * cannot drift apart on the one detail that matters, the direction of the
 * insert. Being given a node that is not in the group is not an error: the
 * caller is rebuilding the bar, and `appendChild` puts it back.
 *
 * @param {Element} group - the container.
 * @param {Element} mover - the node to move.
 * @param {Element|null} anchor - the node to insert before, or null for the end.
 * @returns {void}
 */
function moveBefore(group, mover, anchor) {
  if (anchor === null || anchor === undefined) group.appendChild(mover);
  else group.insertBefore(mover, anchor);
}

/** Seconds → `m:ss`. */
function formatTime(seconds) {
  if (!isFinite(seconds) || seconds < 0) return "0:00";
  var total = Math.floor(seconds);
  var minutes = Math.floor(total / 60);
  var rest = total % 60;
  return minutes + ":" + (rest < 10 ? "0" : "") + rest;
}

/** Whether the user asked for reduced motion. */
function prefersReducedMotion() {
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch (error) {
    return false;
  }
}

/** Trailing-edge debounce. */
function debounce(fn, wait) {
  var timer = null;
  return function () {
    var args = arguments;
    var self = this;
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(function () {
      timer = null;
      fn.apply(self, args);
    }, wait);
  };
}

/** Deep-merge plain objects; arrays and scalars are replaced wholesale. */
function mergeDeep(base, patch) {
  if (!isPlainObject(patch)) return patch === undefined ? base : patch;
  var out = isPlainObject(base) ? base : {};
  for (var key in patch) {
    if (!Object.prototype.hasOwnProperty.call(patch, key)) continue;
    var value = patch[key];
    out[key] = isPlainObject(value) && isPlainObject(out[key]) ? mergeDeep(out[key], value) : value;
  }
  return out;
}

/** Whether a value is a plain object. */
function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A stable-ish unique id for DOM wiring. */
var uidCounter = 0;
function uid(prefix) {
  uidCounter += 1;
  return prefix + "-" + uidCounter;
}

/**
 * Attach a stylesheet this plugin owns, tagged so the module system and a
 * later review can tell where it came from.
 * @param {string} css - the stylesheet text.
 * @param {string} name - a stable name for the sheet.
 * @returns {() => void} a disposer that removes it.
 */
function mountStyle(css, name) {
  var style = document.createElement("style");
  style.dataset.plugin = PLUGIN_ID;
  style.dataset.pluginCss = PLUGIN_ID + "/" + name;
  style.textContent = css;
  document.head.appendChild(style);
  return function () {
    if (style.parentNode) style.parentNode.removeChild(style);
  };
}

/* ------------------------------------------------------------------ *
 * Asset catalog
 * ------------------------------------------------------------------ */

/** The union of build-time manifests and anything the host reports. */
var catalog = {
  wallpapers: [],
  music: [],
  covers: [],
  boot: [],
  emotes: [],
  pet: []
};

/** Reset the catalog to the build-time manifests. */
function primeCatalog() {
  catalog.wallpapers = WALLPAPERS.slice();
  catalog.music = MUSIC.slice();
  catalog.covers = COVERS.slice();
  catalog.boot = BOOT_ANIMATIONS.slice();
  catalog.emotes = EMOTES.slice();
  catalog.pet = PET.slice();
}

/**
 * Adopt the host's manifest as the catalog.
 *
 * The host half scans the same directories live, so its answer is always a
 * superset of the build-time lists — it knows about uploads and about files
 * dropped in after the last build, and it is the only source that knows the
 * uploads at all. It therefore *replaces* the catalog rather than merging into
 * it. Merging two sources with different ideas of `default` is how a fresh
 * install ends up seeding the wrong wallpaper.
 *
 * A key the host omits falls back to the build-time list, so a partial response
 * can never blank a bucket.
 *
 * @param {object} manifest - the `/manifest` response.
 * @returns {void}
 */
function adoptManifest(manifest) {
  if (!isPlainObject(manifest)) return;
  var adopt = function (key, fallback) {
    catalog[key] = Array.isArray(manifest[key]) ? manifest[key] : fallback.slice();
  };
  adopt("wallpapers", WALLPAPERS);
  adopt("music", MUSIC);
  adopt("covers", COVERS);
  adopt("boot", BOOT_ANIMATIONS);
  adopt("emotes", EMOTES);
  // The pet bucket carries a `role` on every entry, and those roles are a
  // *visual* fact read off the sticker sheet at build time — the host cannot
  // derive them. So the host may only override this bucket if it supplies
  // `role` too; otherwise her reactions silently all fall back to idle.
  adopt("pet", PET);
}

/** Entries of a bucket, minus anything the user hid. */
function visible(kind) {
  var hidden = (settings.hidden && settings.hidden[kind]) || [];
  return catalog[kind].filter(function (entry) {
    return hidden.indexOf(entry.id) === -1;
  });
}

/** Find one entry by id across a bucket. */
function findEntry(kind, id) {
  var list = catalog[kind];
  for (var index = 0; index < list.length; index += 1) {
    if (list[index].id === id) return list[index];
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * HTTP
 * ------------------------------------------------------------------ */

/**
 * Call the host half and parse JSON.
 * @param {string} path - path under {@link ROUTE}.
 * @param {{method?: string, body?: unknown}} [options] - request options.
 * @returns {Promise<any>} the parsed response.
 */
function api(path, options) {
  var init = { method: (options && options.method) || "GET", headers: {} };
  if (options && options.body !== undefined) {
    init.headers["content-type"] = "application/json";
    init.body = typeof options.body === "string" ? options.body : JSON.stringify(options.body);
  }
  return fetch(ROUTE + path, init).then(function (response) {
    if (!response.ok) {
      return response.text().then(function (text) {
        throw new Error(text.trim() || "HTTP " + response.status);
      });
    }
    return response.json();
  });
}

/**
 * Upload one file to a bucket.
 * @param {string} kind - `wallpaper` | `music` | `cover` | `emote` | `boot`.
 * @param {File} file - the chosen file.
 * @returns {Promise<object>} the host's record of the stored file.
 */
function uploadFile(kind, file) {
  var target = ROUTE + "/upload?kind=" + encodeURIComponent(kind) + "&name=" + encodeURIComponent(file.name);
  return fetch(target, { method: "POST", body: file }).then(function (response) {
    if (!response.ok) {
      return response.text().then(function (text) {
        throw new Error(text.trim() || "HTTP " + response.status);
      });
    }
    return response.json();
  });
}

/**
 * Move an uploaded file into the host's trash directory.
 * @param {string} bucket - the uploads bucket.
 * @param {string} name - the stored file name.
 * @returns {Promise<object>} the host's result.
 */
function del(bucket, name) {
  return api("/delete", { method: "POST", body: { bucket: bucket, name: name } });
}

/**
 * Put a trashed file back where it came from.
 * @param {string} bucket - the uploads bucket.
 * @param {string} name - the name inside the trash.
 * @returns {Promise<object>} the host's result.
 */
function restoreItem(bucket, name) {
  return api("/restore", { method: "POST", body: { bucket: bucket, name: name } });
}

/** List the trash. */
function listTrash() {
  return api("/trash");
}

/** Permanently clear the trash. */
function emptyTrash() {
  return api("/trash/empty", { method: "POST" });
}

/**
 * Re-read the host's manifest so uploads appear without a rebuild, and adopt
 * its persisted settings when it has something to say.
 *
 * An empty server document is treated as "nothing recorded yet" rather than as
 * "reset everything", so a fresh install does not wipe the localStorage mirror.
 *
 * @returns {Promise<object>} the manifest.
 */
function refreshManifest() {
  return api("/manifest").then(function (manifest) {
    adoptManifest(manifest);
    if (isPlainObject(manifest.state) && Object.keys(manifest.state).length > 0) {
      applySettings(manifest.state, { local: true });
    }
    return manifest;
  });
}

/* ------------------------------------------------------------------ *
 * Settings
 * ------------------------------------------------------------------ */

/** The live settings document. */
var settings = mergeDeep({}, DEFAULT_SETTINGS);

/** Change subscribers. */
var settingsListeners = [];

/** Read the localStorage mirror, tolerating disabled or corrupt storage. */
function readLocal() {
  try {
    var raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === null) return {};
    var parsed = JSON.parse(raw);
    return isPlainObject(parsed) ? parsed : {};
  } catch (error) {
    return {};
  }
}

/** Write the localStorage mirror, tolerating a full or disabled store. */
function writeLocal(value) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
  } catch (error) {
    /* private mode or quota: the server copy is still authoritative */
  }
}

/** Adopt the localStorage mirror, layered over the defaults. */
function loadSettings() {
  settings = mergeDeep(mergeDeep({}, DEFAULT_SETTINGS), readLocal());
  return settings;
}

/** Notify every subscriber of the current document. */
function emitSettings() {
  for (var index = 0; index < settingsListeners.length; index += 1) {
    try {
      settingsListeners[index](settings);
    } catch (error) {
      console.error(PLUGIN_ID + ": settings listener failed", error);
    }
  }
}

/** Subscribe to settings changes. */
function onSettings(fn) {
  settingsListeners.push(fn);
  return function () {
    var at = settingsListeners.indexOf(fn);
    if (at !== -1) settingsListeners.splice(at, 1);
  };
}

/** Push a patch to the host, coalescing bursts into one request. */
var pushSettings = debounce(function (patch) {
  api("/state", { method: "POST", body: patch }).catch(function (error) {
    console.warn(PLUGIN_ID + ": could not persist settings", error);
  });
}, 400);

/**
 * Merge a patch into the live document, mirror it locally, and schedule the
 * host write.
 * @param {object} patch - the partial document.
 * @param {{local?: boolean}} [options] - `local: true` skips the host write.
 * @returns {void}
 */
function applySettings(patch, options) {
  settings = mergeDeep(settings, patch);
  writeLocal(settings);
  emitSettings();
  if (!options || options.local !== true) pushSettings(patch);
}

/* ------------------------------------------------------------------ *
 * Feedback
 * ------------------------------------------------------------------ */

/** Show a short-lived message near the panel. */
function toast(message, tone) {
  var host = document.getElementById(PLUGIN_ID + "-toasts");
  if (host === null) return;
  var node = el("div", { class: "cy-toast", dataset: { tone: tone || "info" }, text: message });
  host.appendChild(node);
  setTimeout(function () {
    node.dataset.leaving = "true";
    setTimeout(function () {
      if (node.parentNode) node.parentNode.removeChild(node);
    }, 320);
  }, 2600);
}

/** Copy to the clipboard, falling back to a hidden textarea. */
function copyText(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    return navigator.clipboard.writeText(text).catch(function () {
      return legacyCopy(text);
    });
  }
  return Promise.resolve(legacyCopy(text));
}

/** Clipboard fallback for a non-secure context. */
function legacyCopy(text) {
  try {
    var area = el("textarea", { style: { position: "fixed", opacity: "0", top: "-1000px" } });
    area.value = text;
    document.body.appendChild(area);
    area.select();
    document.execCommand("copy");
    document.body.removeChild(area);
  } catch (error) {
    /* nothing more to try */
  }
}
