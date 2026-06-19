/* ===== UI scale bootstrap (v0.10.1) =====
   Считаем масштаб ДО загрузки CSS, чтобы избежать FOUC.

   Источник масштаба — screen.width (физическая CSS-ширина монитора, иммунна
   к zoom браузера). Если бы использовали vw в clamp() — браузерный zoom
   менял бы vw и перекомпенсировал scaling (Ctrl+Minus → интерфейс становился
   крупнее). JS-based подход делает zoom ортогональным нашему scaling.

   Раньше этот код жил инлайном в <head> public/index.html, но строгий CSP
   (script-src 'self' без 'unsafe-inline') блокировал его в проде: на 4K
   мониторах --auto-scale оставался дефолтным, юзер получал слишком мелкий
   интерфейс. Вынесли в внешний файл — теперь CSP остаётся строгим, а
   масштаб работает корректно. Грузится синхронно через blocking <script>
   (БЕЗ defer/async) — должен выполниться ДО парсинга CSS.

   КЭШ: подключён как ?v=N в public/index.html. При правке этого файла
   бампать N (см. memory rule про cache-busters). */
(function () {
    try {
        /* DESKTOP (Tauri): окно фиксированного логического размера (1280×820,
           см. lib.rs), дизайн рассчитан на baseline 14px, а физический размер
           уже масштабирует ОС через DPI (devicePixelRatio). Поэтому авто-масштаб
           здесь = 1.0 — «нативно» на любом мониторе. Fluid-формула от screen.width
           раздувала UI в 1.3–3× на 2K/4K (окно-то фиксированное) — это и был баг
           «всё слишком большое». Формула остаётся только для WEB, где вьюпорт
           растягивается во всю ширину монитора и пропорциональный scale уместен.
           __TAURI_INTERNALS__ инжектится WebView ДО любых скриптов (детерминирован). */
        var isDesktop = typeof window.__TAURI_INTERNALS__ !== "undefined";
        if (isDesktop) {
            document.documentElement.style.setProperty('--auto-scale', '1');
        } else {
            var w = (window.screen && window.screen.width) || window.innerWidth || 1920;
            var t = 1.4 * (w / 100) - 10;
            if (t < 14) t = 14;
            if (t > 44) t = 44;
            document.documentElement.style.setProperty('--auto-scale', (t / 14).toFixed(3));
        }

        var raw = localStorage.getItem('void:settings');
        if (raw) {
            var s = JSON.parse(raw);
            var ui = parseFloat(s && s.uiScale);
            if (isFinite(ui) && ui >= 0.5 && ui <= 2.0) {
                document.documentElement.style.setProperty('--ui-scale', ui);
            }
        }
    } catch (e) { /* приватный режим, мусор в storage — оставляем дефолты */ }
})();
