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

class RNNoiseProcessor extends AudioWorkletProcessor {
    constructor() {
        super();
        this.ready = false;
        this.module = null;
        this.state = 0;
        this.inputPtr = 0;
        this.outputPtr = 0;
        this.inBuf = [];
        this.outBuf = [];
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

        // Накапливаем входной сигнал в буфер 480-сэмпловыми кадрами.
        for (let i = 0; i < input.length; i++) {
            this.inBuf.push(input[i] * 32768);
        }

        while (this.inBuf.length >= FRAME_SIZE) {
            for (let i = 0; i < FRAME_SIZE; i++) {
                heap[inPtrIdx + i] = this.inBuf.shift();
            }
            this.module._rnnoise_process_frame(this.state, this.outputPtr, this.inputPtr);
            for (let i = 0; i < FRAME_SIZE; i++) {
                this.outBuf.push(heap[outPtrIdx + i] / 32768);
            }
        }

        // Заполняем выход из готовых обработанных сэмплов. Если буфер ещё
        // не накопился до 480 (первый блок) — выходим тишиной, это <10ms
        // и незаметно при старте трансляции.
        for (let i = 0; i < output.length; i++) {
            output[i] = this.outBuf.length > 0 ? this.outBuf.shift() : 0;
        }

        return true;
    }
}

registerProcessor("rnnoise-processor", RNNoiseProcessor);
