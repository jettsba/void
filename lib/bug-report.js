/* ========= BUG REPORT ENDPOINT =========
 * POST /api/report-bug — принимает багрепорт из настроек клиента и шлёт
 * push-уведомление в Telegram через bot API. Журнала на диск нет — доверяем
 * push-каналу (по согласованию).
 *
 * Конфиг (env):
 *   BUG_TG_TOKEN — токен бота от @BotFather (формат "1234567890:AaBbCc...").
 *   BUG_TG_CHAT  — chat_id куда слать (твой id из @userinfobot, или -100... для канала).
 * Если что-то из этого не задано — endpoint возвращает 503, и UI показывает
 * стандартную «ошибка отправки». Это значит: фича включается ровно когда
 * админ задал env'ы.
 *
 * Anti-abuse:
 *   - Лимит размера payload: 256 KB (express.json({limit}));
 *   - description ≤ 5000 chars, contact ≤ 200, report ≤ 100 KB после обрезки;
 *   - Per-IP rate limit: 5 заявок / час (sliding window in-memory Map).
 *
 * Telegram доставка:
 *   1) Шлём sendMessage с заголовком (description, contact, lang, version
 *      берётся из самого report'а если есть).
 *   2) Если есть report — отдельно шлём sendDocument с приклеенным .txt'ом.
 *      Это удобнее чем заталкивать в текст сообщения (Telegram режет на 4096
 *      символов, плюс лимиты MarkdownV2 экранирования).
 *
 * fetch() — нативный с Node 18+. Без зависимостей.
 */

import { log } from "./log.js";
import { getClientIp } from "./security.js";

const BUG_TG_TOKEN = process.env.BUG_TG_TOKEN || "";
const BUG_TG_CHAT = process.env.BUG_TG_CHAT || "";

const DESC_MAX = 5000;
const CONTACT_MAX = 200;
const REPORT_MAX = 100 * 1024;

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

/** Truncate to N chars и пометить, если резали. Для description/contact. */
function clip(str, max) {
    if (typeof str !== "string") return "";
    return str.length > max ? str.slice(0, max) + "…" : str;
}

function isConfigured() {
    return BUG_TG_TOKEN && BUG_TG_CHAT;
}

/* Telegram MarkdownV2 escape: эти символы должны быть с обратным слэшем,
   иначе API вернёт 400. Полный список из доки Bot API. */
const MDV2_SPECIAL = /([_*\[\]()~`>#+\-=|{}.!\\])/g;
function mdEscape(str) {
    return String(str).replace(MDV2_SPECIAL, "\\$1");
}

async function tgRequest(method, body, isMultipart) {
    const url = `https://api.telegram.org/bot${BUG_TG_TOKEN}/${method}`;
    const opts = { method: "POST" };
    if (isMultipart) {
        opts.body = body; // FormData
    } else {
        opts.headers = { "Content-Type": "application/json" };
        opts.body = JSON.stringify(body);
    }
    const res = await fetch(url, opts);
    const json = await res.json().catch(() => ({}));
    if (!res.ok || json.ok === false) {
        throw new Error(`telegram ${method} failed: ${res.status} ${JSON.stringify(json)}`);
    }
    return json;
}

async function deliverToTelegram({ description, contact, lang, ip, reportText, reportMeta }) {
    const lines = [
        "🐞 *void bug report*",
        "",
        `*lang:* \`${mdEscape(lang || "?")}\`  *version:* \`${mdEscape(reportMeta.version || "?")}\``,
        `*ip:* \`${mdEscape(ip || "?")}\``,
        contact ? `*contact:* ${mdEscape(contact)}` : `*contact:* _не указан_`,
        "",
        "*описание:*",
        mdEscape(description)
    ];
    if (reportMeta.url) lines.push("", `*url:* ${mdEscape(reportMeta.url)}`);
    if (reportMeta.room) lines.push(`*room:* \`${mdEscape(reportMeta.room)}\``);
    if (reportMeta.userAgent) lines.push(`*UA:* \`${mdEscape(reportMeta.userAgent)}\``);

    const text = lines.join("\n").slice(0, 3900); // Telegram cap 4096 с запасом

    await tgRequest("sendMessage", {
        chat_id: BUG_TG_CHAT,
        text,
        parse_mode: "MarkdownV2",
        disable_web_page_preview: true
    });

    if (reportText) {
        /* sendDocument: формируем multipart/form-data руками через FormData/Blob —
           они есть в глобальном scope в Node 18+. */
        const fd = new FormData();
        fd.append("chat_id", BUG_TG_CHAT);
        fd.append("document", new Blob([reportText], { type: "text/plain" }), `bugreport-${Date.now()}.txt`);
        fd.append("caption", "📎 log.bugReport() output");
        await tgRequest("sendDocument", fd, /*isMultipart*/ true);
    }
}

export function mountBugReport(app, jsonMiddleware) {
    app.post("/api/report-bug", jsonMiddleware, async (req, res) => {
        const ip = getClientIp(req);

        if (!isConfigured()) {
            log.warn("bug", "endpoint hit but telegram not configured", { ip });
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

        /* report — это JSON-строка от log.bugReport() (см. webrtc.js).
           Парсим без падения: если кривой — отправим как plain text. */
        const reportText = typeof body.report === "string"
            ? body.report.slice(0, REPORT_MAX)
            : "";
        let reportMeta = {};
        if (reportText) {
            try {
                const parsed = JSON.parse(reportText);
                reportMeta = {
                    version: parsed.version,
                    url: parsed.url,
                    room: parsed.room,
                    userAgent: parsed.userAgent
                };
            } catch (_) { /* кривой — оставляем reportMeta пустым */ }
        }

        try {
            await deliverToTelegram({ description, contact, lang, ip, reportText, reportMeta });
            log.info("bug", "report delivered", {
                ip,
                descLen: description.length,
                hasContact: !!contact,
                hasReport: !!reportText
            });
            res.status(204).end();
        } catch (err) {
            log.error("bug", "telegram delivery failed", { ip, err: err.message });
            res.status(502).json({ error: "delivery failed" });
        }
    });
}
