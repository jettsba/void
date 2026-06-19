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

    /* ---- масштаб трей-меню ----
       Нативный 1.0 на всех мониторах: окно фиксированного логического размера,
       а физику масштабирует ОС через DPI. Раньше домножали на fluid-множитель от
       screen.width (как старый ui-scale-bootstrap.js) — на 2K/4K это раздувало
       меню. Rust теперь шлёт scale=1.0 в void:tray-menu-state; обработчик ниже
       всё равно применяет присланное значение (на случай будущей логики). */
    function setScale(scale) {
        const s = Number(scale);
        if (isFinite(s) && s > 0) {
            document.documentElement.style.setProperty("--tm-scale", s.toFixed(3));
        }
    }

    // Дефолт сразу при загрузке (до первого open) — без скачка размера.
    setScale(1);

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
