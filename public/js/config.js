/* ========= CONFIG ========= */

const INTRO_ENABLED = false;
const INTRO_ACCESS_PASSWORD = ["тишина", "тишина, брат", "тишина, брат мой", "silence", "silence, brother", "silence, my brother"];
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
const INTRO_UNLOCK_STORAGE_KEY = "void:passed";
/* Старый ключ без префикса — для одноразовой миграции в intro.js. */
const INTRO_UNLOCK_STORAGE_KEY_LEGACY = "passed";

const ENTRY_ERROR_DISPLAY_MS = 1500;

/* Формат кода комнаты — синхронизирован с серверным `ROOM_CODE_REGEX`
   в lib/security.js (`^[A-Z0-9]{4,8}$`). Генератор делает 5 символов,
   но сервер принимает 4-8 — клиент не должен хардкодить длину 5 (B16). */
const ROOM_CODE_RX = /^[A-Z0-9]{4,8}$/;

/* Тонкая обёртка над t(): если settings.js по какой-то причине не загрузился,
   возвращаем сам ключ — не падаем на проде. */
function _t(key, vars) {
    return (typeof window !== "undefined" && window.VoidI18n)
        ? window.VoidI18n.t(key, vars)
        : key;
}

const ENTRY_ERROR_KEYS = new Set([
    "room-not-found", "room-full", "connection-failed", "mic-blocked",
    "create-failed", "code-taken", "join-session-invalid", "connection-lost",
    "rate-limited", "id-collision", "unknown"
]);

const USERNAME_ADJECTIVES = [
    "Silent","Dark","Hidden","Lost","Frozen","Broken","Shadowed","Neon","Crimson","Fading",
    "Restless","Distant","Echoing","Obscure","Ghostly","Cold","Blurred","Glitched","Static","Muted",
    "Hollow","Twisted","Shattered","Unknown","Ancient","Binary","Digital","Quantum","Parallel","Midnight",
    "Dusty","Fragmented","Encrypted","Corrupted","Drifting","Endless","Dim","Invisible","Flickering","Dead",
    "Remote","Subtle","Abstract","Lonely","Shifting","Chaotic","Null","Cosmic","Spectral","Cursed","Legendary"
];

const USERNAME_NOUNS = [
    "Nova","Orbit","Pulse","Storm","Signal","Drift","Flare","Wave","Abyss","Core",
    "Matrix","Cluster","Sector","Portal","Fragment","Archive","Node","Protocol","Cipher","Spectrum",
    "Server","Module","Vector","Terminal","Resonance","Pixel","Zero","Commit","Process","Channel",
    "Flux","Noise","Loop","Packet","Dimension","Radius","Interface","Kernel","Sequence","Trace",
    "Frame","Shard","Horizon","Code","Anomaly","Beacon","Circuit","Entity","Voidline","Nexus","Legend"
];

/* Контрибьюторские ники — отображаются с золотистым сиянием в комнате.
   Не покупается, не настраивается через UI — чистая визуальная пасхалка.
   Сравнение case-insensitive по trim+toLowerCase, поэтому здесь храним
   в нижнем регистре. */
const PREMIUM_NICKNAMES = new Set([
    "casheaterr",
    "nakharaktere",
    "fergjo",
    "michael",
    "aoki",
    "artej",
    "garik"
]);

function isPremiumNickname(nickname) {
    if (typeof nickname !== "string") return false;
    return PREMIUM_NICKNAMES.has(nickname.trim().toLowerCase());
}
