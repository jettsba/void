/* ========= PRIVACY: псевдонимы для логов + страна по IP =========
 * privacy.html обещает: IP в постоянное хранилище не пишется. Логи docker'а —
 * это диск (json-file, недели истории), поэтому в лог уходит не IP, а метка
 * `ip#3fa9c1 (RU)`:
 *   - HMAC(ip) на соли, которая живёт ТОЛЬКО в памяти и меняется раз в сутки
 *     (и на каждом рестарте). В течение дня у одного адреса одна метка —
 *     по логам видно «этот создал комнату, у этого упал сокет», — а вернуть
 *     по метке IP нельзя: без соли IPv4 перебирается за минуты, а соли на
 *     диске нет нигде.
 *   - страна — из офлайн-базы DB-IP Lite (CC BY 4.0). Никаких внешних
 *     geo-API: отправить IP пользователя третьей стороне — ровно то, чего
 *     страница приватности обещает не делать. Сервер сам качает файл базы
 *     раз в месяц (запрос к db-ip.com не несёт ничьих данных).
 * Коды комнат в логах → roomRef: тот же солёный хеш, что в failure-логе
 * админки, — провал из /adminstats находится в docker-логах по `room=…`.
 *
 * Модуль не импортирует log.js: log.js импортирует его (маскирует поля сам).
 */
import crypto from "crypto";
import fs from "fs";
import path from "path";
import zlib from "zlib";
import { promisify } from "util";

const gunzip = promisify(zlib.gunzip);

/* ---------- псевдонимы ---------- */

const IP_SALT_ROTATE_MS = 24 * 60 * 60 * 1000;
let _ipSalt = crypto.randomBytes(16);
setInterval(() => { _ipSalt = crypto.randomBytes(16); }, IP_SALT_ROTATE_MS).unref?.();

/* Соль на процесс обязательна: код комнаты короткий, несолёный хеш
   перебирается за секунды, а код — это ключ входа в комнату. В отличие от
   IP-соли не ротируется: ref должен совпадать с записями failure-лога,
   накопленными за жизнь процесса. */
const _roomRefSalt = crypto.randomBytes(16);

export function roomRef(code) {
    return crypto.createHash("sha256")
        .update(_roomRefSalt)
        .update(String(code))
        .digest("hex")
        .slice(0, 6);
}

export function normalizeIp(ip) {
    const s = String(ip || "").trim();
    return s.startsWith("::ffff:") ? s.slice(7) : s;
}

export function ipTag(ip) {
    const norm = normalizeIp(ip);
    if (!norm) return "ip#? (??)";
    const h = crypto.createHmac("sha256", _ipSalt).update(norm).digest("hex").slice(0, 6);
    return `ip#${h} (${countryOf(norm)})`;
}

/* ---------- страна ---------- */

let _geo = null; // { v4Starts: Uint32Array, v4Cc: Uint16Array, v6Starts: BigUint64Array, v6Cc: Uint16Array, codes: string[] }

export function ipv4ToInt(s) {
    const p = s.split(".");
    if (p.length !== 4) return -1;
    let n = 0;
    for (const x of p) {
        if (!/^\d{1,3}$/.test(x)) return -1;
        const v = +x;
        if (v > 255) return -1;
        n = n * 256 + v;
    }
    return n;
}

/* Старшие 64 бита IPv6. Страны раздаются блоками /32…/48, младшая половина
   адреса на страну не влияет — BigUint64Array вдвое дешевле полного 128-bit. */
export function ipv6High(s) {
    if (s.includes(".")) return null;
    const halves = s.split("::");
    if (halves.length > 2) return null;
    const head = halves[0] ? halves[0].split(":") : [];
    let groups;
    if (halves.length === 1) {
        if (head.length !== 8) return null;
        groups = head;
    } else {
        const tail = halves[1] ? halves[1].split(":") : [];
        const fill = 8 - head.length - tail.length;
        if (fill < 1) return null;
        groups = [...head, ...new Array(fill).fill("0"), ...tail];
    }
    let v = 0n;
    for (let i = 0; i < 4; i++) {
        if (!/^[0-9a-f]{1,4}$/i.test(groups[i])) return null;
        v = (v << 16n) | BigInt(parseInt(groups[i], 16));
    }
    return v;
}

function isLanV4(n) {
    const a = n >>> 24, b = (n >>> 16) & 0xff;
    return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31)
        || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
}

function search(starts, x) {
    let lo = 0, hi = starts.length - 1, ans = -1;
    while (lo <= hi) {
        const mid = (lo + hi) >>> 1;
        if (starts[mid] <= x) { ans = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return ans;
}

export function countryOf(ip) {
    const norm = normalizeIp(ip);
    if (norm.includes(".")) {
        const n = ipv4ToInt(norm);
        if (n < 0) return "??";
        if (isLanV4(n)) return "LAN";
        if (!_geo) return "??";
        const i = search(_geo.v4Starts, n);
        return i < 0 ? "??" : _geo.codes[_geo.v4Cc[i]];
    }
    const lower = norm.toLowerCase();
    if (lower === "::1" || /^f[cd]/.test(lower) || lower.startsWith("fe80")) return "LAN";
    const hi = ipv6High(lower);
    if (hi === null || !_geo) return "??";
    const i = search(_geo.v6Starts, hi);
    return i < 0 ? "??" : _geo.codes[_geo.v6Cc[i]];
}

/* CSV DB-IP: `start,end,CC` по строке, диапазоны отсортированы и покрывают
   всё пространство без дыр — поэтому хватает стартов. ZZ = «не назначено». */
export function parseGeoCsv(text) {
    const codes = [], codeIdx = new Map();
    const v4s = [], v4c = [], v6s = [], v6c = [];
    const idx = (cc) => {
        const c = cc === "ZZ" || !/^[A-Z]{2}$/.test(cc) ? "??" : cc;
        let i = codeIdx.get(c);
        if (i === undefined) { i = codes.length; codes.push(c); codeIdx.set(c, i); }
        return i;
    };
    let pos = 0;
    while (pos < text.length) {
        let nl = text.indexOf("\n", pos);
        if (nl < 0) nl = text.length;
        const line = text.slice(pos, nl).trim();
        pos = nl + 1;
        if (!line) continue;
        const c1 = line.indexOf(","), c2 = line.lastIndexOf(",");
        if (c1 < 0 || c2 <= c1) continue;
        const start = line.slice(0, c1), cc = line.slice(c2 + 1);
        if (start.includes(":")) {
            const v = ipv6High(start.toLowerCase());
            if (v === null) continue;
            v6s.push(v); v6c.push(idx(cc));
        } else {
            const n = ipv4ToInt(start);
            if (n < 0) continue;
            v4s.push(n); v4c.push(idx(cc));
        }
    }
    return {
        v4Starts: Uint32Array.from(v4s), v4Cc: Uint16Array.from(v4c),
        v6Starts: BigUint64Array.from(v6s), v6Cc: Uint16Array.from(v6c),
        codes
    };
}

export function setGeoTable(table) { _geo = table; }

const GEO_FILE = process.env.GEO_FILE
    || path.join(path.dirname(process.env.STATS_FILE || "./data/stats.json"), "geo-country.csv.gz");
const GEO_MAX_AGE_MS = 32 * 24 * 60 * 60 * 1000; // DB-IP обновляет базу раз в месяц
const GEO_RECHECK_MS = 24 * 60 * 60 * 1000;

function monthTag(d) {
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

async function downloadGeo() {
    const now = new Date();
    const prev = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
    // Файл нового месяца появляется не в первые минуты 1-го числа — фолбэк на прошлый.
    for (const tag of [monthTag(now), monthTag(prev)]) {
        const res = await fetch(`https://download.db-ip.com/free/dbip-country-lite-${tag}.csv.gz`,
            { signal: AbortSignal.timeout(60_000) });
        if (!res.ok) continue;
        const buf = Buffer.from(await res.arrayBuffer());
        const tmp = GEO_FILE + ".tmp";
        await fs.promises.mkdir(path.dirname(GEO_FILE), { recursive: true });
        await fs.promises.writeFile(tmp, buf);
        await fs.promises.rename(tmp, GEO_FILE);
        return tag;
    }
    throw new Error("db-ip download failed");
}

async function refreshGeo() {
    let fresh = false;
    try {
        const st = await fs.promises.stat(GEO_FILE);
        fresh = Date.now() - st.mtimeMs < GEO_MAX_AGE_MS;
    } catch (_) {}
    let downloaded = null;
    if (!fresh) {
        try { downloaded = await downloadGeo(); } catch (e) {
            // Старый файл лучше, чем никакого: страна меняется у диапазонов редко.
            if (_geo) return { kept: true, err: e.message };
        }
    }
    if (_geo && !downloaded) return { kept: true };
    const text = (await gunzip(await fs.promises.readFile(GEO_FILE))).toString("utf8");
    _geo = parseGeoCsv(text);
    return { ranges: _geo.v4Starts.length + _geo.v6Starts.length, downloaded };
}

/* Старт с задержкой: разбор ~700k строк держит event loop ~0.3 s, а сразу
   после выкатки идёт волна реконнектов — не мешаем им. До загрузки базы
   страна в метке = `??`. `onResult` — колбэк логгера (сам модуль log.js
   не импортирует, чтобы не было цикла). */
export function startGeo(onResult, delayMs = 5000) {
    const run = () => refreshGeo().then(r => onResult(null, r), e => onResult(e));
    setTimeout(run, delayMs).unref?.();
    setInterval(run, GEO_RECHECK_MS).unref?.();
}
