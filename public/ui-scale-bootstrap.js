/* ===== UI scale bootstrap (v0.12.19) =====
   Единственный источник истины для --auto-scale. Считаем масштаб ДО загрузки
   CSS (чтобы избежать FOUC) и экспонируем window.__voidApplyAutoScale, чтобы
   resize-хук в app.js пересчитывал ТЕМ ЖЕ кодом.

   ⚠ ИСТОРИЯ БАГА (почему «desktop-масштаб не чинился 10 версий»):
   раньше desktop-ветка жила только здесь, а app.js на init()/resize звал
   СВОЮ updateAutoScale() — она знала ТОЛЬКО web-формулу от screen.width и
   безусловно ЗАТИРАЛА выставленный тут desktop-масштаб через пару мс после
   загрузки. Любой desktop-фикс (v0.12.8 и далее) был мёртвым кодом: страница
   всегда отрисовывалась с раздутым web-значением. Теперь формула одна.

   Источник fluid-базы — screen.width (физическая CSS-ширина монитора, иммунна
   к zoom браузера). vw НЕ используем: браузерный zoom менял бы vw и
   перекомпенсировал scaling (Ctrl+Minus → интерфейс крупнее). screen.width к
   zoom иммунен → zoom ортогонален нашему scaling.

   Грузится синхронно blocking-<script> (БЕЗ defer/async) — должен выполниться
   ДО парсинга CSS. КЭШ: ?v=N в index.html — бампать при правке (cache-buster). */
(function () {
    /* Канонический расчёт --auto-scale. Используется и тут (до CSS), и из
       app.js (resize-хук) — через window.__voidApplyAutoScale. */
    function computeAutoScale() {
        var isDesktop = typeof window.__TAURI_INTERNALS__ !== "undefined";

        /* Fluid-база по физической ширине монитора: FHD≈1.21, 2K≈1.86, 4K≈3.14,
           пегается 1.0..3.14 по краям. На web это финальный масштаб. */
        var w = (window.screen && window.screen.width) || window.innerWidth || 1920;
        var t = 1.4 * (w / 100) - 10;
        if (t < 14) t = 14;
        if (t > 44) t = 44;
        var base = t / 14;

        if (!isDesktop) return base;

        /* DESKTOP (Tauri): окно фиксированного ЛОГИЧЕСКОГО размера (1280×820,
           см. lib.rs). ОС уже домножает ВЕСЬ контент на DPI (devicePixelRatio =
           OS scale factor: 4K обычно @150%→1.5, 2K @125%→1.25). Контр-масштабируем
           fluid-базу множителем 1.05/dpr, чтобы hi-DPI не раздувал UI поверх
           OS-масштаба. Множитель (НЕ замена базы!): dpr1.0→1.0 (FHD без изм.),
           1.25→0.84, 1.5→0.70 — ровно то, что пользователи выставляли вручную
           (85%/70%) поверх раздутого UI. Кап 1.0 (вниз не растим на FHD),
           пол 0.5 (страховка от экстремального DPI).
           __TAURI_INTERNALS__ инжектится WebView ДО любых скриптов. */
        var dpr = window.devicePixelRatio || 1;
        var factor = 1.05 / dpr;
        if (factor > 1) factor = 1;
        if (factor < 0.5) factor = 0.5;
        return base * factor;
    }

    function applyAutoScale() {
        try {
            document.documentElement.style.setProperty(
                "--auto-scale", computeAutoScale().toFixed(3));
        } catch (e) { /* доступ к DOM/screen недоступен — оставляем дефолт */ }
    }

    /* Экспортируем для resize-хука app.js — единая точка пересчёта. */
    window.__voidApplyAutoScale = applyAutoScale;

    try {
        applyAutoScale();

        var raw = localStorage.getItem("void:settings");
        if (raw) {
            var s = JSON.parse(raw);
            var ui = parseFloat(s && s.uiScale);
            if (isFinite(ui) && ui >= 0.5 && ui <= 2.0) {
                document.documentElement.style.setProperty("--ui-scale", ui);
            }
        }
    } catch (e) { /* приватный режим, мусор в storage — оставляем дефолты */ }
})();
