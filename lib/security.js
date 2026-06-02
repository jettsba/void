/* ========= LIMITS / VALIDATION / IP TRACKING =========
 * Константы лимитов, валидаторы (origin, code, userId, nickname) и трекинг
 * IP'шек для anti-brute-force. ipConnections / ipFailedJoins живут в
 * lib/state.js — здесь только манипуляции над ними.
 *
 * При импорте поднимается setInterval, чистящий протухшие записи в
 * ipFailedJoins (раз в минуту). unref'нут — не держит event loop.
 */

import { log } from "./log.js";
import { ipFailedJoins } from "./state.js";

/** Max simultaneous participants per room (enforced at join intent + at confirm for races). */
export const MAX_ROOM_USERS = (() => {
    const raw = parseInt(process.env.MAX_ROOM_USERS, 10);
    return Number.isFinite(raw) && raw > 0 ? raw : 5;
})();

/** WS payload cap. Сигналинг укладывается в десятки КБ; всё крупнее — abuse. */
export const MAX_PAYLOAD_BYTES = 64 * 1024;

/** Сколько одновременных WS-соединений с одного IP. Для NAT-офиса 20 — с запасом. */
export const MAX_CONNECTIONS_PER_IP = 20;

/** Token bucket на сокет: при пиках offer/answer/ICE спокойно укладываемся, brute — нет. */
export const MSG_BUCKET_CAPACITY = 60;
export const MSG_BUCKET_REFILL_PER_SEC = 30;

/**
 * Защита от перебора кодов комнат. Считаем неудачные join (room-not-found / invalid-code)
 * на IP в скользящем окне; превышение → временный блок. Легитимный пользователь сюда
 * не попадает: даже с опечатками 15 невалидных кодов в минуту нереально.
 */
export const FAILED_JOIN_LIMIT = 15;
export const FAILED_JOIN_WINDOW_MS = 60 * 1000;
export const FAILED_JOIN_BLOCK_MS = 5 * 60 * 1000;

/** Пустая комната, созданная без последующего join-confirm, удаляется через этот таймаут. */
export const EMPTY_ROOM_TTL_MS = 60 * 1000;

const ROOM_CODE_REGEX = /^[A-Z0-9]{4,8}$/;
const USER_ID_REGEX = /^[A-Za-z0-9_-]{1,64}$/;
const NICKNAME_MAX_LEN = 32;

/** Управляющие символы (C0 + C1) — стрипаем из ника, чтобы не уехала вёрстка/логи. */
const CONTROL_CHARS_RX = new RegExp("[\\u0000-\\u001f\\u007f-\\u009f]", "g");

/**
 * Список разрешённых Origin'ов. Берём из env `ALLOWED_ORIGINS` (через запятую) —
 * меняешь домен на VPS, не пересобирая образ. Если переменная не задана,
 * остаются прод-дефолты ниже.
 */
const ALLOWED_ORIGINS = (() => {
    const raw = process.env.ALLOWED_ORIGINS;
    if (typeof raw === "string" && raw.trim().length > 0) {
        return raw.split(",").map(s => s.trim()).filter(Boolean);
    }
    return [
        "https://void-room.space",
        "https://www.void-room.space",
        "https://app.void-room.space",
    ];
})();

export function isOriginAllowed(origin) {
    if (typeof origin !== "string" || origin.length === 0) return false;
    if (ALLOWED_ORIGINS.includes(origin)) return true;
    // dev-loopback на любом порту
    if (/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(origin)) return true;
    /* Tauri 2 bundled desktop app шлёт Origin: http://tauri.localhost (на
       Windows это реальная схема WebView2; на других платформах может быть
       tauri://localhost). Без этого WS verifyClient отвергает 403 и fetch'и
       к /api/* блокируются CORS. */
    if (/^(https?:\/\/)?tauri\.localhost$/.test(origin)) return true;
    return false;
}

export function getClientIp(req) {
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

export function isValidCode(code) {
    return typeof code === "string" && ROOM_CODE_REGEX.test(code);
}

export function isValidUserId(id) {
    return typeof id === "string" && USER_ID_REGEX.test(id);
}

export function sanitizeNickname(raw) {
    if (typeof raw !== "string") return "";
    return raw
        .replace(CONTROL_CHARS_RX, "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, NICKNAME_MAX_LEN);
}

export function noteFailedJoin(ip) {
    if (!ip) return;
    const now = Date.now();
    let entry = ipFailedJoins.get(ip);
    if (!entry || now - entry.windowStart > FAILED_JOIN_WINDOW_MS) {
        entry = { count: 0, windowStart: now, blockedUntil: 0 };
        ipFailedJoins.set(ip, entry);
    }
    entry.count += 1;
    if (entry.count >= FAILED_JOIN_LIMIT && !entry.blockedUntil) {
        entry.blockedUntil = now + FAILED_JOIN_BLOCK_MS;
        log.warn("security", "brute-force block", {
            ip,
            failedJoins: entry.count,
            blockMs: FAILED_JOIN_BLOCK_MS
        });
    }
}

export function isIpBlocked(ip) {
    if (!ip) return false;
    const entry = ipFailedJoins.get(ip);
    return !!(entry && entry.blockedUntil > Date.now());
}

export function clearFailedJoins(ip) {
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
