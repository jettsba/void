/* ========= AMBIENT — deep field =========
   Два слоя поверх --bg-0:
   - blobs: 4 плавно дрейфующих пятна с лёгкими холодными/тёплыми оттенками,
            аддитивное смешение (`lighter`) и 4-стоповый eased градиент.
            Аддитивка убирает «кольца» на пересечениях, eased-falloff —
            mach band у края (линейный градиент его давал отчётливо).
   - stars: ~70 редких звёзд, в основном 1px, у ~18% — медленный twinkle.

   Слой #background-grain (SVG-шум в CSS) — отдельным div'ом, JS не нужен. */

let _canvasPaused = false;

let _starsCanvas = null;
let _starsCtx = null;
let _stars = [];

const BLOB_TINTS = [
    [200, 205, 220],
    [205, 195, 180],
    [185, 195, 210],
    [220, 220, 224],
];

function sizeCanvas() {
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    canvas.width = window.innerWidth * dpr;
    canvas.height = window.innerHeight * dpr;
    canvas.style.width = window.innerWidth + "px";
    canvas.style.height = window.innerHeight + "px";
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    _starsCanvas = _starsCanvas || document.getElementById("background-stars");
    if (_starsCanvas) {
        _starsCtx = _starsCtx || _starsCanvas.getContext("2d");
        _starsCanvas.width = window.innerWidth * dpr;
        _starsCanvas.height = window.innerHeight * dpr;
        _starsCanvas.style.width = window.innerWidth + "px";
        _starsCanvas.style.height = window.innerHeight + "px";
        _starsCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
}

function seedBlobs() {
    blobs = [];
    const count = 4;
    for (let i = 0; i < count; i++) {
        blobs.push({
            x: Math.random() * window.innerWidth,
            y: Math.random() * window.innerHeight,
            r: 320 + Math.random() * 280,
            vx: (Math.random() - 0.5) * 0.05,
            vy: (Math.random() - 0.5) * 0.05,
            a: 0.022 + Math.random() * 0.014,
            tint: BLOB_TINTS[i % BLOB_TINTS.length],
        });
    }
    _seedStars();
}

function _seedStars() {
    _stars = [];
    if (!_starsCanvas) return;
    /* Плотность нормируем к 1920×1080 ≈ 70 шт., но не меньше 50 — на маленьких
       экранах иначе пусто. На больших мониторах звёзд будет соответственно
       больше, но они всё равно редкие, фон не «зашумляется». */
    const target = Math.round(70 * (window.innerWidth * window.innerHeight) / (1920 * 1080));
    const n = Math.max(50, target);
    for (let i = 0; i < n; i++) {
        const sz = Math.random();
        _stars.push({
            x: Math.random() * window.innerWidth,
            y: Math.random() * window.innerHeight,
            r: sz < 0.85 ? 0.6 : (sz < 0.97 ? 1.0 : 1.6),
            base: 0.25 + Math.random() * 0.45,
            twinkle: Math.random() < 0.18,
            phase: Math.random() * Math.PI * 2,
            speed: 0.4 + Math.random() * 0.8,
        });
    }
}

function paint() {
    if (_canvasPaused) {
        setTimeout(() => requestAnimationFrame(paint), 200);
        return;
    }

    const w = window.innerWidth;
    const h = window.innerHeight;

    ctx.clearRect(0, 0, w, h);
    ctx.globalCompositeOperation = "lighter";
    blobs.forEach(b => {
        b.x += b.vx;
        b.y += b.vy;
        if (b.x < -b.r) b.x = w + b.r;
        if (b.x > w + b.r) b.x = -b.r;
        if (b.y < -b.r) b.y = h + b.r;
        if (b.y > h + b.r) b.y = -b.r;

        const [r, g, bl] = b.tint;
        const grad = ctx.createRadialGradient(b.x, b.y, 0, b.x, b.y, b.r);
        grad.addColorStop(0.0, `rgba(${r},${g},${bl},${b.a})`);
        grad.addColorStop(0.35, `rgba(${r},${g},${bl},${b.a * 0.55})`);
        grad.addColorStop(0.7, `rgba(${r},${g},${bl},${b.a * 0.15})`);
        grad.addColorStop(1.0, `rgba(${r},${g},${bl},0)`);
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2);
        ctx.fill();
    });
    /* Возвращаем дефолт — на случай, если что-то ещё рисует поверх canvas. */
    ctx.globalCompositeOperation = "source-over";

    if (_starsCtx && _stars.length) {
        const t = performance.now() * 0.001;
        _starsCtx.clearRect(0, 0, w, h);
        _stars.forEach(s => {
            let a = s.base;
            if (s.twinkle) a *= 0.55 + 0.45 * Math.sin(t * s.speed + s.phase);
            _starsCtx.fillStyle = `rgba(230,230,232,${a})`;
            _starsCtx.beginPath();
            _starsCtx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
            _starsCtx.fill();
        });
    }

    requestAnimationFrame(paint);
}
