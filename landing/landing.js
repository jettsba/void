/* ============================================================================
void — landing behaviors
   ============================================================================ */

/* ----------------------------------------------------------------------------
   Smooth inertial scroll via Lenis (loaded from CDN in <head>).
   Lenis is the industry-standard smooth-scroll lib used by Apple, Cuberto,
   Studio Freight et al. — handles wheel/touch/keyboard with proper momentum
   and frame-rate-independent easing. We just configure and start its rAF loop.

   Skipped on prefers-reduced-motion. Touch uses native momentum (syncTouch
   off — Lenis-smoothed touch can feel laggy vs. iOS rubber-band).
   ---------------------------------------------------------------------------- */
(function initLenis() {
    function start() {
        if (typeof Lenis === 'undefined') return;
        if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

        const lenis = new Lenis({
            // lerp mode: position chases target each frame at a fixed fraction
            // of the remaining distance. Lower = floatier + longer coast.
            // 0.07 gives a clearly visible "doезжает at stop" coast without
            // dragging on; combined with a wheelMultiplier > 1, each notch
            // covers more ground so the page still feels responsive.
            lerp: 0.07,
            smoothWheel: true,
            syncTouch: false,           // touch keeps native iOS momentum
            wheelMultiplier: 1.35,      // each wheel notch covers more ground
            touchMultiplier: 1.5,
        });

        function raf(time) {
            lenis.raf(time);
            requestAnimationFrame(raf);
        }
        requestAnimationFrame(raf);

        // anchor links — route through Lenis so internal nav coasts smoothly too
        document.addEventListener('click', (e) => {
            const a = e.target.closest('a[href^="#"]');
            if (!a) return;
            const id = a.getAttribute('href').slice(1);
            if (!id) return;
            const el = document.getElementById(id);
            if (!el) return;
            e.preventDefault();
            lenis.scrollTo(el, {
                offset: 0,
                duration: 1.8,
                easing: (t) => 1 - Math.pow(1 - t, 4),  // quartic ease-out: silky landing
            });
            try { history.pushState(null, '', '#' + id); } catch (_) {}
        });

        window.__lenis = lenis;        // expose for debugging
    }

    // Lenis is loaded with `defer`, so it's ready by DOMContentLoaded.
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', start);
    } else if (typeof Lenis !== 'undefined') {
        start();
    } else {
        window.addEventListener('load', start);
    }
})();

(function () {
    /* -------------------------------------------------- ambient background */
    const bg = document.getElementById('bgCanvas');
    if (bg) {
        const ctx = bg.getContext('2d');
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        let W = 0, H = 0;
        function fit() {
            // clientWidth/Height of <html> matches what `inset: 0` covers
            // (excludes scrollbar) — keeps buffer == CSS rect, no stretching
            // (same fix as the intro canvas; see comments there).
            W = document.documentElement.clientWidth  || window.innerWidth  || 0;
            H = document.documentElement.clientHeight || window.innerHeight || 0;
            bg.width  = Math.max(1, Math.round(W * dpr));
            bg.height = Math.max(1, Math.round(H * dpr));
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        }
        fit();
        window.addEventListener('resize', fit);

        const N = Math.min(70, Math.max(28, Math.floor((W * H) / 28000)));
        const stars = [];
        for (let i = 0; i < N; i++) {
            stars.push({
                x: Math.random() * W,
                y: Math.random() * H,
                z: 0.3 + Math.random() * 0.7,
                r: 0.4 + Math.random() * 1.2,
                tw: Math.random() * Math.PI * 2,
            });
        }

        const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

        let t0 = performance.now();
        function tick(t) {
            const dt = Math.min(0.05, (t - t0) / 1000);
            t0 = t;
            ctx.clearRect(0, 0, W, H);
            for (const s of stars) {
                if (!prefersReducedMotion) {
                    s.y += dt * 6 * s.z;
                    s.tw += dt * 0.6 * s.z;
                    if (s.y > H + 4) { s.y = -4; s.x = Math.random() * W; }
                }
                const tw = (Math.sin(s.tw) + 1) / 2;
                const a = (0.18 + 0.35 * tw) * s.z;
                ctx.beginPath();
                ctx.fillStyle = `rgba(230, 230, 232, ${a})`;
                ctx.shadowColor = `rgba(255,255,255,${a * 0.6})`;
                ctx.shadowBlur = 3 * s.z;
                ctx.arc(s.x, s.y, s.r * s.z, 0, Math.PI * 2);
                ctx.fill();
            }
            ctx.shadowBlur = 0;
            requestAnimationFrame(tick);
        }
        requestAnimationFrame((t) => { t0 = t; tick(t); });
    }

    /* -------------------------------------------------- header scroll state +
       hero scroll-fade. parallax via transform would fight the .reveal
       transition (which also owns `transform`), so we only modulate opacity
       — that composes cleanly and never causes a "snap back" flicker.
       all writes batched in rAF to avoid layout thrash. */
    const header   = document.getElementById('header');
    const hero     = document.querySelector('.hero');
    const heroCopy = document.querySelector('.hero-copy');
    const heroVis  = document.querySelector('.hero-vis');
    const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    let scrollY = 0;
    let scrollTicking = false;
    let revealsSettled = false;
    setTimeout(() => { revealsSettled = true; }, 1400); // after reveal transitions finish

    function flushScroll() {
        scrollTicking = false;
        const y = scrollY;

        if (y > 20) header.classList.add('scrolled');
        else        header.classList.remove('scrolled');

        if (prefersReducedMotion || !hero || !revealsSettled) return;
        const heroH = hero.offsetHeight || 1;
        const p = Math.max(0, Math.min(1, y / (heroH * 0.85)));
        // soft fade on hero copy + vis as you leave the section — feels like
        // the content is being absorbed into the void below.
        if (heroCopy) heroCopy.style.opacity = `${1 - p * 0.55}`;
        if (heroVis)  heroVis.style.opacity  = `${1 - p * 0.40}`;
    }

    function onScroll() {
        scrollY = window.scrollY || window.pageYOffset;
        if (!scrollTicking) {
            scrollTicking = true;
            requestAnimationFrame(flushScroll);
        }
    }
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();

    /* -------------------------------------------------- scroll reveals.
       Elements with [data-type="cursor"] also get a typing animation:
       a blinking caret appears first, pauses, then types the text in. */
    function triggerTyping(el) {
        const text = el.textContent;
        el.textContent = '';
        const textNode = document.createTextNode('');
        const cursor   = document.createElement('span');
        cursor.className = 'type-cursor';
        cursor.setAttribute('aria-hidden', 'true');
        el.appendChild(textNode);
        el.appendChild(cursor);

        const CARET_PAUSE = 850;   // cursor blinks before any character appears
        const PER_CHAR    = 145;   // typing cadence — feels deliberate, not rushed

        setTimeout(() => {
            let i = 0;
            const id = setInterval(() => {
                i++;
                textNode.data = text.slice(0, i);
                if (i >= text.length) clearInterval(id);
            }, PER_CHAR);
        }, CARET_PAUSE);
    }

    const io = new IntersectionObserver((entries) => {
        for (const e of entries) {
            if (e.isIntersecting) {
                e.target.classList.add('in');
                io.unobserve(e.target);
                if (e.target.dataset.type === 'cursor') triggerTyping(e.target);
            }
        }
    }, { rootMargin: '0px 0px -80px 0px', threshold: 0.05 });
    document.querySelectorAll('.reveal').forEach((el) => io.observe(el));

    /* -------------------------------------------------- howto step cycle */
    const steps = Array.from(document.querySelectorAll('.step'));
    const flowDots = {
        you:  document.querySelector('.flow-node.you'),
        peer: document.querySelector('.flow-node.peer'),
        srv:  document.querySelector('.flow-node.srv'),
    };
    const flowPath = document.getElementById('flowPath');
    let stepIdx = 0;
    let stepHover = false;

    function setStep(i) {
        stepIdx = (i + steps.length) % steps.length;
        steps.forEach((s, k) => s.classList.toggle('is-active', k === stepIdx));
        if (flowPath) {
            const state = ['create', 'share', 'talk', 'close'][stepIdx] || 'create';
            flowPath.setAttribute('data-state', state);
            if (flowDots.you)  flowDots.you.classList.toggle('lit', state === 'share' || state === 'talk');
            if (flowDots.peer) flowDots.peer.classList.toggle('lit', state === 'share' || state === 'talk');
            if (flowDots.srv)  flowDots.srv.classList.toggle('lit', state === 'share');
        }
    }
    function nextStep() { if (!stepHover) setStep(stepIdx + 1); }

    steps.forEach((s, k) => {
        s.addEventListener('mouseenter', () => { stepHover = true;  setStep(k); });
        s.addEventListener('mouseleave', () => { stepHover = false; });
        s.addEventListener('click',      () => { setStep(k); });
    });
    if (steps.length > 0) {
        setStep(0);
        setInterval(nextStep, 3600);
    }

    /* -------------------------------------------------- room peers — animated arcs */
    document.querySelectorAll('.room-peer').forEach((peer) => {
        const arc = peer.querySelector('[data-arc]');
        if (!arc) return;
        const isLive = peer.classList.contains('live');
        const isMuted = peer.classList.contains('muted');
        if (isMuted) { arc.setAttribute('stroke-dashoffset', '999'); return; }
        if (!isLive) { arc.setAttribute('stroke-dashoffset', '180'); return; }
        // animate dashoffset between two values via inline keyframe-ish loop
        const dur = 1600 + Math.random() * 1200;
        const phase = Math.random() * Math.PI * 2;
        function step() {
            const t = (performance.now() / dur) * 2 * Math.PI + phase;
            const v = 90 + (Math.sin(t) + 1) * 0.5 * 110; // 90..200
            arc.setAttribute('stroke-dashoffset', v.toFixed(1));
            requestAnimationFrame(step);
        }
        step();
    });

    /* -------------------------------------------------- screen-share cursor — click / type / erase loop */
    (function () {
        const cursor    = document.getElementById('screenCursor');
        const screenBody = document.getElementById('screenBody');
        const liveLine  = document.getElementById('liveLine');
        const liveText  = document.getElementById('liveText');
        if (!cursor || !screenBody || !liveLine || !liveText) return;

        const snippets = [
            "peer.send('hello');",
            "room.invite('jun');",
            "chat.share(file);",
            "screen.start();"
        ];

        const wait = (ms) => new Promise(r => setTimeout(r, ms));

        function moveTo(x, y, dur = 700) {
            cursor.style.transition = `transform ${dur}ms cubic-bezier(.4,.1,.3,1)`;
            cursor.style.transform  = `translate(${x}px, ${y}px)`;
            return wait(dur);
        }

        async function click() {
            cursor.classList.remove('is-clicking');
            // force reflow so the animation re-triggers
            void cursor.offsetWidth;
            cursor.classList.add('is-clicking');
            await wait(360);
            cursor.classList.remove('is-clicking');
        }

        async function typeText(text, perChar = 70) {
            liveText.textContent = '';
            for (const ch of text) {
                liveText.textContent += ch;
                // small jitter so it doesn't feel mechanical
                await wait(perChar + Math.random() * 40);
            }
        }
        async function eraseAll(perChar = 28) {
            while (liveText.textContent.length > 0) {
                liveText.textContent = liveText.textContent.slice(0, -1);
                await wait(perChar);
            }
        }

        function targetXY() {
            const br = screenBody.getBoundingClientRect();
            const lr = liveLine.getBoundingClientRect();
            const tx = (lr.left - br.left) + 36;   // a touch past the line number
            const ty = (lr.top  - br.top)  + 2;
            return { tx, ty, br };
        }

        let alive = true;
        async function loop() {
            const { br } = targetXY();
            // start at a relaxed lower-right idle position
            cursor.style.transition = 'none';
            cursor.style.transform = `translate(${br.width * 0.7}px, ${br.height * 0.72}px)`;
            await wait(700);

            let i = 0;
            while (alive) {
                const { tx, ty } = targetXY();
                await moveTo(tx, ty, 800);
                await wait(120);
                await click();
                await wait(160);

                const text = snippets[i % snippets.length];
                await typeText(text);
                await wait(1100);
                await eraseAll();
                await wait(420);

                // drift cursor away briefly before next snippet
                const { br: br2 } = targetXY();
                await moveTo(br2.width * 0.62, br2.height * 0.78, 520);
                await wait(420);
                i++;
            }
        }
        loop();
    })();

    /* -------------------------------------------------- year stamp */
    const y = document.getElementById('year');
    if (y) y.textContent = new Date().getFullYear();

    /* -------------------------------------------------- language toggle */
    const toggle = document.querySelector('.lang-toggle');
    if (toggle && window.applyVoidLang && window.getVoidLang) {
        const initial = window.getVoidLang();
        window.applyVoidLang(initial);
        toggle.addEventListener('click', (e) => {
            const btn = e.target.closest('button[data-lang]');
            if (!btn) return;
            const next = btn.getAttribute('data-lang');
            window.applyVoidLang(next);
        });
    }
})();
