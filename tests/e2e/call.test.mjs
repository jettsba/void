/* Сквозной smoke: настоящий сервер + два/три Chromium с фейковым микрофоном.
 * Ловит то, что не видно unit-тестам: perfect negotiation, звук реально идёт,
 * код безопасности совпал у обоих, закрытая комната не пускает постороннего.
 *
 *   npm run test:e2e
 *   E2E_SHOTS=/tmp/void-shots npm run test:e2e   — плюс скриншоты UI
 *
 * Нужен установленный Chromium для Playwright: `npx playwright install chromium`.
 *
 *   E2E_SYNTH_MIC=1 npm run test:e2e   — микрофон из генератора Web Audio вместо
 *   фейкового устройства Chromium. На macOS без доступа терминала к микрофону
 *   getUserMedia в headless-Chromium просто висит даже с fake-device.
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

async function openClient(name, ctxOptions = {}) {
    const ctx = await browser.newContext({ permissions: ["microphone"], viewport: { width: 1280, height: 800 }, ...ctxOptions });
    if (process.env.E2E_SYNTH_MIC === "1") {
        await ctx.addInitScript(() => {
            const real = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
            navigator.mediaDevices.getUserMedia = async (c) => {
                if (c && c.video) return real(c);
                const ac = new AudioContext();
                const osc = ac.createOscillator();
                const dst = ac.createMediaStreamDestination();
                osc.connect(dst);
                osc.start();
                return dst.stream;
            };
        });
    }
    const page = await ctx.newPage();
    page.on("pageerror", e => console.error(`[${name}] pageerror`, e.message));
    if (ctxOptions.noNavigate) return page;
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

/* Каталог данных общий на все запуски сервера в тесте: в нём лежит секрет
   билетов возврата, и после рестарта сервер должен узнать свои же билеты. */
let dataDir;

async function startServer() {
    server = spawn(process.execPath, ["server.js"], {
        cwd: root,
        env: { ...process.env, PORT: String(PORT), STATS_FILE: join(dataDir, "stats.json"), GEO_DISABLED: "1", LOG_LEVEL: "warn" },
        stdio: ["ignore", "inherit", "inherit"]
    });
    await waitFor(() => fetch(BASE + "/api/version").then(r => r.ok), { what: "server up" });
}

/* Как выкатка: SIGTERM (сервер успевает разослать server-restarting) и новый
   процесс на том же порту. */
async function restartServer() {
    const old = server;
    const exited = new Promise(r => old.once("exit", r));
    old.kill("SIGTERM");
    await exited;
    await startServer();
}

before(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "void-e2e-"));
    await startServer();
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

test("deploy restart: a closed room comes back closed, members return on their own, outsiders stay out", async () => {
    const a = await openClient("A2");
    await a.click("#createBtn");
    const code = await waitFor(() => a.evaluate(() => isJoined && currentRoomCode), { what: "room created" });
    const b = await openClient("B2");
    await joinByCode(b, code);
    await waitFor(() => allConnected(a, 1), { what: "A2 connected" });

    await a.click("#roomInfo");
    await a.click("#roomCloseBtn");
    await waitFor(() => b.evaluate(() => document.querySelectorAll(".room-close-dot.is-voted").length === 1), { what: "B2 sees the vote" });
    await b.evaluate(() => document.getElementById("roomCloseBtn").click());
    await waitFor(() => a.evaluate(() => document.getElementById("roomInfo").classList.contains("is-closed")), { what: "closed" });

    await restartServer();

    // Оба вернулись сами (билет поднимает комнату закрытой, токен — своё место).
    for (const [p, name] of [[a, "A2"], [b, "B2"]]) {
        await waitFor(() => p.evaluate(() => isJoined
            && document.getElementById("connLabel")?.textContent
            && document.getElementById("roomInfo").classList.contains("is-closed")
            && document.getElementById("connDot").classList.contains("live")), { what: `${name} back after restart`, timeout: 30_000 });
    }
    // Разговор не рвался: P2P идёт мимо сервера.
    await waitFor(() => allConnected(a, 1), { what: "A2 still connected to B2" });

    const c = await openClient("C2");
    await joinByCode(c, code);
    const err = await waitFor(() => c.evaluate(() => {
        const el = document.getElementById("entryErrorText");
        return !isJoined && el && el.textContent;
    }), { what: "outsider rejected after restart" });
    assert.match(err, /закрыт|closed/);
});

test("invite link on a phone asks before joining; no mic, no join until the click", async () => {
    const a = await openClient("A3");
    await a.click("#createBtn");
    const code = await waitFor(() => a.evaluate(() => isJoined && currentRoomCode), { what: "room created" });

    const phone = await openClient("phone", { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, noNavigate: true });
    await phone.goto(`${BASE}/?room=${code}`);
    await waitFor(() => phone.evaluate(() => document.querySelector("#inviteBanner .invite-banner-code")?.textContent),
        { what: "confirm banner on the phone" });
    assert.equal(await phone.evaluate(() => document.querySelector("#inviteBanner .invite-banner-code").textContent), code);
    await phone.waitForTimeout(1500);
    assert.deepEqual(await phone.evaluate(() => ({ isJoined, mic: !!localStream })), { isJoined: false, mic: false },
        "nothing happens without the click");

    await phone.click("#inviteBanner .invite-banner-open");
    await waitFor(() => phone.evaluate(() => isJoined && !!localStream), { what: "joined after the click" });
    await waitFor(() => allConnected(a, 1), { what: "A3 sees the phone" });
});
