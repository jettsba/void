/* ========= CAMERA STAGE (UI) — tasks/camera-plan.md §5 =========

   Перенос лабы public/lab/cameras.html в прод. Медиа — js/camera.js
   (window.VoidCam), геометрия — js/cam-grid.js (window.VoidCamGrid).

   Два состояния сцены:
   - голос (камер нет) — корона блобов (participants.js layoutCorona);
   - камеры (≥1, включая свою) — сетка плиток, под ней ряд блобов ТЕХ, КТО
     СМОТРИТ (без камеры; свой — по центру), контролы опускаются к футеру и
     встают в одну строку. Камера у всех → ряда нет.
   Заход — одновременно: блоб схлопывается, панель опускается, плитка
   проявляется (своя — сразу с лоадером, до кадра); обратно — плитки гаснут
   → корона. Перестройка сетки — перетекание (снимок кадра
   гаснет на старом месте, плитка проявляется на новом), чистый фейд.

   participants.js отдаёт сюда каждую раскладку (layoutParticipants →
   VoidCamStage.layout): блобы двигает тот, кто владеет сценой. */
(function () {
    "use strict";

    const RISE = "0.57rem";
    const STRIP_GAP = 1.86, STRIP_GAP_FOCUS = 2.0;   // rem: воздух вокруг ряда блобов
    const BLOB_REM = 3.8, GAP_REM = 0.45;
    const CTL_IDLE = 8000;

    const S = {
        order: [],              // порядок плиток (локальный, перетаскиванием)
        focus: null,            // userId в фокусе
        ctl: null,              // плитка в режиме управления (громкость + фокус)
        local: null,            // свой MediaStream камеры
        localPending: false,    // кнопку нажали, камера ещё просыпается
        peerCam: new Set(),     // соседи с включённой камерой
        streams: new Map(),     // userId → MediaStream камеры соседа
    };
    const tiles = new Map();    // userId → { el, video, rect }
    const hiddenBlobs = new Set();
    let stageMode = "voice";    // voice | entering | cams | leaving
    let modeTimer = 0;
    let motionTimer = 0;
    let stageEl, panelArea, controlsEl, camStage, appEl;
    let dragState = null;
    let ctlTimer = 0;

    const isPhone = () => window.matchMedia("(hover: none), (pointer: coarse), (max-width: 640px)").matches;
    const isMobileChat = () => document.body.classList.contains("chat-open")
        && window.matchMedia("(max-width: 740px)").matches;
    const rem = () => parseFloat(getComputedStyle(document.documentElement).fontSize) || 14;
    const reduceMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const dur = () => reduceMotion() ? 1 : MOTION.med;
    const tr = (k) => (typeof _t === "function" ? _t(k) : k);
    const selfId = () => (typeof clientId !== "undefined" ? clientId : null);

    function nickOf(id) {
        const raw = (typeof nicknameMap !== "undefined" && nicknameMap.get(id)) || "";
        const label = typeof participantLabel === "function" ? participantLabel(id, raw) : raw;
        return typeof displayNick === "function" ? displayNick(label) : label;
    }

    function init() {
        stageEl = document.querySelector(".stage");
        panelArea = document.querySelector(".panel-area");
        controlsEl = document.getElementById("controls");
        appEl = document.getElementById("app") || document.querySelector(".app");
        if (!stageEl || !appEl) return;
        camStage = document.createElement("div");
        camStage.className = "cam-stage";
        camStage.id = "camStage";
        appEl.appendChild(camStage);

        window.addEventListener("resize", relayout);
        new ResizeObserver(relayout).observe(stageEl);
        /* Паддинг сцены анимируется --t-med при открытии чата — догоняем. */
        stageEl.addEventListener("transitionend", e => { if (e.propertyName === "padding-right") relayout(); });
        document.addEventListener("visibilitychange", () => refreshDemand(true));
        window.addEventListener("void:participants-changed", onParticipantsChanged);
        document.addEventListener("void:locale-changed", () => { for (const [id, t] of tiles) fillNick(t, id); });
        document.addEventListener("void:devmode-changed", syncDevClass);
        syncDevClass();

        /* Статусы блоба (mute/deaf/говорит/показывает экран) — источник истины
           классы .participant; плитка их зеркалит. */
        const pc = document.getElementById("participants");
        if (pc) new MutationObserver(onBlobClasses).observe(pc, { subtree: true, attributes: true, attributeFilter: ["class"] });

        /* Клик мимо плиток закрывает режим управления. */
        document.addEventListener("pointerdown", e => {
            if (!S.ctl || e.target.closest(".cam-tile")) return;
            S.ctl = null;
            layoutAll();
        });
        /* Esc — сначала режим управления плиткой, остальное — как было. */
        window.addEventListener("keydown", e => {
            if (e.key !== "Escape" || !S.ctl) return;
            S.ctl = null;
            layoutAll();
            e.stopImmediatePropagation();
        }, true);
    }

    function syncDevClass() {
        document.body.classList.toggle("show-cam-tiers", !!window.VoidDev?.isEnabled?.());
    }

    /* ===================== списки ===================== */

    /* Своя плитка есть с нажатия кнопки: пока камера просыпается (~1 с), в ней
       лоадер, кадр проявится сам (is-live). Не дала камеру — плитка уходит. */
    const hasLocal = () => !!S.local || S.localPending;

    function camList() {
        const present = id => id === selfId() ? hasLocal() : (S.peerCam.has(id) && participantElements.has(id));
        const want = [];
        for (const id of S.order) if (present(id)) want.push(id);
        return want;
    }

    function touchOrder(id, on) {
        if (on && !S.order.includes(id)) S.order.push(id);
        if (!on) {
            S.order = S.order.filter(x => x !== id);
            if (S.focus === id) S.focus = null;
            if (S.ctl === id) S.ctl = null;
        }
        /* Свой — последним, остальные по времени включения. */
        const me = selfId();
        if (S.order.includes(me)) S.order = S.order.filter(x => x !== me).concat([me]);
    }

    /* ===================== API для camera.js ===================== */

    function setLocalPending(on) {
        S.localPending = !!on;
        touchOrder(selfId(), hasLocal());
        layoutAll();
    }

    function setLocal(stream) {
        S.local = stream || null;
        S.localPending = false;
        touchOrder(selfId(), !!stream);
        const t = tiles.get(selfId());
        if (t) attachVideo(t, S.local);
        layoutAll();
    }

    function setPeerCam(userId, on) {
        if (on) S.peerCam.add(userId); else S.peerCam.delete(userId);
        touchOrder(userId, on);
        layoutAll();
    }

    function setRemoteStream(userId, stream) {
        if (stream) S.streams.set(userId, stream); else S.streams.delete(userId);
        const t = tiles.get(userId);
        if (t) attachVideo(t, stream);
    }

    function reset() {
        clearTimeout(modeTimer);
        clearTimeout(motionTimer);
        motionTimer = 0;
        clearTimeout(ctlTimer);
        for (const t of tiles.values()) t.el.remove();
        tiles.clear();
        camStage?.querySelectorAll(".cam-tile").forEach(el => el.remove());
        S.order = []; S.focus = null; S.ctl = null; S.local = null; S.localPending = false;
        S.peerCam.clear(); S.streams.clear();
        for (const id of hiddenBlobs) {
            const el = participantElements.get(id);
            if (el) { el.style.opacity = ""; el.style.pointerEvents = ""; el._blobAnims?.forEach(a => a.cancel()); }
        }
        hiddenBlobs.clear();
        stageMode = "voice";
        appEl?.classList.remove("cams", "cam-motion");
        appEl?.style.removeProperty("--cam-panel-shift");
        participantsContainer?.style.removeProperty("--nick-w");
    }

    function onParticipantsChanged() {
        for (const id of [...hiddenBlobs]) if (!participantElements.has(id)) hiddenBlobs.delete(id);
        for (const [id, t] of tiles) fillNick(t, id);
    }

    function onBlobClasses(records) {
        const seen = new Set();
        for (const r of records) {
            const el = r.target;
            if (!el.classList?.contains("participant")) continue;
            const id = el.dataset.userId;
            if (!id || seen.has(id)) continue;
            seen.add(id);
            const t = tiles.get(id);
            if (t) syncStatus(t, id);
        }
    }

    function syncStatus(t, id) {
        const el = participantElements.get(id);
        t.el.classList.toggle("is-muted", !!el?.classList.contains("muted"));
        t.el.classList.toggle("is-deaf", !!el?.classList.contains("deaf"));
        t.el.classList.toggle("is-speaking", !!el?.classList.contains("speaking"));
        t.el.classList.toggle("is-sharing", id !== selfId() && !!el?.classList.contains("screensharing"));
        if (id === selfId()) {
            t.el.classList.toggle("is-rear", window.VoidCam?.facing?.() === "environment");
            t.el.classList.toggle("can-flip", !!window.VoidCam?.canFlip?.());
        }
    }

    /* ===================== плитки ===================== */

    const ICON_MIC = '<svg class="i-mic" viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="3" width="6" height="12" rx="3"/>' +
        '<path d="M5 11a7 7 0 0 0 14 0"/><line x1="20" y1="4" x2="4" y2="20"/></svg>';
    const ICON_VOL = '<svg class="i-vol" viewBox="0 0 24 24" aria-hidden="true"><path d="M11 5 6 9H2v6h4l5 4V5z"/>' +
        '<path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M18.5 5.5a9 9 0 0 1 0 13"/></svg>' +
        '<svg class="i-vol-off" viewBox="0 0 24 24" aria-hidden="true"><path d="M11 5 6 9H2v6h4l5 4V5z"/>' +
        '<path d="M22 9l-6 6M16 9l6 6"/></svg>';
    const ICON_FLIP = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 8h2.5l1.5-2h8l1.5 2H20v11H4z"/>' +
        '<path d="M9.2 12.2a3 3 0 0 1 5.3-1.2M14.8 14.8a3 3 0 0 1-5.3 1.2"/><path d="M14.6 9.4v1.8h-1.8M9.4 17.6v-1.8h1.8"/></svg>';
    const ICON_DEAF = '<svg class="i-deaf" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 13v-1a6 6 0 0 1 12 0v1"/>' +
        '<rect x="4.5" y="12" width="3.5" height="6.5" rx="1.75"/><rect x="16" y="12" width="3.5" height="6.5" rx="1.75"/>' +
        '<line x1="20" y1="4" x2="4" y2="20"/></svg>';

    function makeTile(id) {
        const el = document.createElement("div");
        el.className = "cam-tile";
        el.dataset.userId = id;
        /* Кадр — в своей рамке с жёстким клипом: сама плитка у миниатюры
           выпускает наружу ник и полоску громкости, а видео-слой Chromium при
           object-fit: cover (кадр 4:3 в плитке 16:9) иначе рисуется мимо
           overflow: hidden — дыра под плиткой (поймано e2e-скрином). */
        const frame = document.createElement("div");
        frame.className = "cam-frame";
        const video = document.createElement("video");
        video.autoplay = true; video.muted = true; video.playsInline = true;
        video.setAttribute("playsinline", "");
        frame.appendChild(video);
        el.appendChild(frame);
        el.insertAdjacentHTML("beforeend",
            '<span class="cam-speak" aria-hidden="true"></span>' +
            '<span class="cam-wait" aria-hidden="true"><i></i><i></i><i></i></span>' +
            '<span class="cam-up" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M12 19V5M6 11l6-6 6 6"/></svg></span>' +
            /* справа снизу, как у демки на весь экран: громкость (квадрат,
               по наведению растёт вверх слайдером) и под ней «развернуть» */
            '<span class="cam-vol"><span class="cam-vol-slider" role="slider" aria-valuemin="0" aria-valuemax="100">' +
            '<span class="cam-vol-track"><i class="cam-vol-fill"></i><i class="cam-vol-knob"></i></span></span>' +
            '<button type="button" class="cam-vol-btn">' + ICON_VOL + '</button></span>' +
            '<button type="button" class="cam-flip">' + ICON_FLIP + '</button>' +
            '<button type="button" class="cam-expand">' +
            '<svg class="i-max" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"/></svg>' +
            '<svg class="i-min" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 8h3a2 2 0 0 0 2-2V3M16 3v3a2 2 0 0 0 2 2h3M21 16h-3a2 2 0 0 0-2 2v3M8 21v-3a2 2 0 0 0-2-2H3"/></svg></button>' +
            /* миниатюра фокуса: громкость — линией с точкой над плиткой (как дуга блоба) */
            '<span class="cam-hvol" role="slider" aria-valuemin="0" aria-valuemax="100">' +
            '<span class="cam-vol-track"><i class="cam-vol-fill"></i><i class="cam-vol-knob"></i></span></span>' +
            '<button type="button" class="cam-screen"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="13" rx="2.5"/>' +
            '<path d="M10 14 L15 9"/><path d="M11 9 H15 V13"/><path d="M8 20 H16"/></svg><span></span></button>' +
            '<span class="cam-tag">' + ICON_MIC + ICON_DEAF + '<span class="cam-nick"><span></span></span></span>' +
            '<span class="cam-tier"></span>');
        if (id === selfId()) el.classList.add("is-self");
        camStage.appendChild(el);
        const t = { el, video, rect: null };
        tiles.set(id, t);
        fillNick(t, id);
        syncStatus(t, id);
        bindTile(t, id);
        video.addEventListener("loadeddata", () => el.classList.add("is-live"));
        video.addEventListener("emptied", () => el.classList.remove("is-live"));
        /* повернули телефон / сменили камеру — у кадра другие стороны */
        video.addEventListener("resize", () => refreshDemand());
        attachVideo(t, id === selfId() ? S.local : S.streams.get(id) || null);
        return t;
    }

    function attachVideo(t, stream) {
        if (t.video.srcObject === stream) return;
        t.video.srcObject = stream || null;
        if (!stream) { t.el.classList.remove("is-live"); return; }
        const p = t.video.play?.();
        if (p?.catch) p.catch(() => {});
    }

    function fillNick(t, id) {
        const self = id === selfId();
        const nick = nickOf(id) + (self ? ` (${tr("cam.you")})` : "");
        t.el.querySelector(".cam-nick > span").textContent = nick;
        t.el.querySelector(".cam-tag").classList.toggle("is-inert", self);
        t.el.querySelector(".cam-expand").setAttribute("aria-label", tr(S.focus === id ? "cam.unfocus" : "cam.focus"));
        t.el.querySelector(".cam-vol-slider").setAttribute("aria-label", tr("cam.volume"));
        t.el.querySelector(".cam-hvol").setAttribute("aria-label", tr("cam.volume"));
        t.el.querySelector(".cam-vol-btn").setAttribute("aria-label", tr("cam.volume"));
        t.el.querySelector(".cam-flip").setAttribute("aria-label", tr("cam.flip"));
        const scr = t.el.querySelector(".cam-screen");
        scr.setAttribute("aria-label", tr("screencast.watch") + " " + tr("screencast.screen"));
        scr.querySelector("span").textContent = tr("cam.screen");
    }

    /* ---- движение (гайд §4: фейды + сдвиги ≤ 8px, --t-med, --ease) ---- */
    const anim = (el, frames, extra) => el.animate(frames,
        { duration: dur(), easing: MOTION.ease, fill: "both", ...extra });

    function setBox(t, r) {
        t.el.style.transform = `translate(${r.x.toFixed(1)}px, ${r.y.toFixed(1)}px)`;
        t.el.style.width = r.w.toFixed(1) + "px";
        t.el.style.height = r.h.toFixed(1) + "px";
    }
    function stopMotion(t) {
        t.el.getAnimations().forEach(a => { if (a.id === "tile") a.cancel(); });
    }
    function appear(t) {
        const a = anim(t.el, [{ opacity: 0, translate: `0 ${RISE}` }, { opacity: 1, translate: "0 0" }]);
        a.id = "tile";
        a.onfinish = () => a.cancel();
    }
    function disappear(t) {
        stopMotion(t);
        t.el.classList.add("is-gone");
        const a = anim(t.el, [{ opacity: 1, translate: "0 0" }, { opacity: 0, translate: `0 ${RISE}` }]);
        a.onfinish = () => { t.video.srcObject = null; t.el.remove(); };
    }
    function snapshot(t) {
        const g = t.el.cloneNode(true);
        g.classList.add("is-ghost");
        g.classList.remove("is-drag", "is-ctl");
        const c = document.createElement("canvas");
        const v = t.video;
        c.width = v.videoWidth || 16; c.height = v.videoHeight || 9;
        try { if (v.videoWidth) c.getContext("2d").drawImage(v, 0, 0, c.width, c.height); } catch (_) {}
        g.querySelector("video")?.replaceWith(c);
        camStage.insertBefore(g, camStage.firstChild);
        const a = anim(g, [{ opacity: 1 }, { opacity: 0 }]);
        a.onfinish = () => g.remove();
    }
    function moveTile(t, r, instant) {
        const prev = t.rect;
        t.rect = r;
        if (!prev) { setBox(t, r); return "new"; }
        const same = Math.abs(prev.x - r.x) < 0.5 && Math.abs(prev.y - r.y) < 0.5 &&
            Math.abs(prev.w - r.w) < 0.5 && Math.abs(prev.h - r.h) < 0.5;
        if (same) return "same";
        if (instant || reduceMotion()) { setBox(t, r); return "moved"; }
        /* перетекание: старый кадр гаснет на месте, плитка проявляется на новом */
        stopMotion(t);
        snapshot(t);
        setBox(t, r);
        const a = anim(t.el, [{ opacity: 0 }, { opacity: 1 }]);
        a.id = "tile"; a.onfinish = () => a.cancel();
        return "moved";
    }

    /* ===================== геометрия ===================== */

    const focusOn = (list) => !!S.focus && list.length > 1 && list.includes(S.focus);
    const stripGap = (r, list) => (focusOn(list) ? STRIP_GAP_FOCUS : STRIP_GAP) * r;

    function geometry() {
        const r = rem();
        const st = stageEl.getBoundingClientRect();
        const padR = parseFloat(getComputedStyle(stageEl).paddingRight) || 0;
        const ctrl = controlsEl.getBoundingClientRect();
        const m = getComputedStyle(panelArea).transform;
        const curY = m && m !== "none" ? new DOMMatrixReadOnly(m).m42 : 0;
        const baseCtrlTop = ctrl.top - curY;            // верх контролов без transform панели
        /* режим камер: контролы внизу; на телефоне — тот же воздух от футера,
           что у краёв экрана (1.43rem) */
        const ctrlTop = st.bottom - (isPhone() ? 1.43 : 0.57) * r - ctrl.height;
        return { r, st, right: st.right - padR, ctrlTop, shift: ctrlTop - baseCtrlTop };
    }

    /* Кто в ряду: только те, кто смотрит (без камеры). Свой — в центре
       (нечётно) или в ближайшем к центру слоте (чётно). */
    function stripMetrics(geo) {
        const { r, st, right } = geo;
        const me = selfId();
        const members = [];
        for (const [id] of participantElements) {
            if (id === me) continue;
            if (S.peerCam.has(id)) continue;
            members.push(id);
        }
        if (!hasLocal() && participantElements.has(me)) members.splice(Math.floor(members.length / 2), 0, me);
        const avail = (right - st.left) - 2 * 1.43 * r;
        let sz = BLOB_REM * r, step = sz + 0.86 * r;
        /* тач: ники видны всегда, в одну строку → шаг под самый длинный */
        if (isPhone()) {
            const fs = Math.min(0.86 * r, Math.max(0.62 * r, sz * 0.16));
            const longest = Math.max(0, ...members.map(id => nickOf(id).length));
            step = Math.max(step, longest * fs * 0.78 + 0.57 * r);
        }
        if (members.length > 1 && (members.length - 1) * step + sz > avail) {
            const f = avail / ((members.length - 1) * step + Math.max(sz, step));
            sz *= f; step *= f;
        }
        participantsContainer?.style.setProperty("--nick-w", Math.max(step - 0.43 * r, sz).toFixed(1) + "px");
        return { members, sz: members.length ? sz : 0, step };
    }

    /* Блоб уходит из ряда (включил камеру) — схлопывается в точку на месте;
       возвращается — рождается из точки в своём слоте. Та же анимация, что
       прод-вход/выход (css/stage.css blob-born / blob-collapse). */
    const BLOB_LIFE = () => reduceMotion() ? 1 : MOTION.med * 1.5;
    const BORN = [
        { transform: "scale(0)", easing: MOTION.ease, offset: 0 },
        { transform: "scale(0.16)", easing: MOTION.ease, offset: 0.3 },
        { transform: "scale(1)", offset: 1 }];
    const COLLAPSE = [
        { transform: "scale(1)", easing: MOTION.ease, offset: 0 },
        { transform: "scale(0.16)", easing: MOTION.ease, offset: 0.6 },
        { transform: "scale(0)", offset: 1 }];

    function hideBlob(id, el) {
        if (hiddenBlobs.has(id)) return;
        hiddenBlobs.add(id);
        el.style.pointerEvents = "none";
        const av = el.querySelector(".participant-avatar");
        el._blobAnims?.forEach(a => a.cancel());
        const a1 = av.animate(COLLAPSE, { duration: dur(), fill: "forwards" });
        const a2 = el.animate([{ opacity: 1, offset: 0 }, { opacity: 1, offset: 0.6 }, { opacity: 0, offset: 1 }],
            { duration: dur(), fill: "forwards" });
        el._blobAnims = [a1, a2];
        a2.onfinish = () => { if (hiddenBlobs.has(id)) { el.style.opacity = "0"; a1.cancel(); a2.cancel(); } };
    }
    function showBlob(id, el, place) {
        if (!hiddenBlobs.has(id)) { place(); return; }
        hiddenBlobs.delete(id);
        el._blobAnims?.forEach(a => a.cancel());
        el.classList.add("no-anim");
        place();
        el.style.opacity = "";
        el.style.pointerEvents = "";
        void el.offsetWidth;
        requestAnimationFrame(() => el.classList.remove("no-anim"));
        const av = el.querySelector(".participant-avatar");
        const nm = el.querySelector(".participant-name");
        el._blobAnims = [av.animate(BORN, { duration: BLOB_LIFE() })];
        if (nm) el._blobAnims.push(nm.animate([{ opacity: 0 }, { opacity: 1 }],
            { duration: dur(), delay: MOTION.med * 0.6, fill: "backwards", easing: MOTION.ease }));
    }

    function layoutStrip(geo, cy0, list) {
        const { st, right } = geo;
        const { members, sz, step } = stripMetrics(geo);
        const slot = document.querySelector(".users-slot")?.getBoundingClientRect();
        if (!slot) return;
        const cx = slot.left + slot.width / 2, cy = slot.top + slot.height / 2;
        const y = cy0 ?? (geo.ctrlTop - stripGap(geo.r, list) - sz / 2);
        const midX = st.left + (right - st.left) / 2;
        const x0 = midX - ((members.length - 1) * step) / 2;
        const szPx = sz.toFixed(1) + "px";
        for (const [id, el] of participantElements) {
            const i = members.indexOf(id);
            if (i < 0) { hideBlob(id, el); continue; }
            showBlob(id, el, () => {
                el.style.setProperty("--sz", szPx);
                el.style.setProperty("--px", (x0 + i * step - cx).toFixed(1) + "px");
                el.style.setProperty("--py", (y - cy).toFixed(1) + "px");
            });
        }
    }

    /* ===================== контролы: две строки ↔ одна =====================
       Голос: [mic][deaf][cam][screen] + «выйти» на всю ширину строкой ниже.
       Камеры: всё в одну строку. Сетка перестраивается мгновенно — FLIP:
       иконки едут со старых мест на новые, «выйти» перетекает из широкой
       полосы под ними в кнопку справа (её копия меняет рамку абсолютом, сама
       кнопка проявляется на месте в конце). Одновременно вся панель едет
       к футеру/обратно (transition .cam-motion) — FLIP считается внутри неё. */
    function morphControls(change) {
        const kids = controlsEl ? [...controlsEl.children].filter(el => el.getClientRects().length) : [];
        if (!kids.length || reduceMotion()) { change(); return; }
        /* прерванный переход: стартуем с того места, где элемент сейчас виден */
        const before = new Map(kids.map(el => [el, el.getBoundingClientRect()]));
        change();
        const host = controlsEl.getBoundingClientRect();
        const opts = { duration: dur(), easing: MOTION.ease };
        for (const el of kids) {
            const a = before.get(el);
            el._ghost?.remove(); el._ghost = null;
            el._morph?.forEach(x => x.cancel());
            el._morph = null;
            const b = el.getBoundingClientRect();
            if (!b.width) continue;
            const dx = a.left - b.left, dy = a.top - b.top;
            if (Math.abs(a.width - b.width) < 0.5 && Math.abs(a.height - b.height) < 0.5) {
                if (Math.abs(dx) + Math.abs(dy) > 0.5)
                    el._morph = [el.animate([{ translate: `${dx}px ${dy}px` }, { translate: "0 0" }], opts)];
                continue;
            }
            /* поменялся размер (только «выйти»): старая форма — копией едет к
               новому месту и гаснет, кнопка уже новой формы едет со старого
               места и проявляется. Только transform/opacity — их ведёт
               компоновщик, переход не встаёт, даже если главный поток занят
               (на маке его вешает старт камеры: анимация width/left
               замирала и в конце прыгала). */
            const g = el.cloneNode(true);
            g.removeAttribute("id");
            g.setAttribute("aria-hidden", "true");
            g.tabIndex = -1;
            g.classList.add("ctl-ghost");
            Object.assign(g.style, {
                left: (a.left - host.left) + "px", top: (a.top - host.top) + "px",
                width: a.width + "px", height: a.height + "px"
            });
            controlsEl.appendChild(g);
            el._ghost = g;
            const cx = (b.left + b.width / 2) - (a.left + a.width / 2);
            const cy = (b.top + b.height / 2) - (a.top + a.height / 2);
            const ga = g.animate([{ translate: "0 0", opacity: 1 }, { translate: `${cx}px ${cy}px`, opacity: 0 }],
                { ...opts, fill: "forwards" });
            ga.onfinish = () => { if (el._ghost === g) el._ghost = null; g.remove(); };
            el._morph = [el.animate([{ translate: `${-cx}px ${-cy}px`, opacity: 0 }, { translate: "0 0", opacity: 1 }], opts)];
        }
    }

    /* ===================== раскладка ===================== */

    function layoutAll(reason) {
        if (!camStage || typeof participantElements === "undefined") return;
        const instant = reason === "resize";
        const list = camList();
        const want = list.length > 0 && !isMobileChat()
            && typeof isJoined !== "undefined" && isJoined;

        if (want && (stageMode === "voice" || stageMode === "leaving")) {
            clearTimeout(modeTimer);
            /* Плитки — сразу, вместе с переездом контролов: блоб «превращается»
               в плитку. Таймер «сначала место, потом плитки» не годился — на
               маке камера на старте вешает главный поток ~1 с, и таймер стрелял
               только после неё (контролы уехали, а сцена пустая). */
            stageMode = "cams";
        } else if (!want && stageMode !== "voice") {
            /* Сразу в корону: плитки гаснут, блобы в тот же момент едут/рождаются
               в своих слотах. Промежуточного «ряда снизу» нет. */
            clearTimeout(modeTimer);
            stageMode = "voice";
            for (const t of tiles.values()) disappear(t);
            tiles.clear();
            S.ctl = null;
        }

        const camsLayout = stageMode !== "voice";
        const toggleCams = () => appEl.classList.toggle("cams", camsLayout);
        if (!instant && camsLayout !== appEl.classList.contains("cams")) morphControls(toggleCams);
        else toggleCams();
        /* transition панели живёт на базовом состоянии, пока идёт заход/выход
           (иначе обратный переезд был бы без анимации). Снимается в голосе. */
        if (camsLayout) appEl.classList.add("cam-motion");
        else if (appEl.classList.contains("cam-motion") && !motionTimer) {
            motionTimer = setTimeout(() => {
                motionTimer = 0;
                if (stageMode !== "voice") return;
                appEl.classList.remove("cam-motion");
                /* панель доехала на место — теперь squeeze (app.js) честный */
                if (typeof scheduleLobbyPanelFit === "function") scheduleLobbyPanelFit();
            }, dur() + 50);
        }
        camStage.classList.toggle("no-anim", instant);
        if (instant) requestAnimationFrame(() => camStage.classList.remove("no-anim"));

        const geo = geometry();
        appEl.style.setProperty("--cam-panel-shift", (camsLayout ? geo.shift : 0) + "px");

        if (!camsLayout) {
            /* назад в корону: спрятанные блобы рождаются в своих слотах */
            const back = [...hiddenBlobs].filter(id => participantElements.has(id));
            for (const id of back) participantElements.get(id).classList.add("no-anim");
            if (typeof layoutCorona === "function") layoutCorona();
            for (const id of back) {
                const el = participantElements.get(id);
                showBlob(id, el, () => {});
                el.classList.add("no-anim");
                requestAnimationFrame(() => el.classList.remove("no-anim"));
            }
            refreshDemand();
            return;
        }
        const r = geo.r;
        if (stageMode === "cams") for (const [id, t] of tiles) if (!list.includes(id)) { disappear(t); tiles.delete(id); }
        if (!list.length) { layoutStrip(geo, undefined, list); refreshDemand(); return; }

        /* Композиция «сетка + ряд» с РАВНЫМИ просветами: над сеткой = сетка→ряд
           = ряд→контролы (каждый ≥ G). Без ряда сетка по центру между верхом
           сцены и контролами. Считается в каждой фазе, чтобы ряд встал туда,
           где останется, пока плитки ещё не проявились. */
        const touch = isPhone();
        const sm = stripMetrics(geo), G = stripGap(r, list), sz = sm.sz;
        const nickFont = Math.min(0.86 * r, Math.max(0.62 * r, sz * 0.16));
        const stripH = sz ? sz + (touch ? 0.36 * r + nickFont * 1.3 : 0) : 0;
        const minTop = 0.57 * r;
        const left = geo.st.left + 1.43 * r, right = geo.right - 1.43 * r;
        const W = right - left;
        const H = Math.max(40, geo.ctrlTop - geo.st.top - minTop - (stripH ? 2 * G + stripH : G));
        const ar = W / H < 0.9 ? 1 : 16 / 9;     // узкий портрет — квадратные плитки
        const focusIdx = focusOn(list) ? list.indexOf(S.focus) : null;
        if (S.ctl && !list.includes(S.ctl)) S.ctl = null;
        camStage.classList.toggle("lone", list.length < 2);
        camStage.classList.toggle("many", list.length > 2 && focusIdx == null && !touch);
        const rects = window.VoidCamGrid.layout(list.length, W, H,
            { gap: GAP_REM * r, ar, focusIdx, rem: r, nick: touch ? 0.29 * r + 0.64 * r * 1.3 : 0 });
        if (!rects.length) return;
        const gridH = Math.max(...rects.map(b => b.y + b.h)) - Math.min(...rects.map(b => b.y));
        const y0rel = Math.min(...rects.map(b => b.y));
        const free = (geo.ctrlTop - geo.st.top) - gridH - stripH;
        const parts = stripH ? 3 : 2;
        let gap = Math.max(G, free / parts);
        let airTop = free - gap * (parts - 1);
        if (airTop < minTop) { airTop = minTop; gap = (free - airTop) / (parts - 1); }
        const top = geo.st.top + airTop - y0rel;
        layoutStrip(geo, geo.st.top + airTop + gridH + gap + sz / 2, list);
        if (stageMode !== "cams") { refreshDemand(); return; }   // плитки ждут, пока освободится место

        list.forEach((id, i) => {
            const t = tiles.get(id) || makeTile(id);
            const b = rects[i];
            const box = { x: left + b.x, y: top + b.y, w: b.w, h: b.h };
            t.el.classList.toggle("is-focus", focusIdx === i);
            t.el.classList.toggle("thumb", focusIdx != null && focusIdx !== i);
            t.el.classList.toggle("is-ctl", S.ctl === id);
            t.el.classList.toggle("small", b.h < 6 * r);
            paintVol(t.el, (typeof volumeMap !== "undefined" && volumeMap.get(id)) ?? 1);
            t.el.querySelector(".cam-expand").setAttribute("aria-label", tr(focusIdx === i ? "cam.unfocus" : "cam.focus"));
            syncStatus(t, id);
            const dragged = dragState && dragState.id === id && dragState.moved;
            if (dragged) t.rect = box;                 // едет за курсором, сядет на отпускании
            else if (moveTile(t, box, instant) === "new") appear(t);
        });
        refreshDemand();
    }

    let raf = 0;
    function relayout() {
        if (raf) return;
        raf = requestAnimationFrame(() => { raf = 0; layoutAll("resize"); });
    }

    /* ===================== спрос (что нам слать) ===================== */

    function overlayOpen() {
        return !!document.getElementById("screenOverlay")?.classList.contains("is-visible");
    }

    /* Сколько пикселей кадра реально видно: object-fit: cover масштабирует
       кадр, пока он не закроет плитку, просим КОРОТКУЮ сторону отрисованного
       кадра. Кадр той же формы, что плитка, → это высота плитки, как было.
       Портретный кадр с телефона в плитке 16:9 растянут по ширине — просить
       высоту плитки значило получить втрое меньше пикселей, чем рисуем (мыло). */
    function renderedShort(t) {
        const { w, h } = t.rect;
        let vw = t.video.videoWidth, vh = t.video.videoHeight;
        if (!vw || !vh) { vw = 16; vh = 9; }
        const s = Math.max(w / vw, h / vh);
        return Math.min(vw, vh) * s;
    }

    /* Высота каждой чужой плитки → camera.js → DataChannel отправителю.
       Не видно (вкладка в фоне, сверху демка, голосовой режим) → 0. */
    function refreshDemand(now) {
        const cam = window.VoidCam;
        if (!cam) return;
        const hidden = document.hidden || overlayOpen();
        const me = selfId();
        const T = cam.TIERS;
        for (const id of S.peerCam) {
            if (id === me) continue;
            const t = tiles.get(id);
            let h = 0;
            if (!hidden && stageMode === "cams" && t?.rect) h = renderedShort(t);
            else if (stageMode === "entering" || (stageMode === "cams" && !t?.rect)) continue;   // сейчас появится
            cam.setWant(id, h, now === true);
            if (t) {
                const px = Math.min(720, Math.round(h * (window.devicePixelRatio || 1)));
                const tier = h > 0 ? (T.find(x => x.h >= px) || T[T.length - 1]) : T[0];
                t.el.querySelector(".cam-tier").textContent = `${tier.id} · ${tier.h}p${tier.fps ? "@" + tier.fps : ""}`;
            }
        }
        const st = tiles.get(me);
        if (st) st.el.querySelector(".cam-tier").textContent = tr("cam.local");
    }

    /* ===================== взаимодействие ===================== */

    function armCtl() {
        clearTimeout(ctlTimer);
        if (!S.ctl) return;
        ctlTimer = setTimeout(() => { S.ctl = null; layoutAll(); }, CTL_IDLE);
    }

    function paintVol(el, v) {
        el.style.setProperty("--v", v.toFixed(3));
        el.classList.toggle("is-silent", v <= 0);
        const now = String(Math.round(v * 100));
        el.querySelector(".cam-vol-slider").setAttribute("aria-valuenow", now);
        el.querySelector(".cam-hvol").setAttribute("aria-valuenow", now);
    }

    function setVol(id, el, v) {
        v = Math.max(0, Math.min(1, v));
        if (v > 0) el._lastVol = v;
        if (typeof volumeMap !== "undefined") volumeMap.set(id, v);
        if (typeof applyOutputVolumeForUser === "function") applyOutputVolumeForUser(id);
        paintVol(el, v);
    }

    function bindTile(t, id) {
        const el = t.el;
        const self = id === selfId();
        /* ник под миниатюрой: сразу на входе, гаснет через --d-slow после ухода
           курсора — чтобы до него можно было дотянуться (он открывает профиль) */
        let nickTimer = 0;
        el.addEventListener("pointerenter", () => { clearTimeout(nickTimer); el.classList.add("nick-on"); });
        el.addEventListener("pointerleave", () => {
            clearTimeout(nickTimer);
            nickTimer = setTimeout(() => el.classList.remove("nick-on"), MOTION.slow);
        });
        el.querySelector(".cam-expand").addEventListener("click", e => {
            e.stopPropagation();
            const list = camList();
            S.focus = focusOn(list) && S.focus === id ? null : id;
            S.ctl = null;
            layoutAll();
        });
        el.querySelector(".cam-screen").addEventListener("click", e => {
            e.stopPropagation();
            if (typeof openScreenOverlay === "function") openScreenOverlay(id);
        });
        /* громкость: колесо по всей плитке (как арка блоба, 5 %/щелчок) или
           тянуть полоску (вертикальная на плитке, горизонтальная над миниатюрой) */
        el.addEventListener("wheel", e => {
            if (S.ctl !== id || self) return;
            e.preventDefault();
            const n = window.VoidWheel ? window.VoidWheel.notches(e) : -Math.sign(e.deltaY);
            if (n) setVol(id, el, ((typeof volumeMap !== "undefined" && volumeMap.get(id)) ?? 1) + n * 0.05);
            armCtl();
        }, { passive: false });
        /* слайдеры: вертикальный в квадрате громкости, горизонтальный над
           миниатюрой; значение — по дорожке (точка ездит по ней от края до края) */
        const volBox = el.querySelector(".cam-vol");
        const bindSlider = (bar, vertical) => {
            const track = bar.querySelector(".cam-vol-track");
            const fromPointer = e => {
                const b = track.getBoundingClientRect();
                setVol(id, el, vertical ? (b.bottom - e.clientY) / b.height : (e.clientX - b.left) / b.width);
            };
            bar.addEventListener("pointerdown", e => {
                e.stopPropagation();
                try { bar.setPointerCapture(e.pointerId); } catch (_) {}
                bar._drag = true; el.classList.add("vol-drag"); fromPointer(e); armCtl();
            });
            bar.addEventListener("pointermove", e => { if (bar._drag) { fromPointer(e); armCtl(); } });
            const stopBar = () => { bar._drag = false; el.classList.remove("vol-drag"); };
            bar.addEventListener("pointerup", stopBar);
            bar.addEventListener("pointercancel", stopBar);
            bar.addEventListener("click", e => e.stopPropagation());
        };
        bindSlider(el.querySelector(".cam-vol-slider"), true);
        bindSlider(el.querySelector(".cam-hvol"), false);
        volBox.addEventListener("pointerdown", e => e.stopPropagation());
        volBox.addEventListener("click", e => e.stopPropagation());
        /* иконка: тишина ↔ прошлая громкость */
        el.querySelector(".cam-vol-btn").addEventListener("click", e => {
            e.stopPropagation();
            const cur = (typeof volumeMap !== "undefined" && volumeMap.get(id)) ?? 1;
            setVol(id, el, cur > 0 ? 0 : (el._lastVol || 1));
            armCtl();
        });
        el.querySelector(".cam-flip").addEventListener("click", e => {
            e.stopPropagation();
            window.VoidCam?.flip?.();
            armCtl();
        });
        el.addEventListener("pointermove", () => { if (S.ctl === id) armCtl(); });
        /* ник на плитке = путь в профиль (у владельца камеры нет блоба) */
        el.querySelector(".cam-tag").addEventListener("click", e => {
            if (self) return;
            e.stopPropagation();
            window.VoidFriendsUI?.openPersonProfile?.(id);
        });
        el.addEventListener("pointerdown", e => {
            if (e.button !== 0 || e.target.closest(".cam-tag, .cam-expand, .cam-vol, .cam-hvol, .cam-flip, .cam-screen")) return;
            if (!t.rect) return;
            dragState = { id, sx: e.clientX, sy: e.clientY, ox: t.rect.x, oy: t.rect.y, moved: false };
            try { el.setPointerCapture(e.pointerId); } catch (_) {}
        });
        el.addEventListener("pointermove", e => {
            if (!dragState || dragState.id !== id) return;
            const dx = e.clientX - dragState.sx, dy = e.clientY - dragState.sy;
            if (!dragState.moved && Math.hypot(dx, dy) < 6) return;
            if (!dragState.moved) { stopMotion(t); dragState.moved = true; }
            el.classList.add("is-drag");
            el.style.transform = `translate(${dragState.ox + dx}px, ${dragState.oy + dy}px)`;
            for (const [oid, o] of tiles) {
                if (oid === id || !o.rect) continue;
                const r = o.rect;
                if (e.clientX >= r.x && e.clientX <= r.x + r.w && e.clientY >= r.y && e.clientY <= r.y + r.h) {
                    const a = S.order.indexOf(id), b = S.order.indexOf(oid);
                    if (a < 0 || b < 0) break;
                    S.order.splice(a, 1); S.order.splice(b, 0, id);
                    layoutAll();
                    break;
                }
            }
        });
        const end = () => {
            if (!dragState || dragState.id !== id) return;
            const moved = dragState.moved;
            dragState = null;
            el.classList.remove("is-drag");
            if (!moved) {
                /* клик = режим управления (громкость, кнопка фокуса); миниатюра
                   в режиме управления — второй клик в фокус. Телефон: миниатюра
                   сразу в фокус (на ней нет места под управление). */
                if (el.classList.contains("thumb") && (isPhone() || S.ctl === id)) { S.focus = id; S.ctl = null; }
                else S.ctl = S.ctl === id ? null : id;
                armCtl(); layoutAll(); return;
            }
            /* отпущенная плитка садится из-под курсора в свой слот */
            const from = el.style.transform;
            setBox(t, t.rect);
            const a = el.animate([{ transform: from }, { transform: el.style.transform }],
                { duration: dur(), easing: MOTION.ease });
            a.id = "tile";
            layoutAll();
        };
        el.addEventListener("pointerup", end);
        el.addEventListener("pointercancel", end);
    }

    /* camera.js: сменилась своя камера (фронт/тыл) — зеркало и кнопка смены. */
    function syncSelf() {
        const t = tiles.get(selfId());
        if (t) syncStatus(t, selfId());
    }

    /* participants.js отдаёт сюда каждую раскладку. */
    function layout(instant) {
        layoutAll(instant ? "resize" : undefined);
    }

    window.VoidCamStage = {
        layout, relayout, refreshDemand,
        setLocal, setLocalPending, setPeerCam, setRemoteStream, reset, syncSelf,
        mode: () => stageMode
    };

    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
    else init();
})();
