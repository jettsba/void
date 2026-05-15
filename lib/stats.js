/* ========= STATS =========
 * Дневные/lifetime метрики, debounced запись в JSON. Само хранилище и
 * объект stats — в lib/state.js (импортируется по ссылке).
 *
 * При импорте этого модуля автоматически читается ./data/stats.json
 * (или то, что задано в env STATS_FILE). Если файла нет — стартуем «с нуля».
 */

import fs from "node:fs";
import path from "node:path";
import { log } from "./log.js";
import { rooms, stats } from "./state.js";

export const STATS_FILE = process.env.STATS_FILE || "./data/stats.json";
const STATS_WRITE_DEBOUNCE_MS = 5_000;

// Агрегатор повторяющихся ошибок записи — чтобы EACCES не спамил логи раз в 5с.
const _writeErrWindow = 60_000;
let _writeErrEntry = null; // { code, count, firstAt, timer }

function _noteWriteError(e) {
    const code = e.code || "UNKNOWN";
    if (!_writeErrEntry) {
        log.error("stats", "write failed", { err: e.message });
        _writeErrEntry = {
            code,
            count: 1,
            firstAt: Date.now(),
            timer: setTimeout(() => {
                const entry = _writeErrEntry;
                _writeErrEntry = null;
                if (entry && entry.count > 1) {
                    log.error("stats", "write failed (aggregated)", {
                        code: entry.code,
                        attempts: entry.count,
                        windowSec: Math.round((Date.now() - entry.firstAt) / 1000),
                    });
                }
            }, _writeErrWindow),
        };
        _writeErrEntry.timer.unref?.();
        return;
    }
    _writeErrEntry.count += 1;
    _writeErrEntry.code = code;
}

export const DAY_KEY_RX = /^\d{4}-\d{2}-\d{2}$/;

try {
    const loaded = JSON.parse(fs.readFileSync(STATS_FILE, "utf8"));
    // Берём только ожидаемые поля известного типа — мусор/мутации игнорим.
    if (typeof loaded.since === "number") stats.since = loaded.since;
    if (typeof loaded.roomsCreated === "number") stats.roomsCreated = loaded.roomsCreated;
    // Старое поле userSessions раньше копилось при входе в комнату — теперь
    // переименовалось в usersRegistered. Если читаем старый файл, переносим
    // значение, чтобы не терять историю.
    if (typeof loaded.usersRegistered === "number") stats.usersRegistered = loaded.usersRegistered;
    else if (typeof loaded.userSessions === "number") stats.usersRegistered = loaded.userSessions;
    if (typeof loaded.participantSeconds === "number") stats.participantSeconds = loaded.participantSeconds;
    if (typeof loaded.peakConcurrentRooms === "number") stats.peakConcurrentRooms = loaded.peakConcurrentRooms;
    if (typeof loaded.peakConcurrentUsers === "number") stats.peakConcurrentUsers = loaded.peakConcurrentUsers;
    // ICE-воронка появилась позже — у старых файлов этих полей нет, дефолт 0.
    if (typeof loaded.iceDirect === "number") stats.iceDirect = loaded.iceDirect;
    if (typeof loaded.iceRelay === "number") stats.iceRelay = loaded.iceRelay;
    if (typeof loaded.iceFailed === "number") stats.iceFailed = loaded.iceFailed;
    if (loaded.daily && typeof loaded.daily === "object") {
        for (const [k, v] of Object.entries(loaded.daily)) {
            if (!DAY_KEY_RX.test(k) || !v || typeof v !== "object") continue;
            stats.daily[k] = {
                roomsCreated: +v.roomsCreated || 0,
                usersRegistered: +v.usersRegistered || +v.userSessions || 0,
                participantSeconds: +v.participantSeconds || 0,
                peakConcurrentRooms: +v.peakConcurrentRooms || 0,
                peakConcurrentUsers: +v.peakConcurrentUsers || 0,
                iceDirect: +v.iceDirect || 0,
                iceRelay: +v.iceRelay || 0,
                iceFailed: +v.iceFailed || 0
            };
        }
    }
    log.info("stats", "loaded", { file: STATS_FILE });
} catch (_) {
    log.info("stats", "starting fresh", { file: STATS_FILE });
}

export function dayKey(ms) {
    return new Date(ms).toISOString().slice(0, 10);
}

export function ensureDayBucket(key) {
    if (!stats.daily[key]) {
        stats.daily[key] = {
            roomsCreated: 0,
            usersRegistered: 0,
            participantSeconds: 0,
            peakConcurrentRooms: 0,
            peakConcurrentUsers: 0,
            iceDirect: 0,
            iceRelay: 0,
            iceFailed: 0
        };
    }
    return stats.daily[key];
}

export function bumpDaily(field, amount = 1, ms = Date.now()) {
    const b = ensureDayBucket(dayKey(ms));
    b[field] += amount;
}

export function maxDaily(field, value) {
    const b = ensureDayBucket(dayKey(Date.now()));
    if (value > b[field]) b[field] = value;
}

let statsWriteTimer = null;
export function scheduleStatsWrite() {
    if (statsWriteTimer) return;
    statsWriteTimer = setTimeout(flushStats, STATS_WRITE_DEBOUNCE_MS);
    statsWriteTimer.unref?.();
}

/* F17: коды транзиентных блокировок файла. Чаще всего встречаются на Windows
   когда антивирус / Explorer / sync-клиент (OneDrive, Dropbox) держат файл
   открытым ровно в момент rename. На Linux редко. */
const TRANSIENT_FS_ERRORS = new Set(["EBUSY", "EPERM", "ENOTEMPTY", "EACCES"]);
const STATS_RETRY_DELAYS_MS = [50, 200, 800];

function _writeStatsOnce() {
    const tmp = STATS_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(stats, null, 2));
    fs.renameSync(tmp, STATS_FILE);
}

function _retryFlushAsync(attempt) {
    if (attempt >= STATS_RETRY_DELAYS_MS.length) {
        _noteWriteError({ code: "EBUSY_EXHAUSTED", message: "stats write retries exhausted" });
        return;
    }
    const t = setTimeout(() => {
        try {
            _writeStatsOnce();
        } catch (e) {
            if (TRANSIENT_FS_ERRORS.has(e.code)) {
                _retryFlushAsync(attempt + 1);
            } else {
                _noteWriteError(e);
            }
        }
    }, STATS_RETRY_DELAYS_MS[attempt]);
    t.unref?.();
}

export function flushStats() {
    if (statsWriteTimer) {
        clearTimeout(statsWriteTimer);
        statsWriteTimer = null;
    }
    stats.updatedAt = Date.now();
    try {
        fs.mkdirSync(path.dirname(STATS_FILE), { recursive: true });
        _writeStatsOnce();
    } catch (e) {
        /* F17: если файл занят антивирусом/sync-клиентом (типично на Windows),
           даём ещё 2-3 попытки через 50/200/800 мс. Через setTimeout — чтобы
           не блокировать event loop. На SIGTERM ретраи не успеют, но первая
           попытка sync, так что shutdown-flush работает как раньше. */
        if (TRANSIENT_FS_ERRORS.has(e.code)) {
            _retryFlushAsync(0);
            return;
        }
        _noteWriteError(e);
    }
}

export function updatePeaks() {
    let totalUsers = 0;
    for (const r of rooms.values()) totalUsers += r.users.size;
    let dirty = false;
    if (rooms.size > stats.peakConcurrentRooms) {
        stats.peakConcurrentRooms = rooms.size;
        dirty = true;
    }
    if (totalUsers > stats.peakConcurrentUsers) {
        stats.peakConcurrentUsers = totalUsers;
        dirty = true;
    }
    // Дневные пики ведём всегда — даже если lifetime-пик не побит,
    // у конкретного дня может быть свой максимум.
    maxDaily("peakConcurrentRooms", rooms.size);
    maxDaily("peakConcurrentUsers", totalUsers);
    if (dirty) scheduleStatsWrite();
}

export function captureSessionDuration(ws) {
    if (!ws._joinedAt) return;
    const seconds = Math.max(0, (Date.now() - ws._joinedAt) / 1000);
    stats.participantSeconds += seconds;
    // Время присутствия записываем тому дню, когда сессия НАЧАЛАСЬ — иначе
    // ночной разговор «утекал бы» в следующий день и графики прыгали.
    bumpDaily("participantSeconds", seconds, ws._joinedAt);
    ws._joinedAt = null;
    scheduleStatsWrite();
}
