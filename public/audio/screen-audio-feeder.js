/* Screen-audio feeder (AudioWorkletProcessor).
 *
 * Принимает с main-потока кадры PCM (Int16, interleaved stereo, 48kHz), которые
 * Rust-сторона (screen_audio.rs) захватывает нативным WASAPI loopback с
 * исключением нашего процесс-дерева — чистый звук демки БЕЗ голосов void. Идут
 * через tauri::ipc::Channel → channel.onmessage → port.postMessage(ArrayBuffer).
 *
 * Задача — превратить рваный поток IPC-кадров в непрерывный аудио-сигнал без
 * щелчков, с учётом ДРЕЙФА ЧАСОВ: WASAPI-захват и AudioContext тактируются
 * РАЗНЫМИ аппаратными часами (оба ~48k, но расходятся на десятки ppm). Поэтому:
 *   - префетч PREBUFFER перед стартом (съесть стартовый джиттер);
 *   - на underflow — мягкий refill REFILL (а НЕ полный ре-префетч: иначе каждый
 *     микро-провал давал бы слышимый 50мс разрыв);
 *   - кап латентности MAX_LAT: если буфер раздулся (продюсер быстрее по дрейфу) —
 *     роняем старейшее до PREBUFFER (один редкий тихий тик вместо роста задержки).
 *
 * Выход → MediaStreamAudioDestinationNode → MediaStreamTrack для WebRTC.
 */

const SR = 48000;
const PREBUFFER = Math.round(SR * 0.05);  // 50мс — целевая латентность / старт
const REFILL = Math.round(SR * 0.025);    // 25мс — добор после underflow
const MAX_LAT = Math.round(SR * 0.15);    // 150мс — потолок латентности (дрейф)
const CAP = Math.round(SR * 0.4);         // 400мс — ёмкость кольца (> MAX_LAT)

class ScreenAudioFeeder extends AudioWorkletProcessor {
    constructor() {
        super();
        this.bufL = new Float32Array(CAP);
        this.bufR = new Float32Array(CAP);
        this.read = 0;
        this.write = 0;
        this.size = 0;                 // кадров в кольце
        this.gate = false;            // отдаём звук (true) или копим (false)
        this.primeTarget = PREBUFFER; // сколько накопить перед открытием gate
        this.port.onmessage = (e) => this.enqueue(e.data);
    }

    enqueue(arrbuf) {
        if (!(arrbuf instanceof ArrayBuffer) || arrbuf.byteLength < 4) return;
        const pcm = new Int16Array(arrbuf);
        const frames = pcm.length >> 1; // stereo
        for (let i = 0; i < frames; i++) {
            if (this.size >= CAP) {
                this.read = (this.read + 1) % CAP; // overflow — дроп старейшего
                this.size--;
            }
            this.bufL[this.write] = pcm[2 * i] / 32768;
            this.bufR[this.write] = pcm[2 * i + 1] / 32768;
            this.write = (this.write + 1) % CAP;
            this.size++;
        }
    }

    process(_inputs, outputs) {
        const out = outputs[0];
        const outL = out[0];
        const stereo = out.length > 1;
        const outR = stereo ? out[1] : null;
        const n = outL.length;

        // Дрейф (продюсер быстрее): латентность раздулась → роняем до целевой.
        if (this.size > MAX_LAT) {
            const drop = this.size - PREBUFFER;
            this.read = (this.read + drop) % CAP;
            this.size -= drop;
        }

        // Накопление перед открытием gate (старт или добор после underflow).
        if (!this.gate) {
            if (this.size >= this.primeTarget) {
                this.gate = true;
            } else {
                outL.fill(0);
                if (outR) outR.fill(0);
                return true;
            }
        }

        for (let i = 0; i < n; i++) {
            if (this.size > 0) {
                outL[i] = this.bufL[this.read];
                if (outR) outR[i] = this.bufR[this.read];
                this.read = (this.read + 1) % CAP;
                this.size--;
            } else {
                // Underflow — тишина и мягкий добор (REFILL), без полного префетча.
                outL[i] = 0;
                if (outR) outR[i] = 0;
                this.gate = false;
                this.primeTarget = REFILL;
            }
        }
        return true;
    }
}

registerProcessor("screen-audio-feeder", ScreenAudioFeeder);
