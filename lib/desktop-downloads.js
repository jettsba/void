/* ========= DESKTOP DOWNLOADS =========
 * Счётчик загрузок desktop-приложения из GitHub Releases. GitHub сам ведёт
 * `download_count` на каждый ассет — мы ничего не инструментируем на клиенте,
 * а периодически опрашиваем API и кешируем число для /adminstats.
 *
 * Считаем ТОЛЬКО то, на что ведут кнопки лендинга: void_installer.exe +
 * void_portable.exe (суммарно по всем релизам). Намеренно НЕ считаем:
 *   - latest.json    — манифест авто-апдейтера, дёргается каждым установленным
 *                      аппом при проверке обновлений (это пинги, не загрузки);
 *   - void_setup.exe + .sig — бандл авто-апдейта (обновления уже установленных,
 *                      а не новые скачивания).
 *
 * Поллинг раз в 30 мин — unauthenticated GitHub API даёт 60 req/час на IP,
 * так что 2 req/час с огромным запасом. Кеш in-memory: на рестарте число
 * восстанавливается первым же fetch'ем за пару секунд, персистить незачем.
 */

import { log } from "./log.js";

const REPO = "jettsba/void-desktop";
const API_URL = `https://api.github.com/repos/${REPO}/releases?per_page=100`;

const POLL_INTERVAL_MS = 30 * 60 * 1000;
const FETCH_TIMEOUT_MS = 10 * 1000;

/* Последний успешный снапшот. total=null → ещё ни разу не получили (рисуем «—»).
   При ошибке fetch'а держим прошлое значение, помечая stale через fetchedAt. */
let _cache = { total: null, installer: 0, portable: 0, fetchedAt: 0 };

async function fetchDesktopDownloads() {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    try {
        const res = await fetch(API_URL, {
            headers: {
                // GitHub отдаёт 403 без User-Agent.
                "User-Agent": "void-room-adminstats",
                "Accept": "application/vnd.github+json"
            },
            signal: ctrl.signal
        });
        if (!res.ok) {
            log.warn("stats", "desktop downloads fetch non-ok", { status: res.status });
            return;
        }
        const releases = await res.json();
        if (!Array.isArray(releases)) return;

        let installer = 0, portable = 0;
        for (const rel of releases) {
            if (!rel || !Array.isArray(rel.assets)) continue;
            for (const a of rel.assets) {
                if (!a || typeof a.download_count !== "number") continue;
                if (a.name === "void_installer.exe") installer += a.download_count;
                else if (a.name === "void_portable.exe") portable += a.download_count;
            }
        }
        _cache = { total: installer + portable, installer, portable, fetchedAt: Date.now() };
        log.info("stats", "desktop downloads refreshed", { total: _cache.total, installer, portable });
    } catch (e) {
        // Таймаут / сеть / парсинг — оставляем прошлый снапшот, не роняем поллинг.
        log.warn("stats", "desktop downloads fetch failed", { err: e.message });
    } finally {
        clearTimeout(timer);
    }
}

export function startDesktopDownloadsPolling() {
    fetchDesktopDownloads();
    const t = setInterval(fetchDesktopDownloads, POLL_INTERVAL_MS);
    t.unref?.();
}

export function getDesktopDownloads() {
    return _cache;
}
