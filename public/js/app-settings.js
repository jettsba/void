/* ============ App settings modals + hotkeys ============
   Кнопки в settings panel:
   - "настроить горячие клавиши" → модалка с 4 биндами (keydown capture)
   - "настройки приложения"      → модалка с close behavior + autostart

   Sync с Rust через Tauri events:
     emit  "void:set-close-behavior" { behavior }
     emit  "void:set-autostart"      { enabled }
     emit  "void:register-hotkeys"   { bindings }
     listen "void:autostart-state"   { enabled }
     listen "void:hotkey-pressed"    { action }  → JS вызывает existing toggleMic/etc.

   В web-сборке Tauri runtime отсутствует — emit'ы молча no-op, Tauri-listener'ы
   не подключаются. Вместо них вешаем DOM keydown-обработчик (см. ветку else в
   конце файла): хоткеи работают, пока вкладка в фокусе, без глобальной
   регистрации. Footer-плашка в hotkeys modal об этом предупреждает; в Фазе 9
   (детект web/desktop) скроем её на desktop. */

(function () {
    "use strict";

    const STORAGE_KEY = "void:settings";
    const HOTKEYS_KEY = "void:hotkeys";

    /* Дефолтные бинды. Порядок токенов обязан совпадать с buildAccelerator
       (Ctrl → Shift → Alt → Super), иначе сохранённый дефолт никогда не
       совпадёт с тем, что соберётся из живого события.

       На маке mic/sound скопированы с Discord: ⌘⇧M и ⌘⇧D — то, к чему у
       голосовых чатов уже привыкли руки.

       Оставшиеся два Discord не определяет вовсе (у него нет ни «покинуть
       канал», ни «показать окно» по умолчанию), и просто заменить Ctrl на Cmd
       там нельзя:
         ⌘⇧V — системная «вставить и согласовать стиль», занята везде;
         ⌘⇧Q — ВЫХОД ИЗ УЧЁТНОЙ ЗАПИСИ macOS. Повесить на неё «покинуть
                комнату» значит разлогинить человека посреди разговора.
       Option-комбинации тоже мимо: ⌥⇧Q печатает «Œ» — бинд с модификатором
       срабатывает и в поле ввода. Поэтому у этих двух на маке остаётся ⌃⇧:
       на macOS Ctrl не занят ни браузером, ни системой и символов не вводит. */
    const DEFAULT_HOTKEYS_WIN = {
        toggleMic:    "Ctrl+Shift+M",
        toggleSound:  "Ctrl+Shift+D",
        toggleWindow: "Ctrl+Shift+V",
        leaveRoom:    "Ctrl+Shift+Q"
    };
    const DEFAULT_HOTKEYS_MAC = {
        toggleMic:    "Shift+Super+M",   // ⌘⇧M — как в Discord
        toggleSound:  "Shift+Super+D",   // ⌘⇧D — как в Discord
        toggleWindow: "Ctrl+Shift+V",
        leaveRoom:    "Ctrl+Shift+Q"
    };
    const DEFAULT_HOTKEYS = window.VoidIsMac ? DEFAULT_HOTKEYS_MAC : DEFAULT_HOTKEYS_WIN;

    /* Клавиши, которые разрешено назначить БЕЗ модификатора.
       F-ряд — служебный, набору текста не мешает. Backquote (`/~) добавлен по
       просьбам: в играх это исторически «клавиша консоли», и люди ждут, что её
       можно повесить голой. Всё остальное модификатор требует — иначе бинд
       срабатывал бы на обычном наборе текста.
       Список именно белый, а не «всё, кроме букв»: на desktop голый бинд
       регистрируется глобально и забирает клавишу у всей системы, пока void
       запущен. Расширять — осознанно, по одной клавише. */
    const STANDALONE_KEYS = new Set(["Backquote"]);

    const HOTKEY_ROWS = [
        { action: "toggleMic",    labelKey: "hotkeys.action.toggleMic" },
        { action: "toggleSound",  labelKey: "hotkeys.action.toggleSound" },
        { action: "toggleWindow", labelKey: "hotkeys.action.toggleWindow" },
        { action: "leaveRoom",    labelKey: "hotkeys.action.leaveRoom" }
    ];

    /* i18n helper — словарь живёт в settings.js (VoidI18n). Модалки строятся
       заново на каждый open, поэтому подхватывают текущий язык. */
    function T(key) {
        return (window.VoidI18n && window.VoidI18n.t) ? window.VoidI18n.t(key) : key;
    }

    const isDesktop = window.VoidPlatform === "desktop";
    const tauriEvent = window.__TAURI__ && window.__TAURI__.event;

    /* Платформа для раскладки и подписей клавиш. На маке модификаторы и
       называются, и рисуются иначе (⌘⌥⌃⇧ вместо win/alt/ctrl), и нижний ряд
       физически другой — поэтому «клавиатура» в модалке и кэпы в списке биндов
       строятся по этому флагу. Сам акселератор от платформы НЕ зависит: Tauri
       понимает "Super" как Command на маке и как Win на Windows — меняется
       только показ. Детект — общий VoidIsMac из js/config.js (он грузится
       раньше), чтобы правило «мы на маке» не жило в двух копиях. */
    const IS_MAC = !!window.VoidIsMac;

    /* Tauri-unlisten'ы, привязанные к открытой модалке (напр. слушатели апдейтера
       в «настройках приложения»). Снимаются при закрытии модалки — чтобы не
       копить подписки при повторных открытиях. */
    let appModalCleanups = [];
    function trackCleanup(promise) {
        if (promise && typeof promise.then === "function") {
            promise.then((un) => appModalCleanups.push(un)).catch(() => {});
        }
    }

    /* Монолайн-иконки заголовков модалок (по гайду: stroke, round caps). */
    const ICON_KEYBOARD = `<svg viewBox="0 0 24 24"><rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10"/></svg>`;
    const ICON_RESTORE = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20.5 12a8.5 8.5 0 1 1-2.49-6.01"/><path d="M20.5 4.4v4.6h-4.6"/></svg>`;
    const ICON_APP = `<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3.2"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M19 5l-2 2M7 17l-2 2"/></svg>`;

    // -------------------- localStorage helpers --------------------

    function readAppState() {
        try {
            const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
            return {
                closeAction:
                    parsed.closeAction === "close" || parsed.closeAction === "minimize"
                        ? parsed.closeAction
                        : "minimize",
                autoStart: typeof parsed.autoStart === "boolean" ? parsed.autoStart : false,
                /* Общий выключатель глобальных хоткеев. Default — ВЫКЛЮЧЕНЫ,
                   и для новых установок, и после обновления: дефолтные
                   комбинации пересекались с внутриигровыми биндами, и «покинуть
                   комнату» / «полный мут» срабатывали посреди игры. О смене
                   дефолта сообщает баннер «что нового». */
                hotkeysEnabled: typeof parsed.hotkeysEnabled === "boolean" ? parsed.hotkeysEnabled : false
            };
        } catch {
            return { closeAction: "minimize", autoStart: false, hotkeysEnabled: false };
        }
    }

    function patchAppState(patch) {
        try {
            const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
            Object.assign(parsed, patch);
            localStorage.setItem(STORAGE_KEY, JSON.stringify(parsed));
        } catch {}
    }

    function readHotkeys() {
        try {
            const parsed = JSON.parse(localStorage.getItem(HOTKEYS_KEY) || "{}");
            const out = {};
            for (const k of Object.keys(DEFAULT_HOTKEYS)) {
                out[k] = typeof parsed[k] === "string" ? parsed[k] : DEFAULT_HOTKEYS[k];
            }
            return out;
        } catch {
            return { ...DEFAULT_HOTKEYS };
        }
    }

    function saveHotkeys(hotkeys) {
        try {
            localStorage.setItem(HOTKEYS_KEY, JSON.stringify(hotkeys));
        } catch {}
    }

    // -------------------- Initial Rust sync --------------------

    function pushClientStateToRust() {
        if (!tauriEvent) return;
        const s = readAppState();
        tauriEvent.emit("void:set-close-behavior", { behavior: s.closeAction }).catch(() => {});
        tauriEvent.emit("void:set-autostart", { enabled: s.autoStart }).catch(() => {});
        /* Выключенные хоткеи = регистрируем пустой набор (Rust снимает все
           глобальные биндинги). Иначе шлём актуальные. */
        tauriEvent.emit("void:register-hotkeys", { bindings: s.hotkeysEnabled ? readHotkeys() : {} }).catch(() => {});
    }

    // -------------------- Modal infra --------------------

    /* cardClass — необязательный модификатор карточки. Нужен, потому что шелл
       общий: клавиатурная карта требует широкой модалки, а «настройки
       приложения» и «что нового» на такой ширине разъезжаются. */
    function openModal(title, contentHTML, iconSvg, cardClass) {
        closeModalIfAny();
        const scrim = document.createElement("div");
        scrim.className = "app-modal-scrim";
        scrim.id = "appModalScrim";
        const card = document.createElement("div");
        card.className = "app-modal-card" + (cardClass ? " " + cardClass : "");
        card.setAttribute("role", "dialog");
        card.setAttribute("aria-modal", "true");
        card.innerHTML = `
            <header class="app-modal-header">
                <span class="app-modal-heading">
                    ${iconSvg ? `<span class="app-modal-ic" aria-hidden="true">${iconSvg}</span>` : ""}
                    <span class="app-modal-title">${title}</span>
                </span>
                <button type="button" class="app-modal-close" aria-label="закрыть">
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                        <path d="M6 6l12 12M18 6L6 18" />
                    </svg>
                </button>
            </header>
            <div class="app-modal-body">${contentHTML}</div>
        `;
        scrim.appendChild(card);
        document.body.appendChild(scrim);
        requestAnimationFrame(() => scrim.classList.add("is-open"));

        scrim.addEventListener("click", (e) => {
            if (e.target === scrim) closeModalIfAny();
        });
        card.querySelector(".app-modal-close").addEventListener("click", closeModalIfAny);
        document.addEventListener("keydown", escClose);
        return card;
    }

    function closeModalIfAny() {
        const scrim = document.getElementById("appModalScrim");
        if (!scrim) return;
        scrim.classList.remove("is-open");
        document.removeEventListener("keydown", escClose);
        appModalCleanups.forEach((un) => { try { un(); } catch (_) {} });
        appModalCleanups = [];
        setTimeout(() => scrim.remove(), 180);
    }

    function escClose(e) {
        if (e.key === "Escape") closeModalIfAny();
    }

    /* Генерик-шелл модалки наружу: им же пользуется «что нового»
       (js/desktop/whats-new.js). Один шелл на всех потребителей — один
       визуальный стандарт и одна реализация Esc/клика по scrim'у. */
    window.VoidAppModal = { open: openModal, close: closeModalIfAny };

    // -------------------- Hotkeys modal --------------------

    function openHotkeysModal() {
        const hotkeys = readHotkeys();
        const enabled = readAppState().hotkeysEnabled;
        const rowsHTML = HOTKEY_ROWS.map(
            ({ action, labelKey }) => `
                <div class="hotkey-row" data-action-row="${action}">
                    <span class="hotkey-label">${escape(T(labelKey))}</span>
                    <button type="button" class="hotkey-binding" data-action="${action}" data-accel="${escape(hotkeys[action] || "")}">${accelToKeycaps(hotkeys[action])}</button>
                </div>
            `
        ).join("");

        const card = openModal(
            T("hotkeys.master"),
            `
            <div class="app-modal-row app-modal-row--flush">
                <div class="app-modal-row-text">
                    <span class="app-modal-row-label">${escape(T("hotkeys.master"))}</span>
                    <span class="app-modal-row-hint">${escape(T("hotkeys.master.hint"))}</span>
                </div>
                <label class="sc-switch">
                    <input type="checkbox" id="appHotkeysEnabled" />
                    <span class="sc-switch-track"></span>
                </label>
            </div>

            <div class="app-modal-bindings" data-hotkeys-list>
                ${buildKeyboardHtml()}
                <div class="hotkey-rows">
                    ${rowsHTML}
                </div>
                <div class="hotkey-actions">
                    <button type="button" class="hotkey-restore" id="hotkeyRestore">
                        ${ICON_RESTORE}<span>${escape(T("hotkeys.restore"))}</span>
                    </button>
                </div>
            </div>
            <div class="app-modal-footer-hint" data-web-hotkeys-hint>
                <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 8v4M12 16h.01"/></svg>
                <span>${escape(T("hotkeys.webhint"))}</span>
            </div>
            `,
            ICON_KEYBOARD,
            "app-modal-card--wide"
        );

        const listEl = card.querySelector("[data-hotkeys-list]");
        const applyEnabledUI = (on) => {
            listEl.classList.toggle("is-disabled", !on);
            card.querySelectorAll(".hotkey-binding, .hotkey-restore").forEach((b) => { b.disabled = !on; });
        };

        const toggle = card.querySelector("#appHotkeysEnabled");
        toggle.checked = enabled;
        applyEnabledUI(enabled);
        toggle.addEventListener("change", () => {
            const on = !!toggle.checked;
            patchAppState({ hotkeysEnabled: on });
            applyEnabledUI(on);
            if (tauriEvent) {
                /* Вкл — регистрируем актуальные биндинги; выкл — пустой набор. */
                tauriEvent.emit("void:register-hotkeys", { bindings: on ? readHotkeys() : {} }).catch(() => {});
            }
            window.VoidSettings?.refreshCats?.();
        });

        card.querySelectorAll(".hotkey-row").forEach((row) => {
            const btn = row.querySelector(".hotkey-binding");
            /* Наведение на строку подсвечивает её клавиши на «клавиатуре». */
            row.addEventListener("mouseenter", () => highlightKeyboard(card, btn.dataset.accel));
            row.addEventListener("mouseleave", () => { if (!activeCapture) highlightKeyboard(card, ""); });
            btn.addEventListener("click", () => {
                if (btn.disabled) return;
                startCapture(btn);
            });
        });

        /* «Восстановить» — вернуть все четыре бинда к DEFAULT_HOTKEYS. Общий
           тумблер не трогаем: это сброс назначений, а не включение хоткеев. */
        const restoreBtn = card.querySelector("#hotkeyRestore");
        restoreBtn?.addEventListener("click", () => {
            if (restoreBtn.disabled) return;
            if (activeCapture) {
                stopCapture(activeCapture, true);
                activeCapture = null;
            }
            saveHotkeys({ ...DEFAULT_HOTKEYS });
            card.querySelectorAll(".hotkey-binding").forEach((b) => {
                renderBinding(b, DEFAULT_HOTKEYS[b.dataset.action] || "");
            });
            highlightKeyboard(card, "");
            if (tauriEvent && readAppState().hotkeysEnabled) {
                tauriEvent.emit("void:register-hotkeys", { bindings: readHotkeys() }).catch(() => {});
            }
        });
    }

    /* ===== keyboard + mouse visual (non-interactive) ===== */

    /* Раскладка 65%: шесть рядов по 16 юнитов. Выбрана не за красоту, а потому
       что на неё ложится ВСЁ, что умеет вернуть mapKeyToTauri — F-ряд, цифры,
       знаки, стрелки, home/end/pgup/pgdn. Карта перестаёт врать: любой
       назначенный бинд на ней действительно подсветится. Прежняя миниатюра
       рисовала только буквы + shift/ctrl и читалась как обрезанная.

       Формат: K(label, key, units).
       - key === null — клавиша нарисована для узнаваемости, но забиндить её
         нельзя: esc отменяет захват, bksp/del очищают бинд, caps и fn до нас
         не доходят.
       - GAP(units) — пустой распор между группами, как физический зазор платы.
       - units по умолчанию 1; ряды обязаны давать одинаковую сумму, иначе
         столбцы разъедутся (flex распределяет остаток по ряду). */
    const K = (label, key, units) => ({ label, key: key || null, units: units || 1 });
    const GAP = (units) => ({ label: null, key: null, units });

    /* Маковский «перевёрнутый T»: все четыре стрелки — половинной высоты.
       ←, ↓, → стоят в нижней половине ряда, ↑ — над ↓, над ← и → пусто.
       В плоский ряд это не ложится, поэтому блок рисуется отдельной сеткой
       3×2 шириной в 3 юнита (см. .kbd-arrows в app-settings.css). */
    const ARROW_CLUSTER = { arrows: true, units: 3 };

    /* Ширина F-клавиши в мак-раскладке. Верхний ряд там — 14 клавиш на ту же
       ширину, что 15 клавиш ниже, промежутков между группами нет (в отличие от
       PC-плат), а esc и Touch ID по краям шире функциональных.
       25/24 = (15 − 1.5 esc − 1 touchid) / 12 — ровно то, что остаётся F-ряду. */
    const MAC_FKEY = 25 / 24;

    /* Стрелки — inline SVG, а не юникод: гайд запрещает юникод-иконки
       (rules/VOID_STYLE_GUIDE.md §6, исключения только «—» и «·»). */
    const ARROW = {
        up:    `<svg viewBox="0 0 24 24"><path d="M12 19V6M6 12l6-6 6 6"/></svg>`,
        down:  `<svg viewBox="0 0 24 24"><path d="M12 5v13M6 12l6 6 6-6"/></svg>`,
        left:  `<svg viewBox="0 0 24 24"><path d="M19 12H6M12 6l-6 6 6 6"/></svg>`,
        right: `<svg viewBox="0 0 24 24"><path d="M5 12h13M12 6l6 6-6 6"/></svg>`
    };

    /* Модификаторы мака — тоже inline SVG, а не unicode ⌘/⌥/⌃/⇧: гайд запрещает
       unicode-иконки (rules/VOID_STYLE_GUIDE.md §6), да и глиф зависел бы от
       того, есть ли он в JetBrains Mono. Формы стандартные, эппловские. */
    const MAC_ICON = {
        super: `<svg viewBox="0 0 24 24"><path d="M15 6v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3V6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3"/></svg>`,
        alt:   `<svg viewBox="0 0 24 24"><path d="M3 4h6l6 16h6M14 4h7"/></svg>`,
        ctrl:  `<svg viewBox="0 0 24 24"><path d="M5 15l7-7 7 7"/></svg>`,
        shift: `<svg viewBox="0 0 24 24"><path d="M12 3.5 4.5 11.5H8.5V20h7v-8.5h4z"/></svg>`,
        /* Touch ID — правая верхняя клавиша мака. Отпечаток: три вложенные
           дуги. Клавиша нарисована ради узнаваемости платы, забиндить её
           нельзя (до браузера она не доходит вовсе). */
        touchid: `<svg viewBox="0 0 24 24"><path d="M5 16.5v-3a7 7 0 0 1 14 0v3"/><path d="M8.6 17v-3.5a3.4 3.4 0 0 1 6.8 0V17"/><path d="M12 17.5v-4"/></svg>`
    };

    const KB_LAYOUT_PC = [
        [K("esc", null), GAP(0.5),
         K("f1", "f1"), K("f2", "f2"), K("f3", "f3"), K("f4", "f4"), GAP(0.5),
         K("f5", "f5"), K("f6", "f6"), K("f7", "f7"), K("f8", "f8"), GAP(0.5),
         K("f9", "f9"), K("f10", "f10"), K("f11", "f11"), K("f12", "f12"), GAP(0.5),
         /* На месте del у 65%-плат — ins: Delete во время захвата очищает бинд
            и назначить его нельзя, а Insert mapKeyToTauri отдаёт. */
         K("ins", "insert")],

        [K("`", "backquote"),
         K("1", "1"), K("2", "2"), K("3", "3"), K("4", "4"), K("5", "5"),
         K("6", "6"), K("7", "7"), K("8", "8"), K("9", "9"), K("0", "0"),
         K("-", "minus"), K("=", "equal"), K("bksp", null, 2), K("home", "home")],

        [K("tab", "tab", 1.5),
         K("q", "q"), K("w", "w"), K("e", "e"), K("r", "r"), K("t", "t"),
         K("y", "y"), K("u", "u"), K("i", "i"), K("o", "o"), K("p", "p"),
         K("[", "bracketleft"), K("]", "bracketright"), K("\\", "backslash", 1.5),
         K("end", "end")],

        [K("caps", null, 1.75),
         K("a", "a"), K("s", "s"), K("d", "d"), K("f", "f"), K("g", "g"),
         K("h", "h"), K("j", "j"), K("k", "k"), K("l", "l"),
         K(";", "semicolon"), K("'", "quote"), K("enter", "enter", 2.25),
         K("pgup", "pageup")],

        [K("shift", "shift", 2.25),
         K("z", "z"), K("x", "x"), K("c", "c"), K("v", "v"), K("b", "b"),
         K("n", "n"), K("m", "m"),
         K(",", "comma"), K(".", "period"), K("/", "slash"),
         K("shift", "shift", 1.75), K(ARROW.up, "up"), K("pgdn", "pagedown")],

        [K("ctrl", "ctrl", 1.25), K("win", "super", 1.25), K("alt", "alt", 1.25),
         K("", "space", 6.25),
         K("alt", "alt"), K("fn", null), K("ctrl", "ctrl"),
         K(ARROW.left, "left"), K(ARROW.down, "down"), K(ARROW.right, "right")]
    ];

    /* Мак — 6 рядов по 15 юнитов (у PC-раскладки 16), настоящие маковские
       клавиши: нижний ряд fn/⌃/⌥/⌘, return вместо enter, delete вместо bksp,
       модификаторы значками.

       Правого навигационного столбца НЕТ намеренно: ins/home/end/pgup/pgdn на
       маковских клавиатурах физически отсутствуют (на ноутбуках это fn+стрелки),
       рисовать их — врать про железо. Плата на карте становится 60%-й.
       Плата за это: если кто-то подключит внешнюю PC-клавиатуру и повесит бинд
       на Home, mapKeyToTauri его примет, а подсветиться на карте будет нечему.
       Осознанный размен: чужое железо реже, чем маковское. */
    const KB_LAYOUT_MAC = [
        [K("esc", null, 1.5),
         K("f1", "f1", MAC_FKEY), K("f2", "f2", MAC_FKEY), K("f3", "f3", MAC_FKEY),
         K("f4", "f4", MAC_FKEY), K("f5", "f5", MAC_FKEY), K("f6", "f6", MAC_FKEY),
         K("f7", "f7", MAC_FKEY), K("f8", "f8", MAC_FKEY), K("f9", "f9", MAC_FKEY),
         K("f10", "f10", MAC_FKEY), K("f11", "f11", MAC_FKEY), K("f12", "f12", MAC_FKEY),
         K(MAC_ICON.touchid, null)],

        [K("`", "backquote"),
         K("1", "1"), K("2", "2"), K("3", "3"), K("4", "4"), K("5", "5"),
         K("6", "6"), K("7", "7"), K("8", "8"), K("9", "9"), K("0", "0"),
         K("-", "minus"), K("=", "equal"), K("delete", null, 2)],

        [K("tab", "tab", 1.5),
         K("q", "q"), K("w", "w"), K("e", "e"), K("r", "r"), K("t", "t"),
         K("y", "y"), K("u", "u"), K("i", "i"), K("o", "o"), K("p", "p"),
         K("[", "bracketleft"), K("]", "bracketright"), K("\\", "backslash", 1.5)],

        [K("caps", null, 1.75),
         K("a", "a"), K("s", "s"), K("d", "d"), K("f", "f"), K("g", "g"),
         K("h", "h"), K("j", "j"), K("k", "k"), K("l", "l"),
         K(";", "semicolon"), K("'", "quote"), K("return", "enter", 2.25)],

        [K(MAC_ICON.shift, "shift", 2.25),
         K("z", "z"), K("x", "x"), K("c", "c"), K("v", "v"), K("b", "b"),
         K("n", "n"), K("m", "m"),
         K(",", "comma"), K(".", "period"), K("/", "slash"),
         /* Правый shift длинный до самого края — стрелок в этом ряду нет,
            они целиком уехали в нижний, как на физической плате. */
         K(MAC_ICON.shift, "shift", 2.75)],

        [K("fn", null), K(MAC_ICON.ctrl, "ctrl"),
         K(MAC_ICON.alt, "alt", 1.25), K(MAC_ICON.super, "super", 1.25),
         K("", "space", 5),
         K(MAC_ICON.super, "super", 1.25), K(MAC_ICON.alt, "alt", 1.25),
         ARROW_CLUSTER]
    ];

    const KB_LAYOUT = IS_MAC ? KB_LAYOUT_MAC : KB_LAYOUT_PC;

    /* Модификаторы подсвечиваются контуром, а не заливкой: в комбинации важна
       целевая клавиша, ctrl/shift — только контекст. */
    const KB_MODS = new Set(["ctrl", "shift", "alt", "super"]);

    /* Мышь. data-key — те же токены, что и в акселераторе (Mouse3/4/5,
       WheelUp/WheelDown), поэтому подсветка работает тем же кодом, что и для
       клавиш. Левая и правая нарисованы, но мертвы — их намеренно нельзя
       забиндить (см. mouseButtonToken). */
    const KB_MOUSE = `
        <svg class="kbd-mouse" viewBox="0 0 60 104" aria-hidden="true">
            <path class="kbd-mouse-shell" d="M30 3C16.2 3 7 13.6 7 28v48c0 13.9 10.3 25 23 25s23-11.1 23-25V28C53 13.6 43.8 3 30 3Z"/>
            <path class="kbd-mouse-seam" d="M30 3v11M7 44h46"/>
            <rect class="kbd-mouse-part" data-key="mouse3" x="25" y="16" width="10" height="20" rx="5"/>
            <path class="kbd-mouse-part" data-key="wheelup" d="M27.5 22 30 19l2.5 3"/>
            <path class="kbd-mouse-part" data-key="wheeldown" d="M27.5 30 30 33l2.5-3"/>
            <rect class="kbd-mouse-part" data-key="mouse4" x="2" y="48" width="6" height="12" rx="2.4"/>
            <rect class="kbd-mouse-part" data-key="mouse5" x="2" y="62" width="6" height="12" rx="2.4"/>
        </svg>`;

    function buildKeyboardHtml() {
        const rows = KB_LAYOUT.map((row) => {
            const keys = row.map((k) => {
                const flex = ` style="flex:${k.units} 1 0"`;
                if (k.arrows) {
                    const cap = (dir, cls) =>
                        `<span class="kbd-key kbd-key--ic ${cls}" data-key="${dir}">${ARROW[dir]}</span>`;
                    return `<span class="kbd-arrows"${flex}>` +
                        cap("up", "kbd-arrow-up") +
                        cap("left", "kbd-arrow-left") +
                        cap("down", "kbd-arrow-down") +
                        cap("right", "kbd-arrow-right") +
                    `</span>`;
                }
                if (k.label === null) return `<span class="kbd-gap"${flex}></span>`;
                const isIcon = k.label.charAt(0) === "<";
                const cls = ["kbd-key"];
                if (!k.key) cls.push("kbd-key--dead");
                if (k.units >= 1.5) cls.push("kbd-key--wide");
                if (isIcon) cls.push("kbd-key--ic");
                if (k.key && KB_MODS.has(k.key)) cls.push("kbd-key--mod");
                const attr = k.key ? ` data-key="${k.key}"` : "";
                return `<span class="${cls.join(" ")}"${attr}${flex}>${isIcon ? k.label : escape(k.label)}</span>`;
            }).join("");
            return `<div class="kbd-row">${keys}</div>`;
        }).join("");
        return `
            <div class="kbd-visual" data-kbd aria-hidden="true">
                <div class="kbd-stage">
                    <div class="kbd-board">${rows}</div>
                    ${KB_MOUSE}
                </div>
            </div>
        `;
    }

    /* Ctrl/Shift/Alt/Super + буква → строчные подписи на keycaps. */
    /* Мышиные подписи — через словарь: «mouse4» на кнопке ни о чём не говорит,
       а держать их строками прямо здесь нельзя (единый источник строк — DICTIONARY
       в settings.js, см. rules/lessons.md). Модификаторы остаются как есть:
       ctrl/shift/alt/super пишутся одинаково на обоих языках. */
    const MOUSE_CAP_KEYS = {
        Mouse3: "hotkeys.cap.mouse3",
        Mouse4: "hotkeys.cap.mouse4",
        Mouse5: "hotkeys.cap.mouse5",
        WheelUp: "hotkeys.cap.wheelUp",
        WheelDown: "hotkeys.cap.wheelDown"
    };

    /* Знаки препинания на кэпе: «backquote»/«bracketleft» читаются как
       отладочный вывод. Показываем символ — ровно так, как он выбит на клавише
       (и так же, как подписан на карте). */
    const PUNCT_CAPS = {
        Backquote: "`", Minus: "-", Equal: "=", BracketLeft: "[", BracketRight: "]",
        Semicolon: ";", Quote: "'", Backslash: "\\", Comma: ",", Period: ".", Slash: "/"
    };

    function capLabel(part) {
        if (MOUSE_CAP_KEYS[part]) return T(MOUSE_CAP_KEYS[part]);
        if (PUNCT_CAPS[part]) return PUNCT_CAPS[part];
        const m = { Ctrl: "ctrl", Shift: "shift", Alt: "alt", Super: "super" };
        return m[part] || String(part).toLowerCase();
    }

    /* Содержимое кэпа: на маке модификатор — значок (⌘⌥⌃⇧ как SVG), везде
       ещё — слово. Отдаём ГОТОВЫЙ html, поэтому текст экранируем здесь же:
       наружу не должно уйти ни одной неэкранированной подписи. */
    function capMarkup(part) {
        const icon = IS_MAC && MAC_ICON[String(part).toLowerCase()];
        return icon || escape(capLabel(part));
    }

    /* Порядок модификаторов на показ. Apple пишет их как ⌃⌥⇧⌘ — сортируем
       только отображение, сам акселератор в хранилище не трогаем. */
    const MAC_MOD_ORDER = ["Ctrl", "Alt", "Shift", "Super"];
    function orderPartsForDisplay(parts) {
        if (!IS_MAC) return parts;
        const isMod = (p) => MAC_MOD_ORDER.includes(p);
        return [
            ...parts.filter(isMod).sort((a, b) => MAC_MOD_ORDER.indexOf(a) - MAC_MOD_ORDER.indexOf(b)),
            ...parts.filter((p) => !isMod(p))
        ];
    }

    function accelToKeycaps(accel) {
        if (!accel) return `<span class="binding-empty">—</span>`;
        return orderPartsForDisplay(accel.split("+")).map((p, i) => {
            const cls = (IS_MAC && MAC_ICON[String(p).toLowerCase()]) ? "binding-cap binding-cap--ic" : "binding-cap";
            return `${i ? '<span class="binding-plus">+</span>' : ""}<span class="${cls}">${capMarkup(p)}</span>`;
        }).join("");
    }

    function renderBinding(btn, accel) {
        btn.dataset.accel = accel || "";
        btn.innerHTML = accelToKeycaps(accel);
    }

    /* Сравниваем СЫРЫЕ токены акселератора, а не подписи с keycap'ов: подписи
       переводимые (Mouse3 → «колесо-клик»/«middle click»), и по ним карта
       совпадала бы только на одном языке. data-key хранит токен в нижнем
       регистре — "m", "backquote", "f5", "ctrl", "mouse4". */
    function highlightKeyboard(card, accel) {
        const kb = card.querySelector("[data-kbd]");
        if (!kb) return;
        const tokens = (accel || "").split("+").filter(Boolean).map(p => p.toLowerCase());
        kb.querySelectorAll("[data-key]").forEach(k => {
            k.classList.toggle("is-on", tokens.includes(k.dataset.key));
        });
    }

    function escape(s) {
        return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({
            "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
        })[c]);
    }

    // -------------------- Key capture --------------------

    let activeCapture = null;

    function startCapture(btn) {
        if (activeCapture) stopCapture(activeCapture, /*restore*/ true);
        btn.classList.add("is-capturing");
        const card = btn.closest(".app-modal-card");
        const originalAccel = btn.dataset.accel || "";
        btn.innerHTML = `<span class="binding-prompt">…</span>`;
        highlightKeyboard(card, originalAccel);
        activeCapture = { btn, originalAccel, card, handlers: [] };

        /* Один путь сохранения для клавиатуры и для мыши. */
        const commit = (accel) => {
            saveBinding(btn.dataset.action, accel);
            renderBinding(btn, accel);
            highlightKeyboard(card, accel);
            stopCapture(activeCapture, false);
            activeCapture = null;
        };

        const handler = (e) => {
            // Esc → отмена.
            if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                stopCapture(activeCapture, true);
                activeCapture = null;
                return;
            }
            // Backspace / Delete → очистить бинд.
            if (e.key === "Backspace" || e.key === "Delete") {
                e.preventDefault();
                e.stopPropagation();
                commit("");
                return;
            }
            // Только modifier — игнорируем, ждём «настоящую» клавишу.
            if (["Control", "Shift", "Alt", "Meta", "ControlLeft", "ControlRight",
                 "ShiftLeft", "ShiftRight", "AltLeft", "AltRight", "MetaLeft", "MetaRight"].includes(e.key)) {
                return;
            }
            const accel = buildAccelerator(e);
            if (!accel) return;
            e.preventDefault();
            e.stopPropagation();
            commit(accel);
        };

        /* Кнопки мыши. Ловим mousedown, а не click: click в вебвью приходит
           только для основной кнопки, боковых по нему не видно вовсе.
           Слушатель можно вешать сразу — капчур запускается по `click` на поле,
           то есть mousedown этого самого клика уже отыграл и сюда не попадёт. */
        const mouseHandler = (e) => {
            const token = mouseButtonToken(e.button);
            if (!token) return;   // левая/правая — не биндим (см. mouseButtonToken)
            e.preventDefault();
            e.stopPropagation();
            commit(withModifiers(e, token));
        };

        /* Колесо. Требуем модификатор: голое WheelUp срабатывало бы на каждой
           обычной прокрутке и сделало бы действие неуправляемым. Без
           модификатора просто ждём дальше, не закрывая капчур. */
        const wheelHandler = (e) => {
            if (!e.deltaY) return;
            e.preventDefault();
            e.stopPropagation();
            if (!(e.ctrlKey || e.shiftKey || e.altKey || e.metaKey)) return;
            commit(withModifiers(e, e.deltaY < 0 ? "WheelUp" : "WheelDown"));
        };

        /* Боковые кнопки в вебвью водят историю назад/вперёд, а правая открывает
           контекстное меню — на время захвата глушим и то, и другое. */
        const swallow = (e) => {
            if (e.type === "contextmenu" || mouseButtonToken(e.button)) {
                e.preventDefault();
                e.stopPropagation();
            }
        };

        activeCapture.handlers = [
            ["keydown", handler, true],
            ["mousedown", mouseHandler, true],
            ["wheel", wheelHandler, { capture: true, passive: false }],
            ["mouseup", swallow, true],
            ["auxclick", swallow, true],
            ["contextmenu", swallow, true]
        ];
        for (const [type, fn, opts] of activeCapture.handlers) {
            document.addEventListener(type, fn, opts);
        }
    }

    function stopCapture(state, restore) {
        if (!state) return;
        for (const [type, fn, opts] of state.handlers || []) {
            document.removeEventListener(type, fn, opts);
        }
        state.btn.classList.remove("is-capturing");
        if (restore) {
            renderBinding(state.btn, state.originalAccel);
            highlightKeyboard(state.card, "");
        }
    }

    /**
     * `MouseEvent.button` → токен акселератора.
     *
     * Левая (0) и правая (2) не биндятся НАМЕРЕННО: мьют на левый клик делает
     * машину неюзабельной, а правая нужна контекстному меню. Нумерация токенов
     * взята из игр и Discord (mouse4/mouse5 — боковые), чтобы пользователь узнал
     * свою кнопку без догадок.
     */
    function mouseButtonToken(button) {
        if (button === 1) return "Mouse3";  // средняя (клик колесом)
        if (button === 3) return "Mouse4";  // боковая «назад»
        if (button === 4) return "Mouse5";  // боковая «вперёд»
        return null;
    }

    /** Дописать модификаторы в том же порядке, что и buildAccelerator. */
    function withModifiers(e, token) {
        const parts = [];
        if (e.ctrlKey) parts.push("Ctrl");
        if (e.shiftKey) parts.push("Shift");
        if (e.altKey) parts.push("Alt");
        if (e.metaKey) parts.push("Super");
        parts.push(token);
        return parts.join("+");
    }

    function buildAccelerator(e) {
        const parts = [];
        if (e.ctrlKey) parts.push("Ctrl");
        if (e.shiftKey) parts.push("Shift");
        if (e.altKey) parts.push("Alt");
        if (e.metaKey) parts.push("Super");
        const key = mapKeyToTauri(e);
        if (!key) return null;
        // Требуем хотя бы один modifier для глобальных хоткеев — иначе слишком
        // легко конфликтует с обычным набором текста. Исключения — F-клавиши и
        // STANDALONE_KEYS (см. объявление).
        if (parts.length === 0 && !/^F\d+$/.test(key) && !STANDALONE_KEYS.has(key)) return null;
        parts.push(key);
        return parts.join("+");
    }

    /* Маппинг event.code → Tauri Code-имя.
       Используем e.code (физическая клавиша), не e.key — стабильнее, не зависит
       от раскладки. Например на ЙЦУКЕН раскладке "Ctrl+Shift+М" в event.key =
       "м"/"ь", а event.code = "KeyM" — Tauri ждёт именно последнее. */
    function mapKeyToTauri(e) {
        const code = e.code;
        if (/^Key[A-Z]$/.test(code)) return code.slice(3);                  // KeyM → M
        if (/^Digit[0-9]$/.test(code)) return code.slice(5);                // Digit1 → 1
        if (/^F\d+$/.test(code)) return code;                               // F1..F24
        const special = {
            Space: "Space", Enter: "Enter", Tab: "Tab",
            ArrowUp: "Up", ArrowDown: "Down", ArrowLeft: "Left", ArrowRight: "Right",
            Home: "Home", End: "End", PageUp: "PageUp", PageDown: "PageDown",
            Insert: "Insert", Minus: "Minus", Equal: "Equal",
            BracketLeft: "BracketLeft", BracketRight: "BracketRight",
            Semicolon: "Semicolon", Quote: "Quote", Backslash: "Backslash",
            Comma: "Comma", Period: "Period", Slash: "Slash", Backquote: "Backquote"
        };
        return special[code] || null;
    }

    function saveBinding(action, accel) {
        const hotkeys = readHotkeys();
        hotkeys[action] = accel;
        saveHotkeys(hotkeys);
        /* Пока хоткеи выключены общим тумблером — не регистрируем в Rust
           (новый бинд применится при включении). */
        if (tauriEvent && readAppState().hotkeysEnabled) {
            tauriEvent.emit("void:register-hotkeys", { bindings: hotkeys }).catch(() => {});
        }
    }

    // -------------------- App settings modal --------------------

    function openAppSettingsModal() {
        const s = readAppState();
        const card = openModal(
            T("app.title"),
            `
            <div class="app-section">
                <span class="app-section-label">${escape(T("app.close.label"))}</span>
                <span class="app-section-hint">${escape(T("app.close.hint"))}</span>
                <div class="close-actions" role="radiogroup" aria-label="close behavior">
                    <button type="button" class="close-action" data-value="minimize" role="radio">
                        <svg class="close-action-ic" viewBox="0 0 24 24" aria-hidden="true">
                            <rect x="3" y="4" width="18" height="13" rx="1.4"/>
                            <path d="M9 21h6M12 17v4"/>
                            <path d="M9.5 9.2l2.5 2.6 2.5-2.6"/>
                        </svg>
                        <span class="close-action-title">${escape(T("app.close.minimize.title"))}</span>
                        <span class="close-action-sub">${escape(T("app.close.minimize.sub"))}</span>
                    </button>
                    <button type="button" class="close-action" data-value="close" role="radio">
                        <svg class="close-action-ic" viewBox="0 0 24 24" aria-hidden="true">
                            <rect x="3" y="4" width="18" height="13" rx="1.4"/>
                            <path d="M9 21h6M12 17v4"/>
                            <path d="M10 8.5l4 4M14 8.5l-4 4"/>
                        </svg>
                        <span class="close-action-title">${escape(T("app.close.quit.title"))}</span>
                        <span class="close-action-sub">${escape(T("app.close.quit.sub"))}</span>
                    </button>
                </div>
            </div>

            <div class="app-modal-divider"></div>

            <div class="app-modal-row app-modal-row--lead">
                <span class="app-modal-ic-lead" aria-hidden="true">
                    <svg viewBox="0 0 24 24"><path d="M12 3v9"/><path d="M7.6 6.6a7 7 0 1 0 8.8 0"/></svg>
                </span>
                <div class="app-modal-row-text">
                    <span class="app-modal-row-label">${escape(T("app.autostart.label"))}</span>
                    <span class="app-modal-row-hint">${escape(T("app.autostart.hint"))}</span>
                </div>
                <label class="sc-switch">
                    <input type="checkbox" id="appAutoStartCheckbox" />
                    <span class="sc-switch-track"></span>
                </label>
            </div>
            ${isDesktop ? `
            <div class="app-modal-divider"></div>

            <div class="app-modal-row app-modal-row--lead">
                <span class="app-modal-ic-lead" aria-hidden="true">
                    <svg viewBox="0 0 24 24"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 4v5h-5"/></svg>
                </span>
                <div class="app-modal-row-text">
                    <span class="app-modal-row-label">${escape(T("app.updates.label"))}</span>
                    <span class="app-modal-row-hint">${escape(T("app.updates.current"))} v${escape(window.VoidVersion || "")}</span>
                </div>
                <div class="app-update-ctl">
                    <span class="app-update-toast" id="appUpdateToast" aria-live="polite"></span>
                    <button type="button" class="app-update-btn" id="appCheckUpdatesBtn">
                        <svg class="app-update-ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 4v5h-5"/></svg>
                        <span class="app-update-label">${escape(T("app.updates.btn"))}</span>
                    </button>
                </div>
            </div>
            ` : ""}
            `,
            ICON_APP
        );

        const segs = card.querySelectorAll(".close-action");
        segs.forEach((b) => {
            b.classList.toggle("is-active", b.dataset.value === s.closeAction);
            b.setAttribute("aria-checked", b.dataset.value === s.closeAction ? "true" : "false");
            b.addEventListener("click", () => {
                const value = b.dataset.value;
                segs.forEach((other) => {
                    other.classList.toggle("is-active", other === b);
                    other.setAttribute("aria-checked", other === b ? "true" : "false");
                });
                patchAppState({ closeAction: value });
                if (tauriEvent) {
                    tauriEvent.emit("void:set-close-behavior", { behavior: value }).catch(() => {});
                }
                /* Обновляем сводку в строке категории «application» сразу —
                   иначе превью застывает на прошлом значении (tray · off). */
                window.VoidSettings?.refreshCats?.();
            });
        });

        const cb = card.querySelector("#appAutoStartCheckbox");
        cb.checked = s.autoStart;
        cb.addEventListener("change", () => {
            const enabled = !!cb.checked;
            patchAppState({ autoStart: enabled });
            if (tauriEvent) {
                tauriEvent.emit("void:set-autostart", { enabled }).catch(() => {});
            }
            window.VoidSettings?.refreshCats?.();
        });

        /* «Проверить обновления» — самодостаточный инлайн-флоу (альтернатива
           баннеру): проверка → инлайн-тост над кнопкой → если апдейт есть, кнопка
           становится «обновить» и качает/ставит прямо из настроек. Отдельный
           канал void:updater-probe — баннер не дёргаем. */
        const upBtn = card.querySelector("#appCheckUpdatesBtn");
        if (upBtn && tauriEvent) {
            const toastEl = card.querySelector("#appUpdateToast");
            const labelEl = upBtn.querySelector(".app-update-label");
            const icEl = upBtn.querySelector(".app-update-ic");
            const ICON_REFRESH = `<path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 4v5h-5"/>`;
            const ICON_DOWNLOAD = `<path d="M12 4v11"/><path d="M7 11l5 5 5-5"/><path d="M5 19.5h14"/>`;

            let mode = "check"; // check | update | installing
            let foundVersion = "";
            let toastTimer = null;
            let probeTimer = null;

            const tmpl = (key, val) => T(key).replace("{v}", val).replace("{p}", val);
            function showToast(text, autoDismiss, accent) {
                if (!toastEl) return;
                toastEl.textContent = text;
                toastEl.classList.toggle("is-available", !!accent);
                toastEl.classList.add("is-visible");
                clearTimeout(toastTimer);
                if (autoDismiss) toastTimer = setTimeout(() => toastEl.classList.remove("is-visible"), 2600);
            }
            const setIcon = (paths) => { if (icEl) icEl.innerHTML = paths; };

            function toCheckMode() {
                mode = "check";
                upBtn.classList.remove("is-checking", "is-installing", "is-update");
                upBtn.disabled = false;
                setIcon(ICON_REFRESH);
                if (labelEl) labelEl.textContent = T("app.updates.btn");
            }
            function toUpdateMode(version) {
                mode = "update";
                foundVersion = version;
                upBtn.classList.remove("is-checking");
                upBtn.classList.add("is-update");
                upBtn.disabled = false;
                setIcon(ICON_DOWNLOAD);
                if (labelEl) labelEl.textContent = T("app.updates.update");
            }

            trackCleanup(tauriEvent.listen("void:updater-probe-result", (event) => {
                const p = (event && event.payload) || {};
                clearTimeout(probeTimer);
                if (mode === "installing") return;
                if (p.status === "available") {
                    showToast(tmpl("app.updates.available", "v" + (p.version || "")), false, true);
                    toUpdateMode(p.version || "");
                } else if (p.status === "uptodate") {
                    showToast(T("app.updates.latest"), true);
                    toCheckMode();
                } else {
                    showToast(T("app.updates.failed"), true);
                    toCheckMode();
                }
            }));

            trackCleanup(tauriEvent.listen("void:updater-progress", (event) => {
                if (mode !== "installing") return;
                const p = (event && event.payload) || {};
                const total = Number(p.total || 0), down = Number(p.downloaded || 0);
                const pct = total > 0 ? Math.min(100, Math.floor((down / total) * 100)) : 0;
                if (labelEl) labelEl.textContent = tmpl("app.updates.downloading", String(pct));
            }));

            trackCleanup(tauriEvent.listen("void:updater-error", () => {
                if (mode !== "installing") return;
                showToast(T("app.updates.failed"), true);
                toUpdateMode(foundVersion);
            }));

            upBtn.addEventListener("click", () => {
                if (mode === "installing" || upBtn.disabled) return;
                if (mode === "update") {
                    /* Загрузка+установка прямо из настроек (плагин сам рестартнёт). */
                    mode = "installing";
                    upBtn.classList.add("is-installing");
                    setIcon(ICON_DOWNLOAD);
                    if (labelEl) labelEl.textContent = tmpl("app.updates.downloading", "0");
                    tauriEvent.emit("void:updater-install").catch(() => {});
                    return;
                }
                /* mode === "check" */
                if (toastEl) toastEl.classList.remove("is-visible");
                upBtn.classList.add("is-checking");
                upBtn.disabled = true;
                tauriEvent.emit("void:updater-probe").catch(() => {});
                clearTimeout(probeTimer);
                probeTimer = setTimeout(() => {
                    if (mode === "check") { showToast(T("app.updates.failed"), true); toCheckMode(); }
                }, 20000);
            });
        }
    }

    // -------------------- Hotkey-pressed handler (Rust → JS) --------------------

    function invokeHotkeyAction(action) {
        switch (action) {
            case "toggleMic":
                if (typeof toggleMic === "function") toggleMic();
                break;
            case "toggleSound":
                if (typeof toggleSound === "function") toggleSound();
                break;
            case "leaveRoom":
                if (typeof leaveRoom === "function" && typeof isJoined !== "undefined" && isJoined) {
                    leaveRoom();
                }
                break;
            // toggleWindow обрабатывается напрямую в Rust — JS не получает event.
        }
    }

    if (tauriEvent) {
        tauriEvent
            .listen("void:autostart-state", (event) => {
                const enabled = event && event.payload === true;
                patchAppState({ autoStart: enabled });
                window.VoidSettings?.refreshCats?.();
            })
            .catch(() => {});

        tauriEvent
            .listen("void:hotkey-pressed", (event) => {
                const action = event && event.payload && event.payload.action;
                if (action) invokeHotkeyAction(action);
            })
            .catch(() => {});
    } else {
        /* Web-сборка: Tauri runtime нет, глобальной регистрации хоткеев нет.
           Ловим комбинации DOM-обработчиком — работают, пока вкладка в фокусе.
           Используем тот же buildAccelerator/invokeHotkeyAction, что и desktop,
           чтобы поведение совпадало. */
        /** Общий разбор для клавиатуры и мыши: найти действие по акселератору. */
        const fireByAccel = (e, accel) => {
            if (activeCapture) return false;                  // идёт назначение бинда
            if (!readAppState().hotkeysEnabled) return false;  // общий тумблер выключен
            if (!accel) return false;
            const hotkeys = readHotkeys();
            for (const action of Object.keys(hotkeys)) {
                /* toggleWindow обрабатывается ОС-уровнем в desktop; в вебе окна
                   как сущности нет — пропускаем. */
                if (action === "toggleWindow") continue;
                if (hotkeys[action] && hotkeys[action] === accel) {
                    e.preventDefault();
                    invokeHotkeyAction(action);
                    return true;
                }
            }
            return false;
        };

        /* Голый бинд (без модификаторов) не должен стрелять, пока пользователь
           печатает: в вебе хоткеи ловит тот же document, что и чат/поля ввода.
           Комбинации с модификатором оставляем как были — Ctrl+Shift+… в текст
           всё равно не попадает. */
        const isTypingTarget = (el) =>
            el instanceof Element &&
            (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));

        document.addEventListener("keydown", (e) => {
            /* Автоповтор ОС: зажатая комбинация шлёт keydown десятки раз в
               секунду, и «мут» начинал переключаться туда-обратно со звуком на
               каждое срабатывание. Хоткей — это событие нажатия, а не
               удержания. */
            if (e.repeat) return;
            const accel = buildAccelerator(e);                 // null на чистом modifier
            if (accel && !accel.includes("+") && isTypingTarget(e.target)) return;
            fireByAccel(e, accel);
        });

        /* Кнопки мыши и колесо — тем же путём. Без этого мышиный бинд в вебе
           назначался бы, но молча не срабатывал: глобального хука тут нет, а
           единственный обработчик слушал только клавиатуру. */
        document.addEventListener("mousedown", (e) => {
            const token = mouseButtonToken(e.button);
            if (!token) return;
            fireByAccel(e, withModifiers(e, token));
        });

        document.addEventListener("wheel", (e) => {
            if (!e.deltaY) return;
            fireByAccel(e, withModifiers(e, e.deltaY < 0 ? "WheelUp" : "WheelDown"));
        }, { passive: false });
    }

    // -------------------- Click delegation for action buttons --------------------

    document.addEventListener("click", (e) => {
        const target = e.target instanceof Element ? e.target.closest("button") : null;
        if (!target) return;
        if (target.id === "settingsHotkeysBtn") {
            e.preventDefault();
            openHotkeysModal();
        } else if (target.id === "settingsAppBtn") {
            e.preventDefault();
            openAppSettingsModal();
        }
    });

    // -------------------- Bootstrap --------------------

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", pushClientStateToRust);
    } else {
        pushClientStateToRust();
    }
})();
