/* ========= DOWNLOAD BEACON =========
 * POST /api/dl-hit — клик-счётчик скачиваний desktop с зеркала void-room.space/dl.
 * Кнопка лендинга ПЕРЕД запуском загрузки шлёт {asset:"installer"|"portable"};
 * инкрементим lifetime-счётчик в stats (персист в stats.json) для /adminstats.
 *
 * Зачем не GitHub API: загрузки переехали на свой домен (GitHub в РФ нестабилен),
 * Caddy раздаёт /dl напрямую мимо node, поэтому видеть их node может только так.
 * Это счётчик НАМЕРЕНИЯ (отменённая загрузка тоже засчитается) — для vanity-
 * метрики достаточно. Updater-трафик (void_setup.exe, latest.json) сюда не идёт:
 * бикон шлёт только кнопка скачивания.
 *
 * Идемпотентность не нужна (это счётчик), но per-IP rate limit ставим — чтобы
 * нельзя было накрутить число одним клиентом. Паттерн тот же, что в leave-beacon.
 */

import { log } from "./log.js";
import { stats } from "./state.js";
import { scheduleStatsWrite } from "./stats.js";
import { getClientIp } from "./security.js";

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

setInterval(() => {
    const now = Date.now();
    for (const [ip, entry] of _ipBuckets) {
        if (now - entry.windowStart > RATE_WINDOW_MS) _ipBuckets.delete(ip);
    }
}, RATE_WINDOW_MS).unref?.();

export function mountDownloadBeaconEndpoint(app, jsonMiddleware) {
    app.post("/api/dl-hit", jsonMiddleware, (req, res) => {
        const ip = getClientIp(req);
        // 204 на любой исход — бикон ответа не ждёт; превышение лимита глушим молча.
        if (isRateLimited(ip)) {
            res.status(204).end();
            return;
        }
        const asset = req.body && req.body.asset;
        if (asset === "installer") stats.installerDownloads += 1;
        else if (asset === "portable") stats.portableDownloads += 1;
        else {
            res.status(204).end();
            return;
        }
        scheduleStatsWrite();
        log.info("stats", "desktop download", { asset });
        res.status(204).end();
    });
}
