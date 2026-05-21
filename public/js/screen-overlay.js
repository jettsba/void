/* ========= SCREENCAST ========= */

/**
 * Скрыть оверлейный элемент (модалку или fullscreen-видео-оверлей).
 * Перед `inert + aria-hidden` явно блюрим сфокусированного потомка: в Chrome
 * inert делает это сам синхронно, но Яндекс-браузер (и некоторые версии
 * других Chromium-форков) фокус сбрасывает асинхронно — варн
 * "Blocked aria-hidden on element with focused descendant" успевает
 * выстрелить.
 */
function hideOverlayElement(el) {
    if (el.contains(document.activeElement) && document.activeElement !== document.body) {
        document.activeElement.blur();
    }
    el.setAttribute("inert", "");
    el.setAttribute("aria-hidden", "true");
}

/**
 * Tab/Shift+Tab внутри `el` циклится по interactive-элементам, не вылетает
 * наружу. Esc вызывает `onEscape`. Возвращает функцию-cleanup для unbind'а
 * на закрытии модалки.
 *
 * Слушатель висит на `el`, поэтому работает только когда фокус ВНУТРИ
 * элемента — поэтому модалка должна на open'е сама поставить фокус на
 * что-то внутри (иначе trap не подхватит Tab из «снаружи»).
 */
function trapFocusWithin(el, onEscape) {
    const sel = 'button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';
    const onKey = (e) => {
        if (e.key === "Escape") {
            e.preventDefault();
            onEscape?.();
            return;
        }
        if (e.key !== "Tab") return;
        const items = Array.from(el.querySelectorAll(sel))
            .filter(n => !n.hasAttribute("disabled") && n.offsetParent !== null);
        if (items.length === 0) return;
        const first = items[0];
        const last = items[items.length - 1];
        if (e.shiftKey && document.activeElement === first) {
            e.preventDefault();
            last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
            e.preventDefault();
            first.focus();
        }
    };
    el.addEventListener("keydown", onKey);
    return () => el.removeEventListener("keydown", onKey);
}

function handleScreencastBtnClick() {
    if (roomScreencasterId && roomScreencasterId !== clientId) {
        showRoomToast(_t("errors.screencast.busy"));
        return;
    }
    if (isScreencasting) {
        stopScreenShare();
        broadcastScreencastState(false);
        updateScreencastButton(false);
        return;
    }
    openScModal();
}

let _scModalTrapCleanup = null;

function openScModal() {
    scModal.removeAttribute("inert");
    scModal.setAttribute("aria-hidden", "false");
    scModal.classList.add("is-visible");
    _scModalTrapCleanup = trapFocusWithin(scModal, closeScModal);
    /* Кладём фокус внутрь модалки, иначе Tab из «снаружи» вылетит мимо
       trap'а. Делаем это после rAF — ждём окончания CSS-перехода открытия,
       чтобы браузер не споткнулся о display:none. preventScroll: лента
       страницы под модалкой не должна дёргаться, если кнопка вне viewport. */
    requestAnimationFrame(() => {
        if (!scModal.classList.contains("is-visible")) return;
        scNextBtn?.focus({ preventScroll: true });
    });
}

function closeScModal() {
    _scModalTrapCleanup?.();
    _scModalTrapCleanup = null;
    scModal.classList.remove("is-visible");
    hideOverlayElement(scModal);
}

function broadcastScreencastState(isOn) {
    sendSocket({ type: "screencast-state", room: currentRoomCode, userId: clientId, screen: isOn });
    if (!isOn) {
        isScreencasting = false;
        roomScreencasterId = null;
        updateParticipantScreenState(clientId, false);
    } else {
        roomScreencasterId = clientId;
    }
    syncScreencastBtnBlocked();
}

function updateScreencastButton(isOn) {
    screencastBtn.classList.toggle("active", isOn);
    screencastBtn.classList.toggle("sc-btn-blocked", !isOn && !!roomScreencasterId && roomScreencasterId !== clientId);
    if (!screencastBtn.classList.contains("control-btn-stub")) {
        screencastBtn.title = isOn ? _t("controls.screencast.stop") : _t("controls.screencast.share");
    }
}

function updateParticipantScreenState(userId, isSharing) {
    const el = participantElements?.get(userId) ||
        document.querySelector(`.participant[data-user-id="${userId}"]`);
    if (!el) return;
    el.classList.toggle("screensharing", isSharing);
    if (!isSharing && el.classList.contains("blob-active")) {
        const arc = el.querySelector(".volume-arc");
        if (arc) closeVolumeArc(arc); // also removes .blob-active via hook
    }
}

function handleScreencastStateMsg(data) {
    const { userId, screen } = data;
    if (screen) {
        roomScreencasterId = userId;
    } else if (roomScreencasterId === userId) {
        roomScreencasterId = null;
        /* preserveAutoReopen: стример мог выключить демку чтобы тут же
           пере-запустить с другим разрешением / без звука. Сохраняем
           lastWatched 5 минут — если стример снова запустит, новый трек
           через ontrack/notifyScreenVideoReady авто-реоткроет оверлей.
           Если стример не вернётся за 5 минут, TTL истечёт сам. */
        closeScreenOverlay({ preserveAutoReopen: true });
    }
    updateParticipantScreenState(userId, screen);
    syncScreencastBtnBlocked();
}

function syncScreencastBtnBlocked() {
    const blocked = !!roomScreencasterId && roomScreencasterId !== clientId;
    screencastBtn.classList.toggle("sc-btn-blocked", blocked);
    // Hard-disable: prevent any click when someone else is sharing
    if (blocked) {
        screencastBtn.setAttribute("aria-disabled", "true");
        screencastBtn.disabled = true;
    } else if (!screencastBtn.classList.contains("control-btn-stub")) {
        screencastBtn.removeAttribute("aria-disabled");
        screencastBtn.disabled = false;
    }
}

let screenOverlayUserId = null;
let screenOverlayTrackCleanup = null;
let pendingScreenOverlayUserId = null;
let pendingScreenOverlayTimer = null;
/* Запоминаем юзера, которого смотрели — для двух сценариев:
   1) Peer пересоберётся (WS reconnect стримера, rebuild peer'а, sig-stuck) —
      cleanupPeerSlot закроет оверлей с preserveAutoReopen, новый трек
      придёт через ontrack через 1-5 секунд → auto-reopen.
   2) Стример выключил демку и сразу запустил новую (другое разрешение/
      без звука/etc) — screencast-state приходит false→true, новые tracks,
      новый ontrack → auto-reopen.
   TTL 5 минут — щедрый запас на случай задержек negotiation и того что
   стример что-то возится. Сбрасывается ТОЛЬКО на явное закрытие
   юзером (Esc / X-кнопка) или выходе из комнаты. */
let lastWatchedUserId = null;
let lastWatchedExpiresAt = 0;
const _AUTO_REOPEN_TTL_MS = 5 * 60_000;

/* WebAudio routing for screen share audio. Цепочка такая:
       <audio>.srcObject = stream → createMediaElementSource → GainNode → destination
   Зачем именно `<audio>` element как источник, а не `createMediaStreamSource` напрямую:
     - `createMediaStreamSource(remoteTrack)` наследует от WebRTC-receiver
       классификацию "communications session". На Windows это означает, что AEC
       зрителя засчитывает screen audio в свой "double-talk" анализатор и режет
       playback на 80%, когда зритель говорит ("ducking демки при разговоре").
     - HTMLMediaElement по дефолту классифицируется как "media" (не comms) —
       AEC уже не видит его в reference signal так же агрессивно. Audio после
       этого играет через AudioContext.destination, который мы пометили как
       audioSession.type = "playback" (_prepareScreenAudioCtx ниже).
   Не запутайтесь: `<audio>` element создаётся НЕ для воспроизведения нативно,
   а как «обёртка-источник» — createMediaElementSource отбирает у него audio
   pipeline; .muted / .volume на элементе ни на что не влияют. */
let _screenShareAudioCtx = null;
let _screenShareGainNode = null;
let _screenShareAudioEl = null;     // <audio> wrapper, holds the MediaStream
let _screenShareSourceNode = null;  // MediaElementAudioSourceNode

// Called during a user gesture (click to open overlay) — creates AudioContext
// and gain node while the gesture is still active. Safe to call multiple times.
function _prepareScreenAudioCtx() {
    if (_screenShareAudioCtx) return;
    try {
        _screenShareAudioCtx = new AudioContext({ latencyHint: "playback" });
        /* audioSession.type = "playback" — снимает классификацию контекста как
           communications-session. По дефолту любой AudioContext, в который
           подаётся MediaStreamTrack от WebRTC receiver'а, наследует comms-режим
           источника. На Windows это включает comms-ducking: при голосовой
           активности на mic'е (AEC double-talk detector) система режет
           playback на 80%. Явный "playback" говорит ОС «это медиа, не звонок» —
           ducking перестаёт срабатывать на демку.
           API относительно новый (Chrome 124+, Safari 17+); на старых тихо
           игнорится (try/catch ниже не нужен — присвоение неподдерживаемого
           поля no-op, не throw'ает). */
        if (_screenShareAudioCtx.audioSession) {
            try { _screenShareAudioCtx.audioSession.type = "playback"; } catch (_) {}
        }
        _screenShareGainNode = _screenShareAudioCtx.createGain();
        _screenShareGainNode.gain.value = (typeof isSoundOn !== "undefined" && !isSoundOn) ? 0 : 1;
        _screenShareGainNode.connect(_screenShareAudioCtx.destination);
    } catch (_) {
        _screenShareAudioCtx = null;
        _screenShareGainNode = null;
    }
}

function _startScreenOverlayAudio(stream) {
    const audioTracks = stream.getAudioTracks ? stream.getAudioTracks() : [];
    if (!audioTracks.length) return;
    // Reuse AudioContext prepared during the user gesture. If not prepared yet
    // (video was already ready when user clicked, no pending path), create now —
    // we're still inside the click handler, so the gesture is still active.
    _prepareScreenAudioCtx();
    if (!_screenShareAudioCtx) {
        if (screenOverlayVideo) screenOverlayVideo.muted = false;
        return;
    }
    try {
        _screenShareGainNode.gain.value = (typeof isSoundOn !== "undefined" && !isSoundOn) ? 0 : 1;
        /* Создаём `<audio>` обёртку как media-category источник — снимает с
           аудио-pipeline'а классификацию communications и спасает от AEC
           double-talk ducking'а на Windows. Сам element не приcоединяется к
           DOM и не играет нативно: createMediaElementSource «отбирает» у него
           pipeline, аудио идёт через context. */
        _screenShareAudioEl = document.createElement("audio");
        _screenShareAudioEl.autoplay = true;
        _screenShareAudioEl.muted = true;
        _screenShareAudioEl.playsInline = true;
        _screenShareAudioEl.srcObject = new MediaStream(audioTracks);
        _screenShareSourceNode = _screenShareAudioCtx.createMediaElementSource(_screenShareAudioEl);
        _screenShareSourceNode.connect(_screenShareGainNode);
        /* Element.play() обязательно — без него Chrome не запустит pipeline
           «забранного» элемента, даже если он подключён к context.destination. */
        const playPromise = _screenShareAudioEl.play();
        if (playPromise && playPromise.catch) playPromise.catch(() => {});
        // Resume in case context was created outside a gesture (fallback path).
        _screenShareAudioCtx.resume().catch(() => {
            if (screenOverlayVideo) screenOverlayVideo.muted = false;
        });
    } catch (_) {
        if (screenOverlayVideo) screenOverlayVideo.muted = false;
        _screenShareAudioCtx = null;
        _screenShareGainNode = null;
        _screenShareSourceNode = null;
        if (_screenShareAudioEl) {
            try { _screenShareAudioEl.srcObject = null; } catch (__) {}
        }
        _screenShareAudioEl = null;
    }
}

function _stopScreenOverlayAudio() {
    if (_screenShareSourceNode) {
        try { _screenShareSourceNode.disconnect(); } catch (_) {}
        _screenShareSourceNode = null;
    }
    if (_screenShareAudioEl) {
        try { _screenShareAudioEl.pause(); } catch (_) {}
        try { _screenShareAudioEl.srcObject = null; } catch (_) {}
        _screenShareAudioEl = null;
    }
    if (_screenShareAudioCtx) {
        _screenShareAudioCtx.close();
        _screenShareAudioCtx = null;
        _screenShareGainNode = null;
    }
    if (screenOverlayVideo) screenOverlayVideo.muted = false;
}

function setScreenOverlayAudioMuted(muted) {
    if (_screenShareGainNode) {
        _screenShareGainNode.gain.value = muted ? 0 : 1;
    } else if (screenOverlayVideo) {
        screenOverlayVideo.muted = muted;
    }
}

/**
 * Вызывается из webrtc.js peer.ontrack после того, как видео-трек экрана
 * приехал и привязан к videoEl.
 *
 * Два сценария авто-открытия:
 *   1. pending — юзер кликнул «watch screen» ДО прибытия трека (race на старте).
 *   2. lastWatched — оверлей был открыт, peer пересобрался (WS reconnect стримера
 *      или rebuild), либо стример пере-запустил демку с другими настройками;
 *      в окне auto-reopen TTL восстанавливаем просмотр сами, иначе зритель
 *      видит «черный экран».
 *
 * Диагностические логи решений — чтобы при следующем баге сразу было видно,
 * по какой причине оверлей открылся или НЕ открылся.
 */
function notifyScreenVideoReady(userId) {
    if (pendingScreenOverlayUserId === userId) {
        pendingScreenOverlayUserId = null;
        clearTimeout(pendingScreenOverlayTimer);
        pendingScreenOverlayTimer = null;
        log.info("rtc", "screen overlay auto-open: pending", { userId });
        openScreenOverlay(userId);
        return;
    }
    if (lastWatchedUserId === userId && Date.now() < lastWatchedExpiresAt) {
        log.info("rtc", "screen overlay auto-open: lastWatched", { userId });
        openScreenOverlay(userId);
        return;
    }
    log.debug("rtc", "screen overlay auto-open skipped", {
        userId,
        reason: lastWatchedUserId !== userId ? "different-user" :
                Date.now() >= lastWatchedExpiresAt ? "ttl-expired" : "no-pending"
    });
}

/**
 * Hot-swap srcObject у открытого оверлея, если новый видео-трек пришёл для
 * того же user'а, кого уже смотрим. Без этого после sig-stuck rebuild или
 * track-replace зритель видит чёрный экран: screenOverlayVideo держит
 * ссылку на СТАРЫЙ stream-объект (у которого video-track уже удалён),
 * новый stream висит в videoMap.get(userId).srcObject — но напрямую не
 * привязан к видимому элементу.
 */
function refreshOverlayStreamIfOpen(userId, stream) {
    if (screenOverlayUserId !== userId) return;
    if (!screenOverlayVideo) return;
    if (screenOverlayVideo.srcObject === stream) return;
    log.info("rtc", "screen overlay hot-swap stream", { userId });
    screenOverlayVideo.srcObject = stream;
    /* Audio тоже мог поменяться — перепривяжем через тот же путь. */
    _stopScreenOverlayAudio();
    _startScreenOverlayAudio(stream);
    /* Обновим cleanup-листенеры на новый stream — старые висят на мёртвом. */
    screenOverlayTrackCleanup?.();
    const videoTrack = stream.getVideoTracks?.()[0];
    const onEnded = () => closeScreenOverlay({ preserveAutoReopen: true });
    const onRemoveTrack = e => {
        if (e.track?.kind === "video") closeScreenOverlay({ preserveAutoReopen: true });
    };
    videoTrack?.addEventListener("ended", onEnded);
    stream.addEventListener?.("removetrack", onRemoveTrack);
    screenOverlayTrackCleanup = () => {
        videoTrack?.removeEventListener("ended", onEnded);
        stream.removeEventListener?.("removetrack", onRemoveTrack);
    };
}

function openScreenOverlay(userId) {
    const videoEl = videoMap.get(userId);
    if (!videoEl?.srcObject) {
        /* Race: socket «started sharing» прилетел, а WebRTC-трек ещё нет.
           Запоминаем намерение и ждём сигнала из ontrack. Таймаут 5 сек —
           если трек не приедет, чистим pending.
           _prepareScreenAudioCtx здесь — чтобы AudioContext создался в контексте
           user gesture (клик), пока он активен, до прихода трека. */
        _prepareScreenAudioCtx();
        pendingScreenOverlayUserId = userId;
        clearTimeout(pendingScreenOverlayTimer);
        pendingScreenOverlayTimer = setTimeout(() => {
            pendingScreenOverlayUserId = null;
            pendingScreenOverlayTimer = null;
            _stopScreenOverlayAudio(); // clean up prepared context if track never arrived
        }, 5000);
        return;
    }
    pendingScreenOverlayUserId = null;
    clearTimeout(pendingScreenOverlayTimer);
    pendingScreenOverlayTimer = null;

    const stream = videoEl.srcObject;

    screenOverlayUserId = userId;
    /* Запоминаем для auto-reopen в notifyScreenVideoReady. TTL обновляется
       при каждом успешном open — пока юзер смотрит, окно живёт; явное закрытие
       (Esc, кнопка, screencast-state:false) обнулит. */
    lastWatchedUserId = userId;
    lastWatchedExpiresAt = Date.now() + _AUTO_REOPEN_TTL_MS;
    screenOverlayVideo.srcObject = stream;
    screenOverlayVideo.muted = true; // audio routed via WebAudio below (prevents comms ducking)
    _startScreenOverlayAudio(stream);
    screenOverlay.removeAttribute("inert");
    screenOverlay.setAttribute("aria-hidden", "false");
    screenOverlay.classList.add("is-visible");

    screenOverlayTrackCleanup?.();
    const videoTrack = stream.getVideoTracks?.()[0];
    /* preserveAutoReopen: track может закончиться из-за пересборки peer'а;
       не запрещаем будущий auto-reopen. Юзерское закрытие (Esc / button)
       идёт через закрытия БЕЗ флага и сбрасывает lastWatched. */
    const onEnded = () => closeScreenOverlay({ preserveAutoReopen: true });
    const onRemoveTrack = e => {
        if (e.track?.kind === "video") closeScreenOverlay({ preserveAutoReopen: true });
    };
    videoTrack?.addEventListener("ended", onEnded);
    stream.addEventListener?.("removetrack", onRemoveTrack);
    screenOverlayTrackCleanup = () => {
        videoTrack?.removeEventListener("ended", onEnded);
        stream.removeEventListener?.("removetrack", onRemoveTrack);
    };
}

/**
 * @param {{preserveAutoReopen?: boolean}} [opts]
 *   preserveAutoReopen=true означает «закрытие из-за teardown peer'а, не из-за
 *   юзерского жеста» — оставляем lastWatchedUserId/Expires, чтобы новый трек
 *   через notifyScreenVideoReady авто-реоткрыл оверлей. Дефолт false — юзер
 *   закрыл сам (Esc, кнопка, fullscreen-close), реоткрывать не надо.
 */
function closeScreenOverlay(opts) {
    if (!screenOverlay) return;
    if (document.fullscreenElement === screenOverlay) {
        document.exitFullscreen?.();
    } else if (document.webkitFullscreenElement === screenOverlay) {
        document.webkitExitFullscreen?.();
    }
    screenOverlay.classList.remove("is-visible");
    hideOverlayElement(screenOverlay);
    _stopScreenOverlayAudio();
    if (screenOverlayVideo) screenOverlayVideo.srcObject = null;
    screenOverlayTrackCleanup?.();
    screenOverlayTrackCleanup = null;
    screenOverlayUserId = null;
    if (!opts || !opts.preserveAutoReopen) {
        lastWatchedUserId = null;
        lastWatchedExpiresAt = 0;
    }
}

function toggleScreenFullscreen() {
    const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
    const fsEl = document.fullscreenElement || document.webkitFullscreenElement;
    if (fsEl) {
        (document.exitFullscreen || document.webkitExitFullscreen)?.call(document);
        return;
    }
    if (isIOS && screenOverlayVideo?.webkitEnterFullscreen) {
        screenOverlayVideo.webkitEnterFullscreen();
        return;
    }
    (screenOverlay.requestFullscreen || screenOverlay.webkitRequestFullscreen)?.call(screenOverlay);
}

function handleScreencastRejected() {
    if (isScreencasting) {
        stopScreenShare();
        isScreencasting = false;
        updateScreencastButton(false);
        updateParticipantScreenState(clientId, false);
    }
    showRoomToast(_t("errors.screencast.busy"));
}

function showRoomToast(text) {
    if (!roomToastEl) return;
    roomToastEl.textContent = text;
    roomToastEl.classList.add("is-visible");
    clearTimeout(_toastTimer);
    _toastTimer = setTimeout(() => roomToastEl.classList.remove("is-visible"), 3000);
}
