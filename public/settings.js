/* ========= SETTINGS + I18N =========
   Единый модуль: словари, t(), applyI18n(), localStorage state, панель.
   Загружается ПЕРВЫМ скриптом — script.js/chat.js используют t() и слушают
   событие "void:locale-changed" чтобы перерисовать динамические надписи.
*/

(function () {
    "use strict";

    const APP_VERSION = "0.3.2";

    const STORAGE_KEY = "void:settings";
    /**
     * audioInId / audioOutId — deviceId выбранных устройств; пустая строка =
     * «системное по умолчанию» (passes constraints без явного deviceId).
     * audioInGain — множитель для GainNode в audio-графе (0..1.5, 1.0 = unity).
     * audioOutGain — мастер-громкость для всех `<audio>` элементов peers
     *               и системных звуков (0..1.0).
     */
    const DEFAULTS = {
        lang: "ru",
        streamer: false,
        nickname: "",
        audioInId: "",
        audioOutId: "",
        audioInGain: 1.0,
        audioOutGain: 1.0
    };

    const AUDIO_IN_GAIN_MIN = 0;
    const AUDIO_IN_GAIN_MAX = 1.5;
    const AUDIO_OUT_GAIN_MIN = 0;
    const AUDIO_OUT_GAIN_MAX = 1.0;

    /** Лимит длины кастомного ника — синхронизирован с серверным
     *  `NICKNAME_MAX_LEN` в lib/security.js. Управляющие символы
     *  стрипаем (C0/C1), пробелы схлопываем — как делает сервер. */
    const NICKNAME_MAX_LEN = 32;
    const NICKNAME_CONTROL_RX = new RegExp("[\\u0000-\\u001f\\u007f-\\u009f]", "g");

    function sanitizeNickname(raw) {
        if (typeof raw !== "string") return "";
        return raw
            .replace(NICKNAME_CONTROL_RX, "")
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, NICKNAME_MAX_LEN);
    }

    function clampGain(v, min, max) {
        if (typeof v !== "number" || !isFinite(v)) return min;
        return Math.max(min, Math.min(max, v));
    }

    const DICTIONARY = {
        ru: {
            "intro.question": "что есть музыка жизни?",
            "intro.welcome": "добро пожаловать!",

            "header.chat.show": "показать чат",
            "header.chat.close": "скрыть чат",
            "header.chat.label.idle": "чат",
            "header.chat.label.open": "закрыть",
            "header.settings": "настройки",

            "room.empty": "тут пока никого",

            "entry.placeholder": "код комнаты",
            "entry.join": "войти",
            "entry.or": "или",
            "entry.create": "создать комнату →",

            "controls.mute": "выключить микрофон",
            "controls.deaf": "выключить звук",
            "controls.screencast.soon": "демонстрация (скоро)",
            "controls.screencast.share": "показать экран",
            "controls.screencast.stop": "остановить показ",
            "controls.leave": "выйти",

            "chat.title": "чат",
            "chat.empty": "сообщений ещё нет",
            "chat.placeholder": "сообщение…",
            "chat.attach": "прикрепить",
            "chat.attach.full": "прикрепить файл",
            "chat.send": "отправить",
            "chat.jump": "к новым",
            "chat.drop": "отпусти, чтобы прикрепить",
            "chat.lightbox": "просмотр изображения",
            "chat.close": "закрыть",
            "chat.you": "ты",
            "chat.send.failed": "не удалось отправить файл",
            "chat.file.tooBig": "файл больше {mb} мб",
            "chat.download": "скачать",
            "chat.remove": "убрать",
            "chat.image": "изображение",
            "chat.file": "файл",

            "footer.ready": "готово",
            "footer.connected": "подключено",
            "footer.connecting": "подключение",
            "footer.reconnecting": "переподключение",
            "footer.reconnecting.attempt": "переподключение {attempt}/{total}",
            "footer.error": "ошибка",
            "footer.copy.title": "копировать код",
            "footer.copy.streamer": "скопировать код комнаты",
            "footer.copied": "скопировано!",
            "footer.roomCode": "комната #{code}",

            "ping.empty": "нет участников",

            "errors.room-not-found": "комната не найдена",
            "errors.room-full": "комната заполнена",
            "errors.connection-failed": "не удалось подключиться к серверу",
            "errors.mic-blocked": "нет доступа к микрофону",
            "errors.mic-blocked.title": "микрофон заблокирован",
            "errors.mic-blocked.body": "в адресной строке слева нажми на иконку микрофона и разреши доступ. потом обнови страницу.",
            "errors.mic-blocked.cta": "понятно",
            "errors.create-failed": "не удалось создать комнату",
            "errors.code-taken": "не удалось подобрать свободный код — попробуй ещё раз",
            "errors.join-session-invalid": "сессия недействительна — попробуй ещё раз",
            "errors.connection-lost": "соединение потеряно",
            "errors.rate-limited": "слишком много попыток — подожди немного",
            "errors.id-collision": "сессия с этим id уже активна — обнови страницу",
            "errors.unknown": "что-то пошло не так",
            "errors.screencast.busy": "демонстрация уже идёт в этой комнате",

            "screencast.watch": "смотреть",
            "screencast.screen": "экран",
            "screencast.title": "демонстрация экрана",
            "screencast.resolution": "разрешение",
            "screencast.fps": "частота кадров",
            "screencast.audio": "звук экрана",
            "screencast.next": "далее →",
            "screencast.fullscreen": "на весь экран",

            "settings.title": "настройки",
            "settings.lang": "язык интерфейса",
            "settings.streamer": "режим стримера",
            "settings.streamer.hint": "скрывает код комнаты в футере",
            "settings.nick": "имя",
            "settings.nick.hint": "оставь пустым — будет случайное на каждый вход",
            "settings.nick.placeholder": "твоё имя",
            "settings.nick.save": "сохранить",
            "settings.nick.saved": "сохранено",

            "settings.audio": "звук",
            "settings.audio.mic": "микрофон",
            "settings.audio.speakers": "динамики",
            "settings.audio.default": "системное по умолчанию",
            "settings.audio.gainIn": "усиление",
            "settings.audio.gainOut": "громкость",
            "settings.audio.test": "тест",
            "settings.audio.permHint": "разреши доступ к микрофону, чтобы видеть имена устройств",
            "settings.audio.noSinkId": "выбор колонок недоступен в этом браузере — звук идёт в системное устройство по умолчанию",
            "settings.audio.applyOnRejoin": "новый микрофон подключится при следующем входе в комнату"
        },
        en: {
            "intro.question": "what is the music of life?",
            "intro.welcome": "welcome!",

            "header.chat.show": "show chat",
            "header.chat.close": "close chat",
            "header.chat.label.idle": "chat",
            "header.chat.label.open": "close",
            "header.settings": "settings",

            "room.empty": "no one here yet",

            "entry.placeholder": "enter code",
            "entry.join": "join",
            "entry.or": "or",
            "entry.create": "open a new room →",

            "controls.mute": "mute",
            "controls.deaf": "deaf",
            "controls.screencast.soon": "screencast (soon)",
            "controls.screencast.share": "share screen",
            "controls.screencast.stop": "stop sharing",
            "controls.leave": "leave",

            "chat.title": "chat",
            "chat.empty": "no messages yet",
            "chat.placeholder": "message…",
            "chat.attach": "attach",
            "chat.attach.full": "attach file",
            "chat.send": "send",
            "chat.jump": "jump to newest",
            "chat.drop": "drop to attach",
            "chat.lightbox": "image preview",
            "chat.close": "close",
            "chat.you": "you",
            "chat.send.failed": "failed to send file",
            "chat.file.tooBig": "file larger than {mb} mb",
            "chat.download": "download",
            "chat.remove": "remove",
            "chat.image": "image",
            "chat.file": "file",

            "footer.ready": "ready",
            "footer.connected": "connected",
            "footer.connecting": "connecting",
            "footer.reconnecting": "reconnecting",
            "footer.reconnecting.attempt": "reconnecting {attempt}/{total}",
            "footer.error": "error",
            "footer.copy.title": "copy code",
            "footer.copy.streamer": "copy room code",
            "footer.copied": "copied!",
            "footer.roomCode": "room #{code}",

            "ping.empty": "no peers",

            "errors.room-not-found": "room not found",
            "errors.room-full": "room is full",
            "errors.connection-failed": "could not connect to server",
            "errors.mic-blocked": "microphone blocked",
            "errors.mic-blocked.title": "microphone is blocked",
            "errors.mic-blocked.body": "click the mic icon in the address bar and allow access, then reload the page.",
            "errors.mic-blocked.cta": "got it",
            "errors.create-failed": "could not create room",
            "errors.code-taken": "could not pick a free code — try again",
            "errors.join-session-invalid": "session invalid — try again",
            "errors.connection-lost": "connection lost",
            "errors.rate-limited": "too many attempts — wait a bit",
            "errors.id-collision": "session id is already active — refresh the page",
            "errors.unknown": "something went wrong",
            "errors.screencast.busy": "screen share is already active in this room",

            "screencast.watch": "watch",
            "screencast.screen": "screen",
            "screencast.title": "screen share",
            "screencast.resolution": "resolution",
            "screencast.fps": "frame rate",
            "screencast.audio": "screen audio",
            "screencast.next": "next →",
            "screencast.fullscreen": "fullscreen",

            "settings.title": "settings",
            "settings.lang": "interface language",
            "settings.streamer": "streamer mode",
            "settings.streamer.hint": "hides room code in the footer",
            "settings.nick": "name",
            "settings.nick.hint": "leave empty — a random one each visit",
            "settings.nick.placeholder": "your name",
            "settings.nick.save": "save",
            "settings.nick.saved": "saved",

            "settings.audio": "audio",
            "settings.audio.mic": "microphone",
            "settings.audio.speakers": "speakers",
            "settings.audio.default": "system default",
            "settings.audio.gainIn": "gain",
            "settings.audio.gainOut": "volume",
            "settings.audio.test": "test",
            "settings.audio.permHint": "grant microphone access to see device names",
            "settings.audio.noSinkId": "speaker selection isn't supported in this browser — using system default",
            "settings.audio.applyOnRejoin": "the new microphone will be picked up the next time you join a room"
        }
    };

    /* ===== state ===== */

    let state = { ...DEFAULTS };

    function loadState() {
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            if (!raw) return;
            const parsed = JSON.parse(raw);
            if (parsed && typeof parsed === "object") {
                if (parsed.lang === "ru" || parsed.lang === "en") state.lang = parsed.lang;
                if (typeof parsed.streamer === "boolean") state.streamer = parsed.streamer;
                if (typeof parsed.nickname === "string") {
                    /* Пропускаем через тот же sanitize, что и при save — на случай
                       если в storage попало что-то из старой/чужой версии. */
                    state.nickname = sanitizeNickname(parsed.nickname);
                }
                if (typeof parsed.audioInId === "string") state.audioInId = parsed.audioInId.slice(0, 200);
                if (typeof parsed.audioOutId === "string") state.audioOutId = parsed.audioOutId.slice(0, 200);
                if (typeof parsed.audioInGain === "number" && isFinite(parsed.audioInGain)) {
                    state.audioInGain = clampGain(parsed.audioInGain, AUDIO_IN_GAIN_MIN, AUDIO_IN_GAIN_MAX);
                }
                if (typeof parsed.audioOutGain === "number" && isFinite(parsed.audioOutGain)) {
                    state.audioOutGain = clampGain(parsed.audioOutGain, AUDIO_OUT_GAIN_MIN, AUDIO_OUT_GAIN_MAX);
                }
            }
        } catch {
            /* приватный режим, мусор в storage — игнорим, остаются дефолты */
        }
    }

    function saveState() {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
        } catch {
            /* квота, приватный режим — настройка проживёт сессию */
        }
    }

    /* ===== translation ===== */

    function t(key, vars) {
        const dict = DICTIONARY[state.lang] || DICTIONARY.ru;
        let v = dict[key];
        if (v == null) v = (DICTIONARY.ru[key] != null ? DICTIONARY.ru[key] : key);
        if (vars) {
            v = v.replace(/\{(\w+)\}/g, (_, name) =>
                vars[name] != null ? String(vars[name]) : `{${name}}`
            );
        }
        return v;
    }

    /* ===== DOM application =====
       Поддерживаемые атрибуты:
         data-i18n="key"                       → textContent
         data-i18n-attr="title:keyA;aria:keyB" → set множественных атрибутов
         data-i18n-placeholder="key"           → placeholder (input/textarea)
    */
    function applyI18n(root) {
        const scope = root || document;

        scope.querySelectorAll("[data-i18n]").forEach(el => {
            const key = el.getAttribute("data-i18n");
            if (!key) return;
            el.textContent = t(key);
        });

        scope.querySelectorAll("[data-i18n-placeholder]").forEach(el => {
            const key = el.getAttribute("data-i18n-placeholder");
            if (!key) return;
            el.setAttribute("placeholder", t(key));
        });

        scope.querySelectorAll("[data-i18n-attr]").forEach(el => {
            const spec = el.getAttribute("data-i18n-attr");
            if (!spec) return;
            spec.split(";").forEach(pair => {
                const [attrRaw, keyRaw] = pair.split(":");
                if (!attrRaw || !keyRaw) return;
                const attr = attrRaw.trim();
                const key = keyRaw.trim();
                if (!attr || !key) return;
                el.setAttribute(attr, t(key));
            });
        });
    }

    /* ===== public state mutators ===== */

    function setLang(lang) {
        if (lang !== "ru" && lang !== "en") return;
        if (state.lang === lang) return;
        state.lang = lang;
        document.documentElement.lang = lang;
        saveState();
        applyI18n();
        applyLangToggleUI();
        document.dispatchEvent(new CustomEvent("void:locale-changed", { detail: { lang } }));
    }

    function setStreamer(on) {
        const next = !!on;
        if (state.streamer === next) return;
        state.streamer = next;
        saveState();
        applyStreamerAttr();
        applyStreamerToggleUI();
        document.dispatchEvent(new CustomEvent("void:streamer-changed", { detail: { on: next } }));
    }

    function getLang() { return state.lang; }
    function getStreamer() { return state.streamer; }
    function getNickname() { return state.nickname || ""; }
    function getAudioInId() { return state.audioInId || ""; }
    function getAudioOutId() { return state.audioOutId || ""; }
    function getAudioInGain() { return state.audioInGain; }
    function getAudioOutGain() { return state.audioOutGain; }

    function setAudioInId(id) {
        const next = typeof id === "string" ? id.slice(0, 200) : "";
        if (state.audioInId === next) return;
        state.audioInId = next;
        saveState();
        document.dispatchEvent(new CustomEvent("void:audio-in-device-changed", { detail: { deviceId: next } }));
    }

    function setAudioOutId(id) {
        const next = typeof id === "string" ? id.slice(0, 200) : "";
        if (state.audioOutId === next) return;
        state.audioOutId = next;
        saveState();
        document.dispatchEvent(new CustomEvent("void:audio-out-device-changed", { detail: { deviceId: next } }));
    }

    function setAudioInGain(v) {
        const next = clampGain(v, AUDIO_IN_GAIN_MIN, AUDIO_IN_GAIN_MAX);
        if (state.audioInGain === next) return;
        state.audioInGain = next;
        saveState();
        document.dispatchEvent(new CustomEvent("void:audio-in-gain-changed", { detail: { gain: next } }));
    }

    function setAudioOutGain(v) {
        const next = clampGain(v, AUDIO_OUT_GAIN_MIN, AUDIO_OUT_GAIN_MAX);
        if (state.audioOutGain === next) return;
        state.audioOutGain = next;
        saveState();
        document.dispatchEvent(new CustomEvent("void:audio-out-gain-changed", { detail: { gain: next } }));
    }

    /**
     * Сеттер кастомного ника. Пустая строка ⇒ «сбросить, пусть генерируется».
     * Возвращает фактически сохранённое значение (после sanitize).
     * Слушатели: addParticipant/nicknameMap/currentUsername в app.js.
     */
    function setNickname(raw) {
        const next = sanitizeNickname(raw);
        if (state.nickname === next) return next;
        state.nickname = next;
        saveState();
        document.dispatchEvent(new CustomEvent("void:nickname-changed", { detail: { nickname: next } }));
        return next;
    }

    function applyStreamerAttr() {
        const app = document.getElementById("app");
        if (!app) return;
        if (state.streamer) app.dataset.streamer = "on";
        else delete app.dataset.streamer;
    }

    /* ===== panel UI ===== */

    let panelEl, scrimEl, gearBtn, langSegEl, streamerInputEl;
    let nickFormEl, nickInputEl, nickSavedEl, nickSavedTimer = null;
    let micDropdown, spkDropdown,
        micGainEl, spkGainEl,
        micGainValueEl, spkGainValueEl,
        micMeterFillEl, spkTestBtnEl,
        audioHintEl;
    /* Изолированный preview-stream/analyser для уровня микрофона в панели.
       Включается на open, гасится на close. Не трогает основной localStream. */
    let previewStream = null;
    let previewCtx = null;
    let previewAnalyser = null;
    let previewRaf = null;
    let previewLastDeviceId = null;

    function buildPanel() {
        if (document.getElementById("settingsPanel")) return;

        scrimEl = document.createElement("div");
        scrimEl.className = "settings-scrim";
        scrimEl.id = "settingsScrim";
        scrimEl.setAttribute("aria-hidden", "true");

        panelEl = document.createElement("aside");
        panelEl.className = "settings-panel";
        panelEl.id = "settingsPanel";
        panelEl.setAttribute("aria-hidden", "true");
        panelEl.setAttribute("role", "dialog");
        panelEl.setAttribute("aria-label", t("settings.title"));
        panelEl.innerHTML = `
            <div class="settings-panel-inner">
                <header class="settings-header">
                    <span class="settings-title" data-i18n="settings.title">${t("settings.title")}</span>
                    <button type="button" class="settings-close" id="settingsClose" aria-label="${t("chat.close")}" data-i18n-attr="aria-label:chat.close">
                        <svg viewBox="0 0 24 24" aria-hidden="true">
                            <path d="M6 6l12 12"/>
                            <path d="M18 6L6 18"/>
                        </svg>
                    </button>
                </header>

                <div class="settings-row settings-row--stack">
                    <div class="settings-row-text">
                        <span class="settings-row-label" data-i18n="settings.nick">${t("settings.nick")}</span>
                    </div>
                    <form class="settings-nick-form" id="settingsNickForm" autocomplete="off">
                        <input
                            type="text"
                            id="settingsNickInput"
                            class="settings-nick-input"
                            maxlength="${NICKNAME_MAX_LEN}"
                            data-i18n-placeholder="settings.nick.placeholder"
                            placeholder="${t("settings.nick.placeholder")}"
                            spellcheck="false"
                        />
                        <button
                            type="submit"
                            class="settings-nick-save"
                            id="settingsNickSave"
                            title="${t("settings.nick.save")}"
                            data-i18n-attr="title:settings.nick.save;aria-label:settings.nick.save"
                            aria-label="${t("settings.nick.save")}"
                        >
                            <svg viewBox="0 0 24 24" aria-hidden="true">
                                <path d="M5 12l5 5 9-11"/>
                            </svg>
                        </button>
                        <span class="settings-nick-saved" id="settingsNickSaved" aria-live="polite" data-i18n="settings.nick.saved">${t("settings.nick.saved")}</span>
                    </form>
                    <span class="settings-row-hint settings-row-hint--below" data-i18n="settings.nick.hint">${t("settings.nick.hint")}</span>
                </div>

                <div class="settings-section">
                    <span class="settings-section-title" data-i18n="settings.audio">${t("settings.audio")}</span>

                    <div class="settings-audio-block">
                        <div class="settings-audio-head">
                            <span class="settings-audio-label" data-i18n="settings.audio.mic">${t("settings.audio.mic")}</span>
                            <div class="settings-mic-meter" id="settingsMicMeter" aria-hidden="true">
                                <div class="settings-mic-meter-fill" id="settingsMicMeterFill"></div>
                            </div>
                        </div>
                        <div class="settings-dropdown" id="settingsMicDropdown">
                            <button type="button" class="settings-dropdown-trigger"
                                aria-haspopup="listbox" aria-expanded="false"
                                aria-label="${t("settings.audio.mic")}">
                                <span class="settings-dropdown-current" data-default-label="settings.audio.default">${t("settings.audio.default")}</span>
                                <svg class="settings-dropdown-chevron" viewBox="0 0 24 24" aria-hidden="true">
                                    <path d="M6 9l6 6 6-6"/>
                                </svg>
                            </button>
                            <ul class="settings-dropdown-menu" role="listbox" aria-hidden="true"></ul>
                        </div>
                        <div class="settings-slider-row">
                            <span class="settings-slider-label" data-i18n="settings.audio.gainIn">${t("settings.audio.gainIn")}</span>
                            <input
                                type="range"
                                id="settingsMicGain"
                                class="settings-slider"
                                min="0" max="150" step="1"
                                aria-label="${t("settings.audio.gainIn")}"
                            />
                            <span class="settings-slider-value" id="settingsMicGainValue">100%</span>
                        </div>
                    </div>

                    <div class="settings-audio-block">
                        <div class="settings-audio-head">
                            <span class="settings-audio-label" data-i18n="settings.audio.speakers">${t("settings.audio.speakers")}</span>
                            <button type="button" id="settingsSpkTest" class="settings-test-btn"
                                title="${t("settings.audio.test")}"
                                aria-label="${t("settings.audio.test")}"
                                data-i18n-attr="title:settings.audio.test;aria-label:settings.audio.test">
                                <svg viewBox="0 0 24 24" aria-hidden="true">
                                    <path d="M7 5l12 7-12 7V5z"/>
                                </svg>
                            </button>
                        </div>
                        <div class="settings-dropdown" id="settingsSpkDropdown">
                            <button type="button" class="settings-dropdown-trigger"
                                aria-haspopup="listbox" aria-expanded="false"
                                aria-label="${t("settings.audio.speakers")}">
                                <span class="settings-dropdown-current" data-default-label="settings.audio.default">${t("settings.audio.default")}</span>
                                <svg class="settings-dropdown-chevron" viewBox="0 0 24 24" aria-hidden="true">
                                    <path d="M6 9l6 6 6-6"/>
                                </svg>
                            </button>
                            <ul class="settings-dropdown-menu" role="listbox" aria-hidden="true"></ul>
                        </div>
                        <div class="settings-slider-row">
                            <span class="settings-slider-label" data-i18n="settings.audio.gainOut">${t("settings.audio.gainOut")}</span>
                            <input
                                type="range"
                                id="settingsSpkGain"
                                class="settings-slider"
                                min="0" max="100" step="1"
                                aria-label="${t("settings.audio.gainOut")}"
                            />
                            <span class="settings-slider-value" id="settingsSpkGainValue">100%</span>
                        </div>
                    </div>

                    <span class="settings-audio-hint" id="settingsAudioHint" aria-live="polite"></span>
                </div>

                <div class="settings-row">
                    <div class="settings-row-text">
                        <span class="settings-row-label" data-i18n="settings.streamer">${t("settings.streamer")}</span>
                        <span class="settings-row-hint" data-i18n="settings.streamer.hint">${t("settings.streamer.hint")}</span>
                    </div>
                    <label class="settings-switch">
                        <input type="checkbox" id="settingsStreamerInput"/>
                        <span class="settings-switch-track"></span>
                    </label>
                </div>

                <div class="settings-row">
                    <span class="settings-row-label" data-i18n="settings.lang">${t("settings.lang")}</span>
                    <div class="settings-seg" id="settingsLangSeg" role="tablist">
                        <button type="button" class="settings-seg-btn" data-val="ru" role="tab">RU</button>
                        <button type="button" class="settings-seg-btn" data-val="en" role="tab">EN</button>
                    </div>
                </div>

                <footer class="settings-footer">
                    <span class="settings-footer-pill">void v${APP_VERSION}</span>
                    <a class="settings-footer-author"
                       href="https://t.me/mtbibltww"
                       target="_blank"
                       rel="noopener noreferrer">by @casheaterr</a>
                </footer>
            </div>
        `;

        document.body.appendChild(scrimEl);
        document.body.appendChild(panelEl);

        langSegEl = panelEl.querySelector("#settingsLangSeg");
        streamerInputEl = panelEl.querySelector("#settingsStreamerInput");
        nickFormEl = panelEl.querySelector("#settingsNickForm");
        nickInputEl = panelEl.querySelector("#settingsNickInput");
        nickSavedEl = panelEl.querySelector("#settingsNickSaved");
        micGainEl = panelEl.querySelector("#settingsMicGain");
        spkGainEl = panelEl.querySelector("#settingsSpkGain");
        micGainValueEl = panelEl.querySelector("#settingsMicGainValue");
        spkGainValueEl = panelEl.querySelector("#settingsSpkGainValue");
        micMeterFillEl = panelEl.querySelector("#settingsMicMeterFill");
        spkTestBtnEl = panelEl.querySelector("#settingsSpkTest");
        audioHintEl = panelEl.querySelector("#settingsAudioHint");

        micDropdown = createDropdown(panelEl.querySelector("#settingsMicDropdown"), {
            onChange: (v) => {
                setAudioInId(v);
                restartPreview();
                showAudioHint(t("settings.audio.applyOnRejoin"));
            }
        });
        spkDropdown = createDropdown(panelEl.querySelector("#settingsSpkDropdown"), {
            onChange: (v) => setAudioOutId(v)
        });

        bindAudioControls();

        langSegEl.addEventListener("click", e => {
            const btn = e.target.closest(".settings-seg-btn");
            if (!btn) return;
            setLang(btn.dataset.val);
        });

        streamerInputEl.addEventListener("change", () => {
            setStreamer(streamerInputEl.checked);
        });

        nickFormEl.addEventListener("submit", (e) => {
            e.preventDefault();
            const saved = setNickname(nickInputEl.value);
            /* После sanitize реальное значение может отличаться от ввода
               (обрезали пробелы / control chars / длину). Возвращаем
               пользователю то, что реально сохранили. */
            nickInputEl.value = saved;
            flashNickSaved();
        });

        scrimEl.addEventListener("click", closePanel);
        panelEl.querySelector("#settingsClose").addEventListener("click", closePanel);

        document.addEventListener("keydown", e => {
            if (e.key === "Escape" && panelEl.classList.contains("is-open")) closePanel();
        });
    }

    function applyLangToggleUI() {
        if (!langSegEl) return;
        langSegEl.querySelectorAll(".settings-seg-btn").forEach(b => {
            b.classList.toggle("is-active", b.dataset.val === state.lang);
        });
    }

    function applyStreamerToggleUI() {
        if (!streamerInputEl) return;
        streamerInputEl.checked = !!state.streamer;
    }

    /* ===== AUDIO devices / sliders ===== */

    function bindAudioControls() {
        if (!micGainEl) return;

        micGainEl.addEventListener("input", () => {
            const v = Number(micGainEl.value) / 100;
            setAudioInGain(v);
            updateGainLabels();
        });
        spkGainEl.addEventListener("input", () => {
            const v = Number(spkGainEl.value) / 100;
            setAudioOutGain(v);
            updateGainLabels();
        });

        spkTestBtnEl?.addEventListener("click", playTestTone);

        /* devicechange — пользователь воткнул наушники, поменял USB-микрофон.
           Перебираем список без участия пользователя. */
        if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
            navigator.mediaDevices.addEventListener("devicechange", () => {
                if (panelEl?.classList.contains("is-open")) {
                    populateDeviceSelects();
                }
            });
        }
    }

    /* ===== custom dropdown =====
       Полностью свой компонент: нативный <select> рендерит popup OS-средствами
       и не уважает CSS (особенно <option> на тёмной теме на Windows/Linux).
       Свой даёт hover/keyboard-nav/скруглённые углы — попадает в эстетику. */
    function createDropdown(rootEl, opts) {
        const onChange = opts?.onChange || (() => {});
        const triggerEl = rootEl.querySelector(".settings-dropdown-trigger");
        const currentEl = rootEl.querySelector(".settings-dropdown-current");
        const menuEl = rootEl.querySelector(".settings-dropdown-menu");
        const defaultLabelKey = currentEl?.dataset.defaultLabel || "settings.audio.default";

        let value = "";
        let options = [];   // [{value, label}]
        let isOpen = false;
        let activeIndex = -1;

        function syncLabel() {
            if (!currentEl) return;
            const found = options.find(o => o.value === value);
            currentEl.textContent = found ? found.label : t(defaultLabelKey);
        }

        function render() {
            menuEl.innerHTML = "";
            options.forEach((opt, i) => {
                const li = document.createElement("li");
                li.className = "settings-dropdown-option";
                li.setAttribute("role", "option");
                li.dataset.value = opt.value;
                li.textContent = opt.label;
                if (opt.value === value) {
                    li.classList.add("is-selected");
                    li.setAttribute("aria-selected", "true");
                }
                li.addEventListener("click", (e) => {
                    e.stopPropagation();
                    pickByIndex(i);
                });
                li.addEventListener("mouseenter", () => setActive(i));
                menuEl.appendChild(li);
            });
            syncLabel();
        }

        function setActive(i) {
            activeIndex = i;
            Array.from(menuEl.children).forEach((el, idx) => {
                el.classList.toggle("is-active", idx === i);
            });
            /* Скроллим в видимую область, если меню длиннее видимой части. */
            const active = menuEl.children[i];
            if (active && typeof active.scrollIntoView === "function") {
                active.scrollIntoView({ block: "nearest" });
            }
        }

        function pickByIndex(i) {
            const opt = options[i];
            if (!opt) return;
            setValue(opt.value, /*fireChange*/ true);
            close();
            triggerEl.focus();
        }

        function setOptions(list) {
            options = list.slice();
            render();
        }

        function setValue(v, fireChange) {
            const prev = value;
            value = v == null ? "" : String(v);
            Array.from(menuEl.children).forEach(el => {
                const isSel = el.dataset.value === value;
                el.classList.toggle("is-selected", isSel);
                if (isSel) el.setAttribute("aria-selected", "true");
                else el.removeAttribute("aria-selected");
            });
            syncLabel();
            if (fireChange && prev !== value) onChange(value);
        }

        function open() {
            if (isOpen) return;
            isOpen = true;
            rootEl.classList.add("is-open");
            menuEl.setAttribute("aria-hidden", "false");
            triggerEl.setAttribute("aria-expanded", "true");
            const idx = options.findIndex(o => o.value === value);
            setActive(idx >= 0 ? idx : 0);
        }

        function close() {
            if (!isOpen) return;
            isOpen = false;
            rootEl.classList.remove("is-open");
            menuEl.setAttribute("aria-hidden", "true");
            triggerEl.setAttribute("aria-expanded", "false");
        }

        triggerEl.addEventListener("click", (e) => {
            e.stopPropagation();
            isOpen ? close() : open();
        });

        triggerEl.addEventListener("keydown", (e) => {
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                e.preventDefault();
                if (!isOpen) { open(); return; }
                const step = e.key === "ArrowDown" ? 1 : -1;
                setActive((activeIndex + step + options.length) % options.length);
            } else if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                if (!isOpen) open();
                else pickByIndex(activeIndex);
            } else if (e.key === "Escape" && isOpen) {
                e.preventDefault();
                e.stopPropagation();
                close();
            } else if (e.key === "Tab" && isOpen) {
                /* Tab — закрываем, но не отменяем default: фокус уйдёт штатно. */
                close();
            }
        });

        /* Клик вне дропдауна — закрыть. Один листенер на все инстансы — ок. */
        document.addEventListener("click", (e) => {
            if (isOpen && !rootEl.contains(e.target)) close();
        });

        return { setOptions, setValue, getValue: () => value };
    }

    function updateGainLabels() {
        if (micGainValueEl) micGainValueEl.textContent = Math.round(state.audioInGain * 100) + "%";
        if (spkGainValueEl) spkGainValueEl.textContent = Math.round(state.audioOutGain * 100) + "%";
    }

    function applyAudioControlsFromState() {
        if (!micGainEl) return;
        micGainEl.value = String(Math.round(state.audioInGain * 100));
        spkGainEl.value = String(Math.round(state.audioOutGain * 100));
        updateGainLabels();
    }

    async function populateDeviceSelects() {
        if (!micDropdown) return;
        if (!navigator.mediaDevices?.enumerateDevices) {
            showAudioHint(t("settings.audio.noSinkId"));
            return;
        }

        let devices = [];
        try {
            devices = await navigator.mediaDevices.enumerateDevices();
        } catch (_) {
            return;
        }

        const ins = devices.filter(d => d.kind === "audioinput");
        const outs = devices.filter(d => d.kind === "audiooutput");

        fillDropdown(micDropdown, ins, state.audioInId, "microphone", "audioInId");
        fillDropdown(spkDropdown, outs, state.audioOutId, "speaker", "audioOutId");

        /* setSinkId есть только в Chrome/Edge/Firefox 116+; в Safari отсутствует.
           Если API недоступен — гасим dropdown и пишем подсказку. */
        const supportsSinkId = "setSinkId" in HTMLMediaElement.prototype;
        const spkRoot = panelEl.querySelector("#settingsSpkDropdown");
        if (!supportsSinkId) {
            spkRoot?.classList.add("is-disabled");
            spkRoot?.querySelector(".settings-dropdown-trigger")?.setAttribute("disabled", "");
            if (spkTestBtnEl) spkTestBtnEl.disabled = true;
            showAudioHint(t("settings.audio.noSinkId"));
            return;
        } else {
            spkRoot?.classList.remove("is-disabled");
            spkRoot?.querySelector(".settings-dropdown-trigger")?.removeAttribute("disabled");
            if (spkTestBtnEl) spkTestBtnEl.disabled = false;
        }

        /* enumerateDevices возвращает имена устройств ТОЛЬКО когда у пользователя
           уже выдан permission на микрофон. Если нет — labels пустые, и юзер
           видит «Microphone 1 / Microphone 2». Подсказываем что делать. */
        const hasLabels = devices.some(d => d.label && d.label.length > 0);
        if (!hasLabels) {
            showAudioHint(t("settings.audio.permHint"));
        } else {
            hideAudioHint();
        }
    }

    function fillDropdown(dropdown, list, savedId, kindLabel, stateKey) {
        const opts = [
            { value: "", label: t("settings.audio.default") }
        ];
        list.forEach((d, i) => {
            opts.push({
                value: d.deviceId,
                label: d.label || `${kindLabel} ${i + 1}`
            });
        });
        dropdown.setOptions(opts);
        /* Если сохранённый id больше не существует — fallback на default. */
        const exists = !savedId || list.some(d => d.deviceId === savedId);
        dropdown.setValue(exists ? (savedId || "") : "", /*fireChange*/ false);
        if (!exists && savedId) {
            if (stateKey === "audioInId") setAudioInId("");
            else setAudioOutId("");
        }
    }

    function showAudioHint(text) {
        if (!audioHintEl) return;
        audioHintEl.textContent = text;
        audioHintEl.classList.add("is-visible");
    }
    function hideAudioHint() {
        if (!audioHintEl) return;
        audioHintEl.textContent = "";
        audioHintEl.classList.remove("is-visible");
    }

    /* ===== mic-level preview =====
       Отдельный поток (не трогает основной localStream) — нужен, чтобы юзер
       видел реакцию уровня при выборе устройства и крутил усиление с
       feedback'ом. Запрашиваем только при открытой панели. */

    async function startPreview() {
        stopPreview();
        if (!navigator.mediaDevices?.getUserMedia) return;
        const id = state.audioInId;
        previewLastDeviceId = id || "default";
        try {
            const constraints = {
                audio: id ? { deviceId: { exact: id } } : true,
                video: false
            };
            previewStream = await navigator.mediaDevices.getUserMedia(constraints);
        } catch (_) {
            /* нет permission / устройство пропало — просто молчим, meter
               останется на нуле. Подсказка про permission уже видна. */
            return;
        }
        try {
            const Ctx = window.AudioContext || window.webkitAudioContext;
            if (!Ctx) return;
            previewCtx = new Ctx();
            const src = previewCtx.createMediaStreamSource(previewStream);
            previewAnalyser = previewCtx.createAnalyser();
            previewAnalyser.fftSize = 256;
            previewAnalyser.smoothingTimeConstant = 0.5;
            src.connect(previewAnalyser);
            runPreviewLoop();
            /* Лейблы могли быть пустыми до permission — теперь они есть,
               пере-наполняем select'ы. */
            populateDeviceSelects();
        } catch (_) {
            stopPreview();
        }
    }

    function runPreviewLoop() {
        if (!previewAnalyser) return;
        const data = new Uint8Array(previewAnalyser.frequencyBinCount);
        const tick = () => {
            if (!previewAnalyser || !micMeterFillEl) { previewRaf = null; return; }
            previewAnalyser.getByteFrequencyData(data);
            let sum = 0;
            for (let i = 0; i < data.length; i++) sum += data[i];
            const avg = sum / data.length;
            /* avg в [0..255]; нормальная речь даёт 20..50, громкий звук — 80+.
               Применяем gain (как множитель), отображаем в процентах от ~80.
               Если уперлись в 100% — фактически юзер «в полку». */
            const withGain = avg * state.audioInGain;
            const pct = Math.min(100, (withGain / 80) * 100);
            micMeterFillEl.style.width = pct.toFixed(1) + "%";
            /* Цветная подсветка «слишком громко»: дорисуем класс по порогу. */
            micMeterFillEl.classList.toggle("is-hot", pct > 92);
            previewRaf = requestAnimationFrame(tick);
        };
        tick();
    }

    function stopPreview() {
        if (previewRaf) { cancelAnimationFrame(previewRaf); previewRaf = null; }
        if (previewStream) {
            previewStream.getTracks().forEach(t => { try { t.stop(); } catch (_) {} });
            previewStream = null;
        }
        if (previewCtx) {
            try { previewCtx.close(); } catch (_) {}
            previewCtx = null;
        }
        previewAnalyser = null;
        if (micMeterFillEl) {
            micMeterFillEl.style.width = "0%";
            micMeterFillEl.classList.remove("is-hot");
        }
    }

    async function restartPreview() {
        if (panelEl?.classList.contains("is-open")) {
            await startPreview();
        }
    }

    /* ===== speaker test ===== */

    async function playTestTone() {
        /* Короткий «дзынь» через существующий звук join'а. Создаём временный
           <audio>-элемент, чтобы применить setSinkId именно к нему, не
           ломая основные системные звуки (у них может быть другой sink в
           процессе работы). */
        const audio = new Audio("/static/audio-in.mp3");
        audio.volume = state.audioOutGain;
        try {
            if (audio.setSinkId && state.audioOutId) {
                await audio.setSinkId(state.audioOutId);
            }
        } catch (_) {
            /* Безымянное устройство пропало / нет permission на sinkId.
               Падать в системный default — приемлемо. */
        }
        audio.play().catch(() => {});
    }

    function applyNickInputUI() {
        if (!nickInputEl) return;
        /* Если у пользователя есть сохранённый ник — показываем его.
           Иначе — текущее сгенерированное имя (window.currentUsername выставляет
           app.js после generateAndAssignUsername). Так пользователь видит,
           «как его сейчас зовут», и может либо принять/отредактировать,
           либо очистить поле, чтобы вернуться к рандомной генерации. */
        const stored = state.nickname || "";
        const active = (typeof window !== "undefined" && window.currentUsername) || "";
        nickInputEl.value = stored || active;
    }

    function flashNickSaved() {
        if (!nickSavedEl) return;
        nickSavedEl.classList.add("is-visible");
        if (nickSavedTimer) clearTimeout(nickSavedTimer);
        nickSavedTimer = setTimeout(() => {
            nickSavedEl.classList.remove("is-visible");
            nickSavedTimer = null;
        }, 1400);
    }

    function openPanel() {
        if (!panelEl) return;
        /* Перерисовываем поле ника на каждом open — currentUsername мог
           перегенериться (пользователь очистил ник, или сменилась сессия). */
        applyNickInputUI();
        applyAudioControlsFromState();
        populateDeviceSelects();
        startPreview();
        panelEl.classList.add("is-open");
        panelEl.setAttribute("aria-hidden", "false");
        scrimEl.classList.add("is-open");
        scrimEl.setAttribute("aria-hidden", "false");
        if (gearBtn) gearBtn.setAttribute("aria-expanded", "true");
    }

    function closePanel() {
        if (!panelEl) return;
        stopPreview();
        panelEl.classList.remove("is-open");
        panelEl.setAttribute("aria-hidden", "true");
        scrimEl.classList.remove("is-open");
        scrimEl.setAttribute("aria-hidden", "true");
        if (gearBtn) gearBtn.setAttribute("aria-expanded", "false");
    }

    function bindBrandTrigger() {
        gearBtn = document.getElementById("brandSettingsBtn");
        if (!gearBtn) return;
        gearBtn.addEventListener("click", e => {
            e.preventDefault();
            if (panelEl?.classList.contains("is-open")) closePanel();
            else openPanel();
        });
    }

    /* ===== bootstrap ===== */

    function init() {
        loadState();
        document.documentElement.lang = state.lang;
        applyStreamerAttr();
        applyI18n();

        buildPanel();
        bindBrandTrigger();
        applyLangToggleUI();
        applyStreamerToggleUI();
        applyNickInputUI();
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", init);
    } else {
        init();
    }

    /* ===== exports ===== */
    window.VoidI18n = { t, applyI18n, getLang };
    window.VoidSettings = {
        getLang, getStreamer, getNickname,
        getAudioInId, getAudioOutId, getAudioInGain, getAudioOutGain,
        setLang, setStreamer, setNickname,
        setAudioInId, setAudioOutId, setAudioInGain, setAudioOutGain,
        openPanel, closePanel
    };
})();
