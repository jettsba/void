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
           см. lib.rs). ОС применяет DPI-масштаб ко ВСЕЙ системе (devicePixelRatio
           = OS scale factor: 4K обычно @150%→1.5, 2K @125%→1.25). Для нашего
           фикс-лейаута это делает окно непропорционально большим (на 4K@150% всё
           ×1.5). Контр-масштабируем под постоянный компактный «нативный» размер,
           независимый от монитора/OS-масштаба: auto = 1.05 / dpr (кап 1.0).
           Точки: 4K@150%→0.70, 2K@125%→0.84, 1080p@100%→1.0 — совпадает с тем,
           что пользователи выставляли вручную. Прошлый дефолт 1.0 не учитывал dpr
           и оставался раздутым OS-масштабом.
           WEB сохраняет fluid-формулу от screen.width (вьюпорт ≈ ширине монитора).
           __TAURI_INTERNALS__ инжектится WebView ДО любых скриптов (детерминирован). */
        var isDesktop = typeof window.__TAURI_INTERNALS__ !== "undefined";
        if (isDesktop) {
            var dpr = window.devicePixelRatio || 1;
            var ds = 1.05 / dpr;
            if (ds > 1) ds = 1;
            if (ds < 0.5) ds = 0.5;
            document.documentElement.style.setProperty('--auto-scale', ds.toFixed(3));
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
