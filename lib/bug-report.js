/* ========= BUG REPORT ENDPOINT =========
 * POST /api/report-bug — принимает багрепорт из настроек клиента и шлёт
 * письмо через Yandex SMTP (smtp.yandex.ru:465). Используется вместо
 * Telegram Bot API, который заблокирован в РФ.
 *
 * Конфиг (env):
 *   BUG_SMTP_USER — адрес ящика отправителя (напр. krovmax@yandex.ru).
 *   BUG_SMTP_PASS — app-password от Яндекс.Почты (не пароль аккаунта!).
 *   BUG_SMTP_TO   — куда слать (опционально, дефолт = BUG_SMTP_USER).
 * Если USER или PASS не заданы — endpoint возвращает 503, UI показывает
 * стандартную «ошибка отправки». Фича включается когда задан env.
 *
 * Anti-abuse:
 *   - Лимит payload: 256 KB (express.json({limit})).
 *   - description ≤ 5000 chars, contact ≤ 200, report ≤ 100 KB.
 *   - Per-IP rate limit: 5 заявок / час (sliding window in-memory Map).
 *
 * Доставка:
 *   Text-письмо с описанием, контактом, lang, версией, IP-меткой, UA, URL, комнатой.
 *   Вместо IP — метка `ip#… (CC)` (lib/privacy.js): та же, что в docker-логах
 *   этих суток, по ней письмо сопоставляется с логами без сырого адреса.
 *   Если есть log.bugReport() — прикрепляется как bugreport-{ts}.txt.
 *
 * Приватность: код комнаты и id участников (свой и соседей) в письмо не уходят.
 * Клиентский отчёт их содержит (поля room/userId/peers и журнал), поэтому
 * сервер до отправки заменяет их в тексте на метки `room:<ref>` / `user:<ref>` —
 * те же, что в логах сервера. Сопоставить письмо с логами можно, узнать по нему
 * комнату или человека — нет.
 */

import nodemailer from "nodemailer";
import { log } from "./log.js";
import { getClientIp } from "./security.js";
import { ipTag, roomRef, userRef } from "./privacy.js";

const BUG_SMTP_USER = process.env.BUG_SMTP_USER || "";
const BUG_SMTP_PASS = process.env.BUG_SMTP_PASS || "";
const BUG_SMTP_TO   = process.env.BUG_SMTP_TO   || BUG_SMTP_USER;

const DESC_MAX   = 5000;
const CONTACT_MAX = 200;
const REPORT_MAX  = 100 * 1024;

const RATE_WINDOW_MS = 60 * 60 * 1000; // 1 час
const RATE_LIMIT = 5;
const rateMap = new Map(); // ip → [timestamps]

setInterval(() => {
    const cutoff = Date.now() - RATE_WINDOW_MS;
    for (const [ip, ts] of rateMap) {
        const fresh = ts.filter(t => t > cutoff);
        if (fresh.length === 0) rateMap.delete(ip);
        else if (fresh.length !== ts.length) rateMap.set(ip, fresh);
    }
}, 5 * 60 * 1000).unref?.();

function isRateLimited(ip) {
    const now = Date.now();
    const cutoff = now - RATE_WINDOW_MS;
    const arr = (rateMap.get(ip) || []).filter(t => t > cutoff);
    if (arr.length >= RATE_LIMIT) {
        rateMap.set(ip, arr);
        return true;
    }
    arr.push(now);
    rateMap.set(ip, arr);
    return false;
}

const ROOM_RX = /^[A-Z0-9]{4,8}$/;
const USER_ID_RX = /^[A-Za-z0-9_-]{4,64}$/;

/* Код комнаты и id участников из отчёта → метки. Длинные строки заменяем
   первыми, чтобы короткий код не порезал внутри себя более длинный id. */
export function scrubReport(text, parsed) {
    const swaps = new Map();
    if (typeof parsed.room === "string" && ROOM_RX.test(parsed.room)) {
        swaps.set(parsed.room, `room:${roomRef(parsed.room)}`);
    }
    const ids = [parsed.userId, ...(Array.isArray(parsed.peers) ? parsed.peers.map(p => p && p.userId) : [])];
    for (const id of ids) {
        if (typeof id === "string" && USER_ID_RX.test(id)) swaps.set(id, `user:${userRef(id)}`);
    }
    let out = text;
    for (const [from, to] of [...swaps].sort((a, b) => b[0].length - a[0].length)) {
        out = out.split(from).join(to);
    }
    return out;
}

function clip(str, max) {
    if (typeof str !== "string") return "";
    return str.length > max ? str.slice(0, max) + "…" : str;
}

function isConfigured() {
    return BUG_SMTP_USER && BUG_SMTP_PASS;
}

let _transport = null;
function getTransport() {
    if (!_transport) {
        _transport = nodemailer.createTransport({
            host: "smtp.yandex.ru",
            port: 465,
            secure: true,
            auth: { user: BUG_SMTP_USER, pass: BUG_SMTP_PASS }
        });
    }
    return _transport;
}

async function deliverToEmail({ description, contact, lang, ip, reportText, reportMeta }) {
    const lines = [
        "🐞 Void Bug Report",
        "=".repeat(40),
        "",
        `Lang:    ${lang || "?"}`,
        `Version: ${reportMeta.version || "?"}`,
        `IP:      ${ipTag(ip)}`,
        `Contact: ${contact || "(не указан)"}`,
    ];
    if (reportMeta.url)       lines.push(`URL:     ${reportMeta.url}`);
    if (reportMeta.room)      lines.push(`Room:    room=${roomRef(reportMeta.room)} (код не передаётся, только метка из логов)`);
    if (reportMeta.userAgent) lines.push(`UA:      ${reportMeta.userAgent}`);
    lines.push("", "-".repeat(40), "", description, "");

    const attachments = [];
    if (reportText) {
        attachments.push({
            filename: `bugreport-${Date.now()}.txt`,
            content: reportText,
            contentType: "text/plain"
        });
    }

    await getTransport().sendMail({
        from: `"Void Bug Report" <${BUG_SMTP_USER}>`,
        to: BUG_SMTP_TO,
        subject: `🐞 Void bug: ${description.slice(0, 60)}`,
        text: lines.join("\n"),
        attachments
    });
}

export function mountBugReport(app, jsonMiddleware) {
    app.post("/api/report-bug", jsonMiddleware, async (req, res) => {
        const ip = getClientIp(req);

        if (!isConfigured()) {
            log.warn("bug", "endpoint hit but smtp not configured", { ip });
            res.status(503).json({ error: "not configured" });
            return;
        }

        if (isRateLimited(ip)) {
            res.status(429).json({ error: "rate limited" });
            return;
        }

        const body = req.body || {};
        const description = clip(body.description, DESC_MAX).trim();
        const contact = clip(body.contact, CONTACT_MAX).trim();
        const lang = (typeof body.lang === "string" ? body.lang : "").slice(0, 8);

        if (!description) {
            res.status(400).json({ error: "description required" });
            return;
        }

        let reportText = typeof body.report === "string"
            ? body.report.slice(0, REPORT_MAX)
            : "";
        let reportMeta = {};
        if (reportText) {
            try {
                const parsed = JSON.parse(reportText);
                reportMeta = {
                    version: parsed.version,
                    url: parsed.url,
                    room: typeof parsed.room === "string" && ROOM_RX.test(parsed.room) ? parsed.room : null,
                    userAgent: parsed.userAgent
                };
                reportText = scrubReport(reportText, parsed);
                if (reportMeta.url && reportMeta.room) reportMeta.url = scrubReport(String(reportMeta.url), parsed);
            } catch (_) {
                /* Кривой JSON — без разбора не знаем, что в нём заменить, поэтому
                   и не прикладываем: лучше потерять отчёт, чем отправить код комнаты. */
                reportText = "";
            }
        }

        try {
            await deliverToEmail({ description, contact, lang, ip, reportText, reportMeta });
            log.info("bug", "report delivered via email", {
                ip,
                descLen: description.length,
                hasContact: !!contact,
                hasReport: !!reportText
            });
            res.status(204).end();
        } catch (err) {
            log.error("bug", "email delivery failed", { ip, err: err.message });
            res.status(502).json({ error: "delivery failed" });
        }
    });
}
