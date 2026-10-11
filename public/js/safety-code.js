/* ========= КОД БЕЗОПАСНОСТИ (SAS) =========
 * 5 РАЗНЫХ символов из 25 (25·24·23·22·21 ≈ 6.4 млн), ОДИН код на всю комнату.
 * Без повторов код легче сверять голосом, а стойкость почти та же (22.6 бита
 * против 23.2 у 25⁵ с повторами). Если у всех
 * одинаковые — между участниками никто не встал посередине, даже сервер.
 *
 * Угроза: сигналинг идёт через сервер, вместе с SDP идут DTLS-отпечатки.
 * Скомпрометированный сервер может подменить их и встать посередине (MITM).
 * Голый хеш отпечатков НЕ спасает: подменяющий выбирает свой отпечаток
 * ПОСЛЕДНИМ и за секунды подбирает сертификат под совпадающий короткий код.
 * Поэтому commit-reveal, как в ZRTP:
 *   1. Сертификат один на сессию вкладки (generateCertificate) → у каждого
 *      участника один отпечаток на все peer-соединения.
 *   2. Эпоха = текущий состав комнаты. На каждую эпоху каждый берёт свежий
 *      nonce и шлёт всем commit = H(epoch|userId|fp|nonce).
 *   3. nonce раскрываем (reveal), ТОЛЬКО собрав commit'ы от ВСЕХ участников
 *      эпохи. Подменяющий обязан зафиксировать свои значения до того, как
 *      узнает чужие свежие nonce, — подогнать код он не может, у него одна
 *      попытка с шансом 1 к 6.4 млн, а промах виден людям.
 *   4. Проверяем reveal против commit и против отпечатка из РЕАЛЬНОГО remote
 *      SDP этого соединения (его же проверяет DTLS). Не сошлось → «error».
 *   5. Код = H(epoch | id=fp=nonce для всех), первые 6 байт → номер
 *      размещения 5 из 25 без повторов (факториальная система счисления).
 * Свежий nonce на эпоху обязателен: отпечаток старожила подменяющий уже
 * видел, и без nonce он подогнал бы код под новичка (late-joiner атака).
 *
 * Транспорт — DataChannel "chat" (ordered: commit пира всегда раньше его
 * reveal). Первое значение на (эпоха, участник) окончательно: поздний
 * «другой» commit после чужих reveal'ов — ровно попытка обмана, игнорим.
 *
 * Ограничение: в вебе код приложения отдаёт тот же сервер — взломанный
 * сервер может отдать и подменённый JS. Полная защита — в desktop (код
 * вшит в подписанный бинарь). В модалке об этом не пишем (решение
 * пользователя 2026-10-11 — текст короткий), но помнить при обещаниях.
 */

const SAS_ICON_NAMES = [
    ["луна", "moon"], ["звезда", "star"], ["планета", "planet"], ["комета", "comet"], ["атом", "atom"],
    ["треугольник", "triangle"], ["квадрат", "square"], ["ромб", "diamond"], ["куб", "cube"], ["спираль", "spiral"],
    ["волна", "wave"], ["нота", "note"], ["наушники", "headphones"], ["колокол", "bell"], ["антенна", "antenna"],
    ["капля", "drop"], ["огонь", "flame"], ["молния", "bolt"], ["снежинка", "snowflake"], ["облако", "cloud"],
    ["ключ", "key"], ["глаз", "eye"], ["бесконечность", "infinity"], ["стрела", "arrow"], ["якорь", "anchor"]
];
const SAS_LEN = 5;
const SAS_EPOCH_KEEP = 8; // сколько чужих эпох держим в inbox (пиры могут отставать на шаг)

const VoidSafety = (() => {
    let certificate = null;
    let supported = typeof RTCPeerConnection !== "undefined"
        && typeof RTCPeerConnection.generateCertificate === "function"
        && !!(window.crypto && crypto.subtle);

    const ready = supported
        ? RTCPeerConnection.generateCertificate({ name: "ECDSA", namedCurve: "P-256" })
            .then(c => { certificate = c; })
            .catch(err => {
                supported = false;
                log.warn("rtc", "safety code: certificate generation failed", { err: err?.message || String(err) });
            })
        : Promise.resolve();

    let epoch = null;           // { id, members, nonce, commit, fp, revealed }
    /* Эпохи по id (составу) живут всю жизнь вкладки, даже между входами в
       комнату. Состав вернулся к прежнему (кто-то вышел и зашёл той же
       вкладкой — clientId и сертификат прежние) → берём прежние значения.
       Иначе мы взяли бы новый nonce, а соседи по правилу «первое значение
       окончательно» держали бы старый — и коды разъехались бы. Безопасности
       это не вредит: тот же состав = тот же код, подменяющему нечего подгонять. */
    const myEpochs = new Map();  // epochId → epoch
    const inbox = new Map();     // epochId → { commits: Map, nonces: Map }
    let result = { state: "alone", icons: null };
    let evalSeq = 0;
    let epochTimer = null;

    const enc = new TextEncoder();
    async function sha256Hex(str) {
        const buf = await crypto.subtle.digest("SHA-256", enc.encode(str));
        return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
    }

    function randomHex(bytes) {
        const a = new Uint8Array(bytes);
        crypto.getRandomValues(a);
        return [...a].map(b => b.toString(16).padStart(2, "0")).join("");
    }

    /* a=fingerprint:sha-256 AB:CD:… — session- или media-level, у bundle они
       одинаковые; берём первый sha-256. */
    function sdpFingerprint(sdp) {
        if (typeof sdp !== "string") return null;
        const m = sdp.match(/^a=fingerprint:sha-256 ([0-9A-Fa-f:]+)\s*$/m);
        return m ? m[1].toUpperCase() : null;
    }

    function remoteFp(uid) {
        const pc = typeof peers !== "undefined" ? peers.get(uid) : null;
        return pc ? sdpFingerprint(pc.remoteDescription?.sdp) : null;
    }

    function localFp() {
        if (typeof peers === "undefined") return null;
        for (const pc of peers.values()) {
            const fp = sdpFingerprint(pc?.localDescription?.sdp);
            if (fp) return fp;
        }
        return null;
    }

    function box(id) {
        let b = inbox.get(id);
        if (!b) {
            b = { commits: new Map(), nonces: new Map() };
            inbox.set(id, b);
            while (inbox.size > SAS_EPOCH_KEEP) inbox.delete(inbox.keys().next().value);
        }
        return b;
    }

    function commitInput(epochId, uid, fp, nonce) {
        return `void-sas-commit|${epochId}|${uid}|${fp}|${nonce}`;
    }

    function send(uid, msg) {
        const ch = typeof chatChannels !== "undefined" ? chatChannels.get(uid) : null;
        if (!ch || ch.readyState !== "open") return;
        try { ch.send(JSON.stringify({ type: "sas", ...msg })); } catch (_) {}
    }

    function others() {
        return epoch ? epoch.members.filter(id => id !== clientId) : [];
    }

    async function ensureCommit() {
        if (!epoch) return false;
        if (epoch.commit) return true;
        const fp = localFp();
        if (!fp) return false; // ещё нет ни одного local SDP — дождёмся открытия канала
        const ep = epoch;
        const c = await sha256Hex(commitInput(ep.id, clientId, fp, ep.nonce));
        if (epoch !== ep) return false;
        ep.fp = fp;
        ep.commit = c;
        return true;
    }

    async function syncPeer(uid) {
        if (!epoch || !(await ensureCommit())) return;
        send(uid, { op: "commit", epoch: epoch.id, c: epoch.commit });
        if (epoch.revealed) send(uid, { op: "reveal", epoch: epoch.id, n: epoch.nonce });
    }

    function setResult(state, icons = null) {
        result = { state, icons };
        render();
    }

    function startEpoch() {
        epochTimer = null;
        if (!isJoined || !supported || !certificate) {
            epoch = null;
            setResult(supported ? "alone" : "unavailable");
            return;
        }
        const members = [...new Set([clientId, ...(typeof nicknameMap !== "undefined" ? nicknameMap.keys() : [])])].sort();
        if (members.length < 2) {
            epoch = null;
            setResult("alone");
            return;
        }
        const id = members.join(",");
        if (epoch && epoch.id === id) return;
        epoch = myEpochs.get(id) || { id, members, nonce: randomHex(16), commit: null, fp: null, revealed: false };
        myEpochs.set(id, epoch);
        while (myEpochs.size > SAS_EPOCH_KEEP * 2) myEpochs.delete(myEpochs.keys().next().value);
        setResult("pending");
        others().forEach(uid => syncPeer(uid));
        evaluate();
    }

    function scheduleEpoch() {
        if (epochTimer) clearTimeout(epochTimer);
        // Вход/выход приходит пачкой (user-list → N× addParticipant) — одна эпоха на пачку.
        epochTimer = setTimeout(startEpoch, 80);
    }

    async function evaluate() {
        if (!epoch) return;
        const seq = ++evalSeq;
        const ep = epoch;
        const b = box(ep.id);
        const rest = others();
        if (!(await ensureCommit()) || epoch !== ep) return;

        if (!ep.revealed) {
            if (!rest.every(uid => b.commits.has(uid))) return;
            ep.revealed = true;
            rest.forEach(uid => send(uid, { op: "reveal", epoch: ep.id, n: ep.nonce }));
        }
        if (!rest.every(uid => b.nonces.has(uid))) return;

        const entries = [`${clientId}=${ep.fp}=${ep.nonce}`];
        for (const uid of rest) {
            const fp = remoteFp(uid);
            if (!fp) return; // remote SDP ещё нет — досчитаем на следующем событии
            const expect = await sha256Hex(commitInput(ep.id, uid, fp, b.nonces.get(uid)));
            if (seq !== evalSeq || epoch !== ep) return;
            if (expect !== b.commits.get(uid)) {
                log.warn("rtc", "safety code: commitment mismatch", { userId: uid });
                setResult("error");
                return;
            }
            entries.push(`${uid}=${fp}=${b.nonces.get(uid)}`);
        }
        entries.sort();
        const h = await sha256Hex(`void-sas-code|${ep.id}|${entries.join("|")}`);
        if (seq !== evalSeq || epoch !== ep) return;

        /* 48 бит → число < 2^53 (точно в double); mod 25·24·23·22·21 —
           перекос ~1e-8. Номер → размещение без повторов: на каждом шаге
           выбираем из оставшихся символов (у всех участников одинаково). */
        let space = 1;
        for (let i = 0; i < SAS_LEN; i++) space *= 25 - i;
        let n = parseInt(h.slice(0, 12), 16) % space;
        const pool = Array.from({ length: 25 }, (_, i) => i);
        const icons = [];
        for (let i = 0; i < SAS_LEN; i++) {
            const left = pool.length;
            icons.push(pool.splice(n % left, 1)[0]);
            n = Math.floor(n / left);
        }
        setResult("ready", icons);
    }

    function onMessage(msg, uid) {
        if (!msg || typeof msg.epoch !== "string" || msg.epoch.length > 1024) return;
        const b = box(msg.epoch);
        if (msg.op === "commit" && /^[0-9a-f]{64}$/.test(msg.c)) {
            if (!b.commits.has(uid)) b.commits.set(uid, msg.c);
        } else if (msg.op === "reveal" && /^[0-9a-f]{32}$/.test(msg.n)) {
            // reveal без commit'а — нарушение порядка (канал ordered), не берём.
            if (b.commits.has(uid) && !b.nonces.has(uid)) b.nonces.set(uid, msg.n);
        } else {
            return;
        }
        if (epoch && msg.epoch === epoch.id) evaluate();
    }

    function onChannelOpen(uid) {
        if (epoch && epoch.members.includes(uid)) syncPeer(uid).then(evaluate);
    }

    /* Вышли из комнаты. inbox и myEpochs НЕ чистим — см. myEpochs. */
    function reset() {
        if (epochTimer) { clearTimeout(epochTimer); epochTimer = null; }
        epoch = null;
        setResult(supported ? "alone" : "unavailable");
        closeModal();
    }

    /* ---------- UI ---------- */

    function iconSvg(i, cls) {
        const ns = "http://www.w3.org/2000/svg";
        const svg = document.createElementNS(ns, "svg");
        svg.setAttribute("class", cls);
        svg.setAttribute("aria-hidden", "true");
        const use = document.createElementNS(ns, "use");
        use.setAttribute("href", `#sas-${i}`);
        svg.appendChild(use);
        return svg;
    }

    function iconName(i) {
        const lang = window.VoidI18n?.getLang?.() === "en" ? 1 : 0;
        return SAS_ICON_NAMES[i][lang];
    }

    function render() {
        const mini = document.getElementById("sasMini");
        const row = document.getElementById("sasRow");
        if (mini && row) {
            mini.replaceChildren();
            row.dataset.state = result.state;
            /* Подписи нет — только символы. alone/unavailable — строку прячет CSS;
               pending — пять мерцающих точек на месте символов; error — текстом. */
            if (result.state === "ready") {
                result.icons.forEach(i => mini.appendChild(iconSvg(i, "sas-mini-icon")));
                row.setAttribute("aria-label", `${_t("sas.label")}: ${result.icons.map(iconName).join(", ")}`);
            } else if (result.state === "pending") {
                for (let k = 0; k < SAS_LEN; k++) {
                    const dot = document.createElement("span");
                    dot.className = "sas-mini-dot";
                    dot.style.setProperty("--k", k);
                    mini.appendChild(dot);
                }
                row.setAttribute("aria-label", _t("sas.status.pending"));
            } else if (result.state === "error") {
                mini.textContent = _t("sas.mini.error");
                row.setAttribute("aria-label", _t("sas.status.error"));
            }
        }
        renderModal();
    }

    let modalKey = "";
    function renderModal(force = false) {
        const big = document.getElementById("sasBig");
        const status = document.getElementById("sasStatus");
        const modal = document.getElementById("sasModal");
        if (!big || !status || !modal) return;
        /* Тот же код (повторный evaluate по дублю commit'а и т.п.) — DOM не
           трогаем: пересоздание ячеек заново запускало анимацию посреди показа. */
        const key = `${result.state}|${result.icons || ""}|${window.VoidI18n?.getLang?.() || ""}`;
        if (!force && key === modalKey) return;
        modalKey = key;
        modal.dataset.state = result.state;
        big.replaceChildren();
        if (result.state === "ready") {
            result.icons.forEach((i, k) => {
                const cell = document.createElement("div");
                cell.className = "sas-big-cell";
                cell.style.setProperty("--k", k);
                cell.appendChild(iconSvg(i, "sas-big-icon"));
                // Подписей под символами нет — название остаётся для скринридера.
                cell.setAttribute("role", "img");
                cell.setAttribute("aria-label", iconName(i));
                big.appendChild(cell);
            });
            status.textContent = "";
        } else {
            for (let k = 0; k < SAS_LEN; k++) {
                const cell = document.createElement("div");
                cell.className = "sas-big-cell is-empty";
                cell.style.setProperty("--k", k);
                big.appendChild(cell);
            }
            status.textContent = _t("sas.status." + result.state);
        }
    }

    let escHandler = null;
    function openModal() {
        const modal = document.getElementById("sasModal");
        if (!modal) return;
        if (typeof closePingPanel === "function") closePingPanel();
        renderModal(true);
        /* Анимация проигрывается заново на каждое открытие. */
        modal.classList.remove("is-open");
        void modal.offsetWidth;
        modal.classList.add("is-open");
        modal.removeAttribute("inert");
        modal.setAttribute("aria-hidden", "false");
        setTimeout(() => document.getElementById("sasClose")?.focus(), 60);
        escHandler = (e) => { if (e.key === "Escape") { e.preventDefault(); closeModal(); } };
        document.addEventListener("keydown", escHandler);
    }

    function closeModal() {
        const modal = document.getElementById("sasModal");
        if (!modal || !modal.classList.contains("is-open")) return;
        modal.classList.remove("is-open");
        modal.setAttribute("inert", "");
        modal.setAttribute("aria-hidden", "true");
        if (escHandler) { document.removeEventListener("keydown", escHandler); escHandler = null; }
    }

    function init() {
        const row = document.getElementById("sasRow");
        if (row) {
            const open = (e) => { e.stopPropagation(); openModal(); };
            row.addEventListener("click", open);
            row.addEventListener("keydown", (e) => {
                if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(e); }
            });
        }
        document.getElementById("sasClose")?.addEventListener("click", closeModal);
        document.getElementById("sasBackdrop")?.addEventListener("click", closeModal);
        window.addEventListener("void:participants-changed", scheduleEpoch);
        window.addEventListener("void:locale-changed", render);
        render();
    }

    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
    else init();

    return {
        ready,
        /* Для createPeer: один сертификат на все соединения вкладки. */
        certificates: () => (certificate ? [certificate] : undefined),
        onMessage,
        onChannelOpen,
        reset,
        /* Для e2e-тестов и диагностики. */
        get state() { return { ...result, epoch: epoch?.id || null }; }
    };
})();

window.VoidSafety = VoidSafety;
