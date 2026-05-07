import express from "express";
import { WebSocketServer } from "ws";
import http from "http";
import fs from "node:fs";
import path from "node:path";

const app = express();
const PORT = process.env.PORT || 3000;

/* ========= ADMIN STATS ========= */

/**
 * Простая статистика beta-теста: сколько комнат/сессий/минут присутствия.
 * Хранится в одном JSON-файле, который смонтирован volume'ом — при ребилде
 * контейнера данные не теряются. Реальный voice-трафик идёт P2P, сервер
 * байты не видит — поэтому в качестве «минут разговора» считаем
 * participant-seconds (сумма по всем сессиям длительности «юзер был в комнате»).
 */

const STATS_FILE = process.env.STATS_FILE || "./data/stats.json";
const ADMIN_STATS_PASSWORD = process.env.ADMIN_STATS_PASSWORD || "";
const STATS_WRITE_DEBOUNCE_MS = 5_000;

const stats = {
    since: Date.now(),
    roomsCreated: 0,
    userSessions: 0,
    participantSeconds: 0,
    peakConcurrentRooms: 0,
    peakConcurrentUsers: 0,
    updatedAt: Date.now()
};

try {
    const loaded = JSON.parse(fs.readFileSync(STATS_FILE, "utf8"));
    // Берём только ожидаемые поля известного типа — мусор/мутации игнорим.
    if (typeof loaded.since === "number") stats.since = loaded.since;
    if (typeof loaded.roomsCreated === "number") stats.roomsCreated = loaded.roomsCreated;
    if (typeof loaded.userSessions === "number") stats.userSessions = loaded.userSessions;
    if (typeof loaded.participantSeconds === "number") stats.participantSeconds = loaded.participantSeconds;
    if (typeof loaded.peakConcurrentRooms === "number") stats.peakConcurrentRooms = loaded.peakConcurrentRooms;
    if (typeof loaded.peakConcurrentUsers === "number") stats.peakConcurrentUsers = loaded.peakConcurrentUsers;
    console.log(`📊 Stats loaded from ${STATS_FILE}`);
} catch (_) {
    console.log(`📊 Stats: starting fresh (no ${STATS_FILE} yet)`);
}

let statsWriteTimer = null;
function scheduleStatsWrite() {
    if (statsWriteTimer) return;
    statsWriteTimer = setTimeout(flushStats, STATS_WRITE_DEBOUNCE_MS);
    statsWriteTimer.unref?.();
}

function flushStats() {
    if (statsWriteTimer) {
        clearTimeout(statsWriteTimer);
        statsWriteTimer = null;
    }
    stats.updatedAt = Date.now();
    try {
        fs.mkdirSync(path.dirname(STATS_FILE), { recursive: true });
        const tmp = STATS_FILE + ".tmp";
        fs.writeFileSync(tmp, JSON.stringify(stats, null, 2));
        fs.renameSync(tmp, STATS_FILE);
    } catch (e) {
        console.error("❌ Stats write failed:", e.message);
    }
}

function updatePeaks() {
    let totalUsers = 0;
    for (const r of rooms.values()) totalUsers += r.users.size;
    let dirty = false;
    if (rooms.size > stats.peakConcurrentRooms) {
        stats.peakConcurrentRooms = rooms.size;
        dirty = true;
    }
    if (totalUsers > stats.peakConcurrentUsers) {
        stats.peakConcurrentUsers = totalUsers;
        dirty = true;
    }
    if (dirty) scheduleStatsWrite();
}

function captureSessionDuration(ws) {
    if (!ws._joinedAt) return;
    stats.participantSeconds += Math.max(0, (Date.now() - ws._joinedAt) / 1000);
    ws._joinedAt = null;
    scheduleStatsWrite();
}

function shutdownGracefully(signal) {
    console.log(`\n${signal} received — flushing stats`);
    // На активные сессии — добавляем накопленное время, чтобы не потерять.
    const now = Date.now();
    for (const room of rooms.values()) {
        for (const user of room.users.values()) {
            if (user.ws._joinedAt) {
                stats.participantSeconds += (now - user.ws._joinedAt) / 1000;
                user.ws._joinedAt = null;
            }
        }
    }
    flushStats();
    process.exit(0);
}
process.on("SIGTERM", () => shutdownGracefully("SIGTERM"));
process.on("SIGINT",  () => shutdownGracefully("SIGINT"));

/* ========= ADMIN STATS ENDPOINT ========= */

app.get("/adminstats", (req, res) => {
    if (!ADMIN_STATS_PASSWORD) {
        res.status(503).type("text/plain")
            .send("admin stats disabled — set ADMIN_STATS_PASSWORD env var");
        return;
    }
    const auth = req.headers.authorization || "";
    let pass = "";
    if (auth.startsWith("Basic ")) {
        try {
            const decoded = Buffer.from(auth.slice(6), "base64").toString("utf8");
            const idx = decoded.indexOf(":");
            pass = idx >= 0 ? decoded.slice(idx + 1) : "";
        } catch (_) {}
    }
    if (pass !== ADMIN_STATS_PASSWORD) {
        res.set("WWW-Authenticate", 'Basic realm="void admin"');
        res.status(401).type("text/plain").send("auth required");
        return;
    }
    res.set("Cache-Control", "no-store");
    res.type("text/html; charset=utf-8").send(renderStatsHtml());
});

function renderStatsHtml() {
    let liveUsers = 0;
    let activeSeconds = 0;
    const now = Date.now();
    for (const r of rooms.values()) {
        liveUsers += r.users.size;
        for (const u of r.users.values()) {
            if (u.ws._joinedAt) activeSeconds += (now - u.ws._joinedAt) / 1000;
        }
    }
    const liveRooms = rooms.size;
    const totalMinutes = Math.floor((stats.participantSeconds + activeSeconds) / 60);

    function fmtDate(ms) {
        return new Date(ms).toISOString().replace("T", " ").slice(0, 19) + " UTC";
    }
    function fmtN(n) { return Number(n).toLocaleString("en-US"); }

    return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta http-equiv="refresh" content="15">
<meta name="robots" content="noindex,nofollow">
<title>void · adminstats</title>
<style>
*{box-sizing:border-box}
body{font:14px/1.5 ui-monospace,Menlo,Consolas,monospace;background:#0a0a0b;color:#e6e6e8;margin:0;padding:32px}
h1{font-size:13px;font-weight:400;letter-spacing:.16em;margin:0 0 24px;text-transform:lowercase;color:#8a8a8e}
.grid{display:grid;gap:14px;max-width:680px;grid-template-columns:repeat(auto-fill,minmax(200px,1fr))}
.card{padding:16px 18px;border:1px solid #25252a;border-radius:3px;background:#111114}
.label{font-size:10px;letter-spacing:.18em;text-transform:lowercase;color:#7a7a7e;margin-bottom:10px}
.value{font-size:24px;font-weight:400;color:#fafafc;letter-spacing:.02em}
.unit{font-size:11px;color:#7a7a7e;margin-left:4px;letter-spacing:.1em}
.meta{margin-top:32px;font-size:11px;color:#5e5e62;letter-spacing:.05em;max-width:680px}
.meta div+div{margin-top:4px}
</style>
</head><body>
<h1>void · adminstats</h1>
<div class="grid">
<div class="card"><div class="label">rooms created</div><div class="value">${fmtN(stats.roomsCreated)}</div></div>
<div class="card"><div class="label">user sessions</div><div class="value">${fmtN(stats.userSessions)}</div></div>
<div class="card"><div class="label">presence time</div><div class="value">${fmtN(totalMinutes)}<span class="unit">min</span></div></div>
<div class="card"><div class="label">peak rooms</div><div class="value">${stats.peakConcurrentRooms}</div></div>
<div class="card"><div class="label">peak users</div><div class="value">${stats.peakConcurrentUsers}</div></div>
<div class="card"><div class="label">live now</div><div class="value">${liveUsers}<span class="unit">in ${liveRooms} room${liveRooms === 1 ? "" : "s"}</span></div></div>
</div>
<div class="meta">
<div>since &nbsp;${fmtDate(stats.since)}</div>
<div>updated&nbsp;${fmtDate(stats.updatedAt)} · auto-refresh 15s</div>
<div>presence time = сумма (user_left − user_joined) по всем сессиям; voice-трафик идёт P2P, сервер байты не видит</div>
</div>
</body></html>`;
}

/* ========= STATIC FILES ========= */

app.use(express.static("public"));

const server = http.createServer(app);

server.listen(PORT, "0.0.0.0", () => {
    console.log(`🚀 Server running on http://localhost:${PORT}`);
});

/* ========= LIMITS / VALIDATION ========= */

/** Max simultaneous participants per room (enforced at join intent + at confirm for races). */
const MAX_ROOM_USERS = 5;

/** WS payload cap. Сигналинг укладывается в десятки КБ; всё крупнее — abuse. */
const MAX_PAYLOAD_BYTES = 64 * 1024;

/** Сколько одновременных WS-соединений с одного IP. Для NAT-офиса 20 — с запасом. */
const MAX_CONNECTIONS_PER_IP = 20;

/** Token bucket на сокет: при пиках offer/answer/ICE спокойно укладываемся, brute — нет. */
const MSG_BUCKET_CAPACITY = 60;
const MSG_BUCKET_REFILL_PER_SEC = 30;

/**
 * Защита от перебора кодов комнат. Считаем неудачные join (room-not-found / invalid-code)
 * на IP в скользящем окне; превышение → временный блок. Легитимный пользователь сюда
 * не попадает: даже с опечатками 15 невалидных кодов в минуту нереально.
 */
const FAILED_JOIN_LIMIT = 15;
const FAILED_JOIN_WINDOW_MS = 60 * 1000;
const FAILED_JOIN_BLOCK_MS = 5 * 60 * 1000;

/** Пустая комната, созданная без последующего join-confirm, удаляется через этот таймаут. */
const EMPTY_ROOM_TTL_MS = 60 * 1000;

const ROOM_CODE_REGEX = /^[A-Z0-9]{4,8}$/;
const USER_ID_REGEX = /^[A-Za-z0-9_-]{1,64}$/;
const NICKNAME_MAX_LEN = 32;

/** Управляющие символы (C0 + C1) — стрипаем из ника, чтобы не уехала вёрстка/логи. */
const CONTROL_CHARS_RX = new RegExp("[\\u0000-\\u001f\\u007f-\\u009f]", "g");

const ALLOWED_ORIGINS = [
    "https://void-room.space",
    "https://www.void-room.space",
];

function isOriginAllowed(origin) {
    if (typeof origin !== "string" || origin.length === 0) return false;
    if (ALLOWED_ORIGINS.includes(origin)) return true;
    // dev-loopback на любом порту
    return /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(origin);
}

function getClientIp(req) {
    const remote = (req.socket && req.socket.remoteAddress) || "";
    const isLocal =
        remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1";
    if (isLocal) {
        const xff = req.headers["x-forwarded-for"];
        if (typeof xff === "string" && xff.length > 0) {
            return xff.split(",")[0].trim();
        }
    }
    return remote;
}

function isValidCode(code) {
    return typeof code === "string" && ROOM_CODE_REGEX.test(code);
}

function isValidUserId(id) {
    return typeof id === "string" && USER_ID_REGEX.test(id);
}

function sanitizeNickname(raw) {
    if (typeof raw !== "string") return "";
    return raw
        .replace(CONTROL_CHARS_RX, "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, NICKNAME_MAX_LEN);
}

/* ========= IP TRACKING ========= */

/** ip -> count активных WS */
const ipConnections = new Map();
/** ip -> { count, windowStart, blockedUntil } */
const ipFailedJoins = new Map();

function noteFailedJoin(ip) {
    if (!ip) return;
    const now = Date.now();
    let entry = ipFailedJoins.get(ip);
    if (!entry || now - entry.windowStart > FAILED_JOIN_WINDOW_MS) {
        entry = { count: 0, windowStart: now, blockedUntil: 0 };
        ipFailedJoins.set(ip, entry);
    }
    entry.count += 1;
    if (entry.count >= FAILED_JOIN_LIMIT) {
        entry.blockedUntil = now + FAILED_JOIN_BLOCK_MS;
    }
}

function isIpBlocked(ip) {
    if (!ip) return false;
    const entry = ipFailedJoins.get(ip);
    return !!(entry && entry.blockedUntil > Date.now());
}

function clearFailedJoins(ip) {
    if (!ip) return;
    const entry = ipFailedJoins.get(ip);
    if (entry && entry.blockedUntil <= Date.now()) {
        ipFailedJoins.delete(ip);
    }
}

setInterval(() => {
    const now = Date.now();
    for (const [ip, entry] of ipFailedJoins) {
        if (entry.blockedUntil) {
            if (entry.blockedUntil < now) ipFailedJoins.delete(ip);
        } else if (now - entry.windowStart > FAILED_JOIN_WINDOW_MS) {
            ipFailedJoins.delete(ip);
        }
    }
}, 60 * 1000).unref?.();

/* ========= WEBSOCKET ========= */

const wss = new WebSocketServer({
    server,
    maxPayload: MAX_PAYLOAD_BYTES,
    perMessageDeflate: false,
    verifyClient: ({ req }, cb) => {
        const origin = req.headers.origin;
        if (!isOriginAllowed(origin)) {
            cb(false, 403, "Forbidden origin");
            return;
        }
        const ip = getClientIp(req);
        const count = ipConnections.get(ip) || 0;
        if (count >= MAX_CONNECTIONS_PER_IP) {
            cb(false, 429, "Too many connections");
            return;
        }
        cb(true);
    },
});

/*
Структура rooms:

Map {
  roomCode => {
    users: Map {
      userId => { ws, nickname, mic, sound, screen }
    },
    cleanupTimer: setTimeout id | null
  }
}
*/

const rooms = new Map();

function consumeToken(ws) {
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
 * Heartbeat. Без него мёртвый TCP-коннект (закрытая вкладка без FIN, спящий ноут,
 * сетевой обрыв) висит у нас в `room.users` десятки секунд, ломая reconnect
 * клиента: тот пытается войти со своим userId, мы видим "live" старый ws,
 * отдаём id-collision, юзер не может вернуться. Пингуем каждый HEARTBEAT_MS;
 * если за следующий цикл не пришёл pong — terminate, чем поднимаем `close`,
 * а тот уже зовёт handleDisconnect и чистит запись.
 */
const HEARTBEAT_INTERVAL_MS = 15 * 1000;

const heartbeatTimer = setInterval(() => {
    wss.clients.forEach((ws) => {
        if (ws._isAlive === false) {
            ws.terminate();
            return;
        }
        ws._isAlive = false;
        try { ws.ping(); } catch (_) {}
    });
}, HEARTBEAT_INTERVAL_MS);
heartbeatTimer.unref?.();

wss.on("close", () => clearInterval(heartbeatTimer));

wss.on("connection", (ws, req) => {
    const ip = getClientIp(req);
    ws._ip = ip;
    ws._isAlive = true;
    ws._bucket = { tokens: MSG_BUCKET_CAPACITY, lastRefill: Date.now() };
    ipConnections.set(ip, (ipConnections.get(ip) || 0) + 1);

    console.log(`🟢 Client connected (${ip})`);

    ws.on("pong", () => { ws._isAlive = true; });

    ws.on("error", (err) => {
        console.error(`⚠️  WS error (${ip}):`, err.message);
    });

    ws.on("message", (rawMessage) => {
        // Token bucket: при превышении молча дропаем; легитимный клиент даже близко
        // не подходит к лимиту.
        if (!consumeToken(ws)) return;

        try {
            const data = JSON.parse(rawMessage.toString());

            switch (data.type) {

                case "create-room":
                    handleCreateRoom(ws, data);
                    break;

                case "join-room":
                    handleJoinRoom(ws, data);
                    break;

                case "join-room-confirm":
                    handleJoinConfirm(ws, data);
                    break;

                case "leave-room":
                    handleLeaveRoom(ws);
                    break;

                case "audio-state":
                    handleAudioState(ws, data);
                    break;

                case "screencast-state":
                    handleScreencastState(ws, data);
                    break;

                case "offer":
                case "answer":
                case "ice":
                    handleSignal(ws, data);
                    break;

                default:
                    console.log("Unknown message type:", data.type);
            }

        } catch (err) {
            console.error("❌ Invalid message:", err);
        }
    });

    ws.on("close", (code, reasonBuf) => {
        const cur = ipConnections.get(ip) || 0;
        if (cur <= 1) ipConnections.delete(ip);
        else ipConnections.set(ip, cur - 1);
        // 1000 = normal, 1001 = going away (refresh/tab close). Всё остальное —
        // подозрительно, логируем чтобы не теряться при будущих регрессиях.
        if (code !== 1000 && code !== 1001) {
            const reason = reasonBuf?.toString?.() || "";
            console.log(`🔴 WS closed (${ip}) code=${code}${reason ? " reason=" + reason : ""}`);
        }
        handleDisconnect(ws);
    });
});

/* ========= ROOM LOGIC ========= */

function handleCreateRoom(ws, data) {

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
            console.log(`🧹 Empty room expired: ${code}`);
        }
    }, EMPTY_ROOM_TTL_MS);
    cleanupTimer.unref?.();

    rooms.set(code, {
        users: new Map(),
        cleanupTimer
    });

    stats.roomsCreated += 1;
    updatePeaks();
    scheduleStatsWrite();

    /** Разрешает ровно один последующий join-room-confirm на этот код с этого сокета. */
    ws.authorizedJoinCode = code;

    ws.send(JSON.stringify({
        type: "room-created",
        success: true,
        code
    }));

    console.log(`✅ Room created: ${code}`);
}

function handleJoinRoom(ws, data) {

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

function handleJoinConfirm(ws, data) {

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
     * Защита от hijack'а: если userId уже занят в комнате другим живым сокетом —
     * отказ. Если та же запись принадлежит мёртвому/закрытому сокету (race на
     * reconnect, ещё не отработал handleDisconnect) — спокойно перезаписываем.
     */
    const existing = room.users.get(userId);
    if (existing && existing.ws !== ws && existing.ws.readyState === 1) {
        ws.send(JSON.stringify({
            type: "join-failed",
            reason: "id-collision"
        }));
        return;
    }

    if (!existing && room.users.size >= MAX_ROOM_USERS) {
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

    // Stats: новая сессия. _joinedAt используется при дисконнекте/leave
    // для подсчёта длительности присутствия.
    ws._joinedAt = Date.now();
    stats.userSessions += 1;
    updatePeaks();
    scheduleStatsWrite();

    console.log(`👤 ${cleanNick} (${userId}) joined room ${code}`);
}

function handleScreencastState(ws, data) {
    const room = rooms.get(ws.roomCode);
    if (!room) return;

    const user = room.users.get(ws.userId);
    if (!user || user.ws !== ws) return;

    // Enforce single sharer: reject if another user is already sharing
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

function handleAudioState(ws, data) {

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

function handleLeaveRoom(ws) {

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
        console.log(`🧹 Room deleted: ${code}`);
    }
}

function handleDisconnect(ws) {

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

    console.log("🔴 Client disconnected");
}

function handleSignal(ws, data) {

    if (!ws.roomCode || !ws.userId) return;

    const room = rooms.get(ws.roomCode);
    if (!room) return;

    if (typeof data.to !== "string") return;

    const targetUser = room.users.get(data.to);
    if (!targetUser || targetUser.ws.readyState !== 1) return;

    /**
     * Whitelist полей. Раньше тут был spread `...data` после `from: ws.userId`,
     * из-за чего payload-овский `from` ПЕРЕТИРАЛ серверный — атакующий мог
     * подделать источник signaling (S-C3). Теперь явно перечисляем ровно те
     * поля, которые ожидает клиент (`public/webrtc.js`):
     *  - offer:  { offer, rebuild? }
     *  - answer: { answer }
     *  - ice:    { candidate }
     */
    const out = {
        type: data.type,
        from: ws.userId,
        to: data.to
    };

    if (data.type === "offer") {
        if (data.offer !== undefined) out.offer = data.offer;
        if (data.rebuild === true) out.rebuild = true;
    } else if (data.type === "answer") {
        if (data.answer !== undefined) out.answer = data.answer;
    } else if (data.type === "ice") {
        if (data.candidate !== undefined) out.candidate = data.candidate;
    }

    targetUser.ws.send(JSON.stringify(out));
}
