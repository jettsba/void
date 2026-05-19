/* ========= SERVER ENTRY =========
 * Express + WebSocketServer + heartbeat + shutdown. Вся логика — в lib/.
 *
 * Этот файл сознательно тонкий: только wire-up. Менять его надо когда
 * меняется внешний контракт (новый top-level route, новый тип ws-сообщения),
 * а не когда правишь конкретный handler — для этого есть lib/handlers.js.
 */

import express from "express";
import { WebSocketServer } from "ws";
import http from "http";

import { log } from "./lib/log.js";
import { rooms, stats, ipConnections } from "./lib/state.js";
import { flushStats } from "./lib/stats.js";
import {
    MAX_PAYLOAD_BYTES,
    MAX_CONNECTIONS_PER_IP,
    MSG_BUCKET_CAPACITY,
    isOriginAllowed,
    getClientIp,
} from "./lib/security.js";
import { mountAdminStats } from "./lib/admin-stats.js";
import { mountBugReport } from "./lib/bug-report.js";
import { mountTurnEndpoint } from "./lib/turn.js";
import {
    consumeToken,
    handleHello,
    handleCreateRoom,
    handleJoinRoom,
    handleJoinConfirm,
    handleScreencastState,
    handleAudioState,
    handleNicknameUpdate,
    handleLeaveRoom,
    handleDisconnect,
    handleSignal,
    handleIceReport,
} from "./lib/handlers.js";

import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
const PORT = process.env.PORT || 3000;
/**
 * BIND_HOST — какой интерфейс слушать. По умолчанию 127.0.0.1, чтобы случайный
 * `node server.js` на VPS без TLS не выставлял сервер наружу. В docker-compose
 * этот параметр явно выставляется в 0.0.0.0 (Caddy ходит по localhost моста).
 */
const HOST = process.env.BIND_HOST || "127.0.0.1";

// Шрифты + фавиконки доступны на обоих доменах (лендинг + приложение).
// favicons лежат только в public/, но landing index.html ссылается на тот
// же путь /static/favicon/... — без явного маунта он бы отдавал 404 на
// void-room.space (express.static('landing') не находит этих файлов).
app.use('/static/fonts',   express.static(path.join(__dirname, 'public/static/fonts')));
app.use('/static/favicon', express.static(path.join(__dirname, 'public/static/favicon')));

/* /api/version — единственный источник правды для версии в UI.
   Лендинг (eyebrow в hero) и приложение могут фетчить это вместо того, чтобы
   хардкодить вручную и забывать бампить. Версия читается из package.json при
   старте процесса (редеплой контейнера = новая версия). Короткий клиентский
   кэш (60s), чтобы после редеплоя версия на сайте обновлялась почти сразу,
   но повторные хиты в рамках одной сессии не били сервер. */
const PKG_VERSION = (() => {
    try {
        const pkg = JSON.parse(readFileSync(path.join(__dirname, "package.json"), "utf8"));
        return pkg.version || "0.0.0";
    } catch (_) {
        return "0.0.0";
    }
})();
app.get('/api/version', (req, res) => {
    res.set('Cache-Control', 'public, max-age=60');
    res.json({ version: PKG_VERSION });
});

// Маршрутизация по поддомену: app.* → приложение, всё остальное → лендинг
app.use((req, res, next) => {
    const isApp = req.hostname === 'app.void-room.space'
               || req.hostname === 'localhost'
               || req.hostname === '127.0.0.1';
    express.static(path.join(__dirname, isApp ? 'public' : 'landing'))(req, res, next);
});

const server = http.createServer(app);

server.listen(PORT, HOST, () => {
    log.info("boot", "server running", { host: HOST, port: PORT });
});

/* ========= WEBSOCKET ========= */

/**
 * Anti-flooding для лога «origin rejected». Если бот шурует по WS — каждая
 * попытка падала бы в лог, забивая `docker logs` за минуты. Группируем по
 * IP, пишем одну запись на минуту с агрегированным счётчиком. Map чистится
 * по тому же таймауту, не растёт неограниченно.
 */
const ORIGIN_REJECT_WINDOW_MS = 60 * 1000;
const originRejectAggregator = new Map(); // ip -> { count, firstAt, lastOrigin, timer }

function noteOriginReject(ip, origin) {
    let entry = originRejectAggregator.get(ip);
    if (!entry) {
        /* Первое попадание — пишем в лог сразу, дальше копим. */
        log.warn("security", "origin rejected", { origin, ip });
        entry = {
            count: 1,
            firstAt: Date.now(),
            lastOrigin: origin,
            timer: setTimeout(() => flushOriginReject(ip), ORIGIN_REJECT_WINDOW_MS)
        };
        entry.timer.unref?.();
        originRejectAggregator.set(ip, entry);
        return;
    }
    entry.count += 1;
    entry.lastOrigin = origin;
}

function flushOriginReject(ip) {
    const entry = originRejectAggregator.get(ip);
    originRejectAggregator.delete(ip);
    if (!entry) return;
    if (entry.count > 1) {
        log.warn("security", "origin rejected (aggregated)", {
            ip,
            attempts: entry.count,
            windowSec: Math.round((Date.now() - entry.firstAt) / 1000),
            lastOrigin: entry.lastOrigin
        });
    }
}

const wss = new WebSocketServer({
    server,
    maxPayload: MAX_PAYLOAD_BYTES,
    perMessageDeflate: false,
    verifyClient: ({ req }, cb) => {
        const origin = req.headers.origin;
        const ip = getClientIp(req);
        if (!isOriginAllowed(origin)) {
            noteOriginReject(ip, origin);
            cb(false, 403, "Forbidden origin");
            return;
        }
        const count = ipConnections.get(ip) || 0;
        if (count >= MAX_CONNECTIONS_PER_IP) {
            log.warn("security", "ip connection cap hit", { ip, cap: MAX_CONNECTIONS_PER_IP });
            cb(false, 429, "Too many connections");
            return;
        }
        cb(true);
    },
});

mountAdminStats(app);
/* /api/report-bug — багрепорт-форма из настроек. JSON только для этого
   route (нет смысла парсить тело на каждом запросе статики). 256 KB cap —
   с запасом под полный log.bugReport() от Chrome (история + peer stats). */
mountBugReport(app, express.json({ limit: "256kb" }));
/* /api/turn-credentials — выдаёт клиенту короткие HMAC-credentials для
   coturn-сервиса. Если TURN_HOST/TURN_SECRET пусты — endpoint молча 503,
   клиент работает только со STUN. */
mountTurnEndpoint(app);

/**
 * Heartbeat. Без него мёртвый TCP-коннект (закрытая вкладка без FIN, спящий ноут,
 * сетевой обрыв) висит у нас в `room.users` десятки секунд, ломая reconnect
 * клиента: тот пытается войти со своим userId, мы видим "live" старый ws,
 * отдаём id-collision, юзер не может вернуться.
 *
 * Поэтому раз в HEARTBEAT_INTERVAL_MS шлём ping всем подключённым. На каждый
 * ping без pong увеличиваем `_missedPongs`. Когда счётчик >= MAX_MISSED — режем.
 * 30s × 2 = клиент имеет до 60 секунд тишины, прежде чем сервер посчитает
 * его мёртвым. Этого достаточно, чтобы пережить короткие фризы вкладки
 * (Chrome троттлит фоновые tabs, DevTools breakpoint, мобильный сон), но
 * по-настоящему мёртвые сокеты всё равно чистятся.
 */
const HEARTBEAT_INTERVAL_MS = 30 * 1000;
const HEARTBEAT_MAX_MISSED = 2;

/**
 * F3: app-level keepalive поверх WS ping. Браузерные WebSocket API не отдают
 * клиенту событие на control-frame ping/pong — JS не видит, что сервер ещё жив.
 * При half-open TCP (NAT silently dropped) клиент считает `readyState===1` за
 * правду и до 60 секунд молча шлёт сообщения в никуда. Шлём data-frame, чтобы
 * клиентский liveness watchdog мог детектить молчание сервера явно.
 */
const KEEPALIVE_PAYLOAD = JSON.stringify({ type: "keepalive" });

const heartbeatTimer = setInterval(() => {
    wss.clients.forEach((ws) => {
        if ((ws._missedPongs || 0) >= HEARTBEAT_MAX_MISSED) {
            ws.terminate();
            return;
        }
        ws._missedPongs = (ws._missedPongs || 0) + 1;
        try { ws.ping(); } catch (_) {}
        if (ws.readyState === 1) {
            try { ws.send(KEEPALIVE_PAYLOAD); } catch (_) {}
        }
    });
}, HEARTBEAT_INTERVAL_MS);
heartbeatTimer.unref?.();

wss.on("close", () => clearInterval(heartbeatTimer));

wss.on("connection", (ws, req) => {
    const ip = getClientIp(req);
    ws._ip = ip;
    ws._missedPongs = 0;
    ws._bucket = { tokens: MSG_BUCKET_CAPACITY, lastRefill: Date.now() };
    ipConnections.set(ip, (ipConnections.get(ip) || 0) + 1);
    if (ipConnections.size > 100_000) {
        log.error("security", "ip map exploded", { size: ipConnections.size });
    }

    log.debug("ws", "client connected", { ip });

    ws.on("pong", () => { ws._missedPongs = 0; });

    ws.on("error", (err) => {
        log.warn("ws", "error", { ip, err: err.message });
    });

    ws.on("message", (rawMessage) => {
        // Token bucket: при превышении молча дропаем; легитимный клиент даже близко
        // не подходит к лимиту.
        if (!consumeToken(ws)) return;

        try {
            const data = JSON.parse(rawMessage.toString());

            switch (data.type) {

                case "hello":
                    handleHello(ws);
                    break;

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

                case "nickname-update":
                    handleNicknameUpdate(ws, data);
                    break;

                case "screencast-state":
                    handleScreencastState(ws, data);
                    break;

                case "offer":
                case "answer":
                case "ice":
                    handleSignal(ws, data);
                    break;

                case "ice-report":
                    handleIceReport(ws, data);
                    break;

                default:
                    log.warn("ws", "unknown message type", { type: data.type, ip });
            }

        } catch (err) {
            log.warn("ws", "invalid message", { ip, err: err.message });
        }
    });

    ws.on("close", (code, reasonBuf) => {
        const cur = ipConnections.get(ip) || 0;
        if (cur <= 1) ipConnections.delete(ip);
        else ipConnections.set(ip, cur - 1);
        // 1000 = normal, 1001 = going away (refresh/tab close), 1005 = no status
        // received (тоже типичное закрытие из браузера). 1006 = abnormal close —
        // ожидаемый исход heartbeat'а для мёртвых сокетов, уровень debug.
        // Всё остальное — подозрительно, warn.
        if (code !== 1000 && code !== 1001 && code !== 1005) {
            const reason = reasonBuf?.toString?.() || "";
            const level = code === 1006 ? "debug" : "warn";
            log[level]("ws", "abnormal close", { ip, code, reason });
        }
        handleDisconnect(ws);
    });
});

/* ========= SHUTDOWN ========= */

function shutdownGracefully(signal) {
    log.info("boot", "shutdown signal, flushing stats", { signal });
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
