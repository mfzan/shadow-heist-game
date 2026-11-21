// Shadow Heist — tiny sound engine.
//
// Everything is synthesized with the Web Audio API, so the game ships
// no sound files at all. The audio context is created on the first
// user gesture (the Start button), which is what browsers require.

window.SH_SOUND = (function () {
  var ctx = null;
  var enabled = true;
  var master = null;

  function ensure() {
    if (!ctx) {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return false;
      ctx = new AC();
      master = ctx.createGain();
      master.gain.value = 0.5;
      master.connect(ctx.destination);
    }
    if (ctx.state === 'suspended') ctx.resume();
    return true;
  }

  // One short oscillator blip. `when` is an offset in seconds from now.
  function blip(freq, dur, type, vol, when, slideTo) {
    if (!enabled || !ensure()) return;
    var t0 = ctx.currentTime + (when || 0);
    var osc = ctx.createOscillator();
    var gain = ctx.createGain();
    osc.type = type || 'sine';
    osc.frequency.setValueAtTime(freq, t0);
    if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, t0 + dur);
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(vol || 0.2, t0 + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(gain);
    gain.connect(master);
    osc.start(t0);
    osc.stop(t0 + dur + 0.05);
  }

  // A soft filtered-noise tick, used for footsteps.
  function tick(vol, low) {
    if (!enabled || !ensure()) return;
    var t0 = ctx.currentTime;
    var len = Math.floor(ctx.sampleRate * 0.05);
    var buf = ctx.createBuffer(1, len, ctx.sampleRate);
    var data = buf.getChannelData(0);
    for (var i = 0; i < len; i++) {
      data[i] = (Math.random() * 2 - 1) * (1 - i / len);
    }
    var src = ctx.createBufferSource();
    src.buffer = buf;
    var filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = low || 900;
    var gain = ctx.createGain();
    gain.gain.value = vol || 0.12;
    src.connect(filter);
    filter.connect(gain);
    gain.connect(master);
    src.start(t0);
  }

  return {
    unlock: ensure,
    toggle: function () {
      enabled = !enabled;
      return enabled;
    },
    isOn: function () { return enabled; },

    click: function () { blip(660, 0.07, 'triangle', 0.15); },
    pickup: function () {
      blip(880, 0.09, 'sine', 0.22);
      blip(1318, 0.14, 'sine', 0.2, 0.07);
    },
    unlockDoor: function () {
      blip(523, 0.1, 'triangle', 0.2);
      blip(784, 0.16, 'triangle', 0.2, 0.09);
    },
    suspicious: function () { blip(440, 0.16, 'square', 0.08, 0, 520); },
    alarm: function () {
      blip(620, 0.14, 'sawtooth', 0.12, 0, 780);
      blip(780, 0.14, 'sawtooth', 0.12, 0.15, 620);
      blip(620, 0.2, 'sawtooth', 0.12, 0.3, 780);
    },
    caught: function () {
      blip(220, 0.5, 'sawtooth', 0.16, 0, 110);
      blip(110, 0.7, 'square', 0.1, 0.1, 55);
    },
    levelClear: function () {
      blip(523, 0.12, 'triangle', 0.2);
      blip(659, 0.12, 'triangle', 0.2, 0.1);
      blip(784, 0.2, 'triangle', 0.22, 0.2);
    },
    win: function () {
      var notes = [523, 659, 784, 1046, 784, 1046];
      for (var i = 0; i < notes.length; i++) {
        blip(notes[i], 0.18, 'triangle', 0.2, i * 0.11);
      }
    },
    step: function (sneaking) {
      tick(sneaking ? 0.05 : 0.11, sneaking ? 600 : 1000);
    },
    guardStep: function (distance) {
      // Louder when the guard is close: footsteps tell you where he is.
      var v = Math.max(0, 0.16 * (1 - distance / 340));
      if (v > 0.02) tick(v, 500);
    },
  };
})();
