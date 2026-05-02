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
let entryEl;
let leaveBtn;
let participantsContainer;
let roomElement;
let connDot;
let connLabel;

let isJoined = false;

let usernameElement;
let currentUsername = null;

let currentRoomCode = null;

let clientId = null;

let roomInfo;
let roomCodeText;

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
    entryEl = document.getElementById("entry");
    leaveBtn = document.getElementById("leaveBtn");
    participantsContainer = document.getElementById("participants");
    roomElement = document.getElementById("room");
    connDot = document.getElementById("connDot");
    connLabel = document.getElementById("connLabel");

    roomInfo = document.getElementById("roomInfo");
    roomCodeText = document.getElementById("roomCodeText");

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
    updateRoomState();

    createBtn.addEventListener("click", handleCreateClick);
    joinBtn.addEventListener("click", () => {
        if (!isJoined) tryJoin();
    });
    leaveBtn.addEventListener("click", () => {
        if (isJoined) leaveRoom();
    });
    codeInput.addEventListener("input", () => {
        codeInput.value = codeInput.value.toUpperCase().replace(/[^A-Z0-9]/g, "");
    });
    codeInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") tryJoin();
    });

    roomInfo.addEventListener("click", async () => {
        try {
            await navigator.clipboard.writeText(currentRoomCode);
            roomCodeText.textContent = "copied!";

            setTimeout(() => {
                roomCodeText.textContent = `#${currentRoomCode}`;
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

    const code = (codeInput.value || "").trim().toUpperCase();
    if (code.length !== 5) {
        codeInput.focus();
        return;
    }

    currentRoomCode = code;

    await initMedia();
    await connectSocket();

    sendSocket({
        type: "join-room",
        code,
        userId: clientId,
        nickname: currentUsername
    });
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
        el.classList.remove("pop-in");
        el.classList.add("pop-out");

        el.addEventListener("animationend", () => {
            el.remove();
            updateRoomState();
        }, { once: true });
    });
}

async function leaveRoom() {

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

    roomInfo.classList.add("hidden");

    isJoined = false;

    roomCodeText.textContent = "#XXXXX";
    if (codeInput) codeInput.value = "";

    createBtn.classList.remove("hidden");
    if (entryEl) entryEl.classList.remove("hidden");
    controls.classList.add("hidden");

    removeAllParticipants();
    setConnectionState("ready");
    updateRoomState();
}


function addParticipant(userId, nickname) {

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

    updateRoomState();

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

    currentRoomCode = generateRoomCode();

    await initMedia();
    await connectSocket();
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

    isJoined = true;

    createBtn.classList.add("hidden");
    if (entryEl) entryEl.classList.add("hidden");

    controls.classList.remove("hidden");

    roomInfo.classList.remove("hidden");

    roomCodeText.textContent = `#${currentRoomCode}`;

    addParticipant(clientId, currentUsername);
    applyAudioState();
    setConnectionState("connected");
    updateRoomState();

    playJoinSound();
}

function removeParticipant(userId) {

    const el = document.querySelector(
        `.participant[data-user-id="${userId}"]`
    );

    if (!el || el.classList.contains("pop-out")) return;

    el.classList.remove("pop-in");
    el.classList.add("pop-out");

    el.addEventListener("animationend", () => {
        el.remove();
        updateRoomState();
    }, { once: true });
}

function toggleVolumeControl(participant, userId) {

    const existing = participant.querySelector(".volume-control");
    if (existing) {
        existing.remove();
        return;
    }

    document.querySelectorAll(".volume-control").forEach(el => el.remove());

    const wrapper = document.createElement("div");
    wrapper.classList.add("volume-control");

    const slider = document.createElement("input");
    slider.type = "range";
    slider.min = 0;
    slider.max = 100;

    const saved = volumeMap.get(userId) ?? 1;
    slider.value = saved * 100;

    slider.addEventListener("input", () => {
        const value = slider.value / 100;

        volumeMap.set(userId, value);

        const audio = audioMap.get(userId);
        if (audio) {
            audio.volume = value;
        }
    });

    slider.addEventListener("click", (e) => e.stopPropagation());
    wrapper.addEventListener("click", (e) => e.stopPropagation());

    wrapper.appendChild(slider);
    participant.appendChild(wrapper);
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

function updateRoomState() {
    if (!roomElement || !participantsContainer) return;

    const count = participantsContainer.children.length;
    roomElement.classList.toggle("is-empty", count === 0);
}