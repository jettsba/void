/* ============ «void обновлён» — баннер + модалка «что нового» (desktop) ============
   Пара к updater.js: тот показывает «доступно обновление» ДО установки, этот —
   «обновлён до vX.Y.Z» ПОСЛЕ, на первом запуске новой версии. Тот же угол, тот
   же шелл (.updater-banner), внутри — заголовок + текст-кнопка «что нового»,
   она открывает модалку со списком изменений из public/whats-new.js.

   Как понимаем, что «только что обновились»:
     localStorage["void:seen-version"] — версия, о которой уже отчитались.
     нет записи      → чистая установка / первый запуск с этой фичей: молча
                       запоминаем версию, поздравлять не с чем;
     запись == текущей → обычный запуск, ничего не делаем;
     запись != текущей → обновились, показываем баннер.
   Запись обновляем СРАЗУ при загрузке — один показ на версию, даже если
   пользователь закрыл окно, не дочитав.

   Версию берём у Tauri (`app.getVersion()` — версия БИНАРЯ), а не из
   APP_VERSION страницы: web выкатывается раньше, чем пользователь скачает exe,
   и по версии страницы можно было бы соврать «обновлён» тому, кто ещё сидит на
   старом бинаре. APP_VERSION — только фоллбэк.

   Гейт контента: заметки показываем, ТОЛЬКО если whats-new.js объявляет ровно
   текущую версию и в нём есть непустые строки. Иначе баннера нет вообще — это
   штатный режим для микрофиксов (см. шапку public/whats-new.js).

   Скрывается: по таймеру (12s, тикает только пока окно видно и на баннере нет
   курсора), по крестику, по открытию модалки, и уступает место апдейт-баннеру. */

(function () {
    "use strict";

    const SEEN_KEY = "void:seen-version";
    const AUTO_HIDE_MS = 12000;
    /* Пауза перед показом: приложение только что стартовало, влезать в первый
       кадр — навязчиво. */
    const SHOW_DELAY_MS = 1200;

    /* Монолайн-иконка заголовка модалки (по гайду: stroke, round caps). */
    const ICON_NOTES =
        '<svg viewBox="0 0 24 24"><path d="M5 4h9l5 5v11H5z"/><path d="M14 4v5h5"/><path d="M8.5 13h7M8.5 16.5h4.5"/></svg>';

    let banner = null;
    let hideTimer = null;
    let shownVersion = "";

    const T = (key, vars) => (window.VoidI18n && window.VoidI18n.t ? window.VoidI18n.t(key, vars) : key);

    function esc(s) {
        return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({
            "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
        })[c]);
    }

    /** Строки релиза для языка интерфейса. Пустой массив = показывать нечего. */
    function itemsFor(version) {
        const data = window.VoidWhatsNew;
        if (!data || typeof data !== "object") return [];
        if (String(data.version || "").trim() !== version) return [];
        const clean = (lang) =>
            (Array.isArray(data[lang]) ? data[lang] : [])
                .map((s) => String(s == null ? "" : s).trim())
                .filter(Boolean);
        const primary = clean((window.VoidI18n && window.VoidI18n.getLang && window.VoidI18n.getLang()) || "ru");
        if (primary.length) return primary;
        /* Списка на языке интерфейса нет — отдаём русский (или английский):
           показать заметки не на том языке лучше, чем проглотить релиз молча. */
        const ru = clean("ru");
        return ru.length ? ru : clean("en");
    }

    // -------------------- Banner --------------------

    function ensureBanner() {
        if (banner) return banner;
        banner = document.createElement("div");
        banner.className = "updater-banner whats-new-banner";
        banner.setAttribute("role", "status");
        banner.setAttribute("aria-live", "polite");
        banner.innerHTML = `
            <div class="updater-banner-inner">
                <div class="updater-banner-text">
                    <span class="updater-banner-title" data-wn-title></span>
                    <button type="button" class="whats-new-cta" data-wn-cta>
                        <span data-wn-cta-label></span>
                        <span class="whats-new-cta-arrow" aria-hidden="true">→</span>
                    </button>
                </div>
                <button type="button" class="updater-banner-dismiss" data-wn-close>
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                        <path d="M6 6l12 12M18 6L6 18"/>
                    </svg>
                </button>
            </div>
        `;
        document.body.appendChild(banner);

        banner.querySelector("[data-wn-cta]").addEventListener("click", openNotes);
        banner.querySelector("[data-wn-close]").addEventListener("click", hide);
        /* Курсор на баннере — читают: таймер не должен вырывать текст из-под рук. */
        banner.addEventListener("mouseenter", () => clearTimeout(hideTimer));
        banner.addEventListener("mouseleave", armTimer);
        return banner;
    }

    function renderBanner() {
        if (!banner) return;
        banner.querySelector("[data-wn-title]").textContent = T("whatsnew.banner", { v: "v" + shownVersion });
        banner.querySelector("[data-wn-cta-label]").textContent = T("whatsnew.cta");
        banner.querySelector("[data-wn-close]").setAttribute("aria-label", T("whatsnew.close"));
    }

    function armTimer() {
        clearTimeout(hideTimer);
        /* Окно свёрнуто/в трее — не сжигаем таймер в пустоту (запуск в автозагрузке,
           сворачивание сразу после апдейта). Таймер поедет на visibilitychange. */
        if (document.hidden || !banner || !banner.classList.contains("is-visible")) return;
        hideTimer = setTimeout(hide, AUTO_HIDE_MS);
    }

    function show(version) {
        shownVersion = String(version || "");
        ensureBanner();
        renderBanner();
        requestAnimationFrame(() => {
            banner.classList.add("is-visible");
            armTimer();
        });
    }

    function hide() {
        clearTimeout(hideTimer);
        if (banner) banner.classList.remove("is-visible");
    }

    // -------------------- Modal --------------------

    function listHtml(items) {
        return items.map((it) => `<li>${esc(it)}</li>`).join("");
    }

    function openNotes() {
        const items = itemsFor(shownVersion);
        if (!items.length) return;
        hide(); // баннер своё отработал
        const modal = window.VoidAppModal;
        if (!modal) return;
        /* Заголовок — сама версия: технический ID, регистр не трогаем (гайд §2). */
        modal.open(
            "v" + esc(shownVersion),
            `
            <div class="app-section">
                <span class="app-section-label" data-wn-heading>${esc(T("whatsnew.heading"))}</span>
                <ul class="app-modal-bullets" data-wn-list>${listHtml(items)}</ul>
            </div>
            `,
            ICON_NOTES
        );
    }

    // -------------------- Wiring --------------------

    document.addEventListener("visibilitychange", () => {
        if (document.hidden) clearTimeout(hideTimer);
        else armTimer();
    });

    /* Апдейт-баннер занимает тот же угол и важнее (там действие, тут новость) —
       уступаем ему место. Пересечься они могут только если релиз вышел в те же
       секунды, что и запуск после прошлого, но накладка выглядела бы поломкой. */
    document.addEventListener("void:updater-banner", hide);

    /* Смена языка на живом баннере/открытой модалке: перерисовываем то, что
       сейчас на экране (см. rules/lessons.md — динамику надо перерисовывать). */
    document.addEventListener("void:locale-changed", () => {
        renderBanner();
        const heading = document.querySelector("[data-wn-heading]");
        const list = document.querySelector("[data-wn-list]");
        if (heading) heading.textContent = T("whatsnew.heading");
        if (list) list.innerHTML = listHtml(itemsFor(shownVersion));
    });

    /** Версия запущенного приложения: сперва бинарь, потом страница. */
    async function currentVersion() {
        try {
            const v = await window.__TAURI__?.app?.getVersion();
            if (v) return String(v).trim();
        } catch (_) {}
        return String(window.VoidVersion || "").trim();
    }

    async function boot() {
        const version = await currentVersion();
        if (!version) return;
        let seen = null;
        try {
            seen = localStorage.getItem(SEEN_KEY);
            localStorage.setItem(SEEN_KEY, version);
        } catch (_) {
            /* приватный режим / квота — просто не покажем баннер */
        }
        if (!seen || seen === version) return;
        if (!itemsFor(version).length) return;
        setTimeout(() => show(version), SHOW_DELAY_MS);
    }

    /** Предпросмотр вёрстки перед выкаткой: `VoidWhatsNewPreview()` в консоли.
     *  Берёт версию из whats-new.js, seen-версию не трогает — можно звать сколько
     *  угодно раз и на любой платформе. */
    window.VoidWhatsNewPreview = function (version) {
        show(String(version || (window.VoidWhatsNew && window.VoidWhatsNew.version) || window.VoidVersion || ""));
    };

    /* Авто-показ — только desktop: в вебе «обновления приложения» нет, страница
       просто перезагружается с новым кодом. */
    if (window.VoidPlatform === "desktop") boot();
})();
