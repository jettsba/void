/* ========= WS MESSAGE HANDLERS =========
 * Бизнес-логика room lifecycle: hello / create-room / join-room /
 * join-room-confirm / audio-state / screencast-state / leave-room /
 * disconnect / signal (offer/answer/ice).
 *
 * Состояние (rooms, stats) — через импорты из state.js / stats.js.
 * Ничего не знают про http/express/ws-сервер: чистые функции (ws, data) → effect.
 */

import crypto from "node:crypto";
import { log } from "./log.js";
import { rooms, stats } from "./state.js";
import { bumpDaily, scheduleStatsWrite, captureSessionDuration, updatePeaks, pushIceFailure } from "./stats.js";
import {
    MAX_ROOM_USERS,
    MSG_BUCKET_CAPACITY,
    MSG_BUCKET_REFILL_PER_SEC,
    EMPTY_ROOM_TTL_MS,
    isValidCode,
    isValidUserId,
    sanitizeNickname,
    noteFailedJoin,
    isIpBlocked,
    clearFailedJoins,
} from "./security.js";

/**
 * F11: безопасный broadcast по всем участникам комнаты. Каждый `ws.send`
 * обёрнут в try/catch, чтобы синхронное исключение (race в ws-library между
 * `readyState===1` check и фактическим send) не прервало рассылку посреди
 * `forEach`. До этого фикса часть участников могла не получить broadcast,
 * если один сокет вырубался ровно в момент отправки.
 *
 * Параметры:
 *   room        — объект из rooms Map
 *   message     — объект (будет JSON.stringify один раз снаружи цикла)
 *   exceptUserId? — userId, которого пропустить (обычно сам автор события)
 */
function broadcastToRoom(room, message, exceptUserId) {
    if (!room) return;
    const payload = JSON.stringify(message);
    room.users.forEach((u, id) => {
        if (exceptUserId !== undefined && id === exceptUserId) return;
        if (u.ws.readyState !== 1) return;
        try {
            u.ws.send(payload);
        } catch (err) {
            log.warn("ws", "broadcast send failed", { userId: id, err: err?.message || String(err) });
        }
    });
}

export function consumeToken(ws) {
    const b = ws._bucket;
    if (!b) return true;
    const now = Date.now();
    const elapsed = (now - b.lastRefill) / 1000;
    if (elapsed > 0) {
        b.tokens = Math.min(
            MSG_BUCKET_CAPACITY,
            b.tokens + elapsed * MSG_BUCKET_REFILL_PER_SEC
        );
        b.lastRefill = now;
    }
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
}

/**
 * Клиент шлёт hello один раз — сразу после открытия вкладки (когда сгенерил
 * себе clientId/nickname). На сервере это считается "регистрацией". На один
 * сокет принимаем максимум один hello, повторы игнорируем (защита от
 * случайного двойного отправления; reconnect клиент тоже не должен слать
 * повторно).
 */
export function handleHello(ws) {
    if (ws._registered) return;
    ws._registered = true;
    stats.usersRegistered += 1;
    bumpDaily("usersRegistered");
    scheduleStatsWrite();
}

export function handleCreateRoom(ws, data) {

    const { code } = data;

    if (!isValidCode(code)) {
        ws.send(JSON.stringify({
            type: "room-created",
            success: false,
            reason: "invalid-code"
        }));
        return;
    }

    if (rooms.has(code)) {
        ws.send(JSON.stringify({
            type: "room-created",
            success: false,
            reason: "code-taken"
        }));
        return;
    }

    /** Если в течение TTL не пришёл join-room-confirm — комнату удаляем,
        чтобы её нельзя было заюзать как memory-DoS вектор. */
    const room = {
        users: new Map(),
        cleanupTimer: null
    };
    /* F16: timer мог попасть в очередь event loop'а ДО того, как
       clearTimeout вызвался (например, между двумя WS-сообщениями).
       Проверяем что (а) timer ещё привязан к этой room (clearTimeout
       сбрасывает room.cleanupTimer = null) и (б) под кодом всё ещё ИМЕННО
       эта room (новый create-room после быстрого исчезновения мог
       перезаписать запись с тем же кодом). Без этих проверок коллбек мог
       удалить чужую свежую комнату. */
    const cleanupTimer = setTimeout(() => {
        if (room.cleanupTimer === null) return;
        if (rooms.get(code) !== room) return;
        if (room.users.size > 0) return;
        rooms.delete(code);
        log.info("room", "expired empty", { code });
    }, EMPTY_ROOM_TTL_MS);
    cleanupTimer.unref?.();
    room.cleanupTimer = cleanupTimer;

    rooms.set(code, room);

    stats.roomsCreated += 1;
    bumpDaily("roomsCreated");
    updatePeaks();
    scheduleStatsWrite();

    /** Разрешает ровно один последующий join-room-confirm на этот код с этого сокета. */
    ws.authorizedJoinCode = code;

    ws.send(JSON.stringify({
        type: "room-created",
        success: true,
        code
    }));

    log.info("room", "created", { code, ip: ws._ip });
}

export function handleJoinRoom(ws, data) {

    const { code } = data;

    if (isIpBlocked(ws._ip)) {
        ws.send(JSON.stringify({
            type: "join-failed",
            reason: "rate-limited"
        }));
        return;
    }

    if (!isValidCode(code)) {
        noteFailedJoin(ws._ip);
        ws.send(JSON.stringify({
            type: "join-failed",
            reason: "invalid-code"
        }));
        return;
    }

    if (!rooms.has(code)) {
        noteFailedJoin(ws._ip);
        ws.send(JSON.stringify({
            type: "join-failed",
            reason: "room-not-found"
        }));
        return;
    }

    const room = rooms.get(code);
    if (room.users.size >= MAX_ROOM_USERS) {
        ws.send(JSON.stringify({
            type: "join-failed",
            reason: "room-full"
        }));
        return;
    }

    ws.authorizedJoinCode = code;

    ws.send(JSON.stringify({
        type: "join-success",
        code
    }));
}

export function handleJoinConfirm(ws, data) {

    const { code, userId } = data;

    if (ws.authorizedJoinCode !== code) {
        ws.send(JSON.stringify({
            type: "join-failed",
            reason: "join-session-invalid"
        }));
        return;
    }

    ws.authorizedJoinCode = undefined;

    if (!isValidCode(code)) {
        ws.send(JSON.stringify({
            type: "join-failed",
            reason: "invalid-code"
        }));
        return;
    }

    if (!isValidUserId(userId)) {
        ws.send(JSON.stringify({
            type: "join-failed",
            reason: "invalid-user-id"
        }));
        return;
    }

    const cleanNick = sanitizeNickname(data.nickname);
    if (!cleanNick) {
        ws.send(JSON.stringify({
            type: "join-failed",
            reason: "invalid-nickname"
        }));
        return;
    }

    const room = rooms.get(code);

    if (!room) {
        ws.send(JSON.stringify({
            type: "join-failed",
            reason: "room-not-found"
        }));
        return;
    }

    // Комната получает первого подтверждённого юзера — TTL больше не нужен.
    if (room.cleanupTimer) {
        clearTimeout(room.cleanupTimer);
        room.cleanupTimer = null;
    }

    /**
     * Защита от hijack'а и обработка реконнекта одного и того же userId.
     *
     * Случаи:
     *  - existing.ws === ws — повторный confirm на том же сокете, no-op (упадём
     *    дальше через `room.users.set`).
     *  - existing.ws.readyState === 1 — другой ЖИВОЙ сокет держит userId.
     *    Это либо реальный hijack-attempt (отказываем), либо реконнект, где
     *    старый ws ещё живёт в глазах сервера — клиент через id-collision
     *    подождёт heartbeat'а и пробует ещё (см. socket.js _wasReconnect).
     *  - existing.ws.readyState !== 1 — старый ws УЖЕ дохлый (closing/closed),
     *    но его close-event ещё не успел отработать → handleDisconnect ещё
     *    впереди. Если просто перезаписать слот, потом close-event сравнит
     *    `existing.ws === ws` и СКИПНЕТ broadcast `participant-left` (потому
     *    что существующая запись уже наша новая). У других в DOM накопится
     *    дубль участника. Поэтому здесь явно гасим старую сессию: фиксируем
     *    её время в статистике, освобождаем слот, рассылаем participant-left
     *    и нейтрализуем будущий handleDisconnect через обнуление roomCode.
     */
    const existing = room.users.get(userId);
    if (existing && existing.ws !== ws) {
        if (existing.ws.readyState === 1) {
            ws.send(JSON.stringify({
                type: "join-failed",
                reason: "id-collision"
            }));
            return;
        }
        captureSessionDuration(existing.ws);
        existing.ws.roomCode = undefined;
        existing.ws.userId = undefined;
        room.users.delete(userId);
        broadcastToRoom(room, { type: "participant-left", userId });
    }

    // После возможного delete выше — проверяем capacity заново.
    if (!room.users.has(userId) && room.users.size >= MAX_ROOM_USERS) {
        ws.send(JSON.stringify({
            type: "join-failed",
            reason: "room-full"
        }));
        return;
    }

    ws.roomCode = code;
    ws.userId = userId;
    /* F12: ставим _joinedAt ДО room.users.set, чтобы между set и присваиванием
       не существовало окна, в котором ws закроется (close-event придёт в next
       tick) и handleDisconnect запишет сессию с `_joinedAt === undefined`. */
    ws._joinedAt = Date.now();

    room.users.set(userId, {
        ws,
        nickname: cleanNick,
        mic: true,
        sound: true,
        screen: false
    });

    if (room.users.size > MAX_ROOM_USERS) {
        room.users.delete(userId);
        ws.roomCode = undefined;
        ws.userId = undefined;
        ws.send(JSON.stringify({
            type: "join-failed",
            reason: "room-full"
        }));
        return;
    }

    // Успешный вход — IP больше не подозрителен.
    clearFailedJoins(ws._ip);

    const usersList = [];

    room.users.forEach((user, id) => {
        if (id !== userId) {
            usersList.push({
                id,
                nickname: user.nickname,
                mic: user.mic,
                sound: user.sound,
                screen: user.screen
            });
        }
    });

    ws.send(JSON.stringify({
        type: "user-list",
        users: usersList
    }));

    // Сообщаем остальным, что появился новый
    broadcastToRoom(room, {
        type: "new-participant",
        userId,
        nickname: cleanNick,
        screen: false
    }, userId);

    updatePeaks();
    scheduleStatsWrite();

    log.info("room", "joined", { code, userId, nick: cleanNick });
}

export function handleScreencastState(ws, data) {
    const room = rooms.get(ws.roomCode);
    if (!room) return;

    const user = room.users.get(ws.userId);
    if (!user || user.ws !== ws) return;

    /* Single-sharer enforcement (B13). Проверка «никто другой не шарит» и
       установка `user.screen` — один синхронный блок без `await` между ними.
       Node single-threaded: даже если два юзера прислали `screen:true`
       одновременно, их сообщения обрабатываются по очереди event-loop'ом —
       второй уже увидит `u.screen === true` от первого и получит reject.
       Это корректно атомарно по построению; при будущем рефакторинге держать
       проверку и присваивание в одном synchronous-блоке (никаких async
       операций между ними). */
    if (data.screen) {
        for (const [id, u] of room.users) {
            if (id !== ws.userId && u.screen) {
                ws.send(JSON.stringify({ type: "screencast-rejected" }));
                return;
            }
        }
    }

    user.screen = !!data.screen;

    broadcastToRoom(room, {
        type: "screencast-state",
        userId: ws.userId,
        screen: user.screen
    }, ws.userId);
}

/**
 * Смена ника на лету из настроек (см. public/js/app.js `void:nickname-changed`).
 * Поле `nickname` гоняется через тот же `sanitizeNickname`, что и при join — пустой
 * (после санитайза) игнорим. Сервер хранит ник в `room.users[userId].nickname` —
 * обновляем и рассылаем остальным `nickname-changed`. Себе эхо не шлём: клиент уже
 * локально обновил ник перед отправкой.
 */
export function handleNicknameUpdate(ws, data) {

    const room = rooms.get(ws.roomCode);
    if (!room) return;

    const user = room.users.get(ws.userId);
    if (!user || user.ws !== ws) return;

    const cleanNick = sanitizeNickname(data.nickname);
    if (!cleanNick) return;

    if (user.nickname === cleanNick) return;

    user.nickname = cleanNick;

    broadcastToRoom(room, {
        type: "nickname-changed",
        userId: ws.userId,
        nickname: cleanNick
    }, ws.userId);
}

export function handleAudioState(ws, data) {

    const room = rooms.get(ws.roomCode);
    if (!room) return;

    const user = room.users.get(ws.userId);
    if (!user || user.ws !== ws) return;

    user.mic = !!data.mic;
    user.sound = !!data.sound;

    broadcastToRoom(room, {
        type: "audio-state",
        userId: ws.userId,
        mic: user.mic,
        sound: user.sound
    }, ws.userId);
}

export function handleLeaveRoom(ws) {

    const code = ws.roomCode;
    if (!code) return;

    const userId = ws.userId;
    const roomData = rooms.get(code);
    if (!roomData) return;

    const existing = roomData.users.get(userId);
    if (!existing || existing.ws !== ws) return;

    roomData.users.delete(userId);
    ws.roomCode = undefined;
    ws.userId = undefined;
    captureSessionDuration(ws);

    broadcastToRoom(roomData, { type: "participant-left", userId });

    if (roomData.users.size === 0) {
        if (roomData.cleanupTimer) {
            clearTimeout(roomData.cleanupTimer);
            roomData.cleanupTimer = null;
        }
        rooms.delete(code);
        log.info("room", "deleted", { code });
    }
}

export function handleDisconnect(ws) {

    if (!ws.roomCode) return;

    const room = rooms.get(ws.roomCode);
    if (!room) return;

    const userId = ws.userId;
    const existing = room.users.get(userId);

    if (existing && existing.ws === ws) {
        room.users.delete(userId);
        captureSessionDuration(ws);

        broadcastToRoom(room, { type: "participant-left", userId });
    }

    if (room.users.size === 0) {
        if (room.cleanupTimer) {
            clearTimeout(room.cleanupTimer);
            room.cleanupTimer = null;
        }
        rooms.delete(ws.roomCode);
    }

    log.debug("ws", "client disconnected", { ip: ws._ip });
}

/**
 * T1.1: обработка leave-сигнала из `navigator.sendBeacon` (см. lib/leave-beacon.js).
 * Аналог `handleLeaveRoom`, но без `ws` — параметры взяты из HTTP body и уже
 * провалидированы в endpoint'е. Используем ws, лежащий в `room.users[userId]`,
 * чтобы зафиксировать session-duration и обнулить roomCode (это нейтрализует
 * последующий handleDisconnect от того же ws — он увидит roomCode=undefined и
 * выйдет рано, не дублируя broadcast).
 *
 * Идемпотентен: юзера нет → no-op. Это важно, потому что beacon и WS leave-room
 * могут прилететь оба — кто первый, тот и сработает.
 */
export function handleBeaconLeave(code, userId) {
    const room = rooms.get(code);
    if (!room) return;

    const existing = room.users.get(userId);
    if (!existing) return;

    room.users.delete(userId);

    if (existing.ws) {
        existing.ws.roomCode = undefined;
        existing.ws.userId = undefined;
        captureSessionDuration(existing.ws);
    }

    broadcastToRoom(room, { type: "participant-left", userId });

    if (room.users.size === 0) {
        if (room.cleanupTimer) {
            clearTimeout(room.cleanupTimer);
            room.cleanupTimer = null;
        }
        rooms.delete(code);
        log.info("room", "deleted via beacon", { code });
    }

    log.debug("beacon", "leave processed", { code, userId });
}

/**
 * Клиент сообщает, чем собралось peer-соединение: "direct" (host/srflx/prflx),
 * "relay" (через TURN) или "failed" (ушёл в "failed", не соединившись). Один
 * отчёт на peer-объект. Копим счётчики, чтобы по реальным данным решить —
 * нужен ли TURN. Принимаем только от юзеров внутри комнаты — мусор/спам вне
 * комнат отсекаем (плюс уже работает token-bucket в server.js).
 */
const ICE_RESULT_FIELD = {
    direct: "iceDirect",
    relay: "iceRelay",
    failed: "iceFailed"
};

/**
 * Короткий непрозрачный ref комнаты для failure-лога: позволяет увидеть, что два
 * провала — из одной комнаты (обе стороны пары репортят независимо), НЕ раскрывая
 * сам код. Соль на процесс обязательна: код комнаты короткий, несолёный хеш
 * перебирается за секунды, а код — это ключ входа в комнату.
 */
const _roomRefSalt = crypto.randomBytes(16);
function roomRef(code) {
    return crypto.createHash("sha256")
        .update(_roomRefSalt)
        .update(String(code))
        .digest("hex")
        .slice(0, 6);
}

export function handleIceReport(ws, data) {
    if (!ws.roomCode || !ws.userId) return;

    const field = ICE_RESULT_FIELD[data.result];
    if (!field) return;

    stats[field] += 1;
    bumpDaily(field);

    /* К failed клиент прикладывает диагностический слепок (типы кандидатов,
       состояния пар, ошибки STUN/TURN) — копим последние N для админки.
       pushIceFailure сам санитизирует payload: он клиентский и уедет в HTML. */
    if (data.result === "failed" && data.diag) {
        pushIceFailure({ ...data.diag, at: Date.now(), room: roomRef(ws.roomCode) });
        return; // pushIceFailure уже дёрнул scheduleStatsWrite
    }

    scheduleStatsWrite();
}

export function handleSignal(ws, data) {

    if (!ws.roomCode || !ws.userId) return;

    const room = rooms.get(ws.roomCode);
    if (!room) return;

    if (typeof data.to !== "string") return;

    const targetUser = room.users.get(data.to);
    if (!targetUser || targetUser.ws.readyState !== 1) return;

    /**
     * Whitelist полей + структурная валидация (S-L2). Раньше тут был spread
     * `...data` после `from: ws.userId`, из-за чего payload-овский `from`
     * ПЕРЕТИРАЛ серверный — атакующий мог подделать источник signaling (S-C3).
     * Теперь явно перечисляем ровно те поля, которые ожидает клиент
     * (`public/webrtc.js`), и проверяем форму payload'а:
     *  - offer:  { offer:{type:"offer", sdp:string}, rebuild? }
     *  - answer: { answer:{type:"answer", sdp:string} }
     *  - ice:    { candidate:object|null }
     *
     * Лимит длины SDP — 48 КБ. Минимальный mesh-handshake укладывается в
     * 1-3 КБ, но скринкаст добавляет ещё 2 m-line'а (video + screen-audio),
     * VP9 codec preference и x-google-* fmtp-патчи расширяют каждую m-секцию.
     * Главное: при цикле stopScreenShare → startScreenShare Chrome может
     * НЕ переиспользовать transceiver'ы (если direction шифтится из sendrecv
     * в inactive/recvonly), и каждый ре-старт добавляет m-line'ы поверх
     * старых. За 2-3 цикла SDP перерастал 16 КБ → сервер тихо дропал offer →
     * negotiation навсегда зависала в have-local-offer (баг чёрного экрана
     * в v0.9.10-0.9.12). 48 КБ (v0.9.21) даёт запас на 5-mesh + screencast
     * с несколькими циклами re-share без риска упереться в лимит, и при
     * этом остаётся под WS max payload (64 КБ) с JSON-overhead'ом.
     * Клиентский soft warn в [public/webrtc.js] оставлен на 24 КБ — это
     * раннее предупреждение об утечке m-line'ов, не близость к серверному лимиту. */
    const MAX_SDP_BYTES = 48 * 1024;
    const out = {
        type: data.type,
        from: ws.userId,
        to: data.to
    };

    if (data.type === "offer") {
        if (!isValidSdp(data.offer, "offer", MAX_SDP_BYTES)) return;
        out.offer = data.offer;
        if (data.rebuild === true) out.rebuild = true;
    } else if (data.type === "answer") {
        if (!isValidSdp(data.answer, "answer", MAX_SDP_BYTES)) return;
        out.answer = data.answer;
    } else if (data.type === "ice") {
        if (!isValidIceCandidate(data.candidate)) return;
        out.candidate = data.candidate;
    } else {
        return;
    }

    targetUser.ws.send(JSON.stringify(out));
}

/**
 * RTCSessionDescription по спеке: `{type:"offer"|"answer"|"pranswer"|"rollback", sdp:string}`.
 * Принимаем offer/answer, sdp обязан быть строкой в пределах лимита. Жёсткий
 * парсинг SDP не делаем — браузер всё равно прогонит через `setRemoteDescription`,
 * наша задача только обрезать заведомо невалидное и слишком крупное.
 */
function isValidSdp(desc, expectedType, maxBytes) {
    if (!desc || typeof desc !== "object") return false;
    if (desc.type !== expectedType) return false;
    if (typeof desc.sdp !== "string") return false;
    if (desc.sdp.length === 0 || desc.sdp.length > maxBytes) return false;
    return true;
}

/**
 * RTCIceCandidate приходит как `{candidate, sdpMid, sdpMLineIndex, ...}` ИЛИ
 * `null` (end-of-candidates сигнал, всё ещё валиден). Полей много, проверять
 * каждое — overkill; ограничиваемся типом и базовой санитизацией строки.
 */
function isValidIceCandidate(c) {
    if (c === null) return true;
    if (typeof c !== "object") return false;
    /* end-of-candidates тоже могут пнуть пустую candidate-строку — пропускаем. */
    if (c.candidate !== undefined && c.candidate !== null && typeof c.candidate !== "string") return false;
    if (typeof c.candidate === "string" && c.candidate.length > 2048) return false;
    return true;
}
