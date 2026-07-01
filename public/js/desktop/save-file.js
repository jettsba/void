/* ============ Сохранение файла на диск (desktop-only) ============
   `<a download>` для blob:-URL молча не срабатывает в WebView2 (тот же класс
   ограничения движка, что и с navigator.clipboard.write() для картинок —
   см. js/desktop/clipboard.js): клик проходит без единой ошибки/события,
   но ни диалога сохранения, ни файла на диске не появляется.

   На десктопе идём в обход через нативные tauri-plugin-dialog (выбор пути)
   + tauri-plugin-fs (запись байт) — тот же приём "нативный плагин вместо
   Web API", что уже решил проблему с копированием картинок. */
(function () {
    "use strict";

    if (window.VoidPlatform !== "desktop") return;
    if (!window.__TAURI__ || !window.__TAURI__.core) {
        console.warn("[save-file] Tauri core API not available");
        return;
    }

    const invoke = window.__TAURI__.core.invoke;

    /* Возвращает true, если файл реально записан; false — юзер отменил
       диалог (не ошибка, просто "передумал"). Бросает при реальном сбое. */
    async function saveFile(blobUrl, filename) {
        const savePath = await invoke("plugin:dialog|save", {
            options: { defaultPath: filename }
        });
        if (!savePath) return false;

        const buf = await fetch(blobUrl).then((r) => r.arrayBuffer());

        /* write_file — особый calling convention: сырые байты идут ВТОРЫМ
           позиционным аргументом invoke (не внутри JSON args), путь и опции —
           через headers. Так Tauri IPC передаёт бинарник эффективно, без
           JSON.stringify каждого байта (важно — файлы до 100 МБ, см.
           CHAT_MAX_FILE_MB в chat.js). Формат взят из официального
           @tauri-apps/plugin-fs (writeFile), 1:1. */
        await invoke("plugin:fs|write_file", new Uint8Array(buf), {
            headers: {
                path: encodeURIComponent(savePath),
                options: JSON.stringify({})
            }
        });
        return true;
    }

    window.VoidDesktop = window.VoidDesktop || {};
    window.VoidDesktop.saveFile = saveFile;
})();
