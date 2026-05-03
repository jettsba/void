/* ========= CONFIG ========= */

const INTRO_ENABLED = true;
const INTRO_QUESTION = "что есть музыка жизни?";
const INTRO_ACCESS_PASSWORD = ["тишина", "тишина, брат мой"];
const INTRO_WELCOME = "добро пожаловать!";
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

const ENTRY_ERROR_MESSAGES = {
    "room-not-found": "комната не найдена",
    "room-full": "комната заполнена",
    "connection-failed": "не удалось подключиться к серверу",
    "mic-blocked": "нет доступа к микрофону",
    "create-failed": "не удалось создать комнату",
    "code-taken": "код комнаты уже занят — попробуй ещё раз «open a new room»",
    "join-session-invalid": "сессия входа недействительна — попробуй ещё раз",
    "unknown": "что-то пошло не так"
};

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

let controls;
let isMicOn = true;
let isSoundOn = true;

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

function formatRoomCodeLabel(code) {
    const segment =
        code != null && String(code).length > 0 ? String(code) : "XXXXX";
    return `room #${segment}`;
}

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

    window.addEventListener("resize", sizeCanvas);
    introInput.addEventListener("keydown", handleKeyPress);
    introInput.addEventListener("input", tryStartAudio);

    micBtn.addEventListener("click", toggleMic);
    soundBtn.addEventListener("click", toggleSound);

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
    await typeWriter(introTitleText, INTRO_QUESTION, INTRO_QUESTION_TYPE_MS);
    introCursor.classList.add("hidden");
    introInput.disabled = false;
    introQuestionDone = true;
    introInput.focus();
}

async function runIntroWelcomeThenUnlock() {
    introCursor.classList.remove("hidden");
    await typeWriter(introTitleText, INTRO_WELCOME, INTRO_WELCOME_TYPE_MS);
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
    const text = ENTRY_ERROR_MESSAGES[reason] || ENTRY_ERROR_MESSAGES.unknown;
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
    closeAllConnections();
    if (typeof resetSocketConnection === "function") {
        resetSocketConnection();
    }
    currentRoomCode = null;
    setConnectionState("ready");
    showEntryError(reason);
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

    closePingPanel();
    nicknameMap.clear();

    playLeaveSound();

    closeAllConnections();

    sendSocket({
        type: "leave-room",
        userId: clientId,
        room: currentRoomCode
    });

    setTimeout(() => {
        if (socket) socket.close();
    }, 100);

    if (roomCopyFeedbackTimer) {
        clearTimeout(roomCopyFeedbackTimer);
        roomCopyFeedbackTimer = null;
    }
    roomInfo.classList.remove("room-info--copied");

    roomInfo.classList.add("hidden");

    isJoined = false;

    roomCodeText.textContent = formatRoomCodeLabel(null);
    if (codeInput) {
        codeInput.value = "";
        codeInput.closest(".entry-code-field")?.classList.remove("has-value");
    }

    if (app) app.dataset.mode = "entry";

    hideEntryError();

    removeAllParticipants();
    setConnectionState("ready");
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

    participant.appendChild(avatar);
    participant.appendChild(name);

    participantsContainer.appendChild(participant);

    requestAnimationFrame(() => {
        participant.classList.add("pop-in");
    });

    if (userId !== clientId) {
        participant.addEventListener("click", () => {
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

async function handleCreateClick() {

    hideEntryError();

    currentRoomCode = generateRoomCode();

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

    sendSocket({
        type: "create-room",
        code: currentRoomCode,
        userId: clientId,
        nickname: currentUsername
    });
}

function setConnectionState(state) {
    if (!connDot || !connLabel) return;

    connDot.classList.remove("live", "warn");

    if (state === "connected") {
        connDot.classList.add("live");
        connLabel.textContent = "connected";
        return;
    }

    if (state === "error") {
        connDot.classList.add("warn");
        connLabel.textContent = "error";
        return;
    }

    if (state === "connecting") {
        connLabel.textContent = "connecting";
        return;
    }

    connLabel.textContent = "ready";
}

function enterRoomUI() {

    hideEntryError();

    isJoined = true;

    if (app) app.dataset.mode = "room";

    roomInfo.classList.remove("hidden");

    roomCodeText.textContent = formatRoomCodeLabel(currentRoomCode);

    addParticipant(clientId, currentUsername);
    applyAudioState();
    setConnectionState("connected");

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

    el.classList.remove("pop-in");
    el.classList.add("pop-out");

    el.addEventListener("animationend", () => {
        el.remove();
    }, { once: true });
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
        closeVolumeArc(existing);
        return;
    }

    document.querySelectorAll(".volume-arc").forEach(closeVolumeArc);

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
        pingPanelList.innerHTML = `<div class="ping-row ping-row-empty">no peers</div>`;
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
        pingPanelList.innerHTML = `<div class="ping-row ping-row-empty">no peers</div>`;
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