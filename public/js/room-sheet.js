/* ===== Room sheet (phones) =====
   On a phone the footer is one button: the status dot + «#CODE». A tap opens
   a bottom sheet instead of the two desktop popups. The sheet holds no copy
   of their content: the live #invitePanel and #pingPanel nodes are moved into
   it on open and put back on close, so copy / close-the-room / ping polling /
   the safety code keep working through their own handlers. Desktop never
   touches this — the popups stay where they are. */
/* Swipe down to dismiss a phone bottom sheet (the room sheet, app modals):
   `pop` follows the finger while `scroller` is at its top; a pull past a
   quarter of its height (or a quick flick) calls close(), anything less
   springs back with the sheet's own transition. The pop's CSS supplies the
   drag state: `.is-dragging { transform: translateY(var(--drag-y)); transition: none }`. */
function bindSheetSwipe(pop, scroller, isOpen, close) {
    let y0 = 0, t0 = 0, dy = 0, drag = false, track = false;

    pop.addEventListener("touchstart", (e) => {
        if (!isOpen() || e.touches.length !== 1) return;
        track = !scroller || scroller.scrollTop <= 0;
        drag = false; dy = 0;
        y0 = e.touches[0].clientY; t0 = e.timeStamp;
    }, { passive: true });

    pop.addEventListener("touchmove", (e) => {
        if (!track) return;
        dy = e.touches[0].clientY - y0;
        if (!drag) {
            if (dy < 6) { if (dy < -6) track = false; return; }
            drag = true;
            pop.classList.add("is-dragging");
        }
        e.preventDefault();
        pop.style.setProperty("--drag-y", Math.max(0, dy) + "px");
    }, { passive: false });

    const end = (e) => {
        if (!drag) { track = false; return; }
        drag = track = false;
        const fast = dy / Math.max(1, e.timeStamp - t0) > 0.5;
        /* Pin the finger's offset inline, drop the drag state, then let the
           sheet's transition carry it home (or out, if close() runs). */
        pop.style.transform = `translateY(${Math.max(0, dy)}px)`;
        pop.classList.remove("is-dragging");
        void pop.offsetHeight;
        pop.style.transform = "";
        pop.style.removeProperty("--drag-y");
        if (dy > pop.offsetHeight / 4 || (fast && dy > 24)) close();
    };
    pop.addEventListener("touchend", end);
    pop.addEventListener("touchcancel", end);
}

(function () {
    "use strict";

    const PHONE = matchMedia("(max-width: 640px)");
    let sheet, footer, homes = [], open = false, backTimer = 0, statusObs = null;

    function slot(name) { return sheet.querySelector(`[data-rs="${name}"]`); }

    function syncStatus() {
        const dot = sheet.querySelector(".room-sheet-status .conn-dot");
        dot.className = "conn-dot " + [...connDot.classList].filter(c => c !== "conn-dot").join(" ");
        sheet.querySelector(".room-sheet-status-label").textContent = connLabel.textContent;
    }

    /* Move a node into the sheet, remembering where it lived. */
    function borrow(node, into) {
        if (!node || into.contains(node)) return;
        homes.push([node, node.parentNode, node.nextSibling]);
        into.appendChild(node);
    }

    function giveBack() {
        for (const [node, parent, next] of homes.reverse()) parent.insertBefore(node, next);
        homes = [];
    }

    function openSheet() {
        if (open || !isJoined) return;
        clearTimeout(backTimer);
        giveBack();
        closePingPanel();
        closeInvitePanel();

        borrow(invitePanel, slot("invite"));
        borrow(pingPanelList, slot("ping"));
        borrow(document.getElementById("sasRow"), slot("sas"));

        /* The popups' own "open" state, minus their outside-click handlers:
           ping polls while the sheet is up, copy feedback resets on close. */
        pingPanelOpen = true;
        renderPingPanelSkeleton();
        schedulePingPoll();
        inviteOpen = true;
        if (typeof dismissInviteHint === "function") dismissInviteHint(true);

        syncStatus();
        statusObs = new MutationObserver(syncStatus);
        statusObs.observe(connLabel, { childList: true, characterData: true, subtree: true });
        statusObs.observe(connDot, { attributes: true, attributeFilter: ["class"] });

        open = true;
        sheet.removeAttribute("inert");
        sheet.setAttribute("aria-hidden", "false");
        void sheet.offsetHeight;
        sheet.classList.add("is-open");
    }

    function closeSheet() {
        if (!open) return;
        open = false;
        sheet.classList.remove("is-open");
        sheet.setAttribute("aria-hidden", "true");
        sheet.setAttribute("inert", "");
        statusObs?.disconnect();
        statusObs = null;

        /* closePingPanel stops the poll; closeInvitePanel clears "скопировано". */
        pingPanelOpen = true; closePingPanel();
        inviteOpen = true; closeInvitePanel();

        /* Nodes go home once the sheet has slid out, not mid-animation. */
        backTimer = setTimeout(giveBack, MOTION.med + 40);
    }

    function init() {
        sheet = document.getElementById("roomSheet");
        footer = document.querySelector(".footer-meta");
        if (!sheet || !footer) return;

        /* Capture on the footer: on a phone the tap never reaches the desktop
           popup toggles on #connState / #roomInfo. */
        footer.addEventListener("click", (e) => {
            if (!PHONE.matches || !isJoined) return;
            if (!e.target.closest("#connState, #roomInfo")) return;
            e.preventDefault();
            e.stopPropagation();
            openSheet();
        }, true);

        sheet.querySelectorAll("[data-rs-close]").forEach(el => el.addEventListener("click", closeSheet));
        bindSheetSwipe(sheet.querySelector(".room-sheet-pop"), sheet.querySelector(".room-sheet-body"),
            () => open, closeSheet);
        document.addEventListener("keydown", (e) => { if (e.key === "Escape" && open) closeSheet(); });

        /* Left the room (footer button hidden) or rotated to a wide screen. */
        const info = document.getElementById("roomInfo");
        new MutationObserver(() => { if (info.classList.contains("hidden")) closeSheet(); })
            .observe(info, { attributes: true, attributeFilter: ["class"] });
        PHONE.addEventListener("change", () => { if (!PHONE.matches) closeSheet(); });
    }

    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
    else init();
})();
