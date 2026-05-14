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
    /* Если человек сохранил свой ник в настройках — используем его. Иначе
       генерим случайный adjective+noun, как раньше. Settings подгружается
       первым скриптом, к моменту вызова уже доступен. */
    const stored = (typeof window !== "undefined" && window.VoidSettings)
        ? window.VoidSettings.getNickname()
        : "";
    currentUsername = stored && stored.length > 0 ? stored : generateUsername();
}

function generateRoomCode(length = 5) {
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let result = "";
    for (let i = 0; i < length; i++) {
        result += chars[Math.floor(Math.random() * chars.length)];
    }
    return result;
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
