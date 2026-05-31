/* Desktop runtime bootstrap. Загружается синхронно в <head> ДО CSS, чтобы
   избежать FOUC между web-mode (default chrome) и desktop-mode (custom
   titlebar поверх). Tauri WebView2 инжектит __TAURI_INTERNALS__ до парсинга
   страницы, так что проверка здесь детерминирована.

   Эффект: html.desktop класс активирует видимость .void-titlebar
   и любые .desktop-only элементы; web-сборка работает идентично прежнему
   (без класса). */
(function () {
    if (typeof window.__TAURI_INTERNALS__ === "undefined") return;
    document.documentElement.classList.add("desktop");
    window.VoidPlatform = "desktop";
})();
