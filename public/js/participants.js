/* Кэш ссылок на DOM-элементы участников — чтобы не ходить в querySelector
   на каждое обновление громкости/аудио-состояния/скринкаста. */
const participantElements = new Map(); // userId → .participant element

/* Монолайн-иконки состояний в аватаре (style guide §6, stroke 1.4 round).
   Видимость переключается CSS-ом по классам .muted / .deaf / .screensharing
   на .participant — JS только кладёт разметку один раз при создании блоба.
   - mic-off  → центр, когда muted (но не deaf)
   - headphones-off → центр, когда deaf (deaf ⊇ muted, перекрывает mic)
   - monitor  → центр, когда делится экраном (но не muted/deaf) */
const PARTICIPANT_STATE_ICONS =
    '<span class="participant-state-icon participant-state-icon--mic" aria-hidden="true">' +
        '<svg viewBox="0 0 24 24">' +
            '<rect x="9" y="3" width="6" height="12" rx="3"/>' +
            '<path d="M5 11a7 7 0 0 0 14 0"/>' +
            '<path d="M12 18v3"/>' +
            '<line class="strike-bg" x1="20" y1="4" x2="4" y2="20"/>' +
            '<line class="strike" x1="20" y1="4" x2="4" y2="20"/>' +
        '</svg>' +
    '</span>' +
    '<span class="participant-state-icon participant-state-icon--deaf" aria-hidden="true">' +
        '<svg viewBox="0 0 24 24">' +
            '<path d="M6 13v-1a6 6 0 0 1 12 0v1"/>' +
            '<rect x="4.5" y="12" width="3.5" height="6.5" rx="1.75"/>' +
            '<rect x="16" y="12" width="3.5" height="6.5" rx="1.75"/>' +
            '<line class="strike-bg" x1="20" y1="4" x2="4" y2="20"/>' +
            '<line class="strike" x1="20" y1="4" x2="4" y2="20"/>' +
        '</svg>' +
    '</span>' +
    '<span class="participant-state-icon participant-state-icon--screen" aria-hidden="true">' +
        '<svg viewBox="0 0 24 24">' +
            '<rect x="3" y="4" width="18" height="12" rx="1.6"/>' +
            '<path d="M9 20h6M12 16v4"/>' +
            '<path d="M12 13V7M9.5 9.5 12 7l2.5 2.5"/>' +
        '</svg>' +
    '</span>';

/**
 * F18: безопасный «удалить узел после конца анимации». `animationend` не
 * гарантирован: его не будет если animation вообще не запустилась (CSS не
 * загрузился, prefers-reduced-motion в некоторых браузерах, `display:none`).
 * Без fallback DOM-узлы зависают в .pop-out классе. Помимо animationend
 * запускаем setTimeout(500) — это слегка дольше, чем самая длинная pop-анимация.
 * Любая из двух веток сработает первой → idempotent finish.
 */
function _onAnimationEndOrFallback(el, onDone) {
    let done = false;
    const fire = () => {
        if (done) return;
        done = true;
        el.removeEventListener("animationend", fire);
        clearTimeout(timer);
        if (typeof onDone === "function") onDone();
        else el.remove();
    };
    el.addEventListener("animationend", fire, { once: true });
    const timer = setTimeout(fire, 500);
}

/* ===== Invite hint =====
   С v0.9.16 — поверх unified toast-host (см. public/js/toasts.js). Сам
   hint остался прежним: показывается, когда юзер один в комнате и не
   видел его раньше; persist'ится в localStorage по клику. */

function updateInviteHint() {
    if (!isJoined) return;
    try {
        if (localStorage.getItem("void:invite-hint-seen") === "1") return;
    } catch (_) {}
    const count = participantsContainer
        ? [...participantsContainer.querySelectorAll(".participant:not(.pop-out)")].length
        : 0;
    if (count === 1) {
        window.VoidToast?.showHint(_t("invite.hint"), {
            onClick: () => dismissInviteHint(true)
        });
    } else {
        window.VoidToast?.clearHint();
    }
}

function dismissInviteHint(persist) {
    window.VoidToast?.clearHint();
    if (persist) {
        try { localStorage.setItem("void:invite-hint-seen", "1"); } catch (_) {}
    }
}

function resetInviteHint() {
    window.VoidToast?.clearHint();
}

function removeAllParticipants() {

    participantElements.clear();
    const all = document.querySelectorAll(".participant");

    all.forEach(el => {
        const arc = el.querySelector(".volume-arc");
        if (arc) arc._cleanup?.();

        el.classList.remove("pop-in");
        el.classList.add("pop-out");

        _onAnimationEndOrFallback(el);
    });
}

function addParticipant(userId, nickname) {

    nicknameMap.set(userId, nickname);

    /* Идемпотентность. Если participant с таким userId уже в DOM и не уходит
       pop-out'ом — это повторный addParticipant (новый user-list после
       реконнекта или редкая серверная гонка). Дубль не плодим: обновляем
       ник на месте и возвращаемся. На сервере userId валидируется по
       `[A-Za-z0-9_-]{1,64}`, спецсимволов в селекторе быть не может. */
    const exists = participantsContainer?.querySelector(
        `.participant[data-user-id="${userId}"]:not(.pop-out)`
    );
    if (exists) {
        const lines = exists.querySelectorAll(".participant-name-line");
        const [w1, w2] = splitNicknameLines(nickname);
        if (lines[0]) lines[0].textContent = w1;
        if (lines[1]) lines[1].textContent = w2 || " ";
        const nameEl = exists.querySelector(".participant-name");
        nameEl?.classList.toggle("premium", isPremiumNickname(nickname));
        return;
    }

    const participant = document.createElement("div");
    participant.classList.add("participant");
    participant.dataset.userId = userId;

    if (userId === clientId) {
        participant.classList.add("self");
    }

    const avatar = document.createElement("div");
    avatar.classList.add("participant-avatar");
    avatar.innerHTML = PARTICIPANT_STATE_ICONS;

    const name = document.createElement("div");
    name.classList.add("participant-name");
    if (isPremiumNickname(nickname)) {
        name.classList.add("premium");
    }
    const [word1, word2] = splitNicknameLines(nickname);
    const line1 = document.createElement("span");
    line1.className = "participant-name-line";
    line1.textContent = word1;
    const line2 = document.createElement("span");
    line2.className = "participant-name-line";
    line2.textContent = word2 || "\u00a0";
    name.appendChild(line1);
    name.appendChild(line2);

    const watchBtn = document.createElement("div");
    watchBtn.className = "watch-screen-btn";
    /* Двустрочная кнопка — обе строки переводимые. */
    watchBtn.innerHTML =
        '<span data-i18n="screencast.watch">' + _t("screencast.watch") + '</span>' +
        '<span data-i18n="screencast.screen">' + _t("screencast.screen") + '</span>';

    participant.appendChild(avatar);
    participant.appendChild(name);
    participant.appendChild(watchBtn);

    participantsContainer.appendChild(participant);
    participantElements.set(userId, participant);

    /* Новый блоб ставим сразу в финальную позицию без анимации переезда
       (.no-anim), затем pop-in; остальные плавно переезжают на новые места. */
    participant.classList.add("no-anim");
    _pendingPopIns.add(participant);
    scheduleParticipantsLayout();
    updateInviteHint();

    if (userId !== clientId) {
        participant.addEventListener("click", e => {
            if (e.target.closest(".watch-screen-btn")) {
                openScreenOverlay(userId);
                return;
            }
            toggleVolumeControl(participant, userId);
        });
    }
}

function removeParticipant(userId) {

    nicknameMap.delete(userId);

    const el = participantElements.get(userId) ||
        document.querySelector(`.participant[data-user-id="${userId}"]`);

    if (!el || el.classList.contains("pop-out")) return;

    const arc = el.querySelector(".volume-arc");
    if (arc) arc._cleanup?.();

    el.classList.remove("pop-in");
    el.classList.add("pop-out");
    participantElements.delete(userId);

    /* Оставшиеся сразу переезжают на новые места (уходящий с .pop-out исключён
       из раскладки) — пока он гаснет. FLIP больше не нужен: движение даёт
       transform-transition у .participant. */
    scheduleParticipantsLayout();

    _onAnimationEndOrFallback(el, () => {
        el.remove();
        updateInviteHint();
    });
}

/* ============================================================================
   РАСКЛАДКА УЧАСТНИКОВ — дуга-«корона» вокруг self.

   Свой блоб — якорь в центре (offset 0,0). Остальные — на верхней полудуге,
   огибающей его; радиус короны растёт с числом (RAD_BY_COUNT). Позиции —
   абсолютные, через CSS-переменные --px/--py (transform у .participant); размер
   блоба — через --sz. Перемещение и сужение анимируются CSS-transition'ами
   (одноразовые на вход/выход/resize, не непрерывные → без пиксель-джиттера).

   Всё считается из ЗАМЕРЕННОЙ области (низ header ↔ верх controls, ширина сцены)
   → адаптив под любое разрешение / ui-scale / телефон; fit-scale не даёт вылезти
   за вьюпорт. Спец-кейсы: N=1 центр, N=2 — пара по центру (как в проде).

   Референсная математика и тюнинг значений — participants-canvas.html.
   ============================================================================ */

const _HALFPI = Math.PI / 2;
/* Число участников → «радиус короны» (насколько широко разлетается дуга).
   1-5 зафиксированы; 6-10 — чуть шире. */
const _RAD_BY_COUNT = { 3: 0.18, 4: 0.18, 5: 0.25, 6: 0.30, 7: 0.40, 8: 0.50, 9: 0.60, 10: 0.68 };
/* 8-10: «продление» дуги вниз (рад к размаху) — нижние концы уходят чуть ниже
   уровня self, дуга охватывает больше полукруга. */
const _DIP_BY_COUNT = { 8: 0.16, 9: 0.30, 10: 0.44 };
/* Базовый размер блоба (rem) по числу — прогрессивно; индекс = count-1 (1..10).
   fit-scale может ужать ещё под маленький экран. */
const _SIZE_REM = [6, 6, 6, 6, 6, 5.3, 4.8, 4.3, 3.9, 3.5];
/* Свой блоб не мельче, чем в комнате на 7 (index 6 = 4.8rem): на 8-10 others
   продолжают уменьшаться, а self держит этот минимум. */
const _SELF_SIZE_REM = n => _SIZE_REM[Math.min(6, n - 1)];
const _PAIR_GAP_REM = 2.43;      // базовый зазор пары (N=2), = прежний --participants-gap

const _pendingPopIns = new Set();
let _layoutRaf = 0;
let _layoutInstant = false;

function _remPx() {
    return parseFloat(getComputedStyle(document.documentElement).fontSize) || 14;
}

/* Мобилка с открытым чатом: чат — нижний лист, контролы скрыты, сцена сжата в
   верхнюю полосу. В этом режиме раскладываем строками по 5, а не дугой. */
function _isMobileChat() {
    return !!(document.body && document.body.classList.contains("chat-open")
        && window.matchMedia && window.matchMedia("(max-width: 740px)").matches);
}

/* Высота двухстрочного ника (px) — ник масштабируется с блобом (см. stage.css
   .participant-name font-size clamp), поэтому оценка от sz. */
function _nameHeight(sz, remPx) {
    const fs = Math.min(0.86 * remPx, Math.max(0.62 * remPx, sz * 0.16));
    return fs * 2.5 + 0.6 * remPx;
}

/* Замер доступной области в offset-координатах от якоря (центра .users-slot).
   up/down — сколько можно вверх/вниз, halfW — половина ширины. */
function _measureRegion(remPx) {
    const slot = document.querySelector(".users-slot");
    if (!slot) return null;
    const header = document.querySelector(".header");
    const controls = document.querySelector(".panel-controls");
    const stage = document.querySelector(".stage");
    const a = slot.getBoundingClientRect();
    const ax = a.left + a.width / 2, ay = a.top + a.height / 2;
    const headerB = header ? header.getBoundingClientRect().bottom : 0;
    let ctrlT = window.innerHeight;
    if (controls && controls.getClientRects().length) ctrlT = controls.getBoundingClientRect().top;
    // мобилка + чат: контролы скрыты, снизу лист чата → нижняя граница = верх листа.
    // Берём CSS-высоту (getComputedStyle) — она не зависит от анимации transform.
    if (_isMobileChat()) {
        const chat = document.querySelector(".chat-panel");
        const h = chat ? parseFloat(getComputedStyle(chat).height) || 0 : 0;
        if (h > 0) ctrlT = Math.min(ctrlT, window.innerHeight - h);
    }
    const s = stage ? stage.getBoundingClientRect() : { left: 0, right: window.innerWidth };
    const mSide = 1.4 * remPx, mTop = 1.0 * remPx, mBot = 1.0 * remPx;
    return {
        up: Math.max(30, ay - headerB - mTop),
        down: Math.max(20, ctrlT - ay - mBot),
        halfW: Math.max(40, Math.min(ax - s.left, s.right - ax) - mSide)
    };
}

/* Дуга-корона: self в (0,0), others — по верхней полудуге (dy<0 = вверх).
   Равный шаг + ограниченный джиттер; когда одна дуга не влезает без наложений —
   авто-разворот в две концентрические (ближние = раньше вошли). */
function _computeArc(others, pos, sz, rad, region, dip) {
    const m = others.length;
    const Rmax = Math.min(region.halfW, region.up);
    const chord = sz * 1.28;
    const radiusForStep = step => Math.max(chord / (2 * Math.sin(Math.max(0.001, step / 2))), sz * 1.5);
    // базовый размах + «продление вниз» (dip): концы дуги уходят ниже уровня self.
    const span = Math.min(Math.PI * 1.02, (60 + m * 30) * Math.PI / 180) + (dip || 0);

    const placeArc = (list, R, sp, stag) => {
        const k = list.length, step = k > 1 ? sp / (k - 1) : 0, s0 = -_HALFPI - sp / 2 + (stag || 0);
        for (let q = 0; q < k; q++) {
            const ang = k > 1 ? s0 + step * q : -_HALFPI;   // ровно по дуге, без отклонения
            pos.set(list[q], { x: Math.cos(ang) * R, y: Math.sin(ang) * R });
        }
    };

    const step0 = span / Math.max(1, m - 1), Rneed = radiusForStep(step0);
    if (m <= 5 || Rneed <= Rmax) {
        let R = Math.min(Rmax, Rneed + rad * Math.max(0, Rmax - Rneed));
        if (R < Rneed) R = Math.min(Rneed, Rmax);
        placeArc(others, R, span, 0);
    } else {
        const ni = Math.max(1, Math.floor(m * 0.42)), no = m - ni;
        const Rin = Math.max(sz * 1.6, radiusForStep(span * 0.8 / Math.max(1, ni - 1)));
        const Rout = Math.min(Rmax, Rin + sz * 1.35);
        placeArc(others.slice(0, ni), Rin, span * 0.8, 0);
        placeArc(others.slice(ni), Rout, span, (no > 1 ? span / (no - 1) : 0) * 0.5);
    }
}

/* Раскладка строками по 5 (мобилка + открытый чат). 1-5 — один центрированный
   ряд; 6-10 — два ряда (первый 5, второй — остаток, тоже центрирован). Весь блок
   центрируется по вертикали в области. Без дуги, без релаксации (шаг гарантирует
   отсутствие наложений). Порядок — DOM (self на своём месте, не в центре). */
function _computeRows(els, pos, sz, nameH, region) {
    const n = els.length, perRow = 5;
    const rows = n <= perRow ? [els] : [els.slice(0, perRow), els.slice(perRow)];
    const gapX = sz * 1.42;
    const rowGap = sz + nameH + sz * 0.28;
    const y0 = -((rows.length - 1) * rowGap) / 2;
    rows.forEach((row, ri) => {
        const k = row.length, x0 = -((k - 1) * gapX) / 2, y = y0 + ri * rowGap;
        row.forEach((el, ci) => pos.set(el, { x: x0 + ci * gapX, y }));
    });
    // вертикально центрируем блок (с учётом ников снизу) в середине области
    let minY = Infinity, maxY = -Infinity;
    for (const p of pos.values()) { minY = Math.min(minY, p.y - sz / 2); maxY = Math.max(maxY, p.y + sz / 2 + nameH); }
    const shift = (region.down - region.up) / 2 - (minY + maxY) / 2;
    for (const p of pos.values()) p.y += shift;
}

/* Релаксация по «коробке блоб + ник снизу»: разводит перекрытия (в тесной
   области дуга может дать наложение ников). В просторной области наложений нет →
   ни одного сдвига (дуга остаётся чистой). self зафиксирован в центре (не двигаем).
   Финальная страховка — чисто по X (ширины почти всегда хватает). */
function _relaxBoxes(pos, selfEl, sz, selfSz, nameH, region) {
    const others = [...pos.keys()].filter(e => e !== selfEl);
    if (others.length < 2) return;
    const wReq = sz * 1.06, hReq = sz + nameH * 0.82;
    // keep-out от self считаем по среднему радиусу (self может быть крупнее на 8-10).
    const wReqS = (sz + selfSz) / 2 * 1.06, hReqS = (sz + selfSz) / 2 + nameH * 0.82;
    const hx = region.halfW - sz / 2;
    const top = -region.up + sz / 2, bot = region.down - sz / 2 - nameH;
    const self = pos.get(selfEl) || { x: 0, y: 0 };
    for (let it = 0; it < 160; it++) {
        for (const e of others) {
            const p = pos.get(e), dx = p.x - self.x, dy = p.y - self.y;
            const pX = wReqS - Math.abs(dx), pY = hReqS - Math.abs(dy);
            if (pX > 0 && pY > 0) { if (pX < pY) p.x += (dx >= 0 ? 1 : -1) * pX; else p.y += (dy >= 0 ? 1 : -1) * pY; }
        }
        for (let a = 0; a < others.length; a++) for (let c = a + 1; c < others.length; c++) {
            const A = pos.get(others[a]), B = pos.get(others[c]);
            const qx = wReq - Math.abs(A.x - B.x), qy = hReq - Math.abs(A.y - B.y);
            if (qx > 0 && qy > 0) {
                if (qx < qy) { const s = (A.x >= B.x ? 1 : -1) * qx / 2; A.x += s; B.x -= s; }
                else { const s = (A.y >= B.y ? 1 : -1) * qy / 2; A.y += s; B.y -= s; }
            }
        }
        for (const e of others) { const p = pos.get(e); p.x = Math.max(-hx, Math.min(hx, p.x)); p.y = Math.max(top, Math.min(bot, p.y)); }
    }
    for (let f = 0; f < 50; f++) {
        let moved = false;
        for (const e of others) {
            const p = pos.get(e), dx = p.x - self.x, dy = p.y - self.y;
            if (wReqS - Math.abs(dx) > 0 && hReqS - Math.abs(dy) > 0) { p.x += (dx >= 0 ? 1 : -1) * (wReqS - Math.abs(dx) + 0.5); moved = true; }
        }
        for (let a = 0; a < others.length; a++) for (let c = a + 1; c < others.length; c++) {
            const A = pos.get(others[a]), B = pos.get(others[c]);
            const qx = wReq - Math.abs(A.x - B.x), qy = hReq - Math.abs(A.y - B.y);
            if (qx > 0 && qy > 0) { const s = (A.x >= B.x ? 1 : -1) * (qx / 2 + 0.5); A.x += s; B.x -= s; moved = true; }
        }
        for (const e of others) { const p = pos.get(e); p.x = Math.max(-hx, Math.min(hx, p.x)); }
        if (!moved) break;
    }
}

/* Единый коэффициент, чтобы вся раскладка (блобы + ники снизу) влезла в область.
   self может быть крупнее others (8-10) — считаем его размер отдельно. */
function _fitScale(pos, sz, nameH, selfEl, selfSz, selfNameH, region) {
    let top = 0, bottom = 0, side = 0;
    for (const [el, p] of pos) {
        const s = el === selfEl ? selfSz : sz, nh = el === selfEl ? selfNameH : nameH;
        if (p.y - s / 2 < top) top = p.y - s / 2;
        if (p.y + s / 2 + nh > bottom) bottom = p.y + s / 2 + nh;
        const sx = Math.abs(p.x) + s / 2;
        if (sx > side) side = sx;
    }
    let f = 1;
    if (top < -region.up) f = Math.min(f, region.up / -top);
    if (bottom > region.down) f = Math.min(f, region.down / bottom);
    if (side > region.halfW) f = Math.min(f, region.halfW / side);
    return Math.max(0.35, f);
}

/* Главная функция: вычисляет и проставляет --sz/--px/--py всем участникам. */
function layoutParticipants() {
    if (!participantsContainer) return;
    const els = [...participantsContainer.querySelectorAll(".participant:not(.pop-out)")];
    const n = els.length;
    if (n === 0) return;

    const remPx = _remPx();
    const rowsMode = _isMobileChat();                        // мобилка + чат → строки по 5
    let sz = _SIZE_REM[Math.min(9, n - 1)] * remPx;          // others
    let selfSz = rowsMode ? sz : _SELF_SIZE_REM(n) * remPx;  // в строках self не крупнее
    const region = _measureRegion(remPx);
    if (!region) return;

    const selfEl = els.find(e => e.classList.contains("self")) || els[0];
    const pos = new Map();
    let nameH = _nameHeight(sz, remPx);
    let selfNameH = _nameHeight(selfSz, remPx);

    if (rowsMode) {
        _computeRows(els, pos, sz, nameH, region);           // все N — строками (self в DOM-порядке)
    } else if (n === 1) {
        pos.set(els[0], { x: 0, y: 0 });
    } else if (n === 2) {
        const half = sz / 2 + (_PAIR_GAP_REM * remPx) / 2;   // пара по центру, DOM-порядок как в проде
        pos.set(els[0], { x: -half, y: 0 });
        pos.set(els[1], { x: half, y: 0 });
    } else {
        const others = els.filter(e => e !== selfEl);        // DOM-порядок сохраняется
        const rad = _RAD_BY_COUNT[Math.min(10, n)] ?? 0.4;
        _computeArc(others, pos, sz, rad, region, _DIP_BY_COUNT[n] || 0);
        pos.set(selfEl, { x: 0, y: 0 });
    }
    const f = _fitScale(pos, sz, nameH, selfEl, selfSz, selfNameH, region);
    if (f < 1) {
        sz *= f; selfSz *= f;
        for (const p of pos.values()) { p.x *= f; p.y *= f; }
        nameH = _nameHeight(sz, remPx); selfNameH = _nameHeight(selfSz, remPx);
    }

    /* Разводим остаточные наложения ников (тесная область на 7-10) — в просторной
       это no-op, дуга остаётся чистой. В режиме строк не трогаем (шаг уже без наложений). */
    if (n >= 3 && !rowsMode) _relaxBoxes(pos, selfEl, sz, selfSz, nameH, region);

    const szPx = sz.toFixed(1) + "px", selfSzPx = selfSz.toFixed(1) + "px";
    for (const el of els) {
        const p = pos.get(el) || { x: 0, y: 0 };
        el.style.setProperty("--sz", el === selfEl ? selfSzPx : szPx);
        el.style.setProperty("--px", p.x.toFixed(1) + "px");
        el.style.setProperty("--py", p.y.toFixed(1) + "px");
    }
}

/* rAF-дебаунс пере-раскладки. instant=true → без transition-переезда (resize/
   ui-scale/chat): помечаем всех .no-anim на этот кадр. Новые блобы (в
   _pendingPopIns) после раскладки получают pop-in. */
function scheduleParticipantsLayout(instant) {
    if (instant) _layoutInstant = true;
    if (_layoutRaf) return;
    _layoutRaf = requestAnimationFrame(() => {
        _layoutRaf = 0;
        const inst = _layoutInstant; _layoutInstant = false;
        const all = (inst && participantsContainer)
            ? [...participantsContainer.querySelectorAll(".participant")] : [];
        if (inst) all.forEach(e => e.classList.add("no-anim"));
        layoutParticipants();
        if (inst) requestAnimationFrame(() => all.forEach(e => e.classList.remove("no-anim")));
        if (_pendingPopIns.size) {
            const pend = [..._pendingPopIns]; _pendingPopIns.clear();
            requestAnimationFrame(() => {
                for (const el of pend) {
                    if (!el.isConnected) continue;
                    el.classList.remove("no-anim");
                    el.classList.add("pop-in");
                }
            });
        }
    });
}
