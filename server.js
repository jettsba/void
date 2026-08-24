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
import { rooms, ipConnections } from "./lib/state.js";
import { flushStats, flushOpenCalls, captureSessionDuration } from "./lib/stats.js";
import {
    MAX_PAYLOAD_BYTES,
    MAX_CONNECTIONS_PER_IP,
    MSG_BUCKET_CAPACITY,
    isOriginAllowed,
    getClientIp,
} from "./lib/security.js";
import { mountAdminStats } from "./lib/admin-stats.js";
import { mountDownloadBeaconEndpoint } from "./lib/dl-beacon.js";
import { mountBugReport } from "./lib/bug-report.js";
import { mountTurnEndpoint } from "./lib/turn.js";
import { mountLeaveBeaconEndpoint } from "./lib/leave-beacon.js";
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
/* Скрываем `X-Powered-By: Express`. Заголовок не несёт пользы для клиентов,
   но раскрывает стек атакующим — упрощает таргетинг известных CVE Express'а.
   Caddy и так срезает `Server: Caddy` (см. -Server в Caddyfile), это парная
   мера на уровне приложения. */
app.disable('x-powered-by');
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

/* ========= HOT-RELOAD СТАТИКИ =========
 * `public/`, `landing/` и `package.json` примонтированы в контейнер bind-mount'ом
 * (docker-compose.yml), поэтому фронтовая правка доезжает на прод БЕЗ пересборки
 * образа и без рестарта процесса — а значит без разрыва сигналинга и без выброса
 * людей из комнат (см. tasks/todo.md, правка 0).
 *
 * Но четыре значения ниже раньше читались РОВНО ОДИН раз на старте, и без этой
 * обёртки выкатка без рестарта показывала бы старую версию в шапке лендинга и
 * старый список контрибьюторов до следующего серверного релиза. Читаем лениво,
 * с TTL: один read раз в минуту на значение, зато рестарт не нужен.
 *
 * Ошибка загрузки НЕ затирает прошлое значение (git reset --hard на VPS может
 * поймать нас на полузаписанном файле) — отдаём последнее удачное. */
const HOT_TTL_MS = 60 * 1000;

function hot(loader, fallback) {
    let value;
    let loadedAt = 0;
    return () => {
        const now = Date.now();
        if (value === undefined || now - loadedAt > HOT_TTL_MS) {
            try {
                value = loader();
                loadedAt = now;
            } catch (e) {
                log.warn('boot', 'hot reload failed, keeping previous value', { error: e.message });
                /* loadedAt не двигаем: следующий запрос попробует ещё раз. */
            }
        }
        return value === undefined ? fallback : value;
    };
}

/* /api/version — единственный источник правды для версии в UI.
   Лендинг (eyebrow в hero) и приложение могут фетчить это вместо того, чтобы
   хардкодить вручную и забывать бампить. Короткий клиентский кэш (60s), чтобы
   после выкатки версия на сайте обновлялась почти сразу, но повторные хиты в
   рамках одной сессии не били сервер. */
const getVersion = hot(() => {
    const pkg = JSON.parse(readFileSync(path.join(__dirname, "package.json"), "utf8"));
    return pkg.version || "0.0.0";
}, "0.0.0");
app.get('/api/version', (req, res) => {
    res.set('Cache-Control', 'public, max-age=60');
    res.json({ version: getVersion() });
});

/* /api/contributors — единственный источник правды для списка контрибьюторов
   в лендинге. PREMIUM_NICKNAMES живёт в public/js/config.js (он же — источник
   золотого shimmer'а в комнате), и единая переменная управляет обоими местами:
   добавил ник в Set — он и подсветится в комнате, и появится на лендинге.
   Парсим текстуально, без eval/import (config.js — не ESM-модуль, грузится в
   браузер тегом <script>, а попытка `await import()` здесь дала бы ESM-фейл
   на "const X" в module scope). Исключаем NON_CONTRIBUTOR_NICKNAMES: casheaterr —
   это автор, а void — пасхалка (ник даёт золотой shimmer в комнате, но человека
   за ним нет). Тот же список продублирован в landing/landing.js — фолбэк-парсер
   должен фильтровать ровно так же, иначе dev и prod разойдутся.
   Кэш 5 минут (список меняется только при выкатке — частить смысла нет). */
const NON_CONTRIBUTOR_NICKNAMES = new Set(['casheaterr', 'void']);
const getContributors = hot(() => {
    const src = readFileSync(path.join(__dirname, 'public/js/config.js'), 'utf8');
    const block = src.match(/PREMIUM_NICKNAMES\s*=\s*new\s+Set\s*\(\s*\[([\s\S]*?)\]\s*\)/);
    if (!block) return [];
    return [...block[1].matchAll(/["']([^"']+)["']/g)]
        .map(m => m[1].trim().toLowerCase())
        .filter(Boolean)
        .filter(n => !NON_CONTRIBUTOR_NICKNAMES.has(n));
}, []);
app.get('/api/contributors', (req, res) => {
    res.set('Cache-Control', 'public, max-age=300');
    res.json({ names: getContributors() });
});

/* Рантайм-инъекция версии в лендинг.
   Лендинг ссылается на актуальную версию в двух местах: softwareVersion в
   JSON-LD и data-version-fallback на hero-eyebrow. Чтобы не держать четыре
   синхронных хардкода (package.json + public/settings.js + RU html + EN html),
   один источник истины — package.json. Читаем лендинг-HTML, подставляем
   {{VERSION}} → актуальную версию, кэшируем результат (TTL см. hot()). */
const getLandingHtml = hot(() => ({
    ru: readFileSync(path.join(__dirname, 'landing/index.html'), 'utf8').replaceAll('{{VERSION}}', getVersion()),
    en: readFileSync(path.join(__dirname, 'landing/en/index.html'), 'utf8').replaceAll('{{VERSION}}', getVersion()),
}), { ru: '', en: '' });

/* Рантайм-инъекция lastmod в sitemap.xml.
   Sitemap содержит {{LASTMOD}} плейсхолдер для всех <lastmod> полей; при
   чтении подставляется текущая дата в формате YYYY-MM-DD. Это автоматически
   делает sitemap «свежим» при каждом деплое — поисковики видят актуальные
   даты модификации без ручного редактирования файла. */
const getSitemapXml = hot(() => {
    const today = new Date().toISOString().slice(0, 10);
    return readFileSync(path.join(__dirname, 'landing/sitemap.xml'), 'utf8').replaceAll('{{LASTMOD}}', today);
}, '');
app.get('/sitemap.xml', (req, res, next) => {
    if (!isLandingHost(req)) return next();
    res.set('Content-Type', 'application/xml; charset=utf-8');
    res.send(getSitemapXml());
});

/* Bot UA pattern — поисковики, AI-краулеры, и unfurl-боты соцсетей
   (Telegram/Twitter/Discord фетчат OG-метатеги для превью в чатах).
   Все они должны видеть контент по URL как есть, а не редиректиться по
   Accept-Language: иначе Googlebot со стандартным `en-US` уведёт `/` в
   индекс под /en/, а Telegram-превью русской ссылки покажется английским. */
const BOT_UA_PATTERN = /googlebot|bingbot|yandex|duckduckbot|baiduspider|applebot|gptbot|chatgpt-user|oai-searchbot|claudebot|claude-web|perplexitybot|amazonbot|facebookexternalhit|telegrambot|twitterbot|slackbot|discordbot|whatsapp|linkedinbot|skypeuripreview|pinterestbot|bytespider|ccbot|crawler|spider/i;

/* Language router. Срабатывает ТОЛЬКО на корень `/` лендинг-домена.
   `/en/` — статика, тут не трогается. Решение:
     1. Bot UA → отдать RU (бот индексирует / как русскую страницу).
     2. Accept-Language пуст или начинается с 'ru' → отдать RU.
     3. Иначе → 302 на /en/ (en, es, fr, ja, любой не-RU юзер).
   Vary: Accept-Language обязательно, иначе CDN/прокси может закэшировать
   ответ для одного языка и отдать другому. */
app.use((req, res, next) => {
    if (req.path !== '/') return next();

    const isApp = req.hostname === 'app.void-room.space'
               || req.hostname === 'localhost'
               || req.hostname === '127.0.0.1';
    if (isApp) return next();

    res.set('Vary', 'Accept-Language');

    const ua = req.headers['user-agent'] || '';
    if (BOT_UA_PATTERN.test(ua)) return next();

    const acceptLang = (req.headers['accept-language'] || '').toLowerCase();
    if (!acceptLang || acceptLang.startsWith('ru')) return next();

    res.redirect(302, '/en/');
});

/* Лендинг-HTML с инъектированной версией. Перехватываем только корни /
   и /en/ на лендинг-домене — остальные пути (privacy, статика, ассеты)
   уходят дальше в express.static. */
function isLandingHost(req) {
    return !(req.hostname === 'app.void-room.space'
          || req.hostname === 'localhost'
          || req.hostname === '127.0.0.1');
}
app.get('/', (req, res, next) => {
    if (!isLandingHost(req)) return next();
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.send(getLandingHtml().ru);
});
app.get('/en/', (req, res, next) => {
    if (!isLandingHost(req)) return next();
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.send(getLandingHtml().en);
});

/* Маршрутизация по поддомену: app.* → приложение, всё остальное → лендинг.
   extensions:['html'] позволяет /privacy матчить landing/privacy.html без
   trailing slash и без вынужденной /privacy/index.html структуры. */
app.use((req, res, next) => {
    const isApp = req.hostname === 'app.void-room.space'
               || req.hostname === 'localhost'
               || req.hostname === '127.0.0.1';
    express.static(path.join(__dirname, isApp ? 'public' : 'landing'), { extensions: ['html'] })(req, res, next);
});

/* CORS для /api/* — нужен Tauri desktop'у. Bundled-сборка шлёт fetch'и с
   origin http://tauri.localhost, для browser-юзеров origin совпадает с host
   (same-origin) и CORS не релевантен. Используем общий isOriginAllowed,
   чтобы не дублировать whitelist. Preflight OPTIONS короткозамыкаем 204. */
app.use("/api", (req, res, next) => {
    const origin = req.headers.origin;
    if (origin && isOriginAllowed(origin)) {
        res.setHeader("Access-Control-Allow-Origin", origin);
        res.setHeader("Vary", "Origin");
    }
    if (req.method === "OPTIONS") {
        res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
        res.setHeader("Access-Control-Allow-Headers", "Content-Type");
        return res.sendStatus(204);
    }
    next();
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
/* T1.1: /api/leave-room — приём navigator.sendBeacon на pagehide. Гарантирует
   быстрое (до 1s) исчезновение «призрака» в комнате при закрытии вкладки,
   когда WS leave-room не успевает уйти из TCP-буфера. 256 байт лимит — body
   это `{code, userId}`, ничего больше не ждём. */
mountLeaveBeaconEndpoint(app, express.json({ limit: "256b" }));

/* /api/dl-hit — клик-счётчик скачиваний desktop с зеркала /dl (загрузки
   переехали на свой домен, GitHub в РФ нестабилен). 256b — body это {asset}. */
mountDownloadBeaconEndpoint(app, express.json({ limit: "256b" }));

/* Кастомный 404. Лендинг получает стилизованную страницу в тоне сайта
   (landing/404.html для RU, landing/en/404.html для EN-путей). App-сабдомен
   обычно SPA — все маршруты сводятся к /, поэтому отдаём минимум.
   Важно: эта middleware идёт ПОСЛЕ express.static И ПОСЛЕ всех API-маунтов
   (mountAdminStats / mountTurnEndpoint / mountBugReport / mountLeaveBeacon) —
   иначе catch-all перехватит их запросы первым (Express матчит маршруты в
   порядке регистрации). */
app.use((req, res) => {
    if (!isLandingHost(req)) {
        res.status(404).type('text/plain').send('Not Found');
        return;
    }
    const isEn = req.path.startsWith('/en/') || req.path === '/en';
    const file = isEn ? 'landing/en/404.html' : 'landing/404.html';
    res.status(404).sendFile(path.join(__dirname, file));
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
                    handleHello(ws, data);
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

/**
 * Пауза между анонсом рестарта и реальным выходом. Docker даёт 10s до SIGKILL,
 * нам нужны сотни миллисекунд — только чтобы фрейм успел уйти из TCP-буфера.
 */
const DRAIN_DELAY_MS = 300;
let shuttingDown = false;

function shutdownGracefully(signal) {
    /* Повторный сигнал (docker stop поверх уже идущего shutdown) не должен
       второй раз считать сессии и не должен ронять нас до отправки анонса. */
    if (shuttingDown) return;
    shuttingDown = true;

    log.info("boot", "shutdown signal, flushing stats", { signal });

    /* Дрейн: предупреждаем клиентов, что это ПЛАНОВЫЙ рестарт (выкатка), а не
       обрыв связи. Клиент по этому сигналу переподключается агрессивнее
       (сотни мс вместо секунд) и не паникует. Свой P2P-mesh он при этом
       держит — сервер в медиапути не участвует, разговор продолжается.
       Аналог discord'овского opcode 7 RECONNECT. */
    const notice = JSON.stringify({ type: "server-restarting" });
    for (const ws of wss.clients) {
        if (ws.readyState === 1) {
            try { ws.send(notice); } catch (_) {}
        }
    }

    /* На активные сессии — добавляем накопленное время, чтобы не потерять.
       Через captureSessionDuration, а не вручную: раньше здесь инкрементился
       только lifetime-счётчик, и дневной срез терял время всех, кто был в
       комнате на момент деплоя. */
    for (const room of rooms.values()) {
        for (const user of room.users.values()) {
            captureSessionDuration(user.ws);
        }
    }
    // Незакрытые интервалы разговоров (≥2 человек в комнате) — по той же причине.
    flushOpenCalls();
    flushStats();

    setTimeout(() => process.exit(0), DRAIN_DELAY_MS);
}
process.on("SIGTERM", () => shutdownGracefully("SIGTERM"));
process.on("SIGINT",  () => shutdownGracefully("SIGINT"));
