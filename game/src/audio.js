// Shadow Heist — sound. Everything is synthesized with WebAudio, so the
// game ships no audio files and makes no network request. Footsteps get
// louder as a guard gets closer, so you can hear danger coming.

let actx = null;
let muted = false;

function ac() {
  if (!actx) actx = new (window.AudioContext || window.webkitAudioContext)();
  if (actx.state === 'suspended') actx.resume();
  return actx;
}

function tone(freq, start, dur, type, vol) {
  if (muted) return;
  try {
    const ctx = ac();
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = type || 'sine';
    o.frequency.value = freq;
    g.gain.setValueAtTime(vol || 0.1, ctx.currentTime + start);
    g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + start + dur);
    o.connect(g);
    g.connect(ctx.destination);
    o.start(ctx.currentTime + start);
    o.stop(ctx.currentTime + start + dur);
  } catch (e) { /* audio unavailable: play silent */ }
}

export const sfx = {
  // a guard's footstep; vol scales with closeness (0..1)
  step(vol) {
    if (vol <= 0.02) return;
    tone(90 + Math.random() * 20, 0, 0.08, 'triangle', Math.min(0.14, vol * 0.16));
  },
  // your own soft step while sneaking
  sneakStep() { tone(140, 0, 0.05, 'triangle', 0.03); },
  pickup() { tone(880, 0, 0.09, 'sine', 0.12); tone(1318, 0.07, 0.14, 'sine', 0.12); },
  // suspicion rising: a low warning pulse
  suspicious() { tone(220, 0, 0.16, 'sawtooth', 0.07); },
  // spotted: sharp alarm
  spotted() { tone(660, 0, 0.12, 'square', 0.09); tone(880, 0.1, 0.16, 'square', 0.09); },
  caught() { [392, 311, 233].forEach((f, i) => tone(f, i * 0.14, 0.2, 'triangle', 0.12)); },
  exit() { [523, 659, 784, 1046].forEach((f, i) => tone(f, i * 0.09, 0.16, 'sine', 0.12)); },
  win() { [523, 659, 784, 1046, 1318, 1568].forEach((f, i) => tone(f, i * 0.11, 0.2, 'sine', 0.12)); },
  click() { tone(660, 0, 0.06, 'triangle', 0.05); },
};

export function setMuted(m) { muted = m; }
export function isMuted() { return muted; }
