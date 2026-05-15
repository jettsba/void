/* Кэш ссылок на DOM-элементы участников — чтобы не ходить в querySelector
   на каждое обновление громкости/аудио-состояния/скринкаста. */
const participantElements = new Map(); // userId → .participant element

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

/* ===== Invite hint ===== */

let _inviteHintEl = null;

function _getOrCreateInviteHintEl() {
    if (_inviteHintEl) return _inviteHintEl;
    _inviteHintEl = document.createElement("div");
    _inviteHintEl.className = "invite-hint";
    _inviteHintEl.setAttribute("role", "status");
    _inviteHintEl.addEventListener("click", () => dismissInviteHint(true));
    const slot = participantsContainer?.closest(".users-slot");
    if (slot) slot.appendChild(_inviteHintEl);
    return _inviteHintEl;
}

function updateInviteHint() {
    if (!isJoined) return;
    try {
        if (localStorage.getItem("void:invite-hint-seen") === "1") return;
    } catch (_) {}
    const count = participantsContainer
        ? [...participantsContainer.querySelectorAll(".participant:not(.pop-out)")].length
        : 0;
    if (count === 1) {
        const el = _getOrCreateInviteHintEl();
        el.textContent = _t("invite.hint");
        el.classList.add("is-visible");
    } else {
        _inviteHintEl?.classList.remove("is-visible");
    }
}

function dismissInviteHint(persist) {
    _inviteHintEl?.classList.remove("is-visible");
    if (persist) {
        try { localStorage.setItem("void:invite-hint-seen", "1"); } catch (_) {}
    }
}

function resetInviteHint() {
    if (_inviteHintEl) {
        _inviteHintEl.classList.remove("is-visible");
        _inviteHintEl.remove();
        _inviteHintEl = null;
    }
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

    const name = document.createElement("div");
    name.classList.add("participant-name");
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

    requestAnimationFrame(() => {
        participant.classList.add("pop-in");
        updateInviteHint();
    });

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

    /* FLIP: запоминаем «First» позиции остальных блобов до того, как
       уходящий начнёт схлопываться. Блобы пересядут после удаления
       уходящего из flex-потока — мы доинвертируем разницу transform'ом. */
    const siblings = [...participantsContainer.querySelectorAll(".participant")]
        .filter(p => p !== el);
    const firstRects = new Map(siblings.map(p => [p, p.getBoundingClientRect()]));

    el.classList.remove("pop-in");
    el.classList.add("pop-out");
    participantElements.delete(userId);

    _onAnimationEndOrFallback(el, () => {
        el.remove();
        animateLayoutFlip(siblings, firstRects);
        updateInviteHint();
    });
}

/**
 * FLIP-перекладка: для каждого блока считаем дельту между прошлыми и текущими
 * координатами, ставим обратный transform без анимации, потом снимаем его в
 * следующем кадре с transition — браузер плавно «доезжает» до новой позиции.
 */
function animateLayoutFlip(elements, firstRects) {
    const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduced) return;

    for (const node of elements) {
        if (!node.isConnected) continue;
        const first = firstRects.get(node);
        const last = node.getBoundingClientRect();
        const dx = first.left - last.left;
        const dy = first.top - last.top;
        if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) continue;

        node.style.transition = "none";
        node.style.transform = `translate(${dx.toFixed(2)}px, ${dy.toFixed(2)}px)`;
        node.classList.add("flip-active");

        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                node.style.transition = "";
                node.style.transform = "";
                const cleanup = () => {
                    node.classList.remove("flip-active");
                    node.removeEventListener("transitionend", cleanup);
                };
                node.addEventListener("transitionend", cleanup);
            });
        });
    }
}
