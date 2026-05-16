/* ============================================================================
   void — intro animation (slow, cinematic)
   sequence:
     T=0      logo fades in, faint
     T=900    caption types in: "priming the room"
     T=2400   caption swaps to "..opening"
     T=3000   charging: orbit accelerates, glow intensifies, particles emit
     T=4200   BURST — big radial scatter
     T=4500   lift-off — logo floats up to the centered header slot,
              shrinking on the way; page reveals beneath
     T=6000   intro layer removed; flag stored to skip on reload
   skippable: click anywhere or any key
   ============================================================================ */

(function () {
    const intro      = document.getElementById('intro');
    const introLogo  = document.getElementById('introLogo');
    const introCap   = document.getElementById('introCaption');
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

    /* ---- particle canvas ---------------------------------------------- */
    const ctx = canvas.getContext('2d');
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    let W = 0, H = 0;
    function size() {
        W = canvas.clientWidth = window.innerWidth;
        H = canvas.clientHeight = window.innerHeight;
        canvas.width  = W * dpr;
        canvas.height = H * dpr;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    size();
    window.addEventListener('resize', size);

    const particles = [];

    function spawn(n, opts) {
        opts = opts || {};
        const cx = opts.cx ?? W / 2;
        const cy = opts.cy ?? H / 2;
        for (let i = 0; i < n; i++) {
            const a = Math.random() * Math.PI * 2;
            const speed = (opts.speed || 1.5) * (0.6 + Math.random() * 1.4);
            const tang  = (opts.tang || 0) * (Math.random() - 0.5);
            const vx = Math.cos(a) * speed - Math.sin(a) * tang;
            const vy = Math.sin(a) * speed + Math.cos(a) * tang;
            const r0 = opts.r0 ?? 60;
            const px = cx + Math.cos(a) * r0;
            const py = cy + Math.sin(a) * r0;
            particles.push({
                x: px, y: py,
                vx, vy,
                life: 0,
                ttl: 1.4 + Math.random() * 2.4,
                size: 0.6 + Math.random() * 1.6,
                hue: Math.random() < 0.06 ? 'warm' : 'white',
            });
        }
    }

    let lastT = performance.now();
    let running = true;
    function loop(t) {
        if (!running) return;
        const dt = Math.min(0.05, (t - lastT) / 1000);
        lastT = t;

        ctx.clearRect(0, 0, W, H);

        for (let i = particles.length - 1; i >= 0; i--) {
            const p = particles[i];
            p.life += dt;
            if (p.life > p.ttl) { particles.splice(i, 1); continue; }
            p.vx *= (1 - 0.55 * dt);
            p.vy *= (1 - 0.55 * dt);
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

    /* ---- caption typing ------------------------------------------------ */
    let typeTimer = null;
    function typeText(text, done) {
        clearInterval(typeTimer);
        let i = 0;
        introCap.classList.remove('fading');
        introCap.classList.add('visible');
        introCap.textContent = '';
        typeTimer = setInterval(() => {
            i++;
            introCap.textContent = text.slice(0, i) + (i < text.length && i % 2 ? '_' : '');
            if (i >= text.length) {
                clearInterval(typeTimer);
                introCap.textContent = text;
                if (done) done();
            }
        }, 90);
    }

    function fadeCaption(after) {
        introCap.classList.add('fading');
        setTimeout(after || (() => {}), 700);
    }

    /* ---- the lift-off -------------------------------------------------- */
    let cleanedUp = false;
    function liftOff() {
        if (cleanedUp) return;
        cleanedUp = true;

        const sourceRect = introLogo.getBoundingClientRect();
        const targetRect = headerSlot.getBoundingClientRect();

        const sx = sourceRect.left + sourceRect.width / 2;
        const sy = sourceRect.top  + sourceRect.height / 2;
        const tx = targetRect.left + targetRect.width / 2;
        const ty = targetRect.top  + targetRect.height / 2;
        const scale = targetRect.width / sourceRect.width;
        const dx = tx - sx;
        const dy = ty - sy;

        introLogo.classList.remove('is-charging');
        introLogo.classList.add('is-flying');

        // a few sparks trailing the flight
        spawn(60, { speed: 2.4, tang: 1.0, r0: 60 });

        requestAnimationFrame(() => {
            introLogo.style.transform = `translate(${dx}px, ${dy}px) scale(${scale})`;
        });

        // fade caption out too
        fadeCaption();

        // header slot lights up about the time the logo arrives
        setTimeout(() => {
            if (headerSlot) headerSlot.classList.add('is-ready');
        }, 1200);

        // the page itself fades in slightly before the intro layer fades out,
        // so it reads as "rising from the darkness"
        setTimeout(() => {
            page.classList.add('is-visible');
        }, 900);

        setTimeout(() => {
            intro.classList.add('fade-out');
        }, 1300);

        setTimeout(() => {
            running = false;
            intro.remove();
            sessionStorage.setItem(SKIP_KEY, '1');
        }, 2600);
    }

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

    /* ---- the sequence (slower, deliberate) ----------------------------- */

    // T=200 — wake the logo (CSS handles fade/scale)
    setTimeout(() => introLogo.classList.add('is-awake'), 200);

    // T=900 — type caption
    function pickCaption() {
        const lang = (window.getVoidLang && window.getVoidLang()) || 'ru';
        return lang === 'en'
            ? { a: 'opening the void', b: 'silence is loading' }
            : { a: 'открываем пустоту',   b: 'тишина загружается' };
    }
    setTimeout(() => {
        const c = pickCaption();
        typeText(c.a);
    }, 900);

    // T=2400 — fade caption, retype second phrase
    setTimeout(() => {
        fadeCaption(() => {
            const c = pickCaption();
            typeText(c.b);
        });
    }, 2400);

    // T=900 → start a steady stream of slow sparks (ambient)
    let sparkInterval = null;
    setTimeout(() => {
        sparkInterval = setInterval(() => {
            spawn(2, { speed: 0.7, tang: 0.5, r0: 70 });
        }, 110);
    }, 900);

    // T=3000 — charging
    setTimeout(() => {
        introLogo.classList.add('is-charging');
        clearInterval(sparkInterval);
        sparkInterval = setInterval(() => {
            spawn(5, { speed: 2.2, tang: 1.4, r0: 65 });
        }, 60);
    }, 3000);

    // T=4200 — burst
    setTimeout(() => {
        clearInterval(sparkInterval);
        spawn(240, { speed: 3.6, tang: 2.6, r0: 64 });
        setTimeout(() => spawn(80, { speed: 1.6, tang: 1.0, r0: 80 }), 140);
    }, 4200);

    // T=4500 — lift-off
    setTimeout(liftOff, 4500);
})();
