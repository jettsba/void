/* ========= «ЗАКРЫТЬ КОМНАТУ» (голосование) =========
 * Блок в invite-панели: кнопка + кружки по числу участников. Комната
 * закрывается для новых, когда проголосовали ВСЕ (решает сервер,
 * lib/handlers.js handleRoomCloseVote). Голос отзывается повторным нажатием,
 * таймаута нет. Открыть обратно — любой участник одним нажатием.
 *
 * Пропуск: при закрытии сервер раздаёт участникам общий `pass` и подписанный
 * `ticket`. Храним оба в sessionStorage (живут в этой вкладке, переживают
 * перезагрузку) и шлём в каждом join-room — так нас пускают обратно после
 * обрыва сети и перезагрузки вкладки. После выкатки сервера комната воскресает
 * закрытой только по билету: свой пропуск может придумать кто угодно, а
 * подпись сервера — нет (см. lib/resume-ticket.js).
 */

const ROOM_PASS_KEY = (code) => `void:room-pass:${code}`;
const ROOM_TICKET_KEY = (code) => `void:room-ticket:${code}`;

let roomCloseState = { closed: false, votes: new Set() };

function _read(key) {
    try { return sessionStorage.getItem(key); } catch (_) { return null; }
}

function _write(key, value) {
    try {
        if (value) sessionStorage.setItem(key, value);
        else sessionStorage.removeItem(key);
    } catch (_) {}
}

function _writePass(code, pass, ticket) {
    if (!code) return;
    _write(ROOM_PASS_KEY(code), pass);
    _write(ROOM_TICKET_KEY(code), pass ? ticket : null);
}

/* Поля для join-room: пропуск с билетом (если есть) и флаг «комната была
   закрыта». Флаг и билет сервер смотрит только при воскрешении после рестарта. */
function roomJoinExtras(code) {
    if (!code) return {};
    const pass = _read(ROOM_PASS_KEY(code));
    if (!pass) return {};
    const ticket = _read(ROOM_TICKET_KEY(code));
    return { pass, closed: true, ...(ticket ? { ticket } : {}) };
}

/* Состояние из user-list / room-close-state. */
function applyRoomCloseState(data) {
    if (!data || typeof data !== "object") return;
    roomCloseState.closed = data.closed === true;
    roomCloseState.votes = new Set(Array.isArray(data.closeVotes) ? data.closeVotes : []);
    if (roomCloseState.closed && typeof data.pass === "string") {
        _writePass(currentRoomCode, data.pass, typeof data.ticket === "string" ? data.ticket : null);
    } else if (!roomCloseState.closed) {
        _writePass(currentRoomCode, null);
    }
    renderRoomClose();
}

/* Ушли из комнаты сами — пропуск больше не нужен. */
function forgetRoomPass() {
    _writePass(currentRoomCode, null);
}

function resetRoomCloseState() {
    roomCloseState = { closed: false, votes: new Set() };
    renderRoomClose();
}

function _roomMemberIds() {
    const ids = [clientId];
    if (typeof nicknameMap !== "undefined") {
        for (const id of nicknameMap.keys()) if (id !== clientId) ids.push(id);
    }
    return ids;
}

const _reduceMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

/* Смена текста кнопки: старый уходит вверх и гаснет, новый приходит снизу.
   Быстрая серия смен не копит анимации — берётся последний текст.
   Без filter: blur — анимированный filter в Chromium «залипает» на своём слое. */
function _swapLabel(el, text) {
    el._target = text;
    if (el.textContent === text && !el._swapping) return;
    if (_reduceMotion() || !el.offsetParent || typeof el.animate !== "function") {
        el.textContent = text;
        return;
    }
    if (el._swapping) return;
    el._swapping = true;
    const out = el.animate(
        [{ opacity: 1, transform: "translateY(0)" },
         { opacity: 0, transform: "translateY(-0.36rem)" }],
        { duration: 120, easing: "ease-in", fill: "forwards" });
    out.onfinish = () => {
        /* Ширину подписи ведём от старой к новой — иначе на смене текста
           бокс мгновенно сужался/расширялся и иконка рядом прыгала. */
        const w0 = el.getBoundingClientRect().width;
        el.textContent = el._target;
        const w1 = el.getBoundingClientRect().width;
        out.cancel();
        const ease = "cubic-bezier(.2, .6, .2, 1)";
        el.animate(
            [{ opacity: 0, transform: "translateY(0.36rem)" },
             { opacity: 1, transform: "translateY(0)" }],
            { duration: 220, easing: ease });
        if (Math.abs(w1 - w0) > 0.5) {
            el.animate([{ width: `${w0}px` }, { width: `${w1}px` }], { duration: 240, easing: ease });
        }
        el._swapping = false;
    };
}

/* Разовая анимация на кружке; класс снимаем по окончании, чтобы следующая
   смена состояния могла запустить её снова. */
function _flash(el, cls) {
    el.classList.remove("is-lighting", "is-dimming");
    void el.offsetWidth;
    el.classList.add(cls);
    el.addEventListener("animationend", () => el.classList.remove(cls), { once: true });
}

let _dotsClearTimer = null;
/* Наведение на кнопку закрытой комнаты: «вход закрыт» → «открыть». */
let _closeBtnHover = false;

/* Кружки по участникам — точечно, без пересоздания: иначе не было бы
   анимаций загорания/потухания (новый узел сразу в конечном состоянии). */
function _syncDots(box, ids, votes) {
    clearTimeout(_dotsClearTimer);
    if (ids.length === 0) {
        /* Блок схлопывается CSS-переходом — кружки держим до конца, чтобы
           не пропали раньше контейнера. Следующее голосование начнётся с
           чистого листа и снова «всплывёт». */
        _dotsClearTimer = setTimeout(() => box.replaceChildren(), 360);
        return;
    }
    const existing = new Map([...box.children].map(el => [el.dataset.uid, el]));
    ids.forEach((id, i) => {
        let d = existing.get(id);
        existing.delete(id);
        const voted = votes.has(id);
        if (!d) {
            d = document.createElement("span");
            d.className = "room-close-dot is-entering";
            d.dataset.uid = id;
            d.style.setProperty("--i", i);
            d.addEventListener("animationend", () => d.classList.remove("is-entering"), { once: true });
            d.classList.toggle("is-voted", voted);
            box.appendChild(d);
        } else if (d.classList.contains("is-voted") !== voted) {
            d.classList.toggle("is-voted", voted);
            _flash(d, voted ? "is-lighting" : "is-dimming");
        }
        if (box.children[i] !== d) box.insertBefore(d, box.children[i] || null);
        const nick = typeof nicknameMap !== "undefined" ? nicknameMap.get(id) : "";
        d.title = (id === clientId ? _t("roomClose.you") : nick) || "";
    });
    // Ушедшие участники — гаснут и исчезают.
    existing.forEach(el => {
        if (el.classList.contains("is-leaving")) return;
        el.classList.add("is-leaving");
        el.addEventListener("animationend", () => el.remove(), { once: true });
        if (_reduceMotion()) el.remove();
    });
}

function renderRoomClose() {
    const block = document.getElementById("roomCloseBlock");
    const btn = document.getElementById("roomCloseBtn");
    const label = document.getElementById("roomCloseLabel");
    const dots = document.getElementById("roomCloseDots");
    const info = document.getElementById("roomInfo");
    if (!block || !btn || !label || !dots) return;

    const { closed, votes } = roomCloseState;
    const myVote = votes.has(clientId);
    /* Нейтрально — только кнопка. Пошли голоса — над ней всплывают кружки
       (без подписей). Закрыто — кружков нет, кнопка говорит «вход закрыт»,
       а при наведении — что по ней можно сделать: «открыть». */
    const voting = !closed && votes.size > 0;

    block.classList.toggle("is-closed", closed);
    block.classList.toggle("is-voting", voting);
    // Наведение на «вход закрыт» → «открыть», дужка замка приоткрывается.
    btn.classList.toggle("is-unlock-hint", closed && _closeBtnHover);
    if (info) {
        info.classList.toggle("is-closed", closed);
        // Точка над кодом комнаты: голосование идёт, а моего голоса нет.
        info.classList.toggle("has-pending-vote", voting && !myVote);
    }

    const key = closed ? (_closeBtnHover ? "roomClose.open" : "roomClose.closed")
        : myVote ? "roomClose.unvote" : "roomClose.close";
    _swapLabel(label, _t(key));
    btn.setAttribute("aria-pressed", String(voting && myVote));

    _syncDots(dots, voting ? _roomMemberIds() : [], votes);
}

function onRoomCloseClick(e) {
    e.stopPropagation();
    if (!isJoined) return;
    if (roomCloseState.closed) {
        sendSocket({ type: "room-open" });
        return;
    }
    sendSocket({ type: "room-close-vote", vote: !roomCloseState.votes.has(clientId) });
}

function initRoomClose() {
    const btn = document.getElementById("roomCloseBtn");
    if (btn) {
        btn.addEventListener("click", onRoomCloseClick);
        const hover = (on) => () => {
            if (_closeBtnHover === on) return;
            _closeBtnHover = on;
            if (roomCloseState.closed) renderRoomClose();
        };
        btn.addEventListener("mouseenter", hover(true));
        btn.addEventListener("mouseleave", hover(false));
        btn.addEventListener("focus", hover(true));
        btn.addEventListener("blur", hover(false));
    }
    /* Кружки = участники: перерисовываем при смене состава/ников. */
    ["void:participants-changed", "void:locale-changed"].forEach(ev =>
        window.addEventListener(ev, renderRoomClose));
    renderRoomClose();
}

if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initRoomClose);
} else {
    initRoomClose();
}
