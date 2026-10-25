/* ========= RESUME TICKET (закрытая комната переживает рестарт) =========
 * Комнаты живут только в памяти процесса. После выкатки вернувшийся участник
 * поднимает комнату обратно своим join'ом (resume, см. handleJoinRoom). Для
 * открытой комнаты это безопасно: занять свободный код можно и обычным
 * create-room. Для закрытой — нет: раньше чужак, знающий код, первым
 * воскрешал её со СВОИМ пропуском, и настоящие участники оставались снаружи.
 *
 * Билет — подпись сервера под фактом «комната CODE закрыта с пропуском P».
 * Выдаётся только тем, кто внутри (вместе с пропуском), переживает рестарт,
 * потому что секрет лежит на диске рядом со stats.json. Подделать без секрета
 * нельзя, к другому коду или другому пропуску не подходит.
 *
 * Секрет: env RESUME_SECRET, иначе файл `resume-secret` в каталоге данных
 * (создаётся при первом старте). Если ни то ни другое не вышло — секрет живёт
 * только в памяти: билеты не переживут рестарт, и закрытые комнаты после
 * выкатки просто не воскреснут (безопасный отказ вместо открытой двери).
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { log } from "./log.js";

/* Срок с запасом на длинные звонки: билет переиздаётся при каждом входе и
   смене состояния комнаты, но рестарт может прийти в любой момент. */
const TICKET_TTL_SEC = 7 * 24 * 60 * 60;

function loadSecret() {
    const env = process.env.RESUME_SECRET;
    if (typeof env === "string" && env.length >= 32) return Buffer.from(env);

    const file = path.join(path.dirname(process.env.STATS_FILE || "./data/stats.json"), "resume-secret");
    try {
        const saved = fs.readFileSync(file, "utf8").trim();
        if (saved.length >= 32) return Buffer.from(saved);
    } catch (_) { /* первого старта ещё не было */ }

    const fresh = crypto.randomBytes(32).toString("base64url");
    try {
        // Свежая машина: каталога данных при первом старте может ещё не быть.
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, fresh, { mode: 0o600 });
        log.info("boot", "resume secret created", { file });
    } catch (err) {
        log.warn("boot", "resume secret is memory-only, closed rooms will not survive a restart", { err: err.message });
    }
    return Buffer.from(fresh);
}

const SECRET = loadSecret();

function passHash(pass) {
    return crypto.createHash("sha256").update(pass).digest("base64url").slice(0, 22);
}

function sign(body) {
    return crypto.createHmac("sha256", SECRET).update(body).digest("base64url");
}

export function issueResumeTicket(code, pass) {
    const body = Buffer.from(JSON.stringify({
        c: code,
        p: passHash(pass),
        e: Math.floor(Date.now() / 1000) + TICKET_TTL_SEC
    })).toString("base64url");
    return `${body}.${sign(body)}`;
}

export function verifyResumeTicket(ticket, code, pass) {
    if (typeof ticket !== "string" || ticket.length > 512 || typeof pass !== "string") return false;
    const dot = ticket.indexOf(".");
    if (dot <= 0) return false;
    const body = ticket.slice(0, dot);
    const a = Buffer.from(ticket.slice(dot + 1));
    const b = Buffer.from(sign(body));
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
    let data;
    try {
        data = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    } catch (_) {
        return false;
    }
    return !!data
        && data.c === code
        && data.p === passHash(pass)
        && typeof data.e === "number"
        && data.e > Date.now() / 1000;
}
