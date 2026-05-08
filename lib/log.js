/* ========= LOGGER =========
 * Тонкая обёртка над console.* с уровнями и тегами.
 *
 * Уровень задаётся через env LOG_LEVEL: error | warn | info | debug
 * Дефолт — info. На проде имеет смысл оставить info (это и есть «нормальный
 * шум» — комнаты, рестарты, security-события). debug — когда ловишь баг.
 *
 * Использование:
 *   log.info("room", "created", { code, ip });
 *   log.warn("security", "origin rejected", { origin });
 *   log.error("stats", "write failed", { err: e.message });
 *
 * Формат строки в логах:
 *   2026-05-07 21:34:11 INFO  [room] created code=MNXH2 ip=172.20.0.1
 */
const LOG_LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const _logActive = LOG_LEVELS[(process.env.LOG_LEVEL || "info").toLowerCase()] ?? LOG_LEVELS.info;

function _logEmit(level, tag, msg, fields) {
    if (LOG_LEVELS[level] > _logActive) return;
    const ts = new Date().toISOString().replace("T", " ").slice(0, 19);
    let line = `${ts} ${level.toUpperCase().padEnd(5)} [${tag}] ${msg}`;
    if (fields) {
        const parts = [];
        for (const k of Object.keys(fields)) {
            const v = fields[k];
            if (v === undefined || v === null || v === "") continue;
            const s = typeof v === "string" && /\s/.test(v) ? JSON.stringify(v) : String(v);
            parts.push(`${k}=${s}`);
        }
        if (parts.length) line += " " + parts.join(" ");
    }
    if (level === "error") console.error(line);
    else if (level === "warn") console.warn(line);
    else console.log(line);
}

export const log = {
    error: (tag, msg, fields) => _logEmit("error", tag, msg, fields),
    warn:  (tag, msg, fields) => _logEmit("warn",  tag, msg, fields),
    info:  (tag, msg, fields) => _logEmit("info",  tag, msg, fields),
    debug: (tag, msg, fields) => _logEmit("debug", tag, msg, fields),
};
