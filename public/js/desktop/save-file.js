/* ============ Сохранение файла на диск (desktop-only) ============
   `<a download>` для blob:-URL молча не срабатывает в WebView2 (тот же класс
   ограничения движка, что и с navigator.clipboard.write() для картинок —
   см. js/desktop/clipboard.js): клик проходит без единой ошибки/события,
   но ни диалога сохранения, ни файла на диске не появляется.

   На десктопе идём в обход через нативную команду `save_file` (lib.rs):
   диалог «сохранить как» и запись байт делает Rust, путь выбирает человек.
   Прав на файловую систему у вебвью нет вовсе — скрипт страницы не может
   записать файл куда-то сам (раньше ACL пускал fs-плагин в $HOME/**). */
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
        const buf = await fetch(blobUrl).then((r) => r.arrayBuffer());
        /* Сырые байты — вторым аргументом invoke (raw body, без JSON-
           сериализации каждого байта: файлы до 100 МБ). Имя — в заголовке,
           закодированное: значения заголовков только ASCII. */
        return invoke("save_file", new Uint8Array(buf), {
            headers: { "x-file-name": encodeURIComponent(filename || "file") }
        });
    }

    window.VoidDesktop = window.VoidDesktop || {};
    window.VoidDesktop.saveFile = saveFile;
})();
