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
   mesh       — дрейфующие точки + линии между близкими («сеть узлов»). Перенос
                фона со страницы docs/why-void.html (там — иллюстрация P2P).
                Отличия от оригинала: контраст приглушён (фон не спорит с
                контентом), тёплый акцент линии к курсору убран → нейтральный
                графит. Курсор слегка «притягивает» линии к ближним точкам.
                Без звёзд.

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
let _gridStageRO = null;

/* ===== mesh state =====
   Параметры подобраны под «фоновость»: точки/линии заметно тусклее, чем в
   оригинале на why-void.html (там 0.30 alpha), а линия к курсору — холодный
   графит вместо тёплого песочного (184,122,90). */
const MESH_LINK = 132;                       // CSS-px: дистанция линковки точек
const MESH_LINK_SQ = MESH_LINK * MESH_LINK;
const MESH_MOUSE_LINK = 170;                 // CSS-px: радиус притяжения к курсору
const MESH_MOUSE_LINK_SQ = MESH_MOUSE_LINK * MESH_MOUSE_LINK;
const MESH_DOT_RGB = [142, 145, 156];        // нейтральный графит, без тёплого
const MESH_LINE_RGB = [86, 90, 102];
const MESH_DOT_ALPHA = 0.22;                 // было 0.30 — приглушено «в фон»
const MESH_LINE_ALPHA = 0.16;                // было 0.30
const MESH_MOUSE_ALPHA = 0.16;               // было 0.22 + тёплый → холодный

let _meshDots = [];
let _meshHoverX = -1;
let _meshHoverY = -1;
let _meshMoveHandler = null;
let _meshLeaveHandler = null;

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

/* ===== WEBGL-рендерер блобовых тем =====

   ЗАЧЕМ. Градиент блоба на почти чёрном фоне занимает всего 5-7 градаций
   яркости и растягивает их на полэкрана. В 8 битах это физически не может быть
   гладким: замер живой страницы дал 11 значений альфы и плато шириной до 131
   device-пикселя — те самые террасы. Плёнка шума СВЕРХУ их не лечит: она рвёт
   границу, но не трогает сами ступени (у каждой террасы своё среднее, а глаз
   видит именно среднее). Размытие не лечит по той же причине — после блюра
   результат снова округляется до 8 бит.

   Лечит только дизеринг ДО округления: подмешать в значение шум амплитудой
   в половину градации и лишь потом округлить. Тогда пиксели вокруг порога
   распределяются случайно, локальное среднее сохраняет дробную часть, и
   ступеней не остаётся вовсе. В canvas 2D такое сделать негде — каждая заливка
   сразу попадает в 8-битный буфер. В шейдере — одна строка.

   ЦЕНА. Один полноэкранный проход вместо 12 полноэкранных заливок с blend mode
   (nebula), никаких аллокаций на кадр, контекст без альфы/глубины/стенсила и с
   powerPreference:"low-power" — дискретная карта не будится. По памяти это ровно
   один буфер размером с холст, как и у canvas 2D.

   Рендерим в НАТИВНОМ dpr (в отличие от 2D-пути с его cap 1.5): дизер обязан
   ложиться на реальные пиксели экрана. При масштабировании 1.5→2 компоновщик
   усреднил бы соседние значения и съел бы половину эффекта.

   Фолбэк. Нет WebGL (старая машина, блоклист драйвера, потеря контекста) —
   молча возвращаемся на прежний canvas-путь: он рабочий, просто с полосами. */

const GL_THEMES = new Set(["silence", "nebula"]);
const GL_MAX_LOBES = 16;

let _glCanvas = null;
let _glR = null;          // рендерер или null, если WebGL недоступен
let _glTried = false;

const GL_VERT = `
attribute vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }
`;

const GL_FRAG = `
precision highp float;
uniform vec2  uRes;                    // размер холста в device-пикселях
uniform vec3  uBase;                   // цвет фона (--bg-0)
uniform int   uCount;                  // сколько долей рисуем
uniform int   uScreen;                 // 1 = screen-накопление (nebula), 0 = аддитивное
uniform float uFall;                   // показатель спада (1.4 silence / 4.0 nebula)
uniform vec4  uLobe[${GL_MAX_LOBES}];  // xy — центр, z — радиус, w — альфа
uniform vec3  uTint[${GL_MAX_LOBES}];  // цвет доли, 0..1
uniform vec2  uVig;                    // виньетка: начало (0..1) и сила

/* Дизер: равномерный шум ±полградации ПЕРЕД округлением до 8 бит. Статичный
   по экрану (без времени) — иначе зерно ползло бы между кадрами. */
float hash(vec2 p) {
    return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
}

void main() {
    /* gl_FragCoord считает снизу вверх, координаты блобов — сверху вниз. */
    vec2 fc = vec2(gl_FragCoord.x, uRes.y - gl_FragCoord.y);

    vec3 acc = vec3(0.0);
    for (int i = 0; i < ${GL_MAX_LOBES}; i++) {
        if (i >= uCount) break;
        vec4 L = uLobe[i];
        float t = clamp(distance(fc, L.xy) / L.z, 0.0, 1.0);
        vec3 c = uTint[i] * (pow(1.0 - t, uFall) * L.w);
        acc = (uScreen == 1) ? (acc + c - acc * c) : (acc + c);
    }

    vec3 col = uBase + acc;

    /* Виньетка считается здесь же, а не слоем CSS сверху: у неё те же 5 градаций
       на полэкрана, и отдельным слоем она получила бы собственные террасы уже
       после нашего дизера. Эллипс 120%×80% от центра — форма как у прежнего
       radial-gradient, спад квадратичный. */
    vec2 q = (fc - 0.5 * uRes) / vec2(1.2 * uRes.x, 0.8 * uRes.y);
    float v = clamp((length(q) - uVig.x) / max(1.0 - uVig.x, 0.001), 0.0, 1.0);
    col *= 1.0 - uVig.y * v * v;

    col += (hash(fc) - 0.5) / 255.0;
    gl_FragColor = vec4(col, 1.0);
}
`;

function _glCompile(gl, type, src) {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
        const err = gl.getShaderInfoLog(sh);
        gl.deleteShader(sh);
        throw new Error(err || "shader compile failed");
    }
    return sh;
}

/** Поднять WebGL один раз. Вернёт рендерер или null — тогда работает 2D-путь. */
function _glInit() {
    if (_glTried) return _glR;
    _glTried = true;
    _glCanvas = document.getElementById("background-gl");
    if (!_glCanvas) return null;

    let gl = null;
    try {
        const opts = {
            alpha: false,          // непрозрачный холст: фон рисуем сами, и
                                   // композитор не переквантует наши значения
            antialias: false, depth: false, stencil: false,
            preserveDrawingBuffer: false,
            powerPreference: "low-power",
            desynchronized: true
        };
        gl = _glCanvas.getContext("webgl", opts) || _glCanvas.getContext("experimental-webgl", opts);
    } catch (_) { gl = null; }
    if (!gl) return null;

    let prog;
    try {
        prog = gl.createProgram();
        gl.attachShader(prog, _glCompile(gl, gl.VERTEX_SHADER, GL_VERT));
        gl.attachShader(prog, _glCompile(gl, gl.FRAGMENT_SHADER, GL_FRAG));
        gl.linkProgram(prog);
        if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
            throw new Error(gl.getProgramInfoLog(prog) || "link failed");
        }
    } catch (err) {
        if (window.log?.warn) log.warn("bg", "webgl unavailable, falling back to 2d", { err: err.message });
        return null;
    }

    gl.useProgram(prog);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    /* Два треугольника на весь клип — вся геометрия сцены. */
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 3,-1, -1,3]), gl.STATIC_DRAW);
    const aPos = gl.getAttribLocation(prog, "aPos");
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

    const u = {};
    for (const n of ["uRes", "uBase", "uCount", "uScreen", "uFall", "uLobe", "uTint", "uVig"]) {
        u[n] = gl.getUniformLocation(prog, n);
    }

    /* Потеря контекста (сон машины, сброс драйвера): гасим рендерер и уходим на
       2D-путь, чтобы фон не превратился в чёрный прямоугольник. */
    _glCanvas.addEventListener("webglcontextlost", (e) => {
        e.preventDefault();
        _glR = null;
        _glCanvas.style.display = "none";
        document.documentElement.removeAttribute("data-bg-gl");
    }, { passive: false });

    const lobes = new Float32Array(GL_MAX_LOBES * 4);
    const tints = new Float32Array(GL_MAX_LOBES * 3);

    _glR = {
        gl,
        /* Виньетка: начало спада (доля радиуса) и сила — синхронно с прежним
           CSS-градиентом в base.css. */
        vig: [0.40, 0.55],
        resize() {
            const dpr = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
            const w = Math.round(window.innerWidth * dpr);
            const h = Math.round(window.innerHeight * dpr);
            if (_glCanvas.width !== w || _glCanvas.height !== h) {
                _glCanvas.width = w;
                _glCanvas.height = h;
                gl.viewport(0, 0, w, h);
            }
            _glCanvas.style.width = window.innerWidth + "px";
            _glCanvas.style.height = window.innerHeight + "px";
            this.dpr = dpr;
        },
        /** list: [{x, y, r, a, tint}] в CSS-пикселях. */
        draw(list, fall, screenBlend) {
            const n = Math.min(list.length, GL_MAX_LOBES);
            const d = this.dpr || 1;
            for (let i = 0; i < n; i++) {
                const L = list[i];
                lobes[i*4]   = L.x * d;
                lobes[i*4+1] = L.y * d;
                lobes[i*4+2] = L.r * d;
                lobes[i*4+3] = L.a;
                tints[i*3]   = L.tint[0] / 255;
                tints[i*3+1] = L.tint[1] / 255;
                tints[i*3+2] = L.tint[2] / 255;
            }
            gl.uniform2f(u.uRes, _glCanvas.width, _glCanvas.height);
            gl.uniform3f(u.uBase, 10/255, 10/255, 11/255);   // --bg-0 #0a0a0b
            gl.uniform1i(u.uCount, n);
            gl.uniform1i(u.uScreen, screenBlend ? 1 : 0);
            gl.uniform1f(u.uFall, fall);
            gl.uniform2f(u.uVig, this.vig[0], this.vig[1]);
            gl.uniform4fv(u.uLobe, lobes);
            gl.uniform3fv(u.uTint, tints);
            gl.drawArrays(gl.TRIANGLES, 0, 3);
        }
    };
    _glR.resize();
    return _glR;
}

/** Активен ли GL для текущей темы. */
function _glActive() {
    return !!(_glR && _theme && GL_THEMES.has(_theme));
}

/* Дрейф блобов с заворотом по краям — общий для обоих путей рендера. */
function _driftBlobs() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    for (const b of blobs) {
        b.x += b.vx;
        b.y += b.vy;
        if (b.x < -b.r) b.x = w + b.r;
        if (b.x > w + b.r) b.x = -b.r;
        if (b.y < -b.r) b.y = h + b.r;
        if (b.y > h + b.r) b.y = -b.r;
    }
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

    if (_glR) _glR.resize();

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

const SILENCE_FALLOFF = 1.4;

function frameSilence(t) {
    const w = window.innerWidth;
    const h = window.innerHeight;
    _driftBlobs();

    if (_glActive()) {
        _glR.draw(blobs, SILENCE_FALLOFF, /*screenBlend*/ false);
        _drawStars(t);
        return;
    }

    ctx.clearRect(0, 0, w, h);
    ctx.globalCompositeOperation = "lighter";
    blobs.forEach(b => {
        /* 16 стопов с плавным falloff вместо прежних четырёх (0 / .35 / .7 / 1).
           Между стопами браузер интерполирует ЛИНЕЙНО, поэтому на каждом стопе
           излом наклона — а на градиенте шириной в пол-экрана и высотой всего в
           5-6 градаций яркости излом читается как чёткое кольцо. Это и была
           «лесенка»: не сглаживание и не retina, а геометрия градиента (nebula
           это уже прошла — см. smoothRadialGradient).
           Показатель 1.4 подобран так, чтобы кривая совпала со старой
           (0.65^1.4 ≈ 0.55, 0.3^1.4 ≈ 0.19) — вид блоба не меняется, уходят
           только изломы. */
        ctx.fillStyle = smoothRadialGradient(ctx, b.x, b.y, b.r, b.tint, b.a, 16, SILENCE_FALLOFF);
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

const NEBULA_FALLOFF = 4;

/* Три смещённые «доли» блоба на текущий момент времени. Каждая на ~55% альфы —
   суммарно ≈ исходная, но контур получается неправильный, «галактический».
   Общий источник геометрии для обоих путей рендера. */
function _nebulaLobes(t) {
    const out = [];
    for (const b of blobs) {
        const orbit = b.r * 0.22;
        for (let i = 0; i < 3; i++) {
            const angle = b.phase + (i / 3) * Math.PI * 2 + t * b.spin;
            out.push({
                x: b.x + Math.cos(angle) * orbit,
                y: b.y + Math.sin(angle) * orbit,
                r: b.r * 0.78,
                a: b.a * 0.55,
                tint: b.tint
            });
        }
    }
    return out;
}

function frameNebula(t) {
    const w = window.innerWidth;
    const h = window.innerHeight;
    _driftBlobs();
    const lobes = _nebulaLobes(t);

    if (_glActive()) {
        _glR.draw(lobes, NEBULA_FALLOFF, /*screenBlend*/ true);
        _drawStars(t);
        return;
    }

    ctx.clearRect(0, 0, w, h);
    ctx.globalCompositeOperation = "screen";
    for (const L of lobes) {
        ctx.fillStyle = smoothRadialGradient(ctx, L.x, L.y, L.r, L.tint, L.a, 12, NEBULA_FALLOFF);
        ctx.fillRect(0, 0, w, h);
    }
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

/* Центр сетки = центр `.users-area` (блоба). Он съезжает не только при resize
   окна (это ловит sizeCanvas→resizeGrid), но и при ЛЮБОМ изменении геометрии
   стейджа: открытие/закрытие чата (padding-right у .stage), позднее применение
   --ui-scale из настроек, загрузка шрифтов, смена режима. Чтобы сетка держалась
   под блобом пиксель-в-пиксель в любом состоянии — наблюдаем .stage одним
   ResizeObserver'ом и пересобираем точки на каждое его изменение. Раньше сетка
   собиралась один раз на init и устаревала → блоб уезжал на пару px. */
function recenterGrid() {
    if (_theme === "grid") _rebuildGridDots();
}

function _observeStageForGrid() {
    if (_gridStageRO || typeof ResizeObserver === "undefined") return;
    const stage = document.querySelector(".stage");
    if (!stage) return;
    _gridStageRO = new ResizeObserver(() => recenterGrid());
    _gridStageRO.observe(stage);
}

function setupGrid() {
    /* Звёзд тут нет — гасим star-canvas. */
    _stars = [];
    if (_starsCtx) {
        _starsCtx.clearRect(0, 0, window.innerWidth, window.innerHeight);
    }
    _rebuildGridDots();
    _observeStageForGrid();

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
    if (_gridStageRO) {
        _gridStageRO.disconnect();
        _gridStageRO = null;
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

/* ===== MESH =====
   Дрейфующие точки + линии между близкими. Линии рисуем ДО точек, чтобы узлы
   лежали поверх связей. Hover как у grid: курсор тянет линии к ближним точкам.
   Кол-во точек кап 64 (O(n²) линковка → держим дёшево, как в оригинале). */

function _seedMeshDots() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const target = Math.min(64, Math.round((w * h) / 26000));
    _meshDots = [];
    for (let i = 0; i < target; i++) {
        _meshDots.push({
            x: Math.random() * w,
            y: Math.random() * h,
            vx: (Math.random() - 0.5) * 0.12,
            vy: (Math.random() - 0.5) * 0.12,
            r: Math.random() * 0.9 + 0.6,
        });
    }
}

function setupMesh() {
    /* Звёзд тут нет — гасим star-canvas (как grid). */
    _stars = [];
    if (_starsCtx) {
        _starsCtx.clearRect(0, 0, window.innerWidth, window.innerHeight);
    }
    _seedMeshDots();

    /* Hover-handler ставим только пока активна тема (см. grid — те же причины:
       mousemove на window всплывает поверх canvas pointer-events:none). */
    _meshHoverX = -1;
    _meshHoverY = -1;
    _meshMoveHandler = (e) => {
        _meshHoverX = e.clientX;
        _meshHoverY = e.clientY;
    };
    _meshLeaveHandler = (e) => {
        if (e && e.type === "mouseout" && e.relatedTarget !== null) return;
        _meshHoverX = -1;
        _meshHoverY = -1;
    };
    window.addEventListener("mousemove", _meshMoveHandler, { passive: true });
    document.addEventListener("mouseout", _meshLeaveHandler, { passive: true });
    window.addEventListener("blur", _meshLeaveHandler, { passive: true });
}

function teardownMesh() {
    if (_meshMoveHandler) {
        window.removeEventListener("mousemove", _meshMoveHandler);
        document.removeEventListener("mouseout", _meshLeaveHandler);
        window.removeEventListener("blur", _meshLeaveHandler);
        _meshMoveHandler = null;
        _meshLeaveHandler = null;
    }
    _meshHoverX = -1;
    _meshHoverY = -1;
}

function resizeMesh(ratioX, ratioY) {
    const w = window.innerWidth;
    const h = window.innerHeight;
    _meshDots.forEach(d => {
        if (ratioX && ratioX !== 1) d.x *= ratioX;
        if (ratioY && ratioY !== 1) d.y *= ratioY;
        d.x = Math.min(Math.max(0, d.x), w);
        d.y = Math.min(Math.max(0, d.y), h);
    });
}

function frameMesh() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    ctx.clearRect(0, 0, w, h);

    const dots = _meshDots;
    const n = dots.length;

    /* drift + wrap по краям */
    for (let i = 0; i < n; i++) {
        const d = dots[i];
        d.x += d.vx;
        d.y += d.vy;
        if (d.x < 0) d.x += w; else if (d.x > w) d.x -= w;
        if (d.y < 0) d.y += h; else if (d.y > h) d.y -= h;
    }

    const hoverActive = _meshHoverX >= 0 && _meshHoverY >= 0;
    const [lr, lg, lb] = MESH_LINE_RGB;
    const [dr, dg, db] = MESH_DOT_RGB;
    ctx.lineWidth = 1;

    /* линии: к курсору (нейтральный графит) + между близкими точками */
    for (let i = 0; i < n; i++) {
        const d = dots[i];

        if (hoverActive) {
            const mdx = d.x - _meshHoverX;
            const mdy = d.y - _meshHoverY;
            const md2 = mdx * mdx + mdy * mdy;
            if (md2 < MESH_MOUSE_LINK_SQ) {
                const a = MESH_MOUSE_ALPHA * (1 - Math.sqrt(md2) / MESH_MOUSE_LINK);
                ctx.strokeStyle = `rgba(${dr},${dg},${db},${a.toFixed(3)})`;
                ctx.beginPath();
                ctx.moveTo(d.x, d.y);
                ctx.lineTo(_meshHoverX, _meshHoverY);
                ctx.stroke();
            }
        }

        for (let j = i + 1; j < n; j++) {
            const e = dots[j];
            const dx = d.x - e.x;
            const dy = d.y - e.y;
            const dist2 = dx * dx + dy * dy;
            if (dist2 < MESH_LINK_SQ) {
                const a = MESH_LINE_ALPHA * (1 - Math.sqrt(dist2) / MESH_LINK);
                ctx.strokeStyle = `rgba(${lr},${lg},${lb},${a.toFixed(3)})`;
                ctx.beginPath();
                ctx.moveTo(d.x, d.y);
                ctx.lineTo(e.x, e.y);
                ctx.stroke();
            }
        }
    }

    /* точки поверх линий — одна alpha на всех, fillStyle ставим раз */
    ctx.fillStyle = `rgba(${dr},${dg},${db},${MESH_DOT_ALPHA})`;
    for (let i = 0; i < n; i++) {
        const d = dots[i];
        ctx.beginPath();
        ctx.arc(d.x, d.y, d.r, 0, Math.PI * 2);
        ctx.fill();
    }
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
    /* mesh — нативный rAF (fps:60 → без 30fps-гейта): интерактивная и лёгкая,
       плавность движения курсора важнее экономии (≈64 точки, дёшево). Скорость
       дрейфа ±0.12px/кадр рассчитана именно на 60fps — как в оригинале. */
    mesh:    { setup: setupMesh,    frame: frameMesh,    resize: resizeMesh, teardown: teardownMesh, fps: 60 },
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

    /* GL поднимаем лениво — только когда впервые понадобилась блобовая тема.
       На grid/mesh контекст вообще не создаётся. */
    const wantGl = GL_THEMES.has(next);
    if (wantGl && !_glTried) _glInit();

    const doSwap = () => {
        /* Уходящая тема может держать ресурсы (mousemove-handler у grid)
           — отпускаем их ДО смены _theme, чтобы listeners не «протекли». */
        if (_theme && THEMES[_theme]?.teardown) THEMES[_theme].teardown();
        _theme = next;
        html.dataset.bgTheme = next;
        clearAllCanvases();
        THEMES[next].setup();
        _themeInited = true;

        /* GL-холст непрозрачный и рисует фон целиком, вместе с виньеткой —
           поэтому на блобовых темах прячем CSS-виньетку (иначе она легла бы
           вторым слоем поверх уже отдизеренного кадра и вернула бы свои
           ступени). На grid/mesh всё наоборот: холст прячем, виньетку
           возвращаем. */
        const glOn = !!_glR && wantGl;
        if (_glCanvas) _glCanvas.style.display = glOn ? "block" : "none";
        if (glOn) {
            _glR.resize();
            html.dataset.bgGl = "1";
        } else {
            delete html.dataset.bgGl;
        }
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
   нужен hook для естественной паузы при сворачивании / переходе вкладки.

   Per-theme override: тема может объявить `fps` в реестре. 30fps — компромисс
   для «ленивых» блобных тем (silence/nebula), где дрейф ~0.05px/frame и разница
   с 60 неразличима. Но mesh интерактивна (линии тянутся за курсором) и лёгкая —
   на 30fps движение курсора заметно «степпит» рядом с нативным оригиналом.
   fps>=60 → не гейтим вовсе, отдаём нативный rAF (на 60Гц мониторе gate 16.6мс
   против ~16.6мс интервала rAF из-за дрожания таймера ронял бы до 30). */
const TARGET_FPS = 30;
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
        const cap = (_theme && THEMES[_theme]?.fps) || TARGET_FPS;
        /* cap>=60 → нативный rAF без гейта (плавность), иначе wall-clock gate. */
        if (cap >= 60 || now - _lastFrameMs >= 1000 / cap) {
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
