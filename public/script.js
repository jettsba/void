/* ========= CONFIG ========= */

const INTRO_ENABLED = true;
/* Пароль остаётся завязан на «тишину» — это часть лора. Принимаем оба
   варианта (русский и английский эквивалент), даже если интерфейс переключили. */
const INTRO_ACCESS_PASSWORD = ["тишина", "тишина, брат мой", "silence", "silence, my brother"];
const INTRO_QUESTION_TYPE_MS = 95;
const INTRO_WELCOME_TYPE_MS = 75;
const INTRO_ERASE_MS = 5;
const INTRO_SELECT_HOLD_MS = 800;
const INTRO_PAUSE_BEFORE_QUESTION_MS = 800;
const INTRO_PAUSE_AFTER_WELCOME_MS = 520;
/**
 * После первого верного пароля не показывать интро снова в этом браузере.
 * Пишем только localStorage (без сервера, без пароля): значение "1" — флаг «уже проходил».
 * Инкогнито / другой браузер / очистка данных — интро снова.
 */
const INTRO_REMEMBER_UNLOCK = true;
const INTRO_UNLOCK_STORAGE_KEY = "passed";

const ENTRY_ERROR_DISPLAY_MS = 1500;

/* Тонкая обёртка над t(): если settings.js по какой-то причине не загрузился,
   возвращаем сам ключ — не падаем на проде. */
function _t(key, vars) {
    return (typeof window !== "undefined" && window.VoidI18n)
        ? window.VoidI18n.t(key, vars)
        : key;
}

const ENTRY_ERROR_KEYS = new Set([
    "room-not-found", "room-full", "connection-failed", "mic-blocked",
    "create-failed", "code-taken", "join-session-invalid", "connection-lost", "unknown"
]);

const USERNAME_ADJECTIVES = [
    "Silent","Dark","Hidden","Lost","Frozen","Broken","Shadowed","Neon","Crimson","Fading",
    "Restless","Distant","Echoing","Obscure","Ghostly","Cold","Blurred","Glitched","Static","Muted",
    "Hollow","Twisted","Shattered","Unknown","Ancient","Binary","Digital","Quantum","Parallel","Midnight",
    "Dusty","Fragmented","Encrypted","Corrupted","Drifting","Endless","Dim","Invisible","Flickering","Dead",
    "Remote","Subtle","Abstract","Lonely","Shifting","Chaotic","Null","Cosmic","Spectral","Cursed"
];

const USERNAME_NOUNS = [
    "Nova","Orbit","Pulse","Storm","Signal","Drift","Flare","Wave","Abyss","Core",
    "Matrix","Cluster","Sector","Portal","Fragment","Archive","Node","Protocol","Cipher","Spectrum",
    "Server","Module","Vector","Terminal","Resonance","Pixel","Zero","Commit","Process","Channel",
    "Flux","Noise","Loop","Packet","Dimension","Radius","Interface","Kernel","Sequence","Trace",
    "Frame","Shard","Horizon","Code","Anomaly","Beacon","Circuit","Entity","Voidline","Nexus"
];

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
let screenOverlay, screenOverlayVideo, roomToastEl;
let _toastTimer = null;

let ambientSound;
let welcomeSound;
let joinSound;
let leaveSound;
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

let roomInfo;
let roomCodeText;

/**
 * Рисует лейбл кода комнаты в #roomCodeText. Префикс «комната »/«room »
 * остаётся в lowercase-стилистике футера, сам код заворачивается в .room-code-id
 * чтобы его поднять в uppercase через CSS — без буллшита со склейкой строк.
 */
function renderRoomCodeLabel(code) {
    if (!roomCodeText) return;

    if (window.VoidSettings?.getStreamer?.()) {
        roomCodeText.textContent = _t("footer.copy.streamer");
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
}

let _lastConnState = "ready";
let _lastConnOpts = {};

let entryErrorEl;
let entryErrorTextEl;
let entryErrorHideTimer = null;
let roomCopyFeedbackTimer = null;

let connState;
let pingPanel;
let pingPanelList;
let pingPanelOpen = false;
let pingPollTimer = null;
let pingPanelOutsideHandler = null;
const nicknameMap = new Map();

/** Синхронизируем data-peers на #room под ужим логики «ровно в один ряд» при пятерых. */
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
    roomToastEl = document.getElementById("roomToast");

    ambientSound = document.getElementById("ambientSound");
    welcomeSound = document.getElementById("welcomeSound");
    joinSound = document.getElementById("joinSound");
    leaveSound = document.getElementById("leaveSound");

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

    sizeCanvas();
    seedBlobs();
    paint();
    generateAndAssignUsername();
    clientId = generateClientId();

    if (typeof setReconnectHandlers === "function") {
        setReconnectHandlers({
            onSuccess: handleSocketReconnected,
            onFailed: handleConnectionLost
        });
    }

    window.addEventListener("resize", sizeCanvas);
    introInput.addEventListener("keydown", handleKeyPress);
    introInput.addEventListener("input", tryStartAudio);
    document.getElementById("introSubmitBtn")?.addEventListener("click", checkPassword);

    /* Скрытие фоновой анимации при фокусе нужно только на тач-устройствах
       (iOS-артефакты при сдвиге визуального вьюпорта). На десктопе focus
       у codeInput автоматический после skipIntroAndShowApp — класс срабатывал
       бы и сферы пропадали до первого клика. */
    if (matchMedia("(hover: none) and (pointer: coarse)").matches) {
        const markFocus = () => document.body.classList.add("input-focused");
        const clearFocus = () => document.body.classList.remove("input-focused");
        introInput.addEventListener("focus", markFocus);
        introInput.addEventListener("blur", clearFocus);
        codeInput?.addEventListener("focus", markFocus);
        codeInput?.addEventListener("blur", clearFocus);
    }

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
        const captureAudio = document.getElementById("scAudio")?.checked ?? false;
        closeScModal();
        try {
            await startScreenShare(res, fps, captureAudio);
            isScreencasting = true;
            broadcastScreencastState(true);
            updateScreencastButton(true);
            updateParticipantScreenState(clientId, true);
        } catch (e) {
            console.log("Screen share cancelled", e);
        }
    });

    document.getElementById("screenOverlayClose").addEventListener("click", closeScreenOverlay);

    document.getElementById("screenOverlayFullscreen").addEventListener("click", toggleScreenFullscreen);

    const syncFullscreenClass = () => {
        const fsEl = document.fullscreenElement || document.webkitFullscreenElement;
        screenOverlay.classList.toggle("is-fullscreen", fsEl === screenOverlay);
    };
    document.addEventListener("fullscreenchange", syncFullscreenClass);
    document.addEventListener("webkitfullscreenchange", syncFullscreenClass);

    document.addEventListener("keydown", e => {
        if (e.key === "Escape" && screenOverlay.classList.contains("is-visible")) closeScreenOverlay();
    });

    document.body.style.opacity = "1";
    setConnectionState("ready");

    createBtn.addEventListener("click", handleCreateClick);
    joinBtn.addEventListener("click", () => {
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
    codeInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") tryJoin();
    });

    roomInfo.addEventListener("click", async () => {
        try {
            await navigator.clipboard.writeText(currentRoomCode);
            roomInfo.classList.add("room-info--copied");
            if (roomCopyFeedbackTimer) clearTimeout(roomCopyFeedbackTimer);
            roomCopyFeedbackTimer = setTimeout(() => {
                roomInfo.classList.remove("room-info--copied");
                roomCopyFeedbackTimer = null;
            }, 1000);
        } catch (e) {
            console.error("Copy failed", e);
        }
    });

    if (typeof initChat === "function") {
        initChat();
    }

    if (!INTRO_ENABLED) {
        skipIntroAndShowApp();
    } else if (isIntroUnlockedInBrowser()) {
        skipIntroAndShowApp();
    } else {
        introInput.disabled = true;
        runIntroQuestionTyping();
    }
}

function isIntroUnlockedInBrowser() {
    if (!INTRO_REMEMBER_UNLOCK) return false;
    try {
        return localStorage.getItem(INTRO_UNLOCK_STORAGE_KEY) === "1";
    } catch {
        return false;
    }
}

function saveIntroUnlockedInBrowser() {
    if (!INTRO_REMEMBER_UNLOCK) return;
    try {
        localStorage.setItem(INTRO_UNLOCK_STORAGE_KEY, "1");
    } catch {
        /* приватный режим, запрет storage, квота */
    }
}

function skipIntroAndShowApp() {
    intro.style.display = "none";
    app.classList.add("visible");
    hasPlayedWelcome = true;
    introQuestionDone = true;
    setTimeout(() => codeInput?.focus(), 120);
}

function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

async function typeWriter(el, text, delayMs) {
    el.textContent = "";
    for (let i = 0; i < text.length; i++) {
        el.textContent += text[i];
        await sleep(delayMs);
    }
}

async function eraseWriter(el, delayMs) {
    let s = el.textContent;
    while (s.length > 0) {
        s = s.slice(0, -1);
        el.textContent = s;
        await sleep(delayMs);
    }
}

async function runIntroQuestionTyping() {
    introCursor.classList.remove("hidden");
    introTitleText.textContent = "";
    await sleep(INTRO_PAUSE_BEFORE_QUESTION_MS);
    await typeWriter(introTitleText, _t("intro.question"), INTRO_QUESTION_TYPE_MS);
    introCursor.classList.add("hidden");
    introInput.disabled = false;
    introQuestionDone = true;
    introInput.focus();
}

async function runIntroWelcomeThenUnlock() {
    introCursor.classList.remove("hidden");
    await typeWriter(introTitleText, _t("intro.welcome"), INTRO_WELCOME_TYPE_MS);
    introCursor.classList.add("hidden");
    playWelcomeSound();
    await sleep(INTRO_PAUSE_AFTER_WELCOME_MS);
    unlockApp();
}

async function tryJoin() {
    if (isJoined) return;

    hideEntryError();

    const code = (codeInput.value || "").trim().toUpperCase();
    if (code.length !== 5) {
        codeInput.focus();
        return;
    }

    currentRoomCode = code;

    try {
        await initMedia();
    } catch {
        abortJoinAttempt("mic-blocked");
        return;
    }

    try {
        await connectSocket();
    } catch {
        closeAllConnections();
        abortJoinAttempt("connection-failed");
        return;
    }

    sendSocket({
        type: "join-room",
        code,
        userId: clientId,
        nickname: currentUsername
    });
}

function hideEntryError() {
    clearTimeout(entryErrorHideTimer);
    entryErrorHideTimer = null;
    if (entryErrorEl) {
        entryErrorEl.classList.remove("is-visible");
        entryErrorEl.setAttribute("aria-hidden", "true");
    }
}

function showEntryError(reason) {
    const key = ENTRY_ERROR_KEYS.has(reason) ? reason : "unknown";
    const text = _t("errors." + key);
    if (!entryErrorEl || !entryErrorTextEl) return;

    clearTimeout(entryErrorHideTimer);
    entryErrorHideTimer = null;

    entryErrorTextEl.textContent = text;
    entryErrorEl.classList.remove("is-visible");
    entryErrorEl.setAttribute("aria-hidden", "false");

    requestAnimationFrame(() => {
        requestAnimationFrame(() => {
            entryErrorEl.classList.add("is-visible");
        });
    });

    entryErrorHideTimer = setTimeout(() => {
        hideEntryError();
    }, ENTRY_ERROR_DISPLAY_MS);
}

function abortJoinAttempt(reason) {
    // Если уже сидим в комнате (например, при реконнекте сервер ответил join-failed) —
    // надо полностью вернуться в entry-режим, не только закрыть пиров.
    if (isJoined) {
        tearDownRoomState();
    } else {
        closeAllConnections();
        if (typeof resetSocketConnection === "function") {
            resetSocketConnection();
        }
        currentRoomCode = null;
        setConnectionState("ready");
    }
    showEntryError(reason);
}

/**
 * Полный сброс UI и сетевого состояния комнаты. Используется и при штатном leave,
 * и при потере соединения. НЕ отправляет ничего на сервер — это ответственность
 * вызывающего (leaveRoom отсылает leave-room до вызова, handleConnectionLost не отсылает).
 */
function tearDownRoomState() {
    closePingPanel();
    if (typeof resetChatOnLeave === "function") {
        resetChatOnLeave();
    }

    if (isScreencasting) {
        stopScreenShare();
        isScreencasting = false;
    }
    roomScreencasterId = null;
    closeScreenOverlay();
    updateScreencastButton(false);
    screencastBtn.classList.add("control-btn-stub");
    screencastBtn.setAttribute("aria-disabled", "true");
    screencastBtn.title = _t("controls.screencast.soon");

    nicknameMap.clear();
    closeAllConnections();

    if (typeof resetSocketConnection === "function") {
        resetSocketConnection();
    }

    isJoined = false;
    currentRoomCode = null;

    if (roomCopyFeedbackTimer) {
        clearTimeout(roomCopyFeedbackTimer);
        roomCopyFeedbackTimer = null;
    }
    if (roomInfo) {
        roomInfo.classList.remove("room-info--copied");
        roomInfo.classList.add("hidden");
    }

    renderRoomCodeLabel(null);
    if (codeInput) {
        codeInput.value = "";
        codeInput.closest(".entry-code-field")?.classList.remove("has-value");
    }

    if (app) app.dataset.mode = "entry";

    hideEntryError();
    removeAllParticipants();
    setConnectionState("ready");
}

/**
 * Вызывается из socket.js после успешного восстановления WebSocket-соединения.
 * Сервер нас в комнате уже не помнит — старые WebRTC-пиры мертвы по ICE-таймауту.
 * Сносим mesh (но НЕ микрофон), чистим UI участников и заново входим в комнату
 * под тем же clientId. Сервер пришлёт user-list → mesh пересоберётся автоматически.
 */
function handleSocketReconnected() {
    if (!isJoined || !currentRoomCode) return;

    console.log("↻ Socket reconnected, rejoining room", currentRoomCode);

    if (typeof closeRemotePeerConnections === "function") {
        closeRemotePeerConnections();
    }

    // Убираем всех участников из UI кроме себя — они переедут заново через user-list.
    document.querySelectorAll(".participant").forEach(el => {
        if (el.dataset.userId === clientId) return;
        if (el.classList.contains("pop-out")) return;

        const arc = el.querySelector(".volume-arc");
        if (arc) arc._cleanup?.();

        el.classList.remove("pop-in");
        el.classList.add("pop-out");
        el.addEventListener("animationend", () => el.remove(), { once: true });
    });

    // nicknameMap чистим, но себя оставляем — нужен для ping-панели и т.п.
    nicknameMap.clear();
    if (currentUsername) {
        nicknameMap.set(clientId, currentUsername);
    }

    setConnectionState("connecting");

    sendSocket({
        type: "join-room",
        code: currentRoomCode,
        userId: clientId,
        nickname: currentUsername
    });
}

/**
 * Вызывается из socket.js когда все попытки реконнекта исчерпаны.
 * Выкидываем пользователя из комнаты с тостом, не дёргая сервер (его всё равно нет).
 */
function handleConnectionLost() {
    if (!isJoined) return;

    console.log("🛑 Connection lost permanently, leaving room");

    playLeaveSound();
    tearDownRoomState();
    showEntryError("connection-lost");
}

/* ========= AMBIENT — slow drifting blobs ========= */

function sizeCanvas() {
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    canvas.width = window.innerWidth * dpr;
    canvas.height = window.innerHeight * dpr;
    canvas.style.width = window.innerWidth + "px";
    canvas.style.height = window.innerHeight + "px";
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function seedBlobs() {
    blobs = [];
    const count = 5;
    for (let i = 0; i < count; i++) {
        blobs.push({
            x: Math.random() * window.innerWidth,
            y: Math.random() * window.innerHeight,
            r: 220 + Math.random() * 220,
            vx: (Math.random() - 0.5) * 0.04,
            vy: (Math.random() - 0.5) * 0.04,
            a: 0.02 + Math.random() * 0.016
        });
    }
}

function paint() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    ctx.clearRect(0, 0, w, h);

    blobs.forEach(b => {
        b.x += b.vx;
        b.y += b.vy;
        if (b.x < -b.r) b.x = w + b.r;
        if (b.x > w + b.r) b.x = -b.r;
        if (b.y < -b.r) b.y = h + b.r;
        if (b.y > h + b.r) b.y = -b.r;

        const g = ctx.createRadialGradient(b.x, b.y, 0, b.x, b.y, b.r);
        g.addColorStop(0, `rgba(230,230,232,${b.a})`);
        g.addColorStop(1, "rgba(230,230,232,0)");
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2);
        ctx.fill();
    });

    requestAnimationFrame(paint);
}

/* ========= INTRO LOGIC ========= */

function normalizeText(text) {
    return text
        .toLowerCase()
        .replace(/[.,!?;:"'()-]/g, "")
        .trim();
}

function isIntroPasswordAccepted(input) {
    const userValue = normalizeText(input);
    const candidates = Array.isArray(INTRO_ACCESS_PASSWORD)
        ? INTRO_ACCESS_PASSWORD
        : [INTRO_ACCESS_PASSWORD];
    return candidates.some((p) => normalizeText(String(p)) === userValue);
}

function handleKeyPress(e) {
    if (!INTRO_ENABLED) return;
    if (!introQuestionDone) return;
    if (e.key === "Enter") {
        checkPassword();
    }
}

async function checkPassword() {
    if (!INTRO_ENABLED) return;
    if (!introQuestionDone) return;
    if (hasPlayedWelcome || introAuthBusy) return;

    if (!isIntroPasswordAccepted(introInput.value)) {
        showError();
        return;
    }

    saveIntroUnlockedInBrowser();

    introAuthBusy = true;
    introInput.disabled = true;
    hasPlayedWelcome = true;

    introTitleText.classList.add("is-selected");
    await sleep(INTRO_SELECT_HOLD_MS);

    introTitleText.classList.remove("is-selected");
    introCursor.classList.remove("hidden");
    await eraseWriter(introTitleText, INTRO_ERASE_MS);

    await runIntroWelcomeThenUnlock();
}

function showError() {
    introError.classList.add("visible");

    setTimeout(() => {
        introError.classList.remove("visible");
    }, 1200);
}

function unlockApp() {
    intro.classList.add("fade-out");

    intro.addEventListener("transitionend", () => {
        intro.style.display = "none";
        app.classList.add("visible");
    }, { once: true });
}

/* ========= AUDIO ========= */

function tryStartAudio() {
    if (!hasStartedAudio) {
        ambientSound.volume = 0.2;
        ambientSound.play().catch(() => {});
        hasStartedAudio = true;
    }
}

function playWelcomeSound() {
    welcomeSound.currentTime = 0;
    welcomeSound.volume = 0.4;
    welcomeSound.play().catch(() => {});
}

function playJoinSound() {
    joinSound.currentTime = 0;
    joinSound.volume = 0.4;
    joinSound.play().catch(() => {});
}

function playLeaveSound() {
    leaveSound.currentTime = 0;
    leaveSound.volume = 0.4;
    leaveSound.play().catch(() => {});
}

/* ========= CONTROLS ========= */

function toggleMic() {

    if (!isSoundOn) {
        isSoundOn = true;
        isMicOn = true;
    } else {
        isMicOn = !isMicOn;
    }

    applyAudioState();
}

function toggleSound() {

    const wasOff = !isSoundOn;

    isSoundOn = !isSoundOn;

    if (!isSoundOn) {
        isMicOn = false;
    } else {
        isMicOn = true;
    }

    applyAudioState();
}

function updateMicUI() {
    micBtn.classList.toggle("off", !isMicOn);
}

function updateSoundUI() {
    soundBtn.classList.toggle("off", !isSoundOn);
}

function updateSelfVisualState() {

    const el = document.querySelector(
        `.participant[data-user-id="${clientId}"]`
    );

    if (!el) return;

    el.classList.toggle("muted", !isMicOn);
    el.classList.toggle("deaf", !isSoundOn);
}

function applyAudioState() {

    if (localStream) {
        localStream.getAudioTracks().forEach(track => {
            track.enabled = isMicOn && isSoundOn;
        });
    }

    document.querySelectorAll("audio").forEach(audio => {
        audio.muted = !isSoundOn;
    });

    updateMicUI();
    updateSoundUI();

    updateSelfVisualState();

    sendSocket({
        type: "audio-state",
        room: currentRoomCode,
        userId: clientId,
        mic: isMicOn,
        sound: isSoundOn
    });

}

function updateParticipantAudioState(userId, mic, sound) {

    const el = document.querySelector(
        `.participant[data-user-id="${userId}"]`
    );

    if (!el) return;

    el.classList.toggle("muted", !mic);
    el.classList.toggle("deaf", !sound);
}

function removeAllParticipants() {

    const all = document.querySelectorAll(".participant");

    all.forEach(el => {
        const arc = el.querySelector(".volume-arc");
        if (arc) arc._cleanup?.();

        el.classList.remove("pop-in");
        el.classList.add("pop-out");

        el.addEventListener("animationend", () => {
            el.remove();
        }, { once: true });
    });
}

async function leaveRoom() {

    playLeaveSound();

    // Сначала шлём leave-room (даём серверу шанс уведомить остальных),
    // потом ждём 100мс и сносим всё через общий helper. resetSocketConnection
    // внутри tearDownRoomState закроет сокет — повторный socket.close() не нужен.
    sendSocket({
        type: "leave-room",
        userId: clientId,
        room: currentRoomCode
    });

    await new Promise(r => setTimeout(r, 100));

    tearDownRoomState();
}


function addParticipant(userId, nickname) {

    nicknameMap.set(userId, nickname);

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

    requestAnimationFrame(() => {
        participant.classList.add("pop-in");
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

/* ========= USERNAME ========= */

function getRandomWord(array) {
    return array[Math.floor(Math.random() * array.length)];
}

function generateUsername() {
    const first = getRandomWord(USERNAME_ADJECTIVES);
    const second = getRandomWord(USERNAME_NOUNS);
    return `${first} ${second}`;
}

/** Two display lines: word1 / word2 (handles legacy concatenated nicknames). */
function splitNicknameLines(nickname) {
    const s = (nickname || "").trim();
    if (!s) return ["—", "—"];

    const parts = s.split(/\s+/).filter(Boolean);
    if (parts.length >= 2) {
        return [
            parts[0].toLowerCase(),
            parts.slice(1).join(" ").toLowerCase()
        ];
    }

    const one = parts[0];
    const pascal = one.match(/^([A-Z][a-z]+)([A-Z][a-z]+)$/);
    if (pascal) {
        return [pascal[1].toLowerCase(), pascal[2].toLowerCase()];
    }

    return [one.toLowerCase(), ""];
}

function generateAndAssignUsername() {
    currentUsername = generateUsername();
}

function generateRoomCode(length = 5) {
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let result = "";
    for (let i = 0; i < length; i++) {
        result += chars[Math.floor(Math.random() * chars.length)];
    }
    return result;
}

/**
 * Сколько раз молча перегенерировать код при коллизии (server вернёт code-taken).
 * 5 попыток с алфавитом 32^5 ≈ 33M кодов — вероятность исчерпать ничтожна,
 * это просто страховка от вечного цикла на случай бага сервера.
 */
const CREATE_ROOM_MAX_RETRIES = 5;
let createRoomRetryCount = 0;

async function handleCreateClick() {

    hideEntryError();

    try {
        await initMedia();
    } catch {
        abortJoinAttempt("mic-blocked");
        return;
    }

    try {
        await connectSocket();
    } catch {
        closeAllConnections();
        abortJoinAttempt("connection-failed");
        return;
    }

    setConnectionState("connecting");
    createRoomRetryCount = 0;
    sendCreateRoomAttempt();
}

/** Сгенерировать новый код и отправить create-room. Используется и при первой
 *  попытке, и при коллизии (room-created с reason="code-taken"). */
function sendCreateRoomAttempt() {
    currentRoomCode = generateRoomCode();
    sendSocket({
        type: "create-room",
        code: currentRoomCode,
        userId: clientId,
        nickname: currentUsername
    });
}

/** Вызывается из socket.js когда сервер ответил code-taken. Молча пробуем
 *  ещё раз с новым кодом. Если попытки исчерпаны — показываем ошибку. */
function retryCreateRoomAfterCollision() {
    createRoomRetryCount += 1;
    if (createRoomRetryCount >= CREATE_ROOM_MAX_RETRIES) {
        console.warn(`Create-room: ${CREATE_ROOM_MAX_RETRIES} коллизий подряд, сдаёмся`);
        abortJoinAttempt("create-failed");
        return;
    }
    console.log(`↻ Create-room collision, retry ${createRoomRetryCount}/${CREATE_ROOM_MAX_RETRIES}`);
    sendCreateRoomAttempt();
}

function setConnectionState(state, opts = {}) {
    _lastConnState = state;
    _lastConnOpts = opts || {};
    if (!connDot || !connLabel) return;

    connDot.classList.remove("live", "warn", "pulse");

    if (state === "connected") {
        connDot.classList.add("live");
        connLabel.textContent = _t("footer.connected");
        return;
    }

    if (state === "reconnecting") {
        connDot.classList.add("warn", "pulse");
        if (opts.attempt && opts.total) {
            connLabel.textContent = _t("footer.reconnecting.attempt", {
                attempt: opts.attempt, total: opts.total
            });
        } else {
            connLabel.textContent = _t("footer.reconnecting");
        }
        return;
    }

    if (state === "error") {
        connDot.classList.add("warn");
        connLabel.textContent = _t("footer.error");
        return;
    }

    if (state === "connecting") {
        connLabel.textContent = _t("footer.connecting");
        return;
    }

    connLabel.textContent = _t("footer.ready");
}

function enterRoomUI() {

    hideEntryError();

    isJoined = true;

    if (app) app.dataset.mode = "room";

    roomInfo.classList.remove("hidden");

    renderRoomCodeLabel(currentRoomCode);

    addParticipant(clientId, currentUsername);
    applyAudioState();
    setConnectionState("connected");

    screencastBtn.classList.remove("control-btn-stub");
    screencastBtn.title = _t("controls.screencast.share");
    syncScreencastBtnBlocked();

    playJoinSound();
}

function removeParticipant(userId) {

    nicknameMap.delete(userId);

    const el = document.querySelector(
        `.participant[data-user-id="${userId}"]`
    );

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

    el.addEventListener("animationend", () => {
        el.remove();
        animateLayoutFlip(siblings, firstRects);
    }, { once: true });
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

/* ===== Arc volume control =====
   Геометрия в координатах SVG 84×84 (совпадает с .users-area --avatar-size).
   Арка концентрична с аватаром, радиус чуть больше — чтобы "огибала" блоб справа. */
const VOLUME_ARC = {
    cx: 42,
    cy: 42,
    r: 46,
    startDeg: -55,
    endDeg: 55
};

function volumeArcPolar(angleDeg) {
    const rad = angleDeg * Math.PI / 180;
    return {
        x: VOLUME_ARC.cx + VOLUME_ARC.r * Math.cos(rad),
        y: VOLUME_ARC.cy + VOLUME_ARC.r * Math.sin(rad)
    };
}

function volumeArcPath(angleStart, angleEnd) {
    const s = volumeArcPolar(angleStart);
    const e = volumeArcPolar(angleEnd);
    const large = Math.abs(angleEnd - angleStart) > 180 ? 1 : 0;
    const sweep = angleEnd > angleStart ? 1 : 0;
    return `M ${s.x.toFixed(3)} ${s.y.toFixed(3)} A ${VOLUME_ARC.r} ${VOLUME_ARC.r} 0 ${large} ${sweep} ${e.x.toFixed(3)} ${e.y.toFixed(3)}`;
}

function toggleVolumeControl(participant, userId) {

    const existing = participant.querySelector(".volume-arc");
    if (existing) {
        // closeVolumeArc removes .blob-active via the hook above
        closeVolumeArc(existing);
        return;
    }

    // Close any other active blobs first (removes their .blob-active too)
    document.querySelectorAll(".volume-arc").forEach(closeVolumeArc);

    participant.classList.add("blob-active");

    const arc = createVolumeArc(participant, userId);
    participant.appendChild(arc);

    requestAnimationFrame(() => {
        arc.classList.add("is-visible");
    });
}

function closeVolumeArc(arcEl) {
    if (!arcEl || arcEl.dataset.closing === "1") return;
    arcEl.dataset.closing = "1";
    arcEl._cleanup?.();

    // Sync: closing the arc always deactivates the parent blob
    arcEl.closest(".participant")?.classList.remove("blob-active");

    arcEl.classList.remove("is-visible");

    const fallback = setTimeout(() => arcEl.remove(), 500);
    arcEl.addEventListener("transitionend", () => {
        clearTimeout(fallback);
        arcEl.remove();
    }, { once: true });
}

function createVolumeArc(participant, userId) {

    const wrapper = document.createElement("div");
    wrapper.className = "volume-arc";

    const SVGNS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(SVGNS, "svg");
    svg.setAttribute("viewBox", "0 0 84 84");
    svg.setAttribute("aria-hidden", "true");

    const fullPath = volumeArcPath(VOLUME_ARC.startDeg, VOLUME_ARC.endDeg);

    const track = document.createElementNS(SVGNS, "path");
    track.setAttribute("class", "volume-arc-track");
    track.setAttribute("d", fullPath);

    const fill = document.createElementNS(SVGNS, "path");
    fill.setAttribute("class", "volume-arc-fill");
    fill.setAttribute("d", "");

    const handle = document.createElementNS(SVGNS, "circle");
    handle.setAttribute("class", "volume-arc-handle");
    handle.setAttribute("r", "3");

    const hit = document.createElementNS(SVGNS, "path");
    hit.setAttribute("class", "volume-arc-hit");
    hit.setAttribute("d", fullPath);

    svg.appendChild(track);
    svg.appendChild(fill);
    svg.appendChild(handle);
    svg.appendChild(hit);
    wrapper.appendChild(svg);

    const applyVolume = (v) => {
        v = Math.max(0, Math.min(1, v));
        const angle = VOLUME_ARC.endDeg - (VOLUME_ARC.endDeg - VOLUME_ARC.startDeg) * v;

        if (v > 0.001) {
            fill.setAttribute("d", volumeArcPath(VOLUME_ARC.endDeg, angle));
        } else {
            fill.setAttribute("d", "");
        }

        const p = volumeArcPolar(angle);
        handle.setAttribute("cx", p.x.toFixed(3));
        handle.setAttribute("cy", p.y.toFixed(3));

        volumeMap.set(userId, v);
        const audio = audioMap.get(userId);
        if (audio) audio.volume = v;
    };

    applyVolume(volumeMap.get(userId) ?? 1);

    const pointToVolume = (clientX, clientY) => {
        const rect = svg.getBoundingClientRect();
        const sx = (clientX - rect.left) / rect.width * 84;
        const sy = (clientY - rect.top) / rect.height * 84;
        const dx = Math.max(sx - VOLUME_ARC.cx, 0.001);
        const dy = sy - VOLUME_ARC.cy;
        const angleDeg = Math.atan2(dy, dx) * 180 / Math.PI;
        const clamped = Math.max(VOLUME_ARC.startDeg, Math.min(VOLUME_ARC.endDeg, angleDeg));
        return (VOLUME_ARC.endDeg - clamped) / (VOLUME_ARC.endDeg - VOLUME_ARC.startDeg);
    };

    let dragging = false;
    let pointerId = null;

    const onMove = (e) => {
        if (!dragging) return;
        e.preventDefault();
        applyVolume(pointToVolume(e.clientX, e.clientY));
    };

    const onUp = (e) => {
        if (!dragging) return;
        dragging = false;
        wrapper.classList.remove("is-dragging");
        try { hit.releasePointerCapture(pointerId); } catch {}
        pointerId = null;
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onUp);
    };

    const onDown = (e) => {
        e.preventDefault();
        e.stopPropagation();
        dragging = true;
        pointerId = e.pointerId;
        try { hit.setPointerCapture(pointerId); } catch {}
        wrapper.classList.add("is-dragging");
        applyVolume(pointToVolume(e.clientX, e.clientY));
        window.addEventListener("pointermove", onMove);
        window.addEventListener("pointerup", onUp);
        window.addEventListener("pointercancel", onUp);
    };

    hit.addEventListener("pointerdown", onDown);
    wrapper.addEventListener("click", (e) => e.stopPropagation());

    /* Колесо мыши: ±5% за «щелчок». Слушаем на всём блобе (participant),
       а не только на арке — так регулировка работает и при наведении на
       аватар. Нормализуем по знаку deltaY (deltaMode разный в FF/Chrome). */
    const onWheel = (e) => {
        e.preventDefault();
        const dir = e.deltaY < 0 ? 1 : -1;
        const current = volumeMap.get(userId) ?? 1;
        applyVolume(current + dir * 0.05);
    };
    participant.addEventListener("wheel", onWheel, { passive: false });

    const onOutsideClick = (e) => {
        if (dragging) return;
        if (participant.contains(e.target)) return;
        closeVolumeArc(wrapper);
    };

    setTimeout(() => {
        document.addEventListener("click", onOutsideClick);
    }, 0);

    wrapper._cleanup = () => {
        document.removeEventListener("click", onOutsideClick);
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onUp);
        participant.removeEventListener("wheel", onWheel);
    };

    return wrapper;
}

function generateClientId(length = 8) {

    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    let result = "";

    for (let i = 0; i < length; i++) {
        const randomIndex = Math.floor(Math.random() * chars.length);
        result += chars[randomIndex];
    }

    return result;
}

window.onVolumeChange = function(userId, volume) {
    const participant = document.querySelector(`.participant[data-user-id="${userId}"]`);
    if (!participant) return;

    participant.classList.toggle("speaking", volume > 18);
};

/* ===== Ping panel ===== */

function togglePingPanel() {
    if (pingPanelOpen) closePingPanel();
    else openPingPanel();
}

function openPingPanel() {
    if (pingPanelOpen || !pingPanel) return;
    pingPanelOpen = true;
    pingPanel.classList.add("is-visible");
    pingPanel.setAttribute("aria-hidden", "false");

    renderPingPanelSkeleton();
    refreshPingPanel();
    pingPollTimer = setInterval(refreshPingPanel, 1000);

    pingPanelOutsideHandler = (e) => {
        if (connState && connState.contains(e.target)) return;
        closePingPanel();
    };
    setTimeout(() => {
        document.addEventListener("click", pingPanelOutsideHandler);
    }, 0);
}

function closePingPanel() {
    if (!pingPanelOpen) return;
    pingPanelOpen = false;

    if (pingPanel) {
        pingPanel.classList.remove("is-visible");
        pingPanel.setAttribute("aria-hidden", "true");
    }

    if (pingPollTimer) {
        clearInterval(pingPollTimer);
        pingPollTimer = null;
    }

    if (pingPanelOutsideHandler) {
        document.removeEventListener("click", pingPanelOutsideHandler);
        pingPanelOutsideHandler = null;
    }
}

function renderPingPanelSkeleton() {
    if (!pingPanelList) return;

    if (typeof peers === "undefined" || peers.size === 0) {
        pingPanelList.innerHTML = `<div class="ping-row ping-row-empty">${escapeHtml(_t("ping.empty"))}</div>`;
        return;
    }

    const rows = [...peers.keys()].map(userId => {
        const nick = nicknameMap.get(userId) || "—";
        return `<div class="ping-row" data-uid="${escapeAttr(userId)}">
            <span class="ping-name">${escapeHtml(nick)}</span>
            <span class="ping-value ping-na">—</span>
        </div>`;
    });

    pingPanelList.innerHTML = rows.join("");
}

async function refreshPingPanel() {
    if (!pingPanelOpen || !pingPanelList) return;

    if (typeof peers === "undefined" || peers.size === 0) {
        pingPanelList.innerHTML = `<div class="ping-row ping-row-empty">${escapeHtml(_t("ping.empty"))}</div>`;
        return;
    }

    const entries = [];
    for (const userId of peers.keys()) {
        const ping = await getPeerPing(userId);
        entries.push({
            userId,
            nickname: nicknameMap.get(userId) || "—",
            ping
        });
    }

    if (!pingPanelOpen) return;

    entries.sort((a, b) => a.nickname.localeCompare(b.nickname));

    pingPanelList.innerHTML = entries.map(e => {
        const cls = pingClass(e.ping);
        const val = e.ping == null ? "—" : `${e.ping} ms`;
        return `<div class="ping-row" data-uid="${escapeAttr(e.userId)}">
            <span class="ping-name">${escapeHtml(e.nickname)}</span>
            <span class="ping-value ${cls}">${val}</span>
        </div>`;
    }).join("");
}

function pingClass(ms) {
    if (ms == null) return "ping-na";
    if (ms <= 80) return "ping-good";
    if (ms <= 180) return "ping-mid";
    return "ping-bad";
}

function escapeHtml(s) {
    const div = document.createElement("div");
    div.textContent = String(s);
    return div.innerHTML;
}

function escapeAttr(s) {
    return String(s).replace(/[&<>"']/g, c => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;"
    }[c]));
}

/* ========= SCREENCAST ========= */

function handleScreencastBtnClick() {
    if (roomScreencasterId && roomScreencasterId !== clientId) {
        showRoomToast(_t("errors.screencast.busy"));
        return;
    }
    if (isScreencasting) {
        stopScreenShare();
        broadcastScreencastState(false);
        updateScreencastButton(false);
        return;
    }
    openScModal();
}

function openScModal() {
    scModal.setAttribute("aria-hidden", "false");
    scModal.classList.add("is-visible");
}

function closeScModal() {
    scModal.setAttribute("aria-hidden", "true");
    scModal.classList.remove("is-visible");
}

function broadcastScreencastState(isOn) {
    sendSocket({ type: "screencast-state", room: currentRoomCode, userId: clientId, screen: isOn });
    if (!isOn) {
        isScreencasting = false;
        roomScreencasterId = null;
        updateParticipantScreenState(clientId, false);
    } else {
        roomScreencasterId = clientId;
    }
    syncScreencastBtnBlocked();
}

function updateScreencastButton(isOn) {
    screencastBtn.classList.toggle("active", isOn);
    screencastBtn.classList.toggle("sc-btn-blocked", !isOn && !!roomScreencasterId && roomScreencasterId !== clientId);
    if (!screencastBtn.classList.contains("control-btn-stub")) {
        screencastBtn.title = isOn ? _t("controls.screencast.stop") : _t("controls.screencast.share");
    }
}

function updateParticipantScreenState(userId, isSharing) {
    const el = document.querySelector(`.participant[data-user-id="${userId}"]`);
    if (!el) return;
    el.classList.toggle("screensharing", isSharing);
    if (!isSharing && el.classList.contains("blob-active")) {
        const arc = el.querySelector(".volume-arc");
        if (arc) closeVolumeArc(arc); // also removes .blob-active via hook
    }
}

function handleScreencastStateMsg(data) {
    const { userId, screen } = data;
    if (screen) {
        roomScreencasterId = userId;
    } else if (roomScreencasterId === userId) {
        roomScreencasterId = null;
        closeScreenOverlay();
    }
    updateParticipantScreenState(userId, screen);
    syncScreencastBtnBlocked();
}

function syncScreencastBtnBlocked() {
    const blocked = !!roomScreencasterId && roomScreencasterId !== clientId;
    screencastBtn.classList.toggle("sc-btn-blocked", blocked);
    // Hard-disable: prevent any click when someone else is sharing
    if (blocked) {
        screencastBtn.setAttribute("aria-disabled", "true");
        screencastBtn.disabled = true;
    } else if (!screencastBtn.classList.contains("control-btn-stub")) {
        screencastBtn.removeAttribute("aria-disabled");
        screencastBtn.disabled = false;
    }
}

let screenOverlayUserId = null;
let screenOverlayTrackCleanup = null;
let pendingScreenOverlayUserId = null;
let pendingScreenOverlayTimer = null;

/**
 * Вызывается из webrtc.js peer.ontrack после того, как видео-трек экрана
 * приехал и привязан к videoEl. Если пользователь уже кликнул «watch screen»
 * до прибытия трека — открываем оверлей сейчас.
 */
function notifyScreenVideoReady(userId) {
    if (pendingScreenOverlayUserId === userId) {
        pendingScreenOverlayUserId = null;
        clearTimeout(pendingScreenOverlayTimer);
        pendingScreenOverlayTimer = null;
        openScreenOverlay(userId);
    }
}

function openScreenOverlay(userId) {
    const videoEl = videoMap.get(userId);
    if (!videoEl?.srcObject) {
        /* Race: socket «started sharing» прилетел, а WebRTC-трек ещё нет.
           Запоминаем намерение и ждём сигнала из ontrack. Таймаут 5 сек —
           если трек не приедет, чистим pending. */
        pendingScreenOverlayUserId = userId;
        clearTimeout(pendingScreenOverlayTimer);
        pendingScreenOverlayTimer = setTimeout(() => {
            pendingScreenOverlayUserId = null;
            pendingScreenOverlayTimer = null;
        }, 5000);
        return;
    }
    pendingScreenOverlayUserId = null;
    clearTimeout(pendingScreenOverlayTimer);
    pendingScreenOverlayTimer = null;

    const stream = videoEl.srcObject;

    screenOverlayUserId = userId;
    screenOverlayVideo.srcObject = stream;
    screenOverlay.setAttribute("aria-hidden", "false");
    screenOverlay.classList.add("is-visible");

    screenOverlayTrackCleanup?.();
    const videoTrack = stream.getVideoTracks?.()[0];
    const onEnded = () => closeScreenOverlay();
    const onRemoveTrack = e => { if (e.track?.kind === "video") closeScreenOverlay(); };
    videoTrack?.addEventListener("ended", onEnded);
    stream.addEventListener?.("removetrack", onRemoveTrack);
    screenOverlayTrackCleanup = () => {
        videoTrack?.removeEventListener("ended", onEnded);
        stream.removeEventListener?.("removetrack", onRemoveTrack);
    };
}

function closeScreenOverlay() {
    if (!screenOverlay) return;
    if (document.fullscreenElement === screenOverlay) {
        document.exitFullscreen?.();
    } else if (document.webkitFullscreenElement === screenOverlay) {
        document.webkitExitFullscreen?.();
    }
    screenOverlay.classList.remove("is-visible");
    screenOverlay.setAttribute("aria-hidden", "true");
    if (screenOverlayVideo) screenOverlayVideo.srcObject = null;
    screenOverlayTrackCleanup?.();
    screenOverlayTrackCleanup = null;
    screenOverlayUserId = null;
}

function toggleScreenFullscreen() {
    const fsEl = document.fullscreenElement || document.webkitFullscreenElement;
    if (fsEl) {
        (document.exitFullscreen || document.webkitExitFullscreen)?.call(document);
    } else {
        (screenOverlay.requestFullscreen || screenOverlay.webkitRequestFullscreen)?.call(screenOverlay);
    }
}

function handleScreencastRejected() {
    if (isScreencasting) {
        stopScreenShare();
        isScreencasting = false;
        updateScreencastButton(false);
        updateParticipantScreenState(clientId, false);
    }
    showRoomToast(_t("errors.screencast.busy"));
}

function showRoomToast(text) {
    if (!roomToastEl) return;
    roomToastEl.textContent = text;
    roomToastEl.classList.add("is-visible");
    clearTimeout(_toastTimer);
    _toastTimer = setTimeout(() => roomToastEl.classList.remove("is-visible"), 3000);
}

/* ========= LOCALE / STREAMER REACT =========
   После смены языка перерисовываем те куски UI, чьё содержимое не выражено
   через data-i18n: динамические надписи коннекта, код комнаты, title кнопки
   скринкаста, а также текстовое содержимое уже отрисованных watch-кнопок. */
document.addEventListener("void:locale-changed", () => {
    setConnectionState(_lastConnState, _lastConnOpts);
    renderRoomCodeLabel(currentRoomCode);

    if (screencastBtn) {
        if (screencastBtn.classList.contains("control-btn-stub")) {
            screencastBtn.title = _t("controls.screencast.soon");
        } else {
            const isOn = screencastBtn.classList.contains("active");
            screencastBtn.title = isOn ? _t("controls.screencast.stop") : _t("controls.screencast.share");
        }
    }
});

document.addEventListener("void:streamer-changed", () => {
    renderRoomCodeLabel(currentRoomCode);
});