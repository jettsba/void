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

/* Обычная длина ввода кода. Поле поднимает лимит на один знак, когда набранное
   совпало с записью из RESERVED_CODE_STEMS (см. codeInput в app.js). */
const ROOM_CODE_INPUT_LEN = 5;

const RESERVED_CODE_STEMS = [[32, 25, 42, 20, 21]]
    .map(t => t.map(n => String.fromCharCode(n + 48)).join(""));

/* Тонкая обёртка над t(): если settings.js по какой-то причине не загрузился,
   возвращаем сам ключ — не падаем на проде. */
function _t(key, vars) {
    return (typeof window !== "undefined" && window.VoidI18n)
        ? window.VoidI18n.t(key, vars)
        : key;
}

/* Открыть внешнюю ссылку. На десктопе — через нативный opener-плагин
   (js/desktop/opener.js), т.к. голый <a target="_blank">/window.open в WebView2
   не открывает системный браузер. На вебе — обычный новый таб. Общий хелпер:
   используется и в чате (ссылки), и в футере настроек (ссылка авторства). */
function openExternalUrl(url) {
    if (!url) return;
    if (window.VoidDesktop && typeof window.VoidDesktop.openExternal === "function") {
        window.VoidDesktop.openExternal(url).catch((e) => {
            console.warn("[opener] openExternal failed", e);
        });
        return;
    }
    window.open(url, "_blank", "noopener,noreferrer");
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
    "void",
    "casheaterr",
    "nakharaktere",
    "suja",
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

/* ========= ПЛАТФОРМА =========
   Один источник правды для «мы на маке». Нужен в трёх местах и с разными
   целями, поэтому и вынесен: раскладка клавиатуры в настройках (⌘⌥⌃⇧ вместо
   win/alt/ctrl), формулировка ошибки записи экрана (в macOS доступ выдаётся не
   браузеру страницей, а приложению — в системных настройках) и диагностика.
   userAgentData.platform там, где он есть (Chromium), иначе navigator.platform;
   userAgent — последний рубеж. iPadOS представляется маком, и для обеих задач
   это верно. */
const IS_MAC = /mac/i.test(
    (navigator.userAgentData && navigator.userAgentData.platform) ||
    navigator.platform || navigator.userAgent || ""
);
window.VoidIsMac = IS_MAC;

/* ========= WHEEL → «ЩЕЛЧКИ» =========

   Регуляторы громкости (арка участника, слайдеры настроек, громкость демки)
   раньше читали только ЗНАК deltaY и двигали значение на фиксированный шаг за
   КАЖДОЕ событие. На колесе мыши это ровно один щелчок = один шаг. На тачпаде
   macOS (и на Magic Mouse) один короткий свайп двумя пальцами — это десятки
   событий с крошечными дельтами плюс инерционный «выбег» уже после того, как
   пальцы убраны: громкость улетала с 0 на 100 за жест и не поддавалась
   регулировке вовсе.

   Хелпер переводит поток wheel-событий в целое число щелчков со знаком
   (+ вверх / − вниз, 0 = «ещё рано»):

   - дискретное колесо распознаём и пропускаем БЕЗ изменений — поведение на
     мыши остаётся ровно прежним. Признаки: deltaMode ≠ 0 (Firefox шлёт строки),
     wheelDeltaY кратен 120 (классический признак настоящего колеса) или дельта
     сама по себе крупная;
   - непрерывный поток (тачпад) копим в пикселях и отдаём щелчок на каждые
     NOTCH_PX. Пауза между жестами и смена направления сбрасывают накопитель,
     чтобы хвост инерции не перетекал в следующий жест. */
const WHEEL_NOTCH_PX = 100;
const WHEEL_GESTURE_GAP_MS = 220;
const _wheelAccum = new WeakMap();
let _wheelAccumFallback = { sum: 0, at: 0 };

function _wheelIsDiscrete(e) {
    if (e.deltaMode !== 0) return true;                    // строки/страницы = щелчки
    const legacy = e.wheelDeltaY;                          // Chrome/Safari, нет в Firefox
    if (typeof legacy === "number" && legacy !== 0 && Math.abs(legacy) % 120 === 0) return true;
    return Math.abs(e.deltaY) >= WHEEL_NOTCH_PX;
}

/* Направление жеста → направление значения.

   deltaY описывает движение СТРАНИЦЫ, а не пальцев. В macOS включена
   «естественная» прокрутка (дефолт и на трекпаде, и на мыши): жест вниз двигает
   содержимое вниз, то есть прокручивает страницу ВВЕРХ — и приезжает
   отрицательный deltaY, ровно как от колеса, крученного вверх на Windows.
   Регулятор от этого работал наоборот: пальцы вниз — громкость вверх.

   Формально «deltaY<0 = громче» согласовано с прокруткой на обеих платформах,
   но человек соотносит ползунок не с прокруткой, а с рукой. Поэтому на маке
   переворачиваем знак: жест вверх — громче, вниз — тише.

   Плата: у тех, кто отключил естественную прокрутку в системе, будет
   наоборот. Отличить их из браузера нечем — API не существует; ставим на
   дефолт, которым пользуется подавляющее большинство. */
function _wheelGestureSign() {
    return IS_MAC ? -1 : 1;
}

function wheelNotches(e) {
    const dy = e.deltaY;
    if (!dy) return 0;
    const flip = _wheelGestureSign();
    const dir = dy < 0 ? 1 : -1;
    if (_wheelIsDiscrete(e)) {
        /* Накопитель трекпада не должен пережить переход на мышь. */
        const st = _wheelAccum.get(e.currentTarget) || _wheelAccumFallback;
        st.sum = 0;
        st.at = 0;
        return dir * flip;
    }

    const key = e.currentTarget;
    let st = key ? _wheelAccum.get(key) : _wheelAccumFallback;
    if (!st) {
        st = { sum: 0, at: 0 };
        _wheelAccum.set(key, st);
    }
    const now = e.timeStamp || Date.now();
    if (now - st.at > WHEEL_GESTURE_GAP_MS || (st.sum !== 0 && Math.sign(st.sum) !== Math.sign(dy))) {
        st.sum = 0;
    }
    st.at = now;
    st.sum += dy;

    const steps = Math.trunc(st.sum / WHEEL_NOTCH_PX);
    if (steps === 0) return 0;
    st.sum -= steps * WHEEL_NOTCH_PX;
    return -steps * flip;   // deltaY вниз положительный, «громче» — вверх
}

window.VoidWheel = { notches: wheelNotches };
