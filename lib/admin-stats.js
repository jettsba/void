/* ========= ADMIN STATS ENDPOINT =========
 * /adminstats — HTML-дашборд с live/daily/lifetime метриками и SVG-графиком
 * за период (7/14/30/90/all дней). Auth — Basic, пароль из env
 * ADMIN_STATS_PASSWORD (если не задан — endpoint вообще не работает).
 *
 * mountAdminStats(app, wss) — вешает route на express-приложение. wss нужен
 * чтобы посчитать live-active-users (== wss.clients.size).
 */

import { rooms, stats } from "./state.js";
import { dayKey, DAY_KEY_RX } from "./stats.js";

const ADMIN_STATS_PASSWORD = process.env.ADMIN_STATS_PASSWORD || "";
const VALID_PERIODS = new Set(["7", "14", "30", "90", "all"]);

export function mountAdminStats(app, wss) {
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
        res.type("text/html; charset=utf-8").send(renderStatsHtml(req.query, wss));
    });
}

function renderStatsHtml(query = {}, wss) {
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
