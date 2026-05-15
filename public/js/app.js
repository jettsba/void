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
    roomToastEl = document.getElementById("roomToast");

    micBlockedModal      = document.getElementById("micBlockedModal");
    micBlockedCloseBtn   = document.getElementById("micBlockedClose");
    micBlockedBackdrop   = document.getElementById("micBlockedBackdrop");
    micBlockedCloseBtn?.addEventListener("click", closeMicBlockedModal);
    micBlockedBackdrop?.addEventListener("click", closeMicBlockedModal);

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
    }
    introInput.addEventListener("keydown", handleKeyPress);
    introInput.addEventListener("input", tryStartAudio);
    document.getElementById("introSubmitBtn")?.addEventListener("click", checkPassword);

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
    joinBtn.addEventListener("click", () => {
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
    codeInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") tryJoin();
    });

    roomInfo.addEventListener("click", async () => {
        try {
            await navigator.clipboard.writeText(currentRoomCode);
            dismissInviteHint(true);
            roomInfo.classList.add("room-info--copied");
            if (roomCopyFeedbackTimer) clearTimeout(roomCopyFeedbackTimer);
            roomCopyFeedbackTimer = setTimeout(() => {
                roomInfo.classList.remove("room-info--copied");
                roomCopyFeedbackTimer = null;
            }, 1000);
        } catch (e) {
            log.warn("ui", "copy to clipboard failed", { err: e?.message || String(e) });
        }
    });

    if (typeof initChat === "function") {
        initChat();
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

    if (!INTRO_ENABLED) {
        skipIntroAndShowApp();
    } else if (isIntroUnlockedInBrowser()) {
        skipIntroAndShowApp();
    } else {
        introInput.disabled = true;
        runIntroQuestionTyping();
    }
}
