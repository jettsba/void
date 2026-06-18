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
/* #хэш перехвачен инлайн-скриптом в <head> (до нативного фрагмент-скролла) и
   снят с URL; цель лежит в window.__voidEntrance. Здесь только плавно доезжаем.
   window.scrollTo(0,0) — страховка на случай, если браузер всё же успел скакнуть. */
var __voidEntrance = window.__voidEntrance || null;
if (__voidEntrance) { try { window.scrollTo(0, 0); } catch (_) {} }

(function initLenis() {
    function start() {
        if (typeof Lenis === 'undefined') {
            /* Lenis не загрузился — но хэш уже убран и мы наверху, поэтому
               доставим юзера к секции напрямую (без анимации). */
            if (__voidEntrance) {
                const t = document.getElementById(__voidEntrance);
                if (t) t.scrollIntoView();
            }
            return;
        }
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

        /* Хэш уже убран и страница наверху (captureEntrance) — теперь на глазах
           плавно доезжаем до секции. lenis immediate синхронизирует внутреннюю
           позицию Lenis с верхом перед анимацией. */
        if (__voidEntrance) {
            const target = document.getElementById(__voidEntrance);
            if (target) {
                lenis.scrollTo(0, { immediate: true });
                setTimeout(() => {
                    lenis.scrollTo(target, {
                        offset: 0,
                        duration: 2.4,
                        easing: (t) => 1 - Math.pow(1 - t, 4),  // тот же silky ease-out
                    });
                }, 750);
            }
        }
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
    /* -------------------------------------------------- deep-field blobs
       Тот же приём, что и в app/public/js/background.js:
       - 4 пятна с лёгкими холодными/тёплыми тонами;
       - `globalCompositeOperation = 'lighter'` — пересечения просто светлеют,
         не дают видимых границ;
       - 4-стоповый eased градиент вместо линейного — без mach band у края.
       Слой лежит ПОД bgCanvas (звёзды) — DOM-порядок задаёт стопку. */
    const blob = document.getElementById('bgBlobs');
    /* На мобильном blob'ы убираем: они мелко дёргаются (URL-бар то появляется,
       то прячется → resize → reseed → прыжок) и выглядят криво на узком экране. */
    const blobMobile = window.matchMedia('(max-width: 760px)').matches
        || window.matchMedia('(hover: none) and (pointer: coarse)').matches;
    if (blob && blobMobile) {
        blob.style.display = 'none';
    } else if (blob) {
        const bctx = blob.getContext('2d');
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const TINTS = [
            [200, 205, 220],
            [205, 195, 180],
            [185, 195, 210],
            [220, 220, 224],
        ];
        let BW = 0, BH = 0;
        let blobs = [];
        /* prefers-reduced-motion: рендерим blob'ы статично (один кадр), без
           рАФ-цикла. Юзеры с включённой настройкой "уменьшить движение" в
           OS видят фон, но без анимации — vestibular-safe. */
        const blobReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

        function bfit() {
            BW = document.documentElement.clientWidth  || window.innerWidth  || 0;
            BH = document.documentElement.clientHeight || window.innerHeight || 0;
            blob.width  = Math.max(1, Math.round(BW * dpr));
            blob.height = Math.max(1, Math.round(BH * dpr));
            blob.style.width  = BW + 'px';
            blob.style.height = BH + 'px';
            bctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        }
        function bseed() {
            blobs = [];
            for (let i = 0; i < 4; i++) {
                blobs.push({
                    x: Math.random() * BW,
                    y: Math.random() * BH,
                    r: 320 + Math.random() * 280,
                    vx: (Math.random() - 0.5) * 0.05,
                    vy: (Math.random() - 0.5) * 0.05,
                    a: 0.022 + Math.random() * 0.014,
                    tint: TINTS[i % TINTS.length],
                });
            }
        }
        bfit(); bseed();
        /* Под reduced-motion — на resize только перерисовать (без анимации). */
        window.addEventListener('resize', () => { bfit(); bseed(); if (blobReducedMotion) bpaint(); });

        function bpaint() {
            bctx.clearRect(0, 0, BW, BH);
            bctx.globalCompositeOperation = 'lighter';
            for (const b of blobs) {
                if (!blobReducedMotion) {
                    b.x += b.vx; b.y += b.vy;
                    if (b.x < -b.r) b.x = BW + b.r;
                    if (b.x > BW + b.r) b.x = -b.r;
                    if (b.y < -b.r) b.y = BH + b.r;
                    if (b.y > BH + b.r) b.y = -b.r;
                }
                const [r, g, bl] = b.tint;
                const grad = bctx.createRadialGradient(b.x, b.y, 0, b.x, b.y, b.r);
                grad.addColorStop(0.0, `rgba(${r},${g},${bl},${b.a})`);
                grad.addColorStop(0.35, `rgba(${r},${g},${bl},${b.a * 0.55})`);
                grad.addColorStop(0.7, `rgba(${r},${g},${bl},${b.a * 0.15})`);
                grad.addColorStop(1.0, `rgba(${r},${g},${bl},0)`);
                bctx.fillStyle = grad;
                bctx.beginPath();
                bctx.arc(b.x, b.y, b.r, 0, Math.PI * 2);
                bctx.fill();
            }
            bctx.globalCompositeOperation = 'source-over';
            if (!blobReducedMotion) requestAnimationFrame(bpaint);
        }
        requestAnimationFrame(bpaint);
    }

    /* -------------------------------------------------- ambient background */
    const bg = document.getElementById('bgCanvas');
    if (bg) {
        const ctx = bg.getContext('2d');
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        let W = 0, H = 0;
        function fit() {
            // clientWidth/Height of <html> matches what `inset: 0` covers
            // (excludes scrollbar) — keeps buffer aligned with the layout
            // viewport. We ALSO explicitly set CSS style.width/height in CSS
            // pixels — without that, canvas (a replaced element) renders at its
            // intrinsic size = bufferWidth, which differs from the viewport at
            // dpr != 1, causing star positions to drift right/down at dpr>1 and
            // left/up at dpr<1. (Same fix lives in intro.js — see comments there.)
            W = document.documentElement.clientWidth  || window.innerWidth  || 0;
            H = document.documentElement.clientHeight || window.innerHeight || 0;
            bg.width  = Math.max(1, Math.round(W * dpr));
            bg.height = Math.max(1, Math.round(H * dpr));
            bg.style.width  = W + 'px';
            bg.style.height = H + 'px';
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
    const brandLock  = document.getElementById('brandLockup');
    const brandSlot  = document.getElementById('brandLogoSlot');
    const hero       = document.querySelector('.hero');
    const heroCopy   = document.querySelector('.hero-copy');
    const heroVis    = document.querySelector('.hero-vis');
    const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    /* reveal the "void" wordmark a short beat AFTER the intro orb lands in the
       header slot. intro.js adds `.is-ready` on brandLogoSlot when the eclipse
       is in place; we wait for that, then add `.is-revealed` on the lockup so
       the text slides out from behind the orb. */
    function scheduleBrandReveal() {
        if (!brandLock || !brandSlot) return;
        const reveal = () => setTimeout(() => brandLock.classList.add('is-revealed'), 450);
        if (brandSlot.classList.contains('is-ready')) { reveal(); return; }
        const mo = new MutationObserver(() => {
            if (brandSlot.classList.contains('is-ready')) { mo.disconnect(); reveal(); }
        });
        mo.observe(brandSlot, { attributes: true, attributeFilter: ['class'] });
    }
    scheduleBrandReveal();

    /* clicking the lockup scrolls to top (#top via Lenis). pin the wordmark
       as shown for the duration of that scroll so it doesn't blink-out when
       the cursor/finger leaves — flushScroll releases .is-pinned once y<=20.
       Safety: if already near the top (no scroll will fire) or on touch where
       :hover doesn't apply, release on a short timeout so it doesn't stick. */
    if (brandLock) {
        let pinTimer = null;
        brandLock.addEventListener('click', () => {
            brandLock.classList.add('is-pinned');
            if (pinTimer) clearTimeout(pinTimer);
            // covers: (a) already at top, no scroll happens; (b) touch devices
            // where :hover sticks after tap. 1800ms = comfortably longer than
            // the Lenis scroll-to-top from anywhere on the page.
            pinTimer = setTimeout(() => {
                brandLock.classList.remove('is-pinned');
                pinTimer = null;
            }, 1800);
        });
    }

    let scrollY = 0;
    let scrollTicking = false;
    let revealsSettled = false;
    setTimeout(() => { revealsSettled = true; }, 1400); // after reveal transitions finish

    function flushScroll() {
        scrollTicking = false;
        const y = scrollY;

        if (brandLock) {
            if (y > 20) brandLock.classList.add('is-collapsed');
            else        brandLock.classList.remove('is-collapsed');
            // .is-pinned holds the wordmark visible after a click on the lockup
            // even when the cursor leaves. Release it once we're back at the
            // top — at that point .is-collapsed is gone so the text stays shown
            // for the right reason (not collapsed) instead of the sticky one.
            if (y <= 20) brandLock.classList.remove('is-pinned');
        }

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

    /* -------------------------------------------------- one-shot typewriter
       Distinct from triggerTyping above: no permanent caret, no lead-in pause,
       fires once when an element with [data-type-once] enters the viewport,
       then leaves the static text in place. Used on the `what` section's
       definition line — a quiet "the void writes itself" detail that the
       visitor only catches the first time. Skipped if prefers-reduced-motion
       is set (the global `transition-duration: 0.001s` rule would race the
       interval and produce visible flicker — cleaner to just no-op). */
    const reducedMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    function triggerTypeOnce(el) {
        if (reducedMotion) return;
        const text = el.textContent;
        if (!text) return;
        el.textContent = '';
        const PER_CHAR = 22;
        let i = 0;
        const id = setInterval(() => {
            i++;
            el.textContent = text.slice(0, i);
            if (i >= text.length) clearInterval(id);
        }, PER_CHAR);
    }

    const typeIo = new IntersectionObserver((entries) => {
        for (const e of entries) {
            if (e.isIntersecting) {
                typeIo.unobserve(e.target);
                triggerTypeOnce(e.target);
            }
        }
    }, { rootMargin: '0px 0px -10% 0px', threshold: 0.6 });
    document.querySelectorAll('[data-type-once]').forEach((el) => typeIo.observe(el));


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

    /* -------------------------------------------------- live app version
       Fetches /api/version (served by server.js from package.json) and writes
       it into every `.app-version` element on the page. If the fetch fails
       (no node server behind — e.g. when opened via VSCode Live Server), the
       element keeps its `data-version-fallback` text so the eyebrow doesn't
       go blank. Cached client-side for 1 hour. */
    (function injectVersion() {
        const slots = document.querySelectorAll('.app-version');
        if (slots.length === 0) return;
        fetch('/api/version', { cache: 'default' })
            .then(r => r.ok ? r.json() : null)
            .then(data => {
                if (!data || !data.version) return;
                const text = 'v' + data.version;
                slots.forEach(el => { el.textContent = text; });
            })
            .catch(() => { /* keep data-version-fallback as-is */ });
    })();

    /* -------------------------------------------------- contributors section
       Three responsibilities:

       1. fetchContributors()  primary `/api/contributors` (server parses
                               PREMIUM_NICKNAMES at boot, filters casheaterr).
                               Fallback: live-server / file:// has no node, so
                               we re-parse public/js/config.js client-side with
                               the identical regex. In production the API
                               always succeeds first — fallback never runs.

       2. renderMarquee()      builds <li>name + "/"-separator</li> items and
                               appends them TWICE into #contribList so the CSS
                               `translateX(-50%)` infinite-loop lands on an
                               identical item — visually seamless. Also writes
                               the count into #contribCount.

       3. startAnnouncer()     cycles 1..3 lines from #contribAnnouncer's
                               data-line-N attributes (per-locale copy lives in
                               HTML, JS stays language-agnostic). ~36ms/char
                               typewriter with 3.2s hold between lines.
                               Bails on prefers-reduced-motion — leaves the
                               first line statically visible.

       Empty list (both fetch paths failed) → section.hidden = true. A
       "people who help" block with no people reads worse than no section. */
    async function fetchContributors() {
        try {
            const r = await fetch('/api/contributors', { cache: 'default' });
            if (r.ok) {
                const data = await r.json();
                if (data && Array.isArray(data.names) && data.names.length) return data.names;
            }
        } catch (_) { /* fall through to dev parse */ }
        try {
            const r = await fetch('/public/js/config.js', { cache: 'default' });
            if (r.ok) {
                const src = await r.text();
                const block = src.match(/PREMIUM_NICKNAMES\s*=\s*new\s+Set\s*\(\s*\[([\s\S]*?)\]\s*\)/);
                if (block) {
                    return [...block[1].matchAll(/["']([^"']+)["']/g)]
                        .map(m => m[1].trim().toLowerCase())
                        .filter(Boolean)
                        .filter(n => n !== 'casheaterr');
                }
            }
        } catch (_) { /* both paths failed */ }
        return [];
    }

    function renderMarquee(names) {
        const list  = document.getElementById('contribList');
        const count = document.getElementById('contribCount');
        if (!list) return;
        list.innerHTML = '';
        if (count) count.textContent = String(names.length);

        // placeholder copy is locale-specific, lives on the <ul>'s
        // data-placeholder attr ("+ ваше_имя" / "+ your_name"); skipped if
        // absent so the function stays defensive about partial markup.
        const placeholder = list.dataset.placeholder || '';

        const buildItem = (name, isPlaceholder) => {
            const li  = document.createElement('li');
            const nm  = document.createElement('span');
            const sep = document.createElement('span');
            nm.className  = isPlaceholder ? 'contrib-name placeholder' : 'contrib-name';
            sep.className = 'contrib-sep';
            nm.textContent  = name;
            sep.textContent = '/';
            sep.setAttribute('aria-hidden', 'true');
            li.appendChild(nm);
            li.appendChild(sep);
            return li;
        };

        // Two passes: original + aria-hidden duplicate. The CSS animation
        // translateX(-50%) ends on the duplicate's first item — identical to
        // the original's first item, so the loop is visually seamless. The
        // placeholder slot sits at the end of each pass — "next seat in the
        // list" reads as an open invitation to contribute.
        const frag = document.createDocumentFragment();
        names.forEach((n) => frag.appendChild(buildItem(n, false)));
        if (placeholder) frag.appendChild(buildItem(placeholder, true));
        names.forEach((n) => {
            const li = buildItem(n, false);
            li.setAttribute('aria-hidden', 'true');
            frag.appendChild(li);
        });
        if (placeholder) {
            const ph = buildItem(placeholder, true);
            ph.setAttribute('aria-hidden', 'true');
            frag.appendChild(ph);
        }
        list.appendChild(frag);

        /* Перезапуск анимации после инжекта. CSS-анимация contrib-roll стартует
           на ПУСТОМ <ul> ещё до прихода данных (fetch async), и к моменту вставки
           уже «уехала» по фазе с неверной шириной трека — на мобильных это
           читается как «не двигается / пусто». Сброс + reflow синхронизирует её
           от translateX(0) с уже корректной шириной. */
        list.style.animation = 'none';
        void list.offsetWidth;
        list.style.animation = '';
    }

    function startAnnouncer() {
        const el = document.getElementById('contribAnnouncer');
        if (!el) return;
        const lines = [el.dataset.line1, el.dataset.line2, el.dataset.line3].filter(Boolean);
        if (!lines.length) return;

        if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
            el.textContent = lines[0];
            return;
        }

        let cancelled = false;
        let timer = null;
        const wait = (ms) => new Promise((res) => { timer = setTimeout(res, ms); });

        (async () => {
            while (!cancelled) {
                for (const line of lines) {
                    for (let i = 0; i <= line.length; i++) {
                        if (cancelled) return;
                        el.textContent = line.slice(0, i);
                        await wait(36);
                    }
                    await wait(3200);
                    if (cancelled) return;
                }
            }
        })();

        window.addEventListener('pagehide', () => {
            cancelled = true;
            if (timer) clearTimeout(timer);
        }, { once: true });
    }

    (function injectContributors() {
        const section = document.getElementById('contributors');
        if (!section) return;
        fetchContributors().then((names) => {
            if (!names.length) { section.hidden = true; return; }
            renderMarquee(names);
            startAnnouncer();
        });
    })();

})();

/* ----------------------------------------------------------------------------
   Download split-button: главная половина качает desktop-installer, стрелка
   справа раскрывает меню (desktop + portable). Загрузку триггерим из временного
   <a download>, а не через href на кнопке — поэтому браузер не показывает
   длинный github-URL в статус-баре при наведении. Меню закрывается по клику
   вне, по Esc и после выбора варианта.
   ---------------------------------------------------------------------------- */
(function initDownload() {
    function triggerDownload(url) {
        if (!url) return;
        // download-атрибут cross-origin игнорится, но github отдаёт ассет с
        // Content-Disposition: attachment — загрузка стартует, со страницы не уводит.
        const a = document.createElement('a');
        a.href = url;
        a.rel = 'noopener';
        a.download = '';
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();
        a.remove();
    }

    function init() {
        const dl = document.querySelector('[data-dl]');
        if (!dl) return;
        const toggle = dl.querySelector('[data-dl-toggle]');

        const close = () => {
            dl.dataset.open = 'false';
            if (toggle) toggle.setAttribute('aria-expanded', 'false');
        };
        const open = () => {
            dl.dataset.open = 'true';
            if (toggle) toggle.setAttribute('aria-expanded', 'true');
        };

        // главная кнопка + опции меню несут data-dl-url → качают по клику
        dl.querySelectorAll('[data-dl-url]').forEach((btn) => {
            btn.addEventListener('click', () => {
                triggerDownload(btn.dataset.dlUrl);
                close();
            });
        });

        if (toggle) {
            toggle.addEventListener('click', (e) => {
                e.stopPropagation();
                if (dl.dataset.open === 'true') close(); else open();
            });
        }

        document.addEventListener('click', (e) => {
            if (!dl.contains(e.target)) close();
        });
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') close();
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
