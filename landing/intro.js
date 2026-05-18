/*
void — intro: supernova spin-up.

   A soft glowing orb sits dead-center. Its spinner ring starts rotating
   already in motion (no dead idle), accelerates smoothly via a physics rotor
   (I·dω/dt = T - μω), throws off swirling particles whose emission rate
   tracks the spin velocity, peaks at a BURST that radial-explodes the
   accumulated energy across the screen, then the bright core flies up to
   become the header logo dot.

   Centering is rock-solid at any browser zoom or Windows DPI scale because:
     1) the orb is pinned via top:50%/left:50% + translate(-50%, -50%) — the
        most reliable cross-zoom centering primitive in CSS;
     2) the canvas is `position:fixed; inset:0` covering the viewport at
        (0,0), and its buffer is sized via window.innerWidth/Height (layout-
        independent — getBoundingClientRect can return 0 if called before
        layout settles, which is what was making particles only render in a
        tiny top-left rect — the default 300x150 canvas buffer).

   skippable: click anywhere or any key.
   ============================================================================ */

(function () {
    const intro      = document.getElementById('intro');
    const introLogo  = document.getElementById('introLogo');
    const orbSpinner = introLogo && introLogo.querySelector('.orb-spinner');
    const canvas     = document.getElementById('introCanvas');
    const headerSlot = document.getElementById('brandLogoSlot');
    const page       = document.getElementById('page');

    const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    const SKIP_KEY = 'void.intro.played.v2';
    const replay   = new URLSearchParams(location.search).has('replay');
    const skipIntro = (!replay) && (prefersReducedMotion || sessionStorage.getItem(SKIP_KEY));

    if (skipIntro) {
        intro.style.display = 'none';
        if (headerSlot) headerSlot.classList.add('is-ready');
        page.classList.add('is-visible');
        return;
    }

    /* ---- canvas sizing -----------------------------------------------------
       The canvas is CSS `position: fixed; inset: 0;` which fills the LAYOUT
       VIEWPORT — i.e., everything EXCLUDING the vertical scrollbar area.
       The buffer must match the same area, so we size from
       `document.documentElement.clientWidth/clientHeight` which also excludes
       the scrollbar.

       Why NOT `window.innerWidth`? It returns the visual viewport width
       *including* the scrollbar area. Mismatching buffer (innerWidth*dpr)
       with CSS area (clientWidth) makes the browser stretch the buffer to
       fit the smaller CSS rect — every drawing coord ends up subpixel-shifted
       toward the scrollbar side. At Windows 125% scaling + a ~17px scrollbar,
       this produced a visible ~8 CSS-px drift of particles, scaled to ~10
       physical pixels — the "съезжает вправо вниз" the user observed.

       getBoundingClientRect on the logo also returns layout-viewport coords,
       so once buffer == CSS rect, no per-frame translation is needed: the
       drawing coord equals the on-screen CSS pixel.

       safeResize() avoids re-running canvas.width=N every frame (which clears
       the buffer + resets transforms) when nothing actually changed.
       ---------------------------------------------------------------------- */
    const ctx = canvas.getContext('2d');
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    let W = 0, H = 0;

    function measureViewport() {
        // clientWidth/Height of <html> = layout viewport = what `inset: 0`
        // actually covers. Fallback to innerWidth/Height for the (rare) case
        // where clientWidth returns 0 (very early script execution).
        return {
            w: document.documentElement.clientWidth  || window.innerWidth  || 0,
            h: document.documentElement.clientHeight || window.innerHeight || 0,
        };
    }
    function size() {
        const v = measureViewport();
        W = v.w; H = v.h;
        canvas.width  = Math.max(1, Math.round(W * dpr));
        canvas.height = Math.max(1, Math.round(H * dpr));
        // EXPLICITLY pin the canvas CSS render size to (W, H) CSS pixels.
        // Without this, canvas is a replaced element whose intrinsic size = its
        // buffer (W*dpr px). Per CSS 2.1 §10.4 (over-constrained absolutely-
        // positioned replaced elements), `inset: 0` LOSES to the intrinsic size
        // — the canvas ends up rendering at `W*dpr` CSS pixels wide (not at the
        // viewport's `W` CSS pixels). The mismatch is proportional to (dpr - 1),
        // which is why particles drifted right/down at dpr=1.25, were perfect
        // at dpr=1.0 (intrinsic == viewport), and drifted left/up at dpr=0.875.
        canvas.style.width  = W + 'px';
        canvas.style.height = H + 'px';
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    function safeResize() {
        const v = measureViewport();
        if (v.w !== W || v.h !== H) size();
    }
    size();
    window.addEventListener('resize', safeResize);
    // re-measure after layout settles in case the first call landed too early.
    window.addEventListener('load', safeResize);

    /* logoCenter — viewport coords. Since the canvas covers the layout
       viewport at (0,0) and its buffer is sized to match, viewport coords
       ARE canvas drawing coords. */
    function logoCenter() {
        const lr = introLogo.getBoundingClientRect();
        return {
            cx: lr.left + lr.width / 2,
            cy: lr.top  + lr.height / 2,
            radius: lr.width / 2,
        };
    }

    /* ---- particle field --------------------------------------------- */
    const particles = [];

    /**
     * Emit n particles in a tangential spray. They start on a small ring at
     * the orb's edge, with velocity composed of a radial component (outward)
     * and a tangential component (in the spin direction, so they spiral
     * outward rather than just exploding radially — much more "alive").
     *
     * @param n         count
     * @param opts.speed       base radial speed
     * @param opts.tang        tangential scatter (random both directions)
     * @param opts.tangSpin    tangential bias in the spin direction (omega-driven)
     * @param opts.ringFrac    spawn ring radius as fraction of logo radius
     * @param opts.warm        probability (0..1) a particle is warm-toned
     * @param opts.ttlScale    lifespan multiplier
     */
    function spawn(n, opts) {
        opts = opts || {};
        const c        = logoCenter();
        const r0       = c.radius * (opts.ringFrac ?? 0.55);
        const tangSpin = opts.tangSpin ?? 0;
        const warmP    = opts.warm    ?? 0.06;
        const ttlMul   = opts.ttlScale ?? 1;

        for (let i = 0; i < n; i++) {
            const a     = Math.random() * Math.PI * 2;
            const speed = (opts.speed || 1.5) * (0.6 + Math.random() * 1.4);
            const tang  = (opts.tang || 0) * (Math.random() - 0.5) + tangSpin;
            // velocity: radial outward (cos a, sin a) plus tangential (-sin a, cos a)
            const vx = Math.cos(a) * speed - Math.sin(a) * tang;
            const vy = Math.sin(a) * speed + Math.cos(a) * tang;
            const px = c.cx + Math.cos(a) * r0;
            const py = c.cy + Math.sin(a) * r0;
            particles.push({
                x: px, y: py,
                vx, vy,
                life: 0,
                ttl: (1.4 + Math.random() * 2.4) * ttlMul,
                size: 0.6 + Math.random() * 1.6,
                hue: Math.random() < warmP ? 'warm' : 'white',
            });
        }
    }

    /* ---- physics rotor — I·dω/dt = T(t) − μω -----------------------------
       Smooth asymptotic spin-up; we just shape the torque profile over
       time and the angular velocity evolves naturally. Sub-class controls
       glow + emission rate by reading omega.                              */
    let orbitAngle  = 0;
    let orbitOmega  = 2.2;                  // already spinning on first frame
    const INERTIA   = 1.0;
    const FRICTION  = 1.4;

    let torqueOverride = null;

    function torqueAt(tSec) {
        if (torqueOverride !== null) return torqueOverride;
        if (tSec < 0.05) return 10;                     // motor on immediately
        if (tSec < 2.6) {
            // cubic ease-in ramp 10 → 65 over 2.55s
            const u = (tSec - 0.05) / (2.6 - 0.05);
            return 10 + (u * u * u) * 55;
        }
        return 65;                                      // hold at peak — keep spinning through burst + liftoff
    }

    /* ---- shockwave rings on canvas (used for BURST + send-off) --------- */
    const waves = [];
    function spawnWave(opts) {
        waves.push({
            bornAt:    performance.now(),
            duration:  opts.duration,
            peakAlpha: opts.peakAlpha,
            lineWidth: opts.lineWidth,
            reachFrac: opts.reachFrac,
            glow:      opts.glow || 0,
        });
    }
    function drawWaves(now) {
        if (waves.length === 0) return;
        const c    = logoCenter();
        const maxR = Math.hypot(W, H) / 2;
        for (let i = waves.length - 1; i >= 0; i--) {
            const w = waves[i];
            // Clamp age to [0, ∞). w.bornAt is set with performance.now() INSIDE
            // a stage fn called from physicsStep called from loop(t) — `t` is
            // the rAF frame-start timestamp and `performance.now()` is called
            // milliseconds later in the same frame, so for a wave born on the
            // current frame, (t - bornAt) is a small NEGATIVE number. Without
            // this clamp, `eased = 1 - (1 - negativeAge)^3` goes negative,
            // `r = eased * maxR * reachFrac` is negative, and ctx.arc throws
            // IndexSizeError — which broke the rAF chain and froze the intro.
            const age = Math.max(0, (now - w.bornAt) / w.duration);
            if (age >= 1) { waves.splice(i, 1); continue; }
            const eased = 1 - Math.pow(1 - age, 3);
            const r     = Math.max(0, eased * maxR * w.reachFrac);
            const alpha = w.peakAlpha * Math.pow(1 - age, 1.25);
            ctx.beginPath();
            ctx.strokeStyle = `rgba(245, 245, 247, ${alpha})`;
            ctx.lineWidth   = Math.max(0.5, w.lineWidth * (1 - age * 0.45));
            if (w.glow > 0) {
                ctx.shadowColor = `rgba(255, 255, 255, ${alpha * 0.7})`;
                ctx.shadowBlur  = w.glow;
            }
            ctx.arc(c.cx, c.cy, r, 0, Math.PI * 2);
            ctx.stroke();
            ctx.shadowBlur = 0;
        }
    }

    /* ---- main rAF loop: physics + emission + render -------------------------
       Physics runs at a FIXED timestep (120 Hz), with the renderer running at
       whatever rAF rate the browser provides. This makes the intro completely
       frame-rate-independent:

         * dropped frames → loop catches up on the next render by sub-stepping
           physics until physics-time matches wall-time;
         * stage events (warming → charging → BURST → liftoff) are triggered
           by physics-time, not wall-clock setTimeout — so if the browser is
           slow, stages wait for omega to actually reach its expected value
           before firing. Previously, slow frames caused BURST to fire while
           omega was still ramping → "intro ends at low speed".

       Catch-up is capped at 0.25s/frame to prevent runaway after a long
       tab-away. Particle emission also runs per physics step (not per render
       frame), so the count is consistent regardless of frame rate.
       ---------------------------------------------------------------------- */
    let cleanedUp = false;
    let lastT     = performance.now();
    let running   = true;
    let emitAccum = 0;
    let physTime  = 0;                          // total physics-time elapsed
    let physAccum = 0;
    let stageIdx  = 0;
    const PHYS_DT       = 1 / 120;              // fixed physics tick
    const MAX_CATCHUP_S = 0.25;                 // cap per-frame catch-up

    // Stages fire when physTime crosses `at` (seconds since intro start).
    // Defined here so they can reference spawnWave/spawn/liftOff defined above.
    const STAGES = [
        { at: 0.00, fn: () => introLogo.classList.add('is-awake') },
        { at: 0.60, fn: () => introLogo.classList.add('is-warming') },
        { at: 1.80, fn: () => {
            introLogo.classList.remove('is-warming');
            introLogo.classList.add('is-charging');
        }},
        { at: 2.80, fn: () => {
            introLogo.classList.remove('is-charging');
            introLogo.classList.add('is-bursting');
            // primary shockwave + primary spray
            spawnWave({ duration: 1500, peakAlpha: 0.85, lineWidth: 2.8, reachFrac: 1.10, glow: 18 });
            spawn(320, { speed: 5.0, tang: 2.2, ringFrac: 1.00, ttlScale: 1.3, warm: 0.12 });
        }},
        { at: 3.00, fn: () => {
            // trailing shockwave echo + secondary spray
            spawnWave({ duration: 1200, peakAlpha: 0.38, lineWidth: 1.4, reachFrac: 0.85, glow: 6 });
            spawn(160, { speed: 2.8, tang: 1.4, ringFrac: 1.10, ttlScale: 1.5 });
        }},
        { at: 3.14, fn: () => spawn(90, { speed: 1.6, tang: 0.9, ringFrac: 1.18, ttlScale: 1.9 }) },
        { at: 3.40, fn: () => liftOff() },
    ];

    function physicsStep(dt) {
        // semi-implicit Euler — stable for stiff viscous damping
        const T     = torqueAt(physTime);
        const accel = (T - FRICTION * orbitOmega) / INERTIA;
        orbitOmega += accel * dt;
        if (orbitOmega < 0) orbitOmega = 0;
        orbitAngle += orbitOmega * dt;

        // emission (per physics tick — consistent regardless of frame rate)
        if (!cleanedUp) {
            const emitRate = Math.min(320, 12 + orbitOmega * 8);
            emitAccum += emitRate * dt;
            const emitCount = Math.floor(emitAccum);
            emitAccum -= emitCount;
            if (emitCount > 0) {
                const tangSpin = Math.min(3.0, orbitOmega * 0.09);
                spawn(emitCount, {
                    speed:    1.6 + Math.min(3.2, orbitOmega * 0.07),
                    tang:     0.9 + Math.min(2.0, orbitOmega * 0.05),
                    tangSpin: tangSpin,
                    ringFrac: 1.05,
                });
            }
        }

        physTime += dt;

        // Fire any stages whose physics-time has come. Errors are LOGGED, not
        // silently swallowed — but the stage index still advances so a single
        // broken stage can't deadlock the intro on itself forever.
        while (stageIdx < STAGES.length && physTime >= STAGES[stageIdx].at) {
            try {
                STAGES[stageIdx].fn();
            } catch (e) {
                console.error('[intro stage ' + stageIdx + ' at ' + STAGES[stageIdx].at + 's]', e);
            }
            stageIdx++;
        }
    }

    function loop(t) {
        if (!running) return;
        const realDt = (t - lastT) / 1000;
        lastT = t;

        safeResize();

        // accumulate up to MAX_CATCHUP_S of wall time; the rest is dropped to
        // prevent runaway if the tab was backgrounded for ages.
        physAccum += Math.min(MAX_CATCHUP_S, realDt);
        let safety = 200;  // upper bound on sub-steps per frame
        while (physAccum >= PHYS_DT && safety-- > 0) {
            physicsStep(PHYS_DT);
            physAccum -= PHYS_DT;
        }

        if (orbSpinner) orbSpinner.style.transform = `rotate(${orbitAngle}rad)`;

        ctx.clearRect(0, 0, W, H);
        drawWaves(t);

        // particle integration runs at the render rate (dt-scaled velocities
        // so motion is frame-rate-independent too).
        const partDt = Math.min(0.05, realDt);
        for (let i = particles.length - 1; i >= 0; i--) {
            const p = particles[i];
            p.life += partDt;
            if (p.life > p.ttl) { particles.splice(i, 1); continue; }
            p.vx *= (1 - 0.55 * partDt);
            p.vy *= (1 - 0.55 * partDt);
            p.x  += p.vx;
            p.y  += p.vy;
            const f = 1 - (p.life / p.ttl);
            const a = Math.max(0, f);

            ctx.beginPath();
            ctx.fillStyle = p.hue === 'warm'
                ? `rgba(220, 200, 180, ${0.55 * a})`
                : `rgba(245, 245, 247, ${0.78 * a})`;
            ctx.shadowColor = 'rgba(255,255,255,0.8)';
            ctx.shadowBlur  = 6 * a;
            ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
            ctx.fill();
        }
        ctx.shadowBlur = 0;

        requestAnimationFrame(loop);
    }
    requestAnimationFrame((t) => { lastT = t; loop(t); });

    /* ---- the lift-off -------------------------------------------------- */
    function liftOff() {
        if (cleanedUp) return;
        cleanedUp = true;

        // The page-reveal chain is what the user ACTUALLY needs to see; do it
        // first so even if the fancy transform math below fails, the page
        // doesn't get stuck on the intro overlay.
        const safeSetTimeout = (fn, ms) => setTimeout(() => { try { fn(); } catch (e) { console.error('[intro liftOff]', e); } }, ms);
        safeSetTimeout(() => page.classList.add('is-visible'),                900);
        safeSetTimeout(() => { if (headerSlot) headerSlot.classList.add('is-ready'); }, 1200);
        safeSetTimeout(() => intro.classList.add('fade-out'),                1300);
        safeSetTimeout(() => {
            running = false;
            intro.remove();
            try { sessionStorage.setItem(SKIP_KEY, '1'); } catch (_) {}
        }, 2600);

        // Now attempt the flying-to-header animation. If anything throws here,
        // it's swallowed and the page still reveals (chain above is independent).
        try {
            const sourceRect = introLogo.getBoundingClientRect();
            const targetRect = headerSlot ? headerSlot.getBoundingClientRect() : null;

            introLogo.classList.remove('is-bursting');
            introLogo.classList.add('is-flying');
            spawnWave({ duration: 1400, peakAlpha: 0.28, lineWidth: 1.2, reachFrac: 0.75, glow: 5 });

            if (!targetRect || targetRect.width === 0 || sourceRect.width === 0) {
                // no measurable target — just fade the orb out in place
                introLogo.style.transform = `translate(-100px, -100px) scale(0.25)`;
                introLogo.style.opacity   = '0';
                return;
            }

            // Pixel-based math so the transition is a simple between-pixel-translates
            // interpolation (no calc() / mixed-unit edge cases).
            // Element is centered via top:50%/left:50% + translate(-100px,-100px).
            // To move its center to viewport pixel (tx, ty), we need:
            //   translate( tx - vw/2 - w/2 ,  ty - vh/2 - h/2 ).
            const vw = document.documentElement.clientWidth  || window.innerWidth;
            const vh = document.documentElement.clientHeight || window.innerHeight;
            const tx = targetRect.left + targetRect.width  / 2;
            const ty = targetRect.top  + targetRect.height / 2;
            const offsetX = tx - vw / 2 - sourceRect.width  / 2;
            const offsetY = ty - vh / 2 - sourceRect.height / 2;
            const scale   = targetRect.width / sourceRect.width;

            requestAnimationFrame(() => {
                introLogo.style.transform =
                    `translate(${offsetX}px, ${offsetY}px) scale(${scale})`;
            });
        } catch (e) {
            console.error('[intro liftOff transform]', e);
            // page reveal still happens via safeSetTimeout chain above
        }
    }

    // Absolute safety net: if for ANY reason cleanedUp hasn't fired by 7s
    // wall-clock after IIFE start (frame drops, JS errors, tab backgrounded
    // during liftOff, etc.), force the page-reveal sequence so the user never
    // gets stuck staring at the intro.
    setTimeout(function safetyNet() {
        if (!cleanedUp) {
            console.warn('[intro] safety net triggered after 7s — forcing skipAll');
            skipAll();
        }
    }, 7000);

    function skipAll() {
        if (cleanedUp) return;
        cleanedUp = true;
        running = false;
        if (headerSlot) headerSlot.classList.add('is-ready');
        page.classList.add('is-visible');
        intro.classList.add('fade-out');
        setTimeout(() => intro.remove(), 900);
        sessionStorage.setItem(SKIP_KEY, '1');
    }

    intro.addEventListener('click', skipAll);
    window.addEventListener('keydown', () => { if (!cleanedUp) skipAll(); }, { once: true });

    /* The sequence (supernova spin-up):
         physTime=0.00 — orb wakes, already spinning
         physTime=0.60 — warming: halo + glow bloom
         physTime=1.80 — charging: full glow + core swells, spin near peak
         physTime=2.80 — BURST: shockwave + primary spray
         physTime=3.00 — trailing echo + secondary spray
         physTime=3.14 — tertiary debris spray
         physTime=3.40 — lift-off

       All triggered by the physics-time-driven STAGES table inside loop(),
       so frame drops or background-tab pauses don't desync omega from the
       burst trigger. See STAGES near the rAF loop above. */
})();
