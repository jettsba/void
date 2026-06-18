/* ============ Кастомное трей-меню — логика окна ============
   Живёт в frameless-окне (label "tray-menu"), поднятом скрытым из Rust и
   позиционируемом по правому клику на значке трея (open_tray_menu в lib.rs).

   Rust → окно:
     void:tray-menu-state { inRoom }   — показать/скрыть копи-пункты
   Окно → Rust:
     invoke tray_menu_action(action)   — show | copy-code | copy-link | quit
                                         (Rust сам прячет окно после действия)

   Закрытие по клику мимо — на стороне Rust (WindowEvent::Focused(false) → hide).
   Esc закрывает локально. */

(function () {
    "use strict";

    const T = window.__TAURI__;
    function noop() {}

    /* ---- авто-масштаб (как ui-scale-bootstrap.js основного приложения) ----
       Множитель от физической ширины монитора (screen.width, иммунна к zoom).
       Внутренняя rem-сетка растёт на 2K/4K. Размер ОКНА Rust считает тем же
       множителем (open_tray_menu) → контент точно заполняет окно. */
    function autoScaleFromScreen() {
        try {
            const w = (window.screen && window.screen.width) || window.innerWidth || 1920;
            let t = 1.4 * (w / 100) - 10;
            if (t < 14) t = 14;
            if (t > 44) t = 44;
            return t / 14;
        } catch (e) {
            return 1;
        }
    }

    function setScale(scale) {
        const s = Number(scale);
        if (isFinite(s) && s > 0) {
            document.documentElement.style.setProperty("--tm-scale", s.toFixed(3));
        }
    }

    // Дефолт сразу при загрузке (до первого open) — без скачка размера.
    setScale(autoScaleFromScreen());

    /* ---- видимость копи-пунктов: класс in-room на body ---- */
    function applyState(inRoom) {
        document.body.classList.toggle("in-room", !!inRoom);
    }

    if (T && T.event) {
        T.event
            .listen("void:tray-menu-state", (e) => {
                const p = e.payload || {};
                applyState(p.inRoom);
                // scale приходит из Rust (монитор под курсором) — авторитетнее
                // дефолта от screen.width при мульти-мониторе.
                if (p.scale != null) setScale(p.scale);
            })
            .catch(noop);
    }

    /* ---- клик по пункту → команда в Rust ---- */
    function invokeAction(action) {
        if (!action) return;
        if (T && T.core && typeof T.core.invoke === "function") {
            T.core.invoke("tray_menu_action", { action }).catch(noop);
        }
    }

    document.querySelectorAll(".tm-item").forEach((el) => {
        el.addEventListener("click", () => invokeAction(el.dataset.action));
    });

    /* ---- Esc закрывает меню локально (мгновенный отклик) ---- */
    window.addEventListener("keydown", (e) => {
        if (e.key === "Escape" && T && T.window) {
            T.window.getCurrentWindow().hide().catch(noop);
        }
    });

    /* Подавляем нативное контекстное меню внутри самого меню. */
    window.addEventListener("contextmenu", (e) => e.preventDefault());
})();
