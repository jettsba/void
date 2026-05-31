/* ============ Custom titlebar — IPC обёртка ============
   Связь кнопок minimize / maximize-restore / close с Tauri window API.
   Активируется только в desktop-сборке (window.VoidPlatform === "desktop").

   Tauri 2: при withGlobalTauri=true глобал window.__TAURI__ содержит
   модули window/event/etc. Используем getCurrentWindow() — возвращает
   WebviewWindow с методами minimize/toggleMaximize/close/isMaximized
   и событием onResized (нужно для синхронизации иконки maximize/restore
   когда юзер дабл-кликает по drag-region или drag'ает к краю экрана).

   Фаза 1: close = close (полное завершение). В Фазе 2 после внедрения
   трея переключим на hide() + tray-icon.
*/

(function () {
    "use strict";

    if (window.VoidPlatform !== "desktop") return;
    if (!window.__TAURI__ || !window.__TAURI__.window) {
        console.warn("[titlebar] Tauri runtime not available");
        return;
    }

    const tauriWindow = window.__TAURI__.window.getCurrentWindow();

    const minBtn = document.getElementById("voidTitlebarMin");
    const maxBtn = document.getElementById("voidTitlebarMax");
    const closeBtn = document.getElementById("voidTitlebarClose");

    if (!minBtn || !maxBtn || !closeBtn) {
        console.warn("[titlebar] DOM controls missing");
        return;
    }

    minBtn.addEventListener("click", () => {
        tauriWindow.minimize().catch((e) => console.warn("[titlebar] minimize failed", e));
    });

    maxBtn.addEventListener("click", async () => {
        try {
            await tauriWindow.toggleMaximize();
            await syncMaximizeIcon();
        } catch (e) {
            console.warn("[titlebar] toggleMaximize failed", e);
        }
    });

    closeBtn.addEventListener("click", () => {
        tauriWindow.close().catch((e) => console.warn("[titlebar] close failed", e));
    });

    async function syncMaximizeIcon() {
        try {
            const isMax = await tauriWindow.isMaximized();
            maxBtn.classList.toggle("is-maximized", isMax);
        } catch (e) {
            /* swallow — некритично, иконка останется в прежнем состоянии */
        }
    }

    /* onResized стреляет при maximize, restore, и пользовательском ресайзе.
       Дёшево, syncMaximizeIcon — одна IPC-команда. */
    tauriWindow.onResized(syncMaximizeIcon);
    syncMaximizeIcon();
})();
