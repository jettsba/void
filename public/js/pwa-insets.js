/* Height of the iOS home-screen app (navigator.standalone).

   iOS paints a home-screen app only as far down as the document reaches, up
   to the screen: with html/body at 100% the page came out 812 tall on a 874
   screen (the screen less the 62pt status bar), and the rest was a black
   system strip the DOM could not reach (WebKit bug 301994 describes the
   symptom). A document at least as tall as the screen, in PIXELS, gets the
   whole screen painted — 100%/dvh follow the short viewport and keep it short.
   Same fix as Lightweight (src/lib/viewport.ts).

   - --screen-h: the screen height, the body's min-height (base.css);
   - --app-h: what is actually painted (innerHeight), the .app height. Not
     re-read while a field has focus: the keyboard moves it then and the
     layout must hold.
   Browsers keep the CSS fallbacks (100%, 100dvh), which they get right.
   Android is left out: its screen.height includes the system bars. */
(function () {
    if (!navigator.standalone) return;
    const root = document.documentElement.style;
    const portrait = matchMedia("(orientation: portrait)");
    const screenH = () => portrait.matches
        ? Math.max(screen.width, screen.height)
        : Math.min(screen.width, screen.height);
    const typing = () => {
        const el = document.activeElement;
        return el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement;
    };

    function set() {
        root.setProperty("--screen-h", screenH() + "px");
        if (typing()) return;
        root.setProperty("--app-h", window.innerHeight + "px");
    }
    const later = (ms) => () => setTimeout(set, ms);

    set();
    /* innerHeight grows to the screen only once the taller body is laid out. */
    window.addEventListener("load", later(0), { once: true });
    window.addEventListener("resize", later(50));
    window.visualViewport?.addEventListener("resize", later(50));
    /* After the keyboard goes, iOS settles its sizes a beat after the blur. */
    document.addEventListener("focusout", () => { setTimeout(set, 80); setTimeout(set, 400); });
    portrait.addEventListener("change", later(100));
})();
