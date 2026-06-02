/* Desktop runtime bootstrap. Загружается синхронно в <head> ДО CSS, чтобы
   избежать FOUC между web-mode (default chrome) и desktop-mode (custom
   titlebar поверх). Tauri WebView2 инжектит __TAURI_INTERNALS__ до парсинга
   страницы, так что проверка здесь детерминирована.

   Эффект: html.desktop класс активирует видимость .void-titlebar
   и любые .desktop-only элементы; web-сборка работает идентично прежнему
   (без класса). */
(function () {
    var isTauri = typeof window.__TAURI_INTERNALS__ !== "undefined";
    /* В Tauri 2 на Windows bundled URL — http://tauri.localhost/, а не
       tauri://localhost/ как в docs. Детектим по hostname (плюс fallback
       на protocol для будущих Tauri-версий или других платформ). */
    var isBundled =
        window.location.hostname === "tauri.localhost" ||
        window.location.protocol === "tauri:";

    if (isTauri) {
        document.documentElement.classList.add("desktop");
        window.VoidPlatform = "desktop";
    }

    /* API base URLs.
       В web и dev-desktop (загрузка с http://localhost:3000) — относительные
       пути работают как раньше. В bundled prod (tauri://localhost) location.host
       это "localhost" — relative /api/ и ws://host/ упираются в никуда.
       Поэтому в bundled-режиме явно адресуем production-сервер. */
    if (isBundled) {
        window.VoidApiBase = "https://app.void-room.space";
        window.VoidWsBase = "wss://app.void-room.space";
    } else {
        window.VoidApiBase = "";
        window.VoidWsBase =
            (window.location.protocol === "https:" ? "wss://" : "ws://") +
            window.location.host;
    }
})();
