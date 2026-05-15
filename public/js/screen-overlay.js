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
        closeScreenOverlay();
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

// WebAudio routing for screen share audio — routes received screen audio
// through AudioContext instead of native <video> element playback.
// Chrome's communications ducking only affects HTML media elements; AudioContext
// uses a separate audio session type that isn't ducked when the viewer speaks.
let _screenShareAudioCtx = null;
let _screenShareGainNode = null;

function _startScreenOverlayAudio(stream) {
    _stopScreenOverlayAudio();
    const audioTracks = stream.getAudioTracks ? stream.getAudioTracks() : [];
    if (!audioTracks.length) return;
    try {
        _screenShareAudioCtx = new AudioContext({ latencyHint: "playback" });
        const src = _screenShareAudioCtx.createMediaStreamSource(new MediaStream(audioTracks));
        _screenShareGainNode = _screenShareAudioCtx.createGain();
        _screenShareGainNode.gain.value = (typeof isSoundOn !== "undefined" && !isSoundOn) ? 0 : 1;
        src.connect(_screenShareGainNode);
        _screenShareGainNode.connect(_screenShareAudioCtx.destination);
    } catch (_) {
        // AudioContext unavailable — fall back to native video audio
        if (screenOverlayVideo) screenOverlayVideo.muted = false;
        _screenShareAudioCtx = null;
        _screenShareGainNode = null;
    }
}

function _stopScreenOverlayAudio() {
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
 * приехал и привязан к videoEl. Если пользователь уже кликнул «watch screen»
 * до прибытия трека — открываем оверлей сейчас.
 */
function notifyScreenVideoReady(userId) {
    if (pendingScreenOverlayUserId === userId) {
        pendingScreenOverlayUserId = null;
        clearTimeout(pendingScreenOverlayTimer);
        pendingScreenOverlayTimer = null;
        openScreenOverlay(userId);
    }
}

function openScreenOverlay(userId) {
    const videoEl = videoMap.get(userId);
    if (!videoEl?.srcObject) {
        /* Race: socket «started sharing» прилетел, а WebRTC-трек ещё нет.
           Запоминаем намерение и ждём сигнала из ontrack. Таймаут 5 сек —
           если трек не приедет, чистим pending. */
        pendingScreenOverlayUserId = userId;
        clearTimeout(pendingScreenOverlayTimer);
        pendingScreenOverlayTimer = setTimeout(() => {
            pendingScreenOverlayUserId = null;
            pendingScreenOverlayTimer = null;
        }, 5000);
        return;
    }
    pendingScreenOverlayUserId = null;
    clearTimeout(pendingScreenOverlayTimer);
    pendingScreenOverlayTimer = null;

    const stream = videoEl.srcObject;

    screenOverlayUserId = userId;
    screenOverlayVideo.srcObject = stream;
    screenOverlayVideo.muted = true; // audio routed via WebAudio below (prevents comms ducking)
    _startScreenOverlayAudio(stream);
    screenOverlay.removeAttribute("inert");
    screenOverlay.setAttribute("aria-hidden", "false");
    screenOverlay.classList.add("is-visible");

    screenOverlayTrackCleanup?.();
    const videoTrack = stream.getVideoTracks?.()[0];
    const onEnded = () => closeScreenOverlay();
    const onRemoveTrack = e => { if (e.track?.kind === "video") closeScreenOverlay(); };
    videoTrack?.addEventListener("ended", onEnded);
    stream.addEventListener?.("removetrack", onRemoveTrack);
    screenOverlayTrackCleanup = () => {
        videoTrack?.removeEventListener("ended", onEnded);
        stream.removeEventListener?.("removetrack", onRemoveTrack);
    };
}

function closeScreenOverlay() {
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
