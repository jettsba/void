/* ========= LOGGER =========
 * Тонкая обёртка над console.* с уровнями и тегами. Загружается первой,
 * чтобы window.log был доступен во всех остальных скриптах.
 *
 * Уровни: error | warn | info | debug. По умолчанию — warn (только
 * настоящие проблемы, чистая консоль для обычного пользователя).
 *
 * Как включить полные логи (напр. для отладки бага у юзера):
 *   1. Добавить в URL ?debug=1 — действует на одну загрузку.
 *   2. В DevTools-консоли:  log.setLevel("debug")  — сохранится в localStorage.
 *      Сбросить: log.clearLevel().
 *
 * Использование в коде:
 *   log.info("ws", "reconnected");
 *   log.warn("rtc", "ice error", { err: e.message });
 *   log.debug("chat", "channel open", { userId });
 */
(function () {
    const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };

    let initial = "warn";
    try {
        const url = new URLSearchParams(location.search);
        if (url.has("debug")) initial = "debug";
        else {
            const stored = localStorage.getItem("void:log");
            if (stored && stored in LEVELS) initial = stored;
        }
    } catch (_) {}

    let active = LEVELS[initial];

    function ts() {
        return new Date().toISOString().slice(11, 19);
    }

    function emit(level, tag, msg, fields) {
        if (LEVELS[level] > active) return;
        const prefix = `${ts()} [${tag}]`;
        const fn = level === "error" ? console.error
                : level === "warn"  ? console.warn
                : level === "info"  ? console.info
                : console.debug;
        if (fields !== undefined) fn(prefix, msg, fields);
        else fn(prefix, msg);
    }

    window.log = {
        error: (tag, msg, fields) => emit("error", tag, msg, fields),
        warn:  (tag, msg, fields) => emit("warn",  tag, msg, fields),
        info:  (tag, msg, fields) => emit("info",  tag, msg, fields),
        debug: (tag, msg, fields) => emit("debug", tag, msg, fields),

        getLevel: () => Object.keys(LEVELS).find(k => LEVELS[k] === active),

        /** Сохранить уровень в localStorage. Действует пока не сбросишь. */
        setLevel(level) {
            if (!(level in LEVELS)) {
                console.warn("log.setLevel: unknown level", level, "— allowed:", Object.keys(LEVELS));
                return;
            }
            try { localStorage.setItem("void:log", level); } catch (_) {}
            active = LEVELS[level];
            console.info(`log level → ${level} (saved to localStorage)`);
        },

        /** Вернуться к дефолту warn. */
        clearLevel() {
            try { localStorage.removeItem("void:log"); } catch (_) {}
            active = LEVELS.warn;
            console.info("log level → warn (default)");
        }
    };
})();
