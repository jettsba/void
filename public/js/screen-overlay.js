/* ========= SCREENCAST ========= */

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

function openScModal() {
    scModal.setAttribute("aria-hidden", "false");
    scModal.classList.add("is-visible");
}

function closeScModal() {
    scModal.setAttribute("aria-hidden", "true");
    scModal.classList.remove("is-visible");
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
    const el = document.querySelector(`.participant[data-user-id="${userId}"]`);
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
    // inert + aria-hidden — пара по тому же паттерну, что chatPanel: inert
    // умеет современный браузер (auto-уводит фокус, блокирует клики/таб),
    // aria-hidden остаётся для старых ассистивных технологий.
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
    // inert ставим ДО aria-hidden: браузер сам уберёт фокус с потомков —
    // иначе варн «Blocked aria-hidden on element with focused descendant»
    // когда оверлей закрывается кликом по своей же кнопке.
    screenOverlay.setAttribute("inert", "");
    screenOverlay.setAttribute("aria-hidden", "true");
    if (screenOverlayVideo) screenOverlayVideo.srcObject = null;
    screenOverlayTrackCleanup?.();
    screenOverlayTrackCleanup = null;
    screenOverlayUserId = null;
}

function toggleScreenFullscreen() {
    const fsEl = document.fullscreenElement || document.webkitFullscreenElement;
    if (fsEl) {
        (document.exitFullscreen || document.webkitExitFullscreen)?.call(document);
    } else {
        (screenOverlay.requestFullscreen || screenOverlay.webkitRequestFullscreen)?.call(screenOverlay);
    }
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
