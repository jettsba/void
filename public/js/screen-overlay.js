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
        // Звук стопа скринкаста — слышат все (self здесь, остальные по WS).
        if (window.VoidSounds) VoidSounds.screencast(false);
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
        screencastBtn.setAttribute("aria-label", isOn ? _t("controls.screencast.stop") : _t("controls.screencast.share"));
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
        /* Стример осознанно выключил демку — сбрасываем lastWatched, чтобы
           следующий запуск НЕ авто-открывал оверлей у зрителя. Иначе:
           зритель свернул просмотр / альт-табнулся в игру → стример рестартнул
           демку → оверлей сам разворачивается на фуллскрин поверх игры.
           Auto-reopen остаётся для peer-rebuild сценариев (cleanupPeerSlot,
           participant-left) — там lastWatched сохраняется отдельно. */
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

/* Screen-audio playback: ИГРАЕМ НАТИВНО через <video>.srcObject (без
   AudioContext-роутинга и без `<audio>` обёрток). Это критично для Windows
   ducking: Chrome специально пометил HTMLMediaElement playback с WebRTC
   remote-audio как часть «ducking session» (Chromium codereview 281814/281483
   от 2014) — Windows такой playback НЕ дакает на 80% при активном mic'е.
   AudioContext.destination — отдельный render-stream вне этого opt-out, и
   через него playback демки дакался при разговоре зрителя.
   Громкость и mute контролируются прямыми свойствами screenOverlayVideo:
   .volume, .muted, .setSinkId. */
function setScreenOverlayAudioMuted(muted) {
    if (screenOverlayVideo) screenOverlayVideo.muted = !!muted;
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
    screenOverlayVideo.muted = (typeof isSoundOn !== "undefined" && !isSoundOn);
    applyMasterVolumeToScreenOverlay();
    applySinkIdToScreenOverlay();
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

/**
 * Применить мастер-громкость к screenOverlayVideo. Зовётся при open и при
 * изменении настроек громкости (event "void:audio-out-gain-changed").
 */
function applyMasterVolumeToScreenOverlay() {
    if (!screenOverlayVideo) return;
    const master = (typeof getMasterOutputGain === "function") ? getMasterOutputGain() : 1;
    screenOverlayVideo.volume = Math.max(0, Math.min(1, master));
}

/**
 * Применить выбранное output-устройство (settings → audio out device) к
 * screenOverlayVideo. На Safari/старых браузерах setSinkId отсутствует —
 * тихо игнорим. */
async function applySinkIdToScreenOverlay() {
    if (!screenOverlayVideo) return;
    if (typeof screenOverlayVideo.setSinkId !== "function") return;
    const id = window.VoidSettings?.getAudioOutId?.() || "";
    try { await screenOverlayVideo.setSinkId(id); } catch (_) {}
}

document.addEventListener("void:audio-out-gain-changed", applyMasterVolumeToScreenOverlay);
document.addEventListener("void:audio-out-device-changed", applySinkIdToScreenOverlay);

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
    /* Запоминаем для auto-reopen в notifyScreenVideoReady. TTL обновляется
       при каждом успешном open — пока юзер смотрит, окно живёт; явное закрытие
       (Esc, кнопка, screencast-state:false) обнулит. */
    lastWatchedUserId = userId;
    lastWatchedExpiresAt = Date.now() + _AUTO_REOPEN_TTL_MS;
    screenOverlayVideo.srcObject = stream;
    /* Нативный playback аудио через video-элемент — попадает в Chrome WebRTC
       ducking opt-out (codereview 281814), Windows не дакает на 80% при
       активном mic'е. См. комментарий у setScreenOverlayAudioMuted выше. */
    screenOverlayVideo.muted = (typeof isSoundOn !== "undefined" && !isSoundOn);
    applyMasterVolumeToScreenOverlay();
    applySinkIdToScreenOverlay();
    /* Явный play() — autoplay attribute не всегда срабатывает после смены
       srcObject (особенно на reopen с другим stream). Promise может отказать
       если autoplay policy не позволяет unmuted playback без user gesture —
       но openScreenOverlay всегда зовётся из click handler. */
    const playPromise = screenOverlayVideo.play?.();
    if (playPromise && playPromise.catch) playPromise.catch(() => {});
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
/* Desktop fullscreen демки = нативный fullscreen ОКНА Tauri (см.
   toggleScreenFullscreen). Состояние держим здесь, чтобы close/Esc могли выйти. */
let _screenNativeFs = false;
function _setDesktopScreenFs(on) {
    _screenNativeFs = on;
    screenOverlay.classList.toggle("is-fullscreen", on);
    document.documentElement.classList.toggle("screen-native-fs", on);
    try { window.__TAURI__?.window?.getCurrentWindow?.()?.setFullscreen?.(on); } catch (_) {}
}

function closeScreenOverlay(opts) {
    if (!screenOverlay) return;
    if (_screenNativeFs) {
        _setDesktopScreenFs(false); // desktop: выйти из нативного fullscreen окна
    } else if (document.fullscreenElement === screenOverlay) {
        document.exitFullscreen?.();
    } else if (document.webkitFullscreenElement === screenOverlay) {
        document.webkitExitFullscreen?.();
    }
    screenOverlay.classList.remove("is-visible");
    hideOverlayElement(screenOverlay);
    if (screenOverlayVideo) {
        screenOverlayVideo.srcObject = null;
        screenOverlayVideo.muted = true;
    }
    screenOverlayTrackCleanup?.();
    screenOverlayTrackCleanup = null;
    screenOverlayUserId = null;
    if (!opts || !opts.preserveAutoReopen) {
        lastWatchedUserId = null;
        lastWatchedExpiresAt = 0;
    }
}

function toggleScreenFullscreen() {
    /* Desktop (WebView2): HTML Fullscreen API ломает аппаратный видео-путь
       (DirectComposition overlay) → демка виснет на 1 кадре. В оконном режиме
       видео идёт обычным compositing-путём и плавно. Поэтому делаем fullscreen
       НАТИВНО на окне Tauri, а оверлей (fixed inset:0 + .is-fullscreen) его
       заполняет — видео остаётся в плавном пути, titlebar прячется по CSS-классу
       html.screen-native-fs. На web — обычный HTML Fullscreen API (рабочий). */
    if (window.VoidPlatform === "desktop") {
        _setDesktopScreenFs(!_screenNativeFs);
        return;
    }
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
    /* С v0.9.16 — поверх unified toast-host (public/js/toasts.js). priority
       "warn" — это уведомления вроде screencast.busy / mic-lost: не
       критичная ошибка, но нужно внимание юзера. */
    window.VoidToast?.showToast(text, { priority: "warn" });
}
