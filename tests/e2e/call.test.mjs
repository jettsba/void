/* Сквозной smoke: настоящий сервер + два/три Chromium с фейковым микрофоном.
 * Ловит то, что не видно unit-тестам: perfect negotiation, звук реально идёт,
 * код безопасности совпал у обоих, закрытая комната не пускает постороннего.
 *
 *   npm run test:e2e
 *   E2E_SHOTS=/tmp/void-shots npm run test:e2e   — плюс скриншоты UI
 *
 * Нужен установленный Chromium для Playwright: `npx playwright install chromium`.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";

const PORT = 3000 + Math.floor(Math.random() * 900) + 50;
const BASE = `http://localhost:${PORT}`;
const SHOTS = process.env.E2E_SHOTS || "";
const root = new URL("../../", import.meta.url).pathname;

let server, browser;

async function waitFor(fn, { timeout = 20_000, step = 200, what = "condition" } = {}) {
    const end = Date.now() + timeout;
    let last;
    while (Date.now() < end) {
        try { last = await fn(); if (last) return last; } catch (e) { last = e; }
        await new Promise(r => setTimeout(r, step));
    }
    throw new Error(`timeout waiting for ${what}: ${last instanceof Error ? last.message : JSON.stringify(last)}`);
}

async function openClient(name) {
    const ctx = await browser.newContext({ permissions: ["microphone"], viewport: { width: 1280, height: 800 } });
    const page = await ctx.newPage();
    page.on("pageerror", e => console.error(`[${name}] pageerror`, e.message));
    await page.goto(BASE + "/");
    await page.waitForFunction(() => typeof tryJoin === "function" && document.body.style.opacity === "1");
    return page;
}

async function joinByCode(page, code) {
    await page.fill("#codeInput", code);
    await page.click("#joinBtn");
}

const allConnected = (page, n) => page.evaluate((n) =>
    peers.size === n && [...peers.values()].every(p => p.connectionState === "connected"), n);

async function audioPackets(page) {
    return page.evaluate(async () => {
        let total = 0;
        for (const pc of peers.values()) {
            const stats = await pc.getStats();
            stats.forEach(s => { if (s.type === "inbound-rtp" && s.kind === "audio") total += s.packetsReceived || 0; });
        }
        return total;
    });
}

before(async () => {
    const data = mkdtempSync(join(tmpdir(), "void-e2e-"));
    server = spawn(process.execPath, ["server.js"], {
        cwd: root,
        env: { ...process.env, PORT: String(PORT), STATS_FILE: join(data, "stats.json"), GEO_DISABLED: "1", LOG_LEVEL: "warn" },
        stdio: ["ignore", "inherit", "inherit"]
    });
    await waitFor(() => fetch(BASE + "/api/version").then(r => r.ok), { what: "server up" });
    browser = await chromium.launch({
        args: [
            "--use-fake-ui-for-media-stream",
            "--use-fake-device-for-media-stream",
            // Иначе host-кандидаты прячутся за mDNS-именами, а они на CI не резолвятся.
            "--disable-features=WebRtcHideLocalIpsWithMdns",
            "--autoplay-policy=no-user-gesture-required"
        ]
    });
    if (SHOTS) mkdirSync(SHOTS, { recursive: true });
});

after(async () => {
    await browser?.close();
    server?.kill("SIGTERM");
});

test("two people: call connects, audio flows, security code matches, closed room keeps a third out", async () => {
    const a = await openClient("A");
    await a.click("#createBtn");
    const code = await waitFor(() => a.evaluate(() => isJoined && currentRoomCode), { what: "room created" });

    const b = await openClient("B");
    await joinByCode(b, code);

    await waitFor(() => allConnected(a, 1), { what: "A connected" });
    await waitFor(() => allConnected(b, 1), { what: "B connected" });

    // Звук реально идёт (фейковый микрофон Chromium — непрерывный тон).
    const p0 = await audioPackets(b);
    await waitFor(async () => (await audioPackets(b)) > p0 + 20, { what: "audio packets growing on B" });

    // Код безопасности: готов у обоих и совпадает.
    const sasA = await waitFor(() => a.evaluate(() => VoidSafety.state.state === "ready" && VoidSafety.state.icons), { what: "SAS on A" });
    const sasB = await waitFor(() => b.evaluate(() => VoidSafety.state.state === "ready" && VoidSafety.state.icons), { what: "SAS on B" });
    assert.equal(sasA.length, 5);
    assert.equal(new Set(sasA).size, 5, "symbols never repeat within a code");
    assert.deepEqual(sasA, sasB, "both sides must see the same 5 symbols");

    if (SHOTS) {
        await a.click("#connState");
        await a.waitForTimeout(400);
        await a.screenshot({ path: join(SHOTS, "ping-panel.png") });
        await a.click("#sasRow");
        await a.waitForTimeout(2200);
        await a.screenshot({ path: join(SHOTS, "sas-modal.png") });
        await a.keyboard.press("Escape");
        await a.waitForTimeout(400);
    }

    // Закрываем вход: голосуют оба.
    await a.click("#roomInfo");
    await a.click("#roomCloseBtn");
    await waitFor(() => b.evaluate(() => document.querySelectorAll(".room-close-dot.is-voted").length === 1), { what: "B sees A's vote" });
    if (SHOTS) await a.screenshot({ path: join(SHOTS, "invite-voting.png") });
    await b.evaluate(() => document.getElementById("roomCloseBtn").click());
    await waitFor(() => a.evaluate(() => document.getElementById("roomInfo").classList.contains("is-closed")), { what: "room closed on A" });
    if (SHOTS) await a.screenshot({ path: join(SHOTS, "invite-closed.png") });

    // Посторонний не входит.
    const c = await openClient("C");
    await joinByCode(c, code);
    const err = await waitFor(() => c.evaluate(() => {
        const el = document.getElementById("entryErrorText");
        return !isJoined && el && el.textContent;
    }), { what: "C rejected" });
    assert.match(err, /закрыт|closed/);

    // Открыли — входит.
    await a.evaluate(() => document.getElementById("roomCloseBtn").click());
    await waitFor(() => a.evaluate(() => !document.getElementById("roomInfo").classList.contains("is-closed")), { what: "reopened" });
    await joinByCode(c, code);
    await waitFor(() => allConnected(c, 2), { what: "C connected to both" });

    // Состав сменился → новая эпоха, код снова общий у троих.
    const s3 = await Promise.all([a, b, c].map(p => waitFor(() => p.evaluate(() =>
        VoidSafety.state.state === "ready" && VoidSafety.state.epoch.split(",").length === 3 && VoidSafety.state.icons
    ), { what: "SAS for 3" })));
    assert.deepEqual(s3[0], s3[1]);
    assert.deepEqual(s3[1], s3[2]);
});
