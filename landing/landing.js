/* ============================================================================
   void — landing behaviors
   ============================================================================ */

(function () {
    /* -------------------------------------------------- ambient background */
    const bg = document.getElementById('bgCanvas');
    if (bg) {
        const ctx = bg.getContext('2d');
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        let W = 0, H = 0;
        function fit() {
            W = bg.clientWidth = window.innerWidth;
            H = bg.clientHeight = window.innerHeight;
            bg.width  = W * dpr;
            bg.height = H * dpr;
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

    /* -------------------------------------------------- header scroll state */
    const header = document.getElementById('header');
    function onScroll() {
        const y = window.scrollY || window.pageYOffset;
        if (y > 20) header.classList.add('scrolled');
        else header.classList.remove('scrolled');
    }
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();

    /* -------------------------------------------------- scroll reveals */
    const io = new IntersectionObserver((entries) => {
        for (const e of entries) {
            if (e.isIntersecting) {
                e.target.classList.add('in');
                io.unobserve(e.target);
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
        const cursor     = document.getElementById('screenCursor');
        const screenBody = document.getElementById('screenBody');
        const liveLine   = document.getElementById('liveLine');
        const liveText   = document.getElementById('liveText');
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
            void cursor.offsetWidth;
            cursor.classList.add('is-clicking');
            await wait(360);
            cursor.classList.remove('is-clicking');
        }

        async function typeText(text, perChar = 70) {
            liveText.textContent = '';
            for (const ch of text) {
                liveText.textContent += ch;
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
            const tx = (lr.left - br.left) + 36;
            const ty = (lr.top  - br.top)  + 2;
            return { tx, ty, br };
        }

        let alive = true;
        async function loop() {
            const { br } = targetXY();
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
