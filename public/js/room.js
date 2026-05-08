async function tryJoin() {
    if (isJoined) return;

    hideEntryError();

    const code = (codeInput.value || "").trim().toUpperCase();
    if (code.length !== 5) {
        codeInput.focus();
        return;
    }

    currentRoomCode = code;

    try {
        await initMedia();
    } catch {
        abortJoinAttempt("mic-blocked");
        return;
    }

    try {
        await connectSocket();
    } catch {
        closeAllConnections();
        abortJoinAttempt("connection-failed");
        return;
    }

    sendSocket({
        type: "join-room",
        code,
        userId: clientId,
        nickname: currentUsername
    });
}

function hideEntryError() {
    clearTimeout(entryErrorHideTimer);
    entryErrorHideTimer = null;
    if (entryErrorEl) {
        entryErrorEl.classList.remove("is-visible");
        entryErrorEl.setAttribute("aria-hidden", "true");
    }
}

function showEntryError(reason) {
    const key = ENTRY_ERROR_KEYS.has(reason) ? reason : "unknown";
    const text = _t("errors." + key);
    if (!entryErrorEl || !entryErrorTextEl) return;

    clearTimeout(entryErrorHideTimer);
    entryErrorHideTimer = null;

    entryErrorTextEl.textContent = text;
    entryErrorEl.classList.remove("is-visible");
    entryErrorEl.setAttribute("aria-hidden", "false");

    requestAnimationFrame(() => {
        requestAnimationFrame(() => {
            entryErrorEl.classList.add("is-visible");
        });
    });

    entryErrorHideTimer = setTimeout(() => {
        hideEntryError();
    }, ENTRY_ERROR_DISPLAY_MS);
}

function abortJoinAttempt(reason) {
    // Если уже сидим в комнате (например, при реконнекте сервер ответил join-failed) —
    // надо полностью вернуться в entry-режим, не только закрыть пиров.
    if (isJoined) {
        tearDownRoomState();
    } else {
        closeAllConnections();
        if (typeof resetSocketConnection === "function") {
            resetSocketConnection();
        }
        currentRoomCode = null;
        setConnectionState("ready");
    }
    showEntryError(reason);
}

/**
 * Полный сброс UI и сетевого состояния комнаты. Используется и при штатном leave,
 * и при потере соединения. НЕ отправляет ничего на сервер — это ответственность
 * вызывающего (leaveRoom отсылает leave-room до вызова, handleConnectionLost не отсылает).
 */
function tearDownRoomState() {
    closePingPanel();
    if (typeof resetChatOnLeave === "function") {
        resetChatOnLeave();
    }

    if (isScreencasting) {
        stopScreenShare();
        isScreencasting = false;
    }
    roomScreencasterId = null;
    closeScreenOverlay();
    updateScreencastButton(false);
    screencastBtn.classList.add("control-btn-stub");
    screencastBtn.setAttribute("aria-disabled", "true");
    screencastBtn.title = _t("controls.screencast.soon");

    nicknameMap.clear();
    closeAllConnections();

    if (typeof resetSocketConnection === "function") {
        resetSocketConnection();
    }

    isJoined = false;
    currentRoomCode = null;

    if (roomCopyFeedbackTimer) {
        clearTimeout(roomCopyFeedbackTimer);
        roomCopyFeedbackTimer = null;
    }
    if (roomInfo) {
        roomInfo.classList.remove("room-info--copied");
        roomInfo.classList.add("hidden");
    }

    renderRoomCodeLabel(null);
    if (codeInput) {
        codeInput.value = "";
        codeInput.closest(".entry-code-field")?.classList.remove("has-value");
    }

    if (app) app.dataset.mode = "entry";

    hideEntryError();
    removeAllParticipants();
    setConnectionState("ready");

    // После выхода из комнаты пересобираем lobby-коннект, чтобы юзер снова
    // считался "active" в live-статистике пока он сидит в лобби.
    enterLobby();
}

/**
 * Вызывается из socket.js после успешного восстановления WebSocket-соединения.
 * Сервер нас в комнате уже не помнит — старые WebRTC-пиры мертвы по ICE-таймауту.
 * Сносим mesh (но НЕ микрофон), чистим UI участников и заново входим в комнату
 * под тем же clientId. Сервер пришлёт user-list → mesh пересоберётся автоматически.
 */
function handleSocketReconnected() {
    if (!isJoined || !currentRoomCode) return;

    log.info("ws", "rejoining after reconnect", { code: currentRoomCode });

    if (typeof closeRemotePeerConnections === "function") {
        closeRemotePeerConnections();
    }

    // Убираем всех участников из UI кроме себя — они переедут заново через user-list.
    document.querySelectorAll(".participant").forEach(el => {
        if (el.dataset.userId === clientId) return;
        if (el.classList.contains("pop-out")) return;

        const arc = el.querySelector(".volume-arc");
        if (arc) arc._cleanup?.();

        el.classList.remove("pop-in");
        el.classList.add("pop-out");
        el.addEventListener("animationend", () => el.remove(), { once: true });
    });

    // nicknameMap чистим, но себя оставляем — нужен для ping-панели и т.п.
    nicknameMap.clear();
    if (currentUsername) {
        nicknameMap.set(clientId, currentUsername);
    }

    setConnectionState("connecting");

    sendSocket({
        type: "join-room",
        code: currentRoomCode,
        userId: clientId,
        nickname: currentUsername
    });
}

/**
 * Вызывается из socket.js когда все попытки реконнекта исчерпаны.
 * Выкидываем пользователя из комнаты с тостом, не дёргая сервер (его всё равно нет).
 */
function handleConnectionLost() {
    if (!isJoined) return;

    log.warn("ws", "connection lost permanently, leaving room");

    playLeaveSound();
    tearDownRoomState();
    showEntryError("connection-lost");
}

async function leaveRoom() {

    playLeaveSound();

    // Сначала шлём leave-room (даём серверу шанс уведомить остальных),
    // потом ждём 100мс и сносим всё через общий helper. resetSocketConnection
    // внутри tearDownRoomState закроет сокет — повторный socket.close() не нужен.
    sendSocket({
        type: "leave-room",
        userId: clientId,
        room: currentRoomCode
    });

    await new Promise(r => setTimeout(r, 100));

    tearDownRoomState();
}

/**
 * Сколько раз молча перегенерировать код при коллизии (server вернёт code-taken).
 * 5 попыток с алфавитом 32^5 ≈ 33M кодов — вероятность исчерпать ничтожна,
 * это просто страховка от вечного цикла на случай бага сервера.
 */
const CREATE_ROOM_MAX_RETRIES = 5;
let createRoomRetryCount = 0;

async function handleCreateClick() {

    hideEntryError();

    try {
        await initMedia();
    } catch {
        abortJoinAttempt("mic-blocked");
        return;
    }

    try {
        await connectSocket();
    } catch {
        closeAllConnections();
        abortJoinAttempt("connection-failed");
        return;
    }

    setConnectionState("connecting");
    createRoomRetryCount = 0;
    sendCreateRoomAttempt();
}

/** Сгенерировать новый код и отправить create-room. Используется и при первой
 *  попытке, и при коллизии (room-created с reason="code-taken"). */
function sendCreateRoomAttempt() {
    currentRoomCode = generateRoomCode();
    sendSocket({
        type: "create-room",
        code: currentRoomCode,
        userId: clientId,
        nickname: currentUsername
    });
}

/** Вызывается из socket.js когда сервер ответил code-taken. Молча пробуем
 *  ещё раз с новым кодом. Если попытки исчерпаны — показываем ошибку. */
function retryCreateRoomAfterCollision() {
    createRoomRetryCount += 1;
    if (createRoomRetryCount >= CREATE_ROOM_MAX_RETRIES) {
        log.error("room", "create collision retries exhausted", { max: CREATE_ROOM_MAX_RETRIES });
        abortJoinAttempt("create-failed");
        return;
    }
    log.debug("room", "create collision, retry", { count: createRoomRetryCount, max: CREATE_ROOM_MAX_RETRIES });
    sendCreateRoomAttempt();
}

function setConnectionState(state, opts = {}) {
    _lastConnState = state;
    _lastConnOpts = opts || {};
    if (!connDot || !connLabel) return;

    connDot.classList.remove("live", "warn", "pulse");

    if (state === "connected") {
        connDot.classList.add("live");
        connLabel.textContent = _t("footer.connected");
        return;
    }

    if (state === "reconnecting") {
        connDot.classList.add("warn", "pulse");
        if (opts.attempt && opts.total) {
            connLabel.textContent = _t("footer.reconnecting.attempt", {
                attempt: opts.attempt, total: opts.total
            });
        } else {
            connLabel.textContent = _t("footer.reconnecting");
        }
        return;
    }

    if (state === "error") {
        connDot.classList.add("warn");
        connLabel.textContent = _t("footer.error");
        return;
    }

    if (state === "connecting") {
        connLabel.textContent = _t("footer.connecting");
        return;
    }

    connLabel.textContent = _t("footer.ready");
}

function enterRoomUI() {

    hideEntryError();

    isJoined = true;

    if (app) app.dataset.mode = "room";

    roomInfo.classList.remove("hidden");

    renderRoomCodeLabel(currentRoomCode);

    addParticipant(clientId, currentUsername);
    applyAudioState();
    setConnectionState("connected");

    screencastBtn.classList.remove("control-btn-stub");
    screencastBtn.title = _t("controls.screencast.share");
    syncScreencastBtnBlocked();

    playJoinSound();
}

/* ========= LOCALE / STREAMER REACT =========
   После смены языка перерисовываем те куски UI, чьё содержимое не выражено
   через data-i18n: динамические надписи коннекта, код комнаты, title кнопки
   скринкаста, а также текстовое содержимое уже отрисованных watch-кнопок. */
document.addEventListener("void:locale-changed", () => {
    setConnectionState(_lastConnState, _lastConnOpts);
    renderRoomCodeLabel(currentRoomCode);

    if (screencastBtn) {
        if (screencastBtn.classList.contains("control-btn-stub")) {
            screencastBtn.title = _t("controls.screencast.soon");
        } else {
            const isOn = screencastBtn.classList.contains("active");
            screencastBtn.title = isOn ? _t("controls.screencast.stop") : _t("controls.screencast.share");
        }
    }
});

document.addEventListener("void:streamer-changed", () => {
    renderRoomCodeLabel(currentRoomCode);
});