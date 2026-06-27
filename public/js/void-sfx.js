/* ========= VOID SFX — procedural UI sound synthesis =========
 *
 * Все событийные звуки интерфейса синтезируются в рантайме через Web Audio API —
 * никаких mp3-ассетов (вес ~0, чистый тон на любой громкости). Дизайн — глубокие
 * тактильные "thock"-клики (CGI/premium), тёмный низ, без шума/сатурации.
 *
 * Маршрутизация (выставляется снаружи, audio.js):
 *   enterRoom(true)/exitRoom(true)  — self (вариант 3: быстрый ран из 4 нот)
 *   enterRoom(false)/exitRoom(false)— другой участник (вариант 0: 3 ноты)
 *   micOn/Off, soundOn/Off          — только self
 *   screencastStart/Stop, message   — по событию
 *
 * Контекст создаётся лениво на первом звуке (autoplay policy: первый звук —
 * self-join по клику «войти» = валидный user-gesture). setSink() роутит в
 * выбранное устройство вывода; volume трекает мастер-громкость приложения.
 */
(function (root) {
  'use strict';

  const NOTE = {
    'A1': 55.00, 'C2': 65.41, 'D2': 73.42, 'E2': 82.41, 'G2': 98.00, 'A2': 110.00,
    'C3': 130.81, 'D3': 146.83, 'E3': 164.81, 'G3': 196.00, 'A3': 220.00,
    'C4': 261.63, 'D4': 293.66, 'E4': 329.63, 'G4': 392.00, 'A4': 440.00 };
  const f = (n) => (typeof n === 'number' ? n : NOTE[n]);

  // короткий тёплый импульс для крошечной комнаты (не зал)
  function makeImpulse(ctx, dur, decay) {
    const rate = ctx.sampleRate, len = Math.max(1, Math.floor(rate * dur));
    const buf = ctx.createBuffer(2, len, rate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch); let lp = 0;
      for (let i = 0; i < len; i++) {
        const w = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
        lp += 0.22 * (w - lp); d[i] = lp * 3.0;
      }
    }
    return buf;
  }

  class VoidSFX {
    constructor({ volume = 0.55, sinkId = '' } = {}) {
      this.ctx = null; this._volume = volume; this._sinkId = sinkId;
    }

    _ensure() {
      if (!this.ctx) {
        const AC = root.AudioContext || root.webkitAudioContext;
        const ctx = (this.ctx = new AC());

        this.master = ctx.createGain(); this.master.gain.value = this._volume;
        this.limiter = ctx.createDynamicsCompressor();
        this.limiter.threshold.value = -3; this.limiter.knee.value = 6;
        this.limiter.ratio.value = 8; this.limiter.attack.value = 0.003;
        this.limiter.release.value = 0.1;
        this.master.connect(this.limiter).connect(ctx.destination);

        // мастер-LP демпфирует верх (thock, не "ping"). Сатурации НЕТ: tanh
        // интермодулировал стэки нот/сабов в низ-серед "грязь" → чистый тон.
        this.masterLP = ctx.createBiquadFilter();
        this.masterLP.type = 'lowpass'; this.masterLP.frequency.value = 3400;
        this.masterLP.Q.value = 0.5; this.masterLP.connect(this.master);

        this.dry = ctx.createGain(); this.dry.connect(this.masterLP);

        // крошечная короткая комната
        this.convolver = ctx.createConvolver();
        this.convolver.buffer = makeImpulse(ctx, 0.5, 2.6);
        const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 130;
        const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 2600;
        this.revGain = ctx.createGain(); this.revGain.gain.value = 0.7;
        this.convolver.connect(hp).connect(lp).connect(this.revGain).connect(this.master);

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

    // роутинг звуков в конкретный output-девайс (как setSinkId у <audio>)
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

    _pan(node, pan) {
      const ctx = this.ctx;
      if (ctx.createStereoPanner && pan) {
        const p = ctx.createStereoPanner(); p.pan.value = pan; node.connect(p); return p;
      }
      return node;
    }

    // ---- voices ----------------------------------------------------------

    // DEEP TACTILE THOCK: чистый тональный тик + резонансное низ-серед тело + саб
    _click({ t0, note, peak = 0.5, dur = 0.14, reverb = 0.08, pan = 0,
             bright = 2100, sub = 0.45, snap = 0.32, subDur = 0.075 }) {
      const ctx = this.ctx; const freq = f(note);
      const lpf = ctx.createBiquadFilter();
      lpf.type = 'lowpass'; lpf.frequency.value = bright; lpf.Q.value = 0.8;
      this._route(this._pan(lpf, pan), reverb);

      // тело — фундамент + мягкая 2-я гармоника, быстрая атака, контролируемый спад
      for (const [m, g, df] of [[1, 1.0, 1.0], [2, 0.22, 0.5]]) {
        const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.value = freq * m;
        const ge = ctx.createGain();
        const pd = Math.max(0.05, dur * df);
        ge.gain.setValueAtTime(0.0001, t0);
        ge.gain.linearRampToValueAtTime(peak * g, t0 + 0.003);
        ge.gain.exponentialRampToValueAtTime(0.0001, t0 + pd);
        o.connect(ge).connect(lpf); o.start(t0); o.stop(t0 + pd + 0.03);
      }
      // саб-удар (октава ниже) — вес/заземление
      if (sub > 0) {
        const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.value = freq * 0.5;
        const ge = ctx.createGain();
        ge.gain.setValueAtTime(0.0001, t0);
        ge.gain.linearRampToValueAtTime(peak * sub, t0 + 0.004);
        ge.gain.exponentialRampToValueAtTime(0.0001, t0 + subDur);
        o.connect(ge).connect(this.dry); o.start(t0); o.stop(t0 + subDur + 0.04);
      }
      // тактильный тик — чистый питч-дроп синуса (без шумового хэша = без "битрейта")
      if (snap > 0) {
        const o = ctx.createOscillator(); o.type = 'sine';
        o.frequency.setValueAtTime(1900, t0);
        o.frequency.exponentialRampToValueAtTime(440, t0 + 0.009);
        const kg = ctx.createGain();
        kg.gain.setValueAtTime(0.0001, t0);
        kg.gain.linearRampToValueAtTime(peak * snap, t0 + 0.0006);
        kg.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.015);
        o.connect(kg).connect(lpf); o.start(t0); o.stop(t0 + 0.04);
      }
    }

    // глубокий саб-синус с питч-свипом (вес/«проваливание» под мотивом)
    _sub({ t0, f0, f1, dur, attack = 0.02, peak = 0.5, reverb = 0.1 }) {
      f0 = f(f0); f1 = f1 === undefined ? f0 : f(f1);
      const ctx = this.ctx;
      const o = ctx.createOscillator(); o.type = 'sine';
      o.frequency.setValueAtTime(f0, t0);
      o.frequency.exponentialRampToValueAtTime(Math.max(18, f1), t0 + dur);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.linearRampToValueAtTime(peak, t0 + attack);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      o.connect(g); this._route(g, reverb);
      o.start(t0); o.stop(t0 + dur + 0.05);
    }

    // мотив из thock-кликов: стаггер по времени + панорама
    _motif({ t0, notes, step = 0.09, spread = 0.18, dur = 0.14, peak = 0.46,
             reverb = 0.08, bright = 2100, accentLast = 1.0 }) {
      notes.forEach((n, i) => {
        const norm = notes.length > 1 ? (i - (notes.length - 1) / 2) / ((notes.length - 1) / 2) : 0;
        const last = i === notes.length - 1;
        this._click({
          t0: t0 + i * step, note: n, pan: norm * spread, bright,
          dur: dur * (last ? accentLast : 1), peak: peak * (last ? accentLast : 1), reverb
        });
      });
    }

    // ---- events ----------------------------------------------------------

    // вход в комнату. self=true → быстрый ран ВВЕРХ (4 ноты); peer → 3 ноты
    enterRoom(self = true) {
      const t = this._ensure().currentTime;
      (self ? this._enterSelf : this._enterPeer).call(this, t);
    }
    // выход. self=true → быстрый ран ВНИЗ (4 ноты); peer → 3 ноты, последняя гудит
    exitRoom(self = true) {
      const t = this._ensure().currentTime;
      (self ? this._exitSelf : this._exitPeer).call(this, t);
    }

    // self — быстрый ран вверх (4 ноты)
    _enterSelf(t) {
      ['E2', 'A2', 'C3', 'E3'].forEach((note, i) => this._click({
        t0: t + i * 0.07, note, peak: 0.42 + i * 0.04, dur: 0.16 + i * 0.02,
        reverb: 0.06, bright: 1900 + i * 90, sub: 0.55, subDur: 0.09, pan: (i - 1.5) * 0.1 }));
    }
    // peer — три клика вверх
    _enterPeer(t) {
      this._click({ t0: t,        note: 'E2', peak: 0.48, dur: 0.20, reverb: 0.06, bright: 1900, sub: 0.70, subDur: 0.12, pan: -0.12 });
      this._click({ t0: t + 0.12, note: 'A2', peak: 0.50, dur: 0.22, reverb: 0.06, bright: 2000, sub: 0.68, subDur: 0.12, pan:  0.04 });
      this._click({ t0: t + 0.25, note: 'C3', peak: 0.56, dur: 0.28, reverb: 0.08, bright: 2100, sub: 0.60, subDur: 0.11, pan:  0.14 });
    }
    // self — быстрый ран вниз (4 ноты)
    _exitSelf(t) {
      ['E3', 'C3', 'A2', 'E2'].forEach((note, i) => this._click({
        t0: t + i * 0.07, note, peak: 0.42 + i * 0.05, dur: 0.16 + i * 0.04,
        reverb: 0.06, bright: 2100 - i * 90, sub: 0.55 + i * 0.07, subDur: 0.10, pan: (1.5 - i) * 0.1 }));
    }
    // peer — три клика вниз, последний гудит низом
    _exitPeer(t) {
      this._click({ t0: t,        note: 'C3', peak: 0.52, dur: 0.20, reverb: 0.06, bright: 2050, sub: 0.62, subDur: 0.11, pan:  0.14 });
      this._click({ t0: t + 0.11, note: 'A2', peak: 0.50, dur: 0.24, reverb: 0.06, bright: 1900, sub: 0.68, subDur: 0.13, pan:  0.04 });
      this._click({ t0: t + 0.24, note: 'E2', peak: 0.58, dur: 0.34, reverb: 0.09, bright: 1750, sub: 0.80, subDur: 0.16, pan: -0.12 });
    }

    micOn() {
      const t = this._ensure().currentTime;
      this._motif({ t0: t, notes: ['E3', 'A3'], step: 0.082, dur: 0.13, peak: 0.46, bright: 2200, reverb: 0.038 });
    }
    micOff() {
      const t = this._ensure().currentTime;
      this._motif({ t0: t, notes: ['A3', 'E3'], step: 0.082, dur: 0.13, peak: 0.46, bright: 1900, reverb: 0.038 });
    }

    soundOn() {
      const t = this._ensure().currentTime;
      this._motif({ t0: t, notes: ['C3', 'E3', 'G3'], step: 0.078, dur: 0.13, peak: 0.42, bright: 2100, reverb: 0.045, accentLast: 1.1 });
    }
    soundOff() {
      const t = this._ensure().currentTime;
      this._motif({ t0: t, notes: ['G3', 'E3', 'C3'], step: 0.078, dur: 0.13, peak: 0.42, bright: 1800, reverb: 0.045 });
    }

    // скринкаст старт — глубокое «ту-ту-тун ↑» с сабом
    screencastStart() {
      const t = this._ensure().currentTime;
      this._sub({ t0: t, f0: 'D2', dur: 0.5, attack: 0.03, peak: 0.34, reverb: 0.1 });
      this._motif({ t0: t, notes: ['D3', 'A3', 'D4'], step: 0.10, dur: 0.16, peak: 0.46, bright: 2400, reverb: 0.06, spread: 0.28, accentLast: 1.18 });
    }
    // скринкаст стоп — «ту-тун ↓»
    screencastStop() {
      const t = this._ensure().currentTime;
      this._sub({ t0: t, f0: 'D2', f1: 'A1', dur: 0.42, attack: 0.02, peak: 0.32, reverb: 0.1 });
      this._motif({ t0: t, notes: ['A3', 'D3'], step: 0.11, dur: 0.16, peak: 0.44, bright: 2000, reverb: 0.055, spread: 0.24 });
    }

    // новое сообщение — одиночный мягкий клик
    message() {
      const t = this._ensure().currentTime;
      this._click({ t0: t, note: 'A3', peak: 0.38, dur: 0.16, reverb: 0.05, bright: 2300, sub: 0.45 });
    }
  }

  root.VoidSFX = VoidSFX;
})(typeof window !== 'undefined' ? window : this);
