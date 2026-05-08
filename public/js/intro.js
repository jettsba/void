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
    enterLobby();
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
        enterLobby();
    }, { once: true });
}
