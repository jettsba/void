/* Камеры в звонке (tasks/camera-plan.md): настоящий сервер + Chromium с
 * фейковыми камерой и микрофоном (--use-fake-device-for-media-stream даёт
 * тестовую картинку). Проверяет то, что юнитами не поймать: камера реально
 * идёт и декодируется, вкл/выкл без ренеготиации, поздний вход, камера и
 * демка одновременно, обрыв сигналинга, старый клиент без caps, спрос
 * зрителя (h=0 → энкодер этой пары стоит).
 *
 *   node --test tests/e2e/camera.test.mjs
 *   E2E_SHOTS=/tmp/void-cam npm run test:e2e   — плюс скриншоты сцены
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
const errors = [];

async function waitFor(fn, { timeout = 20_000, step = 200, what = "condition" } = {}) {
    const end = Date.now() + timeout;
    let last;
    while (Date.now() < end) {
        try { last = await fn(); if (last) return last; } catch (e) { last = e; }
        await new Promise(r => setTimeout(r, step));
    }
    throw new Error(`timeout waiting for ${what}: ${last instanceof Error ? last.message : JSON.stringify(last)}`);
}

async function openClient(name, { oldClient = false, viewport = { width: 1280, height: 800 }, ...ctxOptions } = {}) {
    const ctx = await browser.newContext({ permissions: ["microphone", "camera"], viewport, ...ctxOptions });
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
    if (oldClient) {
        /* Клиент до камер: не объявляет caps (как сборка 1.12). */
        await ctx.addInitScript(() => {
            const send = WebSocket.prototype.send;
            WebSocket.prototype.send = function (data) {
                try {
                    const m = JSON.parse(data);
                    if (m && m.type === "join-room-confirm") { delete m.caps; data = JSON.stringify(m); }
                } catch (_) {}
                return send.call(this, data);
            };
        });
    }
    const page = await ctx.newPage();
    page.on("pageerror", e => { errors.push(`[${name}] ${e.message}`); console.error(`[${name}] pageerror`, e.message); });
    await page.goto(BASE + "/");
    await page.waitForFunction(() => typeof tryJoin === "function" && document.body.style.opacity === "1");
    return page;
}

const allConnected = (page, n) => page.evaluate((n) =>
    peers.size === n && [...peers.values()].every(p => p.connectionState === "connected"), n);

/* Сколько кадров камеры этого человека декодировано у нас. */
const camFrames = (page, uid) => page.evaluate(async (uid) => {
    const tr = VoidCam.remoteTrack(uid);
    const pc = peers.get(uid);
    if (!tr || !pc) return -1;
    let n = -1;
    (await pc.getStats()).forEach(s => {
        if (s.type === "inbound-rtp" && s.kind === "video" && s.trackIdentifier === tr.id) n = s.framesDecoded || 0;
    });
    return n;
}, uid);

const tileLive = (page, uid) => page.evaluate((uid) => {
    const t = document.querySelector(`.cam-tile[data-user-id="${uid}"]:not(.is-ghost):not(.is-gone)`);
    const v = t?.querySelector("video");
    return !!(t && v && v.videoWidth > 0 && t.classList.contains("is-live"));
}, uid);

const noTile = (page, uid) => page.evaluate((uid) =>
    !document.querySelector(`.cam-tile[data-user-id="${uid}"]:not(.is-ghost):not(.is-gone)`), uid);

async function room(n, opts = []) {
    const a = await openClient("A", opts[0]);
    await a.click("#createBtn");
    const code = await waitFor(() => a.evaluate(() => isJoined && currentRoomCode), { what: "room created" });
    const pages = [a];
    for (let i = 1; i < n; i++) {
        const p = await openClient(String.fromCharCode(65 + i), opts[i]);
        await p.fill("#codeInput", code);
        await p.click("#joinBtn");
        pages.push(p);
    }
    for (const p of pages) await waitFor(() => allConnected(p, n - 1), { what: "mesh connected", timeout: 30_000 });
    const ids = await Promise.all(pages.map(p => p.evaluate(() => clientId)));
    return { pages, ids, code };
}

before(async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "void-e2e-cam-"));
    server = spawn(process.execPath, ["server.js"], {
        cwd: root,
        env: { ...process.env, PORT: String(PORT), STATS_FILE: join(dataDir, "stats.json"), GEO_DISABLED: "1", LOG_LEVEL: "warn" },
        stdio: ["ignore", "inherit", "inherit"]
    });
    await waitFor(() => fetch(BASE + "/api/version").then(r => r.ok), { what: "server up" });
    browser = await chromium.launch({
        args: [
            "--use-fake-ui-for-media-stream",
            "--use-fake-device-for-media-stream",
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

test("camera: on → neighbour decodes it; off/on again without renegotiation; late joiner sees it", async () => {
    const { pages: [a, b], ids: [aId, bId], code } = await room(2);

    await a.click("#camBtn");
    await waitFor(() => a.evaluate(() => VoidCam.isOn() && document.getElementById("camBtn").classList.contains("active")), { what: "A camera on" });
    await waitFor(() => tileLive(b, aId), { what: "B shows A's camera tile with frames" });
    const f0 = await camFrames(b, aId);
    await waitFor(async () => (await camFrames(b, aId)) > f0 + 10, { what: "A's camera frames keep decoding on B" });
    assert.ok(await b.evaluate(() => document.getElementById("app").classList.contains("cams")), "B is in camera mode");
    assert.ok(await a.evaluate(() => !!document.querySelector(".cam-tile.is-self")), "A sees self tile");
    // На стороне B это камера, не демка.
    assert.equal(await b.evaluate((id) => videoMap.has(id), aId), false, "camera is not routed as a screen share");
    // Спрос: B видит большую плитку → у A для B активная ступень.
    await waitFor(() => a.evaluate((id) => {
        const s = VoidCam.senderFor(id);
        const enc = s?.getParameters().encodings?.[0];
        return enc && enc.active !== false && enc.maxBitrate > 0 && VoidCam.tierInfo(id)?.wanted !== "L0";
    }, bId), { what: "A encodes for B with a live tier" });

    if (SHOTS) {
        await b.waitForTimeout(800);
        await b.screenshot({ path: join(SHOTS, "cam-2p-b.png") });
        await a.screenshot({ path: join(SHOTS, "cam-2p-a-self.png") });
    }

    // Выкл: без ренеготиации, плитка уходит, диод (трек) погашен.
    const sig = () => a.evaluate((id) => peers.get(id).localDescription.sdp.length + "|" + peers.get(id).getTransceivers().length, bId);
    const before = await sig();
    await a.click("#camBtn");
    await waitFor(() => a.evaluate(() => !VoidCam.isOn() && !VoidCam.localTrack()), { what: "A camera off, track stopped" });
    await waitFor(() => noTile(b, aId), { what: "B dropped A's tile" });
    await waitFor(() => b.evaluate(() => !document.getElementById("app").classList.contains("cams")), { what: "B back to voice", timeout: 5000 });
    // Включили снова — тот же трансивер, кадры пошли.
    await a.click("#camBtn");
    await waitFor(() => tileLive(b, aId), { what: "A camera back on B" });
    assert.equal(await sig(), before, "on/off/on: same SDP and transceivers (replaceTrack only)");

    // Поздний вход: C видит камеру A.
    const c = await openClient("C");
    await c.fill("#codeInput", code);
    await c.click("#joinBtn");
    await waitFor(() => allConnected(c, 2), { what: "C connected" });
    await waitFor(() => tileLive(c, aId), { what: "late joiner C sees A's camera" });

    // B тоже включает: у A две плитки (своя + B), у C — две.
    await b.click("#camBtn");
    await waitFor(() => tileLive(a, bId) && tileLive(c, bId), { what: "B's camera on A and C" });
    if (SHOTS) {
        await c.waitForTimeout(800);
        await c.screenshot({ path: join(SHOTS, "cam-3p-c-watcher.png") });
    }
    for (const p of [a, b, c]) await p.context().close();
});

test("camera + screen share at the same time stay apart", async () => {
    const { pages: [a, b], ids: [aId] } = await room(2);
    await a.click("#camBtn");
    await waitFor(() => tileLive(b, aId), { what: "camera on B" });
    // Демка из dev-генератора (без системного пикера).
    await a.evaluate(async () => {
        VoidScreenLab.overrides.source = "generator";
        await beginScreenShare();
    });
    await waitFor(() => b.evaluate((id) => {
        const v = videoMap.get(id);
        return !!(v && v.srcObject && v.srcObject !== VoidCam.remoteStream(id));
    }, aId), { what: "B got the screen share as a separate stream" });
    const f0 = await camFrames(b, aId);
    await waitFor(async () => (await camFrames(b, aId)) > f0 + 10, { what: "camera still decoding during screen share" });
    // Бюджет камеры при демке — вдвое меньше: ступень у A не выше L4/2.
    const bps = await a.evaluate(() => {
        const [uid] = [...peers.keys()];
        return VoidCam.senderFor(uid).getParameters().encodings[0].maxBitrate;
    });
    assert.ok(bps > 0 && bps <= 2_000_000, `camera bitrate halved under screen share (${bps})`);
    // Кнопка «экран» на плитке у того, кто показывает.
    await waitFor(() => b.evaluate((id) => document.querySelector(`.cam-tile[data-user-id="${id}"]`)?.classList.contains("is-sharing"), aId),
        { what: "watch-screen button on the sharer's tile" });
    for (const p of [a, b]) await p.context().close();
});

test("camera survives a signaling blip and an old client gets no video at all", async () => {
    const { pages: [a, b, old], ids: [aId, bId, oldId] } = await room(3, [{}, {}, { oldClient: true }]);
    await a.click("#camBtn");
    await waitFor(() => tileLive(b, aId), { what: "camera on B" });
    // Старому клиенту камеру не шлют вовсе — демки из неё у него не будет.
    await old.waitForTimeout(1500);
    assert.equal(await a.evaluate((id) => !!VoidCam.senderFor(id), oldId), false, "no camera sender to the old client");
    assert.equal(await old.evaluate(() => videoMap.size), 0, "old client sees no 'screen share'");

    const pcBefore = await b.evaluate((id) => { window.__pcA = peers.get(id); return true; }, aId);
    assert.ok(pcBefore);
    await a.evaluate(() => socket.close());
    await waitFor(() => a.evaluate(() => socket && socket.readyState === 1), { what: "A reconnected" });
    await new Promise(r => setTimeout(r, 1500));
    assert.ok(await b.evaluate((id) => peers.get(id) === window.__pcA, aId), "B kept the peer");
    assert.ok(await tileLive(b, aId), "tile stayed");
    assert.ok(await b.evaluate((id) => VoidCam.peerHasCam(id), aId), "camera flag kept");

    // Спрос зрителя: B «не видит» плитку → у A энкодер для B стоит.
    await b.evaluate((id) => VoidCam.setWant(id, 0, true), aId);
    await waitFor(() => a.evaluate((id) => VoidCam.senderFor(id)?.getParameters().encodings[0].active === false, bId),
        { what: "A paused the encoder for B" });
    await b.evaluate(() => VoidCamStage.refreshDemand(true));
    await waitFor(() => a.evaluate((id) => VoidCam.senderFor(id)?.getParameters().encodings[0].active === true, bId),
        { what: "A resumed for B" });
    for (const p of [a, b, old]) await p.context().close();
});

test("camera UI: phone layout and focus mode render without errors", async () => {
    const { pages: [a, b, c], ids: [aId, bId] } = await room(3, [{}, {}, { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }]);
    await a.click("#camBtn");
    await b.click("#camBtn");
    await waitFor(() => tileLive(c, aId) && tileLive(c, bId), { what: "phone sees both cameras" });
    // Тап по плитке у телефона: без фокуса (две равные плитки) — режим управления.
    const tileA = await c.$(`.cam-tile[data-user-id="${aId}"]`);
    const box = await tileA.boundingBox();
    assert.ok(box.width > 100 && box.y > 0, "tile is on screen");
    if (SHOTS) {
        await c.waitForTimeout(800);
        await c.screenshot({ path: join(SHOTS, "cam-phone.png") });
    }
    // Фокус на A у B (десктоп): кнопка фокуса из режима управления.
    await b.click(`.cam-tile[data-user-id="${aId}"]`);
    await b.waitForTimeout(400);
    await b.click(`.cam-tile[data-user-id="${aId}"] .cam-expand`);
    await waitFor(() => b.evaluate((id) => document.querySelector(`.cam-tile[data-user-id="${id}"]:not(.is-ghost)`)?.classList.contains("is-focus"), aId),
        { what: "focus on A" });
    if (SHOTS) {
        await b.waitForTimeout(800);
        await b.screenshot({ path: join(SHOTS, "cam-focus.png") });
    }
    // Выход из комнаты гасит камеру.
    await a.click("#leaveBtn");
    await waitFor(() => a.evaluate(() => !isJoined && !VoidCam.isOn() && !document.querySelector(".cam-tile")), { what: "leave stops the camera" });
    await waitFor(() => noTile(b, aId), { what: "B dropped A after leave" });
    for (const p of [a, b, c]) await p.context().close();
    assert.deepEqual(errors, [], "no page errors");
});

test("camera traffic follows each viewer: thumb → L1, hidden tab → paused, rebuild restores", async () => {
    const { pages: [a, b, c], ids: [aId, bId, cId] } = await room(3);
    await a.click("#camBtn");
    await b.click("#camBtn");
    await waitFor(() => tileLive(c, aId) && tileLive(c, bId) && tileLive(b, aId), { what: "both cameras live" });
    const enc = (uid) => a.evaluate((id) => {
        const p = VoidCam.senderFor(id).getParameters().encodings[0];
        return { active: p.active !== false, max: p.maxBitrate, tier: VoidCam.tierInfo(id).id };
    }, uid);
    // C ставит B в фокус → A у C становится миниатюрой → A шлёт C ступень L1.
    await c.click(`.cam-tile[data-user-id="${bId}"]`);
    await c.waitForTimeout(300);
    await c.click(`.cam-tile[data-user-id="${bId}"] .cam-expand`);
    await waitFor(async () => (await enc(cId)).tier === "L1", { what: "A → C drops to L1 (thumb)" });
    assert.equal((await enc(cId)).max, 150_000);
    assert.notEqual((await enc(bId)).tier, "L1", "B still gets a full tile — per-pair tiers");
    // B прячет вкладку → энкодер A для B стоит; вернулся — снова идёт.
    const setHidden = (p, v) => p.evaluate((v) => {
        Object.defineProperty(document, "hidden", { configurable: true, get: () => v });
        document.dispatchEvent(new Event("visibilitychange"));
    }, v);
    await setHidden(b, true);
    await waitFor(async () => !(await enc(bId)).active, { what: "A paused for hidden B" });
    await setHidden(b, false);
    await waitFor(async () => (await enc(bId)).active, { what: "A resumed for B" });
    // Пересборка peer'а A↔B: камера возвращается сама, демкой не становится.
    await a.evaluate((id) => rebuildPeer(id), bId);
    await waitFor(() => b.evaluate((id) => peers.get(id)?.connectionState === "connected", aId), { what: "rebuilt" });
    await waitFor(() => tileLive(b, aId) && tileLive(a, bId), { what: "cameras back after rebuild" });
    assert.equal(await b.evaluate(() => videoMap.size), 0, "no camera routed as screen after rebuild");
    for (const p of [a, b, c]) await p.context().close();
});
