/* ========= AMBIENT BACKGROUNDS =========

   Три темы, переключаемые из настроек.

   silence    — нейтральные блобы (холодные/тёплые тинты), `lighter` blend,
                редкие звёзды + grain. Историческая «A» — дефолт.
   nebula     — цветные блобы (синие/фиолетовые/янтарь/петроль).
                Чтобы не было «канта» на пересечениях (S→S' оверлап с lighter
                быстро уходит в saturated): большие радиусы, низкая альфа,
                `screen` blend + квартичный gradient falloff с 10 стопами.
   void-grid  — точечная радиальная сетка (статичная, кэшированная в offscreen)
                + многослойный центральный глоу (3 наложенных radial-gradient
                по 12 стопов с easing → без видимых ступеней) + медленное
                «дыхание». Без звёзд.

   API (что зовёт app.js):
     sizeCanvas()  — resize обоих canvas, re-seed текущей темы под новый размер
     seedBlobs()   — первичная инициализация, читает theme из VoidSettings
     paint()       — стартует rAF-цикл (идемпотентно)

   Тему меняет событие "void:bg-theme-changed" (детайл: {theme}).
   На время свопа на <html> ставится класс `bg-switching`, CSS гасит canvas
   через opacity-transition — получается плавный crossfade. */

let _canvasPaused = false;
let _rafId = null;
let _theme = null;
let _themeInited = false;

/* Запоминаем последнюю CSS-ширину/высоту, чтобы при resize пересчитать
   позиции блобов пропорционально новому viewport (а не просто clamp'ить
   в правый/нижний край). Без этого при браузерном zoom-out блобы остаются
   в верхнем-левом углу — выглядит как «обрезанный фон». */
let _lastCssW = 0;
let _lastCssH = 0;

/* ===== shared canvases ===== */

let _starsCanvas = null;
let _starsCtx = null;
let _stars = [];

/* ===== silence/nebula state ===== */

const SILENCE_TINTS = [
    [200, 205, 220],
    [205, 195, 180],
    [185, 195, 210],
    [220, 220, 224],
];

/* Палитра — глубокие сине/фиолетовые тона, как свечение далёких галактик.
   Намеренно не сатурированные и без тёплых/зелёных — чтобы overlap давал
   только разные оттенки одного спектра, без «грязи». */
const NEBULA_TINTS = [
    [110, 90, 200],   // насыщенный фиолет
    [70, 105, 205],   // глубокий синий
    [140, 100, 220],  // индиго / лаванда
    [80, 130, 215],   // ультрамарин с лёгким циан-наклоном
];

/* ===== void-grid state ===== */

const GRID_DOT_STEP = 28;       // шаг сетки в CSS-px
const GRID_DOT_RADIUS = 1.15;   // радиус точки

/* hover-эффект: точки в радиусе курсора плавно подсвечиваются.
   LIFT=0 намеренно — подъём перетягивал внимание (v0.9.40). */
const GRID_HOVER_RADIUS = 130;
const GRID_HOVER_RADIUS_SQ = GRID_HOVER_RADIUS * GRID_HOVER_RADIUS;
const GRID_HOVER_LIFT = 0;
const GRID_HOVER_ALPHA_BOOST = 1.1;
const GRID_DOT_BASE_RGB = [225, 230, 240];
const GRID_DOT_HOVER_RGB = [250, 235, 215]; // тёплый кремовый, в тон ядру глоу

let _gridDots = [];
let _gridGlowCx = 0;
let _gridGlowCy = 0;
let _hoverX = -1;
let _hoverY = -1;
let _gridMoveHandler = null;
let _gridLeaveHandler = null;

/* ===== utility: smooth radial fill ===== */

/** Создаёт радиальный градиент с N стопами и easing-функцией —
 *  устраняет видимые ступени в больших мягких glow'ах. */
function smoothRadialGradient(ctx, x, y, r, rgb, alphaMax, stops, easeExp) {
    const [cr, cg, cb] = rgb;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    for (let i = 0; i <= stops; i++) {
        const t = i / stops;
        /* (1 - t)^easeExp — плоское плато у центра, быстрый спад к краю.
           easeExp=4 даёт quartic falloff, визуально ≈ gaussian без расчётов. */
        const k = Math.pow(1 - t, easeExp);
        g.addColorStop(t, `rgba(${cr},${cg},${cb},${(alphaMax * k).toFixed(4)})`);
    }
    return g;
}

/* ===== canvases ===== */

/* DPR cap для canvas — амбиентный фон не нуждается в native retina
   разрешении. На high-DPI мониторах (1.5/2.0 в Windows, 2-3 на Retina/4K)
   рендер в native умножает pixel-fillrate квадратично. nebula с 12
   fillRect(0,0,w,h) на полный canvas + screen blend mode + 12-stop radial
   gradient на 2K-144Hz моник давал ~14 ГИГА pixel-fills/sec и грузил
   2070 Super на 40%. Cap на 1.5 + 30fps throttle (см. paint()) снижает
   нагрузку ~4-6× при незаметной для глаза потере чёткости фоновых блобов. */
const CANVAS_MAX_DPR = 1.5;

function sizeCanvas() {
    const dpr = Math.min(CANVAS_MAX_DPR, Math.max(1, window.devicePixelRatio || 1));
    const w = window.innerWidth;
    const h = window.innerHeight;

    canvas.width = w * dpr;
    canvas.height = h * dpr;
    canvas.style.width = w + "px";
    canvas.style.height = h + "px";
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    _starsCanvas = _starsCanvas || document.getElementById("background-stars");
    if (_starsCanvas) {
        _starsCtx = _starsCtx || _starsCanvas.getContext("2d");
        _starsCanvas.width = w * dpr;
        _starsCanvas.height = h * dpr;
        _starsCanvas.style.width = w + "px";
        _starsCanvas.style.height = h + "px";
        _starsCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    /* Пропорциональное масштабирование позиций — чтобы при заметном изменении
       viewport (браузерный zoom, перетаскивание окна между мониторами)
       блобы/звёзды распределялись по новому холсту, а не оставались в углу. */
    const ratioX = _lastCssW > 0 ? w / _lastCssW : 1;
    const ratioY = _lastCssH > 0 ? h / _lastCssH : 1;
    _rescaleStars(ratioX, ratioY);
    if (_themeInited && _theme && THEMES[_theme]?.resize) {
        THEMES[_theme].resize(ratioX, ratioY);
    }

    _lastCssW = w;
    _lastCssH = h;
}

function clearAllCanvases() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    ctx.clearRect(0, 0, w, h);
    if (_starsCtx) _starsCtx.clearRect(0, 0, w, h);
}

/* ===== SILENCE ===== */

function setupSilence() {
    blobs = [];
    for (let i = 0; i < 4; i++) {
        blobs.push({
            x: Math.random() * window.innerWidth,
            y: Math.random() * window.innerHeight,
            r: 320 + Math.random() * 280,
            vx: (Math.random() - 0.5) * 0.05,
            vy: (Math.random() - 0.5) * 0.05,
            a: 0.022 + Math.random() * 0.014,
            tint: SILENCE_TINTS[i % SILENCE_TINTS.length],
        });
    }
    _seedStars(70);
}

function resizeSilence(ratioX, ratioY) {
    /* Двигаем блобы пропорционально новому viewport — иначе при zoom-out
       они остаются в левом-верхнем углу, и большая часть экрана пустует. */
    const w = window.innerWidth;
    const h = window.innerHeight;
    blobs.forEach(b => {
        if (ratioX && ratioX !== 1) b.x *= ratioX;
        if (ratioY && ratioY !== 1) b.y *= ratioY;
        b.x = Math.min(Math.max(0, b.x), w);
        b.y = Math.min(Math.max(0, b.y), h);
    });
}

function frameSilence(t) {
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
    ctx.globalCompositeOperation = "source-over";

    _drawStars(t);
}

/* ===== NEBULA =====
   Свечение далёких галактик. Главные приёмы:
   1) Большие радиусы (700–1140 px) → цветные области занимают значительную
      часть экрана, мягкие переходы.
   2) Каждый блоб — не один круг, а три «доли», медленно вращающиеся вокруг
      общего центра со смещением 22% радиуса. Силуэт получается неправильным,
      «галактическим», а не дисковым.
   3) `screen` blend + 12 стопов quartic falloff → пересечения без «канта».
   4) Заливка через `fillRect(0, 0, w, h)` вместо `arc/fill`: gradient сам
      обрезает видимую область альфой=0 на t=1, а fillRect не создаёт
      путевой границы → нет антиалиас-кольца, которое раньше «проявлялось»
      на нативном dpr (а при отдалении сливалось). */
function setupNebula() {
    blobs = [];
    for (let i = 0; i < 4; i++) {
        blobs.push({
            x: Math.random() * window.innerWidth,
            y: Math.random() * window.innerHeight,
            r: 720 + Math.random() * 420,
            vx: (Math.random() - 0.5) * 0.03,
            vy: (Math.random() - 0.5) * 0.03,
            a: 0.075 + Math.random() * 0.035,
            tint: NEBULA_TINTS[i % NEBULA_TINTS.length],
            /* phase + spin → каждая «галактика» вращается со своим ритмом,
               силуэт лениво «дышит». */
            phase: Math.random() * Math.PI * 2,
            spin: (Math.random() < 0.5 ? -1 : 1) * (0.018 + Math.random() * 0.018),
        });
    }
    _seedStars(70);
}

function resizeNebula(ratioX, ratioY) {
    const w = window.innerWidth;
    const h = window.innerHeight;
    blobs.forEach(b => {
        if (ratioX && ratioX !== 1) b.x *= ratioX;
        if (ratioY && ratioY !== 1) b.y *= ratioY;
        b.x = Math.min(Math.max(0, b.x), w);
        b.y = Math.min(Math.max(0, b.y), h);
    });
}

function frameNebula(t) {
    const w = window.innerWidth;
    const h = window.innerHeight;
    ctx.clearRect(0, 0, w, h);
    ctx.globalCompositeOperation = "screen";
    blobs.forEach(b => {
        b.x += b.vx;
        b.y += b.vy;
        if (b.x < -b.r) b.x = w + b.r;
        if (b.x > w + b.r) b.x = -b.r;
        if (b.y < -b.r) b.y = h + b.r;
        if (b.y > h + b.r) b.y = -b.r;

        /* Три смещённые «доли». Каждая на ~55% альфы — суммарно ≈ исходная,
           но контур получается неправильный. */
        const orbit = b.r * 0.22;
        const subR = b.r * 0.78;
        const subA = b.a * 0.55;
        for (let i = 0; i < 3; i++) {
            const angle = b.phase + (i / 3) * Math.PI * 2 + t * b.spin;
            const ox = Math.cos(angle) * orbit;
            const oy = Math.sin(angle) * orbit;
            ctx.fillStyle = smoothRadialGradient(
                ctx, b.x + ox, b.y + oy, subR, b.tint, subA, 12, 4
            );
            ctx.fillRect(0, 0, w, h);
        }
    });
    ctx.globalCompositeOperation = "source-over";

    _drawStars(t);
}

/* ===== VOID-GRID =====
   - Точечная сетка с радиальной маской: плотная у центра, угасает к краям.
     Per-frame draw (не offscreen-спрайт) — нужен для hover-эффекта.
   - Центр сетки и глоу совпадают с центром `.users-area` (participant ripple) —
     визуальная привязка, а не геометрический центр окна. Если элемента нет —
     fallback на центр экрана со сдвигом на 2 шага сетки вверх.
   - Центральный глоу: 3 наложенных radial-gradient, 12 стопов с easing →
     никаких ступеней. Альфы умеренные (≈ половина от прошлой версии).
   - Hover: точки в радиусе курсора плавно теплеют, ярчеют и приподнимаются.
*/

/** Находит точку, в которой центрируется и сетка, и глоу. */
function _getGridCenter() {
    const el = document.querySelector(".users-area");
    if (el) {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) {
            return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
        }
    }
    /* Фоллбэк: центр экрана, сдвинутый на два шага сетки вверх — на момент
       первой инициализации DOM ripple-элемента может ещё не быть. */
    return { x: window.innerWidth / 2, y: window.innerHeight / 2 - GRID_DOT_STEP * 2 };
}

function _rebuildGridDots() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const { x: cx, y: cy } = _getGridCenter();
    _gridGlowCx = cx;
    _gridGlowCy = cy;

    /* Радиус маски — до самого дальнего угла относительно центра сетки. */
    const maxR = Math.hypot(
        Math.max(cx, w - cx),
        Math.max(cy, h - cy)
    );

    _gridDots = [];
    /* Якоримся к (cx, cy), чтобы сетка была симметричной относительно центра.
       Модулёвый трюк (+STEP)%STEP — корректно работает и при cx<0. */
    const x0 = ((cx % GRID_DOT_STEP) + GRID_DOT_STEP) % GRID_DOT_STEP;
    const y0 = ((cy % GRID_DOT_STEP) + GRID_DOT_STEP) % GRID_DOT_STEP;
    for (let y = y0; y < h; y += GRID_DOT_STEP) {
        for (let x = x0; x < w; x += GRID_DOT_STEP) {
            const d = Math.hypot(x - cx, y - cy) / maxR;
            if (d >= 1) continue;
            /* Плотный центр, мягкий выход к краю; макс альфа 0.20. */
            const a = Math.pow(1 - d, 3.2) * 0.20;
            if (a < 0.004) continue;
            _gridDots.push({ x, y, a });
        }
    }
}

function setupGrid() {
    /* Звёзд тут нет — гасим star-canvas. */
    _stars = [];
    if (_starsCtx) {
        _starsCtx.clearRect(0, 0, window.innerWidth, window.innerHeight);
    }
    _rebuildGridDots();

    /* Hover-handler ставим только пока активна эта тема. mousemove на window
       летит независимо от того, что под курсором (canvas → pointer-events:none,
       но события всё равно идут на верхние элементы и всплывают). */
    _hoverX = -1;
    _hoverY = -1;
    _gridMoveHandler = (e) => {
        _hoverX = e.clientX;
        _hoverY = e.clientY;
    };
    _gridLeaveHandler = (e) => {
        /* mouseout с relatedTarget != null — это переход между элементами
           ВНУТРИ страницы, hover не сбрасываем. Только null/window.blur
           означают «курсор покинул окно». */
        if (e && e.type === "mouseout" && e.relatedTarget !== null) return;
        _hoverX = -1;
        _hoverY = -1;
    };
    window.addEventListener("mousemove", _gridMoveHandler, { passive: true });
    document.addEventListener("mouseout", _gridLeaveHandler, { passive: true });
    window.addEventListener("blur", _gridLeaveHandler, { passive: true });
}

function teardownGrid() {
    if (_gridMoveHandler) {
        window.removeEventListener("mousemove", _gridMoveHandler);
        document.removeEventListener("mouseout", _gridLeaveHandler);
        window.removeEventListener("blur", _gridLeaveHandler);
        _gridMoveHandler = null;
        _gridLeaveHandler = null;
    }
    _hoverX = -1;
    _hoverY = -1;
}

function resizeGrid() {
    _rebuildGridDots();
}

function frameGrid(t) {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const cx = _gridGlowCx;
    const cy = _gridGlowCy;

    ctx.clearRect(0, 0, w, h);

    /* Per-frame draw сетки с модуляцией от курсора. */
    const hoverActive = _hoverX >= 0 && _hoverY >= 0;
    const baseR = GRID_DOT_BASE_RGB[0];
    const baseG = GRID_DOT_BASE_RGB[1];
    const baseB = GRID_DOT_BASE_RGB[2];
    const hoverDR = GRID_DOT_HOVER_RGB[0] - baseR;
    const hoverDG = GRID_DOT_HOVER_RGB[1] - baseG;
    const hoverDB = GRID_DOT_HOVER_RGB[2] - baseB;

    for (let i = 0; i < _gridDots.length; i++) {
        const d = _gridDots[i];
        let alpha = d.a;
        let yOff = 0;
        let r = baseR, g = baseG, bl = baseB;

        if (hoverActive) {
            const dx = d.x - _hoverX;
            const dy = d.y - _hoverY;
            const dist2 = dx * dx + dy * dy;
            if (dist2 < GRID_HOVER_RADIUS_SQ) {
                const falloff = 1 - Math.sqrt(dist2) / GRID_HOVER_RADIUS;
                /* smoothstep-ish: квадрат для более «мягкой» зоны действия. */
                const eased = falloff * falloff;
                alpha = d.a * (1 + GRID_HOVER_ALPHA_BOOST * eased);
                yOff = GRID_HOVER_LIFT * eased;
                r = baseR + hoverDR * eased;
                g = baseG + hoverDG * eased;
                bl = baseB + hoverDB * eased;
            }
        }

        ctx.fillStyle = `rgba(${r | 0},${g | 0},${bl | 0},${alpha.toFixed(3)})`;
        ctx.beginPath();
        ctx.arc(d.x, d.y - yOff, GRID_DOT_RADIUS, 0, Math.PI * 2);
        ctx.fill();
    }

    /* Центральный глоу: 3 слоя, lighter blend. Альфы умеренные (≈ половина
       прошлой версии — менее «яркий» центр). Дыхание ±4 % за ~8 s. */
    const breathe = 1 + Math.sin(t * 0.78) * 0.04;
    const baseRad = Math.min(w, h);

    ctx.globalCompositeOperation = "lighter";

    ctx.fillStyle = smoothRadialGradient(
        ctx, cx, cy, baseRad * 0.55 * breathe,
        [200, 210, 230], 0.045, 12, 3.0
    );
    ctx.fillRect(0, 0, w, h);

    ctx.fillStyle = smoothRadialGradient(
        ctx, cx, cy, baseRad * 0.27 * breathe,
        [235, 225, 210], 0.060, 12, 3.5
    );
    ctx.fillRect(0, 0, w, h);

    ctx.fillStyle = smoothRadialGradient(
        ctx, cx, cy, baseRad * 0.10 * breathe,
        [245, 230, 215], 0.075, 14, 4.0
    );
    ctx.fillRect(0, 0, w, h);

    ctx.globalCompositeOperation = "source-over";
}

/* ===== stars ===== */

function _seedStars(targetAt1080) {
    _stars = [];
    if (!_starsCanvas) {
        _starsCanvas = document.getElementById("background-stars");
        if (_starsCanvas) _starsCtx = _starsCanvas.getContext("2d");
    }
    if (!_starsCanvas) return;
    const target = Math.round(
        targetAt1080 * (window.innerWidth * window.innerHeight) / (1920 * 1080)
    );
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

/* Пропорциональное масштабирование позиций звёзд при resize viewport.
   _seedStars фиксирует координаты один раз — без этого после zoom'а звёзды
   тоже остаются в углу, как блобы. */
function _rescaleStars(ratioX, ratioY) {
    if (!_stars || !_stars.length) return;
    if ((!ratioX || ratioX === 1) && (!ratioY || ratioY === 1)) return;
    const w = window.innerWidth;
    const h = window.innerHeight;
    _stars.forEach(s => {
        if (ratioX && ratioX !== 1) s.x *= ratioX;
        if (ratioY && ratioY !== 1) s.y *= ratioY;
        s.x = Math.min(Math.max(0, s.x), w);
        s.y = Math.min(Math.max(0, s.y), h);
    });
}

function _drawStars(t) {
    if (!_starsCtx || !_stars.length) return;
    const w = window.innerWidth;
    const h = window.innerHeight;
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

/* ===== theme registry ===== */

const THEMES = {
    silence: { setup: setupSilence, frame: frameSilence, resize: resizeSilence },
    nebula:  { setup: setupNebula,  frame: frameNebula,  resize: resizeNebula },
    grid:    { setup: setupGrid,    frame: frameGrid,    resize: resizeGrid, teardown: teardownGrid },
};

const DEFAULT_THEME = "silence";
const CROSSFADE_MS = 280;

function _resolveTheme(name) {
    return THEMES[name] ? name : DEFAULT_THEME;
}

/* Внешний API. Зовётся:
   - один раз из seedBlobs() при инициализации (animate=false);
   - из window-листенера void:bg-theme-changed (animate=true).
   Никакого rAF тут не запускаем — paint() уже вертится, frame подхватит
   новый _theme автоматически. */
function applyBackgroundTheme(name, animate) {
    const next = _resolveTheme(name);
    if (next === _theme && _themeInited) return;

    const html = document.documentElement;
    const doSwap = () => {
        /* Уходящая тема может держать ресурсы (mousemove-handler у grid)
           — отпускаем их ДО смены _theme, чтобы listeners не «протекли». */
        if (_theme && THEMES[_theme]?.teardown) THEMES[_theme].teardown();
        _theme = next;
        html.dataset.bgTheme = next;
        clearAllCanvases();
        THEMES[next].setup();
        _themeInited = true;
    };

    if (!animate || !_themeInited) {
        doSwap();
        return;
    }

    /* Crossfade: на время свопа гасим canvas через CSS (см. .bg-switching).
       После завершения transition'а снимаем класс — новый фон проявляется. */
    html.classList.add("bg-switching");
    setTimeout(() => {
        doSwap();
        /* requestAnimationFrame — даём кадру отрисоваться, прежде чем снять
           класс. Без этого CSS не успевает зафиксировать opacity=0 → новый
           кадр и «возврат к 1» сливаются в один и transition не играет. */
        requestAnimationFrame(() => {
            requestAnimationFrame(() => html.classList.remove("bg-switching"));
        });
    }, CROSSFADE_MS);
}

/* ===== legacy entrypoints (зовут app.js / resize listener) ===== */

function seedBlobs() {
    /* Подхватываем сохранённую тему из настроек. VoidSettings ещё может
       не быть готовым (script-порядок), тогда — дефолт. */
    const saved = window.VoidSettings?.getBgTheme?.();
    applyBackgroundTheme(saved || DEFAULT_THEME, /*animate*/ false);
}

/* === rAF throttle 30fps ===
   rAF без throttle крутится на native refresh монитора (60/144/240Hz).
   Для амбиентного фона с блобами, которые двигаются ~0.05px/frame, разница
   между 30 и 144fps визуально неотличима, а GPU-нагрузка снижается в 5×.
   Особенно критично для nebula (12 full-screen fillRect/frame на screen
   blend mode) — без throttle на 2K-144Hz моник давал ~14 ГИГА pixel-fills/sec
   и подвешивал весь браузер (другие вкладки в воздухе, спиннеры лагают).
   Реализация — gate по wall-clock: рисуем кадр, только если прошло
   >= FRAME_MIN_MS с предыдущего. rAF-цикл сам по себе остаётся: браузеру
   нужен hook для естественной паузы при сворачивании / переходе вкладки. */
const TARGET_FPS = 30;
const FRAME_MIN_MS = 1000 / TARGET_FPS;
let _lastFrameMs = 0;

function paint() {
    if (_rafId !== null) return;          // уже крутимся
    const loop = (now) => {
        if (_canvasPaused) {
            /* Visible-pause: тормозим rAF, но не стопаем — на показ страницы
               вернёмся без переинициализации. */
            setTimeout(() => { _rafId = requestAnimationFrame(loop); }, 200);
            return;
        }
        if (now - _lastFrameMs >= FRAME_MIN_MS) {
            _lastFrameMs = now;
            const t = now * 0.001;
            const handler = _theme ? THEMES[_theme]?.frame : null;
            if (handler) handler(t);
        }
        _rafId = requestAnimationFrame(loop);
    };
    _rafId = requestAnimationFrame(loop);
}

/* ===== события смены темы из настроек ===== */

document.addEventListener("void:bg-theme-changed", (e) => {
    const name = e?.detail?.theme;
    applyBackgroundTheme(name, /*animate*/ true);
});
