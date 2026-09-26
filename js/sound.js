'use strict';

// 効果音（Web Audio、音声ファイルなし）。RULES.md §5「音」どおり、マナーモードでも鳴らす。

let ac = null;
let on = true;

export function setSoundOn(v) { on = v; setAudioSession(on); }

// iPhone のマナーモードでも鳴らす（Safari 16.4 以降）。
function setAudioSession(soundOn) {
  try { if (navigator.audioSession) navigator.audioSession.type = soundOn ? 'playback' : 'auto'; } catch { /* 対応していない */ }
}

function ctx() {
  if (!ac) ac = new (window.AudioContext || window.webkitAudioContext)();
  if (ac.state === 'suspended') ac.resume();
  return ac;
}

function blip(freq, dur, type = 'sine', vol = 0.05, delay = 0) {
  if (!on) return;
  try {
    setAudioSession(true);
    const a = ctx();
    const t0 = a.currentTime + delay;
    const osc = a.createOscillator();
    const g = a.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    g.gain.setValueAtTime(vol, t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g).connect(a.destination);
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
  } catch { /* 音を出せない環境は無視 */ }
}

export const sfx = {
  key: (letter) => blip(letter ? 720 : 540, 0.03, 'square', 0.02),
  serialReady: () => blip(880, 0.08, 'sine', 0.04),
  camHit: () => { blip(1200, 0.05, 'sine', 0.05); blip(1500, 0.06, 'sine', 0.05, 0.07); },
  camMiss: () => blip(220, 0.12, 'square', 0.04),
  choice: () => blip(600, 0.03, 'square', 0.02),
  firstRegister: () => { blip(660, 0.1, 'sine', 0.05); blip(880, 0.16, 'sine', 0.05, 0.1); },
  rediscoverRise: () => blip(500, 0.7, 'sine', 0.03),
  rediscoverArrive: () => blip(1046, 0.18, 'sine', 0.06),
  rare: () => [0, 90, 180].forEach((d, i) => blip(880 + i * 220, 0.12, 'sine', 0.05, d / 1000)),
  dexComplete: () => blip(1568, 0.22, 'sine', 0.06, 0.32),
  relayReceived: () => { blip(700, 0.08, 'sine', 0.05); blip(980, 0.1, 'sine', 0.05, 0.09); },
  error: () => blip(180, 0.15, 'square', 0.045),
};
