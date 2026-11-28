/* ============ Окно тихого обновления (updater v2, режим A) ============
   Живёт в отдельном frameless-окне (label "updater"), поднятом из Rust на
   старте, когда найден апдейт. Рендерит терминальный блок-бар + лог по
   событиям из Rust. Полосы и кнопок окна нет — только блок прогресса.

   События (Rust → это окно):
     void:upd-begin     { version }            — старт, версия для лога
     void:upd-progress  { downloaded, total }  — прогресс скачивания
     void:upd-phase     { phase: install|done} — фазы после скачивания
     void:upd-error     { message }            — ошибка (окно закроется из Rust)

   Кнопок НЕТ — обновление идёт само. */

(function () {
    "use strict";

    const T = window.__TAURI__;
    const BAR_LEN = 22;
    const LOG_MAX = 6;

    const fillEl = document.getElementById("uwBarFill");
    const emptyEl = document.getElementById("uwBarEmpty");
    const pctEl = document.getElementById("uwPct");
    const logEl = document.getElementById("uwLog");
    const IS_MAC = /Mac/i.test(navigator.platform || navigator.userAgent || "");

    let version = null;
    let logStarted = false;
    let maxTotal = 0;

    setBar(0);

    /* Полосы нет — окно тащится за любое место. */
    if (T && T.window) {
        const win = T.window.getCurrentWindow();
        document.addEventListener("mousedown", (e) => {
            if (e.button === 0) win.startDragging().catch(noop);
        });
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
        // Окно маленькое: держим последние строки, старые уезжают.
        while (logEl.children.length > LOG_MAX) logEl.removeChild(logEl.firstChild);
    }

    function startLog(v) {
        if (v) version = v;
        if (logStarted) return;
        logStarted = true;
        addLine("dim", "void / update — v" + (version || "?"));
        addLine("arr", IS_MAC ? "→ download  void.app.tar.gz" : "→ download  void_setup.exe");
    }

    /* Лог фазы установки. NSIS теперь идёт тихо (installMode quiet), так что
       эти строки — единственная видимая обратная связь, пока он распаковывает
       и ставит. Стаггерим, чтобы выглядело как реальный прогресс инсталлера. */
    function runInstallLog() {
        const steps = IS_MAC ? [
            "→ verify  signature",
            "→ extract  void.app",
            "→ replace  application",
        ] : [
            "→ verify  signature",
            "→ extract  void-desktop.exe",
            "→ install  application files",
            "→ register  shortcuts",
        ];
        steps.forEach((text, i) => {
            setTimeout(() => addLine("arr", text), i * 320);
        });
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
                runInstallLog();
            } else if (phase === "done") {
                setBar(100);
                addLine("ok", "done — relaunching");
            }
        }).catch(noop);

        T.event.listen("void:upd-error", (e) => {
            addLine("dim", "ошибка обновления");
        }).catch(noop);
    }
})();
