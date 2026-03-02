/* ========= CONFIG ========= */

const PARTICLE_COUNT = 120;
const MAX_SPEED = 0.08;
const ACCESS_PASSWORD = "";

const ICONS = {
    mic: {
        on: "static/icon_mic_on.png",
        off: "static/icon_mic_off.png"
    },
    sound: {
        on: "static/icon_sound_on.png",
        off: "static/icon_sound_off.png"
    }
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
let particles = [];

let intro;
let introInput;
let introError;
let app;

let micBtn;
let soundBtn;
let micIcon;
let soundIcon;

let controls;
let isMicOn = true;
let isSoundOn = true;

let ambientSound;
let welcomeSound;
let hasStartedAudio = false;
let hasPlayedWelcome = false;

let joinBtn;
let createBtn;
let participantsContainer;

let isJoined = false;

let usernameElement;
let currentUsername = null;

let currentRoomCode = null;

let clientId = null;

/* ========= INIT ========= */

init();

function init() {
    canvas = document.getElementById("background");
    ctx = canvas.getContext("2d");

    intro = document.getElementById("intro");
    introInput = document.getElementById("introInput");
    introError = document.getElementById("introError");
    app = document.querySelector(".app");

    controls = document.getElementById("controls");
    micBtn = document.getElementById("micBtn");
    soundBtn = document.getElementById("soundBtn");
    micIcon = document.getElementById("micIcon");
    soundIcon = document.getElementById("soundIcon");

    ambientSound = document.getElementById("ambientSound");
    welcomeSound = document.getElementById("welcomeSound");

    joinBtn = document.getElementById("joinBtn");
    createBtn = document.getElementById("createBtn");
    participantsContainer = document.getElementById("participants");

    usernameElement = document.getElementById("username");

    resizeCanvas();
    createParticles();
    animate();
    generateAndAssignUsername();
    clientId = generateClientId();

    introInput.focus();

    window.addEventListener("resize", resizeCanvas);
    introInput.addEventListener("keydown", handleKeyPress);
    introInput.addEventListener("input", tryStartAudio);

    micBtn.addEventListener("click", toggleMic);
    soundBtn.addEventListener("click", toggleSound);

    document.body.style.opacity = "1";

    createBtn.addEventListener("click", handleCreateClick);
    joinBtn.addEventListener("click", () => {
        if (!isJoined) {
            handleJoinClick();
        } else {
            leaveRoom();
        }
    });

}

/* ========= PARTICLES ========= */

function resizeCanvas() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    createParticles();
}

function createParticles() {
    particles = [];
    for (let i = 0; i < PARTICLE_COUNT; i++) {
        particles.push(createParticle());
    }
}

function createParticle() {
    return {
        x: Math.random() * canvas.width,
        y: Math.random() * canvas.height,
        size: Math.random() * 1.5 + 0.3,
        speedX: (Math.random() - 0.5) * MAX_SPEED,
        speedY: (Math.random() - 0.5) * MAX_SPEED
    };
}

function updateParticles() {
    particles.forEach(p => {
        p.x += p.speedX;
        p.y += p.speedY;

        if (p.x < 0 || p.x > canvas.width || p.y < 0 || p.y > canvas.height) {
            Object.assign(p, createParticle());
        }
    });
}

function drawParticles() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    particles.forEach(p => {
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
        ctx.fillStyle = "rgba(204,204,204,0.35)";
        ctx.fill();
    });
}

function animate() {
    updateParticles();
    drawParticles();
    requestAnimationFrame(animate);
}

/* ========= INTRO LOGIC ========= */

function normalizeText(text) {
    return text
        .toLowerCase()
        .replace(/[.,!?;:"'()-]/g, "")
        .trim();
}

function handleKeyPress(e) {
    if (e.key === "Enter") {
        checkPassword();
    }
}

function checkPassword() {
    if (hasPlayedWelcome) return;

    const userValue = normalizeText(introInput.value);
    const correctValue = normalizeText(ACCESS_PASSWORD);

    if (userValue === correctValue) {
        hasPlayedWelcome = true;
        playWelcomeSound();

        setTimeout(() => {
            unlockApp();
        }, 400);

    } else {
        showError();
    }
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

/* ========= CONTROLS ========= */

function toggleMic() {
    isMicOn = !isMicOn;
    updateMicUI();
}

function toggleSound() {
    isSoundOn = !isSoundOn;
    updateSoundUI();
}

function updateMicUI() {
    micIcon.src = isMicOn ? ICONS.mic.on : ICONS.mic.off;
    micBtn.classList.toggle("off", !isMicOn);
}

function updateSoundUI() {
    soundIcon.src = isSoundOn ? ICONS.sound.on : ICONS.sound.off;
    soundBtn.classList.toggle("off", !isSoundOn);
}

function toggleJoin() {
    if (!isJoined) {
        joinRoom();
    } else {
        leaveRoom();
    }
}

async function joinRoom() {
    await initMedia();
    connectSocket();

    sendSocket({
        type: "join-room",
        code: "VOID",
        userId: clientId,
        nickname: currentUsername
    });

    isJoined = true;

    joinBtn.textContent = "disconnect";

    createBtn.classList.add("hidden");

    controls.classList.remove("hidden");
}

async function leaveRoom() {

    closeAllConnections();

    sendSocket({
        type: "leave-room",
        userId: clientId,
        room: currentRoomCode
    });

    setTimeout(() => {
        if (socket) socket.close();
    }, 100);

    isJoined = false;

    joinBtn.textContent = "connect";

    createBtn.classList.remove("hidden");
    controls.classList.add("hidden");

    const participant = document.querySelector(".participant");

    if (participant) {
        participant.classList.remove("pop-in");
        participant.classList.add("pop-out");

        participant.addEventListener("animationend", () => {
            participantsContainer.innerHTML = "";
        }, { once: true });
    }
}


function addParticipant(userId) {

    const participant = document.createElement("div");
    participant.classList.add("participant");
    participant.dataset.userId = userId;

    const icon = document.createElement("img");
    icon.src = "static/icon_user.png";
    icon.style.width = "40px";

    participant.appendChild(icon);
    participantsContainer.appendChild(participant);

    requestAnimationFrame(() => {
        participant.classList.add("pop-in");
    });
}

/* ========= USERNAME ========= */

function getRandomWord(array) {
    return array[Math.floor(Math.random() * array.length)];
}

function generateUsername() {
    const first = getRandomWord(USERNAME_ADJECTIVES);
    const second = getRandomWord(USERNAME_NOUNS);
    return first + second;
}

function generateAndAssignUsername() {
    currentUsername = generateUsername();
    usernameElement.textContent = currentUsername;
}

function addRemoteParticipant(name) {
    const participant = document.createElement("div");
    participant.classList.add("participant");

    const icon = document.createElement("img");
    icon.src = "static/icon_user.png";
    icon.style.width = "40px";

    participant.appendChild(icon);
    participantsContainer.appendChild(participant);

    requestAnimationFrame(() => {
        participant.classList.add("pop-in");
    });
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

    sendSocket({
        type: "create-room",
        code: currentRoomCode,
        userId: clientId,
        nickname: currentUsername
    });
}

async function handleJoinClick() {

    const code = prompt("Введите код комнаты:");
    if (!code) return;

    currentRoomCode = code.toUpperCase();

    await initMedia();
    await connectSocket();

    sendSocket({
        type: "join-room",
        code: currentRoomCode,
        userId: clientId,
        nickname: currentUsername
    });
}

function enterRoomUI() {

    isJoined = true;

    joinBtn.textContent = "disconnect";

    createBtn.classList.add("hidden");

    controls.classList.remove("hidden");

    addParticipant();
}

function removeParticipant(userId) {

    const el = document.querySelector(
        `.participant[data-user-id="${userId}"]`
    );

    if (!el) return;

    el.classList.remove("pop-in");
    el.classList.add("pop-out");

    el.addEventListener("animationend", () => {
        el.remove();
    }, { once: true });
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