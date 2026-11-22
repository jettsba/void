/* ===== Friends: UI (window.VoidFriendsUI) =====
   - bottom-left «друзья · N» (.tbtn, the twin of «чат») toggles a panel
     (plain fade; phones: bottom sheet). The tab row [друзья|заявки|+] sits at
     the bottom, under the label: on open the icon folds away, the word slides
     onto the first tab and IS that tab (the tab cell under it takes clicks)
   - "+" → add modal: three tiles (qr / code / link), one grows into a field
   - friend & participant profile (VoidAppModal shell), friendship code row →
     the same modal as the room security code (.sas-modal, same reveal)
   - participant blob: second click = profile; the "more" dots live in
     participants.js / css, nothing friend-specific is drawn on the blob
   - settings profile: nick#code line, invisible, device transfer
   Every "choose an option" UI is one component (.sx): equal buttons; the chosen
   one grows over the others in its own direction (left → right, right → left),
   a square action slides in, details + cancel drop in below — one duration.
   Protocol: js/friends/net.js. */
(function () {
    "use strict";

    const F = window.VoidFriends;
    if (!F) return;

    const t = (k, v) => (typeof _t === "function" ? _t(k, v) : k);
    const esc = (s) => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
    /* Every nick on screen goes through displayNick (config.js) — one form
       everywhere; premium (contributor) nicks are gold everywhere too. */
    const nk = (s) => (typeof displayNick === "function" ? displayNick(s) : String(s ?? ""));
    const goldCls = (nick) => (typeof isPremiumNickname === "function" && isPremiumNickname(nick) ? " nick-gold" : "");
    const isTouch = () => matchMedia("(hover: none) and (pointer: coarse)").matches;
    const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
    const IS_DESKTOP = window.VoidPlatform === "desktop";
    /* Camera scan only in a browser: the desktop app has no camera permission
       on purpose (1.7.0 security patch), and a phone is the device that scans. */
    const CAN_SCAN = !IS_DESKTOP && !!navigator.mediaDevices?.getUserMedia;
    const MED_MS = typeof MOTION !== "undefined" ? MOTION.med : 320;

    const svg = (inner) => `<svg viewBox="0 0 24 24" aria-hidden="true">${inner}</svg>`;
    const ICON = {
        friends: svg('<circle cx="9" cy="8.5" r="3.2"/><path d="M3 19.5c0-3.2 2.7-5 6-5s6 1.8 6 5"/><path d="M15.5 5.6a3.2 3.2 0 0 1 0 5.8"/><path d="M17.6 14.8c2 .6 3.4 2.1 3.4 4.7"/>'),
        person: svg('<circle cx="12" cy="8" r="3.6"/><path d="M4.5 20.5c0-3.6 3.4-5.5 7.5-5.5s7.5 1.9 7.5 5.5"/>'),
        plus: svg('<path d="M12 5.5v13M5.5 12h13"/>'),
        mail: svg('<rect x="3.5" y="6" width="17" height="12" rx="1.4"/><path d="M4.2 7.2 12 13l7.8-5.8"/>'),
        check: svg('<path d="M5.5 12.5l4.2 4.2L18.5 8"/>'),
        enter: svg('<path d="M14 4h4.6A1.4 1.4 0 0 1 20 5.4v13.2a1.4 1.4 0 0 1-1.4 1.4H14"/><path d="M9.5 7.5 14 12l-4.5 4.5"/><path d="M14 12H4"/>'),
        lock: svg('<rect x="5" y="11" width="14" height="9.5" rx="1.4"/><path d="M8.5 11V7.5a3.5 3.5 0 0 1 7 0V11"/>'),
        x: svg('<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>'),
        copy: svg('<rect x="9" y="9" width="11" height="11" rx="1.4"/><path d="M5 15V5.5A1.5 1.5 0 0 1 6.5 4H15"/>'),
        qr: svg('<rect x="4" y="4" width="6" height="6" rx="1"/><rect x="14" y="4" width="6" height="6" rx="1"/><rect x="4" y="14" width="6" height="6" rx="1"/><path d="M14 14h2.5v2.5H14zM17.5 17.5H20V20h-2.5zM14 19h1M20 14v1.5"/>'),
        scan: svg('<path d="M4 8V5.4A1.4 1.4 0 0 1 5.4 4H8M16 4h2.6A1.4 1.4 0 0 1 20 5.4V8M20 16v2.6a1.4 1.4 0 0 1-1.4 1.4H16M8 20H5.4A1.4 1.4 0 0 1 4 18.6V16"/><path d="M4 12h16"/>'),
        send: svg('<path d="M5 12h13"/><path d="M13 6.5 18.5 12 13 17.5"/>'),
        hash: svg('<path d="M9.5 4 7.5 20M16.5 4l-2 16M4.5 9h15M3.5 15h15"/>'),
        link: svg('<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>'),
        eye: svg('<path d="M2.5 12s3.5-6.5 9.5-6.5 9.5 6.5 9.5 6.5-3.5 6.5-9.5 6.5S2.5 12 2.5 12Z"/><circle cx="12" cy="12" r="2.8"/>'),
        keys: svg('<rect x="3" y="6" width="18" height="12" rx="1.4"/><path d="M7 10h.01M10.5 10h.01M14 10h.01M17 10h.01M7.5 14h9"/>'),
        chevron: '<svg class="settings-cat-arrow" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>',
    };

    /* ---------- helpers ---------- */
    function setHtml(el, html) {
        if (!el || el._html === html) return;
        el._html = html;
        el.innerHTML = html;
    }

    function flashSwap(el, ms = 1600) {
        if (!el) return;
        el.classList.add("is-swapped");
        clearTimeout(el._swapT);
        el._swapT = setTimeout(() => el.classList.remove("is-swapped"), ms);
    }
    window.VoidSwap = { flash: flashSwap };

    async function copyText(text) {
        try { await navigator.clipboard.writeText(text); return true; } catch (_) {}
        try {
            const ta = document.createElement("textarea");
            ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
            document.body.appendChild(ta); ta.select();
            const ok = document.execCommand("copy");
            ta.remove();
            return ok;
        } catch (_) { return false; }
    }

    /* The app curve, cubic-bezier(.2, .6, .2, 1) (--t-med), for motion that
       CSS cannot run — e.g. scrolling a container. */
    function appEase(x) {
        const x1 = 0.2, y1 = 0.6, x2 = 0.2, y2 = 1;
        let u = x;
        for (let i = 0; i < 8; i++) {
            const v = 1 - u;
            const err = 3 * x1 * u * v * v + 3 * x2 * u * u * v + u * u * u - x;
            const d = 3 * x1 * v * v + 6 * (x2 - x1) * u * v + 3 * (1 - x2) * u * u;
            if (Math.abs(err) < 1e-5 || Math.abs(d) < 1e-6) break;
            u = Math.min(1, Math.max(0, u - err / d));
        }
        const v = 1 - u;
        return 3 * y1 * u * v * v + 3 * y2 * u * u * v + u * u * u;
    }

    /* Scroll the nearest scrolling ancestor to its very end, on the app curve. */
    function scrollToEnd(el, ms = MED_MS) {
        let sc = el.parentElement;
        while (sc && sc !== document.body) {
            const oy = getComputedStyle(sc).overflowY;
            if (oy === "auto" || oy === "scroll") break;
            sc = sc.parentElement;
        }
        if (!sc || sc === document.body) return;
        cancelAnimationFrame(sc._endScrollT);
        const from = sc.scrollTop;
        if (reduced()) { sc.scrollTop = sc.scrollHeight; return; }
        const t0 = performance.now();
        const prevBehavior = sc.style.scrollBehavior;
        sc.style.scrollBehavior = "auto";
        const step = (now) => {
            const p = Math.min(1, (now - t0) / ms);
            const max = Math.max(from, sc.scrollHeight - sc.clientHeight);
            sc.scrollTop = from + (max - from) * appEase(p);
            if (p < 1) sc._endScrollT = requestAnimationFrame(step);
            else sc.style.scrollBehavior = prevBehavior;
        };
        sc._endScrollT = requestAnimationFrame(step);
    }

    const scriptLoads = new Map();
    function loadScript(src) {
        if (!scriptLoads.has(src)) {
            scriptLoads.set(src, new Promise((resolve, reject) => {
                const s = document.createElement("script");
                s.src = src;
                s.onload = resolve;
                s.onerror = () => { scriptLoads.delete(src); reject(new Error("load " + src)); };
                document.head.appendChild(s);
            }));
        }
        return scriptLoads.get(src);
    }

    /* "Generation" of a code: each character flickers through random symbols
       and locks, left to right — the telegram-style "encrypting" feel. */
    const SCRAMBLE = "ABCDEFGHJKMNPQRSTVWXYZ0123456789#$%&*+=?";
    function scramble(el, text, { step = 32, spin = 260 } = {}) {
        if (!el) return;
        cancelAnimationFrame(el._scrT);
        if (reduced()) { el.textContent = text; return; }
        const chars = [...text];
        const start = performance.now();
        const frame = (now) => {
            const tt = now - start;
            let out = "", done = true;
            chars.forEach((c, i) => {
                const lock = i * step + spin;
                if (tt >= lock || c === " " || c === "-" || c === "#" || c === "/" || c === ".") out += c;
                else {
                    done = false;
                    out += tt < i * step * 0.5 ? " " : SCRAMBLE[(Math.random() * SCRAMBLE.length) | 0];
                }
            });
            el.textContent = out;
            if (!done) el._scrT = requestAnimationFrame(frame);
        };
        el._scrT = requestAnimationFrame(frame);
    }

    /* "nick#0198" with the code a step paler; the whole thing copies. */
    function tagHtml(nick, code, gold = false) {
        return `<span class="fr-tag"><span class="fr-tag-nick${gold ? goldCls(nick) : ""}">${esc(nk(nick))}</span><span class="fr-tag-code">#${esc(code)}</span></span>`;
    }
    function copyTagHtml(nick, code, gold = false) {
        return `<span class="swap"><span class="swap-main">${tagHtml(nick, code, gold)}</span><span class="swap-alt">${esc(t("invite.copied"))}</span></span>`;
    }

    /* ---------- qr ---------- */
    function qrSvg(text) {
        return window.VoidQR.svg(text, "fr-qr-svg");
    }

    async function showQr(box, text) {
        box.classList.remove("is-drawn");
        box.innerHTML = '<div class="fr-qr-inner"></div><span class="fr-qr-scanline" aria-hidden="true"></span>';
        try {
            box.firstElementChild.innerHTML = await qrSvg(text);
        } catch (_) {
            box.firstElementChild.textContent = text;
        }
        requestAnimationFrame(() => requestAnimationFrame(() => box.classList.add("is-drawn")));
    }

    /* ---------- camera scanner (web) ---------- */
    let scanner = null;
    async function openScanner(onText) {
        if (!CAN_SCAN || scanner) return;
        const el = document.createElement("div");
        el.className = "fr-scan";
        el.setAttribute("role", "dialog");
        el.innerHTML = `
            <video class="fr-scan-video" playsinline muted></video>
            <div class="fr-scan-frame" aria-hidden="true"><i></i><i></i><i></i><i></i><span class="fr-scan-line"></span></div>
            <p class="fr-scan-hint">${esc(t("friends.scan.hint"))}</p>
            <button type="button" class="fr-scan-close" aria-label="${esc(t("chat.close"))}">${ICON.x}</button>`;
        document.body.appendChild(el);
        const state = { el, stream: null, raf: 0, done: false };
        scanner = state;
        const onKey = (e) => { if (e.key === "Escape") { e.stopPropagation(); close(); } };
        const close = () => {
            if (state.done) return;
            state.done = true;
            cancelAnimationFrame(state.raf);
            state.stream?.getTracks().forEach(tr => tr.stop());
            el.classList.remove("is-open");
            setTimeout(() => el.remove(), MED_MS);
            if (scanner === state) scanner = null;
            document.removeEventListener("keydown", onKey, true);
        };
        document.addEventListener("keydown", onKey, true);
        el.querySelector(".fr-scan-close").addEventListener("click", close);
        requestAnimationFrame(() => el.classList.add("is-open"));
        try {
            await loadScript("vendor/jsQR.js");
            state.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false });
        } catch (_) {
            close();
            window.VoidToast?.showToast(t("friends.scan.nocam"), { priority: "warn" });
            return;
        }
        if (state.done) { state.stream.getTracks().forEach(tr => tr.stop()); return; }
        const video = el.querySelector("video");
        video.srcObject = state.stream;
        try { await video.play(); } catch (_) {}
        const canvas = document.createElement("canvas");
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        const tick = () => {
            if (state.done) return;
            if (video.readyState >= 2 && video.videoWidth) {
                const k = Math.min(1, 640 / Math.max(video.videoWidth, video.videoHeight));
                canvas.width = Math.round(video.videoWidth * k);
                canvas.height = Math.round(video.videoHeight * k);
                ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
                const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
                const hit = window.jsQR?.(img.data, img.width, img.height, { inversionAttempts: "attemptBoth" });
                if (hit?.data) {
                    close();
                    onText(hit.data);
                    return;
                }
            }
            state.raf = requestAnimationFrame(tick);
        };
        state.raf = requestAnimationFrame(tick);
    }

    /* Anything our QR codes carry: a friend link or a transfer link. */
    function handleScanned(text) {
        const s = String(text || "");
        const fr = s.match(/#friend=([A-Za-z0-9_-]{22})/);
        if (fr) { window.VoidAppModal?.close(); F.useLink(fr[1]); return; }
        const tr = s.match(/#transfer=([0-9A-Za-z]{16})/);
        if (tr) { F.joinTransfer(tr[1]); return; }
        window.VoidToast?.showToast(t("friends.scan.unknown"), { priority: "warn" });
    }

    /* ---------- .sx: equal buttons, the chosen one grows into a field ----------
       Option: { id, icon, label, hint?, face: "input" | "text" | "label",
                 placeholder?, inputAttrs?, faceLabel?, faceMeta?, sq?: { icon, label }, pane } */
    function sxFaceHtml(o) {
        if (o.face === "input" && o.mask) {
            return `<span class="sx-mask"><span class="sx-mask-view" aria-hidden="true"></span><input type="text" class="sx-input" spellcheck="false" autocomplete="off" tabindex="-1" aria-label="${esc(o.label)}" ${o.inputAttrs || ""}></span>`;
        }
        if (o.face === "input") {
            return `<input type="text" class="sx-input" spellcheck="false" autocomplete="off" tabindex="-1" placeholder="${esc(o.placeholder || "")}" ${o.inputAttrs || ""}>`;
        }
        if (o.face === "label") {
            return `<span class="sx-flabel"><span class="sx-ic">${o.icon}</span><span class="sx-flabel-text">${esc(o.faceLabel || o.label)}</span>${o.faceMeta ? `<span class="sx-fmeta">${esc(o.faceMeta)}</span>` : ""}</span>`;
        }
        /* The copy icon hangs off the left edge of the text: the text itself is
           what sits in the centre, the icon does not shift it. */
        return `<button type="button" class="sx-text" tabindex="-1" data-sx-copy="${o.id}"><span class="swap">${o.copyIcon ? `<span class="sx-copy-ic" aria-hidden="true">${ICON.copy}</span>` : ""}<span class="swap-main sx-value"></span><span class="swap-alt">${esc(t("invite.copied"))}</span></span></button>`;
    }

    function sxHtml(opts, { tiles = false, extra = "" } = {}) {
        return `<div class="sx${tiles ? " sx--tiles" : ""}" data-mode="">
            <div class="sx-line">
                ${opts.map(o => `<div class="sx-cell" data-sx="${o.id}">
                    <button type="button" class="sx-btn" data-sx-open="${o.id}">
                        <span class="sx-btn-in">
                            <span class="sx-ic">${o.icon}</span>
                            <span class="sx-label">${esc(o.label)}</span>
                            ${o.hint ? `<span class="sx-hint">${esc(o.hint)}</span>` : ""}
                        </span>
                    </button>
                    <div class="sx-face">${sxFaceHtml(o)}</div>
                </div>`).join("")}
                <button type="button" class="sx-sq" data-sx-sq tabindex="-1"></button>
            </div>
            <div class="sx-panel"><div class="sx-panel-inner">
                ${opts.map(o => `<div class="sx-pane" data-pane="${o.id}">${o.pane || ""}</div>`).join("")}
                ${extra}
                <div class="sx-cancel"><button type="button" class="fr-btn is-ghost" data-sx-cancel tabindex="-1">${esc(t("friends.cancel"))}</button></div>
            </div></div>
        </div>`;
    }

    /* Column widths are written inline: an fr ↔ fr / length ↔ length list of the
       same shape interpolates smoothly, so the grow is one continuous motion. */
    function sxColumns(group, mode) {
        const cells = [...group.querySelectorAll(".sx-cell")];
        const sq = mode && group._opts?.find(o => o.id === mode)?.sq;
        const cols = cells.map(c => (!mode || c.dataset.sx === mode) ? "minmax(0, 1fr)" : "minmax(0, 0fr)");
        /* The square track carries its own gap, so the button itself is square. */
        cols.push(sq ? "calc(var(--sx-h) + var(--sx-gap))" : "0px");
        group.querySelector(".sx-line").style.gridTemplateColumns = cols.join(" ");
    }

    function sxMount(group, opts) {
        group._opts = opts;
        sxColumns(group, "");
    }

    function sxSetMode(group, mode) {
        const prev = group.dataset.mode;
        group.dataset.mode = mode || "";
        const opt = mode ? group._opts.find(o => o.id === mode) : null;
        const cells = group.querySelectorAll(".sx-cell");
        const idx = [...cells].findIndex(c => c.dataset.sx === mode);
        /* Direction for the label shift: the cell grows away from its own side. */
        group.dataset.dir = !mode ? "" : idx === 0 ? "right" : idx === cells.length - 1 ? "left" : "both";
        cells.forEach(cell => {
            const on = cell.dataset.sx === mode;
            cell.dataset.state = !mode ? "idle" : on ? "open" : "gone";
            cell.querySelector(".sx-btn").setAttribute("tabindex", mode ? "-1" : "0");
            cell.querySelectorAll(".sx-input, .sx-text").forEach(el => el.setAttribute("tabindex", on ? "0" : "-1"));
        });
        const sq = group.querySelector(".sx-sq");
        if (opt?.sq) {
            sq.innerHTML = opt.sq.icon;
            sq.setAttribute("aria-label", opt.sq.label || "");
            sq.setAttribute("tabindex", "0");
        } else {
            sq.setAttribute("tabindex", "-1");
        }
        sq.classList.remove("is-on");
        /* The pressed idle button keeps focus otherwise, and the opened cell
           (a plain label for qr) would light up as if it were a field. */
        if (mode && group.contains(document.activeElement)) document.activeElement.blur();
        /* Panes: the new one shows on open; on close the old one stays until
           the panel has folded, or it would vanish before the collapse. */
        if (mode) group.querySelectorAll(".sx-pane").forEach(p => p.classList.toggle("is-shown", p.dataset.pane === mode));
        group.querySelector("[data-sx-cancel]").setAttribute("tabindex", mode ? "0" : "-1");
        sxColumns(group, mode);
        if (!mode && prev) group.querySelector(".sx-btn")?.blur();
    }

    /* ---------- bar + popover ---------- */
    let root, pop, panes, listEl, reqEl;
    let activeTab = "friends";
    const lockSwapUntil = new Map();

    function mount() {
        const app = document.getElementById("app");
        if (!app || document.getElementById("friends")) return;
        root = document.createElement("div");
        root.className = "friends";
        root.id = "friends";
        root.dataset.tab = "friends";
        root.innerHTML = `
            <div class="friends-scrim" aria-hidden="true"></div>
            <div class="fbar-wrap">
                <div class="friends-pop" id="friendsPop" role="dialog" aria-hidden="true" inert>
                    <div class="friends-grip" aria-hidden="true"></div>
                    <div class="friends-panes">
                        <div class="friends-pane" data-pane="friends"><ul class="friends-list"></ul></div>
                        <div class="friends-pane" data-pane="requests"><div class="friends-req"></div></div>
                    </div>
                    <div class="friends-head" role="tablist">
                        <button type="button" class="fbar-seg fbar-tab-friends" data-tab="friends" role="tab"><span class="fbar-label fbar-label--friends"></span><span class="fbar-count"></span></button>
                        <button type="button" class="fbar-seg fbar-req" data-tab="requests" role="tab"><span class="fbar-label fbar-label--req"></span><span class="fbar-badge"></span></button>
                        <button type="button" class="fbar-seg fbar-add">${ICON.plus}</button>
                    </div>
                </div>
                <button type="button" class="fbar-pill tbtn" id="friendsPill" aria-haspopup="dialog" aria-expanded="false" aria-controls="friendsPop">
                    <span class="tbtn-ic">${ICON.friends}</span>
                    <span class="fbar-label fbar-label--pill"></span>
                    <span class="fbar-count"></span>
                    <span class="fbar-dot" aria-hidden="true"></span>
                </button>
            </div>`;
        app.appendChild(root);
        pop = root.querySelector(".friends-pop");
        panes = root.querySelector(".friends-panes");
        listEl = root.querySelector(".friends-list");
        reqEl = root.querySelector(".friends-req");

        root.querySelector("#friendsPill").addEventListener("click", (e) => {
            e.stopPropagation();
            if (isOpen()) closePop(); else openPop();
        });
        /* The label lies over this tab and IS it: on the open friends tab it
           closes, like the label did (and like «закрыть» for the chat). */
        root.querySelector(".fbar-tab-friends").addEventListener("click", (e) => {
            e.stopPropagation();
            if (activeTab === "friends") closePop(); else setTab("friends");
        });
        root.querySelector(".fbar-req").addEventListener("click", (e) => { e.stopPropagation(); setTab("requests"); });
        root.querySelector(".fbar-add").addEventListener("click", (e) => { e.stopPropagation(); openAddModal(); });
        root.querySelector(".friends-scrim").addEventListener("click", closePop);
        listEl.addEventListener("click", onListClick);
        reqEl.addEventListener("click", onReqClick);
        document.addEventListener("click", (e) => {
            if (isOpen() && !root.contains(e.target) && !e.target.closest(".app-modal-scrim, .fr-scan, .sas-modal")) closePop();
        });
        document.addEventListener("keydown", (e) => {
            if (e.key === "Escape" && isOpen() && !document.getElementById("appModalScrim") && !scanner) closePop();
        });
        renderAll();
    }

    function isOpen() { return root?.classList.contains("is-open"); }

    function openPop(tab) {
        if (!root) return;
        if (isOpen()) { if (tab) setTab(tab); return; }
        setTab(tab || activeTab, true);
        /* Content and panel height are in place BEFORE the panel fades in. */
        renderList();
        renderRequests();
        panes.classList.add("is-instant");
        fitPanes();
        void panes.offsetHeight;
        panes.classList.remove("is-instant");
        root.classList.add("is-open");
        root.querySelector("#friendsPill").setAttribute("aria-expanded", "true");
        pop.setAttribute("aria-hidden", "false");
        pop.removeAttribute("inert");
    }

    function closePop() {
        if (!root || !isOpen()) return;
        root.classList.remove("is-open");
        root.querySelector("#friendsPill").setAttribute("aria-expanded", "false");
        pop.setAttribute("aria-hidden", "true");
        pop.setAttribute("inert", "");
    }

    function setTab(tab, silent) {
        const next = tab === "requests" ? "requests" : "friends";
        const prev = activeTab;
        activeTab = next;
        root.dataset.tab = next;
        root.querySelectorAll(".fbar-seg[data-tab]").forEach(b => b.setAttribute("aria-selected", String(b.dataset.tab === next)));
        if (!silent && prev !== next) fitPanes();
    }

    /* Panel height follows the active pane (both panes are stacked). */
    function fitPanes() {
        if (!panes) return;
        const pane = panes.querySelector(`.friends-pane[data-pane="${activeTab}"]`);
        const max = parseFloat(getComputedStyle(panes).maxHeight) || 9999;
        panes.style.height = Math.min(pane.scrollHeight, max) + "px";
    }

    function inThisRoom(v) {
        return !!v.room && typeof isJoined !== "undefined" && isJoined && currentRoomCode === v.room;
    }
    function statusText(v) {
        if (v.room) return inThisRoom(v) ? t("friends.status.here") : t("friends.status.room", { code: v.room });
        return t(v.online ? "friends.status.online" : "friends.status.offline");
    }

    function miniBlob(online, cls = "") {
        return `<span class="fr-blob${online ? " is-online" : ""}${cls ? " " + cls : ""}" aria-hidden="true"></span>`;
    }

    function renderBar() {
        if (!root) return;
        const online = F.list().filter(v => v.online).length;
        const req = F.requests().incoming.length;
        const label = t("friends.tab.friends");
        const count = online ? `· ${online}` : "";
        root.querySelector(".fbar-label--pill").textContent = label;
        root.querySelector(".fbar-label--friends").textContent = label;
        root.querySelector(".fbar-label--req").textContent = t("friends.tab.requests");
        root.querySelectorAll(".fbar-count").forEach(el => { el.textContent = count; });
        root.querySelector(".fbar-badge").textContent = req ? String(req) : "";
        root.classList.toggle("has-requests", req > 0);
        root.classList.toggle("has-online", online > 0);
        root.querySelector("#friendsPill").setAttribute("aria-label", t("friends.pill.aria", { online, requests: req }));
        root.querySelector(".fbar-add").setAttribute("aria-label", t("friends.add"));
    }

    function renderList() {
        const all = F.list();
        if (!all.length) {
            setHtml(listEl, `<li class="friends-empty"><span>${esc(t("friends.empty"))}</span><span class="friends-empty-hint">${esc(t("friends.empty.hint"))}</span></li>`);
            return;
        }
        const now = Date.now();
        setHtml(listEl, all.map(v => {
            const swapped = (lockSwapUntil.get(v.pub) || 0) > now;
            let action = "";
            if (v.room && !inThisRoom(v)) {
                action = v.closed
                    ? `<button type="button" class="fr-act is-locked" data-act="locked" aria-label="${esc(t("friends.closed"))}">${ICON.lock}</button>`
                    : `<button type="button" class="fr-act" data-act="join" aria-label="${esc(t("friends.join", { code: v.room }))}">${ICON.enter}</button>`;
            }
            return `<li class="fr-row${v.online ? " is-online" : ""}${swapped ? " is-swapped" : ""}" data-pub="${esc(v.pub)}">
                <button type="button" class="fr-main" data-act="profile">
                    ${miniBlob(v.online)}
                    <span class="fr-text">
                        <span class="fr-name${goldCls(v.nick)}">${esc(nk(v.name))}</span>
                        <span class="fr-status swap">
                            <span class="swap-main">${esc(statusText(v))}</span>
                            <span class="swap-alt">${esc(t("friends.closed"))}</span>
                        </span>
                    </span>
                </button>
                ${action}
            </li>`;
        }).join(""));
    }

    function renderRequests() {
        const { incoming, outgoing } = F.requests();
        const via = (v) => t(v === "link" ? "friends.via.link" : v === "code" ? "friends.via.code" : "friends.via.room");
        let html = "";
        if (incoming.length) {
            html += `<div class="fr-req-head">${esc(t("friends.req.incoming"))}</div><ul class="fr-req-list">` +
                incoming.map(r => `<li class="fr-req" data-id="${esc(r.id)}">
                    ${miniBlob(true)}
                    <span class="fr-text">
                        <span class="fr-name${goldCls(r.nick)}">${esc(r.nick ? nk(r.nick) : t("friends.someone"))}</span>
                        <span class="fr-status">${esc(via(r.via))}</span>
                    </span>
                    <button type="button" class="fr-act" data-act="accept" aria-label="${esc(t("friends.accept"))}">${ICON.check}</button>
                    <button type="button" class="fr-act is-warn" data-act="decline" aria-label="${esc(t("friends.decline"))}">${ICON.x}</button>
                </li>`).join("") + "</ul>";
        }
        if (outgoing.length) {
            html += `<div class="fr-req-head">${esc(t("friends.req.outgoing"))}</div><ul class="fr-req-list">` +
                outgoing.map(r => `<li class="fr-req is-out">
                    ${miniBlob(false)}
                    <span class="fr-text">
                        <span class="fr-name${goldCls(r.nick)}">${esc(r.nick ? nk(r.nick) : via(r.via))}</span>
                        <span class="fr-status">${esc(t("friends.req.waiting"))}</span>
                    </span>
                    <span class="fr-act is-static" aria-hidden="true">${ICON.mail}</span>
                </li>`).join("") + "</ul>";
        }
        if (!html) html = `<div class="friends-empty"><span>${esc(t("friends.req.empty"))}</span><span class="friends-empty-hint">${esc(t("friends.req.empty.hint"))}</span></div>`;
        setHtml(reqEl, html);
    }

    let renderQueued = false;
    function renderAll(now) {
        const run = () => {
            renderQueued = false;
            renderBar();
            if (root && isOpen()) {
                renderList();
                renderRequests();
                fitPanes();
            }
            refreshProfileSlot();
            refreshOpenProfile();
            if (typeof refreshParticipantLabels === "function") refreshParticipantLabels();
        };
        if (now === true) { run(); return; }
        if (renderQueued) return;
        renderQueued = true;
        requestAnimationFrame(run);
    }

    function onListClick(e) {
        const row = e.target.closest(".fr-row");
        const btn = e.target.closest("[data-act]");
        if (!row || !btn) return;
        const v = F.list().find(x => x.pub === row.dataset.pub);
        if (!v) return;
        const act = btn.dataset.act;
        if (act === "profile") openFriendProfile(v.pub);
        else if (act === "join") joinFriend(v);
        else if (act === "locked") {
            lockSwapUntil.set(v.pub, Date.now() + 1800);
            flashSwap(row, 1800);
            setTimeout(() => lockSwapUntil.delete(v.pub), 1850);
        }
    }

    function onReqClick(e) {
        const li = e.target.closest(".fr-req");
        const btn = e.target.closest("[data-act]");
        if (!li || !btn) return;
        if (btn.dataset.act === "accept") F.acceptRequest(li.dataset.id);
        if (btn.dataset.act === "decline") F.declineRequest(li.dataset.id);
    }

    function joinFriend(v) {
        if (!v.room || v.closed) return;
        closePop();
        if (typeof isJoined !== "undefined" && isJoined) {
            if (currentRoomCode === v.room) return;
            if (typeof leaveRoom === "function") leaveRoom();
        }
        if (typeof joinRoomByCode === "function") joinRoomByCode(v.room);
    }

    /* ---------- modals ---------- */
    function modalShell(title, html, cls, icon) {
        if (!window.VoidAppModal) return null;
        return window.VoidAppModal.open(esc(title), html, icon || ICON.friends, "fr-modal " + (cls || ""));
    }

    /* "+" — ways to add a friend. */
    async function openAddModal() {
        const me = await F.myTag();
        const opts = [
            { id: "qr", icon: ICON.qr, label: t("friends.add.qr"), hint: t(CAN_SCAN ? "friends.add.qr.hint" : "friends.add.qr.hint.desk"),
              face: "label", faceLabel: t("friends.add.qr.face"), faceMeta: t("friends.add.once"),
              pane: `<div class="fr-qr" aria-live="polite"></div>
                     <p class="sx-note is-center">${esc(t(CAN_SCAN ? "friends.add.qr.note" : "friends.add.qr.note.desk"))}</p>
                     ${CAN_SCAN ? `<button type="button" class="fr-btn fr-scan-btn" data-scan>${ICON.scan}<span>${esc(t("friends.scan.friend"))}</span></button>` : ""}` },
            { id: "code", icon: ICON.hash, label: t("friends.add.code"), hint: t("friends.add.code.hint"),
              face: "input", placeholder: t("friends.add.code.placeholder"), inputAttrs: 'maxlength="40" enterkeyhint="go"',
              sq: { icon: ICON.send, label: t("friends.add.open") },
              pane: `<div class="sx-err-wrap" aria-live="polite"><p class="sx-note sx-err"></p></div>
                     <div class="fr-mine">
                        <span class="fr-mine-label">${esc(t("friends.add.code.mine"))}</span>
                        <button type="button" class="fr-mytag" data-copy-tag aria-label="${esc(t("friends.code.copy", { tag: me.display }))}">${ICON.copy}${copyTagHtml(me.nick, me.code, true)}</button>
                     </div>` },
            { id: "link", icon: ICON.link, label: t("friends.add.link"), hint: t("friends.add.link.hint"),
              face: "text", sq: { icon: ICON.copy, label: t("friends.link.copy") },
              pane: `<p class="sx-note">${esc(t("friends.link.hint"))}</p>` },
        ];
        const card = modalShell(t("friends.add"), `<div class="fr-add">${sxHtml(opts, { tiles: true })}</div>`, "fr-modal--add", ICON.plus);
        if (!card) return;
        const group = card.querySelector(".sx");
        sxMount(group, opts);
        let link = "";

        const open = async (id) => {
            sxSetMode(group, id);
            const cell = group.querySelector(`[data-sx="${id}"]`);
            if (id === "qr") {
                link = await F.createLink();
                showQr(group.querySelector('.sx-pane[data-pane="qr"] .fr-qr'), link);
            } else if (id === "code") {
                setTimeout(() => cell.querySelector(".sx-input")?.focus({ preventScroll: true }), MED_MS);
            } else if (id === "link") {
                link = await F.createLink();
                scramble(cell.querySelector(".sx-value"), link.replace(/^https?:\/\//, ""), { step: 12, spin: 220 });
            }
        };
        /* The code opens a profile (nothing is sent yet): "add" lives there,
           so "already friends" and "request sent" need no extra states here. */
        /* The error unfolds (height + fade, one duration) instead of popping
           in and shoving the "your code" box down; it folds away on typing,
           the text stays until the fold is over. */
        const errWrap = group.querySelector('.sx-pane[data-pane="code"] .sx-err-wrap');
        const setErr = (msg) => {
            clearTimeout(errWrap._t);
            if (msg) {
                errWrap.firstElementChild.textContent = msg;
                errWrap.classList.add("is-shown");
            } else if (errWrap.classList.contains("is-shown")) {
                errWrap.classList.remove("is-shown");
                errWrap._t = setTimeout(() => { errWrap.firstElementChild.textContent = ""; }, MED_MS);
            }
        };
        const submitCode = async () => {
            const input = group.querySelector('[data-sx="code"] .sx-input');
            const raw = input.value.trim();
            if (!raw) { input.focus(); return; }
            const p = window.VoidFriendStore?.parseTag(raw);
            if (!p) { setErr(t("friends.toast.tag-invalid")); return; }
            if (p.tag === (await F.myTag()).tag) { setErr(t("friends.tag.own")); return; }
            const pub = await friendByTag(p.tag);
            if (pub) openFriendProfile(pub);
            else openTagProfile(p);
        };
        group.querySelector('[data-sx="code"] .sx-input').addEventListener("input", () => setErr(""));
        group.addEventListener("click", async (e) => {
            const openBtn = e.target.closest("[data-sx-open]");
            if (openBtn) { open(openBtn.dataset.sxOpen); return; }
            if (e.target.closest("[data-sx-cancel]")) { sxSetMode(group, ""); return; }
            if (e.target.closest("[data-scan]")) { openScanner(handleScanned); return; }
            if (e.target.closest("[data-sx-sq]")) {
                const mode = group.dataset.mode;
                if (mode === "code") submitCode();
                else if (mode === "link" && link && await copyText(link)) flashSwap(group.querySelector('[data-sx="link"] .sx-text'), 1400);
                return;
            }
            const copyBtn = e.target.closest("[data-sx-copy]");
            if (copyBtn && link && await copyText(link)) { flashSwap(copyBtn, 1400); return; }
            const tagBtn = e.target.closest("[data-copy-tag]");
            if (tagBtn && await copyText(me.display)) flashSwap(tagBtn, 1400);
        });
        group.querySelector('[data-sx="code"] .sx-input').addEventListener("keydown", (e) => {
            if (e.key === "Enter") { e.preventDefault(); submitCode(); }
        });
    }

    /* ---------- profiles ---------- */
    /* No own label → "nick#0198" / status. Own label → label / "nick#0198 · status".
       gold: the nick is a known one (friend / room), so premium shows; a tag
       typed by hand is not proof of anything and stays plain. Gold follows the
       person: with an own label it is the label that shines. */
    function identHtml({ nick, code, alias, status, gold = false }) {
        const tagGold = gold && !alias;
        const tag = code
            ? `<button type="button" class="fr-prof-tag" data-copy-tag="${esc(nk(nick))}#${esc(code)}">${copyTagHtml(nick, code, tagGold)}</button>`
            : `<span class="fr-prof-tag is-static"><span class="fr-tag-nick${tagGold ? goldCls(nick) : ""}">${esc(nk(nick))}</span></span>`;
        if (alias) {
            return `<span class="fr-prof-name fr-prof-alias${gold ? goldCls(nick) : ""}">${esc(nk(alias))}</span>
                <span class="fr-prof-sub">${tag.replace("fr-prof-tag", "fr-prof-tag is-sub")}<span class="fr-prof-dot">·</span><span class="fr-prof-status">${esc(status)}</span></span>`;
        }
        return `<span class="fr-prof-name">${tag}</span>
            <span class="fr-prof-sub"><span class="fr-prof-status">${esc(status)}</span></span>`;
    }

    /* Label set / changed / cleared: the same swap as the own nick in the
       settings profile (settings.css .profile-name.is-swapping) — the old
       block leaves up and fades, the new one settles in. */
    function swapIdent(id, html) {
        clearTimeout(id._swapT);
        if (reduced()) { id.innerHTML = html; return; }
        id.classList.add("is-swapping");
        id._swapT = setTimeout(() => {
            id.innerHTML = html;
            id.classList.remove("is-swapping");
        }, 140);
    }

    function bindCopyTags(card) {
        card.addEventListener("click", async (e) => {
            const b = e.target.closest("[data-copy-tag]");
            if (b && b.dataset.copyTag && await copyText(b.dataset.copyTag)) flashSwap(b, 1400);
        });
    }

    /* The open friend profile follows presence (status line) without a rebuild. */
    let openProfile = null;
    function refreshOpenProfile() {
        if (!openProfile || !openProfile.card.isConnected) { openProfile = null; return; }
        const v = F.list().find(x => x.pub === openProfile.pub);
        if (!v) return;
        openProfile.card.querySelectorAll(".fr-prof-status").forEach(el => { el.textContent = statusText(v); });
        openProfile.card.querySelector(".fr-prof .fr-blob")?.classList.toggle("is-online", !!v.online);
    }

    async function openFriendProfile(pub) {
        const v = F.list().find(x => x.pub === pub);
        if (!v) return;
        const [code, icons] = await Promise.all([F.friendCode(pub), F.pairIcons(pub)]);
        const card = modalShell(t("friends.profile"), `
            <div class="fr-prof">
                <div class="fr-prof-top">
                    ${miniBlob(v.online, "fr-blob--big")}
                    <div class="fr-prof-id">${identHtml({ nick: v.nick || v.name, code, alias: v.alias, status: statusText(v), gold: true })}</div>
                </div>
                ${icons ? `<button type="button" class="settings-cat fr-pair-row" data-pair>
                    <span class="settings-cat-label">${esc(t("friends.pair.title"))}</span>
                    <span class="fr-pair-icons">${icons.map(i => `<svg aria-hidden="true"><use href="#sas-${i}"/></svg>`).join("")}</span>
                    ${ICON.chevron}
                </button>` : ""}
                <label class="fr-field">
                    <span class="fr-field-label">${esc(t("friends.alias"))}</span>
                    <input type="text" class="fr-input" maxlength="32" spellcheck="false" value="${esc(v.alias)}" placeholder="${esc(nk(v.nick))}">
                </label>
                <button type="button" class="fr-btn is-warn fr-remove">
                    <span class="swap">
                        <span class="swap-main">${esc(t("friends.remove"))}</span>
                        <span class="swap-alt">${esc(t("friends.remove.confirm"))}</span>
                    </span>
                </button>
            </div>`, "", ICON.person);
        if (!card) return;
        openProfile = { card, pub };
        bindCopyTags(card);
        const input = card.querySelector(".fr-input");
        const id = card.querySelector(".fr-prof-id");
        id._alias = v.alias;
        const save = async () => {
            await F.renameFriend(pub, input.value);
            const cur = F.list().find(x => x.pub === pub);
            if (!cur) return;
            const html = identHtml({ nick: cur.nick || cur.name, code, alias: cur.alias, status: statusText(cur), gold: true });
            if (id._alias !== cur.alias) { id._alias = cur.alias; swapIdent(id, html); }
        };
        input.addEventListener("change", save);
        input.addEventListener("keydown", (e) => { if (e.key === "Enter") { input.blur(); } });
        const rm = card.querySelector(".fr-remove");
        rm.addEventListener("click", () => {
            if (!rm.classList.contains("is-swapped")) { flashSwap(rm, 3000); return; }
            F.removeFriend(pub);
            window.VoidAppModal.close();
        });
        card.querySelector("[data-pair]")?.addEventListener("click", () => openPairModal(icons, nk(v.alias || v.nick || v.name)));
    }

    function openPersonProfile(userId) {
        const friend = F.friendByUid(userId);
        if (friend) { openFriendProfile(friend.pub); return; }
        const nick = (typeof nicknameMap !== "undefined" && nicknameMap.get(userId)) || "";
        const draw = (card) => {
            const state = F.participantState(userId);
            const status = t(state === "sent" ? "friends.req.waiting" : state === "incoming" ? "friends.req.from" : "friends.not-friend");
            card.querySelector(".fr-prof-id").innerHTML = identHtml({ nick, status, gold: true });
            const btn = card.querySelector(".fr-add-btn");
            btn.disabled = state === "sent" || state === "friend";
            btn.classList.toggle("is-primary", state === "none" || state === "incoming");
            btn.querySelector(".fr-add-ic").innerHTML = state === "sent" ? ICON.mail : state === "incoming" ? ICON.check : ICON.plus;
            btn.querySelector(".fr-add-label").textContent = t(state === "sent" ? "friends.req.sent" : state === "incoming" ? "friends.accept" : "friends.add");
        };
        const card = modalShell(t("friends.profile"), `
            <div class="fr-prof">
                <div class="fr-prof-top">
                    ${miniBlob(true, "fr-blob--big")}
                    <div class="fr-prof-id"></div>
                </div>
                <button type="button" class="fr-btn fr-add-btn"><span class="fr-add-ic"></span><span class="fr-add-label"></span></button>
            </div>`, "", ICON.person);
        if (!card) return;
        draw(card);
        const btn = card.querySelector(".fr-add-btn");
        btn.addEventListener("click", async () => {
            await F.sendRoomRequest(userId);
            draw(card);
        });
        const off = F.onChange(() => { if (card.isConnected) draw(card); else off(); });
    }

    async function friendByTag(tag) {
        for (const v of F.list()) {
            const nick = window.VoidFriendStore?.cleanTagNick(v.nick || v.name || "");
            if (nick && `${nick}#${await F.friendCode(v.pub)}` === tag) return v.pub;
        }
        return null;
    }

    /* Someone known only by nick#0000 (typed in the add modal). Whether the
       code is real is only known on "add": the request itself is the probe. */
    function openTagProfile(p) {
        let state = "none"; // none | sending | sent | missing
        const card = modalShell(t("friends.profile"), `
            <div class="fr-prof">
                <div class="fr-prof-top">
                    ${miniBlob(false, "fr-blob--big")}
                    <div class="fr-prof-id"></div>
                </div>
                <button type="button" class="fr-btn fr-add-btn"><span class="fr-add-ic"></span><span class="fr-add-label"></span></button>
            </div>`, "", ICON.person);
        if (!card) return;
        bindCopyTags(card);
        const draw = () => {
            const status = state === "sent" ? t("friends.req.waiting") : state === "missing" ? t("friends.toast.tag-not-found") : t("friends.not-friend");
            card.querySelector(".fr-prof-id").innerHTML = identHtml({ nick: p.nick, code: p.code, status });
            card.querySelector(".fr-prof-status").classList.toggle("is-warn", state === "missing");
            const btn = card.querySelector(".fr-add-btn");
            btn.disabled = state === "sending" || state === "sent";
            btn.classList.toggle("is-primary", state === "none" || state === "missing");
            btn.querySelector(".fr-add-ic").innerHTML = state === "sent" ? ICON.mail : ICON.plus;
            btn.querySelector(".fr-add-label").textContent = t(state === "sent" ? "friends.req.sent" : "friends.add");
        };
        draw();
        card.querySelector(".fr-add-btn").addEventListener("click", async () => {
            state = "sending";
            draw();
            if (!(await F.useTag(p.tag)) && state === "sending") { state = "none"; draw(); }
        });
        const onEvent = async (e) => {
            if (!card.isConnected) { window.removeEventListener("void:friends-event", onEvent); return; }
            const k = e.detail?.kind;
            if (k === "tag-sent" && state === "sending") { state = "sent"; draw(); }
            else if (k === "tag-not-found" && state === "sending") { state = "missing"; draw(); }
            else if (k === "added") {
                const pub = await friendByTag(p.tag);
                if (pub && card.isConnected) openFriendProfile(pub);
            }
        };
        window.addEventListener("void:friends-event", onEvent);
    }

    /* Friendship code: the same dialog and reveal as the room security code. */
    let pairModal = null;
    function openPairModal(icons, name) {
        if (!icons) return;
        if (!pairModal) {
            pairModal = document.createElement("div");
            pairModal.className = "sas-modal fr-pair-modal";
            pairModal.setAttribute("role", "dialog");
            pairModal.setAttribute("aria-hidden", "true");
            pairModal.setAttribute("inert", "");
            pairModal.dataset.state = "ready";
            pairModal.innerHTML = `
                <div class="sas-backdrop" data-pair-close></div>
                <div class="sas-card">
                    <svg class="sas-scheme" viewBox="0 0 240 48" aria-hidden="true">
                        <line class="sas-link sas-link-l" x1="30" y1="24" x2="108" y2="24" />
                        <line class="sas-link sas-link-r" x1="132" y1="24" x2="210" y2="24" />
                        <circle class="sas-node sas-node-a" cx="18" cy="24" r="6" />
                        <circle class="sas-node sas-node-b" cx="222" cy="24" r="6" />
                        <circle class="sas-packet sas-packet-l" cx="30" cy="24" r="1.8" />
                        <circle class="sas-packet sas-packet-r" cx="132" cy="24" r="1.8" />
                        <g class="sas-lock">
                            <rect x="113" y="23" width="14" height="11" rx="1.4" />
                            <path d="M116 23v-3.4a4 4 0 0 1 8 0V23" />
                        </g>
                    </svg>
                    <h2 class="sas-title"></h2>
                    <div class="sas-big"></div>
                    <p class="sas-body"></p>
                    <p class="sas-hint"></p>
                    <button type="button" class="mic-blocked-cta sas-close" data-pair-close></button>
                </div>`;
            document.body.appendChild(pairModal);
            pairModal.addEventListener("click", (e) => { if (e.target.closest("[data-pair-close]")) closePairModal(); });
        }
        pairModal.querySelector(".sas-title").textContent = t("friends.pair.title");
        pairModal.querySelector(".sas-body").textContent = t("friends.pair.body");
        pairModal.querySelector(".sas-hint").textContent = t("friends.pair.hint", { nick: name });
        pairModal.querySelector(".sas-close").textContent = t("sas.close");
        pairModal.querySelector(".sas-big").innerHTML = icons.map((i, k) =>
            `<div class="sas-big-cell" style="--k:${k}"><svg class="sas-big-icon" aria-hidden="true"><use href="#sas-${i}"/></svg></div>`).join("");
        pairModal.classList.remove("is-open");
        void pairModal.offsetWidth;
        pairModal.classList.add("is-open");
        pairModal.removeAttribute("inert");
        pairModal.setAttribute("aria-hidden", "false");
        setTimeout(() => pairModal.querySelector(".sas-close")?.focus(), 60);
        document.addEventListener("keydown", pairEsc, true);
    }
    function pairEsc(e) {
        if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closePairModal(); }
    }
    function closePairModal() {
        if (!pairModal?.classList.contains("is-open")) return;
        pairModal.classList.remove("is-open");
        pairModal.setAttribute("inert", "");
        pairModal.setAttribute("aria-hidden", "true");
        document.removeEventListener("keydown", pairEsc, true);
    }

    /* ---------- settings profile ---------- */
    let profileSlot = null, profileTagEl = null, transferTimer = null, transferCode = null, transferExp = 0;

    function mountProfile(slot, tagEl) {
        profileSlot = slot;
        profileTagEl = tagEl;
        F.ready().then(() => refreshProfileSlot());
    }

    async function refreshProfileSlot() {
        if (profileTagEl?.isConnected) {
            const me = await F.myTag();
            const codeEl = profileTagEl.querySelector(".profile-code");
            if (codeEl && codeEl.textContent !== "#" + me.code) codeEl.textContent = "#" + me.code;
            profileTagEl.setAttribute("aria-label", t("friends.code.copy", { tag: me.display }));
            if (!profileTagEl._bound) {
                profileTagEl._bound = true;
                profileTagEl.addEventListener("click", async () => {
                    const cur = await F.myTag();
                    if (await copyText(cur.display)) flashSwap(profileTagEl, 1400);
                });
            }
        }
        if (!profileSlot || !profileSlot.isConnected) return;
        if (!profileSlot.firstElementChild) buildProfileSlot();
        const inv = profileSlot.querySelector("#frInvisible");
        if (inv) inv.checked = F.invisible;
    }

    function buildProfileSlot() {
        const opts = [
            { id: "show", icon: ICON.eye, label: t("friends.transfer.show"), face: "text", copyIcon: true,
              sq: { icon: ICON.qr, label: t("friends.transfer.qr") },
              pane: `<p class="sx-note fr-transfer-meta"></p><div class="fr-qr-wrap"><div class="fr-qr"></div></div>` },
            { id: "enter", icon: ICON.keys, label: t("friends.transfer.enter"), face: "input", mask: true,
              inputAttrs: 'maxlength="19" autocapitalize="characters" inputmode="text"',
              sq: CAN_SCAN ? { icon: ICON.scan, label: t("friends.scan") } : null,
              pane: `<p class="sx-note">${esc(t("friends.transfer.enter.note"))}</p>` },
        ];
        profileSlot.innerHTML = `
            <div class="iface-divider"></div>
            <div class="iface-row">
                <span class="iface-text">
                    <span class="iface-label">${esc(t("friends.invisible"))}</span>
                    <span class="iface-hint">${esc(t("friends.invisible.hint"))}</span>
                </span>
                <label class="vswitch">
                    <input type="checkbox" id="frInvisible"/>
                    <span class="vswitch-track"></span>
                </label>
            </div>
            <div class="iface-divider"></div>
            <div class="fr-transfer">
                <span class="iface-text">
                    <span class="iface-label">${esc(t("friends.transfer"))}</span>
                    <span class="iface-hint">${esc(t("friends.transfer.hint"))}</span>
                </span>
                ${sxHtml(opts)}
            </div>
            ${/iP(hone|ad|od)/.test(navigator.userAgent) && !IS_DESKTOP
                ? `<p class="fr-ios-hint">${esc(t("friends.ios.hint"))}</p>` : ""}`;
        profileSlot.querySelector("#frInvisible").addEventListener("change", (e) => F.setInvisible(e.target.checked));
        const group = profileSlot.querySelector(".sx");
        sxMount(group, opts);
        group.addEventListener("click", onTransferClick);
        const input = group.querySelector('[data-sx="enter"] .sx-input');
        const view = group.querySelector('[data-sx="enter"] .sx-mask-view');
        /* Typed characters replace the grey X one by one: S29H-XXXX-XXXX-XXXX. */
        const MASK = "XXXX-XXXX-XXXX-XXXX";
        const paintMask = () => {
            const raw = input.value.toUpperCase().replace(/[^0-9A-Z]/g, "").slice(0, 16);
            const val = fmtCode(raw);
            if (input.value !== val) {
                const atEnd = input.selectionStart === input.value.length;
                input.value = val;
                if (atEnd) input.setSelectionRange(val.length, val.length);
            }
            view.innerHTML = `<span class="sx-mask-typed">${esc(val)}</span><span class="sx-mask-rest">${MASK.slice(val.length)}</span>`;
            return raw;
        };
        paintMask();
        input.addEventListener("input", () => {
            paintMask();
            const c = window.VoidFriendStore?.normalizeTransferCode(input.value);
            if (c) F.joinTransfer(c);
        });
        input.addEventListener("keydown", (e) => { if (e.key === "Enter") F.joinTransfer(input.value); });
    }

    function fmtCode(c) { return c.replace(/(.{4})(?=.)/g, "$1-"); }

    function transferMeta() {
        const meta = profileSlot?.querySelector(".fr-transfer-meta");
        if (!meta) return;
        if (!transferCode) return;
        const left = Math.max(0, Math.ceil((transferExp - Date.now()) / 1000));
        meta.textContent = t("friends.transfer.wait", { time: `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}` });
        if (!left) resetTransfer(true);
    }

    function resetTransfer(cancel) {
        if (cancel && transferCode) F.cancelTransfer();
        clearInterval(transferTimer);
        transferCode = null;
        const group = profileSlot?.querySelector(".sx");
        if (group) {
            sxSetMode(group, "");
            group.querySelector(".fr-qr-wrap")?.classList.remove("is-open");
            const input = group.querySelector(".sx-input");
            if (input) { input.value = ""; input.dispatchEvent(new Event("input")); }
        }
    }

    async function onTransferClick(e) {
        const group = e.currentTarget;
        const openBtn = e.target.closest("[data-sx-open]");
        if (openBtn) {
            const id = openBtn.dataset.sxOpen;
            sxSetMode(group, id);
            if (id === "show") {
                group.querySelector(".fr-transfer-meta").textContent = "";
                const r = await F.startTransfer();
                transferCode = r.code;
                transferExp = r.exp;
                scramble(group.querySelector('[data-sx="show"] .sx-value'), fmtCode(r.code));
                clearInterval(transferTimer);
                transferTimer = setInterval(transferMeta, 1000);
                transferMeta();
            } else {
                setTimeout(() => group.querySelector('[data-sx="enter"] .sx-input')?.focus({ preventScroll: true }), MED_MS);
            }
            return;
        }
        if (e.target.closest("[data-sx-cancel]")) { resetTransfer(true); return; }
        const sq = e.target.closest("[data-sx-sq]");
        if (sq) {
            if (group.dataset.mode === "show" && transferCode) {
                const wrap = group.querySelector(".fr-qr-wrap");
                const on = !wrap.classList.contains("is-open");
                wrap.classList.toggle("is-open", on);
                sq.classList.toggle("is-on", on);
                if (on) {
                    /* The qr unfolds below the fold of the settings card; once
                       it has (the card grows first, so there is nothing to
                       scroll before that), the window glides to its very end. */
                    clearTimeout(wrap._scrollT);
                    wrap._scrollT = setTimeout(() => { if (wrap.classList.contains("is-open")) scrollToEnd(wrap); }, MED_MS);
                    await showQr(wrap.querySelector(".fr-qr"), `${appBase()}/#transfer=${transferCode}`);
                }
            } else if (group.dataset.mode === "enter") {
                openScanner(handleScanned);
            }
            return;
        }
        const copyBtn = e.target.closest("[data-sx-copy]");
        if (copyBtn && transferCode && await copyText(fmtCode(transferCode))) flashSwap(copyBtn, 1400);
    }

    function appBase() {
        return IS_DESKTOP || location.hostname === "tauri.localhost" ? "https://app.void-room.space" : location.origin;
    }

    /* ---------- events → toasts ---------- */
    window.addEventListener("void:friends-event", (e) => {
        const d = e.detail || {};
        const toast = (key, opts) => window.VoidToast?.showToast(t(key, { nick: d.nick ? nk(d.nick) : t("friends.someone") }), opts);
        switch (d.kind) {
            case "incoming":
                toast("friends.toast.incoming", { duration: 6000, onClick: () => openPop("requests") });
                window.VoidSounds?.message?.();
                break;
            case "added": toast("friends.toast.added"); break;
            case "declined": toast("friends.toast.declined", { priority: "warn" }); break;
            case "unreachable": toast("friends.toast.unreachable", { priority: "warn" }); break;
            case "limit": toast("friends.toast.limit", { priority: "warn" }); break;
            case "link-invalid":
            case "link-dead": toast("friends.toast.link-dead", { priority: "warn", duration: 5000 }); break;
            case "link-own":
            case "tag-own": toast("friends.toast.link-own"); break;
            case "link-sent":
            case "tag-sent": toast("friends.toast.link-sent", { duration: 5000 }); break;
            case "tag-invalid": toast("friends.toast.tag-invalid", { priority: "warn" }); break;
            case "tag-not-found": toast("friends.toast.tag-not-found", { priority: "warn", duration: 5000 }); break;
            case "offline": toast("friends.toast.offline", { priority: "warn" }); break;
            case "transfer-done":
                toast(d.role === "source" ? "friends.toast.transfer-source" : "friends.toast.transfer-target", { duration: 6000 });
                resetTransfer(false);
                break;
            case "transfer-not-found": toast("friends.toast.transfer-not-found", { priority: "warn" }); break;
            case "transfer-own": toast("friends.toast.transfer-own", { priority: "warn" }); break;
            case "transfer-failed": toast("friends.toast.transfer-failed", { priority: "warn" }); resetTransfer(false); break;
            case "transfer-expired": resetTransfer(false); break;
        }
        renderAll();
    });

    /* ---------- incoming links (#friend=…, #transfer=…) ---------- */
    function confirmFriendLink(secret) {
        if (!F.parseLinkSecret(secret)) return false;
        const showChoice = !IS_DESKTOP && !isTouch();
        const card = modalShell(t("friends.link.title"), `
            <div class="fr-confirm">
                <p class="fr-confirm-text">${esc(t("friends.link.question"))}</p>
                <div class="fr-confirm-actions">
                    <button type="button" class="fr-btn is-primary" data-ok>${esc(t("friends.link.accept"))}</button>
                    ${showChoice ? `<button type="button" class="fr-btn" data-app>${esc(t("friends.link.app"))}</button>` : ""}
                </div>
                ${showChoice ? `<p class="fr-confirm-hint">${esc(t("friends.link.app.hint"))}</p>` : ""}
            </div>`, "fr-modal--small");
        if (!card) return false;
        card.querySelector("[data-ok]").addEventListener("click", () => { window.VoidAppModal.close(); F.useLink(secret); });
        card.querySelector("[data-app]")?.addEventListener("click", () => {
            window.VoidAppModal.close();
            location.href = `void://friend/${secret}`;
        });
        return true;
    }

    function confirmTransferLink(code) {
        const card = modalShell(t("friends.transfer"), `
            <div class="fr-confirm">
                <p class="fr-confirm-text">${esc(t("friends.transfer.question"))}</p>
                <div class="fr-confirm-actions">
                    <button type="button" class="fr-btn is-primary" data-ok>${esc(t("friends.transfer.go"))}</button>
                </div>
            </div>`, "fr-modal--small", ICON.qr);
        if (!card) return;
        card.querySelector("[data-ok]").addEventListener("click", () => { window.VoidAppModal.close(); F.joinTransfer(code); });
    }

    function consumeHash() {
        const fr = location.hash.match(/^#friend=([A-Za-z0-9_-]{22})$/);
        const tr = location.hash.match(/^#transfer=([0-9A-Za-z]{16})$/);
        if (!fr && !tr) return;
        try { history.replaceState({}, "", location.pathname + location.search); } catch (_) {}
        F.ready().then(() => fr ? confirmFriendLink(fr[1]) : confirmTransferLink(tr[1]));
    }

    /* ---------- boot ---------- */
    function boot() {
        mount();
        consumeHash();
        window.addEventListener("hashchange", consumeHash);
        F.onChange(renderAll);
        /* Dispatched on document (settings.js) and it does not bubble. */
        document.addEventListener("void:locale-changed", () => {
            if (profileSlot) profileSlot.innerHTML = "";
            renderAll();
        });
        window.addEventListener("void:participants-changed", renderAll);
    }
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot, { once: true });
    else boot();

    window.VoidFriendsUI = {
        openPersonProfile,
        mountProfile,
        confirmFriendLink,
        openAdd: openAddModal,
        open: openPop,
        close: closePop,
    };
})();
