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

    const DEFAULT_HOTKEYS = {
        toggleMic:    "Ctrl+Shift+M",
        toggleSound:  "Ctrl+Shift+D",
        toggleWindow: "Ctrl+Shift+V",
        leaveRoom:    "Ctrl+Shift+Q"
    };

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
                /* Общий выключатель глобальных хоткеев. Default — включены. */
                hotkeysEnabled: typeof parsed.hotkeysEnabled === "boolean" ? parsed.hotkeysEnabled : true
            };
        } catch {
            return { closeAction: "minimize", autoStart: false, hotkeysEnabled: true };
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

    function openModal(title, contentHTML, iconSvg) {
        closeModalIfAny();
        const scrim = document.createElement("div");
        scrim.className = "app-modal-scrim";
        scrim.id = "appModalScrim";
        const card = document.createElement("div");
        card.className = "app-modal-card";
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
            </div>
            <div class="app-modal-footer-hint" data-desktop-hotkeys-hint>
                <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 8v4M12 16h.01"/></svg>
                <span>${escape(T("hotkeys.mousehint"))}</span>
            </div>
            <div class="app-modal-footer-hint" data-web-hotkeys-hint>
                <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 8v4M12 16h.01"/></svg>
                <span>${escape(T("hotkeys.webhint"))}</span>
            </div>
            `,
            ICON_KEYBOARD
        );

        const listEl = card.querySelector("[data-hotkeys-list]");
        const applyEnabledUI = (on) => {
            listEl.classList.toggle("is-disabled", !on);
            card.querySelectorAll(".hotkey-binding").forEach((b) => { b.disabled = !on; });
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
    }

    /* ===== keyboard visual (non-interactive) ===== */

    const KB_ROWS = [
        ["Q", "W", "E", "R", "T", "Y", "U", "I", "O", "P"],
        ["A", "S", "D", "F", "G", "H", "J", "K", "L"],
        ["Z", "X", "C", "V", "B", "N", "M"]
    ];

    function buildKeyboardHtml() {
        const letterRows = KB_ROWS.map((row, i) => {
            const keys = row.map(k => `<span class="kbd-key" data-key="${k.toLowerCase()}">${k}</span>`).join("");
            /* shift живёт слева от нижнего буквенного ряда (Z…M) — как на реальной клавиатуре. */
            const shift = i === 2 ? `<span class="kbd-key kbd-key--wide" data-key="shift">shift</span>` : "";
            return `<div class="kbd-row">${shift}${keys}</div>`;
        }).join("");
        return `
            <div class="kbd-visual" data-kbd aria-hidden="true">
                ${letterRows}
                <div class="kbd-row">
                    <span class="kbd-key kbd-key--wide" data-key="ctrl">ctrl</span>
                    <span class="kbd-key kbd-key--space"></span>
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

    function capLabel(part) {
        if (MOUSE_CAP_KEYS[part]) return T(MOUSE_CAP_KEYS[part]);
        const m = { Ctrl: "ctrl", Shift: "shift", Alt: "alt", Super: "super" };
        return m[part] || String(part).toLowerCase();
    }

    function accelToKeycaps(accel) {
        if (!accel) return `<span class="binding-empty">—</span>`;
        return accel.split("+").map((p, i) =>
            `${i ? '<span class="binding-plus">+</span>' : ""}<span class="binding-cap">${escape(capLabel(p))}</span>`
        ).join("");
    }

    function renderBinding(btn, accel) {
        btn.dataset.accel = accel || "";
        btn.innerHTML = accelToKeycaps(accel);
    }

    function highlightKeyboard(card, accel) {
        const kb = card.querySelector("[data-kbd]");
        if (!kb) return;
        const tokens = (accel || "").split("+").map(capLabel);
        kb.querySelectorAll(".kbd-key").forEach(k => {
            k.classList.toggle("is-on", !!k.dataset.key && tokens.includes(k.dataset.key));
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
        // легко конфликтует с обычным набором текста. Исключение — F-клавиши.
        if (parts.length === 0 && !/^F\d+$/.test(key)) return null;
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

        document.addEventListener("keydown", (e) => {
            fireByAccel(e, buildAccelerator(e));               // null на чистом modifier
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
