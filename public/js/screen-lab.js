/* ===== Dev-журнал демки (screen-share lab) =====
   Плавающая панель в dev-режиме (плитка «журнал демки» в разделе «разработчик»):
   кнопка старт/стоп записи, метки и переключатели, которые переопределяют
   настройки демки прямо во время звонка. Журнал пишет ТОЛЬКО свою сторону;
   два файла одного теста сводятся по времени (UTC, мс) и по меткам.

   Формат — JSON Lines: одна запись на строку, поле `k` — тип записи:
     header        система, кодеки, возможности энкодера, состояние комнаты
     display       измеренная частота обновления экрана
     stats         сырые getStats по пиру (RTP/транспорт/выбранная пара)
     sum           выжимка по пиру за секунду (fps по этапам, битрейт, qLim…)
     candidates    все ICE-кандидаты и пары (раз в 10 с и при изменении)
     codecs        кодеки, на которых реально идут потоки (при изменении)
     enc-params    sender.getParameters() демки (при изменении)
     track         настройки/статистика захвата экрана (при изменении)
     render        отрисовка у зрителя (requestVideoFrameCallback) + генератор
     gen           генератор у отправителя: сколько кадров нарисовано
     app           главный поток: лаг цикла событий, long tasks, rAF, фокус
     sys           CPU/память/питание (desktop, Rust lab_sys_stats)
     pc            события RTCPeerConnection
     peer          пир появился/пропал/пересобран
     clock         синхронизация часов с пиром (для задержки генератора)
     log           все записи общего логгера (log.js) любого уровня
     toggle        «Активирован переключатель …: было → стало»
     peer-toggles  состояние переключателей собеседника
     mark / peer-mark  метки «сейчас плохо» (свои / собеседника)
     footer        итог записи

   Переопределения (overrides) читает webrtc.js (labOverride): null — «авто»,
   обычная логика. Кодек живёт в VoidCodec (localStorage), источник и кодек
   применяются к СЛЕДУЮЩЕМУ запуску демки. */
(function () {
    "use strict";

    const TICK_MS = 1000;
    const SYNC_EVERY_MS = 5000;
    const MARK_ACCEL = "Ctrl+Shift+L";
    /* Генератор: штрихкод 2 ряда × 24 клетки в левом верхнем углу. Клетка
       квадратная, ширина кадра / 48 — переживает даунскейл и сжатие. */
    const BAR_COLS = 24;
    const BAR_CELL_DIV = 48;
    const TS_MASK = 0x7FFFFF; // 23 бита миллисекунд ≈ 2.3 ч до перехода через ноль

    const overrides = {
        path: null, fps: null, bitrate: null, degradation: null, hint: null, source: null, adapt: null
    };

    const TOGGLES = [
        { key: "path", label: "путь", opts: [[null, "авто"], ["relay", "relay"], ["direct", "direct"]] },
        { key: "fps", label: "кадры", opts: [[null, "авто"], [15, "15"], [30, "30"], [60, "60"]] },
        { key: "bitrate", label: "битрейт", opts: [[null, "авто"], [1_500_000, "1.5м"], [3_000_000, "3м"], [6_000_000, "6м"], [10_000_000, "10м"]] },
        { key: "degradation", label: "просадка", opts: [[null, "авто"], ["balanced", "баланс"], ["maintain-resolution", "резкость"], ["maintain-framerate", "плавность"]] },
        { key: "hint", label: "контент", opts: [[null, "авто"], ["detail", "detail"], ["text", "text"], ["motion", "motion"]] },
        { key: "adapt", label: "автоподстройка", opts: [[null, "вкл"], ["off", "выкл"]] },
        /* «движок» — НЕ дефолт: setCodecPreferences не зовётся, кодек выбирает
           браузер. Дефолт Void — h264. */
        { key: "codec", label: "кодек", opts: [["h264", "h264"], ["vp9", "vp9"], ["auto", "движок"]], nextDemo: true },
        { key: "source", label: "источник", opts: [[null, "экран"], ["generator", "генератор"]], nextDemo: true }
    ];

    const isDesktop = () => window.VoidPlatform === "desktop";
    const invoke = (cmd, args) => window.__TAURI__?.core?.invoke(cmd, args);
    const peersMap = () => (typeof peers !== "undefined" && peers) ? peers : new Map();
    const nickOf = (uid) => (typeof nicknameMap !== "undefined" && nicknameMap.get?.(uid)) || null;
    const round = (v, d = 1) => (v == null || !isFinite(v)) ? null : Math.round(v * 10 ** d) / 10 ** d;

    /* ---------------- запись ---------------- */

    let rec = null;          // активная запись
    let pendingSave = null;  // { text, name } — сохранение отменено, ждёт повтора
    let markSeq = 0;

    function write(k, data) {
        if (!rec) return;
        const ms = Date.now();
        rec.lines.push(JSON.stringify({ t: new Date(ms).toISOString(), ms, k, ...data }));
    }

    /* Точка входа для webrtc.js / socket.js: события демки. */
    function event(kind, data) {
        write(kind, data || {});
    }

    function toggleLabel(key) {
        return TOGGLES.find(t => t.key === key)?.label || key;
    }

    function optLabel(key, value) {
        const t = TOGGLES.find(x => x.key === key);
        const o = t?.opts.find(([v]) => v === value);
        return o ? o[1] : String(value);
    }

    function currentState() {
        return {
            ...overrides,
            codec: window.VoidCodec?.get?.() || null,
            forceRelay: typeof forceRelay !== "undefined" ? !!forceRelay : null,
            forceDirect: typeof forceDirect !== "undefined" ? !!forceDirect : null
        };
    }

    /* ---------------- заголовок ---------------- */

    function gpuInfo() {
        try {
            const c = document.createElement("canvas");
            const gl = c.getContext("webgl2") || c.getContext("webgl");
            if (!gl) return null;
            const ext = gl.getExtension("WEBGL_debug_renderer_info");
            return {
                vendor: ext ? gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR),
                renderer: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)
            };
        } catch (_) { return null; }
    }

    function codecCaps(kind) {
        try {
            const send = RTCRtpSender.getCapabilities?.(kind)?.codecs || [];
            const recv = RTCRtpReceiver.getCapabilities?.(kind)?.codecs || [];
            const fmt = c => c.mimeType + (c.sdpFmtpLine ? " " + c.sdpFmtpLine : "");
            return { send: send.map(fmt), recv: recv.map(fmt) };
        } catch (_) { return null; }
    }

    /* powerEfficient у encodingInfo ≈ «есть аппаратный энкодер» для этой
       конфигурации. Главный вопрос к машине друга: почему OpenH264. */
    async function encoderCaps() {
        const mc = navigator.mediaCapabilities;
        if (!mc?.encodingInfo) return null;
        const out = [];
        const types = ["video/H264;profile-level-id=42e01f;packetization-mode=1", "video/VP9", "video/VP8", "video/AV1"];
        for (const contentType of types) {
            for (const [height, framerate] of [[1080, 30], [1080, 60], [720, 30]]) {
                const width = height === 1080 ? 1920 : 1280;
                try {
                    const r = await mc.encodingInfo({
                        type: "webrtc",
                        video: { contentType, width, height, bitrate: 6_000_000, framerate }
                    });
                    out.push({ codec: contentType.split(";")[0], res: `${height}p${framerate}`, supported: r.supported, smooth: r.smooth, powerEfficient: r.powerEfficient });
                } catch (e) {
                    out.push({ codec: contentType.split(";")[0], res: `${height}p${framerate}`, error: e?.message || String(e) });
                }
            }
        }
        return out;
    }

    async function writeHeader() {
        let uaCH = null;
        try {
            uaCH = await navigator.userAgentData?.getHighEntropyValues?.(
                ["platform", "platformVersion", "architecture", "bitness", "model", "fullVersionList"]);
        } catch (_) {}
        const peerList = [...peersMap().keys()].map(uid => ({ uid, nick: nickOf(uid) }));
        write("header", {
            journal: 1,
            app: {
                version: window.VoidVersion || null,
                platform: window.VoidPlatform || "web",
                mac: !!window.VoidIsMac
            },
            me: {
                clientId: typeof clientId !== "undefined" ? clientId : null,
                nick: typeof currentUsername !== "undefined" ? currentUsername : null
            },
            webview: isDesktop() ? await invoke("lab_webview_version").catch(e => "err: " + (e?.message || e)) : null,
            room: typeof currentRoomCode !== "undefined" ? currentRoomCode : null,
            peers: peerList,
            ua: navigator.userAgent,
            uaCH,
            lang: navigator.language,
            tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
            cores: navigator.hardwareConcurrency || null,
            deviceMemoryGB: navigator.deviceMemory || null,
            connection: navigator.connection ? {
                type: navigator.connection.type, effectiveType: navigator.connection.effectiveType,
                downlinkMbps: navigator.connection.downlink, rttMs: navigator.connection.rtt
            } : null,
            screen: {
                w: screen.width, h: screen.height, availW: screen.availWidth, availH: screen.availHeight,
                dpr: window.devicePixelRatio, colorDepth: screen.colorDepth,
                innerW: window.innerWidth, innerH: window.innerHeight
            },
            gpu: gpuInfo(),
            codecs: { video: codecCaps("video"), audio: codecCaps("audio") },
            encoderCaps: await encoderCaps(),
            apis: {
                rvfc: "requestVideoFrameCallback" in HTMLVideoElement.prototype,
                trackStats: typeof MediaStreamTrack !== "undefined" && "stats" in MediaStreamTrack.prototype,
                pressure: "PressureObserver" in window,
                longtask: (PerformanceObserver.supportedEntryTypes || []).includes("longtask")
            },
            state: currentState(),
            screenTarget: {
                height: typeof screenTargetHeight !== "undefined" ? screenTargetHeight : null,
                fps: typeof screenTargetFps !== "undefined" ? screenTargetFps : null
            },
            sharing: !!(typeof screenStream !== "undefined" && screenStream?.active),
            screencaster: typeof roomScreencasterId !== "undefined" ? roomScreencasterId : null,
            logLevel: window.log?.getLevel?.() || null,
            timeOrigin: performance.timeOrigin
        });
        measureRefreshRate();
    }

    /* Частота обновления экрана по интервалам rAF за ~1.5 с. */
    function measureRefreshRate() {
        const ts = [];
        const step = (t) => {
            ts.push(t);
            if (ts.length < 90) requestAnimationFrame(step);
            else {
                const iv = [];
                for (let i = 1; i < ts.length; i++) iv.push(ts[i] - ts[i - 1]);
                iv.sort((a, b) => a - b);
                const med = iv[Math.floor(iv.length / 2)];
                write("display", { refreshHz: round(1000 / med, 1), medianFrameMs: round(med, 2), hidden: document.hidden });
            }
        };
        requestAnimationFrame(step);
    }

    /* ---------------- инструментирование пиров ---------------- */

    function parseCand(str) {
        if (typeof str !== "string") return null;
        const p = str.split(" ");
        const typIdx = p.indexOf("typ");
        return {
            protocol: p[2] || null, address: p[4] || null, port: p[5] || null,
            type: typIdx >= 0 ? p[typIdx + 1] : null
        };
    }

    function instrumentPeer(uid, pc) {
        const on = (type, fn) => {
            pc.addEventListener(type, fn);
            rec.listeners.push([pc, type, fn]);
        };
        const base = () => ({ uid, nick: nickOf(uid) });
        on("connectionstatechange", () => write("pc", { ...base(), ev: "connectionState", v: pc.connectionState }));
        on("iceconnectionstatechange", () => write("pc", { ...base(), ev: "iceConnectionState", v: pc.iceConnectionState }));
        on("icegatheringstatechange", () => write("pc", { ...base(), ev: "iceGatheringState", v: pc.iceGatheringState }));
        on("signalingstatechange", () => write("pc", { ...base(), ev: "signalingState", v: pc.signalingState }));
        on("negotiationneeded", () => write("pc", { ...base(), ev: "negotiationneeded" }));
        on("track", (e) => write("pc", { ...base(), ev: "track", kind: e.track?.kind, trackId: e.track?.id, streams: e.streams?.length || 0 }));
        on("icecandidate", (e) => {
            const c = e.candidate;
            write("pc", {
                ...base(), ev: "local-candidate",
                candidate: c ? c.candidate : null, parsed: c ? parseCand(c.candidate) : null,
                relayProtocol: c?.relayProtocol || null, url: c?.url || null
            });
        });
        on("icecandidateerror", (e) => write("pc", {
            ...base(), ev: "icecandidateerror", url: e.url, errorCode: e.errorCode, errorText: e.errorText,
            address: e.address, port: e.port
        }));
    }

    function syncPeers() {
        const seen = new Set();
        for (const [uid, pc] of peersMap()) {
            seen.add(uid);
            const known = rec.peers.get(uid);
            if (known && known.pc === pc) continue;
            write("peer", {
                uid, nick: nickOf(uid), ev: known ? "rebuilt" : "added",
                connectionState: pc.connectionState, iceConnectionState: pc.iceConnectionState,
                polite: pc._polite, relay: !!pc._isRelay
            });
            instrumentPeer(uid, pc);
            rec.peers.set(uid, { pc, prev: null, prevCodecs: "", prevCands: "", prevParams: "", tick: 0 });
        }
        for (const uid of [...rec.peers.keys()]) {
            if (!seen.has(uid)) {
                write("peer", { uid, nick: nickOf(uid), ev: "removed" });
                rec.peers.delete(uid);
            }
        }
    }

    /* ---------------- getStats ---------------- */

    const RAW_TYPES = new Set(["outbound-rtp", "inbound-rtp", "remote-inbound-rtp", "remote-outbound-rtp", "media-source", "media-playout", "transport"]);

    function strip(r) {
        const o = {};
        for (const k in r) o[k] = r[k];
        return o;
    }

    function d(cur, prev, f) {
        if (!cur || !prev || cur[f] == null || prev[f] == null) return null;
        return cur[f] - prev[f];
    }

    function perSec(cur, prev, f, dt) {
        const v = d(cur, prev, f);
        return v == null || !dt ? null : v / dt;
    }

    function qLimDelta(cur, prev) {
        const a = cur?.qualityLimitationDurations, b = prev?.qualityLimitationDurations;
        if (!a || !b) return null;
        const out = {};
        for (const k in a) {
            const v = round((a[k] || 0) - (b[k] || 0), 2);
            if (v) out[k] = v;
        }
        return out;
    }

    function summarizeOut(v, pv, src, rin, dt, codecs) {
        if (!v) return null;
        const enc = d(v, pv, "framesEncoded");
        const encTime = d(v, pv, "totalEncodeTime");
        return {
            res: `${v.frameWidth || 0}x${v.frameHeight || 0}`,
            fpsStat: round(v.framesPerSecond),
            encFps: round(enc != null && dt ? enc / dt : null),
            sentFps: round(perSec(v, pv, "framesSent", dt)),
            kbps: round((perSec(v, pv, "bytesSent", dt) || 0) * 8 / 1000, 0),
            retransKbps: round((perSec(v, pv, "retransmittedBytesSent", dt) || 0) * 8 / 1000, 0),
            targetKbps: v.targetBitrate != null ? Math.round(v.targetBitrate / 1000) : null,
            qLim: v.qualityLimitationReason || null,
            qLimDur: qLimDelta(v, pv),
            qLimResChanges: v.qualityLimitationResolutionChanges ?? null,
            encMsPerFrame: enc ? round(encTime * 1000 / enc, 2) : null,
            qp: enc ? round(d(v, pv, "qpSum") / enc, 1) : null,
            keyframes: d(v, pv, "keyFramesEncoded"),
            hugeFrames: d(v, pv, "hugeFramesSent"),
            nackIn: d(v, pv, "nackCount"),
            pliIn: d(v, pv, "pliCount"),
            firIn: d(v, pv, "firCount"),
            pktSent: d(v, pv, "packetsSent"),
            pacerDelayMs: d(v, pv, "packetsSent") ? round(d(v, pv, "totalPacketSendDelay") * 1000 / d(v, pv, "packetsSent"), 1) : null,
            encoder: v.encoderImplementation || null,
            powerEfficient: v.powerEfficientEncoder ?? null,
            scalability: v.scalabilityMode || null,
            codec: codecs.get(v.codecId) || null,
            active: v.active ?? null,
            src: src ? { res: `${src.width || 0}x${src.height || 0}`, fps: round(src.framesPerSecond), frames: src.frames ?? null } : null,
            remote: rin ? {
                lossPct: rin.fractionLost != null ? round(rin.fractionLost * 100, 2) : null,
                lost: rin.packetsLost ?? null,
                jitterMs: rin.jitter != null ? round(rin.jitter * 1000, 1) : null,
                rttMs: rin.roundTripTime != null ? round(rin.roundTripTime * 1000, 0) : null
            } : null
        };
    }

    function summarizeIn(v, pv, dt, codecs) {
        if (!v) return null;
        const dec = d(v, pv, "framesDecoded");
        const decTime = d(v, pv, "totalDecodeTime");
        const jbE = d(v, pv, "jitterBufferEmittedCount");
        const ifd = d(v, pv, "totalInterFrameDelay");
        const ifd2 = d(v, pv, "totalSquaredInterFrameDelay");
        let ifStd = null;
        if (dec && ifd != null && ifd2 != null) {
            const mean = ifd / dec;
            ifStd = round(Math.sqrt(Math.max(0, ifd2 / dec - mean * mean)) * 1000, 1);
        }
        return {
            res: `${v.frameWidth || 0}x${v.frameHeight || 0}`,
            fpsStat: round(v.framesPerSecond),
            recvFps: round(perSec(v, pv, "framesReceived", dt)),
            decFps: round(dec != null && dt ? dec / dt : null),
            dropped: d(v, pv, "framesDropped"),
            freezes: d(v, pv, "freezeCount"),
            freezeMs: d(v, pv, "totalFreezesDuration") != null ? round(d(v, pv, "totalFreezesDuration") * 1000, 0) : null,
            pauses: d(v, pv, "pauseCount"),
            pauseMs: d(v, pv, "totalPausesDuration") != null ? round(d(v, pv, "totalPausesDuration") * 1000, 0) : null,
            interFrameStdMs: ifStd,
            jbMs: jbE ? round(d(v, pv, "jitterBufferDelay") * 1000 / jbE, 1) : null,
            jbTargetMs: jbE ? round(d(v, pv, "jitterBufferTargetDelay") * 1000 / jbE, 1) : null,
            decMsPerFrame: dec ? round(decTime * 1000 / dec, 2) : null,
            kbps: round((perSec(v, pv, "bytesReceived", dt) || 0) * 8 / 1000, 0),
            pktLost: d(v, pv, "packetsLost"),
            pktRecv: d(v, pv, "packetsReceived"),
            nackOut: d(v, pv, "nackCount"),
            pliOut: d(v, pv, "pliCount"),
            firOut: d(v, pv, "firCount"),
            keyframes: d(v, pv, "keyFramesDecoded"),
            jitterMs: v.jitter != null ? round(v.jitter * 1000, 1) : null,
            decoder: v.decoderImplementation || null,
            powerEfficient: v.powerEfficientDecoder ?? null,
            codec: codecs.get(v.codecId) || null
        };
    }

    async function samplePeer(uid, slot) {
        const pc = slot.pc;
        let report;
        try { report = await pc.getStats(); } catch (e) {
            write("stats-error", { uid, err: e?.message || String(e) });
            return;
        }
        const now = performance.now();
        slot.tick++;
        const all = [];
        report.forEach(r => all.push(r));

        const transport = all.find(r => r.type === "transport");
        let pair = transport?.selectedCandidatePairId ? report.get(transport.selectedCandidatePairId) : null;
        if (!pair) pair = all.find(r => r.type === "candidate-pair" && r.nominated && r.state === "succeeded") || null;
        const lc = pair ? report.get(pair.localCandidateId) : null;
        const rc = pair ? report.get(pair.remoteCandidateId) : null;

        const codecs = new Map();
        all.filter(r => r.type === "codec").forEach(c => codecs.set(c.id, c.mimeType + (c.sdpFmtpLine ? " " + c.sdpFmtpLine : "")));

        /* Сырые записи: видео и транспорт — каждую секунду, аудио — раз в 5 с. */
        const raw = [];
        for (const r of all) {
            if (!RAW_TYPES.has(r.type)) continue;
            if (r.kind === "audio" && slot.tick % 5 !== 1) continue;
            raw.push(strip(r));
        }
        if (pair) raw.push(strip(pair));
        if (lc) raw.push(strip(lc));
        if (rc) raw.push(strip(rc));
        write("stats", { uid, r: raw });

        /* Кодеки, на которых реально идут потоки. */
        const used = [...new Set(all.filter(r => r.codecId && (r.type === "outbound-rtp" || r.type === "inbound-rtp"))
            .map(r => `${r.type}/${r.kind}: ${codecs.get(r.codecId) || r.codecId}`))].sort();
        const usedKey = used.join("|");
        if (usedKey !== slot.prevCodecs) {
            slot.prevCodecs = usedKey;
            write("codecs", { uid, used });
        }

        /* Все кандидаты и пары — раз в 10 с, при изменении состава. */
        if (slot.tick % 10 === 1) {
            const cands = all.filter(r => r.type === "local-candidate" || r.type === "remote-candidate").map(c => ({
                id: c.id, side: c.type, type: c.candidateType, protocol: c.protocol, address: c.address || c.ip,
                port: c.port, relayProtocol: c.relayProtocol, url: c.url, networkType: c.networkType
            }));
            const pairs = all.filter(r => r.type === "candidate-pair").map(p => ({
                id: p.id, local: p.localCandidateId, remote: p.remoteCandidateId, state: p.state,
                nominated: p.nominated, rttMs: p.currentRoundTripTime != null ? Math.round(p.currentRoundTripTime * 1000) : null,
                reqSent: p.requestsSent, respRecv: p.responsesReceived, bytesSent: p.bytesSent, bytesRecv: p.bytesReceived
            }));
            const key = JSON.stringify(cands.map(c => c.id)) + JSON.stringify(pairs.map(p => p.id + p.state));
            if (key !== slot.prevCands) {
                slot.prevCands = key;
                write("candidates", { uid, cands, pairs, selected: pair?.id || null });
            }
        }

        const prev = slot.prev;
        const dt = prev ? (now - prev.now) / 1000 : 0;
        const pick = (type, kind) => all.filter(r => r.type === type && r.kind === kind);
        /* Видео-outbound у нас ровно один (демка), inbound — демка собеседника. */
        const vout = pick("outbound-rtp", "video")[0] || null;
        const vin = pick("inbound-rtp", "video")[0] || null;
        const vsrc = vout?.mediaSourceId ? report.get(vout.mediaSourceId) : null;
        const vrin = vout ? all.find(r => r.type === "remote-inbound-rtp" && r.localId === vout.id) : null;
        const p = prev?.byId || new Map();

        const conn = pair ? ((lc?.candidateType === "relay" || rc?.candidateType === "relay") ? "relay" : "direct") : "none";
        write("sum", {
            uid, nick: nickOf(uid), dt: round(dt, 2),
            conn, pc: pc.connectionState, ice: pc.iceConnectionState,
            local: lc ? { type: lc.candidateType, proto: lc.protocol, relayProto: lc.relayProtocol || null, url: lc.url || null, addr: lc.address || lc.ip, net: lc.networkType || null } : null,
            remote: rc ? { type: rc.candidateType, proto: rc.protocol, addr: rc.address || rc.ip } : null,
            rttMs: pair?.currentRoundTripTime != null ? Math.round(pair.currentRoundTripTime * 1000) : null,
            availOutKbps: pair?.availableOutgoingBitrate != null ? Math.round(pair.availableOutgoingBitrate / 1000) : null,
            availInKbps: pair?.availableIncomingBitrate != null ? Math.round(pair.availableIncomingBitrate / 1000) : null,
            out: summarizeOut(vout, vout && p.get(vout.id), vsrc, vrin, dt, codecs),
            in: summarizeIn(vin, vin && p.get(vin.id), dt, codecs)
        });

        const byId = new Map();
        for (const r of all) if (r.type === "outbound-rtp" || r.type === "inbound-rtp") byId.set(r.id, r);
        slot.prev = { now, byId };

        /* Параметры энкодера демки — при любом изменении. */
        const senders = (typeof screenSenders !== "undefined") ? screenSenders.get(uid) : null;
        const vs = senders?.find?.(s => s.track?.kind === "video");
        if (vs) {
            let params = null;
            try {
                const gp = vs.getParameters();
                params = { encodings: gp.encodings, degradationPreference: gp.degradationPreference ?? null, codecs: (gp.codecs || []).slice(0, 3).map(c => c.mimeType) };
            } catch (e) { params = { err: e?.message || String(e) }; }
            const key = JSON.stringify(params);
            if (key !== slot.prevParams) {
                slot.prevParams = key;
                write("enc-params", { uid, params });
            }
        } else if (slot.prevParams) {
            slot.prevParams = "";
        }
    }

    /* ---------------- захват экрана (своя демка) ---------------- */

    function sampleLocalTrack() {
        const s = (typeof screenStream !== "undefined") ? screenStream : null;
        const track = s?.active ? s.getVideoTracks()[0] : null;
        if (!track) {
            if (rec.prevTrack) { rec.prevTrack = ""; write("track", { active: false }); }
            return;
        }
        const settings = track.getSettings?.() || {};
        const info = { label: track.label, readyState: track.readyState, muted: track.muted, contentHint: track.contentHint, settings };
        const key = JSON.stringify(info);
        let stats = null;
        try {
            const st = track.stats;
            if (st) {
                const cur = { delivered: st.deliveredFrames, discarded: st.discardedFrames, total: st.totalFrames };
                const pv = rec.prevTrackStats;
                stats = pv ? { delivered: cur.delivered - pv.delivered, discarded: cur.discarded - pv.discarded, total: cur.total - pv.total } : null;
                rec.prevTrackStats = cur;
            }
        } catch (_) {}
        if (key !== rec.prevTrack) {
            rec.prevTrack = key;
            write("track", { active: true, ...info });
        }
        if (stats) write("track-stats", { perSec: stats });
    }

    /* ---------------- отрисовка у зрителя ---------------- */

    let sampler = null;

    function decodeBarcode(video) {
        const vw = video.videoWidth, vh = video.videoHeight;
        if (!vw || !vh) return null;
        if (!sampler) {
            const c = document.createElement("canvas");
            c.width = BAR_COLS * 4; c.height = 8;
            sampler = c.getContext("2d", { willReadFrequently: true });
        }
        const cell = vw / BAR_CELL_DIV;
        try {
            sampler.drawImage(video, cell, cell, cell * BAR_COLS, cell * 2, 0, 0, BAR_COLS * 4, 8);
        } catch (_) { return null; }
        const px = sampler.getImageData(0, 0, BAR_COLS * 4, 8).data;
        const bit = (col, row) => {
            const i = ((row * 4 + 2) * BAR_COLS * 4 + col * 4 + 2) * 4;
            return (px[i] + px[i + 1] + px[i + 2]) / 3 > 127 ? 1 : 0;
        };
        if (bit(0, 0) !== 1 || bit(0, 1) !== 0) return null;
        let counter = 0;
        for (let c = 1; c <= 20; c++) counter = counter * 2 + bit(c, 0);
        let check = 0;
        for (let c = 21; c <= 23; c++) check = check * 2 + bit(c, 0);
        if (check !== barCheck(counter)) return null;
        let ts = 0;
        for (let c = 1; c <= 23; c++) ts = ts * 2 + bit(c, 1);
        return { counter, ts };
    }

    function barCheck(counter) {
        return Math.imul(counter, 0x9E3779B1) >>> 29;
    }

    function newRenderAgg() {
        return {
            frames: 0, intervals: [], procMs: 0, procN: 0,
            gen: { ok: 0, fail: 0, skipped: 0, repeats: 0, maxGap: 0, lat: [], rawDiff: [] }
        };
    }

    function attachRender() {
        const v = (typeof screenOverlayVideo !== "undefined") ? screenOverlayVideo : null;
        if (!v || typeof v.requestVideoFrameCallback !== "function") return;
        if (rec.render.el === v && rec.render.handle != null) return;
        rec.render.el = v;
        const onFrame = (nowTs, meta) => {
            if (!rec || rec.render.el !== v) return;
            const r = rec.render;
            const a = r.agg;
            a.frames++;
            if (r.lastPresent != null) a.intervals.push(meta.expectedDisplayTime - r.lastPresent);
            r.lastPresent = meta.expectedDisplayTime;
            if (meta.processingDuration != null) { a.procMs += meta.processingDuration * 1000; a.procN++; }
            r.lastMeta = { w: meta.width, h: meta.height, presentedFrames: meta.presentedFrames };
            /* Генератор: пытаемся каждый кадр, пока он находится; если 60 кадров
               подряд мимо — источник не генератор, пробуем раз в 30 кадров. */
            if (r.genMiss < 60 || a.frames % 30 === 0) {
                const b = decodeBarcode(v);
                if (b) {
                    r.genMiss = 0;
                    a.gen.ok++;
                    if (r.lastCounter != null) {
                        const gap = b.counter - r.lastCounter - 1;
                        if (gap > 0) { a.gen.skipped += gap; a.gen.maxGap = Math.max(a.gen.maxGap, gap); }
                        else if (gap === -1) a.gen.repeats++;
                    }
                    r.lastCounter = b.counter;
                    const displayEpoch = performance.timeOrigin + meta.expectedDisplayTime;
                    a.gen.rawDiff.push(((Math.round(displayEpoch) & TS_MASK) - b.ts + TS_MASK + 1) & TS_MASK);
                    const sender = typeof roomScreencasterId !== "undefined" ? roomScreencasterId : null;
                    const sync = sender ? rec.clock.get(sender) : null;
                    if (sync) {
                        const senderNow = Math.round(displayEpoch + sync.offset);
                        a.gen.lat.push(((senderNow & TS_MASK) - b.ts + TS_MASK + 1) & TS_MASK);
                    }
                } else {
                    r.genMiss++;
                    if (r.genMiss <= 60 && r.lastCounter != null) a.gen.fail++;
                }
            }
            r.handle = v.requestVideoFrameCallback(onFrame);
        };
        rec.render.handle = v.requestVideoFrameCallback(onFrame);
    }

    function stats(arr) {
        if (!arr.length) return null;
        const s = [...arr].sort((x, y) => x - y);
        const sum = s.reduce((x, y) => x + y, 0);
        return { n: s.length, min: round(s[0], 1), avg: round(sum / s.length, 1), p95: round(s[Math.min(s.length - 1, Math.floor(s.length * 0.95))], 1), max: round(s[s.length - 1], 1) };
    }

    function flushRender() {
        const r = rec.render;
        const v = r.el;
        const overlayOpen = !!(typeof screenOverlay !== "undefined" && screenOverlay?.classList?.contains("is-visible"));
        const hasStream = !!v?.srcObject;
        const a = r.agg;
        r.agg = newRenderAgg();
        /* Секунда без кадров — следующий интервал не считаем от старого кадра
           (иначе после паузы/закрытого оверлея вылезает фиктивный «фриз»). */
        if (!a.frames) r.lastPresent = null;
        if (!hasStream && !a.frames) {
            if (r.wasActive) { r.wasActive = false; write("render", { active: false, overlayOpen }); }
            return;
        }
        r.wasActive = true;
        let quality = null;
        try {
            const q = v.getVideoPlaybackQuality?.();
            if (q) {
                const pv = r.prevQuality;
                quality = pv ? { total: q.totalVideoFrames - pv.total, dropped: q.droppedVideoFrames - pv.dropped } : null;
                r.prevQuality = { total: q.totalVideoFrames, dropped: q.droppedVideoFrames };
            }
        } catch (_) {}
        const buckets = { "<20": 0, "20-40": 0, "40-70": 0, "70-150": 0, ">150": 0 };
        for (const iv of a.intervals) {
            if (iv < 20) buckets["<20"]++;
            else if (iv < 40) buckets["20-40"]++;
            else if (iv < 70) buckets["40-70"]++;
            else if (iv < 150) buckets["70-150"]++;
            else buckets[">150"]++;
        }
        const g = a.gen;
        const genActive = g.ok > 0 || g.fail > 0;
        write("render", {
            active: true, overlayOpen,
            fullscreen: !!(typeof screenOverlay !== "undefined" && screenOverlay?.classList?.contains("is-fullscreen")),
            watching: typeof roomScreencasterId !== "undefined" ? roomScreencasterId : null,
            fps: a.frames,
            intervalMs: stats(a.intervals),
            buckets,
            procMs: a.procN ? round(a.procMs / a.procN, 2) : null,
            video: v ? { w: v.videoWidth, h: v.videoHeight, cssW: v.clientWidth, cssH: v.clientHeight, dpr: window.devicePixelRatio, paused: v.paused, readyState: v.readyState } : null,
            meta: r.lastMeta || null,
            quality,
            gen: genActive ? {
                ok: g.ok, fail: g.fail, skipped: g.skipped, repeats: g.repeats, maxGap: g.maxGap,
                lastCounter: r.lastCounter, latencyMs: stats(g.lat), rawDiffMs: stats(g.rawDiff)
            } : null
        });
    }

    /* ---------------- главный поток / система ---------------- */

    function startAppProbes() {
        const app = rec.app = { lagMax: 0, lagOver100: 0, raf: 0, longN: 0, longMs: 0, pressure: null, last: performance.now() };
        app.lagTimer = setInterval(() => {
            const now = performance.now();
            const lag = now - app.last - 50;
            app.last = now;
            if (lag > app.lagMax) app.lagMax = lag;
            if (lag > 100) app.lagOver100++;
        }, 50);
        const raf = () => { if (!rec || rec.app !== app) return; app.raf++; app.rafHandle = requestAnimationFrame(raf); };
        app.rafHandle = requestAnimationFrame(raf);
        try {
            if ((PerformanceObserver.supportedEntryTypes || []).includes("longtask")) {
                app.longObs = new PerformanceObserver(list => {
                    for (const e of list.getEntries()) { app.longN++; app.longMs += e.duration; }
                });
                app.longObs.observe({ type: "longtask", buffered: false });
            }
        } catch (_) {}
        try {
            if ("PressureObserver" in window) {
                app.pressureObs = new PressureObserver(recs => {
                    const last = recs[recs.length - 1];
                    if (last && last.state !== app.pressure) {
                        app.pressure = last.state;
                        write("pressure", { cpu: last.state });
                    }
                });
                app.pressureObs.observe("cpu", { sampleInterval: 1000 }).catch(() => {});
            }
        } catch (_) {}
        app.onVis = () => write("app-state", { visibility: document.visibilityState, focus: document.hasFocus() });
        document.addEventListener("visibilitychange", app.onVis);
        window.addEventListener("focus", app.onVis);
        window.addEventListener("blur", app.onVis);
    }

    function stopAppProbes() {
        const app = rec?.app;
        if (!app) return;
        clearInterval(app.lagTimer);
        cancelAnimationFrame(app.rafHandle);
        try { app.longObs?.disconnect(); } catch (_) {}
        try { app.pressureObs?.disconnect(); } catch (_) {}
        document.removeEventListener("visibilitychange", app.onVis);
        window.removeEventListener("focus", app.onVis);
        window.removeEventListener("blur", app.onVis);
    }

    function flushApp() {
        const app = rec.app;
        const mem = performance.memory;
        write("app", {
            loopLagMaxMs: round(app.lagMax, 0), loopLagOver100: app.lagOver100,
            rafFps: app.raf, longTasks: app.longN, longTaskMs: round(app.longMs, 0),
            visibility: document.visibilityState, focus: document.hasFocus(),
            pressure: app.pressure,
            heapMB: mem ? Math.round(mem.usedJSHeapSize / 1048576) : null
        });
        app.lagMax = 0; app.lagOver100 = 0; app.raf = 0; app.longN = 0; app.longMs = 0;
    }

    async function sampleSys() {
        if (isDesktop()) {
            try {
                const s = await invoke("lab_sys_stats", { power: rec.tick % 10 === 1 });
                if (rec.tick > 1) write("sys", s);
            } catch (e) {
                if (!rec.sysErr) { rec.sysErr = true; write("sys-error", { err: e?.message || String(e) }); }
            }
        }
        if (rec.tick % 10 === 1 && navigator.getBattery) {
            try {
                const b = await navigator.getBattery();
                write("battery", { charging: b.charging, level: b.level, dischargingTime: b.dischargingTime });
            } catch (_) {}
        }
    }

    /* ---------------- синхронизация часов с пирами ---------------- */

    function channels() {
        return (typeof chatChannels !== "undefined" && chatChannels) ? chatChannels : new Map();
    }

    function sendTo(uid, msg) {
        const ch = channels().get(uid);
        if (!ch || ch.readyState !== "open") return false;
        try { ch.send(JSON.stringify({ type: "lab", ...msg })); return true; } catch (_) { return false; }
    }

    function broadcast(msg) {
        for (const uid of channels().keys()) sendTo(uid, msg);
    }

    function syncClocks() {
        for (const uid of channels().keys()) sendTo(uid, { op: "ping", t0: Date.now() });
    }

    const lastPong = new Map();

    function onPeerMessage(json, uid) {
        const op = json.op;
        if (op === "ping") {
            if (!isFinite(json.t0)) return;
            const now = Date.now();
            if (now - (lastPong.get(uid) || 0) < 200) return;
            lastPong.set(uid, now);
            sendTo(uid, { op: "pong", t0: json.t0, t1: now });
            return;
        }
        if (!rec) return;
        if (op === "pong") {
            const t2 = Date.now();
            if (!isFinite(json.t0) || !isFinite(json.t1)) return;
            const rtt = t2 - json.t0;
            if (rtt < 0 || rtt > 10000) return;
            const offset = json.t1 - (json.t0 + t2) / 2;
            /* Держим самый точный замер (минимальный rtt) из последних. */
            const cur = rec.clock.get(uid);
            if (!cur || rtt <= cur.rtt * 1.5 || Date.now() - cur.at > 30000) {
                rec.clock.set(uid, { offset, rtt, at: Date.now() });
            }
            write("clock", { uid, nick: nickOf(uid), rttMs: rtt, offsetMs: round(offset, 1), note: "offset = peer clock - my clock" });
            return;
        }
        if (op === "state" && json.state && typeof json.state === "object") {
            write("peer-toggles", { uid, nick: nickOf(uid), recording: !!json.recording, state: json.state });
            return;
        }
        if (op === "mark" && isFinite(json.n)) {
            write("peer-mark", { uid, nick: nickOf(uid), n: json.n });
            flash(`метка от ${nickOf(uid) || "собеседника"} #${json.n}`);
        }
    }

    /* ---------------- тик ---------------- */

    async function tick() {
        if (!rec || rec.busy) return;
        rec.busy = true;
        try {
            rec.tick++;
            syncPeers();
            for (const [uid, slot] of rec.peers) await samplePeer(uid, slot);
            sampleLocalTrack();
            attachRender();
            flushRender();
            flushGen();
            flushApp();
            await sampleSys();
        } catch (e) {
            write("lab-error", { err: e?.message || String(e), stack: e?.stack || null });
        } finally {
            if (rec) rec.busy = false;
            renderStatus();
        }
    }

    /* ---------------- старт / стоп ---------------- */

    async function start() {
        if (rec) return;
        pendingSave = null;
        rec = {
            startedAt: Date.now(), lines: [], peers: new Map(), listeners: [], tick: 0,
            clock: new Map(), render: { el: null, handle: null, agg: newRenderAgg(), genMiss: 0, lastCounter: null },
            prevTrack: "", prevTrackStats: null, marks: 0
        };
        markSeq = 0;
        window.log?.setTap?.((e) => write("log", { at: e.ts, level: e.level, tag: e.tag, msg: e.msg, fields: e.fields }));
        await writeHeader();
        startAppProbes();
        rec.timer = setInterval(tick, TICK_MS);
        rec.syncTimer = setInterval(syncClocks, SYNC_EVERY_MS);
        syncClocks();
        if (isDesktop()) window.VoidHotkeys?.setExtra?.({ labMark: MARK_ACCEL });
        broadcast({ op: "state", recording: true, state: currentState() });
        renderPanel();
        tick();
    }

    async function stop() {
        if (!rec) return;
        const r = rec;
        clearInterval(r.timer);
        clearInterval(r.syncTimer);
        /* Последний тик — чтобы в журнал попали данные последней секунды. */
        while (r.busy) await new Promise(res => setTimeout(res, 50));
        await tick();
        stopAppProbes();
        window.log?.setTap?.(null);
        for (const [pc, type, fn] of r.listeners) { try { pc.removeEventListener(type, fn); } catch (_) {} }
        try { if (r.render.el && r.render.handle != null) r.render.el.cancelVideoFrameCallback?.(r.render.handle); } catch (_) {}
        if (isDesktop()) {
            window.VoidHotkeys?.setExtra?.({});
            try { invoke("lab_sys_reset"); } catch (_) {}
        }
        write("footer", { durationS: Math.round((Date.now() - r.startedAt) / 1000), lines: r.lines.length + 1, marks: r.marks, state: currentState() });
        rec = null;
        broadcast({ op: "state", recording: false, state: currentState() });
        pendingSave = { text: r.lines.join("\n") + "\n", name: fileName(r.startedAt) };
        renderPanel();
        await savePending();
    }

    function fileName(at) {
        const nick = String((typeof currentUsername !== "undefined" && currentUsername) || "me")
            .toLowerCase().replace(/[^a-z0-9а-яё_-]+/gi, "_").slice(0, 24) || "me";
        const dt = new Date(at);
        const p = (n) => String(n).padStart(2, "0");
        const stamp = `${dt.getFullYear()}${p(dt.getMonth() + 1)}${p(dt.getDate())}-${p(dt.getHours())}${p(dt.getMinutes())}${p(dt.getSeconds())}`;
        return `void-journal-${nick}-${stamp}.jsonl`;
    }

    async function saveText(text, name) {
        const blob = new Blob([text], { type: "application/x-ndjson" });
        if (isDesktop() && window.VoidDesktop?.saveFile) {
            const url = URL.createObjectURL(blob);
            try { return await window.VoidDesktop.saveFile(url, name); }
            finally { URL.revokeObjectURL(url); }
        }
        if (typeof window.showSaveFilePicker === "function") {
            try {
                const h = await window.showSaveFilePicker({
                    suggestedName: name,
                    types: [{ description: "void journal", accept: { "application/x-ndjson": [".jsonl"] } }]
                });
                const w = await h.createWritable();
                await w.write(blob);
                await w.close();
                return true;
            } catch (e) {
                if (e?.name === "AbortError") return false;
            }
        }
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = name;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 10000);
        return true;
    }

    async function savePending() {
        if (!pendingSave) return;
        let ok = false;
        try { ok = await saveText(pendingSave.text, pendingSave.name); }
        catch (e) { flash("ошибка сохранения: " + (e?.message || e)); }
        if (ok) { pendingSave = null; flash("журнал сохранён"); }
        renderPanel();
    }

    function mark() {
        if (!rec) return;
        const n = ++markSeq;
        rec.marks++;
        write("mark", { n });
        broadcast({ op: "mark", n });
        flash(`метка #${n}`);
    }

    /* ---------------- переключатели ---------------- */

    function setToggle(key, value) {
        const from = key === "codec" ? (window.VoidCodec?.get?.() || null) : overrides[key];
        if (from === value) return;
        const t = TOGGLES.find(x => x.key === key);
        const sharing = !!(typeof screenStream !== "undefined" && screenStream?.active);
        write("toggle", {
            key, from, to: value,
            text: `Активирован переключатель «${toggleLabel(key)}»: ${optLabel(key, from)} → ${optLabel(key, value)}`,
            appliesTo: t?.nextDemo ? "next-demo" : "now", sharing
        });
        if (key === "codec") {
            window.VoidCodec?.set?.(value);
        } else {
            overrides[key] = value;
            if (key === "path") {
                window.__voidSetForcePath?.(value || "auto");
                write("toggle-applied", { key, note: "все соединения пересобираются" });
            } else if (key !== "source") {
                Promise.resolve(window.__voidLabReapply?.())
                    .then(() => write("toggle-applied", { key, sharing }))
                    .catch(e => write("toggle-applied", { key, err: e?.message || String(e) }));
            }
        }
        broadcast({ op: "state", recording: !!rec, state: currentState() });
        renderPanel();
    }

    /* ---------------- генератор ---------------- */

    let gen = null;

    function createGenerator(width, height, fps) {
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d", { alpha: false });
        const stream = canvas.captureStream(60);
        const track = stream.getVideoTracks()[0];

        /* Статичный фон с мелким текстом — проверка резкости (detail). */
        const bg = document.createElement("canvas");
        bg.width = width; bg.height = height;
        const b = bg.getContext("2d");
        b.fillStyle = "#0b0b0d";
        b.fillRect(0, 0, width, height);
        b.fillStyle = "#4d4d54";
        const fs = Math.max(10, Math.round(height / 72));
        b.font = `${fs}px monospace`;
        for (let y = Math.round(height * 0.2); y < height * 0.78; y += fs * 1.6) {
            b.fillText("void lab generator — static text for sharpness check 0123456789 abcdefghijklmnopqrstuvwxyz".repeat(2), fs, y);
        }

        const cell = width / BAR_CELL_DIV;
        const state = gen = { track, frame: 0, drawn: 0, maxGap: 0, lastDraw: 0, nextDue: 0, baseFps: fps };

        function drawBarcode(counter, ts) {
            const bits0 = [1];
            for (let i = 19; i >= 0; i--) bits0.push((counter >>> i) & 1);
            const chk = barCheck(counter);
            for (let i = 2; i >= 0; i--) bits0.push((chk >>> i) & 1);
            const bits1 = [0];
            for (let i = 22; i >= 0; i--) bits1.push((ts >>> i) & 1);
            ctx.fillStyle = "#808080";
            ctx.fillRect(cell * 0.5, cell * 0.5, cell * (BAR_COLS + 1), cell * 3);
            [bits0, bits1].forEach((bits, row) => {
                bits.forEach((v, col) => {
                    ctx.fillStyle = v ? "#ffffff" : "#000000";
                    ctx.fillRect(cell + col * cell, cell + row * cell, cell, cell);
                });
            });
        }

        function draw(now) {
            const target = overrides.fps || state.baseFps;
            const n = state.frame++;
            ctx.drawImage(bg, 0, 0);
            /* Бегущая полоса: полный проход за 2 с — видно рывки глазом. */
            const x = (n * width / (2 * target)) % width;
            ctx.fillStyle = "#e6e6e8";
            ctx.fillRect(x, height * 0.12, Math.max(4, width * 0.012), height * 0.76);
            /* Стрелка: оборот в секунду. */
            const cx = width * 0.86, cy = height * 0.3, rad = height * 0.12;
            const ang = (n / target) * Math.PI * 2;
            ctx.strokeStyle = "#5faa7a";
            ctx.lineWidth = Math.max(3, height / 180);
            ctx.beginPath(); ctx.arc(cx, cy, rad, 0, Math.PI * 2); ctx.stroke();
            ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + Math.sin(ang) * rad, cy - Math.cos(ang) * rad); ctx.stroke();
            /* Лента из 60 клеток: горит клетка n % 60 — пропуски видны глазом. */
            const cw = width / 64;
            for (let i = 0; i < 60; i++) {
                ctx.fillStyle = i === n % 60 ? "#e6e6e8" : "#16161a";
                ctx.fillRect(cw * 2 + i * cw, height * 0.88, cw * 0.8, height * 0.06);
            }
            ctx.fillStyle = "#e6e6e8";
            ctx.font = `${Math.round(height / 14)}px monospace`;
            ctx.fillText(`#${n}`, width * 0.55, height * 0.16);
            ctx.font = `${Math.round(height / 40)}px monospace`;
            ctx.fillText(`generator ${target} fps · ${new Date().toISOString().slice(11, 23)}`, width * 0.55, height * 0.22);
            drawBarcode(n & 0xFFFFF, Date.now() & TS_MASK);
            state.drawn++;
            if (state.lastDraw) state.maxGap = Math.max(state.maxGap, now - state.lastDraw);
            state.lastDraw = now;
        }

        function loop(ts) {
            if (track.readyState === "ended") { if (gen === state) gen = null; return; }
            const interval = 1000 / (overrides.fps || state.baseFps);
            if (!state.nextDue || ts - state.nextDue > interval * 4) state.nextDue = ts;
            if (ts >= state.nextDue - 1) {
                state.nextDue += interval;
                draw(ts);
            }
            /* Скрытое окно rAF не крутит — тогда таймер (браузер его тоже
               душит; это будет видно в записи gen и app). */
            if (document.hidden) setTimeout(() => loop(performance.now()), 4);
            else requestAnimationFrame(loop);
        }
        requestAnimationFrame(loop);
        write("gen-start", { width, height, fps, cell });
        return stream;
    }

    function flushGen() {
        if (!gen) return;
        write("gen", { drawn: gen.drawn, maxGapMs: round(gen.maxGap, 1), frame: gen.frame, hidden: document.hidden });
        gen.drawn = 0;
        gen.maxGap = 0;
    }

    /* ---------------- панель ---------------- */

    let panel = null;
    let flashTimer = null;

    function el(tag, cls, text) {
        const e = document.createElement(tag);
        if (cls) e.className = cls;
        if (text != null) e.textContent = text;
        return e;
    }

    function buildPanel() {
        panel = el("div", "lab-panel");
        panel.id = "voidLab";
        const head = el("div", "lab-head");
        head.append(el("span", "lab-title", "журнал демки"));
        const close = el("button", "lab-x", "×");
        close.type = "button";
        close.setAttribute("aria-label", "закрыть");
        close.addEventListener("click", () => togglePanel(false));
        head.append(close);
        panel.append(head);
        panel.append(el("div", "lab-body"));
        makeDraggable(panel, head);
        document.body.append(panel);
    }

    function makeDraggable(box, handle) {
        handle.addEventListener("pointerdown", (e) => {
            if (e.target.closest("button")) return;
            const r = box.getBoundingClientRect();
            const dx = e.clientX - r.left, dy = e.clientY - r.top;
            handle.setPointerCapture(e.pointerId);
            const move = (ev) => {
                box.style.left = Math.max(0, Math.min(window.innerWidth - r.width, ev.clientX - dx)) + "px";
                box.style.top = Math.max(0, Math.min(window.innerHeight - 40, ev.clientY - dy)) + "px";
                box.style.right = "auto";
            };
            const up = () => {
                handle.removeEventListener("pointermove", move);
                handle.removeEventListener("pointerup", up);
            };
            handle.addEventListener("pointermove", move);
            handle.addEventListener("pointerup", up);
        });
    }

    function renderPanel() {
        if (!panel) return;
        const body = panel.querySelector(".lab-body");
        body.textContent = "";
        panel.querySelector(".lab-x").disabled = !!rec;

        const recRow = el("div", "lab-row lab-rec");
        const recBtn = el("button", "lab-btn" + (rec ? " is-on" : ""), rec ? "стоп и сохранить" : "старт записи");
        recBtn.type = "button";
        recBtn.addEventListener("click", () => { rec ? stop() : start(); });
        recRow.append(recBtn);
        const markBtn = el("button", "lab-btn", "метка");
        markBtn.type = "button";
        markBtn.disabled = !rec;
        markBtn.title = MARK_ACCEL.toLowerCase();
        markBtn.addEventListener("click", mark);
        recRow.append(markBtn);
        recRow.append(el("span", "lab-meta lab-timer"));
        body.append(recRow);

        if (pendingSave && !rec) {
            const ps = el("div", "lab-row lab-pending");
            ps.append(el("span", "lab-meta", "журнал не сохранён"));
            const again = el("button", "lab-btn", "сохранить");
            again.type = "button";
            again.addEventListener("click", savePending);
            const drop = el("button", "lab-btn", "выбросить");
            drop.type = "button";
            drop.addEventListener("click", () => { pendingSave = null; renderPanel(); });
            ps.append(again, drop);
            body.append(ps);
        }

        for (const t of TOGGLES) {
            const row = el("div", "lab-row");
            row.append(el("span", "lab-label", t.label + (t.nextDemo ? " *" : "")));
            const seg = el("div", "lab-seg");
            const cur = t.key === "codec" ? (window.VoidCodec?.get?.() || "h264") : overrides[t.key];
            for (const [v, label] of t.opts) {
                const b = el("button", "lab-seg-btn" + (v === cur ? " is-active" : ""), label);
                b.type = "button";
                b.addEventListener("click", () => setToggle(t.key, v));
                seg.append(b);
            }
            row.append(seg);
            body.append(row);
        }
        body.append(el("div", "lab-note", "* — при следующем запуске демки. метка: " + MARK_ACCEL.toLowerCase()));
        body.append(el("div", "lab-status"));
        body.append(el("div", "lab-flash"));
        renderStatus();
    }

    function renderStatus() {
        if (!panel) return;
        const timer = panel.querySelector(".lab-timer");
        if (timer) {
            if (rec) {
                const s = Math.floor((Date.now() - rec.startedAt) / 1000);
                timer.textContent = `● ${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")} · ${rec.lines.length}`;
            } else timer.textContent = "";
        }
        const st = panel.querySelector(".lab-status");
        if (!st) return;
        const sharing = !!(typeof screenStream !== "undefined" && screenStream?.active);
        const lines = [];
        lines.push(`демка: ${sharing ? "показываю" : (typeof roomScreencasterId !== "undefined" && roomScreencasterId) ? "смотрю" : "нет"} · пиров: ${peersMap().size}`);
        if (rec) {
            for (const line of rec.lines.slice(-40).reverse()) {
                if (!line.includes('"k":"sum"')) continue;
                try {
                    const s = JSON.parse(line);
                    const o = s.out, i = s.in;
                    let txt = `${s.nick || s.uid}: ${s.conn}${s.rttMs != null ? " " + s.rttMs + "ms" : ""}`;
                    if (o) txt += ` · out ${o.res}@${o.encFps ?? "?"} ${o.kbps}к ${o.qLim || ""}`;
                    if (i) txt += ` · in ${i.res}@${i.decFps ?? "?"}`;
                    lines.push(txt);
                } catch (_) {}
                break;
            }
            for (const line of rec.lines.slice(-20).reverse()) {
                if (!line.includes('"k":"render"')) continue;
                try {
                    const r = JSON.parse(line);
                    if (r.active) lines.push(`отрисовка: ${r.fps} кадр/с${r.gen ? ` · генератор: пропуск ${r.gen.skipped}${r.gen.latencyMs ? ` · задержка ${r.gen.latencyMs.avg}ms` : ""}` : ""}`);
                } catch (_) {}
                break;
            }
        }
        st.textContent = lines.join("\n");
    }

    function flash(text) {
        const f = panel?.querySelector(".lab-flash");
        if (!f) return;
        f.textContent = text;
        clearTimeout(flashTimer);
        flashTimer = setTimeout(() => { f.textContent = ""; }, 2500);
    }

    function togglePanel(force) {
        const show = force != null ? force : !panel || panel.hidden;
        if (!show && rec) return;
        if (!panel) buildPanel();
        panel.hidden = !show;
        if (show) renderPanel();
    }

    /* Web: метка с клавиатуры, пока вкладка в фокусе. На desktop это делает
       глобальный хоткей (lib.rs → void:hotkey-pressed → app-settings.js). */
    document.addEventListener("keydown", (e) => {
        if (!rec || isDesktop()) return;
        if (e.ctrlKey && e.shiftKey && e.code === "KeyL") {
            e.preventDefault();
            mark();
        }
    });

    window.VoidScreenLab = {
        overrides, event, onPeerMessage, createGenerator, mark, togglePanel,
        isRecording: () => !!rec
    };
})();
