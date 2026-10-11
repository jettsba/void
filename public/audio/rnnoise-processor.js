/* ============ RNNoise AudioWorklet processor ============
   ML-шумодав (Mozilla / RNNoise project, скомпилирован в WASM Jitsi-командой).
   Лучше chromium native noiseSuppression — особенно на mechanical клавиатуру,
   вентиляторы, ambient speech / TV в комнате.

   Архитектура: processor загружается через audioWorklet.addModule, в нём же
   import'им rnnoise-sync.js (Emscripten-обёртка с inlined base64 WASM). sync
   версия специально для AudioWorklet, где async fetch недоступен.

   RNNoise работает на 48 kHz mono frame 480 samples (10ms). Если AudioContext
   на другой частоте — processor молча passthrough'ит (no-op fallback).
   Browser обычно отдаёт 48 kHz по умолчанию, так что это редкий случай.

   Scale: входной аудио float32 от -1 до 1, RNNoise ожидает int16-range
   (-32768..32767). Конвертируем умножением на 32768 и обратно. */

import createModule from "./rnnoise-sync.js";

const FRAME_SIZE = 480; // 10ms @ 48kHz, RNNoise hard requirement.
/* Выходное кольцо: process() отдаёт блоки по 128, RNNoise выдаёт по 480 —
   в кольце копится максимум 480 + 128 сэмплов, 4 кадра с запасом. */
const OUT_RING = FRAME_SIZE * 4;

/* VAD: rnnoise_process_frame возвращает вероятность речи в кадре. Гистерезис
   здесь, в аудиопотоке, а в main thread уходит только смена состояния —
   сообщение раз в пару секунд, а не 100 в секунду. */
const VAD_ON = 0.6;
const VAD_OFF = 0.3;
const VAD_OFF_HOLD_FRAMES = 30; // 300 мс тишины, прежде чем сказать «речи нет»

class RNNoiseProcessor extends AudioWorkletProcessor {
    constructor() {
        super();
        this.ready = false;
        this.module = null;
        this.state = 0;
        this.inputPtr = 0;
        this.outputPtr = 0;
        /* Фиксированные буферы вместо push/shift по JS-массиву: shift — O(n),
           а аллокации на realtime-потоке будят GC и дают щелчки. */
        this.inFrame = new Float32Array(FRAME_SIZE);
        this.inFill = 0;
        this.outRing = new Float32Array(OUT_RING);
        this.outRead = 0;
        this.outWrite = 0;
        this.outCount = 0;
        this.speech = false;
        this.quietFrames = 0;
        this.disabled = sampleRate !== 48000;

        if (this.disabled) {
            this.port.postMessage({ type: "disabled", reason: `sampleRate=${sampleRate}` });
            return;
        }

        try {
            const m = createModule();
            if (m && typeof m.then === "function") {
                m.then((mod) => this.init(mod)).catch((err) => {
                    this.port.postMessage({ type: "error", message: String(err) });
                });
            } else {
                this.init(m);
            }
        } catch (err) {
            this.port.postMessage({ type: "error", message: String(err) });
        }
    }

    init(module) {
        try {
            this.module = module;
            this.state = module._rnnoise_create();
            this.inputPtr = module._malloc(FRAME_SIZE * 4); // float32 = 4 bytes
            this.outputPtr = module._malloc(FRAME_SIZE * 4);
            this.ready = true;
            this.port.postMessage({ type: "ready" });
        } catch (err) {
            this.port.postMessage({ type: "error", message: String(err) });
        }
    }

    trackVad(p) {
        if (!(p >= 0)) return;
        if (!this.speech && p > VAD_ON) {
            this.speech = true;
            this.quietFrames = 0;
            this.port.postMessage({ type: "vad", speech: true });
        } else if (this.speech) {
            this.quietFrames = p < VAD_OFF ? this.quietFrames + 1 : 0;
            if (this.quietFrames >= VAD_OFF_HOLD_FRAMES) {
                this.speech = false;
                this.port.postMessage({ type: "vad", speech: false });
            }
        }
    }

    process(inputs, outputs) {
        const input = inputs[0]?.[0];
        const output = outputs[0]?.[0];
        if (!input || !output) return true;

        // Passthrough пока не готов или disabled — без задержки сигнала.
        if (this.disabled || !this.ready) {
            if (input.length === output.length) {
                output.set(input);
            }
            return true;
        }

        const heap = this.module.HEAPF32;
        const inPtrIdx = this.inputPtr >> 2;
        const outPtrIdx = this.outputPtr >> 2;

        // Накапливаем входной сигнал 480-сэмпловыми кадрами.
        for (let i = 0; i < input.length; i++) {
            this.inFrame[this.inFill++] = input[i] * 32768;
            if (this.inFill === FRAME_SIZE) {
                this.inFill = 0;
                heap.set(this.inFrame, inPtrIdx);
                const vad = this.module._rnnoise_process_frame(this.state, this.outputPtr, this.inputPtr);
                this.trackVad(vad);
                for (let k = 0; k < FRAME_SIZE; k++) {
                    if (this.outCount === OUT_RING) break; // не бывает при 128-блоках; страховка
                    this.outRing[this.outWrite] = heap[outPtrIdx + k] / 32768;
                    this.outWrite = (this.outWrite + 1) % OUT_RING;
                    this.outCount++;
                }
            }
        }

        // Заполняем выход из готовых обработанных сэмплов. Пока первый кадр
        // не накопился до 480 — тишина, это <10ms и незаметно при старте.
        for (let i = 0; i < output.length; i++) {
            if (this.outCount > 0) {
                output[i] = this.outRing[this.outRead];
                this.outRead = (this.outRead + 1) % OUT_RING;
                this.outCount--;
            } else {
                output[i] = 0;
            }
        }

        return true;
    }
}

registerProcessor("rnnoise-processor", RNNoiseProcessor);
