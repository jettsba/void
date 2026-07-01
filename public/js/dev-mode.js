/* ===== Dev-режим (админ-режим) — сессионный флаг + негласная активация =====
   Включается негласным жестом: ник == "casheaterr" (case-insensitive) И 10
   кликов по пилюле версии в настройках (.settings-footer-pill). Живёт ТОЛЬКО в
   памяти — полное закрытие приложения (свежий webview при следующем запуске) →
   снова выключен. За флагом спрятаны все debug-инструменты: нативная консоль
   (ПКМ-меню + F12/Ctrl+Shift+I), peer-HUD, force-relay, копирование диагностики,
   кнопки «админ-панель» и «DevTools» — всё в разделе настроек «разработчик».

   Нативная блокировка F12 на desktop делается в Rust (lib.rs,
   setup_dev_access_gate + команда set_dev_access) по атомику DEV_ACCESS; здесь
   при активации зовём invoke("set_dev_access", { enabled: true }). ПКМ-меню
   WebView2 гасится ниже прямо в JS (contextmenu preventDefault до активации —
   тот же приём, что в tray-menu.js).

   Активация возможна на любой платформе (жест в настройках), но нативная
   блокировка консоли — только desktop; web-браузер не трогаем. */
(function () {
    "use strict";

    const ADMIN_NICK = "casheaterr";
    const CLICKS_NEEDED = 10;
    /* Сбрасываем счётчик, если пауза между кликами слишком большая — чтобы клики
       разных заходов в настройки не накапливались в случайную активацию. */
    const CLICK_RESET_MS = 2000;

    let devMode = false;
    let clicks = 0;
    let lastClickTs = 0;

    function isEnabled() { return devMode; }

    function currentNick() {
        try {
            return (window.VoidSettings?.getNickname() || "").trim().toLowerCase();
        } catch (_) { return ""; }
    }

    function enable() {
        if (devMode) return;
        devMode = true;
        /* Desktop: снять нативную блокировку консоли (F12 — через Rust
           AcceleratorKeyPressed по DEV_ACCESS; ПКМ-меню — через флаг ниже). */
        if (window.VoidPlatform === "desktop") {
            try { window.__TAURI__?.core?.invoke("set_dev_access", { enabled: true }); }
            catch (_) {}
        }
        document.dispatchEvent(new CustomEvent("void:devmode-changed", { detail: { enabled: true } }));
        try { window.log?.info?.("boot", "dev mode enabled"); } catch (_) {}
    }

    /* Вызывается из settings.js на каждый клик по пилюле версии. */
    function registerPillClick() {
        if (devMode) return;
        const now = Date.now();
        clicks = (now - lastClickTs > CLICK_RESET_MS) ? 1 : clicks + 1;
        lastClickTs = now;
        if (clicks < CLICKS_NEEDED) return;
        clicks = 0;
        if (currentNick() === ADMIN_NICK) enable();
    }

    /* ПКМ-меню WebView2 (Обновить / Печать / «Проверить» → консоль). До
       dev-режима гасим нативное контекстное меню на главном окне. На web не
       трогаем — там меню браузера легитимно. */
    if (window.VoidPlatform === "desktop") {
        document.addEventListener("contextmenu", (e) => {
            if (!devMode) e.preventDefault();
        });
    }

    window.VoidDev = { isEnabled, registerPillClick };
})();
