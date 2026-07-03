/*
 * void-sfx-pad.js — procedural "void pad" sound engine (v3 build).   → window.VoidSFXPad
 *
 * Отдельный синт-движок от продового js/void-sfx.js (тот — click/thock-звуки).
 * Здесь — тёмные детюненные пады с длинным тёплым ревербом (одобренный референс).
 * СЕЙЧАС используется только для «проверки звука» в настройках (audio.js →
 * testOnDevice → screencastStart, hero «lock-in»). Остальные методы (mic/sound/
 * message/enter/exit) — готовая палитра на будущую миграцию, пока не подключены.
 *
 * No audio assets. Every sound is synthesized at runtime via Web Audio API.
 *
 * This build is rebuilt from a spectral analysis of the reference sounds the
 * user approved (see SOUND-DESIGN-NOTES.md). The signature is:
 *
 *   dark, detuned, slow-swelling tonal pads with a long warm reverb tail.
 *
 *   • dark      — energy under ~500-1300 Hz; heavy lowpass; sine/triangle only
 *   • detuned   — each note = 3-5 voices ±15-25 cents, stereo-spread (the chorus
 *                 shimmer that makes it lush instead of an 8-bit beep)
 *   • swell     — soft attacks (80-360 ms pads, 10-50 ms toggles), never a click
 *   • reverb    — long (~2.5s) warm lowpassed tail; it IS the "void / cosmic" space
 *   • sub       — clean sine 52-117 Hz under the room sounds for body
 *   • tonal     — virtually no noise; no saw/square buzz; no metallic FM
 *
 * Tonal palette (F# minor / A): G#, A, A#, F#, C# — every sound is built from it
 * so the family stays coherent.
 *
 * Master chain:
 *   voices → dry → saturator → masterLP → master → limiter → out
 *   voices → reverb send → convolver(warm IR) → revHP/LP → master   (parallel)
 */
(function (root) {
  'use strict';

  // ---- note helper -------------------------------------------------------
  const NOTE = { 'G#1':51.91,'A1':55.00,'A#1':58.27,'F#2':92.50,'G#2':103.83,
    'A2':110.00,'A#2':116.54,'B2':123.47,'D#3':155.56,'F3':174.61,'F#3':185.00,
    'A3':220.00,'C#4':277.18,'E4':329.63,'F#4':369.99,'A4':440.00,'C#5':554.37,
    'F5':698.46,'F#5':739.99,'G#5':830.61,'A5':880.00 };
  const f = (n) => (typeof n === 'number' ? n : NOTE[n]);

  // ---- buffer / curve factories ------------------------------------------
  function makeNoise(ctx, seconds) {
    const len = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    return buf;
  }

  // stereo, exponential-decay, *lowpassed* (warm) impulse response
  function makeImpulse(ctx, duration, decay) {
    const rate = ctx.sampleRate;
    const len = Math.max(1, Math.floor(rate * duration));
    const buf = ctx.createBuffer(2, len, rate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      let lp = 0;                       // one-pole lowpass → dark, warm tail
      const a = 0.18;                   // lower = darker reverb
      for (let i = 0; i < len; i++) {
        const white = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
        lp = lp + a * (white - lp);
        d[i] = lp * 3.2;
      }
    }
    return buf;
  }

  function makeSatCurve(drive) {
    const n = 2048, c = new Float32Array(n);
    for (let i = 0; i < n; i++) { const x = (i * 2) / n - 1; c[i] = Math.tanh(drive * x); }
    return c;
  }

  class VoidSFX {
    constructor({ volume = 0.6, sinkId = '' } = {}) { this.ctx = null; this._volume = volume; this._sinkId = sinkId; }

    // ---- engine ----------------------------------------------------------
    _ensure() {
      if (!this.ctx) {
        const AC = root.AudioContext || root.webkitAudioContext;
        const ctx = (this.ctx = new AC());

        this.master = ctx.createGain();
        this.master.gain.value = this._volume;

        this.limiter = ctx.createDynamicsCompressor();
        this.limiter.threshold.value = -5; this.limiter.knee.value = 8;
        this.limiter.ratio.value = 14; this.limiter.attack.value = 0.003;
        this.limiter.release.value = 0.18;
        this.master.connect(this.limiter).connect(ctx.destination);

        // master lowpass: keeps the whole family dark, kills any digital edge
        // and tames intermodulation from the saturator on multi-note chords
        this.masterLP = ctx.createBiquadFilter();
        this.masterLP.type = 'lowpass'; this.masterLP.frequency.value = 2600;
        this.masterLP.Q.value = 0.5;
        this.masterLP.connect(this.master);

        // very gentle saturation — just glue/limiting safety, no real drive
        // (heavier drive intermodulates the dyads up into 1-2k = brightness)
        this.sat = ctx.createWaveShaper();
        this.sat.curve = makeSatCurve(1.0); this.sat.oversample = '4x';
        this.sat.connect(this.masterLP);

        this.dry = ctx.createGain();
        this.dry.connect(this.sat);

        // long warm convolution reverb — the "void" space
        this.convolver = ctx.createConvolver();
        this.convolver.buffer = makeImpulse(ctx, 2.6, 2.2);
        const revHP = ctx.createBiquadFilter();
        revHP.type = 'highpass'; revHP.frequency.value = 90;   // keep sub tight
        const revLP = ctx.createBiquadFilter();
        revLP.type = 'lowpass'; revLP.frequency.value = 2200;  // warm tail
        this.revGain = ctx.createGain(); this.revGain.gain.value = 0.9;
        this.convolver.connect(revHP).connect(revLP).connect(this.revGain).connect(this.master);

        this._noise = makeNoise(ctx, 0.3);

        // роут в выбранное устройство вывода, если задано (Chrome 110+/WebView2)
        if (this._sinkId && typeof ctx.setSinkId === 'function') {
          ctx.setSinkId(this._sinkId).catch(() => {});
        }
      }
      if (this.ctx.state === 'suspended') this.ctx.resume();
      return this.ctx;
    }

    set volume(v) { this._volume = v; if (this.master) this.master.gain.value = v; }
    get volume() { return this._volume; }

    // роутинг в конкретный output-девайс (как setSinkId у <audio>)
    setSink(id) {
      this._sinkId = id || '';
      if (this.ctx && typeof this.ctx.setSinkId === 'function') {
        this.ctx.setSinkId(this._sinkId).catch(() => {});
      }
    }

    // закрыть AudioContext (одноразовый тест-инстанс / освобождение устройства)
    close() {
      if (this.ctx) { this.ctx.close().catch(() => {}); this.ctx = null; }
    }

    _route(node, reverb) {
      node.connect(this.dry);
      if (reverb > 0) {
        const s = this.ctx.createGain(); s.gain.value = reverb;
        node.connect(s); s.connect(this.convolver);
      }
    }

    // ---- voices ----------------------------------------------------------

    // a chord of detuned, stereo-spread voices through a lowpass with an
    // ADSR (linear swell → exponential tail). The workhorse.
    _pad({ t0, notes, type = 'triangle', voices = 4, detune = 20, dur = 1.0,
           attack = 0.15, peak = 0.5, lp0 = 800, lp1, q = 0.6, spread = 0.5,
           reverb = 0.4, glide = 1.0, stagger = 0 }) {
      if (lp1 === undefined) lp1 = lp0;
      const ctx = this.ctx;
      notes.map(f).forEach((freq, ni) => {
        const tt = t0 + ni * stagger;

        const lpf = ctx.createBiquadFilter();
        lpf.type = 'lowpass'; lpf.Q.value = q;
        lpf.frequency.setValueAtTime(lp0, tt);
        lpf.frequency.exponentialRampToValueAtTime(Math.max(60, lp1), tt + dur);

        const g = ctx.createGain();
        const lvl = peak / voices;   // normalize the summed detuned voices
        g.gain.setValueAtTime(0.0001, tt);
        g.gain.linearRampToValueAtTime(lvl, tt + attack);           // swell
        g.gain.exponentialRampToValueAtTime(0.0001, tt + dur);      // long tail
        lpf.connect(g);

        for (let i = 0; i < voices; i++) {
          const o = ctx.createOscillator(); o.type = type;
          const norm = voices > 1 ? (i - (voices - 1) / 2) / ((voices - 1) / 2) : 0;
          o.detune.value = norm * detune;
          const gledTo = tt + Math.max(attack, 0.06);
          o.frequency.setValueAtTime(freq * glide, tt);
          o.frequency.exponentialRampToValueAtTime(freq, gledTo);
          let node = o;
          if (ctx.createStereoPanner && spread) {
            const p = ctx.createStereoPanner(); p.pan.value = norm * spread;
            o.connect(p); node = p;
          }
          node.connect(lpf);
          o.start(tt); o.stop(tt + dur + 0.05);
        }
        this._route(g, reverb);
      });
    }

    // clean sine sub-bass with a gentle swell
    _sub({ t0, f0, f1, dur, attack = 0.05, peak = 0.6, reverb = 0.15 }) {
      f0 = f(f0); f1 = f1 === undefined ? f0 : f(f1);
      const ctx = this.ctx;
      const o = ctx.createOscillator(); o.type = 'sine';
      o.frequency.setValueAtTime(f0, t0);
      o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t0 + dur);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.linearRampToValueAtTime(peak, t0 + attack);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      o.connect(g); this._route(g, reverb);
      o.start(t0); o.stop(t0 + dur + 0.05);
    }

    // ---- events ----------------------------------------------------------

    // deep, slow arrival — sub + low detuned chord, wide, rising a touch
    enterRoom() {
      const t = this._ensure().currentTime;
      this._sub ({ t0: t, f0: 'G#1', dur: 1.0, attack: 0.18, peak: 0.55, reverb: 0.3 });
      this._pad ({ t0: t, notes: ['G#2', 'D#3'], voices: 4,
                   detune: 18, dur: 1.1, attack: 0.32, peak: 0.30, lp0: 560, lp1: 820,
                   q: 0.7, spread: 0.7, reverb: 0.5, glide: 0.965 });
    }

    // sinking, closing — sub + low chord, faster, falling, filter closes
    exitRoom() {
      const t = this._ensure().currentTime;
      this._sub ({ t0: t, f0: 'G#1', dur: 0.95, attack: 0.06, peak: 0.55, reverb: 0.3 });
      this._pad ({ t0: t, notes: ['A#2', 'F3'], voices: 4, detune: 18, dur: 1.0,
                   attack: 0.15, peak: 0.32, lp0: 700, lp1: 430, q: 0.7,
                   spread: 0.45, reverb: 0.5, glide: 1.05 });
    }

    // hero · the screencast "lock in" — F#4+A4 detuned dyad, long tail, sub body
    screencastStart() {
      const t = this._ensure().currentTime;
      this._sub ({ t0: t, f0: 'A2', dur: 1.2, attack: 0.10, peak: 0.34, reverb: 0.25 });
      this._pad ({ t0: t, notes: ['F#4', 'A4'], voices: 5, detune: 22, dur: 1.8,
                   attack: 0.12, peak: 0.36, lp0: 720, lp1: 820, q: 0.8,
                   spread: 0.55, reverb: 0.6, glide: 0.97, stagger: 0.06 });
    }

    // release · resolve downward A4 → F#4, filter closes
    screencastStop() {
      const t = this._ensure().currentTime;
      this._sub ({ t0: t, f0: 'A2', f1: 'F#2', dur: 1.0, attack: 0.05, peak: 0.30, reverb: 0.25 });
      this._pad ({ t0: t, notes: ['A4', 'F#4'], voices: 5, detune: 20, dur: 1.2,
                   attack: 0.10, peak: 0.32, lp0: 820, lp1: 520, q: 0.8,
                   spread: 0.5, reverb: 0.5, glide: 1.03, stagger: 0.05 });
    }

    // soft tactile, open · A3+E4 fifth, quick swell (not a click)
    micOn() {
      const t = this._ensure().currentTime;
      this._pad({ t0: t, notes: ['A3', 'E4'], voices: 3, detune: 14, dur: 0.24,
                  attack: 0.014, peak: 0.34, lp0: 950, lp1: 700, q: 0.9,
                  spread: 0.35, reverb: 0.16 });
    }

    // soft, down · F3+A3 minor third, darker
    micOff() {
      const t = this._ensure().currentTime;
      this._pad({ t0: t, notes: ['F3', 'A3'], voices: 3, detune: 14, dur: 0.26,
                  attack: 0.014, peak: 0.34, lp0: 620, lp1: 430, q: 0.9,
                  spread: 0.3, reverb: 0.16 });
    }

    // unmuffle · filter opens, gentle rise
    soundOn() {
      const t = this._ensure().currentTime;
      this._pad({ t0: t, notes: ['A3', 'C#4'], voices: 3, detune: 14, dur: 0.27,
                  attack: 0.05, peak: 0.30, lp0: 420, lp1: 1200, q: 1.0,
                  spread: 0.3, reverb: 0.18, glide: 0.98 });
    }

    // muffle · filter closes, gentle fall
    soundOff() {
      const t = this._ensure().currentTime;
      this._pad({ t0: t, notes: ['C#4', 'A3'], voices: 3, detune: 14, dur: 0.27,
                  attack: 0.04, peak: 0.30, lp0: 1200, lp1: 400, q: 1.0,
                  spread: 0.3, reverb: 0.18, glide: 1.02 });
    }

    // quiet ping · F#5+A5 detuned pluck, short
    message() {
      const t = this._ensure().currentTime;
      this._pad({ t0: t, notes: ['F#5', 'A5'], voices: 3, detune: 16, dur: 0.30,
                  attack: 0.035, peak: 0.24, lp0: 1400, lp1: 1000, q: 0.8,
                  spread: 0.25, reverb: 0.3 });
    }
  }

  root.VoidSFXPad = VoidSFX;
})(typeof window !== 'undefined' ? window : this);
