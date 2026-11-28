/* ========= CAMERA GRID MATH — tasks/camera-plan.md §5 =========

   Чистая геометрия сцены камер (без DOM): js/cam-stage.js зовёт её на каждую
   раскладку, tests/unit/cam-grid.test.mjs гоняет в node через vm.
   Решения из лабы (public/lab/cameras.html, 2026-11-27):
   - равная сетка: перебор числа колонок, максимум площади плитки при заданном
     соотношении; неполный последний ряд — по центру; 3 камеры — 2 + 1;
   - фокус: одна большая + миниатюры под ней. Десктоп — всегда один ряд
     миниатюр («поезд», мельчает под большой плиткой), узкий экран — ряды
     квадратных миниатюр не уже minW. Размеры решаются точно: при c колонках
     высота «большая + миниатюры» линейна по ширине большой.
   Координаты — px относительно области (0,0 = её левый верх). */
(function (root) {
    "use strict";

    function fitGrid(n, W, H, g, ar) {
        let best = null;
        const maxCols = n === 3 ? 2 : n;          // 3 камеры: 2 + 1, не полоса из трёх
        for (let cols = 1; cols <= maxCols; cols++) {
            const rows = Math.ceil(n / cols);
            const w = Math.min((W - g * (cols - 1)) / cols, ((H - g * (rows - 1)) / rows) * ar);
            if (w <= 0) continue;
            if (!best || w > best.w + 0.5) best = { cols, rows, w, h: w / ar };
        }
        return best;
    }

    /**
     * @param {number} n        число плиток
     * @param {number} W,H      область, px
     * @param {object} o        { gap, rem, ar=16/9, focusIdx=null, nick=0 }
     *   nick — высота строки ника под миниатюрой (тач: ники видны всегда)
     * @returns {{x,y,w,h}[]}   по плитке на индекс, порядок как во входе
     */
    function layout(n, W, H, o) {
        const out = [];
        if (!n || W <= 0 || H <= 0) return out;
        const g = o.gap || 0;
        const ar = o.ar || 16 / 9;
        const rem = o.rem || 14;

        if (o.focusIdx != null && o.focusIdx >= 0 && o.focusIdx < n && n > 1) {
            const k = n - 1;
            const narrow = W < 40 * rem;
            const minW = 3.5 * rem;
            const maxSh = Math.max(4.3 * rem, Math.min(H * 0.2, 9 * rem));
            const nk = o.nick || 0;
            let best = null;
            for (let c = k; c >= (narrow ? 1 : k); c--) {
                const rows = Math.ceil(k / c);
                const Hn = H - rows * nk;
                let bw = (Hn - rows * g + rows * (c - 1) * g / (c * ar)) * ar / (1 + rows / c);
                bw = Math.min(W, bw);
                let sw = (bw - (c - 1) * g) / c, sh = sw / ar;
                if (sh > maxSh) {
                    sh = maxSh; sw = sh * ar;
                    bw = Math.min(W, (Hn - g - rows * sh - (rows - 1) * g) * ar);
                }
                if (narrow && sw < minW && c > 1) continue;
                if (!best || bw > best.bw + 0.5) best = { c, rows, bw, sw, sh };
            }
            if (!best || best.bw <= 0) return out;
            const { c: cols, rows, sw, sh, bw } = best;
            const bh = bw / ar;
            const big = { x: (W - bw) / 2, y: 0, w: bw, h: bh };
            let j = 0;
            for (let i = 0; i < n; i++) {
                if (i === o.focusIdx) { out.push(big); continue; }
                const r = Math.floor(j / cols), c = j % cols;
                const inRow = r === rows - 1 ? k - r * cols : cols;
                const rx = (W - (inRow * sw + (inRow - 1) * g)) / 2;
                out.push({ x: rx + c * (sw + g), y: bh + g + r * (sh + nk + g), w: sw, h: sh });
                j++;
            }
            return out;
        }

        const eq = fitGrid(n, W, H, g, ar);
        if (!eq) return out;
        const { cols, rows, w, h } = eq;
        const bw = cols * w + (cols - 1) * g;
        const ox = (W - bw) / 2;
        for (let i = 0; i < n; i++) {
            const r = Math.floor(i / cols), c = i % cols;
            const inRow = r === rows - 1 ? n - r * cols : cols;
            const rx = ox + (bw - (inRow * w + (inRow - 1) * g)) / 2;   // неполный ряд — по центру
            out.push({ x: rx + c * (w + g), y: r * (h + g), w, h });
        }
        return out;
    }

    root.VoidCamGrid = { layout };
})(typeof window !== "undefined" ? window : globalThis);
