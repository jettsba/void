/* ============================================================================
   void uninstaller — клиентская оркестрация (Веха B).
   Экраны: confirm → progress → done. Та же дизайн-система, что и установщик.
   Без Tauri (браузер) — моки для превью.
   ========================================================================= */
(function () {
  "use strict";

  const TAURI = window.__TAURI__ || null;
  const invoke =
    TAURI && TAURI.core && TAURI.core.invoke ? TAURI.core.invoke.bind(TAURI.core) : null;
  const hasTauri = !!invoke;

  // ----- i18n ---------------------------------------------------------------
  let lang = (navigator.language || "").toLowerCase().startsWith("ru") ? "ru" : "en";
  const DICT = {
    ru: {
      eyeConfirm: "удаление",
      confirmBody: "void будет удалён с этого компьютера.",
      cbPurge: "также удалить данные",
      eyeProgress: "удаление",
      progressFoot: "удаление…",
      eyeDone: "готово",
      doneBody: "void удалён.",
      bCancel: "отмена", bRemove: "удалить", bClose: "закрыть",
      errTitle: "ошибка удаления",
      logDone: "done — удалено · 0 ошибок",
    },
    en: {
      eyeConfirm: "uninstall",
      confirmBody: "void will be removed from this computer.",
      cbPurge: "also remove data",
      eyeProgress: "uninstalling",
      progressFoot: "uninstalling…",
      eyeDone: "done",
      doneBody: "void removed.",
      bCancel: "cancel", bRemove: "remove", bClose: "close",
      errTitle: "uninstall failed",
      logDone: "done — removed · 0 errors",
    },
  };
  const t = (k) => DICT[lang][k];

  const LOG_SEQ = [
    { at: 0,    cls: "dim", t: "void / uninstall" },
    { at: 250,  cls: "arr", t: "→ stop  void-desktop.exe" },
    { at: 600,  cls: "arr", t: "→ remove  resources\\" },
    { at: 980,  cls: "arr", t: "→ remove  void-desktop.exe" },
    { at: 1340, cls: "arr", t: "→ unlink  start menu · void" },
    { at: 1640, cls: "arr", t: "→ unlink  desktop · void" },
    { at: 1960, cls: "arr", t: "→ unregister  void://  protocol" },
    { at: 2300, cls: "ok",  t: "__done__" },
  ];
  const UNINSTALL_MS = 2500;
  const BAR_N = 22;

  const ICON = {
    check: '<svg width="12" height="12" viewBox="0 0 14 14"><path d="M3 7.3l2.6 2.6L11 4"/></svg>',
  };

  // ----- DOM ----------------------------------------------------------------
  const $ring = document.getElementById("ring");
  const $ringLayer = document.getElementById("ringLayer");
  const $wrap = document.getElementById("contentWrap");
  const $stage = document.getElementById("stage");
  const $footer = document.getElementById("footer");

  // ----- состояние ----------------------------------------------------------
  let step = "confirm"; // confirm | progress | done
  let phase = "in";
  const opts = { purgeData: false };
  let progress = 0;
  let log = [];
  const goTimers = [];
  const ringTimers = [];
  let runTimers = [];
  let runIv = null;

  const clearArr = (a) => { a.forEach(clearTimeout); a.length = 0; };
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  // ----- tauri window -------------------------------------------------------
  function tauriWin() {
    try {
      const w = TAURI && TAURI.window;
      if (!w) return null;
      return (w.getCurrentWindow || w.getCurrent).call(w);
    } catch (_) { return null; }
  }
  function closeWindow() { const w = tauriWin(); if (w) w.close(); else console.log("[mock] close"); }
  function minimizeWindow() { const w = tauriWin(); if (w) w.minimize(); else console.log("[mock] minimize"); }
  function showWindow() { const w = tauriWin(); if (w) { try { w.show(); if (w.setFocus) w.setFocus(); } catch (_) {} } }

  // ----- кольцо -------------------------------------------------------------
  function applyRing(s) {
    clearArr(ringTimers);
    $ring.classList.toggle("breathe", s === "confirm");
    $ring.classList.toggle("done", s === "done");
    if (s === "progress") {
      $ringLayer.classList.add("hidden");
    } else {
      const delay = s === "done" ? 220 : 80;
      ringTimers.push(setTimeout(() => $ringLayer.classList.remove("hidden"), delay));
    }
  }

  // ----- футер --------------------------------------------------------------
  function footerHTML(s) {
    const btn = (id, cls, label) => `<button id="${id}" class="v-tbtn ${cls}" type="button">${esc(label)}</button>`;
    if (s === "confirm") return btn("btnCancel", "", t("bCancel")) + btn("btnRemove", "primary", t("bRemove"));
    if (s === "progress") return `<button class="v-tbtn" type="button" disabled>${esc(t("progressFoot"))}</button>`;
    return btn("btnClose", "primary", t("bClose"));
  }
  function bindFooter() {
    const on = (id, fn) => { const el = document.getElementById(id); if (el) el.onclick = fn; };
    on("btnCancel", closeWindow);
    on("btnRemove", () => localGo("progress"));
    on("btnClose", closeWindow);
  }

  // ----- контент ------------------------------------------------------------
  function contentHTML(s) {
    if (s === "confirm") return `
      <div class="v-eyebrow">${esc(t("eyeConfirm"))}</div>
      <div class="v-body" style="margin-top:12px;max-width:300px">${esc(t("confirmBody"))}</div>
      <div style="margin-top:22px">${checkboxHTML("cbPurge", opts.purgeData, t("cbPurge"))}</div>`;

    if (s === "progress") return `
      <div class="v-eyebrow" style="margin-bottom:18px">${esc(t("eyeProgress"))}</div>
      <div id="bar" class="v-blockbar"></div>
      <div style="margin-top:18px;border-top:1px solid var(--fg-4);padding-top:14px;width:324px;max-height:118px;overflow:hidden">
        <div id="log" class="v-log"></div>
      </div>
      <div id="done" class="v-done">
        <svg width="13" height="13" viewBox="0 0 14 14"><path d="M2.5 7.5l3 3L11.5 4"/></svg>
        <span>done</span>
      </div>`;

    return `
      <div class="v-eyebrow">${esc(t("eyeDone"))}</div>
      <div class="v-body" style="margin-top:12px">${esc(t("doneBody"))}</div>`;
  }
  function checkboxHTML(id, on, label) {
    return `
      <div id="${id}" class="v-check" role="checkbox" aria-checked="${on}">
        <span class="v-box${on ? " on" : ""}">${ICON.check}</span>
        <span>${esc(label)}</span>
      </div>`;
  }
  function bindContent(s) {
    if (s === "confirm") {
      const el = document.getElementById("cbPurge");
      if (el) el.onclick = () => {
        opts.purgeData = !opts.purgeData;
        el.setAttribute("aria-checked", String(opts.purgeData));
        el.querySelector(".v-box").classList.toggle("on", opts.purgeData);
      };
    }
  }

  // ----- рендер -------------------------------------------------------------
  function render(s) {
    step = s;
    $wrap.classList.toggle("install", s === "progress");
    $stage.className = "v-stage in" + (s === "progress" ? " left" : "");
    $stage.innerHTML = contentHTML(s);
    bindContent(s);
    $footer.innerHTML = footerHTML(s);
    bindFooter();
    applyRing(s);
    if (s === "progress") startUninstall();
  }
  function go(target) {
    if (target === step || phase === "out") return;
    phase = "out";
    $stage.className = "v-stage out" + (step === "progress" ? " left" : "");
    goTimers.push(setTimeout(() => { phase = "in"; render(target); }, 235));
  }
  function localGo(target) {
    if (target === "progress") $ringLayer.classList.add("hidden");
    go(target);
  }

  // ----- удаление -----------------------------------------------------------
  function startUninstall() {
    clearArr(runTimers);
    if (runIv) clearInterval(runIv);
    progress = 0; log = [];
    const $bar = document.getElementById("bar");
    const $log = document.getElementById("log");
    const $done = document.getElementById("done");

    const renderBar = () => {
      const filled = Math.round(progress * BAR_N);
      const pct = String(Math.round(progress * 100)).padStart(2, " ");
      $bar.innerHTML =
        `<span class="br">[</span><span class="fill">${"█".repeat(filled)}</span>` +
        `<span class="empty">${"░".repeat(BAR_N - filled)}</span><span class="br">]</span>` +
        `<span class="pct">${pct}%</span>`;
    };
    const renderLog = () => {
      const running = progress < 1;
      $log.innerHTML = log.map((ln, i) =>
        `<div class="${ln.cls}">${esc(ln.t)}${running && i === log.length - 1 ? '<span class="v-cursor"></span>' : ""}</div>`
      ).join("");
    };

    renderBar(); renderLog();
    let realDone = !hasTauri;
    let failed = false;
    const start = Date.now();
    runIv = setInterval(() => {
      if (failed) return;
      const elapsed = (Date.now() - start) / UNINSTALL_MS;
      const cap = realDone ? 1 : 0.95;
      progress = Math.min(cap, elapsed);
      renderBar();
      if (progress >= 1) {
        clearInterval(runIv); runIv = null;
        renderLog();
        if ($done) $done.classList.add("show");
        runTimers.push(setTimeout(() => go("done"), 1200));
      }
    }, 40);

    LOG_SEQ.forEach((ln) => runTimers.push(setTimeout(() => {
      log.push(ln.cls === "ok" ? { cls: "ok", t: t("logDone") } : ln);
      renderLog();
    }, ln.at)));

    if (hasTauri) {
      invoke("run_uninstall", { purgeData: opts.purgeData })
        .then(() => { realDone = true; })
        .catch((err) => { failed = true; showError(err); });
    }
  }

  function showError(err) {
    if (runIv) { clearInterval(runIv); runIv = null; }
    clearArr(runTimers);
    const $log = document.getElementById("log");
    if ($log) $log.innerHTML =
      `<div style="color:var(--signal-warn)">${esc(t("errTitle"))}</div>` +
      `<div style="color:var(--fg-3);white-space:pre-wrap;word-break:break-word;max-width:324px">${esc(String(err))}</div>`;
    $footer.innerHTML = `<button id="btnErr" class="v-tbtn primary" type="button">${esc(t("bClose"))}</button>`;
    const b = document.getElementById("btnErr"); if (b) b.onclick = closeWindow;
  }

  // ----- старт --------------------------------------------------------------
  document.getElementById("winMin").onclick = minimizeWindow;
  document.getElementById("winClose").onclick = closeWindow;
  render("confirm");
  requestAnimationFrame(() => requestAnimationFrame(showWindow));
  setTimeout(showWindow, 400);
})();
