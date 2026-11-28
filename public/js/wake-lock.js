/* Keep the phone screen on while in a room.
 *
 * Mobile browsers cut the mic once the screen sleeps (Android Chrome mutes
 * capture shortly after screen-off, iOS suspends the page on lock), so on a
 * touch device we hold a Screen Wake Lock for the whole call — the same thing
 * web callers like Meet do. Android Chrome 84+, iOS Safari 16.4+, and iOS
 * home-screen PWAs since 18.4; elsewhere this is a silent no-op.
 *
 * The OS drops the lock whenever the page is hidden, so it is re-requested on
 * every return to the foreground while the call is still on. Desktop is
 * skipped: a laptop in a call has no reason to never dim.
 */
(function () {
    const TOUCH = matchMedia("(hover: none) and (pointer: coarse)");
    let wanted = false;
    let sentinel = null;
    let pending = null;

    function supported() {
        return TOUCH.matches && !window.VoidDesktop && !!navigator.wakeLock?.request;
    }

    async function acquire() {
        if (!wanted || sentinel || pending || document.visibilityState !== "visible") return;
        pending = navigator.wakeLock.request("screen")
            .then(lock => {
                if (!wanted) { lock.release().catch(() => {}); return; }
                sentinel = lock;
                lock.addEventListener("release", () => { if (sentinel === lock) sentinel = null; });
            })
            .catch(err => log.debug("ui", "wake lock refused", { err: err?.name || String(err) }))
            .finally(() => { pending = null; });
    }

    function start() {
        if (!supported()) return;
        wanted = true;
        acquire();
    }

    function stop() {
        wanted = false;
        const lock = sentinel;
        sentinel = null;
        lock?.release().catch(() => {});
    }

    document.addEventListener("visibilitychange", acquire);
    window.addEventListener("pageshow", acquire);
    /* Safari may want a user activation for the request; any tap retries
       (no-op while the lock is already held). */
    window.addEventListener("pointerdown", acquire, true);

    window.VoidWakeLock = { start, stop };
})();
