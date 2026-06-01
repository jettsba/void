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

   В web-сборке Tauri runtime отсутствует — emit'ы молча no-op, listener'ы не
   подключаются. Хоткеи работают только при открытой вкладке (keydown DOM
   ловится, без глобальной регистрации). Footer-плашка в hotkeys modal об
   этом предупреждает; в Фазе 9 (детект web/desktop) скроем её на desktop. */

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
        { action: "toggleMic",    label: "микрофон вкл/выкл" },
        { action: "toggleSound",  label: "звук вкл/выкл" },
        { action: "toggleWindow", label: "показать/скрыть окно" },
        { action: "leaveRoom",    label: "покинуть комнату" }
    ];

    const isDesktop = window.VoidPlatform === "desktop";
    const tauriEvent = window.__TAURI__ && window.__TAURI__.event;

    // -------------------- localStorage helpers --------------------

    function readAppState() {
        try {
            const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
            return {
                closeAction:
                    parsed.closeAction === "close" || parsed.closeAction === "minimize"
                        ? parsed.closeAction
                        : "minimize",
                autoStart: typeof parsed.autoStart === "boolean" ? parsed.autoStart : false
            };
        } catch {
            return { closeAction: "minimize", autoStart: false };
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
        tauriEvent.emit("void:register-hotkeys", { bindings: readHotkeys() }).catch(() => {});
    }

    // -------------------- Modal infra --------------------

    function openModal(title, contentHTML) {
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
                <span class="app-modal-title">${title}</span>
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
        setTimeout(() => scrim.remove(), 180);
    }

    function escClose(e) {
        if (e.key === "Escape") closeModalIfAny();
    }

    // -------------------- Hotkeys modal --------------------

    function openHotkeysModal() {
        const hotkeys = readHotkeys();
        const rowsHTML = HOTKEY_ROWS.map(
            ({ action, label }) => `
                <div class="app-modal-row">
                    <div class="app-modal-row-text">
                        <span class="app-modal-row-label">${label}</span>
                    </div>
                    <button type="button" class="app-modal-binding" data-action="${action}">${escape(hotkeys[action]) || "—"}</button>
                </div>
            `
        ).join("");

        const card = openModal(
            "горячие клавиши",
            `
            ${rowsHTML}
            <p class="app-modal-note">клик по комбинации — задать новую. esc — отмена, backspace — очистить.</p>
            <div class="app-modal-footer-hint" data-web-hotkeys-hint>
                <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 8v4M12 16h.01"/></svg>
                <span>в web-версии хоткеи работают только при открытой вкладке</span>
            </div>
            `
        );

        card.querySelectorAll(".app-modal-binding").forEach((btn) => {
            btn.addEventListener("click", () => startCapture(btn));
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
        const originalText = btn.textContent;
        btn.textContent = "нажмите комбинацию…";
        activeCapture = { btn, originalText, handler: null };

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
                saveBinding(btn.dataset.action, "");
                btn.textContent = "—";
                stopCapture(activeCapture, false);
                activeCapture = null;
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
            saveBinding(btn.dataset.action, accel);
            btn.textContent = accel;
            stopCapture(activeCapture, false);
            activeCapture = null;
        };

        activeCapture.handler = handler;
        document.addEventListener("keydown", handler, true);
    }

    function stopCapture(state, restore) {
        if (!state) return;
        document.removeEventListener("keydown", state.handler, true);
        state.btn.classList.remove("is-capturing");
        if (restore) state.btn.textContent = state.originalText;
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
        if (tauriEvent) {
            tauriEvent.emit("void:register-hotkeys", { bindings: hotkeys }).catch(() => {});
        }
    }

    // -------------------- App settings modal --------------------

    function openAppSettingsModal() {
        const s = readAppState();
        const card = openModal(
            "настройки приложения",
            `
            <div class="app-modal-row">
                <div class="app-modal-row-text">
                    <span class="app-modal-row-label">при закрытии окна</span>
                    <span class="app-modal-row-hint">"свернуть" — приложение продолжит работать в трее</span>
                </div>
                <div class="app-modal-segmented" role="radiogroup" aria-label="close behavior">
                    <button type="button" class="app-modal-seg" data-value="minimize" role="radio">свернуть</button>
                    <button type="button" class="app-modal-seg" data-value="close" role="radio">закрыть</button>
                </div>
            </div>

            <div class="app-modal-row">
                <div class="app-modal-row-text">
                    <span class="app-modal-row-label">запускать при старте Windows</span>
                    <span class="app-modal-row-hint">приложение откроется автоматически при входе в систему</span>
                </div>
                <label class="sc-switch">
                    <input type="checkbox" id="appAutoStartCheckbox" />
                    <span class="sc-switch-track"></span>
                </label>
            </div>

            <p class="app-modal-note">${isDesktop ? "" : "это desktop-настройки. в web-версии они сохраняются, но не действуют."}</p>
            `
        );

        const segs = card.querySelectorAll(".app-modal-seg");
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
        });
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
            })
            .catch(() => {});

        tauriEvent
            .listen("void:hotkey-pressed", (event) => {
                const action = event && event.payload && event.payload.action;
                if (action) invokeHotkeyAction(action);
            })
            .catch(() => {});
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
