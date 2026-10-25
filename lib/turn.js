/* ========= TURN CREDENTIALS =========
 * Короткие креды для coturn по стандартной схеме `use-auth-secret`:
 *   username   = `${expiry_unix_seconds}:${sid}`
 *   credential = base64( HMAC-SHA1(TURN_SECRET, username) )
 * Coturn валидирует ту же подпись через свой `static-auth-secret`. БД нет,
 * синхронизации нет, ротация автоматическая.
 *
 * КОМУ выдаём. Раньше — любому по GET /api/turn-credentials: через наш VPS
 * можно было бесплатно гонять чужой трафик, ни разу не зайдя в void, и этого
 * никто бы не увидел (логи coturn выключены ради приватности). Теперь креды
 * получает только участник комнаты — сервер кладёт их в его персональный
 * user-list и продлевает по WS-запросу `turn-refresh` (lib/handlers.js).
 *
 * sid — одноразовый серверный id сессии, а не userId: в username не попадает
 * ничего, что связывало бы relay-аллокацию с человеком.
 *
 * Конфиг (env):
 *   TURN_HOST   — публичное hostname/IP coturn-сервера (например turn.void-room.space).
 *   TURN_SECRET — общий секрет с coturn (`openssl rand -base64 48`).
 * Если ЛЮБАЯ из них не задана — TURN не раздаётся, клиент работает только со
 * STUN. Это и есть «portable-режим» (dev / VPS без TURN).
 */

import crypto from "node:crypto";
import { log } from "./log.js";

const TURN_HOST = process.env.TURN_HOST || "";
const TURN_SECRET = process.env.TURN_SECRET || "";
const TURN_TTL_SECONDS = 3600;
/* TLS-вход coturn (turns://). Нужен ИМЕННО hostname: браузер проверяет
   сертификат TURN-сервера и самоподписанный/IP-адрес не примет (проверено на
   стенде). Не задан — URL не раздаём, поведение как раньше. */
const TURN_TLS_HOST = process.env.TURN_TLS_HOST || "";
const TURN_TLS_PORT = parseInt(process.env.TURN_TLS_PORT, 10) || 443;

export function isTurnConfigured() {
    return !!(TURN_HOST && TURN_SECRET);
}

export function newTurnSessionId() {
    return "s" + crypto.randomBytes(8).toString("hex");
}

function generateCredentials(sid, ttl) {
    const expiry = Math.floor(Date.now() / 1000) + ttl;
    const username = `${expiry}:${sid}`;
    const credential = crypto
        .createHmac("sha1", TURN_SECRET)
        .update(username)
        .digest("base64");
    return { username, credential };
}

/**
 * Готовый набор для `new RTCPeerConnection({iceServers})` или `false`, если
 * TURN не настроен (клиент тогда не спрашивает повторно).
 */
export function turnPayload(sid, ttl = TURN_TTL_SECONDS) {
    if (!isTurnConfigured()) return false;
    const creds = generateCredentials(sid, ttl);
    return {
        /* Порядок значим: клиент кладёт этот массив ПЕРЕД публичными STUN
           (см. applyTurnCredentials в public/webrtc.js).

           1. Свой STUN. Формально избыточен — браузер и так спрашивает srflx
              у TURN-сервера, — но делает сбор кандидатов независимым от
              публичных адресов, которые у части клиентов не резолвятся вовсе.
           2. TURN по UDP — основной путь.
           3. TURN по TCP — запасной для сетей, где UDP до нас не доходит
              (в failure-логе такие клиенты есть: allocate отваливается по
              таймауту). Приоритет у TCP-кандидатов ниже, поэтому на здоровой
              сети он просто не выигрывает и ничего не замедляет. Цена — по
              второму allocation'у на peer, под это подняты квоты coturn. */
        iceServers: [
            { urls: [`stun:${TURN_HOST}:3478`] },
            {
                urls: [
                    `turn:${TURN_HOST}:3478?transport=udp`,
                    `turn:${TURN_HOST}:3478?transport=tcp`,
                    /* 4. TURN по TLS на 443 — последний рубеж: выглядит как
                       обычный HTTPS и проходит там, где пускают только 443
                       (прокси, VPN-провайдеры с фильтром портов, DPI).
                       Приоритет у TLS самый низкий — здоровая сеть его не
                       выберет (проверено на стенде). */
                    ...(TURN_TLS_HOST ? [`turns:${TURN_TLS_HOST}:${TURN_TLS_PORT}?transport=tcp`] : [])
                ],
                username: creds.username,
                credential: creds.credential
            }
        ],
        ttl
    };
}

/* ---------- переходный HTTP-путь (удаляется в 1.7.2) ----------
 * Десктоп несёт интерфейс внутри exe: клиенты до 1.7.0 спрашивают креды по
 * HTTP и узнают о новом протоколе только после автообновления. Чтобы у них не
 * пропал relay (~треть пар идёт через него), старый адрес на две недели
 * остаётся — но сжатым: 5 выдач в минуту с IP, креды на 30 минут, в username
 * случайный id, а не userId. Сколько старых клиентов ещё ходит — видно по
 * часовой сводке в логе; когда станет ноль, эндпоинт удаляется. */
const LEGACY_TTL_SECONDS = 30 * 60;
const LEGACY_PER_MIN = 5;
const legacyHits = new Map(); // ip -> { count, windowStart }
let legacyServed = 0;

function legacyAllowed(ip) {
    const now = Date.now();
    let entry = legacyHits.get(ip);
    if (!entry || now - entry.windowStart > 60 * 1000) {
        entry = { count: 0, windowStart: now };
        legacyHits.set(ip, entry);
    }
    entry.count += 1;
    return entry.count <= LEGACY_PER_MIN;
}

setInterval(() => {
    const now = Date.now();
    for (const [ip, entry] of legacyHits) {
        if (now - entry.windowStart > 60 * 1000) legacyHits.delete(ip);
    }
    if (legacyServed > 0) {
        log.info("turn", "legacy credentials endpoint used (pre-1.7.0 clients)", { lastHour: legacyServed });
        legacyServed = 0;
    }
}, 60 * 60 * 1000).unref?.();

export function mountTurnEndpoint(app, getClientIp) {
    app.get("/api/turn-credentials", (req, res) => {
        res.set("Cache-Control", "no-store");
        if (!isTurnConfigured()) {
            res.status(503).json({ error: "turn not configured" });
            return;
        }
        if (!legacyAllowed(getClientIp(req))) {
            res.status(429).json({ error: "too many requests" });
            return;
        }
        legacyServed += 1;
        res.json(turnPayload("l" + crypto.randomBytes(8).toString("hex"), LEGACY_TTL_SECONDS));
    });

    log.info("boot", "turn configured", {
        configured: isTurnConfigured(),
        tls: TURN_TLS_HOST ? `${TURN_TLS_HOST}:${TURN_TLS_PORT}` : "off"
    });
}
