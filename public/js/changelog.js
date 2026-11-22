/* ============ «история изменений» + общий рендер заметок к релизам ============
   Данные — public/changelog.js (window.VoidChangelog, новые сверху).

   VoidNotes — общий для этого окна и для «что нового» (js/desktop/whats-new.js):
     itemsFor(version) — строки релиза на языке интерфейса ([] — показывать нечего);
     listHtml(lines)   — <li>-разметка для .app-modal-bullets с подпунктами.

   Подпункт — строка, начинающаяся с «-» (старое «—» тоже понимаем). Он
   прицепляется к ближайшему обычному пункту выше и рендерится вложенным
   ul.notes-sub: ветка от точки родителя, текст бледнее (app-settings.css).
   Подпункт без родителя (первая строка) показываем обычным пунктом.

   Окно открывается кликом по пилюле версии в футере настроек и ссылкой внизу
   «что нового». Открытие идёт через VoidAppModal.open, а тот закрывает текущую
   модалку — «что нового» не остаётся висеть под историей.
   10 кликов по заголовку окна = жест dev-режима (js/dev-mode.js). */

(function () {
    "use strict";

    const ICON_HISTORY =
        '<svg viewBox="0 0 24 24"><path d="M4 12a8 8 0 1 0 2.4-5.7"/><path d="M4 4v4h4"/><path d="M12 8v4l2.8 1.8"/></svg>';

    const T = (key, vars) => (window.VoidI18n && window.VoidI18n.t ? window.VoidI18n.t(key, vars) : key);
    const lang = () => (window.VoidI18n && window.VoidI18n.getLang && window.VoidI18n.getLang()) || "ru";

    function esc(s) {
        return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({
            "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
        })[c]);
    }

    function entries() {
        return Array.isArray(window.VoidChangelog) ? window.VoidChangelog : [];
    }

    /** Строки записи на языке интерфейса, с фоллбэком на ru, потом en. */
    function linesOf(entry) {
        const clean = (l) =>
            (Array.isArray(entry[l]) ? entry[l] : [])
                .map((s) => String(s == null ? "" : s).trim())
                .filter(Boolean);
        const primary = clean(lang());
        if (primary.length) return primary;
        const ru = clean("ru");
        return ru.length ? ru : clean("en");
    }

    function itemsFor(version) {
        const v = String(version || "").trim();
        const entry = v && entries().find((e) => String(e.version || "").trim() === v);
        return entry ? linesOf(entry) : [];
    }

    function listHtml(lines) {
        const items = [];
        for (const line of lines) {
            const m = line.match(/^[-—]\s*(.+)$/);
            if (m && items.length) items[items.length - 1].subs.push(m[1]);
            else items.push({ text: m ? m[1] : line, subs: [] });
        }
        return items.map((it) =>
            `<li>${esc(it.text)}${it.subs.length
                ? `<ul class="notes-sub">${it.subs.map((s) => `<li>${esc(s)}</li>`).join("")}</ul>`
                : ""}</li>`
        ).join("");
    }

    // -------------------- Changelog modal --------------------

    /* "0.12" < "0.12.5" < "1.0.0": недостающие части = 0. */
    function cmp(a, b) {
        const pa = String(a).split(".").map(Number);
        const pb = String(b).split(".").map(Number);
        for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
            const d = (pa[i] || 0) - (pb[i] || 0);
            if (d) return d;
        }
        return 0;
    }

    function fmtDate(iso) {
        const m = String(iso || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
        return m ? `${m[3]}.${m[2]}.${m[1]}` : "";
    }

    function bodyHtml() {
        const running = String(window.VoidVersion || "").trim();
        /* «текущая» — самая свежая запись не новее запущенной версии: после
           микрофикса без записи пометка остаётся на последнем релизе с заметками. */
        const current = running ? entries().find((e) => cmp(e.version, running) <= 0) : null;
        return entries().map((e) => {
            const lines = linesOf(e);
            if (!lines.length) return "";
            return `
                <section class="changelog-entry">
                    <div class="changelog-head">
                        <span class="changelog-ver">v${esc(e.version)}${e === current
                            ? `<span class="changelog-now">${esc(T("changelog.current"))}</span>` : ""}</span>
                        <span class="changelog-date">${esc(fmtDate(e.date))}</span>
                    </div>
                    <ul class="app-modal-bullets">${listHtml(lines)}</ul>
                </section>`;
        }).join("");
    }

    function open() {
        const modal = window.VoidAppModal;
        if (!modal) return;
        const card = modal.open(esc(T("changelog.title")), bodyHtml(), ICON_HISTORY, "notes-card changelog-card");
        card.querySelector(".app-modal-title")
            ?.addEventListener("click", () => window.VoidDev?.registerTriggerClick());
    }

    /* Смена языка при открытом окне — перерисовываем (rules/lessons.md). */
    document.addEventListener("void:locale-changed", () => {
        const card = document.querySelector("#appModalScrim .changelog-card");
        if (!card) return;
        const title = card.querySelector(".app-modal-title");
        const body = card.querySelector(".app-modal-body");
        if (title) title.textContent = T("changelog.title");
        if (body) body.innerHTML = bodyHtml();
    });

    window.VoidNotes = { itemsFor, listHtml };
    window.VoidChangelogModal = { open };
})();
