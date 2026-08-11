/* ========= STATE ========= */

let canvas;
let ctx;
let blobs = [];

let intro;
let introTitleText;
let introCursor;
let introInput;
let introError;
let app;
let introQuestionDone = false;
let introAuthBusy = false;

let micBtn;
let soundBtn;
let screencastBtn;

let controls;
let isMicOn = true;
let isSoundOn = true;
let isScreencasting = false;
let roomScreencasterId = null;

let scModal, scNextBtn;
let screenOverlay, screenOverlayVideo;

let micBlockedModal, micBlockedCloseBtn, micBlockedBackdrop;
let _micBlockedEscHandler = null;

/* Entry-флоу ошибки (mic-blocked / room-not-found / code-taken / ...).
   Живут в собственном DOM-узле над полем ввода кода (v0.9.17 — вернули
   из unified toast-host обратно для контекстной близости к инпуту). */
let entryErrorEl;
let entryErrorTextEl;
let entryErrorHideTimer = null;

let ambientSound;
let welcomeSound;
let hasStartedAudio = false;
let hasPlayedWelcome = false;

let joinBtn;
let createBtn;
let codeInput;
let leaveBtn;
let participantsContainer;
let connDot;
let connLabel;

let isJoined = false;

let usernameElement;
let currentUsername = null;

let currentRoomCode = null;

let clientId = null;

/* Dev-режим: принудительный TURN-relay (iceTransportPolicy:"relay"). Читается
   в createPeer (webrtc.js). Переключается тумблером в dev-настройках через
   window.__voidSetForceRelay — тест relay-пути без реального CG-NAT. */
let forceRelay = false;

/**
 * Один раз на загрузку вкладки шлём серверу "hello" — это открытие приложения
 * (метрика "opens" в админ-статистике). Reconnect/повторные входы в комнату не
 * считаются. Сокет в лобби держим открытым, чтобы сервер видел, сколько людей
 * сейчас вообще на сайте — даже если они ещё не зашли ни в одну комнату.
 */
let _helloSent = false;

/* Учёт визитов. Отдельный ключ, а не поле в `void:settings`: настройки
   перезаписываются целиком в saveState(), и служебное поле там рано или поздно
   затёрлось бы. Формат: { first: "YYYY-MM-DD", last: "YYYY-MM-DD" }, даты в UTC —
   так же, как сервер нарезает дневные бакеты (dayKey в lib/stats.js). */
const VISIT_STORAGE_KEY = "void:visit";
const VISIT_DAY_RX = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Отметить визит и вернуть два флага для `hello`.
 *
 * ГЛАВНОЕ: на сервер не уходит НИКАКОГО идентификатора — только два булевых
 * значения. Браузер сам помнит, здоровался ли он сегодня, поэтому дедупликация
 * происходит здесь, а сервер просто увеличивает счётчики. «Уникальные за день»
 * считаются точно, но сопоставить два визита одного человека сервер не может
 * даже теоретически. Считать по IP или слать стабильный id было бы проще, но
 * это ровно то, чего void не делает.
 *
 *   fresh — сегодня ещё не здоровались (без этого F5 накручивал бы счётчик);
 *   ret   — первый визит был раньше сегодняшнего дня, то есть человек вернулся.
 */
function markVisit() {
    const today = new Date().toISOString().slice(0, 10);

    let rec = null;
    try {
        rec = JSON.parse(localStorage.getItem(VISIT_STORAGE_KEY) || "null");
    } catch (_) {
        // Битая запись — трактуем как первый визит.
    }

    const valid = rec && typeof rec === "object";
    const first = valid && VISIT_DAY_RX.test(rec.first) ? rec.first : today;
    const last = valid && VISIT_DAY_RX.test(rec.last) ? rec.last : "";

    try {
        localStorage.setItem(VISIT_STORAGE_KEY, JSON.stringify({ first, last: today }));
    } catch (_) {
        /* Приватный режим или запрет хранилища: визит каждый раз будет считаться
           новым. Метрику это немного завышает, но ронять вход из-за счётчика
           нельзя. */
    }

    return { fresh: last !== today, ret: first < today };
}

async function enterLobby() {
    if (typeof connectSocket !== "function") return;
    try {
        await connectSocket();
    } catch (_) {
        // Если коннекта нет — не страшно, повторим при попытке join/create.
        return;
    }
    // socket.js на open ставит "connecting" — это правильно когда юзер реально
    // присоединяется к комнате. В лобби это вводит в заблуждение: индикатор
    // должен быть "ready". Возвращаем сами.
    if (!isJoined && typeof setConnectionState === "function") {
        setConnectionState("ready");
    }
    if (!_helloSent) {
        /* B17: `hello` — это сигнал «вкладка открылась». Из payload'а сервер
           читает ТОЛЬКО два булевых флага визита (см. markVisit) — ни userId,
           ни ника, ни какого-либо идентификатора здесь нет и быть не должно. */
        const visit = markVisit();
        sendSocket({ type: "hello", fresh: visit.fresh, ret: visit.ret });
        _helloSent = true;
    }
}

let roomInfo;
let roomCodeText;

/* Invite-попап над футер-кнопкой #roomInfo. Открывается по клику, внутри —
   копирование кода и копирование invite-ссылки. */
let invitePanel;
let inviteCopyCode;
let inviteCopyLink;
let inviteCodeValue;
let inviteOpen = false;
let inviteOutsideHandler = null;
const inviteCopyFeedbackTimers = new Map();

/**
 * Рисует лейбл кода комнаты в #roomCodeText. Префикс «комната »/«room »
 * остаётся в lowercase-стилистике футера, сам код заворачивается в .room-code-id
 * чтобы его поднять в uppercase через CSS — без буллшита со склейкой строк.
 *
 * Параллельно обновляет значение кода в строке инвайт-попапа: оно должно
 * всегда совпадать с тем, что показывает футер. В streamer mode значение в
 * попапе тоже маскируется (заменяем на «—»).
 */
function renderRoomCodeLabel(code) {
    if (!roomCodeText) return;

    if (window.VoidSettings?.getStreamer?.()) {
        roomCodeText.textContent = _t("footer.copy.streamer");
        /* В попапе код маскируем «звёздочками» (как поле пароля). Длину берём
           по реальному коду, чтобы маска выглядела живой; класс is-masked даёт
           центрирование по высоте + межбуквенный зазор (см. panel.css). */
        if (inviteCodeValue) {
            const len = code != null && String(code).length > 0 ? String(code).length : 5;
            inviteCodeValue.textContent = "*".repeat(len);
            inviteCodeValue.classList.add("is-masked");
        }
        return;
    }

    const segment =
        code != null && String(code).length > 0 ? String(code) : "XXXXX";

    /* Шаблон в словаре: «комната #{code}». Подставляем сентинел, чтобы найти
       границу префикс/суффикс — это даёт переводимость без отдельных ключей. */
    const SENTINEL = "";
    const filled = _t("footer.roomCode", { code: SENTINEL });
    const i = filled.indexOf(SENTINEL);
    const prefix = i === -1 ? filled : filled.slice(0, i);
    const suffix = i === -1 ? "" : filled.slice(i + SENTINEL.length);

    roomCodeText.textContent = "";
    if (prefix) roomCodeText.append(document.createTextNode(prefix));
    const codeSpan = document.createElement("span");
    codeSpan.className = "room-code-id";
    codeSpan.textContent = segment;
    roomCodeText.append(codeSpan);
    if (suffix) roomCodeText.append(document.createTextNode(suffix));

    if (inviteCodeValue) {
        inviteCodeValue.textContent = segment;
        inviteCodeValue.classList.remove("is-masked");
    }
}

let _lastConnState = "ready";
let _lastConnOpts = {};

let connState;
let pingPanel;
let pingPanelList;
let pingPanelOpen = false;
let pingPollTimer = null;
let pingPanelOutsideHandler = null;
const nicknameMap = new Map();

/** Синхронизируем data-peers на #room под денсификацию «ровно в один ряд»
    (stage.css/responsive.css ужимают аватар+gap ступенями при 6-10 участниках). */
let participantsMutationObserver = null;
let syncPeersAttrQueued = false;

function syncRoomPeersDataAttr() {
    const roomEl = document.getElementById("room");
    if (!roomEl || !participantsContainer) return;

    const n = [...participantsContainer.querySelectorAll(".participant:not(.pop-out)")].length;
    if (n === 0) delete roomEl.dataset.peers;
    else roomEl.dataset.peers = String(n);
}

function queueSyncRoomPeersDataAttr() {
    if (syncPeersAttrQueued || !participantsContainer) return;
    syncPeersAttrQueued = true;
    requestAnimationFrame(() => {
        syncPeersAttrQueued = false;
        syncRoomPeersDataAttr();
    });
}
