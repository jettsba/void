/* ========= INIT ========= */

document.addEventListener("DOMContentLoaded", () => {
    init();
});

function init() {
    canvas = document.getElementById("background");
    ctx = canvas.getContext("2d");

    intro = document.getElementById("intro");
    introTitleText = document.getElementById("introTitleText");
    introCursor = document.getElementById("introCursor");
    introInput = document.getElementById("introInput");
    introError = document.getElementById("introError");
    app = document.querySelector(".app");

    controls = document.getElementById("controls");
    micBtn = document.getElementById("micBtn");
    soundBtn = document.getElementById("soundBtn");
    screencastBtn = document.getElementById("screencastBtn");

    scModal = document.getElementById("scModal");
    scNextBtn = document.getElementById("scNextBtn");

    screenOverlay = document.getElementById("screenOverlay");
    screenOverlayVideo = document.getElementById("screenOverlayVideo");

    micBlockedModal      = document.getElementById("micBlockedModal");
    micBlockedCloseBtn   = document.getElementById("micBlockedClose");
    micBlockedBackdrop   = document.getElementById("micBlockedBackdrop");
    micBlockedCloseBtn?.addEventListener("click", closeMicBlockedModal);
    micBlockedBackdrop?.addEventListener("click", closeMicBlockedModal);

    /* M3.3: на iOS/Android путь к разрешениям микрофона разный и совсем не
       похож на десктоп («адресная строка → иконка микрофона» для телефона
       просто не имеет смысла). Подменяем data-i18n ключ на платформенный
       один раз — locale-changed потом сам подхватит правильный перевод. */
    const _micBody = micBlockedModal?.querySelector(".mic-blocked-body");
    if (_micBody) {
        const ua = navigator.userAgent;
        const isIOS = /iPad|iPhone|iPod/.test(ua) && !window.MSStream;
        const isAndroid = /Android/.test(ua);
        if (isIOS) _micBody.setAttribute("data-i18n", "errors.mic-blocked.body.ios");
        else if (isAndroid) _micBody.setAttribute("data-i18n", "errors.mic-blocked.body.android");
        /* settings.js init мог уже сделать applyI18n до нас (порядок
           DOMContentLoaded-листенеров не гарантирован). Принудительный
           re-apply подхватит новый ключ; функция идемпотентна. */
        window.VoidI18n?.applyI18n?.();
    }

    ambientSound = document.getElementById("ambientSound");
    welcomeSound = document.getElementById("welcomeSound");

    joinBtn = document.getElementById("joinBtn");
    createBtn = document.getElementById("createBtn");
    codeInput = document.getElementById("codeInput");
    leaveBtn = document.getElementById("leaveBtn");
    participantsContainer = document.getElementById("participants");
    connDot = document.getElementById("connDot");
    connLabel = document.getElementById("connLabel");

    if (typeof MutationObserver !== "undefined" && participantsContainer) {
        participantsMutationObserver = new MutationObserver(queueSyncRoomPeersDataAttr);
        participantsMutationObserver.observe(participantsContainer, {
            childList: true,
            subtree: false,
            attributes: true,
            attributeFilter: ["class"]
        });
    }
    queueSyncRoomPeersDataAttr();

    roomInfo = document.getElementById("roomInfo");
    roomCodeText = document.getElementById("roomCodeText");
    invitePanel = document.getElementById("invitePanel");
    inviteCopyCode = document.getElementById("inviteCopyCode");
    inviteCopyLink = document.getElementById("inviteCopyLink");
    inviteCodeValue = document.getElementById("inviteCodeValue");

    entryErrorEl = document.getElementById("entryError");
    entryErrorTextEl = document.getElementById("entryErrorText");

    connState = document.getElementById("connState");
    pingPanel = document.getElementById("pingPanel");
    pingPanelList = document.getElementById("pingPanelList");

    connState.addEventListener("click", (e) => {
        if (!isJoined) return;
        e.stopPropagation();
        togglePingPanel();
    });
    connState.addEventListener("keydown", (e) => {
        if (!isJoined) return;
        if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            togglePingPanel();
        }
    });

    /* На тач-устройствах canvas скрыт (см. styles.css «MOBILE — touch fixes»).
       rAF-цикл там бесполезен и сжирает батарею — пропускаем инициализацию. */
    if (!matchMedia("(hover: none) and (pointer: coarse)").matches) {
        sizeCanvas();
        seedBlobs();
        paint();
        document.addEventListener("visibilitychange", () => {
            _canvasPaused = document.hidden;
        });
    }
    generateAndAssignUsername();
    /* Экспортируем «активный» ник в window, чтобы панель настроек могла
       подставить его в поле ввода (settings.js — отдельный IIFE и не видит
       script-scope let-переменные напрямую). Обновляется и при смене ника. */
    window.currentUsername = currentUsername;
    clientId = generateClientId();
    /* Экспортируем для карточки профиля в настройках (короткий UID). */
    window.currentClientId = clientId;

    if (typeof setReconnectHandlers === "function") {
        setReconnectHandlers({
            onSuccess: handleSocketReconnected,
            onFailed: handleConnectionLost
        });
    }

    if (!matchMedia("(hover: none) and (pointer: coarse)").matches) {
        window.addEventListener("resize", sizeCanvas);
        /* visualViewport.resize срабатывает при браузерном zoom (Ctrl+/-) —
           обычный window.resize при zoom не диспатчится надёжно. Без этого
           canvas остаётся в старом масштабе и превращается в прямоугольник
           в верхнем углу до ручного refresh страницы. */
        if (window.visualViewport) {
            window.visualViewport.addEventListener("resize", sizeCanvas);
            /* Тот же zoom меняет и геометрию футер↔панель — пересчитываем fit.
               На тач visualViewport дёргается ещё и виртуальной клавиатурой,
               поэтому этот хук — только для desktop-ветки (не тач). */
            window.visualViewport.addEventListener("resize", scheduleLobbyPanelFit);
        }
    }

    /* === UI auto-scale resize hook ===
       Когда пользователь перетаскивает окно между мониторами разной
       плотности — screen.width меняется → пересчитываем --auto-scale.
       Inline-скрипт в <head> делает это один раз при загрузке, тут
       поддерживаем актуальность в живой сессии. */
    updateAutoScale();
    window.addEventListener("resize", updateAutoScale);

    /* === Lobby panel fit ===
       Футер «отталкивает» панель при низком окне / крупном масштабе. Считаем
       после resize (высота окна), при смене режима entry↔room (меняется
       нижний суб-блок панели) и после загрузки шрифтов (layout-сдвиг). */
    window.addEventListener("resize", scheduleLobbyPanelFit);
    if (typeof MutationObserver !== "undefined") {
        if (app) {
            new MutationObserver(scheduleLobbyPanelFit)
                .observe(app, { attributes: true, attributeFilter: ["data-mode"] });
        }
        /* Слайдер «масштаб интерфейса» (settings.js) меняет --ui-scale на :root
           → rem-геометрия едет, но resize НЕ стреляет. Ловим правку root-стилей. */
        new MutationObserver(scheduleLobbyPanelFit)
            .observe(document.documentElement, { attributes: true, attributeFilter: ["style"] });
    }
    if (document.fonts && document.fonts.ready) {
        document.fonts.ready.then(scheduleLobbyPanelFit);
    }
    scheduleLobbyPanelFit();
    /* M2.2: intro теперь <form id="introForm">. Submit-event универсален
       для любой клавиатуры (включая Android IME, где keydown('Enter')
       приходит как key="Unidentified"). Стрелка-кнопка type="submit"
       внутри формы — её клик тоже триггерит submit, отдельный handler
       на ней не нужен. */
    document.getElementById("introForm")?.addEventListener("submit", handleIntroSubmit);
    introInput.addEventListener("input", tryStartAudio);

    micBtn.addEventListener("click", toggleMic);
    soundBtn.addEventListener("click", toggleSound);
    screencastBtn.addEventListener("click", handleScreencastBtnClick);

    scModal.querySelectorAll(".sc-tiles").forEach(group => {
        group.addEventListener("click", e => {
            const tile = e.target.closest(".sc-tile");
            if (!tile) return;
            group.querySelectorAll(".sc-tile").forEach(t => t.classList.remove("sc-tile--active"));
            tile.classList.add("sc-tile--active");
        });
    });

    scModal.querySelector(".sc-modal-backdrop").addEventListener("click", closeScModal);

    scNextBtn.addEventListener("click", async () => {
        const res = parseInt(scModal.querySelector("#scRes .sc-tile--active")?.dataset.val ?? "1080");
        const fps = parseInt(scModal.querySelector("#scFps .sc-tile--active")?.dataset.val ?? "30");
        /* Тумблер «звук демки» (дефолт вкл). На desktop звук берёт нативный
           loopback, на web — getDisplayMedia. Выключен → демка без звука, без
           трансляции системных звуков стримера. */
        const captureAudio = document.getElementById("scAudio")?.checked ?? true;
        closeScModal();
        try {
            await startScreenShare(res, fps, captureAudio);
            isScreencasting = true;
            broadcastScreencastState(true);
            updateScreencastButton(true);
            updateParticipantScreenState(clientId, true);
            // Звук старта скринкаста — слышат все (self здесь, остальные по WS).
            if (window.VoidSounds) VoidSounds.screencast(true);
        } catch (e) {
            log.debug("rtc", "screen share cancelled", { err: e?.message || String(e) });
        }
    });

    document.getElementById("screenOverlayClose").addEventListener("click", closeScreenOverlay);

    document.getElementById("screenOverlayFullscreen").addEventListener("click", toggleScreenFullscreen);

    /* Кнопка громкости демки: клик по иконке — mute; слайдер (drag) и колёсико —
       уровень. Слайдер кастомный (см. initDemoVolumeSlider в screen-overlay.js). */
    document.getElementById("screenOverlayVolBtn")?.addEventListener("click", toggleDemoMute);
    initDemoVolumeSlider();

    /* Авто-скрытие контролов: любое движение/касание/фокус — показать; наведение
       на контрол — держать открытым (иначе слайдер громкости схлопнется). */
    screenOverlay.addEventListener("mousemove", showScreenControls);
    screenOverlay.addEventListener("pointerdown", showScreenControls);
    screenOverlay.addEventListener("focusin", showScreenControls);
    ["screenOverlayVolume", "screenOverlayFullscreen", "screenOverlayClose"].forEach(id => {
        const el = document.getElementById(id);
        el?.addEventListener("mouseenter", () => setPointerOnScreenControls(true));
        el?.addEventListener("mouseleave", () => setPointerOnScreenControls(false));
    });

    const syncFullscreenClass = () => {
        const fsEl = document.fullscreenElement || document.webkitFullscreenElement;
        screenOverlay.classList.toggle("is-fullscreen", fsEl === screenOverlay);
    };
    document.addEventListener("fullscreenchange", syncFullscreenClass);
    document.addEventListener("webkitfullscreenchange", syncFullscreenClass);

    document.addEventListener("keydown", e => {
        if (e.key === "Escape" && screenOverlay.classList.contains("is-visible")) closeScreenOverlay();
    });

    /* F2 + T1.1: pagehide — единственный надёжный сигнал «вкладка уходит»
       (закрытие, reload, навигация назад на iOS Safari, перевод в bfcache).
       beforeunload блокирует bfcache и часто не стреляет на мобильных.

       Два канала уведомления сервера, оба best-effort:
       1. `navigator.sendBeacon` POST /api/leave-room — спека гарантирует
          доставку одного HTTP-запроса перед смертью документа. Это лечит
          сценарий, когда WS уже в полу-мёртвом состоянии и `socket.send`
          молча no-op'ит (наблюдалось в логах от 2026-05-25: peer-призрак
          друга висел до 60s heartbeat'а).
       2. WS leave-room — старый путь как duplicate-fallback. Серверный
          handleBeaconLeave идемпотентен: если beacon придёт первым,
          последующий handleDisconnect от закрытия WS увидит roomCode=undef
          и выйдет рано. */
    window.addEventListener("pagehide", () => {
        if (!isJoined) return;

        if (typeof navigator !== "undefined"
            && navigator.sendBeacon
            && currentRoomCode
            && clientId) {
            try {
                const payload = JSON.stringify({
                    code: currentRoomCode,
                    userId: clientId
                });
                const blob = new Blob([payload], { type: "application/json" });
                navigator.sendBeacon("/api/leave-room", blob);
            } catch (_) {}
        }

        if (typeof socket !== "undefined" && socket && socket.readyState === 1) {
            try { socket.send(JSON.stringify({ type: "leave-room" })); } catch (_) {}
        }
    });

    document.body.style.opacity = "1";
    setConnectionState("ready");

    createBtn.addEventListener("click", handleCreateClick);
    /* M2.2: entry теперь <form id="entryForm">. Submit-event ловит и
       клик по joinBtn (type="submit"), и Enter в codeInput с любой
       клавиатуры — в т.ч. Android IME, где keydown('Enter') не приходит
       как "Enter". */
    document.getElementById("entryForm")?.addEventListener("submit", (e) => {
        e.preventDefault();
        if (!isJoined) tryJoin();
    });
    leaveBtn.addEventListener("click", () => {
        if (isJoined) leaveRoom();
    });
    codeInput.addEventListener("input", () => {
        codeInput.value = codeInput.value.toUpperCase().replace(/[^A-Z0-9]/g, "");
        codeInput.closest(".entry-code-field")?.classList.toggle("has-value", codeInput.value.length > 0);
        hideEntryError();
    });

    codeInput.closest(".entry-code-field")?.addEventListener("click", () => {
        codeInput.focus();
    });

    roomInfo.addEventListener("click", (e) => {
        e.stopPropagation();
        toggleInvitePanel();
    });
    roomInfo.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            toggleInvitePanel();
        }
        if (e.key === "Escape" && inviteOpen) {
            closeInvitePanel();
            roomInfo.focus();
        }
    });

    inviteCopyCode.addEventListener("click", (e) => {
        e.stopPropagation();
        copyInviteValue(inviteCopyCode, currentRoomCode || "");
    });
    inviteCopyCode.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            copyInviteValue(inviteCopyCode, currentRoomCode || "");
        }
    });
    inviteCopyLink.addEventListener("click", (e) => {
        e.stopPropagation();
        if (!currentRoomCode) return;
        /* В desktop location.origin = tauri.localhost — берём публичный домен
           (VoidApiBase его знает). В вебе VoidApiBase нет → origin корректен. */
        const base = window.VoidApiBase || location.origin;
        const link = `${base}/?room=${encodeURIComponent(currentRoomCode)}`;
        copyInviteValue(inviteCopyLink, link);
    });
    invitePanel.addEventListener("click", (e) => {
        /* Клик по самой панели (между кнопками, по пустому padding'у) не должен
           всплывать до outside-handler и закрывать попап. */
        e.stopPropagation();
    });

    if (typeof initChat === "function") {
        initChat();
    }

    /* M5.1: на мобильном при фокусе на инпут поднимается виртуальная клавиатура
       и заслоняет сам инпут (особенно codeInput и chatInputEl, которые сидят
       в нижней половине экрана). visualViewport не уведомляет нас о поднятии
       клавиатуры синхронно — используем простой recipe: 300мс задержка
       (≈ время анимации клавиатуры) → scrollIntoView в центр.
       Только на тач-устройствах: на десктопе клавиатура виртуальная не
       поднимается, скролл был бы лишним. */
    if (matchMedia("(hover: none) and (pointer: coarse)").matches) {
        const _scrollIntoCenter = (el) => {
            setTimeout(() => {
                try { el.scrollIntoView({ block: "center", behavior: "smooth" }); }
                catch (_) { /* старые браузеры без options-form scrollIntoView */ }
            }, 300);
        };
        [introInput, codeInput, chatInputEl].forEach(el => {
            if (!el) return;
            el.addEventListener("focus", () => _scrollIntoCenter(el));
        });
    }

    /* Кастомный ник из настроек: при сохранении — обновляем currentUsername,
       nicknameMap для самого себя, и self-blob в DOM (addParticipant идемпотентен
       и переписывает имя на месте). Если сидим в комнате — шлём `nickname-update`
       на сервер, чтобы он разослал остальным `nickname-changed` и они тоже
       перерисовали ник без перезахода. */
    document.addEventListener("void:nickname-changed", (e) => {
        const stored = (e?.detail?.nickname || "").trim();
        currentUsername = stored && stored.length > 0 ? stored : generateUsername();
        window.currentUsername = currentUsername;
        if (typeof nicknameMap !== "undefined") {
            nicknameMap.set(clientId, currentUsername);
        }
        if (isJoined) {
            if (typeof addParticipant === "function") {
                addParticipant(clientId, currentUsername);
            }
            if (typeof sendSocket === "function") {
                sendSocket({ type: "nickname-update", nickname: currentUsername });
            }
        }
    });

    /* Invite-link auto-join: ?room=KX7A2 в адресе → подставить код и сразу
       запустить tryJoin(). Адрес чистим ДО входа — F5 после отказа от
       микрофона не должен снова дёргать auto-join (юзер залипнет). Сам
       tryJoin вешаем на void:app-unlocked, чтобы он сработал и при
       включённом intro (после прохождения вопроса), и при отключённом
       (сразу после skipIntroAndShowApp). Невалидный код игнорируем — попадёт
       в обычное лобби, как будто пришли по чистой ссылке. */
    consumeInviteLinkFromUrl();

    if (!INTRO_ENABLED) {
        skipIntroAndShowApp();
    } else if (isIntroUnlockedInBrowser()) {
        skipIntroAndShowApp();
    } else {
        introInput.disabled = true;
        runIntroQuestionTyping();
    }
}

/* ===== Invite popup ===== */

function toggleInvitePanel() {
    if (inviteOpen) closeInvitePanel();
    else openInvitePanel();
}

function openInvitePanel() {
    if (inviteOpen || !invitePanel || !roomInfo) return;
    if (!isJoined || !currentRoomCode) return;

    /* Один попап за раз — закрываем соседний (ping) если он открыт. */
    if (typeof closePingPanel === "function") closePingPanel();

    inviteOpen = true;
    invitePanel.classList.add("is-visible");
    invitePanel.setAttribute("aria-hidden", "false");
    roomInfo.setAttribute("aria-expanded", "true");

    /* Открыли попап — значит пригласительная подсказка свою роль отыграла. */
    if (typeof dismissInviteHint === "function") dismissInviteHint(true);

    inviteOutsideHandler = (e) => {
        if (roomInfo && roomInfo.contains(e.target)) return;
        closeInvitePanel();
    };
    setTimeout(() => {
        document.addEventListener("click", inviteOutsideHandler);
    }, 0);
}

function closeInvitePanel() {
    if (!inviteOpen) return;
    inviteOpen = false;

    if (invitePanel) {
        invitePanel.classList.remove("is-visible");
        invitePanel.setAttribute("aria-hidden", "true");
    }
    if (roomInfo) {
        roomInfo.setAttribute("aria-expanded", "false");
    }

    if (inviteOutsideHandler) {
        document.removeEventListener("click", inviteOutsideHandler);
        inviteOutsideHandler = null;
    }

    /* Все feedback-таймеры сбрасываем — иначе при следующем открытии «скопировано»
       мигнёт сразу, потому что таймер только-только успеет снять класс. */
    for (const [el, id] of inviteCopyFeedbackTimers) {
        clearTimeout(id);
        el.classList.remove("is-copied");
    }
    inviteCopyFeedbackTimers.clear();
}

async function copyInviteValue(rowEl, value) {
    if (!rowEl || !value) return;
    try {
        await navigator.clipboard.writeText(value);
    } catch (e) {
        log.warn("ui", "copy to clipboard failed", { err: e?.message || String(e) });
        return;
    }
    rowEl.classList.add("is-copied");
    const prev = inviteCopyFeedbackTimers.get(rowEl);
    if (prev) clearTimeout(prev);
    inviteCopyFeedbackTimers.set(rowEl, setTimeout(() => {
        rowEl.classList.remove("is-copied");
        inviteCopyFeedbackTimers.delete(rowEl);
    }, 1000));
}

/* ===== Invite-link auto-join =====
   1. Прочитать ?room=...
   2. Если валидный код — почистить URL через replaceState (важно: ДО tryJoin,
      чтобы F5 после mic-deny не повторил auto-join).
   3. Поставить код в codeInput, пометить has-value (визуально как ручной ввод).
   4. Подписаться на void:app-unlocked one-shot и оттуда дёрнуть tryJoin(). */
function consumeInviteLinkFromUrl() {
    let raw = null;
    try {
        raw = new URLSearchParams(location.search).get("room");
    } catch (_) {
        return;
    }
    if (!raw) return;

    /* Чистим URL независимо от валидности кода — мусор не должен висеть. */
    try { history.replaceState({}, "", location.pathname); } catch (_) {}

    const normalized = raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (!ROOM_CODE_RX.test(normalized)) return;

    /* В desktop ссылку обрабатываем напрямую (хотя сюда обычно не попадаем —
       deep-link идёт через Rust-событие). В вебе НЕ авто-входим: показываем
       баннер-приглашение с выбором (открыть в приложении / продолжить в
       браузере). Любой вход — только по клику пользователя. */
    if (window.VoidPlatform === "desktop") {
        joinRoomByCode(normalized);
        return;
    }
    showInviteBanner(normalized);
}

/* Вход в комнату по коду — для desktop deep-link приёмника (js/desktop/deep-link.js).
   Тот же путь, что invite-link: ставим код, дёргаем tryJoin (сразу если приложение
   уже разблокировано, иначе по void:app-unlocked). */
function joinRoomByCode(raw) {
    const normalized = (raw || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (!ROOM_CODE_RX.test(normalized)) return false;
    if (codeInput) {
        codeInput.value = normalized;
        codeInput.closest(".entry-code-field")?.classList.add("has-value");
    }
    const go = () => { if (!isJoined) tryJoin(); };
    if (app && app.classList.contains("visible")) {
        go();
    } else {
        document.addEventListener("void:app-unlocked", go, { once: true });
    }
    return true;
}

/* URL страницы загрузки с учётом языка: сначала явный сохранённый выбор в
   настройках (localStorage void:settings.lang), иначе — язык системы (navigator;
   не ru → en, как в auto-detect лендинга). en → /en/#download, ru → /#download. */
function voidDownloadUrl() {
    let lang = null;
    try {
        const raw = localStorage.getItem("void:settings");
        if (raw) {
            const p = JSON.parse(raw);
            if (p && (p.lang === "ru" || p.lang === "en")) lang = p.lang;
        }
    } catch (_) {}
    if (!lang) {
        const sys = (navigator.language || "").toLowerCase();
        lang = sys.startsWith("ru") ? "ru" : "en";
    }
    return lang === "en"
        ? "https://void-room.space/en/#download"
        : "https://void-room.space/#download";
}

/* Баннер-приглашение (web-only) при заходе по ?room=-ссылке. НЕ авто-входим —
   юзер выбирает: открыть в приложении (void://) или продолжить в браузере.
   Desktop-приём ссылки — js/desktop/deep-link.js + Rust.

   Про фолбэк: надёжно определить из веба, открылось ли приложение, НЕЛЬЗЯ
   (cold-start бывает >2с, вкладка при открытии app остаётся 'visible', а
   focus/blur непостоянны). Поэтому НЕ авто-редиректим на download — после клика
   «открыть в приложении» показываем ручной фолбэк «не открылось? → скачать /
   в браузере». Так в download случайно не уведём того, у кого app открылся. */
function showInviteBanner(code) {
    if (document.getElementById("inviteBanner")) return;
    const tr = (k, fb) => (typeof _t === "function" ? _t(k) : fb);
    const DOWNLOAD_URL = voidDownloadUrl();

    const banner = document.createElement("div");
    banner.id = "inviteBanner";
    banner.className = "invite-banner";
    banner.setAttribute("role", "dialog");
    banner.setAttribute("aria-live", "polite");

    /* Префикс приглашения — lowercase (CSS), код комнаты — отдельный span с
       заглавными (CSS text-transform не должен опускать код в нижний регистр). */
    const text = document.createElement("div");
    text.className = "invite-banner-text";
    const renderInvite = () => {
        const tpl = tr("deeplink.invite", "вас пригласили в комнату #{code}");
        const parts = tpl.split("{code}");
        text.replaceChildren(document.createTextNode(parts[0] || ""));
        if (parts.length > 1) {
            const codeSpan = document.createElement("span");
            codeSpan.className = "invite-banner-code";
            codeSpan.textContent = code;
            text.append(codeSpan, document.createTextNode(parts[1] || ""));
        }
    };
    /* Аккуратная смена текста: fade out → подмена → fade in (класс .is-fading). */
    const swapText = (apply) => {
        text.classList.add("is-fading");
        setTimeout(() => { apply(); text.classList.remove("is-fading"); }, 170);
    };
    renderInvite();

    const actions = document.createElement("div");
    actions.className = "invite-banner-actions";

    /* Утекающая полоса по нижней границе — таймер автозакрытия (14с). Пауза при
       наведении (CSS animation-play-state на :hover), закрытие — по animationend. */
    const timer = document.createElement("div");
    timer.className = "invite-banner-timer";
    const restartTimer = () => {
        timer.style.animation = "none";
        void timer.offsetWidth;   // reflow → перезапуск CSS-анимации
        timer.style.animation = "";
    };

    let dismissed = false;
    const dismiss = () => {
        if (dismissed) return;
        dismissed = true;
        banner.classList.remove("is-visible");
        setTimeout(() => { try { banner.remove(); } catch (_) {} }, 250);
    };
    timer.addEventListener("animationend", dismiss);

    const goWeb = () => {
        dismiss();
        if (typeof joinRoomByCode === "function") joinRoomByCode(code);
    };
    const openDownload = () => {
        const w = window.open(DOWNLOAD_URL, "_blank");
        if (!w) window.location.href = DOWNLOAD_URL;
    };
    const mkBtn = (cls, label, onClick) => {
        const b = document.createElement("button");
        b.type = "button";
        b.className = cls;
        b.textContent = label;
        b.addEventListener("click", onClick);
        return b;
    };

    const openBtn = mkBtn(
        "invite-banner-open",
        tr("deeplink.open-app", "открыть в приложении"),
        () => {
            try { window.location.href = `void://room/${encodeURIComponent(code)}`; }
            catch (_) {}
            /* Фолбэк вместо авто-редиректа (см. шапку функции): плавно меняем текст,
               подменяем кнопки и перезапускаем таймер — дать время на решение. */
            swapText(() => {
                text.textContent = tr("deeplink.fallback", "приложение не открылось?");
            });
            actions.replaceChildren(
                mkBtn("invite-banner-open", tr("deeplink.download", "скачать приложение"), openDownload),
                mkBtn("invite-banner-web", tr("deeplink.continue-web", "продолжить в браузере"), goWeb)
            );
            restartTimer();
        }
    );
    const webBtn = mkBtn(
        "invite-banner-web",
        tr("deeplink.continue-web", "продолжить в браузере"),
        goWeb
    );

    actions.append(openBtn, webBtn);
    banner.append(text, actions, timer);
    document.body.appendChild(banner);
    requestAnimationFrame(() => banner.classList.add("is-visible"));
}

/* === UI auto-scale ===
   Пересчитывает корневой --auto-scale при init() и на window.resize (юзер
   перетащил окно между мониторами разной плотности → screen.width/dpr меняются).

   ⚠ ЕДИНЫЙ источник истины — window.__voidApplyAutoScale из ui-scale-bootstrap.js
   (blocking-<script> в <head>). РАНЬШЕ тут жила СВОЯ копия формулы — только web-
   ветка от screen.width, БЕЗ desktop-ветки по dpr. Она затирала desktop-масштаб,
   выставленный bootstrap'ом, на каждом init/resize → весь desktop-фикс масштаба
   (v0.12.8+) был мёртвым кодом, UI на 2K/4K оставался раздутым. Не дублировать
   формулу здесь — только делегировать. */
function updateAutoScale() {
    if (typeof window.__voidApplyAutoScale === "function") {
        window.__voidApplyAutoScale();
    }
}

/* === Lobby panel fit («футер отталкивает панель») ===
   Панель (.panel-area) сдвинута ВНИЗ от якоря (users-area/ripple) на
   --panel-offset-y. Центр ripple фиксирован — двигать нельзя. Но при сильном
   ui-масштабе / низком окне низ панели (кнопка «создать» в lobby, controls в
   комнате «свисают» ниже собственного бокса из-за absolute-позиционирования)
   наезжает на футер. Тут футер «отталкивает» панель вверх: меряем перекрытие и
   поднимаем панель ровно на него через --panel-squeeze, но НЕ выше её
   статической позиции (offset) — margin к ripple сохраняется, ripple не двигается.

   Читаем геометрию с текущим squeeze и добавляем его обратно, получая позиции
   «при squeeze=0» — так не нужен write-before-read (без layout-трэша). */
let _panelSqueeze = 0;
let _panelFitScheduled = false;

function reflowLobbyPanel() {
    _panelFitScheduled = false;

    const panel = document.querySelector(".panel-area");
    const footer = document.querySelector(".footer-meta");
    const users = document.querySelector(".users-area");
    if (!panel || !footer || !users) return;

    const pr = panel.getBoundingClientRect();

    /* Самый нижний ВИДИМЫЙ суб-блок: tail (lobby) / controls (комната) уходят
       ниже бокса .panel-area. offsetParent === null у скрытых по режиму. */
    let bottom = pr.bottom;
    panel.querySelectorAll(".panel-tail, .panel-controls").forEach((el) => {
        if (el.offsetParent !== null) {
            bottom = Math.max(bottom, el.getBoundingClientRect().bottom);
        }
    });

    const rootPx = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
    const footerGap = rootPx * 0.5;      /* небольшой зазор до строки футера */

    const bottomNatural = bottom + _panelSqueeze;                 /* при squeeze=0 */
    const topNatural = pr.top + _panelSqueeze;                    /* при squeeze=0 */
    const footerTop = footer.getBoundingClientRect().top;

    /* Пол подъёма: панель не должна налезть на «якорь». Держим её ниже самого
       нижнего из: (1) бокса users-area (ripple), сохраняя штатный margin — т.е.
       не выше статической позиции; (2) подписей участников, которые в комнате
       свисают НИЖЕ бокса (position:absolute) и в бокс не входят. marginTop и
       рект приходят из getComputedStyle/rect уже в px — без разбора rem. */
    const usersRect = users.getBoundingClientRect();
    let anchorBottom = usersRect.bottom;
    users.querySelectorAll(".participant-name").forEach((el) => {
        if (el.offsetParent !== null) {
            anchorBottom = Math.max(anchorBottom, el.getBoundingClientRect().bottom);
        }
    });
    const marginTopPx = parseFloat(getComputedStyle(panel).marginTop) || 0;
    const floorTop = Math.max(usersRect.bottom + marginTopPx, anchorBottom + footerGap);
    const maxSqueeze = Math.max(0, topNatural - floorTop);

    const overlap = bottomNatural + footerGap - footerTop;
    const next = Math.min(Math.max(overlap, 0), maxSqueeze);

    if (Math.abs(next - _panelSqueeze) > 0.5) {
        _panelSqueeze = next;
        panel.style.setProperty("--panel-squeeze", next.toFixed(1) + "px");
    }
}

/* rAF-дебаунс: reflow читает и пишет layout — на потоке resize-событий
   схлопываем в один вызов на кадр. */
function scheduleLobbyPanelFit() {
    if (_panelFitScheduled) return;
    _panelFitScheduled = true;
    requestAnimationFrame(reflowLobbyPanel);
}
