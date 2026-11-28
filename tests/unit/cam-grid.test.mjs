/* Геометрия сцены камер (public/js/cam-grid.js) — классический скрипт
   браузера, гоняем его в изолированном vm-контексте. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const src = readFileSync(new URL("../../public/js/cam-grid.js", import.meta.url), "utf8");
const ctx = {};
vm.runInNewContext(src, ctx);
const { layout } = ctx.VoidCamGrid;
const REM = 14;
const o = (extra = {}) => ({ gap: 0.45 * REM, rem: REM, ...extra });

const overlaps = (a, b) => a.x < b.x + b.w - 0.5 && b.x < a.x + a.w - 0.5 && a.y < b.y + b.h - 0.5 && b.y < a.y + a.h - 0.5;
function sane(rects, W, H) {
    for (const r of rects) {
        assert.ok(r.w > 0 && r.h > 0, "positive size");
        assert.ok(r.x >= -0.5 && r.y >= -0.5 && r.x + r.w <= W + 0.5 && r.y + r.h <= H + 0.5, `inside ${JSON.stringify(r)}`);
    }
    for (let i = 0; i < rects.length; i++)
        for (let j = i + 1; j < rects.length; j++)
            assert.ok(!overlaps(rects[i], rects[j]), `tiles ${i} and ${j} overlap`);
}

test("cam grid: 1..10 tiles fit, never overlap, keep 16:9", () => {
    for (const [W, H] of [[1400, 620], [900, 500], [600, 900], [360, 520]]) {
        for (let n = 1; n <= 10; n++) {
            const r = layout(n, W, H, o());
            assert.equal(r.length, n);
            sane(r, W, H);
            for (const t of r) assert.ok(Math.abs(t.w / t.h - 16 / 9) < 0.01);
        }
    }
});

test("cam grid: 3 cameras are two rows (2 + 1), the lone one centred", () => {
    const W = 1400, H = 700;
    const r = layout(3, W, H, o());
    assert.equal(r[0].y, r[1].y);
    assert.ok(r[2].y > r[0].y, "third goes to the second row");
    assert.ok(Math.abs((r[2].x + r[2].w / 2) - W / 2) < 1, "incomplete row is centred");
});

test("cam grid: square tiles on a narrow portrait area", () => {
    const r = layout(4, 360, 560, o({ ar: 1 }));
    for (const t of r) assert.ok(Math.abs(t.w - t.h) < 0.01);
    sane(r, 360, 560);
});

test("cam focus: big tile on top, thumbs in one row on desktop, never wider than the big one", () => {
    const W = 1400, H = 650;
    for (let n = 2; n <= 10; n++) {
        const r = layout(n, W, H, o({ focusIdx: 1 }));
        sane(r, W, H);
        const big = r[1];
        const thumbs = r.filter((_, i) => i !== 1);
        assert.ok(thumbs.every(t => t.w < big.w && t.y > big.y), "thumbs are smaller and below");
        assert.equal(new Set(thumbs.map(t => Math.round(t.y))).size, 1, "desktop: one row");
        const span = Math.max(...thumbs.map(t => t.x + t.w)) - Math.min(...thumbs.map(t => t.x));
        assert.ok(span <= big.w + 1, "row not wider than the big tile");
    }
});

test("cam focus: phone wraps thumbs into rows instead of shrinking them to specks", () => {
    const W = 340, H = 560;
    const r = layout(9, W, H, o({ focusIdx: 0, ar: 1, nick: 14 }));
    sane(r, W, H);
    const thumbs = r.slice(1);
    assert.ok(new Set(thumbs.map(t => Math.round(t.y))).size > 1, "more than one row");
    assert.ok(thumbs.every(t => t.w >= 3.5 * REM - 0.5), "thumbs not narrower than 3.5rem");
});

test("cam grid: degenerate input → empty", () => {
    assert.equal(layout(0, 800, 600, o()).length, 0);
    assert.equal(layout(3, 0, 600, o()).length, 0);
});
