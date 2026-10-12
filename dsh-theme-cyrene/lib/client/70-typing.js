/**
 * Typing sound: a synthesised click with a low thump, produced by Web Audio.
 *
 * No audio files are involved, so there is nothing to download and no licence
 * to worry about. The composer's input element is found by behaviour
 * (a focused editable target) rather than by a DSH-specific selector, so a DOM
 * reshuffle does not silently break it.
 */

/**
 * Create the typing-sound player.
 * @returns {{setEnabled: (on: boolean) => void, play: (kind: string) => void, dispose: () => void}} the player.
 */
function createTypingSound() {
  var audioContext = null;
  var enabled = false;
  var lastPlayed = 0;

  /** Lazily create the context: browsers require a user gesture first. */
  var contextOf = function () {
    if (audioContext !== null) return audioContext;
    var Ctor = window.AudioContext || window.webkitAudioContext;
    if (Ctor === undefined) return null;
    try {
      audioContext = new Ctor();
    } catch (error) {
      return null;
    }
    return audioContext;
  };

  /**
   * One short voice: a filtered noise burst plus a sine thump.
   * @param {number} pitch - base frequency in Hz.
   * @param {number} gain - peak gain.
   * @param {number} duration - seconds.
   */
  var voice = function (pitch, gain, duration) {
    var context = contextOf();
    if (context === null) return;
    if (context.state === "suspended" && typeof context.resume === "function") {
      context.resume().catch(function () {});
    }

    var now = context.currentTime;
    var envelope = context.createGain();
    envelope.gain.setValueAtTime(0, now);
    envelope.gain.linearRampToValueAtTime(gain, now + 0.004);
    envelope.gain.exponentialRampToValueAtTime(0.0001, now + duration);
    envelope.connect(context.destination);

    var tone = context.createOscillator();
    tone.type = "sine";
    tone.frequency.setValueAtTime(pitch, now);
    tone.frequency.exponentialRampToValueAtTime(pitch * 0.55, now + duration);
    tone.connect(envelope);
    tone.start(now);
    tone.stop(now + duration + 0.02);

    // A short noise burst gives the click its "key" character.
    var frames = Math.max(1, Math.floor(context.sampleRate * duration * 0.5));
    var buffer = context.createBuffer(1, frames, context.sampleRate);
    var channel = buffer.getChannelData(0);
    for (var index = 0; index < frames; index += 1) {
      channel[index] = (Math.random() * 2 - 1) * (1 - index / frames);
    }
    var noise = context.createBufferSource();
    noise.buffer = buffer;
    var noiseGain = context.createGain();
    noiseGain.gain.setValueAtTime(gain * 0.42, now);
    noiseGain.gain.exponentialRampToValueAtTime(0.0001, now + duration * 0.6);
    var filter = context.createBiquadFilter();
    filter.type = "bandpass";
    filter.frequency.value = pitch * 4.2;
    filter.Q.value = 0.9;
    noise.connect(filter);
    filter.connect(noiseGain);
    noiseGain.connect(context.destination);
    noise.start(now);
    noise.stop(now + duration);
  };

  /**
   * Play the click for a key, throttled so fast typing does not stack voices.
   *
   * The character voice used to sit at gain 0.032 over 35 ms, which is
   * effectively inaudible on laptop speakers — the other half of why typing
   * read as silent.
   *
   * @param {string} kind - `char` | `space` | `enter` | `back`.
   */
  var play = function (kind) {
    if (!enabled) return;
    var now = performance.now();
    if (now - lastPlayed < 16) return;
    lastPlayed = now;
    // Lower notes for the keys that do something structural; the plain
    // character click sits highest and is the one heard most often.
    if (kind === "space") voice(320, 0.075, 0.055);
    else if (kind === "enter") voice(240, 0.090, 0.080);
    else if (kind === "back") voice(430, 0.055, 0.040);
    else voice(560, 0.075, 0.045);
  };

  /**
   * Whether an event target is somewhere the user types prose.
   *
   * The ancestor check matters: a composer built from a plain `<div>` reports
   * `isContentEditable` only on the element that carries the attribute, not on
   * the child the key event actually targets.
   */
  var isEditable = function (node) {
    if (node === null || node === undefined || node.nodeType !== 1) return false;
    if (node.isContentEditable === true) return true;
    var tag = node.tagName;
    if (tag === "TEXTAREA") return true;
    if (tag === "INPUT") {
      var type = (node.getAttribute("type") || "text").toLowerCase();
      if (type === "text" || type === "search" || type === "url" || type === "email" || type === "password") return true;
    }
    if (typeof node.closest === "function") {
      return node.closest('[contenteditable="true"], [contenteditable=""], [role="textbox"]') !== null;
    }
    return false;
  };

  /**
   * Keydown listener: capture phase so it sees the key before any handler that
   * might stop propagation.
   *
   * `isComposing` is deliberately **not** a reason to stay silent. With an IME
   * every character the user types arrives as a composing keydown (or as
   * `key: "Process"`), so filtering those out silences typing completely while
   * leaving Backspace — which the browser reports outside composition —
   * audible. That asymmetry is the bug this listener used to have.
   *
   * @param {KeyboardEvent} event - the key event.
   */
  var onKeyDown = function (event) {
    if (!enabled) return;
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    var target = event.target;
    if (!isEditable(target)) return;
    // Never click over the plugin's own controls.
    if (typeof target.closest === "function" && target.closest(".cy-input") !== null) return;

    var key = event.key;
    if (key === "Backspace" || key === "Delete") {
      play("back");
      return;
    }
    if (key === "Enter" || key === "NumpadEnter") {
      play("enter");
      return;
    }
    if (key === " " || key === "Spacebar") {
      play("space");
      return;
    }
    // Chromium reports an IME keystroke that produces no character this way.
    if (key === "Process" || key === "Unidentified" || key === undefined) {
      play("char");
      return;
    }
    if (typeof key === "string" && key.length === 1) play("char");
  };

  document.addEventListener("keydown", onKeyDown, true);

  return {
    setEnabled: function (on) {
      enabled = on === true;
      if (enabled) {
        // Warm the context inside the click that enabled it.
        var context = contextOf();
        if (context !== null && context.state === "suspended" && typeof context.resume === "function") {
          context.resume().catch(function () {});
        }
      }
    },
    play: play,
    dispose: function () {
      document.removeEventListener("keydown", onKeyDown, true);
      if (audioContext !== null && typeof audioContext.close === "function") {
        try {
          audioContext.close();
        } catch (error) {
          /* already closed */
        }
        audioContext = null;
      }
    }
  };
}
