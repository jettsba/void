/* ============ Deep-link приём (desktop-only) ============
   Ловит void://room/КОД и входит в комнату:
   - warm (app уже открыт): событие "void:deep-link-room" из Rust;
   - cold (ссылка запустила app): команда take_pending_deep_link на init.
   Сам вход — joinRoomByCode() из app.js. В web-сборке модуль no-op. */

(function () {
    "use strict";

    if (window.VoidPlatform !== "desktop") return;
    if (!window.__TAURI__) return;

    /* joinRoomByCode читает codeInput/app/isJoined, которые заполняются в init()
       (DOMContentLoaded). app.js регистрирует свой DCL-листенер раньше нашего,
       поэтому к моменту whenReady-колбэка init уже отработал. */
    function whenReady(fn) {
        if (document.readyState === "loading") {
            document.addEventListener("DOMContentLoaded", fn, { once: true });
        } else {
            fn();
        }
    }

    function handle(code) {
        if (!code) return;
        whenReady(() => {
            if (typeof joinRoomByCode === "function") joinRoomByCode(code);
        });
    }

    // Warm: ссылка прилетела во время работы приложения.
    if (window.__TAURI__.event) {
        window.__TAURI__.event
            .listen("void:deep-link-room", (e) => handle(e?.payload?.code))
            .catch((err) => console.warn("[deep-link] listen failed", err));
    }

    // Cold: ссылка запустила приложение — забираем отложенный код.
    if (window.__TAURI__.core && window.__TAURI__.core.invoke) {
        window.__TAURI__.core
            .invoke("take_pending_deep_link")
            .then((code) => handle(code))
            .catch((err) => console.warn("[deep-link] take pending failed", err));
    }
})();
