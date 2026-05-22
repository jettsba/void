/* ========= TOAST + HINT MANAGER =========
   Единая поверхность над футером для всех неблокирующих уведомлений.

   Два состояния:
     - "hint" — пассивная подсказка (invite "пригласи друзей с кодом"),
       приходит и висит пока не дёрнут clearHint() или onClick.
     - "toast" — активное уведомление (ошибка, предупреждение, info-плашка),
       перекрывает hint, по таймеру или клику исчезает, восстанавливает hint.

   Один DOM-узел, переключаем data-kind/data-priority. Конфликт-логика:
     - toast приходит при висящем hint → hint скрывается, показывается toast;
       по закрытию toast — hint возвращается.
     - toast приходит при висящем toast → перекрывает, новый таймер.
     - hint приходит при висящем toast → ставится в "очередь", покажется
       после закрытия toast'а (на самом деле просто сохраняется _hintText).
     - hint приходит при висящем hint → просто заменяет текст.

   Не модуль (без import/export — у нас нет бандлеров, см. CONTEXT.md §14).
   Глобал `window.VoidToast` подхватывается остальными скриптами defensive'но
   через `window.VoidToast?.showToast(...)`. */

(function () {
    "use strict";

    let _el = null;
    let _toastTimer = null;
    /* "idle" — host скрыт; "hint" — показан hint; "toast" — показан toast
       (hint при этом может быть «отложен» в _hintText). */
    let _state = "idle";
    let _hintText = null;
    let _hintOnClick = null;

    function ensureHost() {
        if (_el) return _el;
        const footer = document.querySelector(".footer.footer-meta");
        if (!footer) return null;
        _el = document.createElement("div");
        _el.className = "toast-host";
        /* aria-live=polite + role=status — screen reader озвучит изменения,
           но не прервёт текущую речь. Достаточно для нашего use case. */
        _el.setAttribute("role", "status");
        _el.setAttribute("aria-live", "polite");
        _el.setAttribute("aria-atomic", "true");
        footer.appendChild(_el);
        return _el;
    }

    function applyHintState() {
        if (!_el) return;
        if (!_hintText) {
            _state = "idle";
            _el.classList.remove("is-visible");
            _el.removeAttribute("data-kind");
            _el.removeAttribute("data-priority");
            _el.onclick = null;
            return;
        }
        _state = "hint";
        _el.textContent = _hintText;
        _el.dataset.kind = "hint";
        _el.removeAttribute("data-priority");
        _el.onclick = _hintOnClick || null;
        _el.classList.toggle("is-clickable", !!_hintOnClick);
        _el.classList.add("is-visible");
    }

    function showToast(text, opts) {
        if (!ensureHost()) return;
        opts = opts || {};
        const priority = opts.priority || "info";
        const duration = typeof opts.duration === "number" ? opts.duration : 3000;
        const onClick = opts.onClick || null;

        _el.textContent = text;
        _el.dataset.kind = "toast";
        _el.dataset.priority = priority;
        _el.onclick = () => {
            if (onClick) {
                try { onClick(); } catch (_) {}
            }
            clearToast();
        };
        _el.classList.toggle("is-clickable", true);
        _el.classList.add("is-visible");
        _state = "toast";

        if (_toastTimer) clearTimeout(_toastTimer);
        if (duration > 0) {
            _toastTimer = setTimeout(clearToast, duration);
        } else {
            _toastTimer = null;
        }
    }

    function clearToast() {
        if (_toastTimer) {
            clearTimeout(_toastTimer);
            _toastTimer = null;
        }
        if (_state !== "toast") return;
        /* Если был hint — восстанавливаем. Если нет — гасим host. */
        applyHintState();
    }

    function showHint(text, opts) {
        if (!ensureHost()) return;
        opts = opts || {};
        _hintText = text;
        _hintOnClick = opts.onClick || null;
        /* Поверх toast'а hint не пробивается — он «отложен» в _hintText
           и проявится при clearToast'е. */
        if (_state !== "toast") {
            applyHintState();
        }
    }

    function clearHint() {
        _hintText = null;
        _hintOnClick = null;
        if (_state === "hint") {
            applyHintState();
        }
    }

    window.VoidToast = { showToast, showHint, clearToast, clearHint };
})();
