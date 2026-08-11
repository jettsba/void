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
import { dayKey, DAY_KEY_RX, flushStats } from "./stats.js";
import { getClientIp } from "./security.js";

const ADMIN_STATS_PASSWORD = process.env.ADMIN_STATS_PASSWORD || "";
const VALID_PERIODS = new Set(["7", "14", "30", "90", "all"]);

/* Геометрия графиков. Вынесена наружу, потому что графиков теперь два (активность
   и скачивания) и они должны быть выровнены по оси X день-в-день. */
const CHART_W = 880;
const CHART_PAD_L = 36;
const CHART_PAD_R = 12;

/**
 * HTML-escape. Обязателен для всего, что пришло от клиента (failure-лог: ua,
 * тексты ICE-ошибок, url'ы). До failure-лога в этот шаблон не попадало ни одной
 * недоверенной строки — теперь попадает, и без экранирования это XSS в собственной
 * админке (с Basic-auth сессией в браузере владельца).
 */
function esc(v) {
    return String(v)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

/** Округление верха шкалы до «красивого» числа — общее для обоих графиков. */
function pickNiceMax(v) {
    const safe = Math.max(1, v);
    const exp = Math.pow(10, Math.floor(Math.log10(safe)));
    for (const m of [1, 2, 5, 10]) {
        if (m * exp >= safe) return m * exp;
    }
    return safe;
}

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

/**
 * Общая проверка доступа для всех маршрутов админки: сам дашборд, выгрузка
 * failure-лога и его очистка. Возвращает true, если запрос авторизован; иначе
 * САМА отправляет ответ (503/429/401), и вызывающему остаётся только выйти.
 *
 * Каждый маршрут проверяется отдельно, а не через общий express-middleware на
 * префиксе: браузер не обязан слать Basic-креды на соседний путь, поэтому любой
 * из них должен уметь выдать собственный 401-challenge.
 */
function requireAdmin(req, res) {
    if (!ADMIN_STATS_PASSWORD) {
        res.status(503).type("text/plain")
            .send("admin stats disabled — set ADMIN_STATS_PASSWORD env var");
        return false;
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
        return false;
    }

    const auth = req.headers.authorization || "";
    if (!auth.startsWith("Basic ")) {
        /* Браузер сперва шлёт запрос БЕЗ credentials, чтобы получить
           challenge — это не неудачная попытка, счётчик не трогаем. */
        res.set("WWW-Authenticate", 'Basic realm="void admin"');
        res.status(401).type("text/plain").send("auth required");
        return false;
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
        return false;
    }

    noteAdminSuccess();
    return true;
}

/**
 * Токен для мутирующих действий админки (очистка лога).
 *
 * Зачем: браузер шлёт Basic-креды и на POST со СТОРОННЕГО сайта, поэтому одной
 * авторизации мало — чужая страница могла бы втихую стереть лог. Токен выводится
 * из пароля, попадает в форму на самой странице, и подделать его, не зная
 * пароля, нельзя. Значение стабильно между перезапусками — отдельное состояние
 * сессии для этого держать не нужно.
 */
function actionToken(action) {
    return crypto.createHmac("sha256", ADMIN_STATS_PASSWORD)
        .update(String(action))
        .digest("hex")
        .slice(0, 32);
}

export function mountAdminStats(app) {
    app.get("/adminstats", (req, res) => {
        if (!requireAdmin(req, res)) return;
        res.set("Cache-Control", "no-store");
        res.type("text/html; charset=utf-8").send(renderStatsHtml(req.query));
    });

    /**
     * Выгрузка failure-лога одним JSON-файлом: скачал → отправил → разбор без
     * угадывания формата. Кладём и воронку целиком, потому что без неё записи
     * не с чем соотнести («20 провалов» — это много или мало?).
     */
    app.get("/adminstats/fails.json", (req, res) => {
        if (!requireAdmin(req, res)) return;

        const list = stats.iceFailLog || [];
        const payload = {
            meta: {
                generatedAt: new Date().toISOString(),
                source: "void /adminstats",
                entries: list.length,
                /* Счётчики считают ОТЧЁТЫ: каждое соединение отчитывают обе
                   стороны, поэтому соединений примерно вдвое меньше. */
                funnel: {
                    direct: stats.iceDirect || 0,
                    relay: stats.iceRelay || 0,
                    failed: stats.iceFailed || 0,
                    dropped: stats.iceDropped || 0,
                    note: "counts are REPORTS; both peers report the same connection"
                },
                fields: {
                    ms: "peer lifetime before the failure was reported",
                    attempt: "which reconnect attempt failed (report is sent once per peer)",
                    effType: "navigator.connection.effectiveType — link speed class, NOT network type",
                    local: "locally gathered ICE candidates by type",
                    remote: "remote ICE candidates by type",
                    pairs: "candidate pairs by state"
                }
            },
            entries: list.slice().reverse().map(e => ({
                ...e,
                at: new Date(e.at).toISOString(),
                verdict: diagnoseFailure(e).text
            }))
        };

        const stamp = dayKey(Date.now());
        res.set("Cache-Control", "no-store");
        res.set("Content-Disposition", `attachment; filename="void-failconns-${stamp}.json"`);
        res.type("application/json; charset=utf-8").send(JSON.stringify(payload, null, 2));
    });

    /** Очистка лога. POST + токен — см. actionToken. */
    app.post("/adminstats/fails/clear", (req, res) => {
        if (!requireAdmin(req, res)) return;

        if (!safeEqualString(String(req.query.t || ""), actionToken("fails-clear"))) {
            log.warn("security", "adminstats clear rejected (bad token)", {
                ip: getClientIp(req)
            });
            res.status(403).type("text/plain").send("bad token");
            return;
        }

        const removed = (stats.iceFailLog || []).length;
        stats.iceFailLog = [];
        flushStats();
        log.info("stats", "failure log cleared", { removed });

        // 303 — чтобы обновление страницы не повторяло POST.
        res.redirect(303, "/adminstats?fails=1");
    });
}

function renderStatsHtml(query = {}) {
    /* ---- разбираем query ---- */
    const today = dayKey(Date.now());
    const day = (typeof query.day === "string" && DAY_KEY_RX.test(query.day)) ? query.day : today;
    const period = VALID_PERIODS.has(query.period) ? query.period : "7";
    // Панель с логами failed-соединений: состояние живёт в query (JS на странице нет).
    const failsOpen = query.fails === "1";

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
        roomsCreated: 0, roomsUsed: 0, roomsWithCall: 0,
        usersRegistered: 0, visitorsUnique: 0, visitorsNew: 0, visitorsReturning: 0,
        participantSeconds: 0, callSeconds: 0,
        peakConcurrentRooms: 0, peakConcurrentUsers: 0,
        installerDownloads: 0, portableDownloads: 0
    };

    let dayPresenceSeconds = dayBucket.participantSeconds;
    if (day === today) dayPresenceSeconds += activeSeconds;

    /* Идущие прямо сейчас разговоры ещё не записаны в callSeconds (интервал
       закрывается, когда в комнате остаётся <2 человек) — доливаем их, иначе
       за сегодня «talk time» выглядел бы нулевым во время активной беседы. */
    let liveCallSeconds = 0;
    for (const r of rooms.values()) {
        if (r._callStartedAt) liveCallSeconds += (now - r._callStartedAt) / 1000;
    }
    let dayCallSeconds = dayBucket.callSeconds || 0;
    if (day === today) dayCallSeconds += liveCallSeconds;

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
        const dlI = b ? (b.installerDownloads || 0) : 0;
        const dlP = b ? (b.portableDownloads || 0) : 0;
        return {
            day: d,
            users: b ? b.usersRegistered : 0,
            rooms: b ? b.roomsCreated : 0,
            presence: b ? b.participantSeconds : 0,
            dlI,
            dlP,
            dl: dlI + dlP
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
        /* Меньше минуты показываем в секундах. Раньше округляли до "0m", и это
           читалось как «время не считается» — короткую сессию было не отличить
           от полного нуля. */
        if (m > 0) return `${m}m`;
        return `${total}s`;
    }

    const chartHtml = renderChart(chartData);
    const dlChartHtml = renderDownloadsChart(chartData);
    const connHtml = renderConnectivity(stats);
    const failsHtml = failsOpen ? renderFailsPanel(stats, `?day=${day}&period=${period}`) : "";

    /* ---- desktop downloads (клик-счётчик зеркала /dl, см. lib/dl-beacon.js) ---- */
    const dlInstaller = stats.installerDownloads || 0;
    const dlPortable = stats.portableDownloads || 0;
    const dlValue = Number(dlInstaller + dlPortable).toLocaleString("en-US");
    const dlTitle = `installer ${dlInstaller} · portable ${dlPortable}`;

    const dayDlI = dayBucket.installerDownloads || 0;
    const dayDlP = dayBucket.portableDownloads || 0;
    const dayDlValue = fmtN(dayDlI + dayDlP);
    const dayDlTitle = `installer ${dayDlI} · portable ${dayDlP}`;

    /* Подсказки к тем цифрам, которые легко прочитать неправильно: «созданная
       комната» ≠ «состоявшийся разговор», «visitors» ≠ «opens». */
    const dayRoomsTitle =
        `used ${fmtN(dayBucket.roomsUsed || 0)} · with call ${fmtN(dayBucket.roomsWithCall || 0)}`;
    const dayVisitorsTitle =
        `unique per day · new ${fmtN(dayBucket.visitorsNew || 0)} · returning ${fmtN(dayBucket.visitorsReturning || 0)}`;
    const lifeRoomsTitle =
        `used ${fmtN(stats.roomsUsed || 0)} · with call ${fmtN(stats.roomsWithCall || 0)}`;
    const lifeVisitorsTitle =
        `people who tried void (sum of daily new) · returning visits ${fmtN(stats.visitorsReturning || 0)}`;

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
${failsOpen ? "<!-- auto-refresh off: панель логов открыта, перезагрузка мешала бы читать -->" : '<meta http-equiv="refresh" content="15">'}
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
    /* Desktop-скачивания — свой график, своя шкала (3-5/день против ~190 юзеров:
       на общей оси бар был бы в 1-2px). Зелёный проверен на CVD-разделимость
       с cyan/amber/purple и контраст к фону. */
    --dl:#7ed69f;
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
/* dropped — не часть воронки (в полосе его нет), поэтому только точка в списке.
   Приглушённый жёлтый: это не провал связи, а оборванный живой звонок. */
.seg-dropped{background:var(--warn)}
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

/* ── FAILED-CONNECTION LOG ──
   Оверлей поверх консоли. Состояние — в query (?fails=1), никакого JS: страница
   намеренно остаётся чистым HTML/CSS (и переживает meta-refresh без потери UI-стейта). */
.fails-overlay{
    position:fixed;inset:0;z-index:50;
    display:flex;align-items:center;justify-content:center;
    padding:24px;
}
.fails-backdrop{
    position:absolute;inset:0;
    background:rgba(4,4,8,0.82);
    backdrop-filter:blur(2px);
}
.fails-panel{
    position:relative;
    width:min(920px,100%);max-height:100%;
    display:flex;flex-direction:column;
    background:var(--bg-1);border:1px solid var(--line-2);
    box-shadow:0 24px 60px rgba(0,0,0,.6);
}
.fails-head{
    display:flex;align-items:center;justify-content:space-between;gap:12px;
    padding:12px 16px;border-bottom:1px solid var(--line);
    font-size:9px;letter-spacing:.22em;text-transform:uppercase;color:var(--fg-3);
    flex-shrink:0;
}
.fails-head .x{
    color:var(--fg-2);text-decoration:none;
    border:1px solid var(--line-2);padding:1px 7px;border-radius:2px;
}
.fails-head .x:hover{border-color:var(--accent-dim);color:var(--fg)}
.fails-actions{display:flex;align-items:center;gap:6px}
/* Форма — inline-обёртка вокруг кнопки: POST без единой строчки JS. */
.act-form{margin:0;display:inline-flex}
/* Ссылка и кнопка в одном ряду: без явных display/line-height они дают разную
   высоту (inline vs inline-block + дефолтные метрики кнопки). */
.act{
    display:inline-flex;align-items:center;
    color:var(--fg-2);text-decoration:none;
    border:1px solid var(--line-2);padding:1px 7px;border-radius:2px;
    background:none;cursor:pointer;
    font:inherit;font-size:9px;letter-spacing:.16em;text-transform:uppercase;
    line-height:1.45;
}
.act:hover{border-color:var(--accent-dim);color:var(--fg)}
.act-danger:hover{border-color:var(--bad);color:var(--bad)}
.fails-list{overflow-y:auto;padding:4px 16px 16px}
.fail{
    border-bottom:1px solid var(--line);
    padding:12px 0;
    display:flex;flex-direction:column;gap:5px;
}
.fail:last-child{border-bottom:0}
.fail-top{
    display:flex;flex-wrap:wrap;align-items:baseline;gap:10px;
    font-size:10px;color:var(--fg);font-variant-numeric:tabular-nums;
}
.fail-top .age{color:var(--warn)}
.fail-top .tag{
    font-size:8px;letter-spacing:.18em;text-transform:uppercase;color:var(--fg-3);
    border:1px solid var(--line-2);padding:0 5px;border-radius:2px;
}
.fail-ua{font-size:9px;color:var(--fg-3);word-break:break-all}
.fail-grid{
    display:grid;grid-template-columns:64px 1fr;gap:2px 10px;
    font-size:9px;
}
.fail-k{
    text-transform:uppercase;letter-spacing:.16em;color:var(--fg-3);
}
.fail-v{color:var(--fg-2);font-variant-numeric:tabular-nums}
.fail-v .zero{color:var(--bad)}
.fail-v .err{color:var(--warn)}
.fail-verdict{
    margin-top:3px;font-size:9px;letter-spacing:.12em;text-transform:uppercase;
}
.fail-verdict.v-warn{color:var(--warn)}
.fail-verdict.v-bad{color:var(--bad)}

/* ── CHART (full-width row) ── */
.chart-row{margin-top:6px}
.chart-frame + .chart-frame{margin-top:8px}
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
            <span class="controls">
                <a href="${failsOpen ? `?day=${day}&period=${period}` : `?day=${day}&period=${period}&fails=1`}"
                   class="${failsOpen ? "is-active" : ""}"
                   title="failed connection logs">${failsOpen ? "×" : "i"}</a>
            </span>
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
            <div class="readout" title="${dayRoomsTitle}">
                <div class="readout-label">rooms created</div>
                <div class="readout-value">${fmtN(dayBucket.roomsCreated)}</div>
            </div>
            <div class="readout is-live" title="${dayVisitorsTitle}">
                <div class="readout-label">visitors</div>
                <div class="readout-value">${fmtN(dayBucket.visitorsUnique || 0)}</div>
            </div>
            <div class="readout" title="app opens — F5 and second tab count again">
                <div class="readout-label">opens</div>
                <div class="readout-value">${fmtN(dayBucket.usersRegistered)}</div>
            </div>
            <div class="readout" title="total time rooms were held open, summed per person">
                <div class="readout-label">presence</div>
                <div class="readout-value">${fmtDuration(dayPresenceSeconds)}</div>
            </div>
            <div class="readout" title="wall-clock time rooms had 2+ people — actual conversation">
                <div class="readout-label">talk time</div>
                <div class="readout-value">${fmtDuration(dayCallSeconds)}</div>
            </div>
            <div class="readout is-peak">
                <div class="readout-label">peak rooms</div>
                <div class="readout-value">${dayBucket.peakConcurrentRooms}</div>
            </div>
            <div class="readout is-peak">
                <div class="readout-label">peak users</div>
                <div class="readout-value">${dayBucket.peakConcurrentUsers}</div>
            </div>
            <div class="readout" title="${dayDlTitle}">
                <div class="readout-label">desktop dl</div>
                <div class="readout-value">${dayDlValue}</div>
            </div>
        </div>
    </div>

    <!-- ── LIFETIME ── -->
    <div class="col">
        <div class="sec-head">
            <span class="label">// lifetime</span>
        </div>
        <div class="readouts">
            <div class="readout" title="${lifeRoomsTitle}">
                <div class="readout-label">rooms created</div>
                <div class="readout-value">${fmtN(stats.roomsCreated)}</div>
            </div>
            <div class="readout is-live" title="${lifeVisitorsTitle}">
                <div class="readout-label">people</div>
                <div class="readout-value">${fmtN(stats.visitorsNew || 0)}</div>
            </div>
            <div class="readout" title="app opens — F5 and second tab count again">
                <div class="readout-label">opens</div>
                <div class="readout-value">${fmtN(stats.usersRegistered)}</div>
            </div>
            <div class="readout" title="total time rooms were held open, summed per person">
                <div class="readout-label">presence</div>
                <div class="readout-value">${fmtDuration(stats.participantSeconds + activeSeconds)}</div>
            </div>
            <div class="readout" title="wall-clock time rooms had 2+ people — actual conversation">
                <div class="readout-label">talk time</div>
                <div class="readout-value">${fmtDuration((stats.callSeconds || 0) + liveCallSeconds)}</div>
            </div>
            <div class="readout is-peak">
                <div class="readout-label">peak rooms</div>
                <div class="readout-value">${stats.peakConcurrentRooms}</div>
            </div>
            <div class="readout is-peak">
                <div class="readout-label">peak users</div>
                <div class="readout-value">${stats.peakConcurrentUsers}</div>
            </div>
            <div class="readout" title="${dlTitle}">
                <div class="readout-label">desktop dl</div>
                <div class="readout-value">${dlValue}</div>
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
    <!-- Скачивания — ОТДЕЛЬНЫЙ график: та же ось X (дни выровнены), но своя шкала.
         На общей оси с users (пик ~190/день) бар в 3 скачивания был бы невидим. -->
    <div class="chart-frame">
        <div class="chart-meta">
            <span>desktop downloads</span>
            <span><span class="legend-dot" style="background:var(--dl)"></span>downloads</span>
        </div>
        ${dlChartHtml}
    </div>
</div>

<div class="hud-footer">
    <div>since <span>${fmtDate(stats.since)}</span></div>
    <div>updated <span>${fmtDate(stats.updatedAt)}</span></div>
    <div>auto-refresh <span>${failsOpen ? "paused" : "15s"}</span></div>
</div>

${failsHtml}

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
    /* dropped считается ОТДЕЛЬНО от воронки: это не «чем собралось соединение»,
       а «сколько собравшихся потом развалилось». Раньше эти случаи приходили как
       failed и завышали долю провалов — TURN на них не влияет никак. */
    const dropped = s.iceDropped || 0;
    const total = direct + relay + failed;

    if (total === 0 && dropped === 0) {
        return `<div class="conn-empty">no samples yet</div>`;
    }

    const pct = n => (total === 0 ? 0 : Math.round((n / total) * 100));
    const dPct = pct(direct), rPct = pct(relay), fPct = pct(failed);
    const failedRatio = total === 0 ? 0 : failed / total;

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
    const row = (cls, label, n, p, title) =>
        `<div class="conn-row"${title ? ` title="${title}"` : ""}>
            <span class="conn-k"><i class="conn-dot ${cls}"></i>${label}</span>
            <span class="conn-v">${fmtCount(n)}${p === null ? "" : ` · ${p}%`}</span>
        </div>`;

    return `<div class="conn" title="counts are reports — both peers report the same connection, so connections ≈ half">
        <div class="conn-bar">
            <span class="seg seg-direct" style="width:${dPct}%"></span>
            <span class="seg seg-relay" style="width:${rPct}%"></span>
            <span class="seg seg-failed" style="width:${fPct}%"></span>
        </div>
        <div class="conn-rows">
            ${row("seg-direct", "direct", direct, dPct)}
            ${row("seg-relay", "relay", relay, rPct)}
            ${row("seg-failed", "failed", failed, fPct)}
            ${row("seg-dropped", "dropped", dropped, null, "established connections that later died — not a setup failure")}
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

    const W = CHART_W;
    const H = 180;
    const padL = CHART_PAD_L, padR = CHART_PAD_R, padT = 10, padB = 28;
    const innerW = W - padL - padR;
    const innerH = H - padT - padB;

    const maxVal = Math.max(1, ...data.flatMap(d => [d.users, d.rooms]));
    const xStep = innerW / data.length;
    const barGroupW = Math.min(xStep * 0.7, 48);
    const barW = barGroupW / 2 - 1;

    // niceMax для bar-шкалы (users/rooms): округлённый верх для сетки.
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

/**
 * Скачивания desktop по дням — ОТДЕЛЬНЫЙ график, а не четвёртая серия в основном.
 * Причина: масштабы несопоставимы (users в пик ~190/день против 3-5 скачиваний) —
 * на общей оси бар DL был бы высотой в 1-2px, т.е. бесполезен. Две метрики разного
 * порядка → два графика с общей осью X, а не вторая Y-шкала.
 *
 * Геометрия (CHART_W / CHART_PAD_L / CHART_PAD_R / xStep) намеренно та же, что у
 * основного графика — дни выровнены вертикально, читается как один блок.
 */
function renderDownloadsChart(data) {
    if (data.length === 0) {
        return `<div style="padding:18px;text-align:center;color:var(--fg-3);font-size:11px;letter-spacing:.16em">no data yet</div>`;
    }

    const W = CHART_W;
    const H = 92;
    const padL = CHART_PAD_L, padR = CHART_PAD_R, padT = 8, padB = 24;
    const innerW = W - padL - padR;
    const innerH = H - padT - padB;

    const niceMax = pickNiceMax(Math.max(...data.map(d => d.dl)));
    const xStep = innerW / data.length;
    const barW = Math.min(xStep * 0.36, 22);

    const x = i => padL + xStep * i + xStep / 2;
    const y = v => padT + innerH - (v / niceMax) * innerH;

    const yTicks = [0, niceMax];
    const yLines = yTicks.map(t => {
        const yy = y(t);
        return `<line x1="${padL}" y1="${yy}" x2="${W - padR}" y2="${yy}" stroke="var(--line)" stroke-dasharray="${t === 0 ? "" : "2,4"}"/>
                <text x="${padL - 6}" y="${yy + 3}" text-anchor="end" font-size="9" fill="var(--fg-3)" font-family="ui-monospace,monospace">${Math.round(t)}</text>`;
    }).join("");

    const labelEvery = data.length <= 7 ? 1 : data.length <= 14 ? 2 : data.length <= 30 ? 5 : Math.ceil(data.length / 8);

    const bars = data.map((d, i) => {
        const cx = x(i);
        /* Минимум 2px на ненулевой день: одно скачивание при niceMax=10 дало бы
           6px, но при niceMax=100 — меньше пикселя, и день выглядел бы пустым. */
        const h = d.dl > 0 ? Math.max(2, (d.dl / niceMax) * innerH) : 0;
        const showLabel = i % labelEvery === 0 || i === data.length - 1;
        const dayShort = d.day.slice(5);
        return `<g>
            <title>${d.day} · downloads: ${d.dl} (installer ${d.dlI} · portable ${d.dlP})</title>
            <rect x="${cx - barW / 2}" y="${padT + innerH - h}" width="${barW}" height="${h}" fill="var(--dl)" opacity="0.85"/>
            ${showLabel ? `<text x="${cx}" y="${H - 8}" text-anchor="middle" font-size="9" fill="var(--fg-3)" font-family="ui-monospace,monospace" letter-spacing=".05em">${dayShort}</text>` : ""}
        </g>`;
    }).join("");

    return `<svg class="chart-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" xmlns="http://www.w3.org/2000/svg">
        ${yLines}
        ${bars}
    </svg>`;
}

/* ========= FAILED-CONNECTION LOG =========
 * Счётчик failed отвечает «сколько», лог — «почему». Слепок собирает клиент при
 * переходе peer в failed (см. reportFailure в public/webrtc.js), сервер копит
 * последние 100 (lib/stats.js). Всё, что тут рендерится, пришло от клиента —
 * поэтому строго через esc().
 */

/**
 * Автовердикт по слепку: самая вероятная причина провала. Порядок проверок = от
 * самого однозначного диагноза к самому общему; первый сработавший и выигрывает.
 */
function diagnoseFailure(e) {
    const local = e.local || {};
    const remote = e.remote || {};
    const errs = e.errs || [];
    const remoteTotal = (remote.host || 0) + (remote.srflx || 0) + (remote.prflx || 0) + (remote.relay || 0);

    if (errs.some(x => x.code === 401 || x.code === 403)) {
        return { text: "turn auth rejected — check TURN_SECRET / realm", cls: "v-bad" };
    }
    if (remoteTotal === 0) {
        /* Раньше на этот случай всегда писали «signalling lost», и он собирал
           89% лога — то есть не различал ничего. Пока peer ещё в gathering,
           куда вероятнее, что вторая сторона просто ушла или не успела ответить,
           чем что у нас потерялся сигналинг. */
        if (e.gather === "gathering") {
            return { text: "peer never answered — left early or answer/ice never arrived", cls: "v-warn" };
        }
        return { text: "no remote candidates — signalling or ice trickle lost", cls: "v-bad" };
    }
    if (e.turn && !local.relay) {
        return { text: "turn configured but 0 relay candidates — allocation failed", cls: "v-bad" };
    }
    if (!e.turn) {
        return { text: "no turn on this client — stun-only peer", cls: "v-warn" };
    }
    if (!local.srflx && !local.relay) {
        return { text: "no srflx/relay gathered — udp likely blocked", cls: "v-bad" };
    }
    if (local.relay && remote.relay) {
        return { text: "relay pairs existed but checks failed — turn reachability", cls: "v-warn" };
    }
    if (local.relay && !remote.relay) {
        return { text: "peer gathered no relay — turn failed on the other side", cls: "v-warn" };
    }
    return { text: "symmetric nat / udp blocked on both ends", cls: "v-warn" };
}

function renderFailsPanel(s, closeHref) {
    const list = s.iceFailLog || [];

    const fmtCands = (obj) => {
        const parts = ["host", "srflx", "prflx", "relay"]
            .map(k => {
                const n = obj[k] || 0;
                // relay:0 — самая частая причина провала, подсвечиваем красным.
                const cls = (k === "relay" && n === 0) ? ' class="zero"' : "";
                return `<span${cls}>${k} ${n}</span>`;
            });
        return parts.join(" · ");
    };

    const fmtPairs = (obj) => {
        const keys = Object.keys(obj);
        if (keys.length === 0) return "none formed";
        return keys.map(k => `${esc(k)} ${obj[k]}`).join(" · ");
    };

    const rows = list.slice().reverse().map(e => {
        const v = diagnoseFailure(e);
        const time = new Date(e.at).toISOString().replace("T", " ").slice(0, 19);
        const errsHtml = (e.errs || []).length
            ? (e.errs || []).map(x =>
                `<span class="err">${x.code}</span> ${esc(x.url || "—")}${x.text ? ` — ${esc(x.text)}` : ""}${x.count > 1 ? ` ×${x.count}` : ""}`
              ).join("<br>")
            : "none";

        return `<div class="fail">
            <div class="fail-top">
                <span>${time}</span>
                <span class="age">${(e.ms / 1000).toFixed(1)}s to fail</span>
                ${e.platform ? `<span class="tag">${esc(e.platform)}</span>` : ""}
                <span class="tag">turn ${e.turn ? "yes" : "no"}</span>
                ${e.relayOnly ? `<span class="tag">force-relay</span>` : ""}
                ${e.effType ? `<span class="tag" title="link speed class, not network type">${esc(e.effType)}</span>` : ""}
                ${e.attempt > 1 ? `<span class="tag" title="reconnect attempts before giving up">try ${e.attempt}</span>` : ""}
                ${e.room ? `<span class="tag">room ${esc(e.room)}</span>` : ""}
            </div>
            <div class="fail-ua">${esc(e.ua || "unknown ua")}</div>
            <div class="fail-grid">
                <span class="fail-k">state</span>
                <span class="fail-v">ice ${esc(e.ice || "?")} · gathering ${esc(e.gather || "?")} · signaling ${esc(e.sig || "?")}</span>
                <span class="fail-k">local</span>
                <span class="fail-v">${fmtCands(e.local || {})}</span>
                <span class="fail-k">remote</span>
                <span class="fail-v">${fmtCands(e.remote || {})}</span>
                <span class="fail-k">pairs</span>
                <span class="fail-v">${fmtPairs(e.pairs || {})}</span>
                <span class="fail-k">errors</span>
                <span class="fail-v">${errsHtml}</span>
            </div>
            <div class="fail-verdict ${v.cls}">→ ${v.text}</div>
        </div>`;
    }).join("");

    const body = list.length
        ? rows
        : `<div style="padding:28px 0;text-align:center;color:var(--fg-3);font-size:10px;letter-spacing:.16em;text-transform:uppercase">no failures recorded</div>`;

    /* Кнопки действий. Скачивание — обычная ссылка (GET, ничего не меняет),
       очистка — форма с POST и токеном: браузер шлёт Basic-креды и на чужой
       POST, поэтому без токена сторонняя страница смогла бы стереть лог. JS на
       странице по-прежнему нет. */
    const clearToken = actionToken("fails-clear");
    const actions = list.length
        ? `<a class="act" href="/adminstats/fails.json" download>download</a>
           <form class="act-form" method="post" action="/adminstats/fails/clear?t=${clearToken}">
               <button class="act act-danger" type="submit">clear</button>
           </form>`
        : "";

    return `<div class="fails-overlay">
        <a class="fails-backdrop" href="${closeHref}"></a>
        <div class="fails-panel">
            <div class="fails-head">
                <span>// failed connections · last ${list.length}</span>
                <span class="fails-actions">
                    ${actions}
                    <a class="x" href="${closeHref}">×</a>
                </span>
            </div>
            <div class="fails-list">${body}</div>
        </div>
    </div>`;
}
