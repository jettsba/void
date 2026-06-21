/* ========= SETTINGS + I18N =========
   Единый модуль: словари, t(), applyI18n(), localStorage state, панель.
   Загружается ПЕРВЫМ скриптом — script.js/chat.js используют t() и слушают
   событие "void:locale-changed" чтобы перерисовать динамические надписи.
*/

(function () {
    "use strict";

    const APP_VERSION = "0.12.11";
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
        /* Шумоподавление (RNNoise + штатный NS). Применяется при следующем
           (пере)входе в комнату — как и смена микрофона. webrtc.js читает
           через VoidSettings.getNoiseSuppression() при сборке аудио-графа. */
        noiseSuppression: true,
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
        autoStart: false,
        /* Общий выключатель глобальных хоткеев (desktop). Управляется в
           app-settings.js (модалка «горячие клавиши»), но хранится в этом же
           STORAGE_KEY — поэтому держим поле и здесь, иначе saveState() затёр бы
           его при любом изменении других настроек. */
        hotkeysEnabled: true
    };

    const BG_THEMES = ["silence", "nebula", "grid"];

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
            "footer.copy.streamer": "пригласить",
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
            "settings.cat.profile": "профиль",
            "settings.cat.audio": "аудио",
            "settings.cat.interface": "интерфейс",
            "settings.cat.hotkeys": "горячие клавиши",
            "settings.cat.app": "приложение",
            "settings.cat.on": "вкл",
            "settings.cat.off": "выкл",

            "hotkeys.master": "горячие клавиши",
            "hotkeys.master.hint": "общий выключатель всех комбинаций",
            "hotkeys.action.toggleMic": "микрофон вкл/выкл",
            "hotkeys.action.toggleSound": "звук вкл/выкл",
            "hotkeys.action.toggleWindow": "показать/скрыть окно",
            "hotkeys.action.leaveRoom": "покинуть комнату",
            "hotkeys.webhint": "в web-версии хоткеи работают только при открытой вкладке",

            "app.title": "настройки приложения",
            "app.close.label": "при закрытии окна",
            "app.close.hint": "что делает кнопка закрытия окна",
            "app.close.minimize.title": "свернуть в трей",
            "app.close.minimize.sub": "продолжит работать в фоне",
            "app.close.quit.title": "закрыть полностью",
            "app.close.quit.sub": "выход из приложения",
            "app.autostart.label": "запускать при старте windows",
            "app.autostart.hint": "откроется автоматически при входе в систему",

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
            "settings.audio.noise": "шумоподавление",
            "settings.audio.noise.hint": "убирает фоновый шум микрофона",
            "settings.audio.device": "устройство",
            "settings.uiScale.apply": "применить",
            "settings.profile.copy": "скопировать id",

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
            "invite.copied": "скопировано",

            "deeplink.invite": "вас пригласили в комнату #{code}",
            "deeplink.open-app": "открыть в приложении",
            "deeplink.continue-web": "продолжить в браузере",
            "deeplink.fallback": "приложение не открылось?",
            "deeplink.download": "скачать приложение"
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
            "footer.copy.streamer": "invite",
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
            "settings.cat.profile": "profile",
            "settings.cat.audio": "audio",
            "settings.cat.interface": "interface",
            "settings.cat.hotkeys": "hotkeys",
            "settings.cat.app": "application",
            "settings.cat.on": "on",
            "settings.cat.off": "off",

            "hotkeys.master": "hotkeys",
            "hotkeys.master.hint": "master switch for all shortcuts",
            "hotkeys.action.toggleMic": "mic on/off",
            "hotkeys.action.toggleSound": "sound on/off",
            "hotkeys.action.toggleWindow": "show/hide window",
            "hotkeys.action.leaveRoom": "leave room",
            "hotkeys.webhint": "in the web version hotkeys work only while the tab is open",

            "app.title": "application settings",
            "app.close.label": "on window close",
            "app.close.hint": "what the close button does",
            "app.close.minimize.title": "minimize to tray",
            "app.close.minimize.sub": "keeps running in the background",
            "app.close.quit.title": "quit completely",
            "app.close.quit.sub": "exits the app",
            "app.autostart.label": "launch on windows startup",
            "app.autostart.hint": "opens automatically on system login",

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
            "settings.audio.noise": "noise suppression",
            "settings.audio.noise.hint": "removes microphone background noise",
            "settings.audio.device": "device",
            "settings.uiScale.apply": "apply",
            "settings.profile.copy": "copy id",

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
            "invite.copied": "copied",

            "deeplink.invite": "you've been invited to room #{code}",
            "deeplink.open-app": "open in the app",
            "deeplink.continue-web": "continue in browser",
            "deeplink.fallback": "app didn't open?",
            "deeplink.download": "download the app"
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
                if (typeof parsed.noiseSuppression === "boolean") state.noiseSuppression = parsed.noiseSuppression;
                if (typeof parsed.bgTheme === "string") {
                    /* Миграция: старое имя темы "void-grid" → "grid". */
                    const bg = parsed.bgTheme === "void-grid" ? "grid" : parsed.bgTheme;
                    if (BG_THEMES.indexOf(bg) !== -1) state.bgTheme = bg;
                }
                if (typeof parsed.uiScale === "number" && isFinite(parsed.uiScale)) {
                    state.uiScale = clampGain(parsed.uiScale, UI_SCALE_MIN, UI_SCALE_MAX);
                }
                if (parsed.closeAction === "minimize" || parsed.closeAction === "close") {
                    state.closeAction = parsed.closeAction;
                }
                if (typeof parsed.autoStart === "boolean") state.autoStart = parsed.autoStart;
                if (typeof parsed.hotkeysEnabled === "boolean") state.hotkeysEnabled = parsed.hotkeysEnabled;
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
    function getNoiseSuppression() { return state.noiseSuppression; }

    function setNoiseSuppression(on) {
        const next = !!on;
        if (state.noiseSuppression === next) return;
        state.noiseSuppression = next;
        saveState();
        document.dispatchEvent(new CustomEvent("void:noise-suppression-changed", { detail: { on: next } }));
    }

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
    let uiScaleEl, uiScaleValueEl, uiScaleApplyEl, scalePreviewInnerEl;
    let noiseToggleEl, spkMeterFillEl;
    let micDropdown, spkDropdown,
        micGainEl, spkGainEl,
        micGainValueEl, spkGainValueEl,
        micMeterFillEl, spkTestBtnEl,
        audioHintEl;
    /* Ожидающий применения масштаб (слайдер двигается — превью живёт сразу,
       глобальный --ui-scale меняется только по клику на «применить»). */
    let pendingUiScale = null;
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

    /* Эквалайзер выхода (динамики): отдельный AudioContext/analyser, к которому
       подключаем все играющие удалённые медиа-стримы (peer-audio, screen-overlay).
       Анализ не трогает воспроизведение — элементы продолжают играть в свой sink.
       Живёт только пока открыта аудио-модалка. */
    let spkMeterCtx = null;
    let spkMeterAnalyser = null;
    let spkMeterRaf = null;
    let spkMeterSources = [];

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

                <nav class="settings-cats">
                    <button type="button" class="settings-cat" id="settingsCatProfile">
                        <svg class="settings-cat-icon" viewBox="0 0 24 24" aria-hidden="true">
                            <circle cx="12" cy="8" r="3.6"/>
                            <path d="M4.5 20.5c0-3.6 3.4-5.5 7.5-5.5s7.5 1.9 7.5 5.5"/>
                        </svg>
                        <span class="settings-cat-label" data-i18n="settings.cat.profile">${t("settings.cat.profile")}</span>
                        <span class="settings-cat-value" id="catValueProfile"></span>
                        <svg class="settings-cat-arrow" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>
                    </button>

                    <button type="button" class="settings-cat" id="settingsCatAudio">
                        <svg class="settings-cat-icon" viewBox="0 0 24 24" aria-hidden="true">
                            <rect x="9" y="3" width="6" height="11" rx="3"/>
                            <path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>
                        </svg>
                        <span class="settings-cat-label" data-i18n="settings.cat.audio">${t("settings.cat.audio")}</span>
                        <span class="settings-cat-value" id="catValueAudio"></span>
                        <svg class="settings-cat-arrow" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>
                    </button>

                    <button type="button" class="settings-cat" id="settingsCatInterface">
                        <svg class="settings-cat-icon" viewBox="0 0 24 24" aria-hidden="true">
                            <circle cx="12" cy="12" r="9"/>
                            <path d="M12 3v18a9 9 0 0 0 0-18z"/>
                        </svg>
                        <span class="settings-cat-label" data-i18n="settings.cat.interface">${t("settings.cat.interface")}</span>
                        <span class="settings-cat-value" id="catValueInterface"></span>
                        <svg class="settings-cat-arrow" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>
                    </button>

                    <button type="button" class="settings-cat" id="settingsHotkeysBtn">
                        <svg class="settings-cat-icon" viewBox="0 0 24 24" aria-hidden="true">
                            <rect x="2" y="6" width="20" height="12" rx="2"/>
                            <path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10"/>
                        </svg>
                        <span class="settings-cat-label" data-i18n="settings.cat.hotkeys">${t("settings.cat.hotkeys")}</span>
                        <span class="settings-cat-value" id="catValueHotkeys"></span>
                        <svg class="settings-cat-arrow" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>
                    </button>

                    <button type="button" class="settings-cat" id="settingsAppBtn">
                        <svg class="settings-cat-icon" viewBox="0 0 24 24" aria-hidden="true">
                            <circle cx="12" cy="12" r="3.2"/>
                            <path d="M12 2v3.2M12 18.8V22M2 12h3.2M18.8 12H22M4.9 4.9l2.3 2.3M16.8 16.8l2.3 2.3M19.1 4.9l-2.3 2.3M7.2 16.8l-2.3 2.3"/>
                        </svg>
                        <span class="settings-cat-label" data-i18n="settings.cat.app">${t("settings.cat.app")}</span>
                        <span class="settings-cat-value" id="catValueApp"></span>
                        <svg class="settings-cat-arrow" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>
                    </button>
                </nav>

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

        /* Контролы категорий живут в собственных модалках (profile/audio/interface),
           а не внутри самой панели. Строим их ДО получения ссылок на элементы —
           id сохранены, поэтому вся существующая логика ниже работает без правок,
           меняется только место поиска (document вместо panelEl). */
        buildCategoryModals();

        const $ = (id) => document.getElementById(id);
        langSegEl = $("settingsLangSeg");
        bgThemeSegEl = $("settingsBgThemeSeg");
        streamerInputEl = $("settingsStreamerInput");
        nickFormEl = $("settingsNickForm");
        nickInputEl = $("settingsNickInput");
        nickSavedEl = $("settingsNickSaved");
        micGainEl = $("settingsMicGain");
        spkGainEl = $("settingsSpkGain");
        micGainValueEl = $("settingsMicGainValue");
        spkGainValueEl = $("settingsSpkGainValue");
        micMeterFillEl = $("settingsMicMeterFill");
        spkTestBtnEl = $("settingsSpkTest");
        audioHintEl = $("settingsAudioHint");
        uiScaleEl = $("settingsUiScale");
        uiScaleValueEl = $("settingsUiScaleValue");
        uiScaleApplyEl = $("settingsUiScaleApply");
        scalePreviewInnerEl = $("scalePreviewInner");
        noiseToggleEl = $("settingsNoiseToggle");
        spkMeterFillEl = $("settingsSpkMeterFill");

        micDropdown = createDropdown($("settingsMicDropdown"), {
            onChange: (v) => {
                setAudioInId(v);
                restartPreview();
                showAudioHint(t("settings.audio.applyOnRejoin"));
            }
        });
        spkDropdown = createDropdown($("settingsSpkDropdown"), {
            onChange: (v) => setAudioOutId(v)
        });

        bindAudioControls();

        langSegEl.addEventListener("click", e => {
            const btn = e.target.closest(".vseg-btn");
            if (!btn) return;
            setLang(btn.dataset.val);
            updateCatValues();
        });

        bgThemeSegEl?.addEventListener("click", e => {
            const btn = e.target.closest(".bg-thumb");
            if (!btn) return;
            setBgTheme(btn.dataset.val);
            updateCatValues();
        });

        streamerInputEl.addEventListener("change", () => {
            setStreamer(streamerInputEl.checked);
        });

        noiseToggleEl?.addEventListener("change", () => {
            /* Применяется на лету (webrtc слушает void:noise-suppression-changed
               и пересобирает mic-граф, если в комнате). Подсказку не дублируем —
               она уже есть строкой под лейблом. */
            setNoiseSuppression(noiseToggleEl.checked);
        });

        nickFormEl.addEventListener("submit", (e) => {
            e.preventDefault();
            const saved = setNickname(nickInputEl.value);
            /* После sanitize реальное значение может отличаться от ввода
               (обрезали пробелы / control chars / длину). Возвращаем
               пользователю то, что реально сохранили. */
            nickInputEl.value = saved;
            flashNickSaved();
            updateCatValues();
        });

        scrimEl.addEventListener("click", closePanel);
        panelEl.querySelector("#settingsClose").addEventListener("click", closePanel);

        /* Категории, контролы которых лежат в собственных модалках. Хоткеи и
           «приложение» открываются делегатом в app-settings.js (id сохранены). */
        panelEl.querySelector("#settingsCatProfile")
            .addEventListener("click", () => openCatModal(profileModalEl, onProfileModalOpen));
        panelEl.querySelector("#settingsCatAudio")
            .addEventListener("click", () => openCatModal(audioModalEl, onAudioModalOpen));
        panelEl.querySelector("#settingsCatInterface")
            .addEventListener("click", () => openCatModal(interfaceModalEl, onInterfaceModalOpen));

        supportBtnEl = panelEl.querySelector("#settingsSupportBtn");
        supportBtnEl?.addEventListener("click", openSupportModal);

        bugBtnEl = panelEl.querySelector("#settingsBugBtn");
        bugBtnEl?.addEventListener("click", openBugModal);

        buildSupportModal();
        buildBugModal();

        document.addEventListener("keydown", e => {
            if (e.key !== "Escape") return;
            /* Закрываем по иерархии: QR → support → bug → cat-modal → панель. */
            if (supportQrModalEl?.classList.contains("is-open")) { closeSupportQr(); return; }
            if (supportModalEl?.classList.contains("is-open")) { closeSupportModal(); return; }
            if (bugModalEl?.classList.contains("is-open")) { closeBugModal(); return; }
            if (currentCatModal) { closeCatModal(currentCatModal); return; }
            if (panelEl.classList.contains("is-open")) closePanel();
        });
    }

    /* ===== category modals (profile / audio / interface) =====
       Главная панель теперь — список категорий; контролы каждой вынесены в
       отдельное окно, открывающееся поверх панели (как hotkeys/app в
       app-settings.js). DOM контролов идентичен прежнему — те же id и классы,
       поэтому createDropdown / bindAudioControls / nick-form / i18n работают
       без изменений. */

    let profileModalEl = null, audioModalEl = null, interfaceModalEl = null;
    let currentCatModal = null, lastCatTrigger = null;

    function buildCatModalShell(id, titleKey, bodyHTML, iconSvg) {
        const el = document.createElement("div");
        el.className = "cat-modal";
        el.id = id;
        el.setAttribute("aria-hidden", "true");
        el.setAttribute("role", "dialog");
        el.setAttribute("aria-modal", "true");
        el.innerHTML = `
            <div class="cat-modal-backdrop" data-cat-close></div>
            <div class="cat-modal-card">
                <header class="cat-modal-header">
                    <span class="cat-modal-heading">
                        ${iconSvg ? `<span class="cat-modal-ic" aria-hidden="true">${iconSvg}</span>` : ""}
                        <span class="cat-modal-title" data-i18n="${titleKey}">${t(titleKey)}</span>
                    </span>
                    <button type="button" class="cat-modal-close" data-cat-close
                        aria-label="${t("chat.close")}" data-i18n-attr="aria-label:chat.close">
                        <svg viewBox="0 0 24 24" aria-hidden="true">
                            <path d="M6 6l12 12"/>
                            <path d="M18 6L6 18"/>
                        </svg>
                    </button>
                </header>
                <div class="cat-modal-body">${bodyHTML}</div>
            </div>
        `;
        document.body.appendChild(el);
        el.querySelectorAll("[data-cat-close]").forEach(b =>
            b.addEventListener("click", () => closeCatModal(el)));
        return el;
    }

    function buildCategoryModals() {
        if (document.getElementById("catModalProfile")) return;

        profileModalEl = buildCatModalShell("catModalProfile", "settings.cat.profile", `
            <div class="profile-card">
                <div class="profile-avatar" id="profileAvatar" aria-hidden="true">—</div>
                <div class="profile-ident">
                    <span class="profile-name" id="profileName">—</span>
                    <button type="button" class="profile-uid" id="profileUidCopy"
                        data-i18n-attr="aria-label:settings.profile.copy"
                        aria-label="${t("settings.profile.copy")}">
                        <span class="profile-uid-text" id="profileUid">uid-····-····</span>
                        <svg class="profile-uid-icon" viewBox="0 0 24 24" aria-hidden="true">
                            <rect x="9" y="9" width="11" height="11" rx="1.4"/>
                            <path d="M5 15V5.5A1.5 1.5 0 0 1 6.5 4H15"/>
                        </svg>
                        <span class="profile-uid-copied" data-i18n="support.copied">${t("support.copied")}</span>
                    </button>
                </div>
            </div>

            <div class="iface-divider"></div>

            <div class="field-block">
                <span class="field-label" data-i18n="settings.nick">${t("settings.nick")}</span>
                <span class="field-hint" data-i18n="settings.nick.hint">${t("settings.nick.hint")}</span>
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
                        data-i18n-attr="aria-label:settings.nick.save"
                        aria-label="${t("settings.nick.save")}"
                    >
                        <svg viewBox="0 0 24 24" aria-hidden="true">
                            <path d="M5 12l5 5 9-11"/>
                        </svg>
                    </button>
                    <span class="settings-nick-saved" id="settingsNickSaved" aria-live="polite" data-i18n="settings.nick.saved">${t("settings.nick.saved")}</span>
                </form>
            </div>
        `, `<svg viewBox="0 0 24 24"><circle cx="12" cy="8" r="3.6"/><path d="M4.5 20.5c0-3.6 3.4-5.5 7.5-5.5s7.5 1.9 7.5 5.5"/></svg>`);

        audioModalEl = buildCatModalShell("catModalAudio", "settings.cat.audio", `
            <div class="audio-faders">
                <div class="fader-card">
                    <div class="fader-top">
                        <div class="fader-valrow">
                            <span class="fader-value" id="settingsMicGainValue"><b>100</b>%</span>
                        </div>
                        <div class="fader-rail">
                            <div class="vslider-wrap">
                                <input type="range" id="settingsMicGain" class="vslider"
                                    min="0" max="150" step="1" aria-label="${t("settings.audio.gainIn")}"/>
                            </div>
                            <div class="vmeter" aria-hidden="true">
                                <div class="vmeter-fill" id="settingsMicMeterFill"></div>
                                <div class="vmeter-grid"></div>
                            </div>
                        </div>
                        <span class="fader-label" data-i18n="settings.audio.mic">${t("settings.audio.mic")}</span>
                    </div>
                    <div class="settings-dropdown audio-device" id="settingsMicDropdown">
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
                </div>

                <div class="fader-card">
                    <div class="fader-top">
                        <div class="fader-valrow">
                            <span class="fader-value" id="settingsSpkGainValue"><b>100</b>%</span>
                            <button type="button" id="settingsSpkTest" class="audio-test"
                                aria-label="${t("settings.audio.test")}"
                                data-i18n-attr="aria-label:settings.audio.test">
                                <svg viewBox="0 0 24 24" aria-hidden="true">
                                    <path d="M7 5l12 7-12 7V5z"/>
                                </svg>
                            </button>
                        </div>
                        <div class="fader-rail">
                            <div class="vslider-wrap">
                                <input type="range" id="settingsSpkGain" class="vslider"
                                    min="0" max="100" step="1" aria-label="${t("settings.audio.gainOut")}"/>
                            </div>
                            <div class="vmeter vmeter--screen" aria-hidden="true">
                                <div class="vmeter-fill" id="settingsSpkMeterFill"></div>
                                <div class="vmeter-grid"></div>
                            </div>
                        </div>
                        <span class="fader-label" data-i18n="settings.audio.speakers">${t("settings.audio.speakers")}</span>
                    </div>
                    <div class="settings-dropdown audio-device" id="settingsSpkDropdown">
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
                </div>
            </div>

            <div class="iface-divider"></div>

            <label class="toggle-row">
                <span class="toggle-row-text">
                    <span class="toggle-row-label" data-i18n="settings.audio.noise">${t("settings.audio.noise")}</span>
                    <span class="toggle-row-hint" data-i18n="settings.audio.noise.hint">${t("settings.audio.noise.hint")}</span>
                </span>
                <span class="vswitch">
                    <input type="checkbox" id="settingsNoiseToggle"/>
                    <span class="vswitch-track"></span>
                </span>
            </label>

        `, `<svg viewBox="0 0 24 24"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>`);

        interfaceModalEl = buildCatModalShell("catModalInterface", "settings.cat.interface", `
            <div class="iface-row">
                <span class="iface-label" data-i18n="settings.lang">${t("settings.lang")}</span>
                <div class="vseg" id="settingsLangSeg" role="tablist">
                    <button type="button" class="vseg-btn" data-val="ru" role="tab">ru</button>
                    <button type="button" class="vseg-btn" data-val="en" role="tab">en</button>
                </div>
            </div>

            <div class="iface-divider"></div>

            <div class="iface-block" id="settingsBgThemeRow">
                <span class="iface-label" data-i18n="settings.bg">${t("settings.bg")}</span>
                <div class="bg-thumbs" id="settingsBgThemeSeg" role="tablist">
                    <!-- Названия тем намеренно НЕ локализованы — техника фона, не интерфейс. -->
                    <button type="button" class="bg-thumb" data-val="silence" role="tab">
                        <span class="bg-thumb-prev bg-thumb-prev--silence"></span>
                        <span class="bg-thumb-name">silence<span class="bg-thumb-dot"></span></span>
                    </button>
                    <button type="button" class="bg-thumb" data-val="nebula" role="tab">
                        <span class="bg-thumb-prev bg-thumb-prev--nebula"></span>
                        <span class="bg-thumb-name">nebula<span class="bg-thumb-dot"></span></span>
                    </button>
                    <button type="button" class="bg-thumb" data-val="grid" role="tab">
                        <span class="bg-thumb-prev bg-thumb-prev--grid"></span>
                        <span class="bg-thumb-name">grid<span class="bg-thumb-dot"></span></span>
                    </button>
                </div>
            </div>

            <div class="iface-divider"></div>

            <div class="iface-block" id="settingsUiScaleRow">
                <span class="iface-label" data-i18n="settings.uiScale">${t("settings.uiScale")}</span>
                <span class="iface-hint" data-i18n="settings.uiScale.hint">${t("settings.uiScale.hint")}</span>
                <div class="scale-preview">
                    <span class="scale-preview-inner" id="scalePreviewInner">
                        <span class="scale-preview-avatar" id="scalePreviewAvatar">—</span>
                        <span class="scale-preview-name" id="scalePreviewName">—</span>
                        <span class="scale-preview-meta">void</span>
                    </span>
                </div>
                <div class="scale-control">
                    <input type="range" id="settingsUiScale" class="hslider"
                        min="70" max="150" step="5" aria-label="${t("settings.uiScale")}"/>
                    <span class="scale-value" id="settingsUiScaleValue">100%</span>
                    <button type="button" class="scale-apply" id="settingsUiScaleApply" disabled
                        data-i18n-attr="aria-label:settings.uiScale.apply"
                        aria-label="${t("settings.uiScale.apply")}">
                        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12l5 5 9-11"/></svg>
                    </button>
                </div>
            </div>

            <div class="iface-divider"></div>

            <div class="iface-row">
                <span class="iface-text">
                    <span class="iface-label" data-i18n="settings.streamer">${t("settings.streamer")}</span>
                    <span class="iface-hint" data-i18n="settings.streamer.hint">${t("settings.streamer.hint")}</span>
                </span>
                <label class="vswitch">
                    <input type="checkbox" id="settingsStreamerInput"/>
                    <span class="vswitch-track"></span>
                </label>
            </div>
        `, `<svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="1.4"/><path d="M3 9.5h18M7 13.5h7"/></svg>`);

        /* Копирование UID из карточки профиля. */
        const uidCopyBtn = profileModalEl.querySelector("#profileUidCopy");
        uidCopyBtn?.addEventListener("click", async () => {
            const uid = profileModalEl.querySelector("#profileUid")?.textContent || "";
            if (!uid) return;
            try {
                await navigator.clipboard.writeText(uid);
            } catch (_) {
                try {
                    const ta = document.createElement("textarea");
                    ta.value = uid; ta.style.position = "fixed"; ta.style.opacity = "0";
                    document.body.appendChild(ta); ta.select();
                    document.execCommand("copy"); document.body.removeChild(ta);
                } catch (_) { return; }
            }
            uidCopyBtn.classList.add("is-copied");
            clearTimeout(uidCopyBtn._copyT);
            uidCopyBtn._copyT = setTimeout(() => uidCopyBtn.classList.remove("is-copied"), 1200);
        });

        /* i18n уже применён глобально на init, но модалки построены здесь —
           прогоним applyI18n по ним, чтобы плейсхолдеры/aria проставились. */
        applyI18n(profileModalEl);
        applyI18n(audioModalEl);
        applyI18n(interfaceModalEl);
    }

    function openCatModal(el, onOpen) {
        if (!el) return;
        lastCatTrigger = document.activeElement;
        currentCatModal = el;
        el.classList.add("is-open");
        el.setAttribute("aria-hidden", "false");
        if (typeof onOpen === "function") onOpen();
        requestAnimationFrame(() =>
            el.querySelector(".cat-modal-close")?.focus({ preventScroll: true }));
    }

    function closeCatModal(el) {
        if (!el) return;
        el.classList.remove("is-open");
        el.setAttribute("aria-hidden", "true");
        if (el === audioModalEl) { stopPreview(); stopSpkMeter(); }
        if (el === currentCatModal) currentCatModal = null;
        updateCatValues();
        /* Возвращаем фокус на строку категории, с которой модалка открыта. */
        if (lastCatTrigger && typeof lastCatTrigger.focus === "function") {
            lastCatTrigger.focus({ preventScroll: true });
        }
        lastCatTrigger = null;
    }

    function onAudioModalOpen() {
        applyAudioControlsFromState();
        populateDeviceSelects();
        startPreview();
        startSpkMeter();
    }

    function onInterfaceModalOpen() {
        applyLangToggleUI();
        applyStreamerToggleUI();
        applyBgThemeSegUI();
        applyUiScaleSliderUI();
        /* Превью масштаба показывает текущего пользователя. */
        const name = state.nickname || window.currentUsername || "void";
        const avatarEl = document.getElementById("scalePreviewAvatar");
        const nameEl = document.getElementById("scalePreviewName");
        if (avatarEl) avatarEl.textContent = profileInitials(name);
        if (nameEl) nameEl.textContent = name;
    }

    function onProfileModalOpen() {
        applyNickInputUI();
        populateProfileCard();
    }

    /* Инициалы для аватара: первые буквы двух слов, либо две буквы одного. */
    function profileInitials(name) {
        const n = String(name || "").trim();
        if (!n) return "—";
        const parts = n.split(/\s+/).filter(Boolean);
        const a = parts[0] ? parts[0][0] : "";
        const b = parts.length > 1 ? parts[parts.length - 1][0] : (parts[0] && parts[0][1] ? parts[0][1] : "");
        return (a + b).toLowerCase() || "—";
    }

    /* Короткий UID (FNV-1a → 8 hex). Технический ID — UPPERCASE по гайду. */
    function shortUid(seed) {
        const s = String(seed || "void");
        let h = 0x811c9dc5;
        for (let i = 0; i < s.length; i++) {
            h ^= s.charCodeAt(i);
            h = (h * 0x01000193) >>> 0;
        }
        const hex = h.toString(16).toUpperCase().padStart(8, "0");
        return `UID-${hex.slice(0, 4)}-${hex.slice(4, 8)}`;
    }

    /* Постоянный UID устройства. clientId генерируется заново каждую сессию,
       поэтому для «личного айди» в профиле храним стабильный seed в localStorage —
       так ID не меняется между запусками. Это не серверный аккаунт (приложение
       анонимное, p2p), а локальный идентификатор. */
    const UID_KEY = "void:uid";
    function getStableUid() {
        try {
            let u = localStorage.getItem(UID_KEY);
            if (!u) {
                u = shortUid(String(Date.now()) + ":" + Math.random());
                localStorage.setItem(UID_KEY, u);
            }
            return u;
        } catch {
            return shortUid(window.currentClientId || "void");
        }
    }

    function populateProfileCard() {
        const name = state.nickname || window.currentUsername || "";
        const avatarEl = document.getElementById("profileAvatar");
        const nameEl = document.getElementById("profileName");
        const uidEl = document.getElementById("profileUid");
        if (avatarEl) avatarEl.textContent = profileInitials(name);
        if (nameEl) {
            nameEl.textContent = name || "—";
            /* Золотое сияние ника контрибьютора — та же пасхалка, что в комнате
               (см. config.js isPremiumNickname + stage.css .premium). */
            const premium = typeof isPremiumNickname === "function" && isPremiumNickname(name);
            nameEl.classList.toggle("premium", !!premium);
        }
        if (uidEl) uidEl.textContent = getStableUid();
    }

    /* Сводные значения справа в строках категорий — короткий отпечаток
       текущего состояния, как в макете («en · silence · 100%»). */
    function updateCatValues() {
        const set = (id, text) => {
            const el = document.getElementById(id);
            if (el) el.textContent = text || "";
        };
        set("catValueProfile", state.nickname || (window.currentUsername || ""));
        set("catValueInterface", `${state.lang} · ${state.bgTheme} · ${Math.round(state.uiScale * 100)}%`);
        /* hotkeysEnabled живёт в том же STORAGE_KEY, но переключается из
           app-settings.js — поэтому читаем СВЕЖЕЕ значение из localStorage,
           а не из (возможно устаревшего) state. */
        let hkEnabled = state.hotkeysEnabled;
        try {
            const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
            if (typeof raw.hotkeysEnabled === "boolean") hkEnabled = raw.hotkeysEnabled;
        } catch {}
        set("catValueHotkeys", hkEnabled ? t("settings.cat.on") : t("settings.cat.off"));
        set("catValueApp", window.VoidPlatform === "desktop" ? "desktop" : "web");
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
        langSegEl.querySelectorAll(".vseg-btn").forEach(b => {
            b.classList.toggle("is-active", b.dataset.val === state.lang);
        });
    }

    function applyStreamerToggleUI() {
        if (!streamerInputEl) return;
        streamerInputEl.checked = !!state.streamer;
    }

    /** Синхронизирует слайдер «масштаб интерфейса» с текущим state.uiScale.
     *  Сбрасывает pending-значение и гасит кнопку «применить» (мы только что
     *  привели слайдер к уже применённому масштабу). */
    function applyUiScaleSliderUI() {
        if (!uiScaleEl) return;
        const pct = Math.round(state.uiScale * 100);
        uiScaleEl.value = String(pct);
        if (uiScaleValueEl) uiScaleValueEl.textContent = pct + "%";
        pendingUiScale = null;
        setScaleApplyEnabled(false);
        applyScalePreview(state.uiScale);
    }

    /* Превью масштаба: показываем будущий размер относительно уже применённого
       (модалка сама отрисована в текущем масштабе, поэтому previewScale=1 при
       совпадении). transform-origin слева — превью «растёт» вправо, не прыгает. */
    function applyScalePreview(targetScale) {
        if (!scalePreviewInnerEl) return;
        const rel = targetScale / (state.uiScale || 1);
        scalePreviewInnerEl.style.transform = `scale(${rel})`;
    }

    function setScaleApplyEnabled(on) {
        if (!uiScaleApplyEl) return;
        uiScaleApplyEl.disabled = !on;
        uiScaleApplyEl.classList.toggle("is-active", !!on);
    }

    function applyBgThemeSegUI() {
        if (!bgThemeSegEl) return;
        bgThemeSegEl.querySelectorAll(".bg-thumb").forEach(b => {
            b.classList.toggle("is-active", b.dataset.val === state.bgTheme);
        });
    }

    /* ===== AUDIO devices / sliders ===== */

    /* Колёсико мыши над range-слайдером: крутим вверх — громче, вниз — тише.
       Меняем value и диспатчим штатный `input` — вся логика (setAudioInGain,
       лейблы) остаётся одна. preventDefault, чтобы колесо не скроллило модалку. */
    const WHEEL_STEP = 5;
    function attachWheelToSlider(el) {
        el.addEventListener("wheel", (e) => {
            e.preventDefault();
            const min = Number(el.min), max = Number(el.max);
            const dir = e.deltaY < 0 ? 1 : -1;
            const next = Math.min(max, Math.max(min, Number(el.value) + dir * WHEEL_STEP));
            if (next === Number(el.value)) return;
            el.value = next;
            el.dispatchEvent(new Event("input", { bubbles: true }));
        }, { passive: false });
    }

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
        attachWheelToSlider(micGainEl);
        attachWheelToSlider(spkGainEl);

        if (uiScaleEl) {
            /* input — НЕ применяем масштаб глобально (иначе модалка и сам
               слайдер пересчитываются под курсором). Вместо этого: обновляем
               цифру, двигаем превью в реальном времени и «зажигаем» кнопку
               применения. Глобальный --ui-scale меняется только по клику на
               галочку справа от слайдера. */
            uiScaleEl.addEventListener("input", () => {
                const next = Number(uiScaleEl.value) / 100;
                pendingUiScale = next;
                if (uiScaleValueEl) uiScaleValueEl.textContent = uiScaleEl.value + "%";
                applyScalePreview(next);
                setScaleApplyEnabled(Math.abs(next - state.uiScale) > 1e-6);
            });
        }

        uiScaleApplyEl?.addEventListener("click", () => {
            if (pendingUiScale == null) return;
            setUiScale(pendingUiScale);
            /* applyUiScaleSliderUI пересинхронит превью/кнопку под новый масштаб. */
            applyUiScaleSliderUI();
            updateCatValues();
        });

        spkTestBtnEl?.addEventListener("click", playTestTone);

        /* devicechange — пользователь воткнул наушники, поменял USB-микрофон.
           Перебираем список без участия пользователя. */
        if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
            navigator.mediaDevices.addEventListener("devicechange", () => {
                if (audioModalEl?.classList.contains("is-open")) {
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
        /* Крупное число + мелкий «%» (см. .fader-value). */
        const fmt = (v) => `<b>${Math.round(v * 100)}</b>%`;
        if (micGainValueEl) micGainValueEl.innerHTML = fmt(state.audioInGain);
        if (spkGainValueEl) spkGainValueEl.innerHTML = fmt(state.audioOutGain);
        /* Метр динамиков НЕ привязан к положению фейдера — он показывает реальный
           воспроизводимый уровень (см. startSpkMeter, эквалайзер выхода). */
    }

    function applyAudioControlsFromState() {
        if (!micGainEl) return;
        micGainEl.value = String(Math.round(state.audioInGain * 100));
        spkGainEl.value = String(Math.round(state.audioOutGain * 100));
        updateGainLabels();
        if (noiseToggleEl) noiseToggleEl.checked = !!state.noiseSuppression;
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
        const spkRoot = document.getElementById("settingsSpkDropdown");
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
            /* Вертикальный метр — заполняется снизу вверх (height, не width). */
            micMeterFillEl.style.height = pct.toFixed(1) + "%";
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
            micMeterFillEl.style.height = "0%";
            micMeterFillEl.classList.remove("is-hot");
        }
    }

    /* ===== speaker output meter (эквалайзер выхода) ===== */

    function startSpkMeter() {
        stopSpkMeter();
        if (!spkMeterFillEl) return;
        const Ctx = window.AudioContext || window.webkitAudioContext;
        if (!Ctx) return;
        try {
            spkMeterCtx = new Ctx();
            spkMeterAnalyser = spkMeterCtx.createAnalyser();
            spkMeterAnalyser.fftSize = 256;
            spkMeterAnalyser.smoothingTimeConstant = 0.6;
            /* Подключаем все играющие удалённые медиа: <audio>/<video> с
               MediaStream-srcObject (peer-голос, демонстрация экрана). Локальный
               mic в DOM-аудио не сидит, поэтому в метр выхода не попадёт. */
            const media = Array.from(document.querySelectorAll("audio, video"));
            for (const el of media) {
                const s = el.srcObject;
                if (s && typeof s.getAudioTracks === "function" && s.getAudioTracks().length) {
                    try {
                        const src = spkMeterCtx.createMediaStreamSource(s);
                        src.connect(spkMeterAnalyser);
                        spkMeterSources.push(src);
                    } catch (_) { /* стрим без аудио / уже подключён — пропускаем */ }
                }
            }
            runSpkMeterLoop();
        } catch (_) {
            stopSpkMeter();
        }
    }

    function runSpkMeterLoop() {
        if (!spkMeterAnalyser) return;
        const data = new Uint8Array(spkMeterAnalyser.frequencyBinCount);
        const tick = () => {
            if (!spkMeterAnalyser || !spkMeterFillEl) { spkMeterRaf = null; return; }
            spkMeterAnalyser.getByteFrequencyData(data);
            let sum = 0;
            for (let i = 0; i < data.length; i++) sum += data[i];
            const avg = sum / data.length;
            /* Умножаем на текущую мастер-громкость — метр отражает то, что
               реально слышно. Нормируем к ~80 как у mic-метра. */
            const withVol = avg * state.audioOutGain;
            const pct = Math.min(100, (withVol / 80) * 100);
            spkMeterFillEl.style.height = pct.toFixed(1) + "%";
            spkMeterRaf = requestAnimationFrame(tick);
        };
        tick();
    }

    function stopSpkMeter() {
        if (spkMeterRaf) { cancelAnimationFrame(spkMeterRaf); spkMeterRaf = null; }
        spkMeterSources.forEach(s => { try { s.disconnect(); } catch (_) {} });
        spkMeterSources = [];
        if (spkMeterCtx) {
            try { spkMeterCtx.close(); } catch (_) {}
            spkMeterCtx = null;
        }
        spkMeterAnalyser = null;
        if (spkMeterFillEl) spkMeterFillEl.style.height = "0%";
    }

    async function restartPreview() {
        if (audioModalEl?.classList.contains("is-open")) {
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
        /* Контролы переехали в модалки категорий и инициализируются на open
           соответствующей модалки (превью микрофона, список устройств, поле
           ника). Здесь — только освежаем сводные значения в списке категорий
           (ник/язык/масштаб могли измениться извне). */
        updateCatValues();
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
        /* Если открыта модалка категории — закрываем её вместе с панелью
           (заодно гасит превью микрофона через closeCatModal/stopPreview). */
        if (currentCatModal) closeCatModal(currentCatModal);
        stopPreview();
        stopSpkMeter();
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
        /* Язык, выбранный в кастомном установщике, инжектится главным процессом
           один раз через initialization_script (window.__VOID_INSTALLER_LANG__).
           Перебивает сохранённый — это свежий осознанный выбор юзера при установке.
           Маркер на стороне Rust уже удалён, так что применяется только раз. */
        const installerLang = window.__VOID_INSTALLER_LANG__;
        if (installerLang === "ru" || installerLang === "en") {
            state.lang = installerLang;
            saveState();
        }
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
        updateCatValues();
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
        getNoiseSuppression, setNoiseSuppression,
        openPanel, closePanel,
        /* Освежить сводные значения строк категорий. Зовётся из app-settings.js
           после изменения хоткеев / app-настроек, чьи модалки живут там. */
        refreshCats: () => updateCatValues()
    };
})();
