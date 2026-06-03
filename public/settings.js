/* ========= SETTINGS + I18N =========
   Единый модуль: словари, t(), applyI18n(), localStorage state, панель.
   Загружается ПЕРВЫМ скриптом — script.js/chat.js используют t() и слушают
   событие "void:locale-changed" чтобы перерисовать динамические надписи.
*/

(function () {
    "use strict";

    const APP_VERSION = "0.10.63";
    /* Экспортируем версию в window — log.bugReport() кладёт её в отчёт,
       чтобы было видно с какой версии собран дамп. */
    window.VoidVersion = APP_VERSION;

    /* Platform-флаг. desktop-bootstrap.js в <head> уже выставляет
       window.VoidPlatform="desktop" и html.desktop класс при наличии
       Tauri runtime (без FOUC). Здесь — fallback для web-сборки. */
    if (!window.VoidPlatform) window.VoidPlatform = "web";

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
        audioOutGain: 1.0,
        /* Тема амбиентного фона приложения. См. public/js/background.js —
           three themes registry. На лендинг не влияет. */
        bgTheme: "silence",
        /* Пользовательский масштаб интерфейса. Применяется как множитель
           к корневому font-size поверх auto-scale (см. base.css :root).
           inline-скрипт в <head> index.html читает это ДО загрузки CSS,
           чтобы избежать FOUC. Слайдер в панели — 70..150%. */
        uiScale: 1.0,
        /* Desktop-only настройки. В web-сборке игнорируются, но сериализуются
           одинаково — чтобы settings panel UI не разваливался при переключении.
           closeAction: "minimize" (default) — close → hide-to-tray;
                        "close" — close → quit. */
        closeAction: "minimize",
        autoStart: false
    };

    const BG_THEMES = ["silence", "nebula", "void-grid"];

    const AUDIO_IN_GAIN_MIN = 0;
    const AUDIO_IN_GAIN_MAX = 1.5;
    const AUDIO_OUT_GAIN_MIN = 0;
    const AUDIO_OUT_GAIN_MAX = 1.0;

    const UI_SCALE_MIN = 0.7;
    const UI_SCALE_MAX = 1.5;

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
            "chat.like": "лайк",

            "footer.ready": "готово",
            "footer.connected": "подключено",
            "footer.connecting": "подключение",
            "footer.reconnecting": "переподключение",
            "footer.reconnecting.attempt": "переподключение {attempt}/{total}",
            "footer.unstable": "связь нестабильна",
            "footer.error": "ошибка",
            "footer.copy.streamer": "скопировать код комнаты",
            "footer.roomCode": "комната #{code}",

            "ping.empty": "нет участников",

            "errors.room-not-found": "комната не найдена",
            "errors.room-full": "комната заполнена",
            "errors.connection-failed": "не удалось подключиться к серверу",
            "errors.mic-blocked": "нет доступа к микрофону",
            "errors.mic-blocked.title": "микрофон заблокирован",
            "errors.mic-blocked.body": "в адресной строке слева нажми на иконку микрофона и разреши доступ - после чего обнови страницу.",
            "errors.mic-blocked.body.ios": "открой настройки iOS → safari → камера и микрофон, разреши доступ для этого сайта и обнови страницу",
            "errors.mic-blocked.body.android": "открой меню браузера → настройки сайта → разрешения → микрофон, разреши доступ и обнови страницу",
            "errors.mic-blocked.cta": "понятно",
            "hints.mic-permission-incoming": "сейчас браузер спросит разрешение на микрофон",
            "errors.create-failed": "не удалось создать комнату",
            "errors.code-taken": "не удалось подобрать свободный код — попробуй ещё раз",
            "errors.join-session-invalid": "сессия недействительна — попробуй ещё раз",
            "errors.connection-lost": "соединение потеряно",
            "errors.rate-limited": "слишком много попыток — подожди немного",
            "errors.id-collision": "сессия с этим id уже активна — обнови страницу",
            "errors.unknown": "что-то пошло не так",
            "errors.screencast.busy": "демонстрация уже идёт в этой комнате",
            "errors.mic-lost": "микрофон отключился — пробую восстановить",
            "errors.mic-lost.failed": "не удалось восстановить микрофон — попробуй перезайти",

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
            "settings.audio.applyOnRejoin": "новый микрофон подключится при следующем входе в комнату",

            "settings.bg": "фон",
            "settings.uiScale": "масштаб интерфейса",
            "settings.uiScale.hint": "размер всех элементов: текста, кнопок, аватаров",

            "settings.support": "поддержать",
            "settings.hint": "нажми, чтобы открыть настройки",
            "support.title": "спасибо, что ты здесь",
            "support.body": "void бесплатный и без рекламы. если он сделал твой день чуть теплее — можно угостить чашкой кофе. это правда помогает держать сервер живым и пилить дальше.",
            "support.copy.title": "скопировать адрес",
            "support.copied": "скопировано",
            "support.qr.show": "показать qr",
            "support.qr.title": "qr-код адреса",
            "support.qr.close": "закрыть",
            "support.coin.btc": "bitcoin",
            "support.coin.eth": "ethereum (erc-20)",
            "support.coin.usdt": "usdt (tron, trc-20)",

            "settings.bug": "сообщить о проблеме",
            "bug.title": "сообщить о проблеме",
            "bug.body": "опиши, что пошло не так или что хотелось бы добавить. к заявке автоматически приложится короткий технический лог — поможет быстрее разобраться.",
            "bug.desc.placeholder": "опиши проблему или предложение",
            "bug.contact.placeholder": "контакт (почта / telegram), по желанию",
            "bug.contact.hint": "необязательно, но так смогу ответить",
            "bug.submit": "отправить",
            "bug.submitting": "отправляю…",
            "bug.error": "не удалось отправить — попробуй ещё раз",
            "bug.error.rate": "слишком много заявок — подожди немного",
            "bug.error.empty": "напиши пару слов о проблеме",
            "bug.thanks.title": "спасибо!",
            "bug.thanks.body": "заявка отправлена. постараюсь разобраться как можно скорее.",
            "bug.thanks.close": "закрыть",

            "invite.hint": "нажми на код внизу — там код и ссылка для друзей",
            "invite.button-title": "пригласить",
            "invite.code-label": "комната:",
            "invite.copy-link": "скопировать ссылку",
            "invite.copied": "скопировано"
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
            "chat.like": "like",

            "footer.ready": "ready",
            "footer.connected": "connected",
            "footer.connecting": "connecting",
            "footer.reconnecting": "reconnecting",
            "footer.reconnecting.attempt": "reconnecting {attempt}/{total}",
            "footer.unstable": "connection unstable",
            "footer.error": "error",
            "footer.copy.streamer": "copy room code",
            "footer.roomCode": "room #{code}",

            "ping.empty": "no peers",

            "errors.room-not-found": "room not found",
            "errors.room-full": "room is full",
            "errors.connection-failed": "could not connect to server",
            "errors.mic-blocked": "microphone blocked",
            "errors.mic-blocked.title": "microphone is blocked",
            "errors.mic-blocked.body": "click the mic icon in the address bar and allow access, then reload the page.",
            "errors.mic-blocked.body.ios": "open ios settings → safari → camera & microphone, allow access for this site and reload",
            "errors.mic-blocked.body.android": "open browser menu → site settings → permissions → microphone, allow access and reload",
            "errors.mic-blocked.cta": "got it",
            "hints.mic-permission-incoming": "browser will ask for microphone access",
            "errors.create-failed": "could not create room",
            "errors.code-taken": "could not pick a free code — try again",
            "errors.join-session-invalid": "session invalid — try again",
            "errors.connection-lost": "connection lost",
            "errors.rate-limited": "too many attempts — wait a bit",
            "errors.id-collision": "session id is already active — refresh the page",
            "errors.unknown": "something went wrong",
            "errors.screencast.busy": "screen share is already active in this room",
            "errors.mic-lost": "mic disconnected — trying to restore",
            "errors.mic-lost.failed": "couldn't restore mic — try rejoining",

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
            "settings.audio.applyOnRejoin": "the new microphone will be picked up the next time you join a room",

            "settings.bg": "background",
            "settings.uiScale": "interface scale",
            "settings.uiScale.hint": "size of all elements: text, buttons, avatars",

            "settings.support": "support",
            "settings.hint": "tap to open settings",
            "support.title": "thanks for being here",
            "support.body": "void is free and ad-free. if it made your day a little warmer — you can buy it a coffee. it genuinely helps keep the server up and the work going.",
            "support.copy.title": "copy address",
            "support.copied": "copied",
            "support.qr.show": "show qr",
            "support.qr.title": "address qr code",
            "support.qr.close": "close",
            "support.coin.btc": "bitcoin",
            "support.coin.eth": "ethereum (erc-20)",
            "support.coin.usdt": "usdt (tron, trc-20)",

            "settings.bug": "report a bug",
            "bug.title": "report a bug",
            "bug.body": "describe what went wrong or what you'd like to see added. a short technical log will be attached automatically — it helps me figure out the issue faster.",
            "bug.desc.placeholder": "describe the problem or suggestion",
            "bug.contact.placeholder": "contact (email / telegram), optional",
            "bug.contact.hint": "optional, lets me reach back if needed",
            "bug.submit": "send",
            "bug.submitting": "sending…",
            "bug.error": "couldn't send — please try again",
            "bug.error.rate": "too many submissions — wait a bit",
            "bug.error.empty": "write a couple of words first",
            "bug.thanks.title": "thanks!",
            "bug.thanks.body": "your report is on its way. i'll look into it as soon as i can.",
            "bug.thanks.close": "close",

            "invite.hint": "tap the code below — share it or copy a link",
            "invite.button-title": "invite",
            "invite.code-label": "room code:",
            "invite.copy-link": "copy link",
            "invite.copied": "copied"
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
                if (typeof parsed.bgTheme === "string" && BG_THEMES.indexOf(parsed.bgTheme) !== -1) {
                    state.bgTheme = parsed.bgTheme;
                }
                if (typeof parsed.uiScale === "number" && isFinite(parsed.uiScale)) {
                    state.uiScale = clampGain(parsed.uiScale, UI_SCALE_MIN, UI_SCALE_MAX);
                }
                if (parsed.closeAction === "minimize" || parsed.closeAction === "close") {
                    state.closeAction = parsed.closeAction;
                }
                if (typeof parsed.autoStart === "boolean") state.autoStart = parsed.autoStart;
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
                /* title даёт browser tooltip при hover — намеренно не применяем,
                   UI без подсказок. Accessibility сохраняется через aria-label. */
                if (attr === "title") return;
                el.setAttribute(attr, t(key));
            });
        });

        /* Удаляем все inline title="..." — они fallback'ом проставлены в HTML
           и показывают tooltip до прихода applyI18n + после (мы их не пишем
           через i18n, но статический атрибут остаётся). */
        scope.querySelectorAll("[title]").forEach(el => el.removeAttribute("title"));
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
    function getBgTheme() { return state.bgTheme; }
    function getUiScale() { return state.uiScale; }

    function setBgTheme(name) {
        if (BG_THEMES.indexOf(name) === -1) return;
        if (state.bgTheme === name) return;
        state.bgTheme = name;
        saveState();
        applyBgThemeSegUI();
        /* background.js слушает это событие и плавно переключает фон. */
        document.dispatchEvent(new CustomEvent("void:bg-theme-changed", { detail: { theme: name } }));
    }

    function setUiScale(v) {
        const next = clampGain(v, UI_SCALE_MIN, UI_SCALE_MAX);
        if (state.uiScale === next) return;
        state.uiScale = next;
        saveState();
        /* Применяем сразу: --ui-scale на :root → font-size пересчитается,
           всё, что в rem, перерисуется в новом масштабе без перезагрузки. */
        document.documentElement.style.setProperty("--ui-scale", next);
        applyUiScaleSliderUI();
    }

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

    /* ===== settings hint ===== */

    const HINT_KEY = "void:hint-settings";

    function buildSettingsHint() {
        if (localStorage.getItem(HINT_KEY)) return;
        const el = document.createElement("div");
        el.className = "settings-hint";
        el.id = "settingsHint";
        el.setAttribute("aria-hidden", "true");
        el.innerHTML = `
            <svg class="settings-hint-arrow" viewBox="0 0 12 16" fill="none" aria-hidden="true">
                <path d="M6 14V2M1.5 7.5L6 2L10.5 7.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
            <span class="settings-hint-text" data-i18n="settings.hint">${t("settings.hint")}</span>
        `;
        document.body.appendChild(el);
        setTimeout(() => el.classList.add("is-visible"), 600);
    }

    function dismissSettingsHint() {
        const el = document.getElementById("settingsHint");
        if (!el) return;
        localStorage.setItem(HINT_KEY, "1");
        el.classList.remove("is-visible");
        el.addEventListener("transitionend", () => el.remove(), { once: true });
    }

    /* ===== panel UI ===== */

    let panelEl, scrimEl, gearBtn, langSegEl, streamerInputEl, bgThemeSegEl;
    let nickFormEl, nickInputEl, nickSavedEl, nickSavedTimer = null;
    let uiScaleEl, uiScaleValueEl;
    let micDropdown, spkDropdown,
        micGainEl, spkGainEl,
        micGainValueEl, spkGainValueEl,
        micMeterFillEl, spkTestBtnEl,
        audioHintEl;
    let supportBtnEl, supportModalEl, supportQrModalEl, supportQrFigureEl, supportQrLabelEl;
    let bugBtnEl, bugModalEl, bugFormViewEl, bugSuccessViewEl,
        bugDescEl, bugContactEl, bugSubmitEl, bugErrorEl;
    /* Чтобы не дать спамить кнопкой submit на медленной сети. */
    let bugSubmitting = false;

    /* Адреса намеренно зашиты в код: они привязаны к одному автору,
       никакой динамики тут не нужно. Если кошельки сменятся — правка здесь
       (и заодно перегенерить картинки в public/static/qr/). */
    const SUPPORT_COINS = [
        { id: "btc",  labelKey: "support.coin.btc",  address: "bc1qqny8g5zy2a7eyzdj9dknl55gj6hdqh2kejcut3", qr: "static/qr/btc.png" },
        { id: "eth",  labelKey: "support.coin.eth",  address: "0x7DD7912D37bD498f2F920079d89D500C5aB970ca", qr: "static/qr/eth.png" },
        { id: "usdt", labelKey: "support.coin.usdt", address: "TA2rJmmDujhuL1b2PDZwKhPDUufQkkG665",        qr: "static/qr/usdt.png" }
    ];
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

                <div class="settings-row settings-row--stack" id="settingsBgThemeRow">
                    <div class="settings-row-text">
                        <span class="settings-row-label" data-i18n="settings.bg">${t("settings.bg")}</span>
                    </div>
                    <div class="settings-seg settings-seg--full" id="settingsBgThemeSeg" role="tablist">
                        <!-- Названия тем намеренно НЕ локализованы — техника фона, не интерфейс. -->
                        <button type="button" class="settings-seg-btn" data-val="silence" role="tab">silence</button>
                        <button type="button" class="settings-seg-btn" data-val="nebula" role="tab">nebula</button>
                        <button type="button" class="settings-seg-btn" data-val="void-grid" role="tab">grid</button>
                    </div>
                </div>

                <div class="settings-row settings-row--stack" id="settingsUiScaleRow">
                    <div class="settings-row-text">
                        <span class="settings-row-label" data-i18n="settings.uiScale">${t("settings.uiScale")}</span>
                        <span class="settings-row-hint" data-i18n="settings.uiScale.hint">${t("settings.uiScale.hint")}</span>
                    </div>
                    <div class="settings-slider-row settings-slider-row--solo">
                        <div class="settings-slider-wrap">
                            <input
                                type="range"
                                id="settingsUiScale"
                                class="settings-slider"
                                min="70" max="150" step="5"
                                aria-label="${t("settings.uiScale")}"
                            />
                            <span class="settings-slider-tick" aria-hidden="true"></span>
                        </div>
                        <span class="settings-slider-value" id="settingsUiScaleValue">100%</span>
                    </div>
                </div>

                <!-- Desktop-related action rows. Сейчас отображаются и в web
                     (это намеренно, чтобы UI был доступен везде на текущем этапе).
                     В Фазе 9 (детект web/desktop) — нормально показать/скрыть,
                     поправить копирайтинг хинтов, разделить modal'ки. -->
                <button type="button" class="settings-action-btn" id="settingsHotkeysBtn">
                    <svg class="settings-action-btn-icon" viewBox="0 0 24 24" aria-hidden="true">
                        <rect x="2" y="6" width="20" height="12" rx="2"/>
                        <path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10"/>
                    </svg>
                    <span class="settings-action-btn-body">
                        <span class="settings-action-btn-label">настроить горячие клавиши</span>
                        <span class="settings-action-btn-hint" data-web-hint>работают только при открытой вкладке</span>
                    </span>
                </button>

                <button type="button" class="settings-action-btn" id="settingsAppBtn">
                    <svg class="settings-action-btn-icon" viewBox="0 0 24 24" aria-hidden="true">
                        <circle cx="12" cy="12" r="3"/>
                        <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h0a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h0a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v0a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
                    </svg>
                    <span class="settings-action-btn-body">
                        <span class="settings-action-btn-label">настройки приложения</span>
                        <span class="settings-action-btn-hint">только для desktop версии</span>
                    </span>
                </button>

                <button type="button" class="settings-bug-btn" id="settingsBugBtn"
                    aria-haspopup="dialog" aria-controls="bugModal"
                    data-i18n-attr="title:settings.bug;aria-label:settings.bug"
                    title="${t("settings.bug")}"
                    aria-label="${t("settings.bug")}">
                    <svg class="settings-bug-icon" viewBox="0 0 24 24" aria-hidden="true">
                        <path d="M5 3v18"/>
                        <path d="M5 4h12l-2 3 2 3H5"/>
                    </svg>
                    <span class="settings-bug-label" data-i18n="settings.bug">${t("settings.bug")}</span>
                </button>

                <footer class="settings-footer">
                    <div class="settings-footer-meta">
                        <span class="settings-footer-pill">void v${APP_VERSION}</span>
                        <a class="settings-footer-author"
                           href="https://t.me/mtbibltww"
                           target="_blank"
                           rel="noopener noreferrer">by @casheaterr</a>
                    </div>
                    <button type="button" class="settings-support-btn" id="settingsSupportBtn"
                        aria-haspopup="dialog" aria-controls="supportModal">
                        <svg class="settings-support-heart" viewBox="0 0 24 24" aria-hidden="true">
                            <path d="M12 21s-7-4.35-9.5-8.5C.7 9 2.6 5 6.2 5c2 0 3.4 1.1 4.3 2.4l1.5 2 1.5-2C14.4 6.1 15.8 5 17.8 5c3.6 0 5.5 4 3.7 7.5C19 16.65 12 21 12 21z"/>
                        </svg>
                        <span class="settings-support-label" data-i18n="settings.support">${t("settings.support")}</span>
                    </button>
                </footer>
            </div>
        `;

        document.body.appendChild(scrimEl);
        document.body.appendChild(panelEl);

        langSegEl = panelEl.querySelector("#settingsLangSeg");
        bgThemeSegEl = panelEl.querySelector("#settingsBgThemeSeg");
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
        uiScaleEl = panelEl.querySelector("#settingsUiScale");
        uiScaleValueEl = panelEl.querySelector("#settingsUiScaleValue");

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

        bgThemeSegEl?.addEventListener("click", e => {
            const btn = e.target.closest(".settings-seg-btn");
            if (!btn) return;
            setBgTheme(btn.dataset.val);
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

        supportBtnEl = panelEl.querySelector("#settingsSupportBtn");
        supportBtnEl?.addEventListener("click", openSupportModal);

        bugBtnEl = panelEl.querySelector("#settingsBugBtn");
        bugBtnEl?.addEventListener("click", openBugModal);

        buildSupportModal();
        buildBugModal();

        document.addEventListener("keydown", e => {
            if (e.key !== "Escape") return;
            /* Закрываем модалки по иерархии: QR поверх support, поверх bug, поверх settings. */
            if (supportQrModalEl?.classList.contains("is-open")) { closeSupportQr(); return; }
            if (supportModalEl?.classList.contains("is-open")) { closeSupportModal(); return; }
            if (bugModalEl?.classList.contains("is-open")) { closeBugModal(); return; }
            if (panelEl.classList.contains("is-open")) closePanel();
        });
    }

    /* ===== support modal ===== */

    function buildSupportModal() {
        if (document.getElementById("supportModal")) return;

        const coinsHtml = SUPPORT_COINS.map(c => `
            <div class="support-coin" data-coin="${c.id}">
                <span class="support-coin-label" data-i18n="${c.labelKey}">${t(c.labelKey)}</span>
                <div class="support-coin-row">
                    <button type="button" class="support-coin-addr"
                        data-address="${c.address}"
                        data-i18n-attr="title:support.copy.title;aria-label:support.copy.title"
                        title="${t("support.copy.title")}"
                        aria-label="${t("support.copy.title")}">
                        <span class="support-coin-addr-text">${c.address}</span>
                        <span class="support-coin-copied" data-i18n="support.copied">${t("support.copied")}</span>
                    </button>
                    <button type="button" class="support-coin-qr"
                        data-address="${c.address}" data-coin-id="${c.id}"
                        data-i18n-attr="title:support.qr.show;aria-label:support.qr.show"
                        title="${t("support.qr.show")}"
                        aria-label="${t("support.qr.show")}">
                        <svg viewBox="0 0 24 24" aria-hidden="true">
                            <path d="M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4z"/>
                            <path d="M14 14h2v2h-2zM18 14h2v2h-2zM14 18h2v2h-2zM18 18h2v2h-2z"/>
                        </svg>
                    </button>
                </div>
            </div>
        `).join("");

        supportModalEl = document.createElement("div");
        supportModalEl.className = "support-modal";
        supportModalEl.id = "supportModal";
        supportModalEl.setAttribute("aria-hidden", "true");
        supportModalEl.setAttribute("role", "dialog");
        supportModalEl.setAttribute("aria-labelledby", "supportTitle");
        supportModalEl.innerHTML = `
            <div class="support-backdrop" id="supportBackdrop"></div>
            <div class="support-card">
                <button type="button" class="support-close" id="supportClose"
                    data-i18n-attr="aria-label:support.qr.close;title:support.qr.close"
                    aria-label="${t("support.qr.close")}"
                    title="${t("support.qr.close")}">
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                        <path d="M6 6l12 12"/>
                        <path d="M18 6L6 18"/>
                    </svg>
                </button>
                <div class="support-content">
                    <div class="support-head">
                        <svg class="support-head-heart" viewBox="0 0 24 24" aria-hidden="true">
                            <path d="M12 21s-7-4.35-9.5-8.5C.7 9 2.6 5 6.2 5c2 0 3.4 1.1 4.3 2.4l1.5 2 1.5-2C14.4 6.1 15.8 5 17.8 5c3.6 0 5.5 4 3.7 7.5C19 16.65 12 21 12 21z"/>
                        </svg>
                        <h2 class="support-title" id="supportTitle" data-i18n="support.title">${t("support.title")}</h2>
                    </div>
                    <p class="support-body" data-i18n="support.body">${t("support.body")}</p>
                    <div class="support-coins">${coinsHtml}</div>
                </div>
            </div>
        `;

        supportQrModalEl = document.createElement("div");
        supportQrModalEl.className = "support-qr-modal";
        supportQrModalEl.id = "supportQrModal";
        supportQrModalEl.setAttribute("aria-hidden", "true");
        supportQrModalEl.setAttribute("role", "dialog");
        supportQrModalEl.innerHTML = `
            <div class="support-qr-backdrop" id="supportQrBackdrop"></div>
            <div class="support-qr-card">
                <button type="button" class="support-qr-close" id="supportQrClose"
                    data-i18n-attr="aria-label:support.qr.close;title:support.qr.close"
                    aria-label="${t("support.qr.close")}"
                    title="${t("support.qr.close")}">
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                        <path d="M6 6l12 12"/>
                        <path d="M18 6L6 18"/>
                    </svg>
                </button>
                <span class="support-qr-title" id="supportQrLabel" data-i18n="support.qr.title">${t("support.qr.title")}</span>
                <div class="support-qr-figure" id="supportQrFigure" aria-hidden="true"></div>
                <span class="support-qr-addr" id="supportQrAddr"></span>
            </div>
        `;

        document.body.appendChild(supportModalEl);
        document.body.appendChild(supportQrModalEl);

        supportQrFigureEl = supportQrModalEl.querySelector("#supportQrFigure");
        supportQrLabelEl = supportQrModalEl.querySelector("#supportQrAddr");

        supportModalEl.querySelector("#supportBackdrop").addEventListener("click", closeSupportModal);
        supportModalEl.querySelector("#supportClose").addEventListener("click", closeSupportModal);

        supportModalEl.querySelectorAll(".support-coin-addr").forEach(btn => {
            btn.addEventListener("click", () => copySupportAddress(btn));
        });
        supportModalEl.querySelectorAll(".support-coin-qr").forEach(btn => {
            btn.addEventListener("click", () => {
                const addr = btn.dataset.address || "";
                const coin = SUPPORT_COINS.find(c => c.id === btn.dataset.coinId);
                openSupportQr(addr, coin ? t(coin.labelKey) : "", coin ? coin.qr : "");
            });
        });

        supportQrModalEl.querySelector("#supportQrBackdrop").addEventListener("click", closeSupportQr);
        supportQrModalEl.querySelector("#supportQrClose").addEventListener("click", closeSupportQr);
    }

    function openSupportModal() {
        if (!supportModalEl) return;
        supportModalEl.classList.add("is-open");
        supportModalEl.setAttribute("aria-hidden", "false");
    }

    function closeSupportModal() {
        if (!supportModalEl) return;
        supportModalEl.classList.remove("is-open");
        supportModalEl.setAttribute("aria-hidden", "true");
        /* QR закроем тоже — он бессмыслен без родительской модалки. */
        closeSupportQr();
    }

    function openSupportQr(address, coinLabel, qrSrc) {
        if (!supportQrModalEl || !supportQrFigureEl) return;
        const src = qrSrc || "";
        const alt = coinLabel || t("support.qr.title");
        /* Картинки 1500×1500 — CSS даст object-fit:contain в 220×220 контейнер.
           Браузер сам отресемплит, оставаясь в quiet-zone PNG. */
        supportQrFigureEl.innerHTML = src
            ? `<img src="${src}" alt="${alt}" draggable="false">`
            : "";
        if (supportQrLabelEl) supportQrLabelEl.textContent = address;
        const titleEl = supportQrModalEl.querySelector("#supportQrLabel");
        if (titleEl) titleEl.textContent = alt;
        supportQrModalEl.classList.add("is-open");
        supportQrModalEl.setAttribute("aria-hidden", "false");
    }

    function closeSupportQr() {
        if (!supportQrModalEl) return;
        supportQrModalEl.classList.remove("is-open");
        supportQrModalEl.setAttribute("aria-hidden", "true");
    }

    async function copySupportAddress(btnEl) {
        const addr = btnEl.dataset.address || "";
        if (!addr) return;
        try {
            await navigator.clipboard.writeText(addr);
        } catch (_) {
            /* fallback: невидимый textarea + execCommand для старых браузеров /
               http-контекстов. clipboard-API требует secure context. */
            try {
                const ta = document.createElement("textarea");
                ta.value = addr;
                ta.style.position = "fixed";
                ta.style.opacity = "0";
                document.body.appendChild(ta);
                ta.select();
                document.execCommand("copy");
                document.body.removeChild(ta);
            } catch (_) { return; }
        }
        btnEl.classList.add("is-copied");
        clearTimeout(btnEl._copyT);
        btnEl._copyT = setTimeout(() => btnEl.classList.remove("is-copied"), 1200);
    }

    /* ===== bug-report modal ===== */

    /** Кэп на длину описания/контакта. Сервер тоже валидирует — здесь UX-кэп. */
    const BUG_DESC_MAX = 5000;
    const BUG_CONTACT_MAX = 200;

    function buildBugModal() {
        if (document.getElementById("bugModal")) return;

        bugModalEl = document.createElement("div");
        bugModalEl.className = "bug-modal";
        bugModalEl.id = "bugModal";
        bugModalEl.setAttribute("aria-hidden", "true");
        bugModalEl.setAttribute("role", "dialog");
        bugModalEl.setAttribute("aria-labelledby", "bugTitle");
        bugModalEl.innerHTML = `
            <div class="bug-backdrop" id="bugBackdrop"></div>
            <div class="bug-card">
                <button type="button" class="bug-close" id="bugClose"
                    data-i18n-attr="aria-label:bug.thanks.close;title:bug.thanks.close"
                    aria-label="${t("bug.thanks.close")}"
                    title="${t("bug.thanks.close")}">
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                        <path d="M6 6l12 12"/>
                        <path d="M18 6L6 18"/>
                    </svg>
                </button>

                <div class="bug-view bug-view--form" id="bugFormView">
                    <h2 class="bug-title" id="bugTitle" data-i18n="bug.title">${t("bug.title")}</h2>
                    <p class="bug-body" data-i18n="bug.body">${t("bug.body")}</p>

                    <form class="bug-form" id="bugForm" autocomplete="off">
                        <textarea
                            id="bugDesc"
                            class="bug-input bug-input--desc"
                            rows="5"
                            maxlength="${BUG_DESC_MAX}"
                            data-i18n-placeholder="bug.desc.placeholder"
                            placeholder="${t("bug.desc.placeholder")}"
                            required
                        ></textarea>

                        <div class="bug-field">
                            <input
                                type="text"
                                id="bugContact"
                                class="bug-input"
                                maxlength="${BUG_CONTACT_MAX}"
                                data-i18n-placeholder="bug.contact.placeholder"
                                placeholder="${t("bug.contact.placeholder")}"
                            />
                            <span class="bug-hint" data-i18n="bug.contact.hint">${t("bug.contact.hint")}</span>
                        </div>

                        <div class="bug-error" id="bugError" aria-live="polite"></div>

                        <button type="submit" class="bug-submit" id="bugSubmit"
                            data-label-idle="${t("bug.submit")}"
                            data-label-sending="${t("bug.submitting")}">
                            <span class="bug-submit-label" data-i18n="bug.submit">${t("bug.submit")}</span>
                        </button>
                    </form>
                </div>

                <div class="bug-view bug-view--success" id="bugSuccessView" hidden>
                    <svg class="bug-success-heart" viewBox="0 0 24 24" aria-hidden="true">
                        <path d="M12 21s-7-4.35-9.5-8.5C.7 9 2.6 5 6.2 5c2 0 3.4 1.1 4.3 2.4l1.5 2 1.5-2C14.4 6.1 15.8 5 17.8 5c3.6 0 5.5 4 3.7 7.5C19 16.65 12 21 12 21z"/>
                    </svg>
                    <h2 class="bug-title" data-i18n="bug.thanks.title">${t("bug.thanks.title")}</h2>
                    <p class="bug-body" data-i18n="bug.thanks.body">${t("bug.thanks.body")}</p>
                    <button type="button" class="bug-success-close" id="bugSuccessClose" data-i18n="bug.thanks.close">${t("bug.thanks.close")}</button>
                </div>
            </div>
        `;

        document.body.appendChild(bugModalEl);

        bugFormViewEl    = bugModalEl.querySelector("#bugFormView");
        bugSuccessViewEl = bugModalEl.querySelector("#bugSuccessView");
        bugDescEl        = bugModalEl.querySelector("#bugDesc");
        bugContactEl     = bugModalEl.querySelector("#bugContact");
        bugSubmitEl      = bugModalEl.querySelector("#bugSubmit");
        bugErrorEl       = bugModalEl.querySelector("#bugError");

        bugModalEl.querySelector("#bugBackdrop").addEventListener("click", closeBugModal);
        bugModalEl.querySelector("#bugClose").addEventListener("click", closeBugModal);
        bugModalEl.querySelector("#bugSuccessClose").addEventListener("click", closeBugModal);
        bugModalEl.querySelector("#bugForm").addEventListener("submit", submitBugReport);
    }

    function openBugModal() {
        if (!bugModalEl) return;
        /* Возвращаемся к форме (на случай если предыдущее открытие закончилось success). */
        showBugFormView();
        bugErrorEl.textContent = "";
        bugErrorEl.classList.remove("is-visible");
        bugModalEl.classList.add("is-open");
        bugModalEl.setAttribute("aria-hidden", "false");
        /* Микро-задержка чтобы анимация открытия не съела focus. */
        setTimeout(() => bugDescEl?.focus(), 60);
    }

    function closeBugModal() {
        if (!bugModalEl) return;
        bugModalEl.classList.remove("is-open");
        bugModalEl.setAttribute("aria-hidden", "true");
    }

    function showBugFormView() {
        bugFormViewEl.hidden = false;
        bugSuccessViewEl.hidden = true;
    }

    function showBugSuccessView() {
        bugFormViewEl.hidden = true;
        bugSuccessViewEl.hidden = false;
    }

    async function submitBugReport(e) {
        e.preventDefault();
        if (bugSubmitting) return;

        const description = (bugDescEl.value || "").trim();
        const contact = (bugContactEl.value || "").trim().slice(0, BUG_CONTACT_MAX);

        if (!description) {
            showBugError(t("bug.error.empty"));
            return;
        }

        bugSubmitting = true;
        bugSubmitEl.disabled = true;
        bugSubmitEl.querySelector(".bug-submit-label").textContent =
            bugSubmitEl.dataset.labelSending;
        bugErrorEl.classList.remove("is-visible");

        /* log.bugReport() возвращает JSON-строку. На свежей вкладке без peers
           она будет короткой; в активной комнате — до десятков КБ. Сервер
           сам режет до safe-limit'а, здесь не паримся о размере. */
        let report = "";
        try {
            if (window.log?.bugReport) report = await window.log.bugReport();
        } catch (_) { /* не критично — отправим без него */ }

        try {
            const res = await fetch((window.VoidApiBase || "") + "/api/report-bug", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    description: description.slice(0, BUG_DESC_MAX),
                    contact,
                    report,
                    lang: state.lang
                })
            });
            if (res.status === 429) {
                showBugError(t("bug.error.rate"));
                return;
            }
            if (!res.ok) {
                showBugError(t("bug.error"));
                return;
            }
            /* Очищаем форму, чтобы при следующем открытии было чисто. */
            bugDescEl.value = "";
            bugContactEl.value = "";
            showBugSuccessView();
        } catch (_) {
            showBugError(t("bug.error"));
        } finally {
            bugSubmitting = false;
            bugSubmitEl.disabled = false;
            bugSubmitEl.querySelector(".bug-submit-label").textContent =
                bugSubmitEl.dataset.labelIdle;
        }
    }

    function showBugError(msg) {
        bugErrorEl.textContent = msg;
        bugErrorEl.classList.add("is-visible");
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

    /** Синхронизирует слайдер «масштаб интерфейса» с текущим state.uiScale.
     *  Вызывается на init и после программных изменений (например, если
     *  setUiScale зовётся из консоли). */
    function applyUiScaleSliderUI() {
        if (!uiScaleEl) return;
        const pct = Math.round(state.uiScale * 100);
        uiScaleEl.value = String(pct);
        if (uiScaleValueEl) uiScaleValueEl.textContent = pct + "%";
    }

    function applyBgThemeSegUI() {
        if (!bgThemeSegEl) return;
        bgThemeSegEl.querySelectorAll(".settings-seg-btn").forEach(b => {
            b.classList.toggle("is-active", b.dataset.val === state.bgTheme);
        });
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

        if (uiScaleEl) {
            /* input — live во время drag'а: обновляем только цифру справа,
               НЕ применяя scale. Иначе во время drag'а размеры всего
               интерфейса (включая сам слайдер) пересчитываются, и thumb
               уезжает из-под курсора — управлять невозможно.
               change — apply при отпускании: scale применяется один раз. */
            uiScaleEl.addEventListener("input", () => {
                if (uiScaleValueEl) uiScaleValueEl.textContent = uiScaleEl.value + "%";
            });
            uiScaleEl.addEventListener("change", () => {
                setUiScale(Number(uiScaleEl.value) / 100);
            });
        }

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

    /* M5.6 (v0.9.21): focus trap внутри открытой панели. До этого Tab из
       панели вылетал наружу — на скрытые под scrim'ом кнопки страницы.
       Helper зацикливает Tab между первым и последним focusable элементом
       внутри panelEl. Возвращает cleanup-функцию для closePanel. */
    let _settingsTrapCleanup = null;

    function trapSettingsFocus() {
        if (!panelEl) return null;
        const sel = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
        const onKey = (e) => {
            if (e.key !== "Tab") return;
            const items = Array.from(panelEl.querySelectorAll(sel))
                .filter(n => !n.hasAttribute("disabled") && n.offsetParent !== null);
            if (items.length === 0) return;
            const first = items[0];
            const last = items[items.length - 1];
            if (e.shiftKey && document.activeElement === first) {
                e.preventDefault();
                last.focus();
            } else if (!e.shiftKey && document.activeElement === last) {
                e.preventDefault();
                first.focus();
            }
        };
        panelEl.addEventListener("keydown", onKey);
        return () => panelEl.removeEventListener("keydown", onKey);
    }

    function openPanel() {
        if (!panelEl) return;
        dismissSettingsHint();
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
        /* Tab-trap + начальный фокус на close-кнопку. Без начального фокуса
           внутри панели Tab бы продолжил с gearBtn и вылетел за пределы
           (DOM-порядок ≠ визуальный порядок). preventScroll — чтобы открытие
           панели не дёргало основной layout. */
        _settingsTrapCleanup = trapSettingsFocus();
        requestAnimationFrame(() => {
            panelEl.querySelector("#settingsClose")?.focus({ preventScroll: true });
        });
    }

    function closePanel() {
        if (!panelEl) return;
        stopPreview();
        panelEl.classList.remove("is-open");
        panelEl.setAttribute("aria-hidden", "true");
        scrimEl.classList.remove("is-open");
        scrimEl.setAttribute("aria-hidden", "true");
        if (gearBtn) gearBtn.setAttribute("aria-expanded", "false");
        _settingsTrapCleanup?.();
        _settingsTrapCleanup = null;
        /* Возвращаем фокус на gear-кнопку, с которой панель была открыта —
           keyboard-only-юзер не теряет ориентацию. */
        gearBtn?.focus({ preventScroll: true });
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
        applyBgThemeSegUI();
        applyUiScaleSliderUI();
        applyNickInputUI();
        /* Применяем сохранённый uiScale на корень. Inline-скрипт в <head>
           уже сделал это до загрузки CSS (без FOUC), но дублируем для
           случая, когда state.uiScale пришёл из дефолтов / был перезаписан
           в loadState нормализацией. */
        document.documentElement.style.setProperty("--ui-scale", state.uiScale);
        /* Hint показываем ТОЛЬКО после того, как intro-экран ушёл и
           пользователь увидел шапку с шестерёнкой. Иначе стрелка торчит
           поверх intro и сбивает с толку. Event диспатчит intro.js из
           unlockApp() и skipIntroAndShowApp(). Если app уже visible на
           момент init (race / intro отключён) — строим сразу. */
        if (document.querySelector(".app.visible")) {
            buildSettingsHint();
        } else {
            document.addEventListener("void:app-unlocked", buildSettingsHint, { once: true });
        }
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
        getBgTheme, getUiScale,
        setLang, setStreamer, setNickname,
        setAudioInId, setAudioOutId, setAudioInGain, setAudioOutGain,
        setBgTheme, setUiScale,
        openPanel, closePanel
    };
})();
