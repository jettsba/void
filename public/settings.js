/* ========= SETTINGS + I18N =========
   Единый модуль: словари, t(), applyI18n(), localStorage state, панель.
   Загружается ПЕРВЫМ скриптом — script.js/chat.js используют t() и слушают
   событие "void:locale-changed" чтобы перерисовать динамические надписи.
*/

(function () {
    "use strict";

    const APP_VERSION = "0.2.1";

    const STORAGE_KEY = "void:settings";
    const DEFAULTS = { lang: "ru", streamer: false, nickname: "" };

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
            "settings.nick.saved": "сохранено"
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
            "settings.nick.saved": "saved"
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

                <div class="settings-row">
                    <span class="settings-row-label" data-i18n="settings.lang">${t("settings.lang")}</span>
                    <div class="settings-seg" id="settingsLangSeg" role="tablist">
                        <button type="button" class="settings-seg-btn" data-val="ru" role="tab">RU</button>
                        <button type="button" class="settings-seg-btn" data-val="en" role="tab">EN</button>
                    </div>
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

                <div class="settings-row settings-row--stack">
                    <div class="settings-row-text">
                        <span class="settings-row-label" data-i18n="settings.nick">${t("settings.nick")}</span>
                        <span class="settings-row-hint" data-i18n="settings.nick.hint">${t("settings.nick.hint")}</span>
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
        panelEl.classList.add("is-open");
        panelEl.setAttribute("aria-hidden", "false");
        scrimEl.classList.add("is-open");
        scrimEl.setAttribute("aria-hidden", "false");
        if (gearBtn) gearBtn.setAttribute("aria-expanded", "true");
    }

    function closePanel() {
        if (!panelEl) return;
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
        setLang, setStreamer, setNickname,
        openPanel, closePanel
    };
})();
