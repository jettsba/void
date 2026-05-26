/* ========= LEAVE BEACON ENDPOINT =========
 * POST /api/leave-room — приём `navigator.sendBeacon` от закрывающейся вкладки
 * с {code, userId}. Делает то же, что handleLeaveRoom: удаляет юзера из комнаты,
 * фиксирует session-duration, рассылает participant-left.
 *
 * Зачем: WS leave-room на pagehide часто теряется — TCP-буфер не flush'ится
 * до отправки FIN, мобильник внезапно умирает, browser kill'ит таб без шанса
 * закрыть socket штатно. sendBeacon — браузерная гарантия одного HTTP POST'а
 * перед смертью документа (спека описывает именно этот сценарий).
 *
 * Идемпотентен и безопасен: если юзера в комнате нет — no-op. Поэтому может
 * работать рядом с обычным leave-room через WS — что придёт первым, то и
 * сработает, второе будет no-op'ом.
 */

import { log } from "./log.js";
import { handleBeaconLeave } from "./handlers.js";
import { getClientIp, isValidCode, isValidUserId } from "./security.js";

/* Per-IP rate limit. sendBeacon по сценарию — ≤1 вызов на выход из вкладки.
   30/мин с большим запасом покрывает NAT-офисы (10+ юзеров за NAT'ом) и
   DevTools-сценарии быстрых рефрешей. Выше — это уже не легитимный паттерн. */
const RATE_WINDOW_MS = 60_000;
const RATE_LIMIT = 30;
const _ipBuckets = new Map(); // ip → { count, windowStart }

function isRateLimited(ip) {
    if (!ip) return false;
    const now = Date.now();
    let entry = _ipBuckets.get(ip);
    if (!entry || now - entry.windowStart > RATE_WINDOW_MS) {
        entry = { count: 0, windowStart: now };
        _ipBuckets.set(ip, entry);
    }
    entry.count += 1;
    return entry.count > RATE_LIMIT;
}

/* Чистка пустых/протухших bucket'ов раз в минуту. unref — не держит loop. */
setInterval(() => {
    const now = Date.now();
    for (const [ip, entry] of _ipBuckets) {
        if (now - entry.windowStart > RATE_WINDOW_MS) _ipBuckets.delete(ip);
    }
}, RATE_WINDOW_MS).unref?.();

export function mountLeaveBeaconEndpoint(app, jsonMiddleware) {
    app.post("/api/leave-room", jsonMiddleware, (req, res) => {
        const ip = getClientIp(req);

        /* 204 на любой outcome — sendBeacon ответа не ждёт и не ретраит,
           информативные коды смысла не несут. Лимит превышен → молча 204,
           чтобы не давать атакующему feedback'а. */
        if (isRateLimited(ip)) {
            res.status(204).end();
            return;
        }

        const body = req.body;
        if (!body || typeof body !== "object") {
            res.status(204).end();
            return;
        }

        const { code, userId } = body;
        if (!isValidCode(code) || !isValidUserId(userId)) {
            res.status(204).end();
            return;
        }

        try {
            handleBeaconLeave(code, userId);
        } catch (err) {
            log.warn("beacon", "leave failed", {
                code, userId, err: err?.message || String(err)
            });
        }
        res.status(204).end();
    });
}
