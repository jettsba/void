/* ============ «void обновлён» — баннер + модалка «что нового» (desktop + web) ============
   Пара к updater.js: тот показывает «доступно обновление» ДО установки, этот —
   «обновлён до vX.Y.Z» ПОСЛЕ, на первом запуске новой версии. Тот же угол, тот
   же шелл (.updater-banner), внутри — заголовок + текст-кнопка «что нового»,
   она открывает модалку со списком изменений — запись этой версии из
   public/changelog.js. Внизу модалки — ссылка «история изменений»: она
   заменяет модалку окном истории (js/changelog.js).

   Как понимаем, что «только что обновились»:
     localStorage["void:seen-version"] — версия, о которой уже отчитались.
     запись == текущей → ничего не делаем;
     запись != текущей → обновились, показываем баннер;
     записи нет        → смотрим void:visit (учёт визитов, js/state.js): первый
                       визит раньше сегодняшнего дня — это старый клиент, у
                       которого seen-version просто ещё не было (веб до v1.13.1),
                       показываем; иначе новичок — молча запоминаем версию.
   Запись ставим не при загрузке, а когда баннер ОТРАБОТАЛ: крестик, открытие
   «что нового» или авто-скрытие (таймер тикает только пока баннер реально на
   экране — значит, его видели). Закрыли вкладку/свернули в трей раньше — баннер
   придёт снова на следующем запуске, пока не выйдет следующая версия.

   Версию берём у Tauri (`app.getVersion()` — версия БИНАРЯ), а не из
   APP_VERSION страницы: web выкатывается раньше, чем пользователь скачает exe,
   и по версии страницы можно было бы соврать «обновлён» тому, кто ещё сидит на
   старом бинаре. APP_VERSION — только фоллбэк.

   Что показываем: заметки ВСЕХ пропущенных версий (новее seen-version, а у
   старого веб-клиента без неё — вышедших с дня последнего визита), до
   MAX_VERSIONS, свежая сверху. Ни у одной нет записи в changelog.js (одни
   микрофиксы) — баннера нет вообще (см. шапку public/changelog.js).

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
    /* Все версии, заметки которых покажет «что нового»: текущая + пропущенные
       (человек не заходил несколько релизов). Новые сверху, как в changelog.js. */
    let shownVersions = [];
    let previewing = false;
    /* Учёт визитов читаем СРАЗУ, синхронно: js/state.js перезапишет `last` на
       hello (после коннекта сокета), и «когда был в прошлый раз» потеряется. */
    const prevVisit = readVisit();
    /* Не вываливаем простыню: дальше — ссылка «история изменений». */
    const MAX_VERSIONS = 5;

    const T = (key, vars) => (window.VoidI18n && window.VoidI18n.t ? window.VoidI18n.t(key, vars) : key);

    function esc(s) {
        return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({
            "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
        })[c]);
    }

    /** Строки релиза для языка интерфейса (из public/changelog.js). Пустой
     *  массив = показывать нечего: записи для этой версии нет (микрофикс). */
    function itemsFor(version) {
        return window.VoidNotes ? window.VoidNotes.itemsFor(version) : [];
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
        banner.querySelector("[data-wn-close]").addEventListener("click", dismiss);
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
        hideTimer = setTimeout(dismiss, AUTO_HIDE_MS);
    }

    function show(version, versions) {
        shownVersion = String(version || "");
        shownVersions = versions && versions.length ? versions : [shownVersion];
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

    /** Баннер отработал (закрыли / открыли заметки / сам скрылся на виду) —
     *  больше про эту версию не напоминаем. Превью seen не трогает. */
    function dismiss() {
        if (!previewing) markSeen(shownVersion);
        hide();
    }

    function markSeen(version) {
        try { if (version) localStorage.setItem(SEEN_KEY, version); } catch (_) {}
    }

    // -------------------- Modal --------------------

    function listHtml(items) {
        return window.VoidNotes ? window.VoidNotes.listHtml(items) : "";
    }

    /** Тело модалки: одна версия — как раньше, «что нового:» + список; несколько
     *  — секция на версию с её номером в подписи (свежая сверху). */
    function sectionsHtml() {
        const vs = shownVersions.filter((v) => itemsFor(v).length);
        if (vs.length <= 1) {
            return `
            <div class="app-section">
                <span class="app-section-label">${esc(T("whatsnew.heading"))}</span>
                <ul class="app-modal-bullets">${listHtml(itemsFor(vs[0] || shownVersion))}</ul>
            </div>`;
        }
        /* Вёрстка — как в окне «история изменений» (js/changelog.js): номер +
           дата, разделитель между версиями. */
        const list = Array.isArray(window.VoidChangelog) ? window.VoidChangelog : [];
        return vs.map((v) => {
            const e = list.find((x) => String(x.version || "").trim() === v) || {};
            const m = String(e.date || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
            return `
            <section class="changelog-entry">
                <div class="changelog-head">
                    <span class="changelog-ver">v${esc(v)}</span>
                    <span class="changelog-date">${m ? `${m[3]}.${m[2]}.${m[1]}` : ""}</span>
                </div>
                <ul class="app-modal-bullets">${listHtml(itemsFor(v))}</ul>
            </section>`;
        }).join("");
    }

    function openNotes() {
        if (!shownVersions.some((v) => itemsFor(v).length)) return;
        dismiss(); // баннер своё отработал
        const modal = window.VoidAppModal;
        if (!modal) return;
        /* Заголовок — сама версия: технический ID, регистр не трогаем (гайд §2). */
        const card = modal.open(
            "v" + esc(shownVersion),
            `
            <div data-wn-body>${sectionsHtml()}</div>
            <button type="button" class="whats-new-history" data-wn-history>${esc(T("changelog.title"))}</button>
            `,
            ICON_NOTES,
            "notes-card"
        );
        /* Замена, а не стопка: VoidAppModal.open сам закрывает текущую модалку. */
        card.querySelector("[data-wn-history]")
            ?.addEventListener("click", () => window.VoidChangelogModal?.open());
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
        const body = document.querySelector("[data-wn-body]");
        const history = document.querySelector("[data-wn-history]");
        if (history) history.textContent = T("changelog.title");
        if (body) body.innerHTML = sectionsHtml();
    });

    /** Версия запущенного приложения: сперва бинарь, потом страница. */
    async function currentVersion() {
        try {
            const v = await window.__TAURI__?.app?.getVersion();
            if (v) return String(v).trim();
        } catch (_) {}
        return String(window.VoidVersion || "").trim();
    }

    function readVisit() {
        try {
            const rec = JSON.parse(localStorage.getItem("void:visit") || "null");
            return rec && typeof rec === "object" ? rec : null;
        } catch (_) {
            return null;
        }
    }

    const DAY_RX = /^\d{4}-\d{2}-\d{2}$/;

    /** Старый клиент без seen-version: первый визит был раньше сегодня. */
    function isReturningVisitor() {
        const today = new Date().toISOString().slice(0, 10);
        return !!(prevVisit && DAY_RX.test(prevVisit.first) && prevVisit.first < today);
    }

    /** "1.13.1" vs "1.9.0" по числам; старые сводки "0.12" — тоже. */
    function cmpVersion(a, b) {
        const pa = String(a).split(".").map(Number);
        const pb = String(b).split(".").map(Number);
        for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
            const d = (pa[i] || 0) - (pb[i] || 0);
            if (d) return d;
        }
        return 0;
    }

    /** Версии с заметками, которые человек пропустил, включая текущую.
     *  seen есть → всё новее seen. seen нет (старый веб-клиент до баннеров) →
     *  всё, что вышло начиная с дня последнего визита. */
    function missedVersions(version, seen) {
        const list = Array.isArray(window.VoidChangelog) ? window.VoidChangelog : [];
        const since = prevVisit && DAY_RX.test(prevVisit.last) ? prevVisit.last : "";
        return list
            .filter((e) => {
                const v = String(e.version || "").trim();
                if (!v || cmpVersion(v, version) > 0 || !itemsFor(v).length) return false;
                if (seen) return cmpVersion(v, seen) > 0;
                return v === version || (since && String(e.date || "") >= since);
            })
            .map((e) => String(e.version).trim())
            .slice(0, MAX_VERSIONS);
    }

    async function boot() {
        const version = await currentVersion();
        if (!version) return;
        let seen = null;
        try {
            seen = localStorage.getItem(SEEN_KEY);
        } catch (_) {
            return; /* приватный режим — не знаем, кто это, молчим */
        }
        if (seen === version) return;
        const versions = !seen && !isReturningVisitor() ? [] : missedVersions(version, seen);
        if (!versions.length) {
            markSeen(version); /* новичок или ни у одной пропущенной версии нет заметок */
            return;
        }
        setTimeout(() => show(version, versions), SHOW_DELAY_MS);
    }

    /** Предпросмотр вёрстки перед выкаткой: `VoidWhatsNewPreview("1.12.0")` в
     *  консоли; вторым аргументом — «последняя виденная»: `("1.13.1", "1.12.2")`
     *  покажет все пропущенные. Без аргумента — самая свежая запись changelog.js. seen-версию не
     *  трогает — можно звать сколько угодно раз и на любой платформе. */
    window.VoidWhatsNewPreview = function (version, sinceVersion) {
        const top = Array.isArray(window.VoidChangelog) && window.VoidChangelog[0];
        const v = String(version || (top && top.version) || window.VoidVersion || "");
        previewing = true;
        show(v, sinceVersion ? missedVersions(v, String(sinceVersion)) : [v]);
    };

    /* Desktop и веб: в вебе «обновление» — это новая версия страницы, на
       desktop — новая версия бинаря (см. currentVersion). */
    boot();
})();
