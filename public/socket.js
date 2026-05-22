/* ========= SOCKET ========= */

let socket = null;

/**
 * F9: «намеренное закрытие» теперь живёт на самом ws-объекте (`ws._intentional`),
 * а не в модульной переменной. Без этого быстрый leave→join создавал гонку:
 * новый сокет уже создан, но close-event СТАРОГО сокета ещё в очереди.
 * Старый handler смотрел на глобальный `intentionalClose`, который мог быть
 * сброшен новым connectSocket'ом, и портил новую сессию.
 * Также close-handler теперь проверяет `ws === socket`: events от устаревших
 * сокетов просто игнорятся, не трогая глобальную ссылку.
 */

/**
 * Расписание попыток реконнекта в миллисекундах. Подобрано так, чтобы за ~1 минуту
 * мы успели сделать ~8 попыток с растущими паузами между ними. Если за это время
 * связь не восстановилась — считаем, что соединение потеряно окончательно.
 */
const RECONNECT_DELAYS_MS = [1000, 2000, 4000, 8000, 10000, 10000, 10000, 10000];

let reconnectAttempt = 0;
let reconnectTimer = null;
let reconnecting = false;

/**
 * Поднимаем на ~10s после успешного реконнекта. Используется чтобы отличить
 * «свежий пользователь нажал join» от «WS только что мигнул, мы сами
 * перезаходим». Отличие важно для id-collision: сервер ещё не успел
 * отработать close старого ws (heartbeat 30s × 2), поэтому видит наш
 * `userId` живым и отдаёт `id-collision`. В этом окне такая ошибка —
 * не настоящий конфликт, а гонка реконнекта; молча ждём и пробуем ещё.
 */
let _wasReconnect = false;
let _wasReconnectClearTimer = null;
let _reconnectRejoinRetries = 0;
const _RECONNECT_REJOIN_MAX_RETRIES = 3;
// Базовая задержка перед первой повторной попыткой join после id-collision.
// Следующие попытки: base * 1.5^retry (1.5s, 2.25s, 3.375s).
const _RECONNECT_REJOIN_BASE_DELAY_MS = 1500;
const _WAS_RECONNECT_WINDOW_MS = 10000;

/**
 * F3: liveness watchdog. Сервер шлёт data-frame `{type:"keepalive"}` раз в
 * 30 секунд (HEARTBEAT_INTERVAL_MS на сервере). Если timeout секунд подряд
 * от сервера НИЧЕГО не пришло — значит TCP-туннель мёртв, хотя
 * `readyState===1` лжёт. Принудительно закрываем сокет, чтобы стандартный
 * reconnect-флоу подхватился.
 *
 * Desktop: 45s = 30s heartbeat + 15s страховки на сетевое дрожание.
 * Mobile (M5.3, v0.9.21): 35s — 4G→5G handoff и переход между башнями
 * рвут TCP-туннель чаще, чем стационарный Wi-Fi. Чем меньше timeout, тем
 * быстрее юзер видит «reconnecting…» и быстрее восстанавливается связь.
 * Меньше 35s не делаем: keepalive раз в 30s + jitter сети может дать
 * 32-33s между пакетами, false-positive разрыва.
 *
 * Любое входящее сообщение (keepalive, signalling, broadcast'ы) обнуляет таймер. */
const LIVENESS_TIMEOUT_MS = matchMedia("(hover: none) and (pointer: coarse)").matches
    ? 35_000
    : 45_000;
const LIVENESS_CHECK_MS = 10_000;
let _lastServerMsgAt = 0;
let _livenessTimer = null;

function startLivenessWatchdog() {
    stopLivenessWatchdog();
    _lastServerMsgAt = Date.now();
    _livenessTimer = setInterval(() => {
        if (!socket || socket.readyState !== 1) return;
        if (Date.now() - _lastServerMsgAt > LIVENESS_TIMEOUT_MS) {
            log.warn("ws", "liveness timeout, forcing reconnect");
            try { socket.close(); } catch (_) {}
        }
    }, LIVENESS_CHECK_MS);
}

function stopLivenessWatchdog() {
    if (_livenessTimer) {
        clearInterval(_livenessTimer);
        _livenessTimer = null;
    }
}

/**
 * F4: буфер исходящих на время разрыва WS. На реконнекте `handleSocketReconnected`
 * пере-анонсирует основное состояние (mic/screen — через applyAudioState,
 * nickname — через join-room), НО в окне между «WS уже мёртв» и «реконнект
 * заметил» юзер мог щёлкнуть микрофоном/настройкой ника несколько раз. Без
 * буфера эти изменения молча уйдут в null, потому что sendSocket no-op'ит при
 * readyState!==1. Кешируем последнее значение по типу (toggling mic 5 раз
 * подряд → буфер хранит финал), флашим после успешного user-list.
 *
 * Whitelist жёсткий: signalling (offer/answer/ice) НЕ буферим. После реконнекта
 * mesh пересобирается с нуля через closeRemotePeerConnections — старые SDP
 * и кандидаты устарели в момент close().
 */
const _BUFFERABLE_TYPES = new Set(["audio-state", "screencast-state", "nickname-update"]);
const _OUTGOING_BUFFER_TTL_MS = 10_000;
const _outgoingBuffer = new Map(); // type → {data, addedAt}

function flushOutgoingBuffer() {
    if (_outgoingBuffer.size === 0) return;
    if (!socket || socket.readyState !== 1) return;
    const now = Date.now();
    const queue = [..._outgoingBuffer.values()];
    _outgoingBuffer.clear();
    for (const entry of queue) {
        if (now - entry.addedAt > _OUTGOING_BUFFER_TTL_MS) continue;
        try { socket.send(JSON.stringify(entry.data)); } catch (_) {}
    }
}

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
    cancelReconnect();
    stopLivenessWatchdog();
    _outgoingBuffer.clear();
    if (socket) {
        /* F9: помечаем именно ЭТОТ ws — его close-handler потом увидит флаг и
           не запустит reconnect. Глобальной «намеренности» больше нет. */
        socket._intentional = true;
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

        let connectionResolved = false;
        // wss:// на HTTPS-странице, ws:// на http://localhost для разработки.
        // Браузер запрещает mixed content (https + ws), поэтому схема обязана совпадать.
        const wsScheme = window.location.protocol === "https:" ? "wss" : "ws";
        const ws = new WebSocket(`${wsScheme}://${window.location.host}`);
        /* F9: per-socket флаг «намеренного закрытия». Глобальной модульной
           переменной больше нет — она ломала рейс leave→join: новый ws
           создаётся, старый close-event прилетает позже и видит сброшенный
           глобал → запускает reconnect к мёртвому сокету. */
        ws._intentional = false;
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
                /* F3: любое входящее сообщение — признак, что туннель жив.
                   Обновляем timestamp до парсинга, чтобы даже невалидный JSON
                   (но реально пришедший с сервера) сбрасывал watchdog. */
                _lastServerMsgAt = Date.now();
                /* B8: битый JSON (поломанный промежуточным proxy фрейм, баг
                   сервера) не должен прокидывать throw в global error —
                   просто логируем и игнорируем сообщение. */
                let data;
                try {
                    data = JSON.parse(event.data);
                } catch (err) {
                    log.warn("ws", "invalid message", { err: err?.message || String(err) });
                    return;
                }
                handleSocketMessage(data);
            });

            startLivenessWatchdog();
            resolve();
        });

        ws.addEventListener("close", () => {
            /* F9: события устаревшего сокета (старый ws, чей close прилетел
               после того, как мы уже создали новый) — игнорируем, чтобы не
               перетереть `socket`-ссылку на актуальный ws и не запустить
               лишний reconnect. */
            if (socket !== null && socket !== ws) return;

            stopLivenessWatchdog();
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
            if (!ws._intentional && typeof isJoined !== "undefined" && isJoined) {
                scheduleReconnect(ws);
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
function scheduleReconnect(closedWs) {
    /* F19: раньше тут было `if (!socket || socket._intentional) return;` —
       и это был мёртвый сценарий. close-handler нулит socket ДО вызова
       scheduleReconnect, так что `!socket` всегда true → реконнект никогда
       не запускался. Пользователь терял аудио молча и видел «connected» в
       футере (setConnectionState("reconnecting") живёт только тут).
       Проверяем флаг на самом закрытом ws, который пришёл явным аргументом.
       attemptReconnect() ниже передаёт null — там проверять нечего,
       cancelReconnect() из resetSocketConnection всё равно прибил бы таймер. */
    if (closedWs && closedWs._intentional) return;

    reconnecting = true;

    if (reconnectAttempt >= RECONNECT_DELAYS_MS.length) {
        log.warn("ws", "reconnect attempts exhausted");
        cancelReconnect();
        if (typeof onReconnectFailed === "function") {
            onReconnectFailed();
        }
        return;
    }

    /* F15: jitter ±30% сверху, чтобы при массовом дисконнекте (рестарт сервера,
       проблема у провайдера на участке) клиенты не лупили синхронно одной
       волной — это thundering herd, сервер захлёбывается на open. */
    const baseDelay = RECONNECT_DELAYS_MS[reconnectAttempt];
    const delay = Math.round(baseDelay + Math.random() * baseDelay * 0.3);
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
    /* F9: «намеренное» означает «мы только что resetSocketConnection
       и socket=null». Если socket не null и НЕ помечен intentional —
       продолжаем попытку реконнекта. */
    if (socket && socket._intentional) return;
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
        // Сети нет — не тратим попытку, ждём события 'online'.
        log.debug("ws", "offline, defer reconnect");
        return;
    }

    try {
        await connectSocket();
        log.info("ws", "reconnected");
        _wasReconnect = true;
        if (_wasReconnectClearTimer) clearTimeout(_wasReconnectClearTimer);
        _wasReconnectClearTimer = setTimeout(() => {
            _wasReconnect = false;
            _wasReconnectClearTimer = null;
        }, _WAS_RECONNECT_WINDOW_MS);
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
        const intentional = socket?._intentional === true;
        if (reconnecting && !reconnectTimer && !intentional) {
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
        return;
    }
    /* F4: WS не готов — если тип буферизуемый, сохраняем последнее значение.
       После реконнекта flushOutgoingBuffer пройдётся по очереди. */
    if (data && _BUFFERABLE_TYPES.has(data.type)) {
        _outgoingBuffer.set(data.type, { data, addedAt: Date.now() });
    }
}

function handleSocketMessage(data) {
    switch (data.type) {
        case "keepalive":
            /* F3: серверный пульс. Сам факт получения сообщения уже сбросил
               liveness timer выше в onmessage; здесь просто признаём тип, чтобы
               не оставлять «висящих» сообщений в switch'е. */
            return;

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
            // id-collision сразу после WS-реконнекта — не настоящая ошибка, а
            // гонка с серверным heartbeat'ом: сервер ещё видит наш старый ws
            // как «живой», потому что close-фрейм с прошлого сокета не дошёл
            // (VPN-смена, RST вместо FIN). Не выкидываем юзера — ждём и
            // пересылаем join-room ещё раз; сервер прибьёт старый ws по
            // missed-pong в течение HEARTBEAT_INTERVAL_MS и пропустит нас.
            if (data.reason === "id-collision"
                && _wasReconnect
                && _reconnectRejoinRetries < _RECONNECT_REJOIN_MAX_RETRIES) {
                _reconnectRejoinRetries += 1;
                log.debug("ws", "id-collision on reconnect rejoin, retrying", {
                    attempt: _reconnectRejoinRetries,
                    max: _RECONNECT_REJOIN_MAX_RETRIES
                });
                const delay = Math.round(_RECONNECT_REJOIN_BASE_DELAY_MS * Math.pow(1.5, _reconnectRejoinRetries - 1));
                setTimeout(() => {
                    if (typeof isJoined !== "undefined" && isJoined && currentRoomCode) {
                        sendSocket({
                            type: "join-room",
                            code: currentRoomCode,
                            userId: clientId,
                            nickname: currentUsername
                        });
                    }
                }, delay);
                return;
            }
            _reconnectRejoinRetries = 0;
            if (typeof abortJoinAttempt === "function") {
                abortJoinAttempt(data.reason || "room-not-found");
            }
            break;

        case "audio-state":
            updateParticipantAudioState(data.userId, data.mic, data.sound);
            break;

        case "nickname-changed":
            /* Кто-то из соседей сменил ник в настройках. Обновляем кеш и
               перерисовываем blob (addParticipant идемпотентен — обновит имя
               in-place, не плодя дублей). Ping-панель и chat-инициалы читают
               nicknameMap при следующем re-render. */
            if (typeof nicknameMap !== "undefined" && typeof data.userId === "string") {
                nicknameMap.set(data.userId, data.nickname);
            }
            if (typeof addParticipant === "function") {
                addParticipant(data.userId, data.nickname);
            }
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
            /* B15: если ушедший участник был активным скринкастером — сбрасываем
               roomScreencasterId, иначе у остальных кнопка screencast навсегда
               остаётся «sc-btn-blocked» (лечилось только реджойном).
               preserveAutoReopen: сервер шлёт participant-left и при «реальном»
               уходе, и при WS-reconnect стримера (см. handlers.js handleJoinConfirm
               при ws.readyState!==1). Не сбрасываем lastWatched — если это
               реконнект, через секунду придёт new-participant + новый трек →
               auto-reopen восстановит просмотр. Если ушёл реально — TTL
               истечёт через 30s, ничего не сломается. */
            if (typeof roomScreencasterId !== "undefined" && roomScreencasterId === data.userId) {
                roomScreencasterId = null;
                if (typeof syncScreencastBtnBlocked === "function") syncScreencastBtnBlocked();
                if (typeof closeScreenOverlay === "function") closeScreenOverlay({ preserveAutoReopen: true });
            }
            removeParticipant(data.userId);
            // Закрываем peer + audio + analyser + health timer.
            cleanupPeerSlot(data.userId);
            break;

        case "new-participant":
            addParticipant(data.userId, data.nickname);
            /* F1: если в нашей карте peer'ов уже есть запись под тем же userId —
               это призрак прошлой сессии (тот человек реконнектился). Сервер
               только что подтвердил, что под этим userId сидит свежий сокет,
               значит наш старый peer заведомо мёртв. Без явного cleanup ICE
               state machine будет ждать grace (5s) + restart (8s) + polite
               passive (15s) — до 28 секунд тишины. Сносим сразу, callUser
               создаст новый peer и handshake пройдёт заново. */
            if (peers.has(data.userId)) {
                log.debug("ws", "stale peer on new-participant, rebuilding", { userId: data.userId });
                cleanupPeerSlot(data.userId);
            }
            callUser(data.userId);
            break;

        case "user-list":
            // Любой user-list — это успешное вхождение. Сбрасываем счётчик
            // повторных попыток после reconnect-collision.
            _reconnectRejoinRetries = 0;
            if (!isJoined) {
                enterRoomUI();
            } else {
                if (typeof setConnectionState === "function") {
                    // Реконнект-сценарий: enterRoomUI уже отработал ранее, нам
                    // нужно только вернуть индикатор в "connected" — mesh
                    // пересоберётся через приходящие следом new-participant /
                    // offer / answer.
                    setConnectionState("connected");
                }
                /* F4: дренируем буфер исходящих, накопленных пока WS был мёртв.
                   Делаем ДО applyAudioState/broadcastScreencastState — те же
                   типы (audio-state/screencast-state) сейчас будут отправлены
                   с актуальным локальным состоянием, перебивая буферные. */
                flushOutgoingBuffer();
                // Сервер при handleJoinConfirm сбрасывает наш `screen`, `mic`,
                // `sound` к дефолтам (true/true/false). Если до реконнекта мы
                // вещали или были в нестандартном audio-state — пере-анонсируем,
                // иначе у соседей UI-индикаторы (halo вокруг скринкастера,
                // muted/deaf-классы) не восстановятся.
                if (typeof applyAudioState === "function") {
                    applyAudioState();
                }
                if (typeof isScreencasting !== "undefined" && isScreencasting
                    && typeof broadcastScreencastState === "function") {
                    broadcastScreencastState(true);
                }
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
