/* ========= ADMIN STATS ENDPOINT =========
 * /adminstats — HTML-дашборд с live/daily/lifetime метриками и SVG-графиком
 * за период (7/14/30/90/all дней). Auth — Basic, пароль из env
 * ADMIN_STATS_PASSWORD (если не задан — endpoint вообще не работает).
 *
 * mountAdminStats(app) — вешает route на express-приложение. Live-метрики
 * считаются из `rooms` (см. lib/state.js).
 */

import crypto from "node:crypto";
import { log } from "./log.js";
import { rooms, stats } from "./state.js";
import { dayKey, DAY_KEY_RX } from "./stats.js";
import { getClientIp } from "./security.js";

const ADMIN_STATS_PASSWORD = process.env.ADMIN_STATS_PASSWORD || "";
const VALID_PERIODS = new Set(["7", "14", "30", "90", "all"]);

/**
 * Сравнивает строки за константное время — атакующий не может узнать длину
 * пароля или его префикс по разнице RTT. На разных длинах compare всё равно
 * запускается на буфере одинаковой длины, чтобы и здесь не утекало время.
 */
function safeEqualString(a, b) {
    if (typeof a !== "string" || typeof b !== "string") return false;
    const ab = Buffer.from(a, "utf8");
    const bb = Buffer.from(b, "utf8");
    if (ab.length !== bb.length) {
        // Холостой compare на буфере той же длины, чтобы early-return не палил
        // несоответствие длин.
        crypto.timingSafeEqual(ab, ab);
        return false;
    }
    return crypto.timingSafeEqual(ab, bb);
}

/**
 * Anti-brute-force для единственного пароля /adminstats.
 *
 * IP-fence НЕ используем (у владельца динамический IP + VPN — allowlist его же
 * и заблокировал бы). Лок — ГЛОБАЛЬНЫЙ на эндпоинт, не per-IP: секрет один,
 * легитимный пользователь один. Глобальный счётчик ловит и распределённый
 * перебор с ротацией IP — per-IP лок такой обошёл бы. Цена компромисса: во
 * время активной атаки владелец тоже подождёт, но не дольше LOCK_MAX_MS.
 *
 * Первые FAIL_THRESHOLD промахов — без задержки (право на опечатку). Дальше
 * блокировка с экспоненциальным ростом 30s→1m→2m→…→30m(потолок). Счётчик
 * сбрасывается ТОЛЬКО при успешном входе — медленный «trickle»-перебор всё
 * равно накопится и упрётся в лок. Состояние in-memory: рестарт = сброс, но
 * дыры это не даёт (перебор пароля длиннее, чем uptime между деплоями).
 */
const FAIL_THRESHOLD = 5;
const LOCK_BASE_MS = 30 * 1000;
const LOCK_MAX_MS = 30 * 60 * 1000;
let _adminFailCount = 0;
let _adminLockedUntil = 0;

function adminLockRemainingMs() {
    return Math.max(0, _adminLockedUntil - Date.now());
}

function noteAdminFail() {
    _adminFailCount += 1;
    if (_adminFailCount >= FAIL_THRESHOLD) {
        const over = _adminFailCount - FAIL_THRESHOLD; // 0,1,2,…
        const delay = Math.min(LOCK_BASE_MS * 2 ** over, LOCK_MAX_MS);
        _adminLockedUntil = Date.now() + delay;
    }
}

function noteAdminSuccess() {
    _adminFailCount = 0;
    _adminLockedUntil = 0;
}

export function mountAdminStats(app) {
    app.get("/adminstats", (req, res) => {
        if (!ADMIN_STATS_PASSWORD) {
            res.status(503).type("text/plain")
                .send("admin stats disabled — set ADMIN_STATS_PASSWORD env var");
            return;
        }

        /* Глобальный лок активен → отказываем НЕ проверяя пароль (иначе
           блокировка не ограничивала бы скорость перебора). 429 + Retry-After. */
        const lockMs = adminLockRemainingMs();
        if (lockMs > 0) {
            log.warn("security", "adminstats locked (brute-force backoff)", {
                ip: getClientIp(req),
                retryAfterSec: Math.ceil(lockMs / 1000)
            });
            res.set("Retry-After", String(Math.ceil(lockMs / 1000)));
            res.status(429).type("text/plain").send("too many attempts, try later");
            return;
        }

        const auth = req.headers.authorization || "";
        if (!auth.startsWith("Basic ")) {
            /* Браузер сперва шлёт запрос БЕЗ credentials, чтобы получить
               challenge — это не неудачная попытка, счётчик не трогаем. */
            res.set("WWW-Authenticate", 'Basic realm="void admin"');
            res.status(401).type("text/plain").send("auth required");
            return;
        }

        let pass = "";
        try {
            const decoded = Buffer.from(auth.slice(6), "base64").toString("utf8");
            const idx = decoded.indexOf(":");
            pass = idx >= 0 ? decoded.slice(idx + 1) : "";
        } catch (_) {}

        if (!safeEqualString(pass, ADMIN_STATS_PASSWORD)) {
            noteAdminFail();
            /* Логируем все провалы — без этого никто не заметит перебор.
               Слои: timing-safe сравнение + эскалирующий глобальный лок + лог. */
            log.warn("security", "adminstats auth failed", {
                ip: getClientIp(req),
                ua: req.headers["user-agent"] || "",
                fails: _adminFailCount
            });
            res.set("WWW-Authenticate", 'Basic realm="void admin"');
            res.status(401).type("text/plain").send("auth required");
            return;
        }

        noteAdminSuccess();
        res.set("Cache-Control", "no-store");
        res.type("text/html; charset=utf-8").send(renderStatsHtml(req.query));
    });
}

function renderStatsHtml(query = {}) {
    /* ---- разбираем query ---- */
    const today = dayKey(Date.now());
    const day = (typeof query.day === "string" && DAY_KEY_RX.test(query.day)) ? query.day : today;
    const period = VALID_PERIODS.has(query.period) ? query.period : "7";

    /* ---- live-снапшот ---- */
    // active users = люди, реально сидящие в комнатах (`room.users`). Раньше
    // считали `wss.clients.size` — он включает лобби-вкладки, дубль-вкладки
    // одного клиента и зомби-сокеты в окно реконнекта (старый ws ещё в
    // `clients`, пока heartbeat не убил, новый уже там). Из-за этого админка
    // показывала больше пользователей, чем фактически было в звонках. Теперь
    // метрика отражает именно «голосовая активность сейчас».
    let liveUsers = 0;
    const now = Date.now();
    let activeSeconds = 0;
    for (const r of rooms.values()) {
        liveUsers += r.users.size;
        for (const u of r.users.values()) {
            if (u.ws._joinedAt) activeSeconds += (now - u.ws._joinedAt) / 1000;
        }
    }
    const liveRooms = rooms.size;

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
            rooms: b ? b.roomsCreated : 0,
            presence: b ? b.participantSeconds : 0
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
    const connHtml = renderConnectivity(stats);

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
    --bad:#e8746e;
    /* Presence (минуты в комнатах) — отдельная третья метрика на графике.
       Шкала отличается от users/rooms (секунды vs штуки), поэтому рисуем
       как area-fill с собственной нормировкой под слоем баров. */
    --presence:#a698d8;
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

/* ── CONNECTIVITY ──
   Живёт под колонкой "// live" — у неё всего 3 readout'а против 5 у daily/
   lifetime, поэтому снизу пустое место. Виджет его заполняет: высота страницы
   не растёт, скролл не появляется. */
.conn-head{margin-top:18px}
.conn{
    display:flex;flex-direction:column;gap:9px;
    background:var(--bg-1);border:1px solid var(--line);
    padding:12px 14px;
}
.conn-empty{
    background:var(--bg-1);border:1px solid var(--line);
    color:var(--fg-3);font-size:9px;letter-spacing:.16em;text-transform:uppercase;
    text-align:center;padding:18px 14px;
}
.conn-bar{
    display:flex;height:7px;width:100%;
    background:var(--bg-2);border:1px solid var(--line);overflow:hidden;
}
.conn-bar .seg{height:100%}
.seg-direct{background:var(--accent)}
.seg-relay{background:var(--presence)}
.seg-failed{background:var(--bad)}
.conn-rows{display:flex;flex-direction:column;gap:4px}
.conn-row{
    display:flex;align-items:baseline;justify-content:space-between;gap:10px;
    font-size:9px;
}
.conn-k{
    display:flex;align-items:center;gap:6px;
    text-transform:uppercase;letter-spacing:.16em;color:var(--fg-3);
}
.conn-dot{width:7px;height:7px;border-radius:50%;display:inline-block;flex-shrink:0}
.conn-v{color:var(--fg);font-variant-numeric:tabular-nums;letter-spacing:.04em;white-space:nowrap}
.conn-verdict{
    margin-top:1px;padding-top:8px;border-top:1px solid var(--line);
    font-size:9px;letter-spacing:.14em;text-transform:uppercase;text-align:center;
}
.conn-verdict.v-good{color:var(--accent)}
.conn-verdict.v-warn{color:var(--warn)}
.conn-verdict.v-bad{color:var(--bad)}

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

        <!-- ── CONNECTIVITY (P2P-воронка → нужен ли TURN) ── -->
        <div class="sec-head conn-head">
            <span class="label">// connectivity</span>
        </div>
        ${connHtml}
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
                &nbsp;&nbsp;
                <span class="legend-dot" style="background:var(--presence)"></span>presence
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
 * Виджет P2P-связности: горизонтальный stacked-bar direct/relay/failed +
 * разбивка по числам и процентам + вердикт «нужен ли TURN».
 *
 * Считаем по lifetime-счётчикам (`stats.iceDirect/iceRelay/iceFailed`) — для
 * решения про TURN важна вся накопленная картина, а не один день. Вердикт —
 * по доле failed: это те звонки, что вообще не собрались, и где помог бы релей.
 */
function renderConnectivity(s) {
    const direct = s.iceDirect || 0;
    const relay = s.iceRelay || 0;
    const failed = s.iceFailed || 0;
    const total = direct + relay + failed;

    if (total === 0) {
        return `<div class="conn-empty">no samples yet</div>`;
    }

    const pct = n => Math.round((n / total) * 100);
    const dPct = pct(direct), rPct = pct(relay), fPct = pct(failed);
    const failedRatio = failed / total;

    let verdict, vClass;
    if (failedRatio < 0.02) {
        verdict = "p2p holds — turn not needed";
        vClass = "v-good";
    } else if (failedRatio <= 0.08) {
        verdict = "borderline — keep watching";
        vClass = "v-warn";
    } else {
        verdict = "turn recommended";
        vClass = "v-bad";
    }

    const fmtCount = n => Number(n).toLocaleString("en-US");
    const row = (cls, label, n, p) =>
        `<div class="conn-row">
            <span class="conn-k"><i class="conn-dot ${cls}"></i>${label}</span>
            <span class="conn-v">${fmtCount(n)} · ${p}%</span>
        </div>`;

    return `<div class="conn">
        <div class="conn-bar">
            <span class="seg seg-direct" style="width:${dPct}%"></span>
            <span class="seg seg-relay" style="width:${rPct}%"></span>
            <span class="seg seg-failed" style="width:${fPct}%"></span>
        </div>
        <div class="conn-rows">
            ${row("seg-direct", "direct", direct, dPct)}
            ${row("seg-relay", "relay", relay, rPct)}
            ${row("seg-failed", "failed", failed, fPct)}
        </div>
        <div class="conn-verdict ${vClass}">${verdict}</div>
    </div>`;
}

/**
 * SVG-график: для каждого дня два тонких столбца — users (cyan) и rooms (amber).
 * Под баром тянется area-fill presence (минуты в комнатах) — третья метрика с
 * собственной нормировкой, потому что секунды ≫ count и иначе бы дисторсила
 * шкалу. При наведении на день браузер показывает нативный tooltip из <title>.
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

    // niceMax для bar-шкалы (users/rooms): округлённый верх для сетки.
    function pickNiceMax(v) {
        const safe = Math.max(1, v);
        const exp = Math.pow(10, Math.floor(Math.log10(safe)));
        for (const m of [1, 2, 5, 10]) {
            if (m * exp >= safe) return m * exp;
        }
        return safe;
    }
    const niceMax = pickNiceMax(maxVal);

    // presence нормируем под СВОЙ максимум — иначе area прижмётся к нулю
    // (presence в секундах, users/rooms в штуках). Шкалу presence не подписываем
    // на оси Y, метрика читается через tooltip и legend.
    const presenceMax = Math.max(1, ...data.map(d => d.presence));

    function y(v) { return padT + innerH - (v / niceMax) * innerH; }
    function yPresence(v) { return padT + innerH - (v / presenceMax) * innerH; }
    function x(i) { return padL + xStep * i + xStep / 2; }

    // ось Y — три отметки (для users/rooms)
    const yTicks = [0, niceMax / 2, niceMax];
    const yLines = yTicks.map(t => {
        const yy = y(t);
        return `<line x1="${padL}" y1="${yy}" x2="${W - padR}" y2="${yy}" stroke="var(--line)" stroke-dasharray="${t === 0 ? '' : '2,4'}"/>
                <text x="${padL - 6}" y="${yy + 3}" text-anchor="end" font-size="9" fill="var(--fg-3)" font-family="ui-monospace,monospace">${Math.round(t)}</text>`;
    }).join("");

    // решаем сколько меток на оси X показать (чтобы не слипались)
    const labelEvery = data.length <= 7 ? 1 : data.length <= 14 ? 2 : data.length <= 30 ? 5 : Math.ceil(data.length / 8);

    /* presence как area-chart под баром. Замыкаем полилинию вниз к baseline,
       чтобы получилась заливка. Точки нанизаны на cx каждого дня; на краях
       графика «прижимаем» к ближайшему x, чтобы фигура была без пустот по
       бокам. */
    const presencePts = data.map((d, i) => `${x(i)},${yPresence(d.presence)}`).join(" ");
    const presenceArea =
        `M ${x(0)},${padT + innerH} ` +                              // start at baseline
        `L ${presencePts.split(" ").join(" L ")} ` +                  // dataset
        `L ${x(data.length - 1)},${padT + innerH} Z`;                 // close down

    function fmtDurationShort(seconds) {
        const total = Math.floor(seconds);
        const h = Math.floor(total / 3600);
        const m = Math.floor((total % 3600) / 60);
        if (h > 0) return `${h}h ${m}m`;
        return `${m}m`;
    }

    const bars = data.map((d, i) => {
        const cx = x(i);
        const usersH = (d.users / niceMax) * innerH;
        const roomsH = (d.rooms / niceMax) * innerH;
        const showLabel = i % labelEvery === 0 || i === data.length - 1;
        const dayShort = d.day.slice(5); // MM-DD
        return `<g>
            <title>${d.day} · users: ${d.users} · rooms: ${d.rooms} · presence: ${fmtDurationShort(d.presence)}</title>
            <rect x="${cx - barW - 0.5}" y="${padT + innerH - usersH}" width="${barW}" height="${usersH}" fill="var(--accent)" opacity="0.85"/>
            <rect x="${cx + 0.5}" y="${padT + innerH - roomsH}" width="${barW}" height="${roomsH}" fill="var(--warn)" opacity="0.7"/>
            ${showLabel ? `<text x="${cx}" y="${H - 8}" text-anchor="middle" font-size="9" fill="var(--fg-3)" font-family="ui-monospace,monospace" letter-spacing=".05em">${dayShort}</text>` : ""}
        </g>`;
    }).join("");

    return `<svg class="chart-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" xmlns="http://www.w3.org/2000/svg">
        ${yLines}
        <path d="${presenceArea}" fill="var(--presence)" opacity="0.16"/>
        <polyline points="${presencePts}" fill="none" stroke="var(--presence)" stroke-width="1.2" opacity="0.7" stroke-linejoin="round"/>
        ${bars}
    </svg>`;
}
