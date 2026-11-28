/* ========= CAMERA (media) — tasks/camera-plan.md §1-4 =========

   window.VoidCam: захват своей камеры, отправка всем пирам, приём чужих,
   спрос зрителя → ступень качества у отправителя. Картинку рисует
   js/cam-stage.js (window.VoidCamStage), здесь только медиа и сигналинг.

   Инварианты:
   - Один camStream на вкладку (id стабилен = sid в camera-state): по нему
     получатель отличает камеру от демки в ontrack (оба — video).
   - Вкл/выкл НЕ ренеготиирует: выкл = replaceTrack(null) + track.stop()
     (гаснет диод), вкл = новый getUserMedia + replaceTrack. Первый раз на
     пира — addTrack (обычная ренеготиация, perfect negotiation уже есть).
     removeTrack как у демки не берём: частые вкл/выкл копили бы m-line'ы.
   - Камеру шлём только пирам с caps "cam": старый клиент считает ЛЮБОЕ
     входящее видео демкой.
   - Ступень (разрешение/fps/битрейт) — своя на каждую пару: в mesh у
     каждого пира свой энкодер. Зритель сообщает размер своей плитки по
     DataChannel `{type:"cam", h}`; не видно плитку → h=0 → active=false.
   - Все setParameters одного sender'а — одной очередью (параллельные
     конфликтуют, урок демки). */
(function () {
    "use strict";

    /* Лестница §1. h — высота кадра у зрителя; L0 = не кодировать вовсе. */
    const TIERS = [
        { id: "L0", h: 0, fps: 0, bps: 0 },
        { id: "L1", h: 180, fps: 15, bps: 150_000 },
        { id: "L2", h: 360, fps: 30, bps: 500_000 },
        { id: "L3", h: 540, fps: 30, bps: 900_000 },
        { id: "L4", h: 720, fps: 30, bps: 1_600_000 },
    ];
    const DEFAULT_TIER = 2;               // пока зритель не прислал размер
    const PHONE_MAX_TIER = 3;             // телефон греется и садит батарею…
    const PHONE_FULL_VIEWERS = 2;         // …но 1-2 энкодера 720p он тянет
    const CAM_UPLOAD_BUDGET = 4_000_000;  // на ВСЕ отправки камеры
    const CAM_RELAY_MAX = 1_000_000;      // relay-пара, на зрителя
    const PARK_MS = 2000;                 // трек обогнал camera-state
    const DEMAND_DOWN_MS = 300;
    const DEMAND_UP_MS = 1000;

    const CONSTRAINTS = {
        width: { ideal: 1280 }, height: { ideal: 720 },
        frameRate: { ideal: 30, max: 30 }, aspectRatio: { ideal: 16 / 9 },
        facingMode: "user"
    };

    let camStream = null;      // MediaStream, живёт всю жизнь вкладки
    let camTrack = null;
    let camOn = false;
    let camStarting = false;
    let facing = "user";       // телефон: фронталка / тыл (кнопка на своей плитке)
    let multiCam = false;      // камер больше одной → есть что переключать

    /** userId → { caps:Set, cam:bool, sid:string|null } — из user-list /
     *  new-participant / camera-state. */
    const peerInfo = new Map();
    /** userId → RTCRtpSender нашей камеры в peer'е с ним. */
    const camSenders = new Map();
    /** userId → индекс ступени, которую этот зритель просит у нас. */
    const demand = new Map();
    /** userId → { stream, track } — принятая камера соседа. */
    const remote = new Map();
    /** userId → [{ peer, event, timer }] — треки, обогнавшие camera-state. */
    const parked = new Map();
    /** Зритель: что мы просим у каждого отправителя. */
    const want = new Map();    // userId → { sent, pending, timer }

    const isTouch = () => window.matchMedia("(hover: none) and (pointer: coarse)").matches;
    const tr = (k, p) => (typeof _t === "function" ? _t(k, p) : (window.VoidI18n?.t?.(k, p) || k));
    const validSid = (s) => typeof s === "string" && /^[A-Za-z0-9{}_-]{1,64}$/.test(s);

    function stream() {
        if (!camStream) camStream = new MediaStream();
        return camStream;
    }

    function supports(userId) {
        return !!peerInfo.get(userId)?.caps?.has("cam");
    }

    function info(userId) {
        let i = peerInfo.get(userId);
        if (!i) { i = { caps: new Set(), cam: false, sid: null }; peerInfo.set(userId, i); }
        return i;
    }

    /* ---------- захват ---------- */

    /* Desktop (WebView2): камера разрешается Rust'ом только в коротком окне
       после этой команды (lib.rs arm_camera) — вне нажатия кнопки её не
       откроет никакой скрипт. На маке/web — no-op. */
    async function armDesktop() {
        const invoke = window.__TAURI__?.core?.invoke;
        if (window.VoidPlatform !== "desktop" || typeof invoke !== "function") return;
        try { await invoke("arm_camera"); } catch (err) {
            log.warn("cam", "arm_camera failed", { err: err?.message || String(err) });
        }
    }

    async function acquire() {
        if (!navigator.mediaDevices?.getUserMedia) {
            const e = new Error("no getUserMedia"); e.name = "NotSupportedError"; throw e;
        }
        await armDesktop();
        const id = window.VoidSettings?.getVideoInId?.() || "";
        const video = id ? { ...CONSTRAINTS, deviceId: { exact: id } } : { ...CONSTRAINTS };
        try {
            return await navigator.mediaDevices.getUserMedia({ audio: false, video });
        } catch (err) {
            /* Сохранённой камеры больше нет — берём любую. */
            if (id && (err?.name === "OverconstrainedError" || err?.name === "NotFoundError")) {
                return await navigator.mediaDevices.getUserMedia({ audio: false, video: { ...CONSTRAINTS } });
            }
            throw err;
        }
    }

    function errorToast(err) {
        const name = err?.name || "";
        const mac = window.VoidIsMac && window.VoidPlatform === "desktop";
        const key = name === "NotAllowedError" || name === "SecurityError"
            ? (mac ? "errors.camera.denied.mac" : "errors.camera.denied")
            : name === "NotFoundError" || name === "OverconstrainedError" ? "errors.camera.notfound"
            : name === "NotReadableError" || name === "AbortError" ? "errors.camera.busy"
            : "errors.camera.failed";
        if (typeof showRoomToast === "function") showRoomToast(tr(key));
        else window.VoidToast?.showToast?.(tr(key), { priority: "warn" });
    }

    async function start() {
        if (camOn || camStarting) return camOn;
        if (typeof isJoined !== "undefined" && !isJoined) return false;
        camStarting = true;
        facing = "user";
        syncButton();
        /* Плитка с лоадером — сразу: камера просыпается до секунды, без неё
           сцена уже перестроилась, а на месте кадра пусто. */
        window.VoidCamStage?.setLocalPending(true);
        /* Камеру будим ПОСЛЕ перехода сцены: на маке её старт вешает главный
           поток ~1 с, и переход посреди этого дёргался бы. Плитка с лоадером
           уже стоит, лишние 0.3 с не видны. */
        const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
        await new Promise(r => setTimeout(r, reduce ? 0 : MOTION.med + 40));
        let track = null;
        try {
            const s = await acquire();
            track = s.getVideoTracks()[0] || null;
            s.getTracks().forEach(t => { if (t !== track) t.stop(); });
            if (!track) throw Object.assign(new Error("no video track"), { name: "NotFoundError" });
        } catch (err) {
            log.warn("cam", "camera start failed", { err: err?.name || String(err) });
            camStarting = false;
            syncButton();
            window.VoidCamStage?.setLocalPending(false);
            errorToast(err);
            return false;
        }
        camStarting = false;
        /* Вышли из комнаты, пока ОС спрашивала разрешение. */
        if (typeof isJoined !== "undefined" && !isJoined) {
            track.stop();
            syncButton();
            window.VoidCamStage?.setLocalPending(false);
            return false;
        }
        try { track.contentHint = "motion"; } catch (_) {}
        setTrack(track);
        camOn = true;
        for (const [uid, peer] of peers) attachPeer(uid, peer);
        broadcast();
        syncButton();
        window.VoidCamStage?.setLocal(stream());
        log.info("cam", "camera on", { settings: track.getSettings?.() || null });
        countCams();
        return true;
    }

    /* Кнопка смены камеры (только тач) есть, если камер больше одной. Список
       устройств с метками доступен только после разрешения — считаем после
       старта. */
    function countCams() {
        if (!isTouch() || !navigator.mediaDevices?.enumerateDevices) { multiCam = false; return; }
        navigator.mediaDevices.enumerateDevices().then(list => {
            multiCam = list.filter(d => d.kind === "videoinput").length > 1;
            window.VoidCamStage?.syncSelf();
        }).catch(() => {});
    }

    /* Телефон: фронталка ↔ тыл. Старый трек гасим ДО запроса: iOS не держит
       две камеры разом (вторая открылась бы немой). Не вышло — возвращаем
       прежнюю, не вышло и это — камера выключается. */
    async function flip() {
        if (!camOn || camStarting) return;
        camStarting = true;
        syncButton();
        const next = facing === "user" ? "environment" : "user";
        if (camTrack) { camTrack.onended = null; camTrack.stop(); }
        const open = async (mode) => {
            try {
                return await navigator.mediaDevices.getUserMedia({ audio: false, video: { ...CONSTRAINTS, facingMode: { exact: mode } } });
            } catch (err) {
                if (err?.name !== "OverconstrainedError") throw err;
                return await navigator.mediaDevices.getUserMedia({ audio: false, video: { ...CONSTRAINTS, facingMode: mode } });
            }
        };
        let track = null;
        try {
            track = (await open(next)).getVideoTracks()[0] || null;
            if (track) facing = track.getSettings?.().facingMode || next;
        } catch (err) {
            log.warn("cam", "camera flip failed", { err: err?.name || String(err) });
            errorToast(err);
            try { track = (await open(facing)).getVideoTracks()[0] || null; } catch (_) { track = null; }
        }
        camStarting = false;
        if (!camOn) { track?.stop(); syncButton(); return; }
        if (!track) { stop(); return; }
        try { track.contentHint = "motion"; } catch (_) {}
        setTrack(track);
        for (const [uid, sender] of camSenders) {
            enqueue(sender, () => sender.replaceTrack(track));
            applyParams(uid);
        }
        syncButton();
        window.VoidCamStage?.setLocal(stream());
        window.VoidCamStage?.syncSelf();
    }

    function setTrack(track) {
        const s = stream();
        for (const t of s.getVideoTracks()) { if (t !== track) s.removeTrack(t); }
        if (track && !s.getVideoTracks().includes(track)) s.addTrack(track);
        if (camTrack && camTrack !== track) {
            camTrack.onended = null;
            camTrack.stop();
        }
        camTrack = track;
        if (track) {
            /* Камеру забрали снаружи (выдернули USB, ОС отозвала доступ). */
            track.onended = () => {
                if (camTrack !== track) return;
                log.warn("cam", "camera track ended");
                stop();
                if (typeof showRoomToast === "function") showRoomToast(tr("errors.camera.lost"));
            };
        }
    }

    function stop({ silent = false } = {}) {
        if (!camOn && !camTrack) return;
        camOn = false;
        for (const s of camSenders.values()) enqueue(s, () => s.replaceTrack(null));
        setTrack(null);
        if (!silent) broadcast();
        syncButton();
        window.VoidCamStage?.setLocal(null);
        facing = "user";
        log.info("cam", "camera off");
    }

    function toggle() {
        if (camOn) stop();
        else start();
    }

    /* Сменили устройство в настройках посреди звонка — подменяем трек на
       лету, без ренеготиации. */
    async function switchDevice() {
        if (!camOn || camStarting) return;
        camStarting = true;
        try {
            const s = await acquire();
            const track = s.getVideoTracks()[0];
            if (!track || !camOn) { s.getTracks().forEach(t => t.stop()); return; }
            try { track.contentHint = "motion"; } catch (_) {}
            setTrack(track);
            facing = "user";
            for (const [uid, sender] of camSenders) {
                enqueue(sender, () => sender.replaceTrack(track));
                applyParams(uid);
            }
            window.VoidCamStage?.setLocal(stream());
            window.VoidCamStage?.syncSelf();
        } catch (err) {
            errorToast(err);
        } finally {
            camStarting = false;
        }
    }

    function broadcast() {
        if (typeof sendSocket !== "function") return;
        sendSocket(camOn
            ? { type: "camera-state", cam: true, sid: stream().id }
            : { type: "camera-state", cam: false });
    }

    function syncButton() {
        const btn = document.getElementById("camBtn");
        if (!btn) return;
        btn.classList.toggle("active", camOn);
        btn.classList.toggle("is-busy", camStarting);
        btn.setAttribute("aria-pressed", camOn ? "true" : "false");
        btn.setAttribute("aria-label", tr(camOn ? "controls.camera.off" : "controls.camera.on"));
    }

    /* ---------- отправка ---------- */

    function enqueue(sender, job) {
        const run = () => Promise.resolve().then(job).catch(err =>
            log.debug("cam", "sender job failed", { err: err?.message || String(err) }));
        sender._camQ = (sender._camQ || Promise.resolve()).then(run, run);
        return sender._camQ;
    }

    /* H.264 (аппаратный почти везде) → VP8 → остальное. VP9 софтовый, а
       энкодеров камеры при mesh до 9 разом. */
    function preferCamCodecs(peer, sender) {
        if (typeof RTCRtpSender === "undefined" || !RTCRtpSender.getCapabilities) return;
        const t = peer.getTransceivers().find(x => x.sender === sender);
        if (!t || typeof t.setCodecPreferences !== "function") return;
        const caps = RTCRtpSender.getCapabilities("video");
        if (!caps?.codecs) return;
        const h264 = c => /H264/i.test(c.mimeType), vp8 = c => /VP8/i.test(c.mimeType);
        try {
            t.setCodecPreferences([
                ...caps.codecs.filter(h264), ...caps.codecs.filter(vp8),
                ...caps.codecs.filter(c => !h264(c) && !vp8(c))
            ]);
        } catch (err) {
            log.debug("cam", "setCodecPreferences failed", { err: err?.message || String(err) });
        }
    }

    function attachPeer(userId, peer) {
        if (!camOn || !camTrack || !peer || !supports(userId)) return;
        if (peer.connectionState === "closed") return;
        let sender = camSenders.get(userId);
        if (sender && peer.getSenders().includes(sender)) {
            if (sender.track !== camTrack) enqueue(sender, () => sender.replaceTrack(camTrack));
            applyParams(userId);
            return;
        }
        try {
            sender = peer.addTrack(camTrack, stream());
        } catch (err) {
            log.warn("cam", "addTrack failed", { userId, err: err?.message || String(err) });
            return;
        }
        sender._cam = true;
        camSenders.set(userId, sender);
        preferCamCodecs(peer, sender);
        applyParams(userId);
        reapplyAll();   // зрителей стало больше → бюджет на каждого меньше
    }

    function activeViewers() {
        let n = 0;
        for (const uid of camSenders.keys()) if ((demand.get(uid) ?? DEFAULT_TIER) > 0) n++;
        return Math.max(1, n);
    }

    /* Телефон режем до L3 только при 3+ зрителях: с одним-двумя кап 540p
       давал заметное мыло на большой плитке десктопа, а аппаратный H.264
       тянет 720p без перегрева. */
    function tierIndexFor(userId) {
        let ti = demand.get(userId) ?? DEFAULT_TIER;
        if (isTouch() && activeViewers() > PHONE_FULL_VIEWERS) ti = Math.min(ti, PHONE_MAX_TIER);
        return ti;
    }

    function paramsFor(userId, sender) {
        const ti = tierIndexFor(userId);
        const tier = TIERS[ti];
        if (!ti) return { active: false, tier };
        let budget = CAM_UPLOAD_BUDGET;
        /* Демка идёт одновременно — аплоад у людей не резиновый, голос важнее. */
        if (typeof screenStream !== "undefined" && screenStream?.active) budget /= 2;
        let bps = Math.min(tier.bps, Math.round(budget / activeViewers()));
        if (peers.get(userId)?._isRelay) bps = Math.min(bps, CAM_RELAY_MAX);
        /* Ступень = КОРОТКАЯ сторона кадра (зритель просит ровно её, см.
           cam-stage renderedShort): портретный кадр телефона 720×1280 на L4
           уходит целиком, а не ужатым до 405×720. */
        const st = sender.track?.getSettings?.() || {};
        const srcShort = Math.min(st.width || 1280, st.height || 720);
        const scale = Math.max(1, Math.round((srcShort / tier.h) * 1000) / 1000);
        return { active: true, tier, bps, scale, fps: tier.fps };
    }

    function applyParams(userId) {
        const sender = camSenders.get(userId);
        if (!sender) return;
        enqueue(sender, async () => {
            if (!sender.track) return;
            const p = paramsFor(userId, sender);
            const set = async (withScale) => {
                const params = sender.getParameters();
                if (!params.encodings || !params.encodings.length) params.encodings = [{}];
                const enc = params.encodings[0];
                enc.active = p.active;
                if (p.active) {
                    enc.maxBitrate = p.bps;
                    enc.maxFramerate = p.fps;
                    if (withScale) enc.scaleResolutionDownBy = p.scale;
                }
                await sender.setParameters(params);
            };
            try {
                await set(true);
            } catch (_) {
                await set(false);
            }
            sender._camTier = p.tier.id;
        });
    }

    function reapply(userId) {
        if (userId != null) applyParams(userId);
    }

    function reapplyAll() {
        for (const uid of camSenders.keys()) applyParams(uid);
    }

    /* Зритель прислал, какую высоту ему нужно (DataChannel {type:"cam"}). */
    /* Камера выключена — спрос всё равно запоминаем: пригодится на включении.
       Честный зритель шлёт пару сообщений в секунду максимум (вниз — дебаунс
       300 мс, вверх — секунда); всё сверх 10/с — флуд, каждое стоило бы нам
       setParameters. */
    const demandRate = new Map();   // userId → { at, n }
    function onPeerMessage(json, userId) {
        const now = Date.now();
        let r = demandRate.get(userId);
        if (!r || now - r.at >= 1000) { r = { at: now, n: 0 }; demandRate.set(userId, r); }
        if (++r.n > 10) return;
        const h = Number(json?.h);
        if (!Number.isFinite(h) || h < 0 || h > 4320) return;
        let ti = 0;
        if (h > 0) {
            ti = TIERS.findIndex(t => t.h >= Math.min(h, 720));
            if (ti < 1) ti = TIERS.length - 1;
        }
        const prev = demand.get(userId) ?? DEFAULT_TIER;
        demand.set(userId, ti);
        if (prev === ti) return;
        /* Ушёл/пришёл активный зритель → бюджет делится по-другому. */
        if ((prev > 0) !== (ti > 0)) reapplyAll();
        else applyParams(userId);
    }

    /* ---------- приём ---------- */

    function routeTrack(peer, userId, event) {
        const sid = event.streams?.[0]?.id || null;
        const i = peerInfo.get(userId);
        if (sid && i?.sid === sid) { adopt(peer, userId, event); return true; }
        /* Старый клиент камеру не шлёт: всё его видео — демка. */
        if (!i?.caps?.has("cam")) return false;
        /* Sid камеры уже известен и не совпал — это демка. */
        if (i.sid) return false;
        /* Человек показывает экран, а камеру ещё ни разу не включал — демка. */
        if (typeof roomScreencasterId !== "undefined" && roomScreencasterId === userId) return false;
        /* Трек обогнал camera-state / screencast-state: ждём, кем он окажется. */
        const list = parked.get(userId) || [];
        const entry = { peer, event, timer: 0 };
        entry.timer = setTimeout(() => release(userId, entry, "timeout"), PARK_MS);
        list.push(entry);
        parked.set(userId, list);
        log.debug("cam", "video track parked", { userId });
        return true;
    }

    /* Припаркованный трек оказался не камерой → в путь демки. */
    function release(userId, entry, why) {
        const list = parked.get(userId);
        if (!list) return;
        const i = list.indexOf(entry);
        if (i < 0) return;
        list.splice(i, 1);
        if (!list.length) parked.delete(userId);
        clearTimeout(entry.timer);
        if (peers.get(userId) !== entry.peer) return;   // peer уже пересобран
        log.debug("cam", "parked track → screen", { userId, why });
        handleScreenVideoTrack(entry.peer, userId, entry.event);
    }

    function resolveParked(userId) {
        const list = parked.get(userId);
        if (!list) return;
        const i = peerInfo.get(userId);
        if (!i?.sid) return;
        for (const entry of [...list]) {
            const sid = entry.event.streams?.[0]?.id;
            /* Sid камеры теперь известен: совпал — камера, нет — демка. */
            if (sid !== i.sid) { release(userId, entry, "not-camera"); continue; }
            list.splice(list.indexOf(entry), 1);
            clearTimeout(entry.timer);
            if (peers.get(userId) === entry.peer) adopt(entry.peer, userId, entry.event);
        }
        if (!list.length) parked.delete(userId);
    }

    function adopt(peer, userId, event) {
        const s = event.streams[0];
        const track = event.track;
        remote.set(userId, { stream: s, track });
        track.addEventListener("ended", () => {
            if (remote.get(userId)?.track !== track) return;
            remote.delete(userId);
            window.VoidCamStage?.setRemoteStream(userId, null);
        });
        log.debug("cam", "camera track", { userId });
        window.VoidCamStage?.setRemoteStream(userId, s);
        /* Новый трек → энкодер на той стороне ничего про нас не знает: просим
           заново, что видим (DC мог не переоткрываться). */
        const w = want.get(userId);
        if (w) w.sent = undefined;
        window.VoidCamStage?.refreshDemand();
    }

    /* ---------- спрос зрителя (мы смотрим чужую камеру) ---------- */

    /* cssH — высота плитки в CSS px (0 = не видно). Вниз — быстро, вверх —
       только после стабильной секунды (ресайз/перетаскивание не дёргают
       энкодер собеседника); `now` — сразу (вкладку вернули из фона). */
    function setWant(userId, cssH, now = false) {
        const h = cssH > 0 ? Math.min(720, Math.round(cssH * (window.devicePixelRatio || 1))) : 0;
        let ti = 0;
        if (h > 0) { ti = TIERS.findIndex(t => t.h >= h); if (ti < 1) ti = TIERS.length - 1; }
        let w = want.get(userId);
        if (!w) { w = { sent: undefined, pending: undefined, timer: 0 }; want.set(userId, w); }
        if (w.pending === ti && w.timer) return;
        clearTimeout(w.timer);
        w.timer = 0;
        w.pending = ti;
        if (w.sent === ti) return;
        const up = w.sent === undefined || ti > w.sent;
        const delay = now || w.sent === undefined ? 0 : (up ? DEMAND_UP_MS : DEMAND_DOWN_MS);
        const fire = () => { w.timer = 0; sendWant(userId); };
        if (delay) w.timer = setTimeout(fire, delay);
        else fire();
    }

    function sendWant(userId) {
        const w = want.get(userId);
        if (!w || w.pending === undefined) return;
        const ch = typeof chatChannels !== "undefined" ? chatChannels.get(userId) : null;
        if (!ch || ch.readyState !== "open") return;   // onChannelOpen дошлёт
        const tier = TIERS[w.pending];
        try {
            ch.send(JSON.stringify({ type: "cam", h: tier.h, fps: tier.fps }));
            w.sent = w.pending;
        } catch (_) { /* канал закрывается — дошлём на open */ }
    }

    function onChannelOpen(userId) {
        const w = want.get(userId);
        if (w) { w.sent = undefined; sendWant(userId); }
    }

    /* ---------- состояние соседей ---------- */

    /* Из user-list / new-participant: caps + текущая камера. */
    function onPeerInfo(userId, data) {
        if (!userId || userId === clientId) return;
        const i = info(userId);
        const caps = Array.isArray(data?.caps) ? data.caps : [];
        i.caps = new Set(caps.filter(c => typeof c === "string"));
        if (validSid(data?.camSid)) i.sid = data.camSid;
        if (camOn && supports(userId) && peers.has(userId)) attachPeer(userId, peers.get(userId));
        onPeerState(userId, !!data?.cam, data?.camSid);
    }

    function onPeerState(userId, cam, sid) {
        if (!userId || userId === clientId) return;
        const i = info(userId);
        if (validSid(sid)) i.sid = sid;
        i.cam = !!cam;
        resolveParked(userId);
        window.VoidCamStage?.setPeerCam(userId, i.cam);
    }

    /* Сосед начал показывать экран — его припаркованные треки и есть демка. */
    function onScreencastState(userId, on) {
        if (!on) return;
        const list = parked.get(userId);
        if (list) for (const e of [...list]) release(userId, e, "screencast-state");
    }

    /* Peer закрыт (уход, пересборка): сендер и принятый трек — в прошлое,
       знание о соседе (caps/sid/cam) живёт до participant-left. */
    function detachPeer(userId) {
        camSenders.delete(userId);
        demand.delete(userId);
        const list = parked.get(userId);
        if (list) { list.forEach(e => clearTimeout(e.timer)); parked.delete(userId); }
        if (remote.delete(userId)) window.VoidCamStage?.setRemoteStream(userId, null);
        const w = want.get(userId);
        if (w) { clearTimeout(w.timer); w.sent = undefined; w.timer = 0; }
        reapplyAll();
    }

    function forget(userId) {
        detachPeer(userId);
        peerInfo.delete(userId);
        want.delete(userId);
        window.VoidCamStage?.setPeerCam(userId, false);
    }

    /* После реконнекта сигналинга сервер мог потерять наше состояние. */
    function reannounce() {
        if (camOn) broadcast();
    }

    /* Выход из комнаты: всё в ноль (сокет уже закрыт — ничего не шлём). */
    function reset() {
        stop({ silent: true });
        camStarting = false;
        for (const list of parked.values()) list.forEach(e => clearTimeout(e.timer));
        for (const w of want.values()) clearTimeout(w.timer);
        parked.clear(); peerInfo.clear(); camSenders.clear(); demand.clear(); demandRate.clear();
        remote.clear(); want.clear();
        syncButton();
        window.VoidCamStage?.reset();
    }

    document.addEventListener("void:video-in-device-changed", () => { switchDevice(); });
    document.addEventListener("void:locale-changed", syncButton);

    window.VoidCam = {
        start, stop, toggle, flip, reset, reannounce,
        attachPeer, detachPeer, forget, reapply, reapplyAll,
        routeTrack, onPeerInfo, onPeerState, onScreencastState, onPeerMessage, onChannelOpen,
        setWant,
        isOn: () => camOn,
        isStarting: () => camStarting,
        facing: () => facing,
        canFlip: () => camOn && multiCam,
        localStream: () => (camOn ? stream() : null),
        localTrack: () => camTrack,
        remoteStream: (uid) => remote.get(uid)?.stream || null,
        remoteTrack: (uid) => remote.get(uid)?.track || null,
        peerHasCam: (uid) => !!peerInfo.get(uid)?.cam,
        peerSupports: supports,
        senderFor: (uid) => camSenders.get(uid) || null,
        /* dev: ступень, которую мы шлём этому зрителю. */
        tierInfo: (uid) => {
            const s = camSenders.get(uid);
            if (!s) return null;
            const t = TIERS[tierIndexFor(uid)];
            return { id: s._camTier || t.id, wanted: t.id, viewers: activeViewers() };
        },
        TIERS
    };
})();

/* Кнопка и хоткей зовут по имени, как toggleMic/toggleSound. */
function toggleCamera() {
    if (typeof isJoined !== "undefined" && !isJoined) return;
    window.VoidCam?.toggle();
}
