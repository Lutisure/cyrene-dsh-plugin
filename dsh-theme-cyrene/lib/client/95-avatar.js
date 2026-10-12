/**
 * The avatar.
 *
 * The theme has exactly one avatar surface: the collapsed dock dot. Her portrait
 * is the recognisable thing at 42 px, and it keeps her present when the bar is
 * folded away — but it was fixed to whatever the build found in `brand/`.
 *
 * ## Why the custom image is stored as a data URL
 *
 * The host's upload route has buckets for wallpapers, music, covers, emotes and
 * boot sequences — no avatars. Adding one would change the host half of the
 * plugin for a 40-pixel circle. A data URL instead travels inside the settings
 * document, so an exported theme carries its own face rather than a link into
 * somebody else's asset folder. The cost is document size, which is why the
 * image is downscaled before it is stored.
 *
 * ## Safety
 *
 * The stored value only ever reaches an `<img src>`, never a stylesheet, so it
 * cannot become CSS. The image is decoded through `URL.createObjectURL` and drawn
 * to a canvas; a file that is not a decodable image makes the load fail, which is
 * handled by leaving the current avatar alone. `canvas.toDataURL` is wrapped
 * because a canvas will throw rather than taint when the source is unusable.
 */

/**
 * Read an image file and re-encode it small enough to keep in settings.
 *
 * @param {File} file - the chosen image.
 * @returns {Promise<{ok: boolean, url?: string, reason?: string}>} the result.
 */
function readAvatarFile(file) {
  return new Promise(function (resolve) {
    var url;
    try {
      url = URL.createObjectURL(file);
    } catch (error) {
      resolve({ ok: false, reason: "读不了这个文件" });
      return;
    }

    var image = new Image();
    image.onload = function () {
      try {
        var scale = Math.min(1, AVATAR_MAX_EDGE / Math.max(image.width || 1, image.height || 1));
        var canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round((image.width || 1) * scale));
        canvas.height = Math.max(1, Math.round((image.height || 1) * scale));
        var context = canvas.getContext("2d");
        if (context === null || context === undefined) {
          resolve({ ok: false, reason: "这台机器上没有可用的画布" });
          return;
        }
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
        var data = canvas.toDataURL("image/webp", AVATAR_QUALITY);
        // Some engines return a PNG data URL when asked for webp; either way the
        // value is a data URL, and anything else means the encode failed.
        if (typeof data !== "string" || data.slice(0, 5) !== "data:") {
          resolve({ ok: false, reason: "这个格式转不出来" });
          return;
        }
        resolve({ ok: true, url: data });
      } catch (error) {
        resolve({ ok: false, reason: "这个图片读不成像素" });
      } finally {
        URL.revokeObjectURL(url);
      }
    };
    image.onerror = function () {
      URL.revokeObjectURL(url);
      resolve({ ok: false, reason: "这个文件不是能识别的图片" });
    };
    image.src = url;
  });
}

/**
 * Resolve the avatar URL the current settings ask for.
 *
 * @param {object} settings - the settings document.
 * @returns {string} a URL, or `""` for "no portrait, show the plain circle".
 */
function avatarURL(settings) {
  var source = String(settings.avatarSource === undefined ? "builtin" : settings.avatarSource);
  if (source === "custom") {
    var custom = settings.avatarCustom;
    if (typeof custom === "string" && custom.slice(0, 11) === "data:image/") return custom;
    // Falls through to the portrait rather than to nothing: a half-set custom
    // avatar should not cost you the face you already had.
  }
  if (source === "none") return "";
  return typeof AVATAR === "string" ? AVATAR : "";
}

/**
 * Create the avatar controller.
 *
 * @param {HTMLElement} dot - the collapsed dock button.
 * @returns {{apply: (settings: object) => void}} the controller.
 */
function createAvatar(dot) {
  var shown = null;

  /** Swap the portrait, or fall back to the plain circle. */
  var render = function (url) {
    if (url === shown) return;
    shown = url;

    while (dot.firstChild) dot.removeChild(dot.firstChild);
    if (url === "") {
      dot.className = "cy-dot";
      dot.appendChild(document.createTextNode("\u25CF"));
      return;
    }

    dot.className = "cy-dot cy-dot-avatar";
    var image = el("img", { class: "cy-avatar", alt: "昔涟", draggable: "false" });
    // A portrait that fails to load must not leave an empty button behind.
    image.addEventListener("error", function () {
      shown = "";
      dot.className = "cy-dot";
      while (dot.firstChild) dot.removeChild(dot.firstChild);
      dot.appendChild(document.createTextNode("\u25CF"));
    });
    dot.appendChild(image);
    // Set after the element is in place: assigning `src` through `el()` starts
    // the load before the error handler exists.
    image.src = url;
  };

  return {
    /**
     * Re-read the avatar from a settings document.
     * @param {object} next - the settings document.
     */
    apply: function (next) {
      render(avatarURL(isPlainObject(next) ? next : {}));
    }
  };
}
