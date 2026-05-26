/* ========= INIT ========= */

document.addEventListener("DOMContentLoaded", () => {
    init();
});

function init() {
    canvas = document.getElementById("background");
    ctx = canvas.getContext("2d");

    intro = document.getElementById("intro");
    introTitleText = document.getElementById("introTitleText");
    introCursor = document.getElementById("introCursor");
    introInput = document.getElementById("introInput");
    introError = document.getElementById("introError");
    app = document.querySelector(".app");

    controls = document.getElementById("controls");
    micBtn = document.getElementById("micBtn");
    soundBtn = document.getElementById("soundBtn");
    screencastBtn = document.getElementById("screencastBtn");

    scModal = document.getElementById("scModal");
    scNextBtn = document.getElementById("scNextBtn");

    screenOverlay = document.getElementById("screenOverlay");
    screenOverlayVideo = document.getElementById("screenOverlayVideo");

    micBlockedModal      = document.getElementById("micBlockedModal");
    micBlockedCloseBtn   = document.getElementById("micBlockedClose");
    micBlockedBackdrop   = document.getElementById("micBlockedBackdrop");
    micBlockedCloseBtn?.addEventListener("click", closeMicBlockedModal);
    micBlockedBackdrop?.addEventListener("click", closeMicBlockedModal);

    /* M3.3: на iOS/Android путь к разрешениям микрофона разный и совсем не
       похож на десктоп («адресная строка → иконка микрофона» для телефона
       просто не имеет смысла). Подменяем data-i18n ключ на платформенный
       один раз — locale-changed потом сам подхватит правильный перевод. */
    const _micBody = micBlockedModal?.querySelector(".mic-blocked-body");
    if (_micBody) {
        const ua = navigator.userAgent;
        const isIOS = /iPad|iPhone|iPod/.test(ua) && !window.MSStream;
        const isAndroid = /Android/.test(ua);
        if (isIOS) _micBody.setAttribute("data-i18n", "errors.mic-blocked.body.ios");
        else if (isAndroid) _micBody.setAttribute("data-i18n", "errors.mic-blocked.body.android");
        /* settings.js init мог уже сделать applyI18n до нас (порядок
           DOMContentLoaded-листенеров не гарантирован). Принудительный
           re-apply подхватит новый ключ; функция идемпотентна. */
        window.VoidI18n?.applyI18n?.();
    }

    ambientSound = document.getElementById("ambientSound");
    welcomeSound = document.getElementById("welcomeSound");
    joinSound = document.getElementById("joinSound");
    leaveSound = document.getElementById("leaveSound");

    joinBtn = document.getElementById("joinBtn");
    createBtn = document.getElementById("createBtn");
    codeInput = document.getElementById("codeInput");
    leaveBtn = document.getElementById("leaveBtn");
    participantsContainer = document.getElementById("participants");
    connDot = document.getElementById("connDot");
    connLabel = document.getElementById("connLabel");

    if (typeof MutationObserver !== "undefined" && participantsContainer) {
        participantsMutationObserver = new MutationObserver(queueSyncRoomPeersDataAttr);
        participantsMutationObserver.observe(participantsContainer, {
            childList: true,
            subtree: false,
            attributes: true,
            attributeFilter: ["class"]
        });
    }
    queueSyncRoomPeersDataAttr();

    roomInfo = document.getElementById("roomInfo");
    roomCodeText = document.getElementById("roomCodeText");
    invitePanel = document.getElementById("invitePanel");
    inviteCopyCode = document.getElementById("inviteCopyCode");
    inviteCopyLink = document.getElementById("inviteCopyLink");
    inviteCodeValue = document.getElementById("inviteCodeValue");

    entryErrorEl = document.getElementById("entryError");
    entryErrorTextEl = document.getElementById("entryErrorText");

    connState = document.getElementById("connState");
    pingPanel = document.getElementById("pingPanel");
    pingPanelList = document.getElementById("pingPanelList");

    connState.addEventListener("click", (e) => {
        if (!isJoined) return;
        e.stopPropagation();
        togglePingPanel();
    });
    connState.addEventListener("keydown", (e) => {
        if (!isJoined) return;
        if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            togglePingPanel();
        }
    });

    /* На тач-устройствах canvas скрыт (см. styles.css «MOBILE — touch fixes»).
       rAF-цикл там бесполезен и сжирает батарею — пропускаем инициализацию. */
    if (!matchMedia("(hover: none) and (pointer: coarse)").matches) {
        sizeCanvas();
        seedBlobs();
        paint();
        document.addEventListener("visibilitychange", () => {
            _canvasPaused = document.hidden;
        });
    }
    generateAndAssignUsername();
    /* Экспортируем «активный» ник в window, чтобы панель настроек могла
       подставить его в поле ввода (settings.js — отдельный IIFE и не видит
       script-scope let-переменные напрямую). Обновляется и при смене ника. */
    window.currentUsername = currentUsername;
    clientId = generateClientId();

    if (typeof setReconnectHandlers === "function") {
        setReconnectHandlers({
            onSuccess: handleSocketReconnected,
            onFailed: handleConnectionLost
        });
    }

    if (!matchMedia("(hover: none) and (pointer: coarse)").matches) {
        window.addEventListener("resize", sizeCanvas);
        /* visualViewport.resize срабатывает при браузерном zoom (Ctrl+/-) —
           обычный window.resize при zoom не диспатчится надёжно. Без этого
           canvas остаётся в старом масштабе и превращается в прямоугольник
           в верхнем углу до ручного refresh страницы. */
        if (window.visualViewport) {
            window.visualViewport.addEventListener("resize", sizeCanvas);
        }
    }

    /* === UI auto-scale resize hook ===
       Когда пользователь перетаскивает окно между мониторами разной
       плотности — screen.width меняется → пересчитываем --auto-scale.
       Inline-скрипт в <head> делает это один раз при загрузке, тут
       поддерживаем актуальность в живой сессии. */
    updateAutoScale();
    window.addEventListener("resize", updateAutoScale);
    /* M2.2: intro теперь <form id="introForm">. Submit-event универсален
       для любой клавиатуры (включая Android IME, где keydown('Enter')
       приходит как key="Unidentified"). Стрелка-кнопка type="submit"
       внутри формы — её клик тоже триггерит submit, отдельный handler
       на ней не нужен. */
    document.getElementById("introForm")?.addEventListener("submit", handleIntroSubmit);
    introInput.addEventListener("input", tryStartAudio);

    micBtn.addEventListener("click", toggleMic);
    soundBtn.addEventListener("click", toggleSound);
    screencastBtn.addEventListener("click", handleScreencastBtnClick);

    scModal.querySelectorAll(".sc-tiles").forEach(group => {
        group.addEventListener("click", e => {
            const tile = e.target.closest(".sc-tile");
            if (!tile) return;
            group.querySelectorAll(".sc-tile").forEach(t => t.classList.remove("sc-tile--active"));
            tile.classList.add("sc-tile--active");
        });
    });

    scModal.querySelector(".sc-modal-backdrop").addEventListener("click", closeScModal);

    scNextBtn.addEventListener("click", async () => {
        const res = parseInt(scModal.querySelector("#scRes .sc-tile--active")?.dataset.val ?? "1080");
        const fps = parseInt(scModal.querySelector("#scFps .sc-tile--active")?.dataset.val ?? "30");
        const captureAudio = document.getElementById("scAudio")?.checked ?? false;
        closeScModal();
        try {
            await startScreenShare(res, fps, captureAudio);
            isScreencasting = true;
            broadcastScreencastState(true);
            updateScreencastButton(true);
            updateParticipantScreenState(clientId, true);
        } catch (e) {
            log.debug("rtc", "screen share cancelled", { err: e?.message || String(e) });
        }
    });

    document.getElementById("screenOverlayClose").addEventListener("click", closeScreenOverlay);

    document.getElementById("screenOverlayFullscreen").addEventListener("click", toggleScreenFullscreen);

    const syncFullscreenClass = () => {
        const fsEl = document.fullscreenElement || document.webkitFullscreenElement;
        screenOverlay.classList.toggle("is-fullscreen", fsEl === screenOverlay);
    };
    document.addEventListener("fullscreenchange", syncFullscreenClass);
    document.addEventListener("webkitfullscreenchange", syncFullscreenClass);

    document.addEventListener("keydown", e => {
        if (e.key === "Escape" && screenOverlay.classList.contains("is-visible")) closeScreenOverlay();
    });

    /* F2: pagehide — единственный надёжный сигнал «вкладка уходит» (закрытие,
       reload, навигация назад на iOS Safari, перевод в bfcache). beforeunload
       блокирует bfcache и часто не стреляет на мобильных. Если мы в комнате —
       шлём leave-room синхронно, чтобы сервер сразу разослал participant-left,
       а не ждал 60 секунд heartbeat'а. */
    window.addEventListener("pagehide", () => {
        if (!isJoined) return;
        if (typeof socket === "undefined" || !socket || socket.readyState !== 1) return;
        try { socket.send(JSON.stringify({ type: "leave-room" })); } catch (_) {}
    });

    document.body.style.opacity = "1";
    setConnectionState("ready");

    createBtn.addEventListener("click", handleCreateClick);
    /* M2.2: entry теперь <form id="entryForm">. Submit-event ловит и
       клик по joinBtn (type="submit"), и Enter в codeInput с любой
       клавиатуры — в т.ч. Android IME, где keydown('Enter') не приходит
       как "Enter". */
    document.getElementById("entryForm")?.addEventListener("submit", (e) => {
        e.preventDefault();
        if (!isJoined) tryJoin();
    });
    leaveBtn.addEventListener("click", () => {
        if (isJoined) leaveRoom();
    });
    codeInput.addEventListener("input", () => {
        codeInput.value = codeInput.value.toUpperCase().replace(/[^A-Z0-9]/g, "");
        codeInput.closest(".entry-code-field")?.classList.toggle("has-value", codeInput.value.length > 0);
        hideEntryError();
    });

    codeInput.closest(".entry-code-field")?.addEventListener("click", () => {
        codeInput.focus();
    });

    roomInfo.addEventListener("click", (e) => {
        e.stopPropagation();
        toggleInvitePanel();
    });
    roomInfo.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            toggleInvitePanel();
        }
        if (e.key === "Escape" && inviteOpen) {
            closeInvitePanel();
            roomInfo.focus();
        }
    });

    inviteCopyCode.addEventListener("click", (e) => {
        e.stopPropagation();
        copyInviteValue(inviteCopyCode, currentRoomCode || "");
    });
    inviteCopyCode.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            copyInviteValue(inviteCopyCode, currentRoomCode || "");
        }
    });
    inviteCopyLink.addEventListener("click", (e) => {
        e.stopPropagation();
        if (!currentRoomCode) return;
        const link = `${location.origin}/?room=${encodeURIComponent(currentRoomCode)}`;
        copyInviteValue(inviteCopyLink, link);
    });
    invitePanel.addEventListener("click", (e) => {
        /* Клик по самой панели (между кнопками, по пустому padding'у) не должен
           всплывать до outside-handler и закрывать попап. */
        e.stopPropagation();
    });

    if (typeof initChat === "function") {
        initChat();
    }

    /* M5.1: на мобильном при фокусе на инпут поднимается виртуальная клавиатура
       и заслоняет сам инпут (особенно codeInput и chatInputEl, которые сидят
       в нижней половине экрана). visualViewport не уведомляет нас о поднятии
       клавиатуры синхронно — используем простой recipe: 300мс задержка
       (≈ время анимации клавиатуры) → scrollIntoView в центр.
       Только на тач-устройствах: на десктопе клавиатура виртуальная не
       поднимается, скролл был бы лишним. */
    if (matchMedia("(hover: none) and (pointer: coarse)").matches) {
        const _scrollIntoCenter = (el) => {
            setTimeout(() => {
                try { el.scrollIntoView({ block: "center", behavior: "smooth" }); }
                catch (_) { /* старые браузеры без options-form scrollIntoView */ }
            }, 300);
        };
        [introInput, codeInput, chatInputEl].forEach(el => {
            if (!el) return;
            el.addEventListener("focus", () => _scrollIntoCenter(el));
        });
    }

    /* Кастомный ник из настроек: при сохранении — обновляем currentUsername,
       nicknameMap для самого себя, и self-blob в DOM (addParticipant идемпотентен
       и переписывает имя на месте). Если сидим в комнате — шлём `nickname-update`
       на сервер, чтобы он разослал остальным `nickname-changed` и они тоже
       перерисовали ник без перезахода. */
    document.addEventListener("void:nickname-changed", (e) => {
        const stored = (e?.detail?.nickname || "").trim();
        currentUsername = stored && stored.length > 0 ? stored : generateUsername();
        window.currentUsername = currentUsername;
        if (typeof nicknameMap !== "undefined") {
            nicknameMap.set(clientId, currentUsername);
        }
        if (isJoined) {
            if (typeof addParticipant === "function") {
                addParticipant(clientId, currentUsername);
            }
            if (typeof sendSocket === "function") {
                sendSocket({ type: "nickname-update", nickname: currentUsername });
            }
        }
    });

    /* Invite-link auto-join: ?room=KX7A2 в адресе → подставить код и сразу
       запустить tryJoin(). Адрес чистим ДО входа — F5 после отказа от
       микрофона не должен снова дёргать auto-join (юзер залипнет). Сам
       tryJoin вешаем на void:app-unlocked, чтобы он сработал и при
       включённом intro (после прохождения вопроса), и при отключённом
       (сразу после skipIntroAndShowApp). Невалидный код игнорируем — попадёт
       в обычное лобби, как будто пришли по чистой ссылке. */
    consumeInviteLinkFromUrl();

    if (!INTRO_ENABLED) {
        skipIntroAndShowApp();
    } else if (isIntroUnlockedInBrowser()) {
        skipIntroAndShowApp();
    } else {
        introInput.disabled = true;
        runIntroQuestionTyping();
    }
}

/* ===== Invite popup ===== */

function toggleInvitePanel() {
    if (inviteOpen) closeInvitePanel();
    else openInvitePanel();
}

function openInvitePanel() {
    if (inviteOpen || !invitePanel || !roomInfo) return;
    if (!isJoined || !currentRoomCode) return;

    /* Один попап за раз — закрываем соседний (ping) если он открыт. */
    if (typeof closePingPanel === "function") closePingPanel();

    inviteOpen = true;
    invitePanel.classList.add("is-visible");
    invitePanel.setAttribute("aria-hidden", "false");
    roomInfo.setAttribute("aria-expanded", "true");

    /* Открыли попап — значит пригласительная подсказка свою роль отыграла. */
    if (typeof dismissInviteHint === "function") dismissInviteHint(true);

    inviteOutsideHandler = (e) => {
        if (roomInfo && roomInfo.contains(e.target)) return;
        closeInvitePanel();
    };
    setTimeout(() => {
        document.addEventListener("click", inviteOutsideHandler);
    }, 0);
}

function closeInvitePanel() {
    if (!inviteOpen) return;
    inviteOpen = false;

    if (invitePanel) {
        invitePanel.classList.remove("is-visible");
        invitePanel.setAttribute("aria-hidden", "true");
    }
    if (roomInfo) {
        roomInfo.setAttribute("aria-expanded", "false");
    }

    if (inviteOutsideHandler) {
        document.removeEventListener("click", inviteOutsideHandler);
        inviteOutsideHandler = null;
    }

    /* Все feedback-таймеры сбрасываем — иначе при следующем открытии «скопировано»
       мигнёт сразу, потому что таймер только-только успеет снять класс. */
    for (const [el, id] of inviteCopyFeedbackTimers) {
        clearTimeout(id);
        el.classList.remove("is-copied");
    }
    inviteCopyFeedbackTimers.clear();
}

async function copyInviteValue(rowEl, value) {
    if (!rowEl || !value) return;
    try {
        await navigator.clipboard.writeText(value);
    } catch (e) {
        log.warn("ui", "copy to clipboard failed", { err: e?.message || String(e) });
        return;
    }
    rowEl.classList.add("is-copied");
    const prev = inviteCopyFeedbackTimers.get(rowEl);
    if (prev) clearTimeout(prev);
    inviteCopyFeedbackTimers.set(rowEl, setTimeout(() => {
        rowEl.classList.remove("is-copied");
        inviteCopyFeedbackTimers.delete(rowEl);
    }, 1000));
}

/* ===== Invite-link auto-join =====
   1. Прочитать ?room=...
   2. Если валидный код — почистить URL через replaceState (важно: ДО tryJoin,
      чтобы F5 после mic-deny не повторил auto-join).
   3. Поставить код в codeInput, пометить has-value (визуально как ручной ввод).
   4. Подписаться на void:app-unlocked one-shot и оттуда дёрнуть tryJoin(). */
function consumeInviteLinkFromUrl() {
    let raw = null;
    try {
        raw = new URLSearchParams(location.search).get("room");
    } catch (_) {
        return;
    }
    if (!raw) return;

    /* Чистим URL независимо от валидности кода — мусор не должен висеть. */
    try { history.replaceState({}, "", location.pathname); } catch (_) {}

    const normalized = raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (!ROOM_CODE_RX.test(normalized)) return;

    if (codeInput) {
        codeInput.value = normalized;
        codeInput.closest(".entry-code-field")?.classList.add("has-value");
    }

    document.addEventListener("void:app-unlocked", () => {
        /* Двойной защитный пояс: если за время intro юзер уже сам вошёл —
           ничего не делаем. tryJoin сам себя проверит, но дешевле не дёргать. */
        if (isJoined) return;
        tryJoin();
    }, { once: true });
}

/* === UI auto-scale ===
   Пересчитывает корневой --auto-scale по screen.width (физическая CSS-ширина
   монитора). Используется при init() и на window.resize (если юзер
   перетащил окно между мониторами разной плотности).
   Формула — линейная, та же что в inline-скрипте <head>: на FHD ≈1.21,
   2K ≈1.86, 4K ≈3.14, пегается на 1.0/3.14 по краям.
   Браузерный zoom screen.width не трогает, поэтому zoom работает чисто. */
function updateAutoScale() {
    const w = (window.screen && window.screen.width) || window.innerWidth || 1920;
    let t = 1.4 * (w / 100) - 10;
    if (t < 14) t = 14;
    if (t > 44) t = 44;
    document.documentElement.style.setProperty("--auto-scale", (t / 14).toFixed(3));
}
