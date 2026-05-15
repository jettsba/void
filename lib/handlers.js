/* ========= WS MESSAGE HANDLERS =========
 * Бизнес-логика room lifecycle: hello / create-room / join-room /
 * join-room-confirm / audio-state / screencast-state / leave-room /
 * disconnect / signal (offer/answer/ice).
 *
 * Состояние (rooms, stats) — через импорты из state.js / stats.js.
 * Ничего не знают про http/express/ws-сервер: чистые функции (ws, data) → effect.
 */

import { log } from "./log.js";
import { rooms, stats } from "./state.js";
import { bumpDaily, scheduleStatsWrite, captureSessionDuration, updatePeaks } from "./stats.js";
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
    const cleanupTimer = setTimeout(() => {
        const r = rooms.get(code);
        if (r && r.users.size === 0) {
            rooms.delete(code);
            log.info("room", "expired empty", { code });
        }
    }, EMPTY_ROOM_TTL_MS);
    cleanupTimer.unref?.();

    rooms.set(code, {
        users: new Map(),
        cleanupTimer
    });

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
        room.users.forEach((u) => {
            if (u.ws.readyState === 1) {
                u.ws.send(JSON.stringify({
                    type: "participant-left",
                    userId
                }));
            }
        });
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
    room.users.forEach((user, id) => {
        if (id !== userId && user.ws.readyState === 1) {
            user.ws.send(JSON.stringify({
                type: "new-participant",
                userId,
                nickname: cleanNick,
                screen: false
            }));
        }
    });

    // _joinedAt используется при дисконнекте/leave для подсчёта длительности
    // присутствия. Регистрация (lifetime "users") считается отдельно — по
    // hello-сообщению при загрузке вкладки, не по входам в комнаты.
    ws._joinedAt = Date.now();
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

    room.users.forEach((u, id) => {
        if (id !== ws.userId && u.ws.readyState === 1) {
            u.ws.send(JSON.stringify({
                type: "screencast-state",
                userId: ws.userId,
                screen: user.screen
            }));
        }
    });
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

    room.users.forEach((u, id) => {
        if (id !== ws.userId && u.ws.readyState === 1) {
            u.ws.send(JSON.stringify({
                type: "nickname-changed",
                userId: ws.userId,
                nickname: cleanNick
            }));
        }
    });
}

export function handleAudioState(ws, data) {

    const room = rooms.get(ws.roomCode);
    if (!room) return;

    const user = room.users.get(ws.userId);
    if (!user || user.ws !== ws) return;

    user.mic = !!data.mic;
    user.sound = !!data.sound;

    room.users.forEach((u, id) => {
        if (id !== ws.userId && u.ws.readyState === 1) {
            u.ws.send(JSON.stringify({
                type: "audio-state",
                userId: ws.userId,
                mic: user.mic,
                sound: user.sound
            }));
        }
    });
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

    roomData.users.forEach((user) => {
        if (user.ws.readyState === 1) {
            user.ws.send(JSON.stringify({
                type: "participant-left",
                userId
            }));
        }
    });

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

        room.users.forEach((user) => {
            if (user.ws.readyState === 1) {
                user.ws.send(JSON.stringify({
                    type: "participant-left",
                    userId
                }));
            }
        });
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

export function handleIceReport(ws, data) {
    if (!ws.roomCode || !ws.userId) return;

    const field = ICE_RESULT_FIELD[data.result];
    if (!field) return;

    stats[field] += 1;
    bumpDaily(field);
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
     * Лимит длины SDP — 16 КБ. Реальный mesh-handshake укладывается в 1-3 КБ;
     * всё, что больше — abuse-payload (атакующий шлёт 60-КБ строку → жертва
     * парсит → лишний CPU и потенциальные crash'и в редких реализациях ICE).
     */
    const MAX_SDP_BYTES = 16 * 1024;
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
