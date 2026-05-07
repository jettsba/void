import express from "express";
import { WebSocketServer } from "ws";
import http from "http";
import fs from "node:fs";
import path from "node:path";

const app = express();
const PORT = process.env.PORT || 3000;

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

const log = {
    error: (tag, msg, fields) => _logEmit("error", tag, msg, fields),
    warn:  (tag, msg, fields) => _logEmit("warn",  tag, msg, fields),
    info:  (tag, msg, fields) => _logEmit("info",  tag, msg, fields),
    debug: (tag, msg, fields) => _logEmit("debug", tag, msg, fields),
};

/* ========= ADMIN STATS ========= */

/**
 * Простая статистика beta-теста: сколько комнат/сессий/минут присутствия.
 * Хранится в одном JSON-файле, который смонтирован volume'ом — при ребилде
 * контейнера данные не теряются. Реальный voice-трафик идёт P2P, сервер
 * байты не видит — поэтому в качестве «минут разговора» считаем
 * participant-seconds (сумма по всем сессиям длительности «юзер был в комнате»).
 */

const STATS_FILE = process.env.STATS_FILE || "./data/stats.json";
const ADMIN_STATS_PASSWORD = process.env.ADMIN_STATS_PASSWORD || "";
const STATS_WRITE_DEBOUNCE_MS = 5_000;

const stats = {
    since: Date.now(),
    roomsCreated: 0,
    /**
     * Количество "регистраций" — клиент сгенерировал ник/userId и подключился.
     * Считается по сообщению "hello" (один раз на загрузку вкладки).
     * Не включает входы в комнаты — туда метрика участия идёт через
     * participantSeconds.
     */
    usersRegistered: 0,
    participantSeconds: 0,
    peakConcurrentRooms: 0,
    peakConcurrentUsers: 0,
    /** Дневные срезы. Ключ — "YYYY-MM-DD" в UTC. */
    daily: {},
    updatedAt: Date.now()
};

const DAY_KEY_RX = /^\d{4}-\d{2}-\d{2}$/;

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
    if (loaded.daily && typeof loaded.daily === "object") {
        for (const [k, v] of Object.entries(loaded.daily)) {
            if (!DAY_KEY_RX.test(k) || !v || typeof v !== "object") continue;
            stats.daily[k] = {
                roomsCreated: +v.roomsCreated || 0,
                usersRegistered: +v.usersRegistered || +v.userSessions || 0,
                participantSeconds: +v.participantSeconds || 0,
                peakConcurrentRooms: +v.peakConcurrentRooms || 0,
                peakConcurrentUsers: +v.peakConcurrentUsers || 0
            };
        }
    }
    log.info("stats", "loaded", { file: STATS_FILE });
} catch (_) {
    log.info("stats", "starting fresh", { file: STATS_FILE });
}

function dayKey(ms) {
    return new Date(ms).toISOString().slice(0, 10);
}

function ensureDayBucket(key) {
    if (!stats.daily[key]) {
        stats.daily[key] = {
            roomsCreated: 0,
            usersRegistered: 0,
            participantSeconds: 0,
            peakConcurrentRooms: 0,
            peakConcurrentUsers: 0
        };
    }
    return stats.daily[key];
}

function bumpDaily(field, amount = 1, ms = Date.now()) {
    const b = ensureDayBucket(dayKey(ms));
    b[field] += amount;
}

function maxDaily(field, value) {
    const b = ensureDayBucket(dayKey(Date.now()));
    if (value > b[field]) b[field] = value;
}

let statsWriteTimer = null;
function scheduleStatsWrite() {
    if (statsWriteTimer) return;
    statsWriteTimer = setTimeout(flushStats, STATS_WRITE_DEBOUNCE_MS);
    statsWriteTimer.unref?.();
}

function flushStats() {
    if (statsWriteTimer) {
        clearTimeout(statsWriteTimer);
        statsWriteTimer = null;
    }
    stats.updatedAt = Date.now();
    try {
        fs.mkdirSync(path.dirname(STATS_FILE), { recursive: true });
        const tmp = STATS_FILE + ".tmp";
        fs.writeFileSync(tmp, JSON.stringify(stats, null, 2));
        fs.renameSync(tmp, STATS_FILE);
    } catch (e) {
        log.error("stats", "write failed", { err: e.message });
    }
}

function updatePeaks() {
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

function captureSessionDuration(ws) {
    if (!ws._joinedAt) return;
    const seconds = Math.max(0, (Date.now() - ws._joinedAt) / 1000);
    stats.participantSeconds += seconds;
    // Время присутствия записываем тому дню, когда сессия НАЧАЛАСЬ — иначе
    // ночной разговор «утекал бы» в следующий день и графики прыгали.
    bumpDaily("participantSeconds", seconds, ws._joinedAt);
    ws._joinedAt = null;
    scheduleStatsWrite();
}

function shutdownGracefully(signal) {
    log.info("boot", "shutdown signal, flushing stats", { signal });
    // На активные сессии — добавляем накопленное время, чтобы не потерять.
    const now = Date.now();
    for (const room of rooms.values()) {
        for (const user of room.users.values()) {
            if (user.ws._joinedAt) {
                stats.participantSeconds += (now - user.ws._joinedAt) / 1000;
                user.ws._joinedAt = null;
            }
        }
    }
    flushStats();
    process.exit(0);
}
process.on("SIGTERM", () => shutdownGracefully("SIGTERM"));
process.on("SIGINT",  () => shutdownGracefully("SIGINT"));

/* ========= ADMIN STATS ENDPOINT ========= */

app.get("/adminstats", (req, res) => {
    if (!ADMIN_STATS_PASSWORD) {
        res.status(503).type("text/plain")
            .send("admin stats disabled — set ADMIN_STATS_PASSWORD env var");
        return;
    }
    const auth = req.headers.authorization || "";
    let pass = "";
    if (auth.startsWith("Basic ")) {
        try {
            const decoded = Buffer.from(auth.slice(6), "base64").toString("utf8");
            const idx = decoded.indexOf(":");
            pass = idx >= 0 ? decoded.slice(idx + 1) : "";
        } catch (_) {}
    }
    if (pass !== ADMIN_STATS_PASSWORD) {
        res.set("WWW-Authenticate", 'Basic realm="void admin"');
        res.status(401).type("text/plain").send("auth required");
        return;
    }
    res.set("Cache-Control", "no-store");
    res.type("text/html; charset=utf-8").send(renderStatsHtml(req.query));
});

const VALID_PERIODS = new Set(["7", "14", "30", "90", "all"]);

function renderStatsHtml(query = {}) {
    /* ---- разбираем query ---- */
    const today = dayKey(Date.now());
    const day = (typeof query.day === "string" && DAY_KEY_RX.test(query.day)) ? query.day : today;
    const period = VALID_PERIODS.has(query.period) ? query.period : "7";

    /* ---- live-снапшот ---- */
    // active users = ВСЕ открытые WebSocket'ы (включая лобби, не только тех,
    // кто уже зашёл в комнату). Лобби-сокет открывается клиентом сразу после
    // прохождения пароля, поэтому wss.clients.size — это "сколько вкладок
    // сейчас открыто на сайте".
    const liveUsers = wss.clients.size;
    const liveRooms = rooms.size;

    let activeSeconds = 0;
    const now = Date.now();
    for (const r of rooms.values()) {
        for (const u of r.users.values()) {
            if (u.ws._joinedAt) activeSeconds += (now - u.ws._joinedAt) / 1000;
        }
    }

    /* ---- daily-срез выбранного дня ---- */
    const dayBucket = stats.daily[day] || {
        roomsCreated: 0, usersRegistered: 0, participantSeconds: 0,
        peakConcurrentRooms: 0, peakConcurrentUsers: 0
    };

    let dayPresenceSeconds = dayBucket.participantSeconds;
    if (day === today) dayPresenceSeconds += activeSeconds;

    /* ---- соседние дни для кнопок prev/next ---- */
    const allDays = Object.keys(stats.daily).sort();
    if (!allDays.includes(today)) allDays.push(today);
    allDays.sort();
    const dayIdx = allDays.indexOf(day);
    const prevDay = dayIdx > 0 ? allDays[dayIdx - 1] : null;
    const nextDay = (dayIdx >= 0 && dayIdx < allDays.length - 1) ? allDays[dayIdx + 1] : null;

    /* ---- данные для графика ---- */
    const chartDays = (() => {
        if (period === "all") return allDays.slice();
        const n = parseInt(period, 10);
        const arr = [];
        for (let i = n - 1; i >= 0; i--) arr.push(dayKey(now - i * 86400000));
        return arr;
    })();

    const chartData = chartDays.map(d => {
        const b = stats.daily[d];
        return {
            day: d,
            users: b ? b.usersRegistered : 0,
            rooms: b ? b.roomsCreated : 0
        };
    });

    /* ---- helpers ---- */
    function fmtDate(ms) {
        return new Date(ms).toISOString().replace("T", " ").slice(0, 19) + " UTC";
    }
    function fmtN(n) { return Number(n).toLocaleString("en-US"); }
    function fmtDuration(seconds) {
        const total = Math.floor(seconds);
        const d = Math.floor(total / 86400);
        const h = Math.floor((total % 86400) / 3600);
        const m = Math.floor((total % 3600) / 60);
        if (d > 0) return `${d}d ${h}h ${m}m`;
        if (h > 0) return `${h}h ${m}m`;
        return `${m}m`;
    }

    const chartHtml = renderChart(chartData);

    /* ---- селекторы ---- */
    const periodBtns = ["7", "14", "30", "90", "all"].map(p => {
        const active = p === period ? " is-active" : "";
        const label = p === "all" ? "all" : (p + "d");
        return `<a class="seg${active}" href="?day=${day}&period=${p}">${label}</a>`;
    }).join("");

    const prevHref = prevDay ? `?day=${prevDay}&period=${period}` : null;
    const nextHref = nextDay ? `?day=${nextDay}&period=${period}` : null;
    const todayHref = `?day=${today}&period=${period}`;

    /* ---- разметка ---- */
    return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta http-equiv="refresh" content="15">
<meta name="robots" content="noindex,nofollow">
<title>void :: nav console</title>
<style>
*{box-sizing:border-box}
:root{
    --bg:#06060a;
    --bg-1:#0c0c12;
    --bg-2:#10101a;
    --line:#1d1d2a;
    --line-2:#262636;
    --fg:#e6e6ec;
    --fg-2:#a8a8b6;
    --fg-3:#6c6c7a;
    --accent:#7ed6e6;
    --accent-dim:#3a8290;
    --warn:#e6b07e;
}
html,body{margin:0;padding:0}
body{
    font:12px/1.45 ui-monospace,"DotGothic16",Menlo,Consolas,monospace;
    background:var(--bg);
    color:var(--fg);
    min-height:100vh;
    background-image:
        radial-gradient(ellipse 80% 50% at 50% 0%, rgba(126,214,230,0.04), transparent 70%),
        radial-gradient(ellipse 60% 40% at 80% 100%, rgba(126,214,230,0.03), transparent 70%);
    background-attachment:fixed;
    letter-spacing:.02em;
}
::selection{background:var(--accent-dim);color:#fff}
a{color:inherit}

.console{
    max-width:1240px;
    margin:0 auto;
    padding:18px 28px 24px;
}

/* ── HEADER ── */
.hud-header{
    display:flex;align-items:center;justify-content:space-between;
    border-bottom:1px solid var(--line);
    padding:0 0 10px;
    margin-bottom:18px;
    font-size:10px;letter-spacing:.22em;text-transform:uppercase;color:var(--fg-2);
}
.hud-header .brand{color:var(--fg)}
.hud-header .brand-tag{color:var(--fg-3);margin-left:10px}
.hud-header .ts{color:var(--fg-3);font-variant-numeric:tabular-nums}
.live-dot{
    display:inline-block;width:6px;height:6px;border-radius:50%;
    background:var(--accent);box-shadow:0 0 8px var(--accent);
    margin-right:6px;vertical-align:middle;
    animation:pulse 1.6s ease-in-out infinite;
}
@keyframes pulse{
    0%,100%{opacity:.4;transform:scale(.85)}
    50%{opacity:1;transform:scale(1.15)}
}

/* ── 3-COLUMN GRID ── */
.cols{
    display:grid;
    grid-template-columns:0.85fr 1fr 1fr;
    gap:18px;
    margin-bottom:18px;
}
.col{display:flex;flex-direction:column;min-width:0}

/* ── SECTION HEADER ── */
.sec-head{
    display:flex;align-items:center;gap:10px;
    font-size:9px;letter-spacing:.22em;text-transform:uppercase;color:var(--fg-3);
    margin:0 0 10px;height:22px;
}
.sec-head .label{flex-shrink:0}
.sec-head .label.live{color:var(--accent)}
.sec-head::after{content:"";flex:1;height:1px;background:var(--line)}
.sec-head .controls{
    display:flex;align-items:center;gap:4px;color:var(--fg-2);
    flex-wrap:wrap;justify-content:flex-end;flex-shrink:0;
}
.sec-head .controls a{
    color:var(--fg-2);text-decoration:none;
    border:1px solid var(--line-2);
    padding:1px 6px;border-radius:2px;
    transition:all .12s ease;
    font-size:9px;letter-spacing:.16em;
}
.sec-head .controls a:hover{border-color:var(--accent-dim);color:var(--fg)}
.sec-head .controls a.is-active{
    color:var(--accent);border-color:var(--accent-dim);
    background:rgba(126,214,230,0.06);
}
.sec-head .controls a.disabled{opacity:.3;pointer-events:none}
.sec-head .controls .day-cur{
    color:var(--fg);font-variant-numeric:tabular-nums;letter-spacing:.08em;
    padding:0 4px;font-size:10px;
}

/* ── READOUTS — вертикальный стек внутри колонки ── */
.readouts{
    display:flex;flex-direction:column;gap:1px;
    background:var(--line);border:1px solid var(--line);
}
.readout{
    background:var(--bg-1);
    padding:9px 14px;
    display:flex;align-items:baseline;justify-content:space-between;gap:12px;
}
.readout-label{
    font-size:8px;letter-spacing:.22em;text-transform:uppercase;color:var(--fg-3);
    flex-shrink:0;
}
.readout-value{
    font-size:18px;color:var(--fg);font-variant-numeric:tabular-nums;
    letter-spacing:.04em;line-height:1;
    text-align:right;
    white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
}
.readout.is-live .readout-value{color:var(--accent)}
.readout.is-peak .readout-value{color:var(--warn)}

/* ── CHART (full-width row) ── */
.chart-row{margin-top:6px}
.chart-frame{
    border:1px solid var(--line);
    background:linear-gradient(180deg, var(--bg-1), var(--bg-2));
    padding:10px 14px 4px;
}
.chart-meta{
    display:flex;align-items:center;justify-content:space-between;
    font-size:8px;letter-spacing:.22em;text-transform:uppercase;color:var(--fg-3);
    margin-bottom:6px;
}
.legend-dot{display:inline-block;width:8px;height:8px;border-radius:50%;vertical-align:middle;margin-right:5px}
.chart-svg{display:block;width:100%;height:auto}

/* ── FOOTER ── */
.hud-footer{
    border-top:1px solid var(--line);
    margin-top:14px;padding-top:10px;
    font-size:8px;letter-spacing:.22em;text-transform:uppercase;color:var(--fg-3);
    display:flex;flex-wrap:wrap;gap:16px;
}
.hud-footer span{color:var(--fg-2);font-variant-numeric:tabular-nums}

/* ── RESPONSIVE ── */
@media (max-width:900px){
    .cols{grid-template-columns:1fr;gap:14px}
}
@media (max-width:600px){
    .console{padding:14px 14px 24px}
    .hud-header{flex-direction:column;align-items:flex-start;gap:6px}
    .sec-head{flex-wrap:wrap;height:auto;padding:4px 0}
    .sec-head .controls{justify-content:flex-start}
}
</style>
</head>
<body>
<div class="console">

<div class="hud-header">
    <div>
        <span class="brand">void</span>
        <span class="brand-tag">:: nav console</span>
    </div>
    <div class="ts"><span class="live-dot"></span>${fmtDate(now).replace(" UTC","")} · UTC</div>
</div>

<div class="cols">

    <!-- ── LIVE ── -->
    <div class="col">
        <div class="sec-head">
            <span class="label live">// live</span>
        </div>
        <div class="readouts">
            <div class="readout is-live">
                <div class="readout-label">active rooms</div>
                <div class="readout-value">${liveRooms}</div>
            </div>
            <div class="readout is-live">
                <div class="readout-label">active users</div>
                <div class="readout-value">${liveUsers}</div>
            </div>
            <div class="readout is-live">
                <div class="readout-label">live presence</div>
                <div class="readout-value">${fmtDuration(activeSeconds)}</div>
            </div>
        </div>
    </div>

    <!-- ── DAILY ── -->
    <div class="col">
        <div class="sec-head">
            <span class="label">// daily</span>
            <span class="controls">
                <a href="${prevHref || '#'}" class="${prevHref ? '' : 'disabled'}">‹</a>
                <span class="day-cur">${day}</span>
                <a href="${nextHref || '#'}" class="${nextHref ? '' : 'disabled'}">›</a>
                <a href="${todayHref}">today</a>
            </span>
        </div>
        <div class="readouts">
            <div class="readout">
                <div class="readout-label">rooms created</div>
                <div class="readout-value">${fmtN(dayBucket.roomsCreated)}</div>
            </div>
            <div class="readout">
                <div class="readout-label">users</div>
                <div class="readout-value">${fmtN(dayBucket.usersRegistered)}</div>
            </div>
            <div class="readout">
                <div class="readout-label">presence</div>
                <div class="readout-value">${fmtDuration(dayPresenceSeconds)}</div>
            </div>
            <div class="readout is-peak">
                <div class="readout-label">peak rooms</div>
                <div class="readout-value">${dayBucket.peakConcurrentRooms}</div>
            </div>
            <div class="readout is-peak">
                <div class="readout-label">peak users</div>
                <div class="readout-value">${dayBucket.peakConcurrentUsers}</div>
            </div>
        </div>
    </div>

    <!-- ── LIFETIME ── -->
    <div class="col">
        <div class="sec-head">
            <span class="label">// lifetime</span>
        </div>
        <div class="readouts">
            <div class="readout">
                <div class="readout-label">rooms created</div>
                <div class="readout-value">${fmtN(stats.roomsCreated)}</div>
            </div>
            <div class="readout">
                <div class="readout-label">users</div>
                <div class="readout-value">${fmtN(stats.usersRegistered)}</div>
            </div>
            <div class="readout">
                <div class="readout-label">presence</div>
                <div class="readout-value">${fmtDuration(stats.participantSeconds + activeSeconds)}</div>
            </div>
            <div class="readout is-peak">
                <div class="readout-label">peak rooms</div>
                <div class="readout-value">${stats.peakConcurrentRooms}</div>
            </div>
            <div class="readout is-peak">
                <div class="readout-label">peak users</div>
                <div class="readout-value">${stats.peakConcurrentUsers}</div>
            </div>
        </div>
    </div>

</div>

<!-- ── CHART (full width) ── -->
<div class="chart-row">
    <div class="sec-head">
        <span class="label">// growth · ${period === "all" ? "all time" : period + " days"}</span>
        <span class="controls">${periodBtns}</span>
    </div>
    <div class="chart-frame">
        <div class="chart-meta">
            <span>daily activity</span>
            <span>
                <span class="legend-dot" style="background:var(--accent)"></span>users
                &nbsp;&nbsp;
                <span class="legend-dot" style="background:var(--warn)"></span>rooms
            </span>
        </div>
        ${chartHtml}
    </div>
</div>

<div class="hud-footer">
    <div>since <span>${fmtDate(stats.since)}</span></div>
    <div>updated <span>${fmtDate(stats.updatedAt)}</span></div>
    <div>auto-refresh <span>15s</span></div>
</div>

</div>
</body></html>`;
}

/**
 * Простенький SVG-график. Никакого JS, никаких внешних библиотек.
 * Для каждого дня рисуем два тонких столбца: sessions (cyan) и rooms (amber)
 * рядом друг с другом. Высота относительно максимума по обеим метрикам.
 * При наведении на день браузер покажет нативный tooltip из <title>.
 */
function renderChart(data) {
    if (data.length === 0) {
        return `<div style="padding:32px;text-align:center;color:var(--fg-3);font-size:11px;letter-spacing:.16em">no data yet</div>`;
    }

    const W = 880;
    const H = 180;
    const padL = 36, padR = 12, padT = 10, padB = 28;
    const innerW = W - padL - padR;
    const innerH = H - padT - padB;

    const maxVal = Math.max(1, ...data.flatMap(d => [d.users, d.rooms]));
    const xStep = innerW / data.length;
    const barGroupW = Math.min(xStep * 0.7, 48);
    const barW = barGroupW / 2 - 1;

    // округляем maxVal до приятного числа для сетки
    const niceMax = (() => {
        const exp = Math.pow(10, Math.floor(Math.log10(maxVal)));
        for (const m of [1, 2, 5, 10]) {
            if (m * exp >= maxVal) return m * exp;
        }
        return maxVal;
    })();

    function y(v) { return padT + innerH - (v / niceMax) * innerH; }
    function x(i) { return padL + xStep * i + xStep / 2; }

    // ось Y — три отметки
    const yTicks = [0, niceMax / 2, niceMax];
    const yLines = yTicks.map(t => {
        const yy = y(t);
        return `<line x1="${padL}" y1="${yy}" x2="${W - padR}" y2="${yy}" stroke="var(--line)" stroke-dasharray="${t === 0 ? '' : '2,4'}"/>
                <text x="${padL - 6}" y="${yy + 3}" text-anchor="end" font-size="9" fill="var(--fg-3)" font-family="ui-monospace,monospace">${Math.round(t)}</text>`;
    }).join("");

    // решаем сколько меток на оси X показать (чтобы не слипались)
    const labelEvery = data.length <= 7 ? 1 : data.length <= 14 ? 2 : data.length <= 30 ? 5 : Math.ceil(data.length / 8);

    const bars = data.map((d, i) => {
        const cx = x(i);
        const usersH = (d.users / niceMax) * innerH;
        const roomsH = (d.rooms / niceMax) * innerH;
        const showLabel = i % labelEvery === 0 || i === data.length - 1;
        const dayShort = d.day.slice(5); // MM-DD
        return `<g>
            <title>${d.day} · users: ${d.users} · rooms: ${d.rooms}</title>
            <rect x="${cx - barW - 0.5}" y="${padT + innerH - usersH}" width="${barW}" height="${usersH}" fill="var(--accent)" opacity="0.85"/>
            <rect x="${cx + 0.5}" y="${padT + innerH - roomsH}" width="${barW}" height="${roomsH}" fill="var(--warn)" opacity="0.7"/>
            ${showLabel ? `<text x="${cx}" y="${H - 8}" text-anchor="middle" font-size="9" fill="var(--fg-3)" font-family="ui-monospace,monospace" letter-spacing=".05em">${dayShort}</text>` : ""}
        </g>`;
    }).join("");

    return `<svg class="chart-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" xmlns="http://www.w3.org/2000/svg">
        ${yLines}
        ${bars}
    </svg>`;
}

/* ========= STATIC FILES ========= */

app.use(express.static("public"));

const server = http.createServer(app);

server.listen(PORT, "0.0.0.0", () => {
    log.info("boot", "server running", { port: PORT });
});

/* ========= LIMITS / VALIDATION ========= */

/** Max simultaneous participants per room (enforced at join intent + at confirm for races). */
const MAX_ROOM_USERS = 5;

/** WS payload cap. Сигналинг укладывается в десятки КБ; всё крупнее — abuse. */
const MAX_PAYLOAD_BYTES = 64 * 1024;

/** Сколько одновременных WS-соединений с одного IP. Для NAT-офиса 20 — с запасом. */
const MAX_CONNECTIONS_PER_IP = 20;

/** Token bucket на сокет: при пиках offer/answer/ICE спокойно укладываемся, brute — нет. */
const MSG_BUCKET_CAPACITY = 60;
const MSG_BUCKET_REFILL_PER_SEC = 30;

/**
 * Защита от перебора кодов комнат. Считаем неудачные join (room-not-found / invalid-code)
 * на IP в скользящем окне; превышение → временный блок. Легитимный пользователь сюда
 * не попадает: даже с опечатками 15 невалидных кодов в минуту нереально.
 */
const FAILED_JOIN_LIMIT = 15;
const FAILED_JOIN_WINDOW_MS = 60 * 1000;
const FAILED_JOIN_BLOCK_MS = 5 * 60 * 1000;

/** Пустая комната, созданная без последующего join-confirm, удаляется через этот таймаут. */
const EMPTY_ROOM_TTL_MS = 60 * 1000;

const ROOM_CODE_REGEX = /^[A-Z0-9]{4,8}$/;
const USER_ID_REGEX = /^[A-Za-z0-9_-]{1,64}$/;
const NICKNAME_MAX_LEN = 32;

/** Управляющие символы (C0 + C1) — стрипаем из ника, чтобы не уехала вёрстка/логи. */
const CONTROL_CHARS_RX = new RegExp("[\\u0000-\\u001f\\u007f-\\u009f]", "g");

const ALLOWED_ORIGINS = [
    "https://void-room.space",
    "https://www.void-room.space",
];

function isOriginAllowed(origin) {
    if (typeof origin !== "string" || origin.length === 0) return false;
    if (ALLOWED_ORIGINS.includes(origin)) return true;
    // dev-loopback на любом порту
    return /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(origin);
}

function getClientIp(req) {
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

function isValidCode(code) {
    return typeof code === "string" && ROOM_CODE_REGEX.test(code);
}

function isValidUserId(id) {
    return typeof id === "string" && USER_ID_REGEX.test(id);
}

function sanitizeNickname(raw) {
    if (typeof raw !== "string") return "";
    return raw
        .replace(CONTROL_CHARS_RX, "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, NICKNAME_MAX_LEN);
}

/* ========= IP TRACKING ========= */

/** ip -> count активных WS */
const ipConnections = new Map();
/** ip -> { count, windowStart, blockedUntil } */
const ipFailedJoins = new Map();

function noteFailedJoin(ip) {
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

function isIpBlocked(ip) {
    if (!ip) return false;
    const entry = ipFailedJoins.get(ip);
    return !!(entry && entry.blockedUntil > Date.now());
}

function clearFailedJoins(ip) {
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

/* ========= WEBSOCKET ========= */

const wss = new WebSocketServer({
    server,
    maxPayload: MAX_PAYLOAD_BYTES,
    perMessageDeflate: false,
    verifyClient: ({ req }, cb) => {
        const origin = req.headers.origin;
        if (!isOriginAllowed(origin)) {
            log.warn("security", "origin rejected", { origin, ip: getClientIp(req) });
            cb(false, 403, "Forbidden origin");
            return;
        }
        const ip = getClientIp(req);
        const count = ipConnections.get(ip) || 0;
        if (count >= MAX_CONNECTIONS_PER_IP) {
            log.warn("security", "ip connection cap hit", { ip, cap: MAX_CONNECTIONS_PER_IP });
            cb(false, 429, "Too many connections");
            return;
        }
        cb(true);
    },
});

/*
Структура rooms:

Map {
  roomCode => {
    users: Map {
      userId => { ws, nickname, mic, sound, screen }
    },
    cleanupTimer: setTimeout id | null
  }
}
*/

const rooms = new Map();

function consumeToken(ws) {
    const b = ws._bucket;
    if (!b) return true;
    const now = Date.now();
    const elapsed = (now - b.lastRefill) / 1000;
    if (elapsed > 0) {
        b.tokens = Math.min(
            MSG_BUCKET_CAPACITY,
            b.tokens + elapsed * MSG_BUCKET_REFILL_PER_SEC
        );
        b.lastRefill = now;
    }
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
}

/**
 * Heartbeat. Без него мёртвый TCP-коннект (закрытая вкладка без FIN, спящий ноут,
 * сетевой обрыв) висит у нас в `room.users` десятки секунд, ломая reconnect
 * клиента: тот пытается войти со своим userId, мы видим "live" старый ws,
 * отдаём id-collision, юзер не может вернуться.
 *
 * Поэтому раз в HEARTBEAT_INTERVAL_MS шлём ping всем подключённым. На каждый
 * ping без pong увеличиваем `_missedPongs`. Когда счётчик >= MAX_MISSED — режем.
 * 30s × 2 = клиент имеет до 60 секунд тишины, прежде чем сервер посчитает
 * его мёртвым. Этого достаточно, чтобы пережить короткие фризы вкладки
 * (Chrome троттлит фоновые tabs, DevTools breakpoint, мобильный сон), но
 * по-настоящему мёртвые сокеты всё равно чистятся.
 */
const HEARTBEAT_INTERVAL_MS = 30 * 1000;
const HEARTBEAT_MAX_MISSED = 2;

const heartbeatTimer = setInterval(() => {
    wss.clients.forEach((ws) => {
        if ((ws._missedPongs || 0) >= HEARTBEAT_MAX_MISSED) {
            ws.terminate();
            return;
        }
        ws._missedPongs = (ws._missedPongs || 0) + 1;
        try { ws.ping(); } catch (_) {}
    });
}, HEARTBEAT_INTERVAL_MS);
heartbeatTimer.unref?.();

wss.on("close", () => clearInterval(heartbeatTimer));

wss.on("connection", (ws, req) => {
    const ip = getClientIp(req);
    ws._ip = ip;
    ws._missedPongs = 0;
    ws._bucket = { tokens: MSG_BUCKET_CAPACITY, lastRefill: Date.now() };
    ipConnections.set(ip, (ipConnections.get(ip) || 0) + 1);

    log.debug("ws", "client connected", { ip });

    ws.on("pong", () => { ws._missedPongs = 0; });

    ws.on("error", (err) => {
        log.warn("ws", "error", { ip, err: err.message });
    });

    ws.on("message", (rawMessage) => {
        // Token bucket: при превышении молча дропаем; легитимный клиент даже близко
        // не подходит к лимиту.
        if (!consumeToken(ws)) return;

        try {
            const data = JSON.parse(rawMessage.toString());

            switch (data.type) {

                case "hello":
                    handleHello(ws);
                    break;

                case "create-room":
                    handleCreateRoom(ws, data);
                    break;

                case "join-room":
                    handleJoinRoom(ws, data);
                    break;

                case "join-room-confirm":
                    handleJoinConfirm(ws, data);
                    break;

                case "leave-room":
                    handleLeaveRoom(ws);
                    break;

                case "audio-state":
                    handleAudioState(ws, data);
                    break;

                case "screencast-state":
                    handleScreencastState(ws, data);
                    break;

                case "offer":
                case "answer":
                case "ice":
                    handleSignal(ws, data);
                    break;

                default:
                    log.warn("ws", "unknown message type", { type: data.type, ip });
            }

        } catch (err) {
            log.warn("ws", "invalid message", { ip, err: err.message });
        }
    });

    ws.on("close", (code, reasonBuf) => {
        const cur = ipConnections.get(ip) || 0;
        if (cur <= 1) ipConnections.delete(ip);
        else ipConnections.set(ip, cur - 1);
        // 1000 = normal, 1001 = going away (refresh/tab close), 1005 = no status
        // received (тоже типичное закрытие из браузера). Всё остальное —
        // подозрительно, логируем чтобы не теряться при будущих регрессиях.
        // 1006 = abnormal close — heartbeat прибил мёртвый сокет, бывает.
        if (code !== 1000 && code !== 1001 && code !== 1005) {
            const reason = reasonBuf?.toString?.() || "";
            log.warn("ws", "abnormal close", { ip, code, reason });
        }
        handleDisconnect(ws);
    });
});

/* ========= ROOM LOGIC ========= */

/**
 * Клиент шлёт hello один раз — сразу после открытия вкладки (когда сгенерил
 * себе clientId/nickname). На сервере это считается "регистрацией". На один
 * сокет принимаем максимум один hello, повторы игнорируем (защита от
 * случайного двойного отправления; reconnect клиент тоже не должен слать
 * повторно).
 */
function handleHello(ws) {
    if (ws._registered) return;
    ws._registered = true;
    stats.usersRegistered += 1;
    bumpDaily("usersRegistered");
    scheduleStatsWrite();
}

function handleCreateRoom(ws, data) {

    const { code } = data;

    if (!isValidCode(code)) {
        ws.send(JSON.stringify({
            type: "room-created",
            success: false,
            reason: "invalid-code"
        }));
        return;
    }

    if (rooms.has(code)) {
        ws.send(JSON.stringify({
            type: "room-created",
            success: false,
            reason: "code-taken"
        }));
        return;
    }

    /** Если в течение TTL не пришёл join-room-confirm — комнату удаляем,
        чтобы её нельзя было заюзать как memory-DoS вектор. */
    const cleanupTimer = setTimeout(() => {
        const r = rooms.get(code);
        if (r && r.users.size === 0) {
            rooms.delete(code);
            log.info("room", "expired empty", { code });
        }
    }, EMPTY_ROOM_TTL_MS);
    cleanupTimer.unref?.();

    rooms.set(code, {
        users: new Map(),
        cleanupTimer
    });

    stats.roomsCreated += 1;
    bumpDaily("roomsCreated");
    updatePeaks();
    scheduleStatsWrite();

    /** Разрешает ровно один последующий join-room-confirm на этот код с этого сокета. */
    ws.authorizedJoinCode = code;

    ws.send(JSON.stringify({
        type: "room-created",
        success: true,
        code
    }));

    log.info("room", "created", { code, ip: ws._ip });
}

function handleJoinRoom(ws, data) {

    const { code } = data;

    if (isIpBlocked(ws._ip)) {
        ws.send(JSON.stringify({
            type: "join-failed",
            reason: "rate-limited"
        }));
        return;
    }

    if (!isValidCode(code)) {
        noteFailedJoin(ws._ip);
        ws.send(JSON.stringify({
            type: "join-failed",
            reason: "invalid-code"
        }));
        return;
    }

    if (!rooms.has(code)) {
        noteFailedJoin(ws._ip);
        ws.send(JSON.stringify({
            type: "join-failed",
            reason: "room-not-found"
        }));
        return;
    }

    const room = rooms.get(code);
    if (room.users.size >= MAX_ROOM_USERS) {
        ws.send(JSON.stringify({
            type: "join-failed",
            reason: "room-full"
        }));
        return;
    }

    ws.authorizedJoinCode = code;

    ws.send(JSON.stringify({
        type: "join-success",
        code
    }));
}

function handleJoinConfirm(ws, data) {

    const { code, userId } = data;

    if (ws.authorizedJoinCode !== code) {
        ws.send(JSON.stringify({
            type: "join-failed",
            reason: "join-session-invalid"
        }));
        return;
    }

    ws.authorizedJoinCode = undefined;

    if (!isValidCode(code)) {
        ws.send(JSON.stringify({
            type: "join-failed",
            reason: "invalid-code"
        }));
        return;
    }

    if (!isValidUserId(userId)) {
        ws.send(JSON.stringify({
            type: "join-failed",
            reason: "invalid-user-id"
        }));
        return;
    }

    const cleanNick = sanitizeNickname(data.nickname);
    if (!cleanNick) {
        ws.send(JSON.stringify({
            type: "join-failed",
            reason: "invalid-nickname"
        }));
        return;
    }

    const room = rooms.get(code);

    if (!room) {
        ws.send(JSON.stringify({
            type: "join-failed",
            reason: "room-not-found"
        }));
        return;
    }

    // Комната получает первого подтверждённого юзера — TTL больше не нужен.
    if (room.cleanupTimer) {
        clearTimeout(room.cleanupTimer);
        room.cleanupTimer = null;
    }

    /**
     * Защита от hijack'а: если userId уже занят в комнате другим живым сокетом —
     * отказ. Если та же запись принадлежит мёртвому/закрытому сокету (race на
     * reconnect, ещё не отработал handleDisconnect) — спокойно перезаписываем.
     */
    const existing = room.users.get(userId);
    if (existing && existing.ws !== ws && existing.ws.readyState === 1) {
        ws.send(JSON.stringify({
            type: "join-failed",
            reason: "id-collision"
        }));
        return;
    }

    if (!existing && room.users.size >= MAX_ROOM_USERS) {
        ws.send(JSON.stringify({
            type: "join-failed",
            reason: "room-full"
        }));
        return;
    }

    ws.roomCode = code;
    ws.userId = userId;

    room.users.set(userId, {
        ws,
        nickname: cleanNick,
        mic: true,
        sound: true,
        screen: false
    });

    if (room.users.size > MAX_ROOM_USERS) {
        room.users.delete(userId);
        ws.roomCode = undefined;
        ws.userId = undefined;
        ws.send(JSON.stringify({
            type: "join-failed",
            reason: "room-full"
        }));
        return;
    }

    // Успешный вход — IP больше не подозрителен.
    clearFailedJoins(ws._ip);

    const usersList = [];

    room.users.forEach((user, id) => {
        if (id !== userId) {
            usersList.push({
                id,
                nickname: user.nickname,
                mic: user.mic,
                sound: user.sound,
                screen: user.screen
            });
        }
    });

    ws.send(JSON.stringify({
        type: "user-list",
        users: usersList
    }));

    // Сообщаем остальным, что появился новый
    room.users.forEach((user, id) => {
        if (id !== userId && user.ws.readyState === 1) {
            user.ws.send(JSON.stringify({
                type: "new-participant",
                userId,
                nickname: cleanNick,
                screen: false
            }));
        }
    });

    // _joinedAt используется при дисконнекте/leave для подсчёта длительности
    // присутствия. Регистрация (lifetime "users") считается отдельно — по
    // hello-сообщению при загрузке вкладки, не по входам в комнаты.
    ws._joinedAt = Date.now();
    updatePeaks();
    scheduleStatsWrite();

    log.info("room", "joined", { code, userId, nick: cleanNick });
}

function handleScreencastState(ws, data) {
    const room = rooms.get(ws.roomCode);
    if (!room) return;

    const user = room.users.get(ws.userId);
    if (!user || user.ws !== ws) return;

    // Enforce single sharer: reject if another user is already sharing
    if (data.screen) {
        for (const [id, u] of room.users) {
            if (id !== ws.userId && u.screen) {
                ws.send(JSON.stringify({ type: "screencast-rejected" }));
                return;
            }
        }
    }

    user.screen = !!data.screen;

    room.users.forEach((u, id) => {
        if (id !== ws.userId && u.ws.readyState === 1) {
            u.ws.send(JSON.stringify({
                type: "screencast-state",
                userId: ws.userId,
                screen: user.screen
            }));
        }
    });
}

function handleAudioState(ws, data) {

    const room = rooms.get(ws.roomCode);
    if (!room) return;

    const user = room.users.get(ws.userId);
    if (!user || user.ws !== ws) return;

    user.mic = !!data.mic;
    user.sound = !!data.sound;

    room.users.forEach((u, id) => {
        if (id !== ws.userId && u.ws.readyState === 1) {
            u.ws.send(JSON.stringify({
                type: "audio-state",
                userId: ws.userId,
                mic: user.mic,
                sound: user.sound
            }));
        }
    });
}

function handleLeaveRoom(ws) {

    const code = ws.roomCode;
    if (!code) return;

    const userId = ws.userId;
    const roomData = rooms.get(code);
    if (!roomData) return;

    const existing = roomData.users.get(userId);
    if (!existing || existing.ws !== ws) return;

    roomData.users.delete(userId);
    ws.roomCode = undefined;
    ws.userId = undefined;
    captureSessionDuration(ws);

    roomData.users.forEach((user) => {
        if (user.ws.readyState === 1) {
            user.ws.send(JSON.stringify({
                type: "participant-left",
                userId
            }));
        }
    });

    if (roomData.users.size === 0) {
        if (roomData.cleanupTimer) {
            clearTimeout(roomData.cleanupTimer);
            roomData.cleanupTimer = null;
        }
        rooms.delete(code);
        log.info("room", "deleted", { code });
    }
}

function handleDisconnect(ws) {

    if (!ws.roomCode) return;

    const room = rooms.get(ws.roomCode);
    if (!room) return;

    const userId = ws.userId;
    const existing = room.users.get(userId);

    if (existing && existing.ws === ws) {
        room.users.delete(userId);
        captureSessionDuration(ws);

        room.users.forEach((user) => {
            if (user.ws.readyState === 1) {
                user.ws.send(JSON.stringify({
                    type: "participant-left",
                    userId
                }));
            }
        });
    }

    if (room.users.size === 0) {
        if (room.cleanupTimer) {
            clearTimeout(room.cleanupTimer);
            room.cleanupTimer = null;
        }
        rooms.delete(ws.roomCode);
    }

    log.debug("ws", "client disconnected", { ip: ws._ip });
}

function handleSignal(ws, data) {

    if (!ws.roomCode || !ws.userId) return;

    const room = rooms.get(ws.roomCode);
    if (!room) return;

    if (typeof data.to !== "string") return;

    const targetUser = room.users.get(data.to);
    if (!targetUser || targetUser.ws.readyState !== 1) return;

    /**
     * Whitelist полей. Раньше тут был spread `...data` после `from: ws.userId`,
     * из-за чего payload-овский `from` ПЕРЕТИРАЛ серверный — атакующий мог
     * подделать источник signaling (S-C3). Теперь явно перечисляем ровно те
     * поля, которые ожидает клиент (`public/webrtc.js`):
     *  - offer:  { offer, rebuild? }
     *  - answer: { answer }
     *  - ice:    { candidate }
     */
    const out = {
        type: data.type,
        from: ws.userId,
        to: data.to
    };

    if (data.type === "offer") {
        if (data.offer !== undefined) out.offer = data.offer;
        if (data.rebuild === true) out.rebuild = true;
    } else if (data.type === "answer") {
        if (data.answer !== undefined) out.answer = data.answer;
    } else if (data.type === "ice") {
        if (data.candidate !== undefined) out.candidate = data.candidate;
    }

    targetUser.ws.send(JSON.stringify(out));
}
