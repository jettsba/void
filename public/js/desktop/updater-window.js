/* ============ Окно тихого обновления (updater v2, режим A) ============
   Живёт в отдельном frameless-окне (label "updater"), поднятом из Rust на
   старте, когда найден апдейт. Рендерит терминальный блок-бар + лог по
   событиям из Rust, управляет кнопками окна (свернуть / закрыть).

   События (Rust → это окно):
     void:upd-begin     { version }            — старт, версия для лога
     void:upd-progress  { downloaded, total }  — прогресс скачивания
     void:upd-phase     { phase: install|done} — фазы после скачивания
     void:upd-error     { message }            — ошибка (окно закроется из Rust)

   Кнопок действия НЕТ — обновление идёт само. Закрытие (✕) = выход (Rust). */

(function () {
    "use strict";

    const T = window.__TAURI__;
    const BAR_LEN = 22;

    const fillEl = document.getElementById("uwBarFill");
    const emptyEl = document.getElementById("uwBarEmpty");
    const pctEl = document.getElementById("uwPct");
    const logEl = document.getElementById("uwLog");
    const footEl = document.getElementById("uwFoot");

    let version = null;
    let logStarted = false;
    let maxTotal = 0;

    setBar(0);

    /* ---- кнопки окна (свернуть / закрыть) ---- */
    if (T && T.window) {
        const win = T.window.getCurrentWindow();
        const min = document.getElementById("uwMin");
        const close = document.getElementById("uwClose");
        if (min) min.addEventListener("click", () => win.minimize().catch(noop));
        if (close) close.addEventListener("click", () => win.close().catch(noop));
    }

    /* ---- блок-бар [████░░░░] NN% ---- */
    function setBar(pct) {
        pct = Math.max(0, Math.min(100, Math.round(pct)));
        const filled = Math.round((pct / 100) * BAR_LEN);
        if (fillEl) fillEl.textContent = "█".repeat(filled);
        if (emptyEl) emptyEl.textContent = "░".repeat(BAR_LEN - filled);
        if (pctEl) pctEl.textContent = pct + "%";
    }

    function addLine(cls, text) {
        if (!logEl) return;
        const line = document.createElement("div");
        line.className = cls;
        line.textContent = text;
        logEl.appendChild(line);
    }

    function startLog(v) {
        if (v) version = v;
        if (logStarted) return;
        logStarted = true;
        addLine("dim", "void / update — v" + (version || "?"));
        addLine("arr", "→ download  void_setup.exe");
    }

    function noop() {}

    /* ---- события из Rust ---- */
    if (T && T.event) {
        T.event.listen("void:upd-begin", (e) => {
            startLog((e.payload || {}).version);
        }).catch(noop);

        T.event.listen("void:upd-progress", (e) => {
            const p = e.payload || {};
            startLog();
            const downloaded = Number(p.downloaded || 0);
            const total = Number(p.total || 0);
            if (total > maxTotal) maxTotal = total;
            if (maxTotal > 0) setBar((downloaded / maxTotal) * 100);
        }).catch(noop);

        T.event.listen("void:upd-phase", (e) => {
            const phase = (e.payload || {}).phase;
            if (phase === "install") {
                setBar(100);
                addLine("arr", "→ verify  signature");
            } else if (phase === "done") {
                setBar(100);
                addLine("ok", "done — relaunching");
                if (footEl) footEl.textContent = "перезапуск…";
            }
        }).catch(noop);

        T.event.listen("void:upd-error", (e) => {
            addLine("dim", "ошибка обновления");
            if (footEl) footEl.textContent = "ошибка";
        }).catch(noop);
    }
})();
