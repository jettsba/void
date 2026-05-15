/* ========= LOGGER =========
 * Тонкая обёртка над console.* с уровнями, тегами, ring buffer'ом и
 * глобальным перехватом необработанных ошибок.
 *
 * Уровни: error | warn | info | debug. По умолчанию — info (видим штатные
 * события: join/leave, peer state, reconnect). debug — для глубокой отладки.
 *
 * Как менять уровень:
 *   ?debug=1 в URL          — действует на одну загрузку.
 *   log.setLevel("debug")   — сохранится в localStorage. Сбросить: log.clearLevel().
 *
 * Использование в коде:
 *   log.info("ws", "reconnected");
 *   log.warn("rtc", "ice error", { err: e.message });
 *
 * Ring buffer (L3):
 *   log.dump()              — массив последних 300 записей (любых уровней).
 *   log.dumpString()        — те же записи как одна строка.
 *   log.clearBuffer()       — обнулить.
 *
 * Глобальные хендлеры (L2):
 *   window.onerror и unhandledrejection пишут в логгер с тегом "global" —
 *   ни одно async-исключение больше не уйдёт в тишину.
 */
(function () {
    const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };

    let initial = "info";
    try {
        const url = new URLSearchParams(location.search);
        if (url.has("debug")) initial = "debug";
        else {
            const stored = localStorage.getItem("void:log");
            if (stored && stored in LEVELS) initial = stored;
        }
    } catch (_) {}

    let active = LEVELS[initial];

    /* L3: ring buffer на последние RING_CAP записей. Хранит ВСЕ уровни
       независимо от `active` — чтобы dump() после факта мог достать дебаг,
       даже если консоль в момент инцидента была на warn. */
    const RING_CAP = 300;
    const ring = [];

    function ts() {
        return new Date().toISOString().slice(11, 19);
    }

    function emit(level, tag, msg, fields) {
        /* В буфер пишем всегда (полная история, любые уровни).
           В консоль — только то, что подходит по active. */
        ring.push({ ts: Date.now(), level, tag, msg, fields });
        if (ring.length > RING_CAP) ring.shift();

        if (LEVELS[level] > active) return;
        const prefix = `${ts()} [${tag}]`;
        const fn = level === "error" ? console.error
                : level === "warn"  ? console.warn
                : level === "info"  ? console.info
                : console.debug;
        if (fields !== undefined) fn(prefix, msg, fields);
        else fn(prefix, msg);
    }

    function formatEntry(e) {
        const isoMs = new Date(e.ts).toISOString().slice(11, 23);
        let line = `${isoMs} ${e.level.toUpperCase().padEnd(5)} [${e.tag}] ${e.msg}`;
        if (e.fields !== undefined) {
            try { line += " " + JSON.stringify(e.fields); }
            catch (_) { line += " [unserializable fields]"; }
        }
        return line;
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

        /** Вернуться к дефолту info. */
        clearLevel() {
            try { localStorage.removeItem("void:log"); } catch (_) {}
            active = LEVELS.info;
            console.info("log level → info (default)");
        },

        /** L3: snapshot буфера (последние 300 записей, любые уровни).
         *  Юзер прислал баг-репорт → "набери copy(log.dump())". */
        dump: () => ring.slice(),
        dumpString: () => ring.map(formatEntry).join("\n"),
        clearBuffer: () => { ring.length = 0; }

        /* dumpStats — биндится из webrtc.js при инициализации (L5). */
    };

    /* L2: глобальный перехват необработанных ошибок. Без этого async
       исключения (промисы в WebRTC handlers, setTimeout-колбэках, etc)
       молча исчезают, и в консоли — пустота даже при реальном крэше. */
    window.addEventListener("error", (event) => {
        emit("error", "global", "uncaught", {
            msg: event.message,
            src: event.filename,
            line: event.lineno,
            col: event.colno,
            stack: event.error?.stack
        });
    });
    window.addEventListener("unhandledrejection", (event) => {
        const reason = event.reason;
        emit("error", "global", "unhandled rejection", {
            msg: reason?.message || String(reason),
            stack: reason?.stack
        });
    });
})();
