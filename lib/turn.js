/* ========= TURN CREDENTIALS ENDPOINT =========
 * GET /api/turn-credentials?uid=<userId> → JSON с iceServers, готовый
 * к подстановке в `new RTCPeerConnection({iceServers})`.
 *
 * Использует стандартный coturn-паттерн `use-auth-secret`:
 *   username   = `${expiry_unix_seconds}:${userId}`
 *   credential = base64( HMAC-SHA1(TURN_SECRET, username) )
 *
 * Coturn валидирует ту же подпись через свой `static-auth-secret`. БД нет,
 * синхронизации нет, ротация креденшалов автоматическая (TTL 1 час).
 *
 * Конфиг (env):
 *   TURN_HOST   — публичное hostname/IP coturn-сервера (например turn.void-room.space).
 *   TURN_SECRET — общий секрет с coturn (`openssl rand -base64 48`).
 *
 * Если ЛЮБАЯ из них не задана — endpoint возвращает 503, клиент работает
 * только со STUN. Это и есть «portable-режим» (dev / VPS без TURN).
 */

import crypto from "node:crypto";
import { log } from "./log.js";

const TURN_HOST = process.env.TURN_HOST || "";
const TURN_SECRET = process.env.TURN_SECRET || "";
const TURN_TTL_SECONDS = 3600;

export function isTurnConfigured() {
    return !!(TURN_HOST && TURN_SECRET);
}

/**
 * Генерация коротких credentials по схеме coturn `use-auth-secret`.
 * userId попадает в username — это полезно для дебага в coturn-логах
 * (видно «кто аллокатил relay»), на безопасность не влияет, потому что
 * подпись и так в credential.
 */
function generateCredentials(userId) {
    const expiry = Math.floor(Date.now() / 1000) + TURN_TTL_SECONDS;
    const username = `${expiry}:${userId}`;
    const credential = crypto
        .createHmac("sha1", TURN_SECRET)
        .update(username)
        .digest("base64");
    return { username, credential, ttl: TURN_TTL_SECONDS };
}

export function mountTurnEndpoint(app) {
    app.get("/api/turn-credentials", (req, res) => {
        if (!isTurnConfigured()) {
            /* TURN_* env не заданы → endpoint молча 503, клиент работает только
               со STUN (как сейчас, без relay). Это portable-режим: можно гонять
               проект без TURN-инфры. Клиент знает 503 и не шумит. */
            res.status(503).json({ error: "turn not configured" });
            return;
        }

        /* userId шлёт клиент в query. Не доверяем серверной стороне в плане
           identity (он spoofable, см. CONTEXT.md §9), используем только для
           coturn-логов и санитизации. Регекс совпадает с серверной валидацией
           userId в lib/security.js. */
        const rawUserId = String(req.query.uid || "anon");
        const userId = rawUserId.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32) || "anon";

        const creds = generateCredentials(userId);
        res.set("Cache-Control", "no-store");
        res.json({
            /* Порядок значим: клиент кладёт этот массив ПЕРЕД публичными STUN
               (см. ensureTurnCredentials в public/webrtc.js).

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
                        `turn:${TURN_HOST}:3478?transport=tcp`
                    ],
                    username: creds.username,
                    credential: creds.credential
                }
            ],
            ttl: creds.ttl
        });
    });

    log.info("boot", "turn endpoint mounted", { configured: isTurnConfigured() });
}
