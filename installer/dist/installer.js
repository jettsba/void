/* ============================================================================
   void installer — клиентская оркестрация.
   Фаза 2: вёрстка + машина состояний.
   Фаза 3: реальный бэкенд (tauri-команды). Без Tauri (браузер) — моки.
   Правки: i18n ru/en + сегментный переключатель языка.

   Шаги: 0 приветствие · 1 папка · 2 установка · 3 готово · 'exists' уже устан.
   ========================================================================= */
(function () {
  "use strict";

  // ----- tauri bridge -------------------------------------------------------
  const TAURI = window.__TAURI__ || null;
  const invoke =
    TAURI && TAURI.core && TAURI.core.invoke ? TAURI.core.invoke.bind(TAURI.core) : null;
  const hasTauri = !!invoke;

  // ----- i18n ---------------------------------------------------------------
  const LANGS = [
    { code: "ru", name: "ru" },
    { code: "en", name: "en" },
  ];
  // Начальный язык — по языку системы (navigator.language в webview = язык ОС).
  // Важно для экрана «уже установлено», где переключателя нет.
  let lang = (navigator.language || "").toLowerCase().startsWith("ru") ? "ru" : "en";

  const DICT = {
    ru: {
      body0: "будет установлен на этот компьютер.",
      folder: "папка установки",
      meta: (mb, gb) => `требуется ${mb} · доступно ${gb}`,
      installing: "установка",
      installingFoot: "установка…",
      doneEye: "готово",
      doneBody: "установка завершена.",
      cbLaunch: "запустить void",
      cbDesktop: "ярлык на рабочем столе",
      existsBody: "уже установлен на этом компьютере. при продолжении текущая версия будет удалена.",
      cbPurge: "также удалить данные",
      bCancel: "отмена", bNext: "далее →", bBack: "← назад", bInstall: "установить",
      bDone: "готово", bReinstall: "удалить и переустановить",
      errTitle: "ошибка установки", bClose: "закрыть",
      logDone: "done — установлено · 0 ошибок",
    },
    en: {
      body0: "will be installed on this computer.",
      folder: "installation folder",
      meta: (mb, gb) => `requires ${mb} · ${gb} free`,
      installing: "installing",
      installingFoot: "installing…",
      doneEye: "done",
      doneBody: "installation complete.",
      cbLaunch: "launch void",
      cbDesktop: "desktop shortcut",
      existsBody: "already installed on this computer. continuing will remove the current version.",
      cbPurge: "also remove data",
      bCancel: "cancel", bNext: "next →", bBack: "← back", bInstall: "install",
      bDone: "done", bReinstall: "remove and reinstall",
      errTitle: "install failed", bClose: "close",
      logDone: "done — installed · 0 errors",
    },
  };
  const t = (k) => DICT[lang][k];

  // ----- данные (моки по умолчанию; в Tauri перезаписываются из Rust) -------
  let VERSION = "0.11.4";
  let PATH = "C:\\Users\\Admin\\AppData\\Local\\Void";
  let installDir = PATH;
  let existing = null;
  let metaMB = "17.5 mb";
  let metaGB = "94.9 gb";
  const metaStr = () => t("meta")(metaMB, metaGB);

  const LOG_SEQ = [
    { at: 0,    cls: "dim", t: "void / install" },
    { at: 280,  cls: "arr", t: "→ target  " + PATH.toLowerCase() },
    { at: 720,  cls: "arr", t: "→ extract  void.exe                 4.2 mb" },
    { at: 1150, cls: "arr", t: "→ extract  resources\\app.void       8.1 mb" },
    { at: 1600, cls: "arr", t: "→ extract  resources\\runtime\\      3.9 mb" },
    { at: 2050, cls: "arr", t: "→ extract  resources\\fonts\\        1.3 mb" },
    { at: 2480, cls: "arr", t: "→ link  start menu · void" },
    { at: 2820, cls: "arr", t: "→ link  desktop · void" },
    { at: 3160, cls: "arr", t: "→ register  void://  protocol" },
    { at: 3520, cls: "ok",  t: "__done__" }, // подменяется на t('logDone')
  ];
  const INSTALL_MS = 3650;
  const BAR_N = 22;

  const fmtMB = (b) => (b / 1048576).toFixed(1) + " mb";
  const fmtGB = (b) => (b / 1073741824).toFixed(1) + " gb";

  // ----- иконки -------------------------------------------------------------
  const ICON = {
    check:  '<svg width="12" height="12" viewBox="0 0 14 14"><path d="M3 7.3l2.6 2.6L11 4"/></svg>',
    folder: '<svg width="15" height="15" viewBox="0 0 16 16" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M2 4.2h4l1.3 1.6H14v6.6a.7.7 0 0 1-.7.7H2.7a.7.7 0 0 1-.7-.7V4.2z"/></svg>',
  };

  // ----- DOM ----------------------------------------------------------------
  const $ring = document.getElementById("ring");
  const $ringLayer = document.getElementById("ringLayer");
  const $wrap = document.getElementById("contentWrap");
  const $stage = document.getElementById("stage");
  const $footer = document.getElementById("footer");

  // ----- состояние ----------------------------------------------------------
  let step = 0;
  let phase = "in";
  const opts = { launch: true, desktop: true, purgeData: false };
  let progress = 0;
  let log = [];
  const goTimers = [];
  const ringTimers = [];
  let installTimers = [];
  let installIv = null;

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
  const ringIdle = (s) => s === 0 || s === 1 || s === "exists";
  const ringDone = (s) => s === 3;
  const ringHidden = (s) => s === 2;
  function applyRing(s) {
    clearArr(ringTimers);
    $ring.classList.toggle("breathe", ringIdle(s));
    $ring.classList.toggle("done", ringDone(s));
    if (ringHidden(s)) {
      $ringLayer.classList.add("hidden");
    } else {
      const delay = s === 3 ? 220 : (s === 0 || s === "exists") ? 80 : 0;
      ringTimers.push(setTimeout(() => $ringLayer.classList.remove("hidden"), delay));
    }
  }

  // ----- футер --------------------------------------------------------------
  function footerHTML(s) {
    const btn = (id, cls, label) => `<button id="${id}" class="v-tbtn ${cls}" type="button">${esc(label)}</button>`;
    if (s === "exists") return btn("btnCancel", "", t("bCancel")) + btn("btnReinstall", "primary", t("bReinstall"));
    if (s === 0) return btn("btnCancel", "", t("bCancel")) + btn("btnNext", "primary", t("bNext"));
    if (s === 1) return btn("btnBack", "", t("bBack")) + btn("btnInstall", "primary", t("bInstall"));
    if (s === 2) return `<button class="v-tbtn" type="button" disabled>${esc(t("installingFoot"))}</button>`;
    return btn("btnFinish", "primary", t("bDone"));
  }
  function bindFooter() {
    const on = (id, fn) => { const el = document.getElementById(id); if (el) el.onclick = fn; };
    on("btnCancel", closeWindow);
    on("btnNext", () => go(1));
    on("btnBack", () => go(0));
    on("btnInstall", () => localGo(2));
    on("btnReinstall", reinstall);
    on("btnFinish", finish);
  }

  // ----- контент ------------------------------------------------------------
  function contentHTML(s) {
    if (s === "exists") return `
      <div class="v-eyebrow">void v${esc(VERSION)}</div>
      <div class="v-body" style="margin-top:12px;max-width:300px">${esc(t("existsBody"))}</div>
      <div class="v-meta" style="margin-top:14px">${esc(existing ? existing.location : PATH)}</div>
      <div style="margin-top:20px">${checkboxHTML("cbPurge", opts.purgeData, t("cbPurge"))}</div>`;

    if (s === 0) return `
      <div class="v-eyebrow">void v${esc(VERSION)}</div>
      <div class="v-body" style="margin-top:12px;max-width:290px">${esc(t("body0"))}</div>
      <div style="margin-top:22px">${segmentHTML()}</div>`;

    if (s === 1) return `
      <div class="v-eyebrow">${esc(t("folder"))}</div>
      <div style="margin-top:16px;display:flex;gap:8px;width:316px">
        <div class="v-field" style="flex:1"><span id="pathField" class="v-path" style="font-size:12px">${esc(installDir)}</span></div>
        <button id="btnFolder" class="v-btn" type="button" aria-label="${esc(t("folder"))}">${ICON.folder}</button>
      </div>
      <div id="metaLine" class="v-meta" style="margin-top:14px">${esc(metaStr())}</div>`;

    if (s === 2) return `
      <div class="v-eyebrow" style="margin-bottom:18px">${esc(t("installing"))}</div>
      <div id="bar" class="v-blockbar"></div>
      <div style="margin-top:18px;border-top:1px solid var(--fg-4);padding-top:14px;width:324px;max-height:118px;overflow:hidden">
        <div id="log" class="v-log"></div>
      </div>
      <div id="done" class="v-done">
        <svg width="13" height="13" viewBox="0 0 14 14"><path d="M2.5 7.5l3 3L11.5 4"/></svg>
        <span>done</span>
      </div>`;

    return `
      <div class="v-eyebrow">${esc(t("doneEye"))}</div>
      <div class="v-body" style="margin-top:12px">${esc(t("doneBody"))}</div>
      <div style="margin-top:24px;display:flex;flex-direction:column;gap:14px;align-items:flex-start">
        ${checkboxHTML("cbLaunch", opts.launch, t("cbLaunch"))}
        ${checkboxHTML("cbDesktop", opts.desktop, t("cbDesktop"))}
      </div>`;
  }

  function segmentHTML() {
    return `<div id="seg" class="v-seg">${LANGS.map((l) =>
      `<button class="v-seg-opt${l.code === lang ? " on" : ""}" data-lang="${l.code}" type="button">${esc(l.name)}</button>`
    ).join("")}</div>`;
  }
  function checkboxHTML(id, on, label) {
    return `
      <div id="${id}" class="v-check" role="checkbox" aria-checked="${on}">
        <span class="v-box${on ? " on" : ""}">${ICON.check}</span>
        <span>${esc(label)}</span>
      </div>`;
  }

  // ----- биндинг интерактива ------------------------------------------------
  function bindContent(s) {
    if (s === "exists") bindCheckbox("cbPurge", "purgeData");
    if (s === 0) bindSegment();
    if (s === 1) { const f = document.getElementById("btnFolder"); if (f) f.onclick = chooseFolder; }
    if (s === 3) { bindCheckbox("cbLaunch", "launch"); bindCheckbox("cbDesktop", "desktop"); }
  }
  function bindCheckbox(id, key) {
    const el = document.getElementById(id);
    if (!el) return;
    el.onclick = () => {
      opts[key] = !opts[key];
      el.setAttribute("aria-checked", String(opts[key]));
      el.querySelector(".v-box").classList.toggle("on", opts[key]);
    };
  }
  function bindSegment() {
    document.querySelectorAll("#seg .v-seg-opt").forEach((b) => {
      b.onclick = () => {
        const c = b.getAttribute("data-lang");
        if (c !== lang) { lang = c; render(0, false); } // мгновенно применяем язык, без анимации
      };
    });
  }

  // ----- выбор папки --------------------------------------------------------
  async function chooseFolder() {
    if (!hasTauri) { console.log("[mock] pick_folder"); return; }
    try {
      const picked = await invoke("pick_folder");
      if (!picked) return;
      installDir = picked.replace(/[\\/]+$/, "") + "\\Void";
      const pf = document.getElementById("pathField");
      if (pf) pf.textContent = installDir;
      await refreshMeta(true);
    } catch (e) { console.warn("pick_folder", e); }
  }
  async function refreshMeta(updateDom) {
    if (!hasTauri) return;
    try {
      const ds = await invoke("disk_space", { dir: installDir });
      metaMB = fmtMB(ds.needed);
      metaGB = fmtGB(ds.free);
      if (updateDom) { const ml = document.getElementById("metaLine"); if (ml) ml.textContent = metaStr(); }
    } catch (e) { console.warn("disk_space", e); }
  }

  // ----- рендер шага --------------------------------------------------------
  function render(s, animate) {
    if (animate === undefined) animate = true;
    step = s;
    $wrap.classList.toggle("install", s === 2);
    $stage.className = (animate ? "v-stage in" : "v-stage") + (s === 2 ? " left" : "");
    $stage.innerHTML = contentHTML(s);
    bindContent(s);
    $footer.innerHTML = footerHTML(s);
    bindFooter();
    applyRing(s);
    if (s === 2) startInstall();
  }

  function go(target) {
    if (target === step || phase === "out") return;
    phase = "out";
    $stage.className = "v-stage out" + (step === 2 ? " left" : "");
    goTimers.push(setTimeout(() => { phase = "in"; render(target); }, 235));
  }
  function localGo(target) {
    if (target === 2) $ringLayer.classList.add("hidden");
    go(target);
  }

  // ----- удалить и переустановить -------------------------------------------
  async function reinstall() {
    if (hasTauri && existing) {
      try { await invoke("uninstall_existing", { location: existing.location, purgeData: opts.purgeData }); }
      catch (e) { console.warn("uninstall_existing", e); }
    }
    localGo(2);
  }

  // ----- установка ----------------------------------------------------------
  function startInstall() {
    clearArr(installTimers);
    if (installIv) clearInterval(installIv);
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
    installIv = setInterval(() => {
      if (failed) return;
      const elapsed = (Date.now() - start) / INSTALL_MS;
      const cap = realDone ? 1 : 0.95;
      progress = Math.min(cap, elapsed);
      renderBar();
      if (progress >= 1) {
        clearInterval(installIv); installIv = null;
        renderLog();
        if ($done) $done.classList.add("show");
        installTimers.push(setTimeout(() => go(3), 1600));
      }
    }, 40);

    LOG_SEQ.forEach((ln) => installTimers.push(setTimeout(() => {
      log.push(ln.cls === "ok" ? { cls: "ok", t: t("logDone") } : ln);
      renderLog();
    }, ln.at)));

    if (hasTauri) {
      invoke("run_install", { dir: installDir })
        .then(() => { realDone = true; })
        .catch((err) => { failed = true; showInstallError(err); });
    }
  }

  function showInstallError(err) {
    if (installIv) { clearInterval(installIv); installIv = null; }
    clearArr(installTimers);
    const $log = document.getElementById("log");
    if ($log) $log.innerHTML =
      `<div style="color:var(--signal-warn)">${esc(t("errTitle"))}</div>` +
      `<div style="color:var(--fg-3);white-space:pre-wrap;word-break:break-word;max-width:324px">${esc(String(err))}</div>`;
    $footer.innerHTML = `<button id="btnErr" class="v-tbtn primary" type="button">${esc(t("bClose"))}</button>`;
    const b = document.getElementById("btnErr"); if (b) b.onclick = closeWindow;
  }

  // ----- финиш --------------------------------------------------------------
  async function finish() {
    if (hasTauri) {
      try { await invoke("finish_install", { location: installDir, launch: opts.launch, desktopShortcut: opts.desktop, lang }); }
      catch (e) { console.warn("finish_install", e); }
    } else { console.log("[mock] finish", JSON.stringify(opts), lang); }
    closeWindow();
  }

  // ----- старт --------------------------------------------------------------
  document.getElementById("winMin").onclick = minimizeWindow;
  document.getElementById("winClose").onclick = closeWindow;

  async function boot() {
    let startStep = 0;
    if (hasTauri) {
      try {
        installDir = await invoke("default_install_dir");
        PATH = installDir;
        const ex = await invoke("detect_existing");
        if (ex && ex.installed) { existing = ex; VERSION = ex.version || VERSION; startStep = "exists"; }
        await refreshMeta(false);
      } catch (e) { console.warn("boot", e); }
    }
    if (location.hash === "#exists") startStep = "exists";
    render(startStep);
    requestAnimationFrame(() => requestAnimationFrame(showWindow));
    setTimeout(showWindow, 400);
  }

  boot();
})();
