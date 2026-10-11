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

/* Случайная строка из алфавита через crypto.getRandomValues (не Math.random:
   его состояние предсказуемо, а код комнаты — ключ входа). Rejection
   sampling: байт ≥ floor(256/n)·n отбрасываем, иначе первые символы алфавита
   выпадали бы чаще (для 32 знаков порог = 256 — перекоса нет вовсе). */
function randomFromAlphabet(chars, length) {
    const limit = 256 - (256 % chars.length);
    let result = "";
    const buf = new Uint8Array(length * 2);
    while (result.length < length) {
        crypto.getRandomValues(buf);
        for (let i = 0; i < buf.length && result.length < length; i++) {
            if (buf[i] < limit) result += chars[buf[i] % chars.length];
        }
    }
    return result;
}

function generateRoomCode(length = 5) {
    // Без I, O, 0, 1 — их путают, когда диктуют код голосом.
    return randomFromAlphabet("ABCDEFGHJKLMNPQRSTUVWXYZ23456789", length);
}

function generateClientId(length = 8) {
    return randomFromAlphabet("ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789", length);
}
