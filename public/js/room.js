async function tryJoin() {
    if (isJoined) return;

    hideEntryError();

    const code = (codeInput.value || "").trim().toUpperCase();
    /* B16: проверяем по серверному формату (4-8 символов A-Z0-9), а не
       хардкодом length === 5. Иначе при смене длины в generateRoomCode
       клиент молча отказывал бы вводить валидный код. */
    if (!ROOM_CODE_RX.test(code)) {
        codeInput.focus();
        return;
    }

    currentRoomCode = code;

    try {
        await tryAcquireMic();
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

/**
 * Обёртка над initMedia() с pre-flight проверкой permission state.
 *
 * Зачем: на Chrome / Firefox / Android Chrome можно узнать состояние ДО
 * вызова getUserMedia — и реагировать осмысленно:
 *   - "denied" → не дёргаем getUserMedia вообще (он бросит NotAllowedError
 *     с дефолтным prompt-popup'ом дополнительно к нашей mic-blocked-модалке;
 *     лишний UI), сразу проваливаемся в catch → mic-blocked.
 *   - "prompt" → показываем info-тост «сейчас браузер спросит про микрофон»,
 *     чтобы юзер ожидал системный prompt и не растерялся (особенно на телефоне,
 *     где системный prompt появляется не у адресной строки).
 *   - "granted" → молча через.
 *
 * Safari iOS не поддерживает Permissions API для микрофона (бросает или
 * возвращает null) — тогда фоллбэк на старое поведение, прямой getUserMedia.
 *
 * User-gesture context: на iOS getUserMedia требует user-gesture в стеке.
 * Но iOS API не поддерживается → ветка `prompt` не запускается → await на
 * permissions.query не съест gesture. На Chrome activation окно ~5s,
 * await на быстрый query внутри click handler'а не критичен.
 */
async function tryAcquireMic() {
    let permState = null;
    if (navigator.permissions?.query) {
        try {
            const status = await navigator.permissions.query({ name: "microphone" });
            permState = status.state;
        } catch (_) {
            /* "microphone" name не поддержан (Safari) — фоллбэк на прямой getUserMedia. */
        }
    }

    if (permState === "denied") {
        throw new Error("mic-denied-preflight");
    }

    let previewToast = false;
    if (permState === "prompt") {
        window.VoidToast?.showToast(_t("hints.mic-permission-incoming"), {
            priority: "info",
            duration: 8000
        });
        previewToast = true;
    }

    try {
        await initMedia();
    } finally {
        /* clearToast снимает только тост (если есть), invite-hint при этом
           восстановится сам. Если другой код выставил свой тост между нами
           и initMedia — мы его погасим, но это edge-case без последствий
           (entry-флоу — единственный путь к tryAcquireMic). */
        if (previewToast) window.VoidToast?.clearToast();
    }
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
    /* Double-rAF: меняем класс is-visible через два кадра после
       removeClass+textContent, чтобы браузер успел применить «исходное»
       состояние и затем плавно перейти в is-visible. Без этого при
       повторном showEntryError'е (юзер несколько раз кликнул join до
       того как тост сам угас) перехода нет — класс уже стоял. */
    entryErrorEl.classList.remove("is-visible");
    entryErrorEl.setAttribute("aria-hidden", "false");

    requestAnimationFrame(() => {
        requestAnimationFrame(() => {
            entryErrorEl.classList.add("is-visible");
        });
    });

    /* Эвристика длительности: длинные тексты показываем дольше, минимум
       3 сек чтобы юзер успел прочитать «room-not-found» и т.п. */
    const displayMs = Math.max(3000, 1500 + text.length * 25);
    entryErrorHideTimer = setTimeout(() => {
        hideEntryError();
    }, displayMs);
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

    /* mic-blocked — особый кейс: пользователь не понимает что произошло
       и что делать. Короткий тост ему не объяснит. Открываем sticky-диалог
       с инструкцией; короткий тост через showEntryError тоже оставляем
       (как подложку, если модалку не получится открыть). */
    if (reason === "mic-blocked") {
        openMicBlockedModal();
    }
    showEntryError(reason);
}

function openMicBlockedModal() {
    if (!micBlockedModal) return;
    micBlockedModal.classList.add("is-open");
    micBlockedModal.removeAttribute("inert");
    micBlockedModal.setAttribute("aria-hidden", "false");
    setTimeout(() => micBlockedCloseBtn?.focus(), 60);

    // Esc — закрыть. Глобальный слушатель, чтобы не зависеть от фокуса
    // внутри модалки. Снимается в closeMicBlockedModal.
    _micBlockedEscHandler = (e) => {
        if (e.key === "Escape") {
            e.preventDefault();
            closeMicBlockedModal();
        }
    };
    document.addEventListener("keydown", _micBlockedEscHandler);
}

function closeMicBlockedModal() {
    if (!micBlockedModal) return;
    micBlockedModal.classList.remove("is-open");
    micBlockedModal.setAttribute("inert", "");
    micBlockedModal.setAttribute("aria-hidden", "true");
    if (_micBlockedEscHandler) {
        document.removeEventListener("keydown", _micBlockedEscHandler);
        _micBlockedEscHandler = null;
    }
}

/**
 * Полный сброс UI и сетевого состояния комнаты. Используется и при штатном leave,
 * и при потере соединения. НЕ отправляет ничего на сервер — это ответственность
 * вызывающего (leaveRoom отсылает leave-room до вызова, handleConnectionLost не отсылает).
 */
function tearDownRoomState() {
    closePingPanel();
    stopConnQualityMonitor();
    resetInviteHint();
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
    _peerTrouble = false;

    if (window.VoidDesktop) window.VoidDesktop.setTrayState({ inRoom: false, roomCode: null, micMuted: false, screenSharing: false });

    if (typeof closeInvitePanel === "function") closeInvitePanel();
    if (roomInfo) {
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
        /* F18: fallback таймер — `animationend` не всегда стреляет. */
        _onAnimationEndOrFallback(el);
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

function leaveRoom() {

    playLeaveSound();

    /* F10: 100ms ожидание flush не гарантировано на медленных аплинках —
       сообщение могло не выйти из TCP-буфера, и сервер чистил нас через
       60s heartbeat. Полагаемся на clean-close handshake (initiated в
       resetSocketConnection → socket.close(1000)): браузер flushит pending
       data ДО отправки FIN, а серверный handleDisconnect функционально
       эквивалентен handleLeaveRoom (broadcast participant-left +
       captureSessionDuration). Сообщение leave-room оставляем как
       «попытка дойти первым» — если успеет, отлично; нет — close-handler
       сервера сделает всё то же. */
    sendSocket({
        type: "leave-room",
        userId: clientId,
        room: currentRoomCode
    });

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
        await tryAcquireMic();
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

/* F20: «peer-trouble» — наслаивается ПОВЕРХ ws-состояния "connected".
   Когда сокет жив, но хотя бы один peer ушёл в failed / активно
   восстанавливается, индикатор показывает warn-pulse, чтобы юзер не
   видел зелёное "connected" пока его на самом деле не слышно. На
   ws-уровни (reconnecting/error/ready) флаг не влияет — там свой
   рендер с приоритетом. Обновляется из webrtc.js через setPeerTrouble. */
let _peerTrouble = false;

function setPeerTrouble(trouble) {
    const next = !!trouble;
    if (next === _peerTrouble) return;
    _peerTrouble = next;
    if (_lastConnState === "connected") {
        setConnectionState("connected", _lastConnOpts);
    }
}

function setConnectionState(state, opts = {}) {
    _lastConnState = state;
    _lastConnOpts = opts || {};
    if (!connDot || !connLabel) return;

    connDot.classList.remove("live", "warn", "pulse");

    if (state === "connected") {
        if (_peerTrouble) {
            connDot.classList.add("warn", "pulse");
            connLabel.textContent = _t("footer.unstable");
        } else {
            connDot.classList.add("live");
            connLabel.textContent = _t("footer.connected");
        }
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

    if (window.VoidDesktop) window.VoidDesktop.setTrayState({ inRoom: true, roomCode: currentRoomCode });

    if (app) app.dataset.mode = "room";

    roomInfo.classList.remove("hidden");

    renderRoomCodeLabel(currentRoomCode);

    addParticipant(clientId, currentUsername);
    applyAudioState();
    setConnectionState("connected");

    screencastBtn.classList.remove("control-btn-stub");
    screencastBtn.title = _t("controls.screencast.share");
    syncScreencastBtnBlocked();

    startConnQualityMonitor();

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