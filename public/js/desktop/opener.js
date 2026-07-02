/* ============ Открытие внешних ссылок (desktop-only) ============
   Голый `<a target="_blank">` / window.open в WebView2 не открывает системный
   браузер (навигация из вебвью заблокирована — тот же класс ограничения движка,
   что у save-file.js/clipboard.js). Идём через кастомную Rust-команду
   `open_external` (lib.rs — обёртка над tauri-plugin-opener). Вызов опенера из
   Rust НЕ требует JS-ACL, поэтому отдельный `opener:`-пермишен в capabilities не
   нужен. На вебе VoidDesktop не определён → общий хелпер openExternalUrl
   (js/config.js) сам падает в window.open. */
(function () {
    "use strict";

    if (window.VoidPlatform !== "desktop") return;
    if (!window.__TAURI__ || !window.__TAURI__.core) {
        console.warn("[opener] Tauri core API not available");
        return;
    }

    const invoke = window.__TAURI__.core.invoke;

    async function openExternal(url) {
        await invoke("open_external", { url });
    }

    window.VoidDesktop = window.VoidDesktop || {};
    window.VoidDesktop.openExternal = openExternal;
})();
