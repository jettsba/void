/* Friends end-to-end: real server + several Chromium contexts (separate IndexedDB).
 *
 *   E2E_SYNTH_MIC=1 node --test tests/e2e/friends.test.mjs
 *   E2E_SHOTS=dir … — UI screenshots
 *
 * Covers: request from a person's profile in a room (second click on a blob), presence and
 * room status, joining a friend's room, closed room lock, invite link,
 * device transfer, invisible mode, removal. */
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

async function openClient(name, viewport = { width: 1280, height: 800 }) {
    const ctx = await browser.newContext({ permissions: ["microphone", "clipboard-read", "clipboard-write"], viewport });
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
    page._name = name;
    page.on("pageerror", e => console.error(`[${name}] pageerror`, e.message));
    await page.goto(BASE + "/");
    await page.waitForFunction(() => typeof tryJoin === "function" && document.body.style.opacity === "1" && !!window.VoidFriends);
    await page.evaluate(() => window.VoidFriends.ready());
    return page;
}

const shot = (page, file) => SHOTS ? page.screenshot({ path: join(SHOTS, file) }) : null;
const friends = (page) => page.evaluate(() => window.VoidFriends.list());
const myPub = (page) => page.evaluate(() => window.VoidFriends.myPub);

async function createRoom(page) {
    await page.click("#createBtn");
    return waitFor(() => page.evaluate(() => isJoined && currentRoomCode), { what: `${page._name} room` });
}
async function joinRoom(page, code) {
    await page.fill("#codeInput", code);
    await page.click("#joinBtn");
    await waitFor(() => page.evaluate((c) => isJoined && currentRoomCode === c, code), { what: `${page._name} joined` });
}
const connected = (page, n) => page.evaluate((n) =>
    peers.size === n && [...peers.values()].every(p => p.connectionState === "connected")
    && [...chatChannels.values()].every(c => c.readyState === "open"), n);
const otherId = (page) => page.evaluate(() => [...participantElements.keys()].find(id => id !== clientId));

before(async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "void-e2e-"));
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

test("friends: room request, presence, join, closed lock, link, transfer, invisible, removal", { timeout: 180_000 }, async () => {
    const a = await openClient("A");
    const b = await openClient("B");

    /* --- request from the blob --- */
    const code = await createRoom(a);
    await joinRoom(b, code);
    await waitFor(() => connected(a, 1), { what: "A connected" });
    await waitFor(() => connected(b, 1), { what: "B connected" });

    const bIdOnA = await otherId(a);
    const avatar = `.participant[data-user-id="${bIdOnA}"] .participant-avatar`;
    const stateOf = () => a.evaluate((id) => window.VoidFriends.participantState(id), bIdOnA);
    await a.click(avatar);
    await a.waitForTimeout(500);
    await shot(a, "01-blob-more.png");
    await a.click(avatar);
    await a.waitForSelector(".fr-prof .fr-add-btn");
    await a.waitForTimeout(400);
    await shot(a, "01b-person-profile.png");
    await a.click(".fr-add-btn");
    await waitFor(() => stateOf().then(s => s === "sent"), { what: "request sent" });
    await a.waitForTimeout(300);
    await shot(a, "01c-person-sent.png");
    await a.evaluate(() => window.VoidAppModal.close());

    await waitFor(() => b.evaluate(() => window.VoidFriends.requests().incoming.length === 1), { what: "B incoming" });
    await b.click("#friendsPill");
    await b.click(".fbar-req");
    await b.waitForTimeout(400);
    await shot(b, "02-requests.png");
    await b.click('.fr-req [data-act="accept"]');

    await waitFor(async () => (await friends(a)).length === 1 && (await friends(b)).length === 1, { what: "both friends" });
    await waitFor(() => stateOf().then(s => s === "friend"), { what: "friend in room" });
    assert.equal((await friends(a))[0].pub, await myPub(b));
    assert.equal((await friends(b))[0].pub, await myPub(a));
    // friendship security code: same icons on both sides
    const pairA = await a.evaluate((p) => window.VoidFriends.pairIcons(p), await myPub(b));
    const pairB = await b.evaluate((p) => window.VoidFriends.pairIcons(p), await myPub(a));
    assert.equal(pairA.length, 5);
    assert.deepEqual(pairA, pairB);

    /* --- presence + room status --- */
    await waitFor(async () => { const [f] = await friends(a); return f.online && f.room === code; }, { what: "A sees B in room" });
    await a.click("#friendsPill");
    await a.waitForTimeout(500);
    await shot(a, "03-friends-here.png");

    /* second click on a blob = profile */
    await a.keyboard.press("Escape");
    await a.click(`.participant[data-user-id="${bIdOnA}"] .participant-avatar`);
    await a.waitForTimeout(400);
    await a.click(`.participant[data-user-id="${bIdOnA}"] .participant-avatar`);
    await a.waitForSelector(".fr-prof .fr-pair-row svg");
    await a.waitForTimeout(400);
    await shot(a, "04-profile.png");
    await a.click(".fr-pair-row");
    await a.waitForTimeout(1800);
    await shot(a, "04b-pair-info.png");
    await a.click(".fr-pair-modal .sas-close");
    await a.fill(".fr-prof .fr-input", "бро");
    await a.press(".fr-prof .fr-input", "Enter");
    await a.waitForTimeout(400);
    await shot(a, "04c-profile-alias.png");
    await a.evaluate(() => window.VoidAppModal.close());

    /* B moves to its own room, A joins through the friends list */
    await b.evaluate(() => leaveRoom());
    const code2 = await createRoom(b);
    await waitFor(async () => (await friends(a))[0].room === code2, { what: "A sees B's new room" });
    await a.evaluate(() => window.VoidFriendsUI.open("friends"));
    await a.click('.fr-row [data-act="join"]');
    await waitFor(() => a.evaluate((c) => isJoined && currentRoomCode === c, code2), { what: "A joined B's room" });

    /* closed room → lock + swap */
    await b.evaluate(() => leaveRoom());
    await a.evaluate(() => sendSocket({ type: "room-close-vote", vote: true }));
    await waitFor(async () => { const [f] = await friends(b); return f.room === code2 && f.closed; }, { what: "B sees closed room" });
    await b.evaluate(() => window.VoidFriendsUI.open("friends"));
    await b.click('.fr-row [data-act="locked"]');
    await waitFor(() => b.evaluate(() => document.querySelector(".fr-row").classList.contains("is-swapped")), { what: "lock swap" });
    await shot(b, "05-locked.png");
    await b.keyboard.press("Escape");

    /* --- invite link --- */
    const c = await openClient("C", { width: 390, height: 844 });
    const link = await a.evaluate(() => window.VoidFriends.createLink());
    assert.match(link, /#friend=[A-Za-z0-9_-]{22}$/);
    await c.goto(link.replace(/^https?:\/\/[^/]+/, BASE));
    await c.waitForSelector(".fr-confirm [data-ok]");
    await shot(c, "06-link-confirm-mobile.png");
    await c.click(".fr-confirm [data-ok]");
    await waitFor(() => a.evaluate(() => window.VoidFriends.requests().incoming.some(r => r.via === "link")), { what: "A gets link request" });
    const reqId = await a.evaluate(() => window.VoidFriends.requests().incoming[0].id);
    await a.evaluate((id) => window.VoidFriends.acceptRequest(id), reqId);
    await waitFor(async () => (await friends(c)).length === 1 && (await friends(a)).length === 2, { what: "link friendship" });
    // single use
    const again = await c.evaluate((l) => window.VoidFriends.useLink(l), link);
    assert.equal(again, true);
    await waitFor(() => c.evaluate(() => window.VoidFriends.requests().outgoing.length === 0), { what: "dead link rejected" });

    await c.evaluate(() => window.VoidFriendsUI.open("friends"));
    await waitFor(async () => (await friends(c))[0].online, { what: "C sees A online" });
    await c.waitForTimeout(500);
    await shot(c, "07-sheet-mobile.png");

    /* --- add by code nick#0000 (E adds C) + QR decodes back to the link --- */
    const e = await openClient("E");
    const cTag = await c.evaluate(() => window.VoidFriends.myTag());
    assert.match(cTag.tag, /^[a-z ]+#\d{4}$/);
    await e.evaluate((t) => window.VoidFriends.useTag(t), cTag.display);
    await waitFor(() => c.evaluate(() => window.VoidFriends.requests().incoming.some(r => r.via === "code")), { what: "C gets code request" });
    const cReq = await c.evaluate(() => window.VoidFriends.requests().incoming.find(r => r.via === "code").id);
    await c.evaluate((id) => window.VoidFriends.acceptRequest(id), cReq);
    await waitFor(async () => (await friends(e)).length === 1, { what: "friends by code" });

    await e.evaluate(() => window.VoidFriendsUI.openAdd());
    await e.waitForTimeout(400);
    await shot(e, "08a-add.png");
    await e.click('[data-sx-open="qr"]');
    await e.waitForSelector(".fr-qr.is-drawn svg");
    await e.waitForTimeout(900);
    await shot(e, "08-add-qr.png");
    const decoded = await e.evaluate(async () => {
        await new Promise((res, rej) => { const s = document.createElement("script"); s.src = "vendor/jsQR.js"; s.onload = res; s.onerror = rej; document.head.appendChild(s); });
        const svg = document.querySelector(".fr-qr svg");
        const img = new Image();
        img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(new XMLSerializer().serializeToString(svg).replace('class="vqr-bg"', 'fill="#e6e6e8"').replaceAll('class="vqr-mod"', 'fill="#0a0a0b"'));
        await img.decode();
        const cv = document.createElement("canvas"); cv.width = cv.height = 400;
        const ctx = cv.getContext("2d"); ctx.drawImage(img, 0, 0, 400, 400);
        return window.jsQR(ctx.getImageData(0, 0, 400, 400).data, 400, 400)?.data || null;
    });
    assert.match(decoded || "", /#friend=[A-Za-z0-9_-]{22}$/);
    await e.click(".fr-modal [data-sx-cancel]");
    await e.waitForTimeout(400);
    await e.click('[data-sx-open="code"]');
    await e.waitForTimeout(500);
    await shot(e, "08b-add-code.png");
    // a bad code stays in the modal with a note; a good one opens the profile
    await e.fill('[data-sx="code"] .sx-input', "nonsense");
    await e.click(".fr-modal [data-sx-sq]");
    await e.waitForFunction(() => document.querySelector(".fr-modal .sx-err")?.textContent.length > 0);
    await e.waitForTimeout(300);
    await shot(e, "08c-add-code-bad.png");
    await e.fill('[data-sx="code"] .sx-input', "ghost#0001");
    await e.click(".fr-modal [data-sx-sq]");
    await e.waitForSelector(".fr-prof .fr-add-btn");
    await e.waitForTimeout(400);
    await shot(e, "08d-tag-profile.png");
    await e.click(".fr-prof .fr-add-btn");
    await e.waitForSelector(".fr-prof-status.is-warn");
    await e.waitForTimeout(400);
    await shot(e, "08e-tag-missing.png");
    // C is already a friend: its code opens the friend profile
    await e.evaluate(() => window.VoidFriendsUI.openAdd());
    await e.waitForTimeout(400);
    await e.click('[data-sx-open="code"]');
    await e.waitForTimeout(400);
    await e.fill('[data-sx="code"] .sx-input', cTag.display);
    await e.keyboard.press("Enter");
    await e.waitForSelector(".fr-prof .fr-pair-row");
    await e.evaluate(() => window.VoidAppModal.close());
    await e.waitForTimeout(400);
    await e.evaluate(() => window.VoidFriendsUI.openAdd());
    await e.waitForTimeout(400);
    await e.click('[data-sx-open="link"]');
    await e.waitForTimeout(900);
    await shot(e, "09-add-link.png");
    await e.evaluate(() => window.VoidAppModal.close());

    /* settings profile: nick#code, transfer buttons */
    await e.evaluate(() => document.getElementById("settingsCatProfile").click());
    await e.waitForSelector('[data-sx-open="show"]');
    await e.waitForTimeout(500);
    await shot(e, "10-settings-profile.png");
    await e.click('[data-sx-open="show"]');
    await e.waitForTimeout(900);
    await shot(e, "11-transfer-show.png");
    await e.click("#profileFriendsSlot [data-sx-sq]");
    await e.waitForTimeout(1400);
    await shot(e, "11b-transfer-qr.png");
    await e.click("#profileFriendsSlot [data-sx-sq]");
    await e.waitForTimeout(400);
    await e.click("#profileFriendsSlot [data-sx-cancel]");
    await e.waitForTimeout(400);
    await e.click('[data-sx-open="enter"]');
    await e.waitForTimeout(500);
    await e.keyboard.type("s29h");
    await e.waitForTimeout(200);
    assert.equal(await e.inputValue('[data-sx="enter"] .sx-input'), "S29H");
    await shot(e, "12-transfer-enter.png");
    await e.click("#profileFriendsSlot [data-sx-cancel]");
    await e.keyboard.press("Escape");

    /* --- device transfer: C → D --- */
    const d = await openClient("D");
    const { code: tcode } = await c.evaluate(() => window.VoidFriends.startTransfer());
    await d.evaluate((k) => window.VoidFriends.joinTransfer(k), tcode);
    await waitFor(async () => (await myPub(d)) === (await myPub(c)), { what: "D adopted C's key" });
    await waitFor(async () => (await friends(d)).length === 2, { what: "D has C's friends" });
    await waitFor(async () => (await friends(d)).some(f => f.online), { what: "D sees a friend online" });

    /* --- invisible: A hides, B no longer sees A; A still sees B --- */
    await a.evaluate(() => window.VoidFriends.setInvisible(true));
    const bPubOnB = await myPub(b);
    await waitFor(async () => !(await friends(b))[0].online, { timeout: 15_000, what: "B sees A offline" });
    await waitFor(async () => (await friends(a)).find(f => f.pub === bPubOnB)?.online, { what: "A still sees B" });
    await a.evaluate(() => window.VoidFriends.setInvisible(false));
    await waitFor(async () => (await friends(b))[0].online, { what: "B sees A again" });

    /* --- settings profile block renders --- */
    await a.evaluate(() => window.VoidAppModal.close());
    await a.evaluate(() => window.VoidFriendsUI.close());

    /* --- removal propagates --- */
    await b.evaluate((pub) => window.VoidFriends.removeFriend(pub), (await friends(b))[0].pub);
    await waitFor(async () => (await friends(a)).length === 1, { what: "A dropped B" });
});
