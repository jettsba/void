/* ========= SOCKET ========= */

let socket = null;

/**
 * intentionalClose === true означает, что сокет закрывает САМ пользователь
 * (leaveRoom, отмена входа, abortJoinAttempt). Только в этом случае мы НЕ
 * должны пытаться реконнектиться. Любое другое закрытие — аварийное.
 */
let intentionalClose = false;

/**
 * Расписание попыток реконнекта в миллисекундах. Подобрано так, чтобы за ~1 минуту
 * мы успели сделать ~8 попыток с растущими паузами между ними. Если за это время
 * связь не восстановилась — считаем, что соединение потеряно окончательно.
 */
const RECONNECT_DELAYS_MS = [1000, 2000, 4000, 8000, 10000, 10000, 10000, 10000];

let reconnectAttempt = 0;
let reconnectTimer = null;
let reconnecting = false;

/** Колбэки, которые вешает script.js — сообщить ему о ходе реконнекта. */
let onReconnectAttempt = null;     // (attempt, total) => void
let onReconnectSuccess = null;     // () => void  -> здесь script.js перезайдёт в комнату
let onReconnectFailed = null;      // () => void  -> здесь script.js выкидывает из комнаты

function setReconnectHandlers({ onAttempt, onSuccess, onFailed }) {
    onReconnectAttempt = onAttempt || null;
    onReconnectSuccess = onSuccess || null;
    onReconnectFailed = onFailed || null;
}

/** Закрыть сокет штатно (вызывается из script.js при leaveRoom / отмене). */
function resetSocketConnection() {
    intentionalClose = true;
    cancelReconnect();
    if (socket) {
        try {
            socket.close();
        } catch (_) {}
        socket = null;
    }
}

function cancelReconnect() {
    if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
    }
    reconnecting = false;
    reconnectAttempt = 0;
}

function connectSocket() {
    return new Promise((resolve, reject) => {

        if (socket && socket.readyState === 1) {
            resolve();
            return;
        }

        intentionalClose = false;

        let connectionResolved = false;
        // wss:// на HTTPS-странице, ws:// на http://localhost для разработки.
        // Браузер запрещает mixed content (https + ws), поэтому схема обязана совпадать.
        const wsScheme = window.location.protocol === "https:" ? "wss" : "ws";
        const ws = new WebSocket(`${wsScheme}://${window.location.host}`);
        socket = ws;

        const timeoutId = setTimeout(() => {
            if (!connectionResolved) {
                connectionResolved = true;
                try {
                    ws.close();
                } catch (_) {}
                socket = null;
                reject(new Error("timeout"));
            }
        }, 15000);

        ws.addEventListener("open", () => {
            if (connectionResolved) return;
            connectionResolved = true;
            clearTimeout(timeoutId);

            log.debug("ws", "connected");
            if (typeof setConnectionState === "function") {
                setConnectionState("connecting");
            }

            ws.addEventListener("message", (event) => {
                const data = JSON.parse(event.data);
                handleSocketMessage(data);
            });

            resolve();
        });

        ws.addEventListener("close", () => {
            if (!connectionResolved) {
                connectionResolved = true;
                clearTimeout(timeoutId);
                socket = null;
                reject(new Error("ws-closed"));
                return;
            }

            log.debug("ws", "socket closed");
            socket = null;

            // Аварийное закрытие во время активной комнаты — пробуем восстановиться.
            // Если пользователь сам нажал leave / мы вне комнаты — просто молчим.
            if (!intentionalClose && typeof isJoined !== "undefined" && isJoined) {
                scheduleReconnect();
            } else if (typeof setConnectionState === "function") {
                setConnectionState("ready");
            }
        });

        ws.addEventListener("error", () => {
            if (!connectionResolved) {
                connectionResolved = true;
                clearTimeout(timeoutId);
                try {
                    ws.close();
                } catch (_) {}
                socket = null;
                reject(new Error("ws-error"));
            }
            // Если уже подключены — реальную обработку сделает 'close', который придёт следом.
        });
    });
}

/**
 * Поставить следующую попытку реконнекта. Если попытки кончились — финальный фейл.
 * Вызывает onReconnectAttempt перед самой попыткой и onReconnectSuccess/Failed по результату.
 */
function scheduleReconnect() {
    if (intentionalClose) return;

    reconnecting = true;

    if (reconnectAttempt >= RECONNECT_DELAYS_MS.length) {
        log.warn("ws", "reconnect attempts exhausted");
        cancelReconnect();
        if (typeof onReconnectFailed === "function") {
            onReconnectFailed();
        }
        return;
    }

    const delay = RECONNECT_DELAYS_MS[reconnectAttempt];
    reconnectAttempt += 1;
    const total = RECONNECT_DELAYS_MS.length;

    if (typeof setConnectionState === "function") {
        setConnectionState("reconnecting", { attempt: reconnectAttempt, total });
    }
    if (typeof onReconnectAttempt === "function") {
        onReconnectAttempt(reconnectAttempt, total);
    }

    log.debug("ws", "reconnect attempt", { attempt: reconnectAttempt, total, delayMs: delay });

    reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        attemptReconnect();
    }, delay);
}

async function attemptReconnect() {
    if (intentionalClose) return;
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
        // Сети нет — не тратим попытку, ждём события 'online'.
        log.debug("ws", "offline, defer reconnect");
        return;
    }

    try {
        await connectSocket();
        log.info("ws", "reconnected");
        cancelReconnect();
        if (typeof onReconnectSuccess === "function") {
            onReconnectSuccess();
        }
    } catch (err) {
        log.debug("ws", "reconnect attempt failed", { err: err.message });
        scheduleReconnect();
    }
}

/**
 * Браузерные события сети — мгновенный сигнал что инет вернулся / пропал.
 * При возврате — если мы в режиме реконнекта, не ждём backoff-таймер, пробуем сразу.
 * При пропаже — отменяем активный таймер чтобы не тратить попытку впустую.
 */
if (typeof window !== "undefined") {
    window.addEventListener("online", () => {
        if (reconnecting && !reconnectTimer && !intentionalClose) {
            log.info("ws", "back online, retrying immediately");
            attemptReconnect();
        }
    });
    window.addEventListener("offline", () => {
        if (reconnectTimer) {
            clearTimeout(reconnectTimer);
            reconnectTimer = null;
        }
    });
}

function sendSocket(data) {
    if (socket && socket.readyState === 1) {
        socket.send(JSON.stringify(data));
    }
}

function handleSocketMessage(data) {
    switch (data.type) {
        case "room-created":
            if (data.success) {
                sendSocket({
                    type: "join-room-confirm",
                    code: data.code,
                    userId: clientId,
                    nickname: currentUsername
                });
            } else if (data.reason === "code-taken"
                && typeof retryCreateRoomAfterCollision === "function") {
                // Молча пробуем ещё раз с новым кодом. Пользователь даже не узнает.
                retryCreateRoomAfterCollision();
            } else if (typeof abortJoinAttempt === "function") {
                abortJoinAttempt(data.reason || "create-failed");
            }
            break;

        case "join-success":
            sendSocket({
                type: "join-room-confirm",
                code: data.code,
                userId: clientId,
                nickname: currentUsername
            });
            break;

        case "join-failed":
            if (typeof abortJoinAttempt === "function") {
                abortJoinAttempt(data.reason || "room-not-found");
            }
            break;

        case "audio-state":
            updateParticipantAudioState(data.userId, data.mic, data.sound);
            break;

        case "screencast-state":
            if (typeof handleScreencastStateMsg === "function") {
                handleScreencastStateMsg(data);
            }
            break;

        case "screencast-rejected":
            if (typeof handleScreencastRejected === "function") {
                handleScreencastRejected();
            }
            break;

        case "participant-left":
            removeParticipant(data.userId);
            // Закрываем peer + audio + analyser + health timer.
            cleanupPeerSlot(data.userId);
            break;

        case "new-participant":
            addParticipant(data.userId, data.nickname);
            callUser(data.userId);
            break;

        case "user-list":
            if (!isJoined) {
                enterRoomUI();
            } else if (typeof setConnectionState === "function") {
                // Реконнект-сценарий: enterRoomUI уже отработал ранее, нам нужно
                // только вернуть индикатор в "connected" — mesh пересоберётся
                // через приходящие следом new-participant / offer / answer.
                setConnectionState("connected");
            }
            data.users.forEach(user => {
                addParticipant(user.id, user.nickname);
                updateParticipantAudioState(user.id, user.mic, user.sound);
                if (user.screen && typeof handleScreencastStateMsg === "function") {
                    handleScreencastStateMsg({ userId: user.id, screen: true });
                }
            });
            break;

        case "offer":
            handleOffer(data);
            break;

        case "answer":
            handleAnswer(data);
            break;

        case "ice":
            handleIce(data);
            break;
    }
}
