/* ============ Auto-updater UI (desktop-only) ============
   Слушает событие от Rust о доступной новой версии, показывает баннер в
   левом нижнем углу. При клике "Обновить" — emit event обратно в Rust,
   плагин скачает signed exe + verify signature + silent install + relaunch.

   States (primary-кнопка — только иконка, без текста):
     idle        — "доступно обновление" / "void vX.Y.Z" + [↓] [×]
     confirm     — "обновление закроет приложение" (в комнате) + [✓] [×]
     downloading — "скачивание... NN%" + progress bar
     ready       — installer запускается, плагин сам рестартнёт Void
     error       — "ошибка обновления" + [↻] [×]

   Snooze: при клике × банер прячется на 24 часа (localStorage).
   Если за этот срок прилетит ДРУГАЯ версия — снова покажется. */

(function () {
    "use strict";

    const L = window.log;
    const dlog = (msg, fields) =>
        (L && L.info ? L.info("updater", msg, fields || {}) : console.log("[updater]", msg, fields || {}));

    /* Диагностика инициализации — ДО гварда, чтобы видеть почему модуль мог
       выйти раньше времени (platform не desktop / нет __TAURI__.event). Гейтим
       на наличие __TAURI__ — на вебе его нет, и прод-консоль не засоряется. */
    if (window.__TAURI__) {
        dlog("script loaded", {
            platform: window.VoidPlatform,
            event: !!(window.__TAURI__ && window.__TAURI__.event),
        });
    }

    if (window.VoidPlatform !== "desktop") return;
    if (!window.__TAURI__ || !window.__TAURI__.event) return;

    const SNOOZE_KEY = "void:updater-snoozed";
    const SNOOZE_DURATION_MS = 24 * 60 * 60 * 1000;

    /* Иконки primary-кнопки (текста нет — только глиф). Stroke-стиль, цвет
       наследуется от кнопки (var(--screen)). aria-label ставится в setState. */
    const ICON_DOWNLOAD =
        '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v11"/><path d="M7 11l5 5 5-5"/><path d="M5 19.5h14"/></svg>';
    const ICON_CHECK =
        '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7"/></svg>';
    const ICON_RETRY =
        '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19.5 11a7.5 7.5 0 10-2.1 5.3"/><path d="M19.5 5v6h-6"/></svg>';

    /* Состояние модуля: храним последнюю предложенную версию + статус.
       Если прилетела новая major-version пока юзер заснузил — снимаем snooze. */
    let banner = null;
    let lastVersion = null;
    let totalBytes = 0;

    function isSnoozed(version) {
        try {
            const raw = localStorage.getItem(SNOOZE_KEY);
            if (!raw) return false;
            const data = JSON.parse(raw);
            if (!data || typeof data.until !== "number") return false;
            if (data.version !== version) return false;
            return data.until > Date.now();
        } catch {
            return false;
        }
    }

    function snooze(version) {
        try {
            localStorage.setItem(
                SNOOZE_KEY,
                JSON.stringify({ version, until: Date.now() + SNOOZE_DURATION_MS })
            );
        } catch {}
    }

    function clearSnooze() {
        try { localStorage.removeItem(SNOOZE_KEY); } catch {}
    }

    function escapeHtml(s) {
        return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({
            "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
        })[c]);
    }

    function ensureBanner() {
        if (banner) return banner;
        banner = document.createElement("div");
        banner.className = "updater-banner";
        banner.setAttribute("role", "status");
        banner.setAttribute("aria-live", "polite");
        banner.innerHTML = `
            <div class="updater-banner-inner">
                <div class="updater-banner-text">
                    <span class="updater-banner-title"></span>
                    <span class="updater-banner-body"></span>
                </div>
                <div class="updater-banner-actions">
                    <button type="button" class="updater-banner-primary"></button>
                    <button type="button" class="updater-banner-dismiss" aria-label="закрыть">
                        <svg viewBox="0 0 24 24" aria-hidden="true">
                            <path d="M6 6l12 12M18 6L6 18"/>
                        </svg>
                    </button>
                </div>
            </div>
            <div class="updater-banner-progress"><span class="updater-banner-progress-fill"></span></div>
        `;
        document.body.appendChild(banner);

        banner.querySelector(".updater-banner-primary").addEventListener("click", onPrimary);
        banner.querySelector(".updater-banner-dismiss").addEventListener("click", onDismiss);

        return banner;
    }

    function setState(state) {
        const b = ensureBanner();
        b.dataset.state = state;
        const title = b.querySelector(".updater-banner-title");
        const body = b.querySelector(".updater-banner-body");
        const primary = b.querySelector(".updater-banner-primary");

        switch (state) {
            case "idle":
                title.textContent = "доступно обновление";
                body.textContent = `void v${lastVersion}`;
                body.hidden = false;
                primary.innerHTML = ICON_DOWNLOAD;
                primary.setAttribute("aria-label", "обновить");
                primary.hidden = false;
                break;
            case "confirm":
                /* юзер в комнате — обновление оборвёт звонок. Одна строка
                   основным белым, без второй строки. */
                title.textContent = "обновление закроет приложение";
                body.hidden = true;
                primary.innerHTML = ICON_CHECK;
                primary.setAttribute("aria-label", "выйти и обновить");
                primary.hidden = false;
                break;
            case "downloading":
                title.textContent = `обновление до v${lastVersion}`;
                body.hidden = false;
                body.textContent = "скачивание...";
                primary.hidden = true;
                break;
            case "ready":
                title.textContent = "установка";
                body.hidden = false;
                body.textContent = "void перезапустится";
                primary.hidden = true;
                break;
            case "error":
                title.textContent = "ошибка обновления";
                body.hidden = false;
                body.textContent = "попробовать снова?";
                primary.innerHTML = ICON_RETRY;
                primary.setAttribute("aria-label", "повторить");
                primary.hidden = false;
                break;
        }
    }

    /* Плавная подмена состояния: текст уезжает/гаснет, в этот момент
       меняется контент и высота карточки (FLIP), затем текст возвращается.
       Используется для idle → confirm, где меняется заголовок и пропадает
       вторая строка — иначе скачок был бы резким. */
    function swapState(newState) {
        const b = ensureBanner();
        const textEl = b.querySelector(".updater-banner-text");
        const startH = b.offsetHeight;
        textEl.classList.add("is-swapping");
        setTimeout(() => {
            setState(newState);
            const endH = b.offsetHeight;
            b.style.height = startH + "px";
            void b.offsetHeight; // форсим reflow перед анимацией высоты
            b.style.transition = "height 200ms cubic-bezier(.2, .6, .2, 1)";
            b.style.height = endH + "px";
            requestAnimationFrame(() => textEl.classList.remove("is-swapping"));
            const cleanup = (e) => {
                if (e.propertyName !== "height") return;
                b.style.height = "";
                b.style.transition = "";
                b.removeEventListener("transitionend", cleanup);
            };
            b.addEventListener("transitionend", cleanup);
        }, 140);
    }

    function showBanner() {
        const b = ensureBanner();
        requestAnimationFrame(() => b.classList.add("is-visible"));
    }

    function hideBanner() {
        if (!banner) return;
        banner.classList.remove("is-visible");
    }

    function updateProgress(downloaded, total) {
        if (!banner) return;
        const fill = banner.querySelector(".updater-banner-progress-fill");
        const body = banner.querySelector(".updater-banner-body");
        if (total && total > 0) {
            const pct = Math.min(100, Math.floor((downloaded / total) * 100));
            fill.style.width = pct + "%";
            body.textContent = `скачивание ${pct}%`;
        } else {
            body.textContent = "скачивание...";
        }
    }

    function isInRoom() {
        /* isJoined — глобал из js/state.js; до инициализации typeof кинет
           ReferenceError (TDZ), поэтому в try. */
        try { return typeof isJoined !== "undefined" && !!isJoined; }
        catch { return false; }
    }

    function triggerInstall() {
        setState("downloading");
        totalBytes = 0;
        window.__TAURI__.event
            .emit("void:updater-install")
            .catch((e) => console.warn("[updater] emit install failed", e));
    }

    function onPrimary() {
        const state = banner && banner.dataset.state;
        if (state === "idle") {
            /* в комнате рестарт оборвёт звонок — сначала подтверждение */
            if (isInRoom()) { swapState("confirm"); return; }
            triggerInstall();
        } else if (state === "confirm" || state === "error") {
            triggerInstall();
        }
    }

    function onDismiss() {
        if (lastVersion) snooze(lastVersion);
        hideBanner();
    }

    // -------------- Tauri event subscriptions --------------

    window.__TAURI__.event
        .listen("void:updater-available", (event) => {
            const p = (event && event.payload) || {};
            const version = String(p.version || "?");
            dlog("update available", { version });
            lastVersion = version;
            if (isSnoozed(version)) { dlog("snoozed — banner suppressed", { version }); return; }
            /* Loosened dedup: Rust теперь эмитит available на каждой удачной
               проверке (страховка от пропуска эмита). Не сбиваем активную
               загрузку/установку повторным показом. */
            const st = banner && banner.dataset.state;
            if (st === "downloading" || st === "ready") return;
            setState("idle");
            showBanner();
        })
        .catch((e) => console.warn("[updater] listen available failed", e));

    /* Диагностика результата фоновой проверки (uptodate / error / init-error)
       от Rust — на Windows release eprintln невидим, поэтому статус приходит
       сюда и пишется в лог. */
    window.__TAURI__.event
        .listen("void:updater-status", (event) => {
            dlog("check result", (event && event.payload) || {});
        })
        .catch(() => {});

    window.__TAURI__.event
        .listen("void:updater-progress", (event) => {
            const p = (event && event.payload) || {};
            const downloaded = Number(p.downloaded || 0);
            const total = Number(p.total || 0);
            if (total > totalBytes) totalBytes = total;
            updateProgress(downloaded, totalBytes);
        })
        .catch(() => {});

    window.__TAURI__.event
        .listen("void:updater-error", (event) => {
            const p = (event && event.payload) || {};
            console.warn("[updater] error:", p.message);
            setState("error");
        })
        .catch(() => {});

    /* На случай если юзер только что обновился — снимаем snooze, чтобы
       следующее обновление точно показалось без задержки. */
    if (window.VoidVersion && lastVersion === window.VoidVersion) {
        clearSnooze();
    }

    /* Само-проверка на старте: гарантируем, что webview получит актуальный статус,
       даже если ранний emit режима B разошёлся по времени с подключением
       слушателя (см. lessons: пропуск единственного эмита). Не manual → тостов
       нет, только баннер при наличии апдейта. */
    if (window.__TAURI__ && window.__TAURI__.event) {
        setTimeout(() => {
            window.__TAURI__.event.emit("void:updater-check").catch(() => {});
        }, 3000);
    }
})();
