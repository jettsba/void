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

    /* settings profile: nick#code, my devices, "add" opens the transfer modal */
    await e.evaluate(() => document.getElementById("settingsCatProfile").click());
    await e.waitForSelector("#profileFriendsSlot [data-dev-add]");
    await e.waitForTimeout(500);
    assert.equal(await e.locator("#profileFriendsSlot .fr-dev").count(), 1, "only this device listed");
    assert.equal(await e.locator('#profileFriendsSlot [data-sx-open]').count(), 0, "transfer buttons left the profile");
    await shot(e, "10-settings-profile.png");
    await e.click("#profileFriendsSlot [data-dev-add]");
    await e.waitForSelector('.fr-modal [data-sx-open="show"]');
    await e.waitForTimeout(400);
    await shot(e, "10b-device-add.png");
    await e.click('.fr-modal [data-sx-open="show"]');
    await e.waitForTimeout(900);
    await shot(e, "11-transfer-show.png");
    await e.click(".fr-modal [data-sx-sq]");
    await e.waitForTimeout(1400);
    await shot(e, "11b-transfer-qr.png");
    await e.click(".fr-modal [data-sx-sq]");
    await e.waitForTimeout(400);
    await e.click(".fr-modal [data-sx-cancel]");
    await e.waitForTimeout(400);
    await e.click('.fr-modal [data-sx-open="enter"]');
    await e.waitForTimeout(500);
    await e.keyboard.type("s29h");
    await e.waitForTimeout(200);
    assert.equal(await e.inputValue('.fr-modal [data-sx="enter"] .sx-input'), "S29H");
    await shot(e, "12-transfer-enter.png");
    await e.evaluate(() => window.VoidAppModal.close());
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

/* Device sync: P transfers its key to P2, then the two stay in sync on their
   own — adds, renames, removals, invisible, synced settings. tasks/device-sync-plan.md */
test("device sync: one key on two devices, changes follow both ways", { timeout: 180_000 }, async () => {
    async function befriend(owner, other) {
        const before = (await friends(owner)).length;
        const link = await owner.evaluate(() => window.VoidFriends.createLink());
        await other.evaluate((l) => window.VoidFriends.useLink(l), link);
        await waitFor(() => owner.evaluate(() => window.VoidFriends.requests().incoming.length > 0), { what: `${owner._name} gets request` });
        const id = await owner.evaluate(() => window.VoidFriends.requests().incoming[0].id);
        await owner.evaluate((i) => window.VoidFriends.acceptRequest(i), id);
        await waitFor(async () => (await friends(owner)).length === before + 1, { what: `${owner._name} befriended ${other._name}` });
    }
    async function transfer(src, dst) {
        const { code } = await src.evaluate(() => window.VoidFriends.startTransfer());
        await dst.evaluate((k) => window.VoidFriends.joinTransfer(k), code);
        await waitFor(async () => (await myPub(dst)) === (await myPub(src)), { what: "key adopted" });
    }
    const devs = (page) => page.evaluate(() => window.VoidFriends.syncInfo().devices);
    const names = async (page) => (await friends(page)).map(f => f.name).sort();

    const p = await openClient("P"), q = await openClient("Q"), r = await openClient("R");
    await befriend(p, q);
    const p2 = await openClient("P2");
    await p.evaluate(() => window.VoidSettings.setUiScale(1.2));      // device-local, must not travel
    await transfer(p, p2);
    await waitFor(async () => (await friends(p2)).length === 1, { what: "P2 got Q" });
    await waitFor(async () => (await devs(p)) === 1 && (await devs(p2)) === 1, { what: "devices see each other" });

    /* friend added on P after the transfer lands on P2 */
    await befriend(p, r);
    await waitFor(async () => (await friends(p2)).length === 2, { what: "R synced to P2" });
    const rPub = await myPub(r);

    /* rename on P2 → P */
    await p2.evaluate((pub) => window.VoidFriends.renameFriend(pub, "arr"), rPub);
    await waitFor(async () => (await names(p)).includes("arr"), { what: "alias synced to P" });

    /* synced settings both ways, device-local ones stay put */
    await p.evaluate(() => window.VoidSettings.setLang("en"));
    await waitFor(() => p2.evaluate(() => window.VoidSettings.getLang() === "en"), { what: "lang synced" });
    await p2.evaluate(() => window.VoidSettings.setSfxVolume(0.5));
    await waitFor(() => p.evaluate(() => window.VoidSettings.getSfxVolume() === 0.5), { what: "sfx synced" });
    assert.equal(await p2.evaluate(() => window.VoidSettings.getUiScale()), 1);

    /* invisible follows */
    await p.evaluate(() => window.VoidFriends.setInvisible(true));
    await waitFor(() => p2.evaluate(() => window.VoidFriends.invisible), { what: "invisible synced" });
    await p2.evaluate(() => window.VoidFriends.setInvisible(false));
    await waitFor(() => p.evaluate(() => !window.VoidFriends.invisible), { what: "visible synced" });

    /* removal on P2 → gone on P too, and stays gone after a re-transfer */
    const qPub = await myPub(q);
    await p2.evaluate((pub) => window.VoidFriends.removeFriend(pub), qPub);
    await waitFor(async () => !(await friends(p)).some(f => f.pub === qPub), { what: "removal synced to P" });
    await waitFor(async () => (await friends(q)).length === 0, { what: "Q dropped P" });
    await transfer(p, p2);
    await new Promise(res => setTimeout(res, 1500));
    for (const page of [p, p2]) {
        assert.ok(!(await friends(page)).some(f => f.pub === qPub), `${page._name}: removed friend came back`);
    }

    /* P closes: R still sees P online through P2 */
    await p.context().close();
    await waitFor(async () => (await devs(p2)) === 0, { what: "P2 notices P left" });
    await new Promise(res => setTimeout(res, 8000));                 // past the 6 s offline debounce
    assert.ok((await friends(r))[0]?.online, "R sees P online through P2 only");
    await waitFor(async () => (await p2.evaluate(() => window.VoidFriends.syncInfo().lastSync)) > 0, { what: "lastSync stamped" });

    /* unlink: P3 joins through the UI, P2 unlinks it from the profile table
       (two clicks: "unlink" → "sure?") → P3 wipes its key and friends */
    const p3 = await openClient("P3");
    const { code: c3 } = await p2.evaluate(() => window.VoidFriends.startTransfer());
    await p3.evaluate((k) => window.VoidFriendsUI.confirmTransferLink(k), c3);
    await p3.waitForSelector('.dl-modal.is-open [data-dl-go]');
    await p3.waitForTimeout(500);
    await shot(p3, "20-link-ask.png");
    await p3.click('.dl-modal [data-dl-go]');
    await waitFor(() => p3.evaluate(() => document.querySelector(".dl-modal")?.dataset.phase === "done"), { what: "P3 link dialog done" });
    await shot(p3, "21-link-done.png");
    await waitFor(() => p2.evaluate(() => document.querySelector(".dl-modal")?.dataset.phase === "done"), { what: "P2 link dialog done" });
    await waitFor(async () => (await myPub(p3)) === (await myPub(p2)), { what: "P3 adopted key" });
    const p3Dev = await p3.evaluate(() => window.VoidFriendStore.meta.dev);
    await waitFor(() => p2.evaluate((id) => window.VoidFriends.deviceList().some(d => d.id === id && d.online), p3Dev), { what: "P2 lists P3 online" });

    await p2.click(".dl-modal .s-done [data-dl-close]");
    await p2.evaluate(() => document.getElementById("settingsCatProfile").click());
    const row = `#profileFriendsSlot .fr-dev[data-id="${p3Dev}"] [data-unlink]`;
    await p2.waitForSelector(row);
    await p2.waitForTimeout(400);
    await p2.click(row);
    await p2.waitForTimeout(300);
    await shot(p2, "22-unlink-sure.png");
    assert.ok(await p2.evaluate((id) => window.VoidFriends.deviceList().some(d => d.id === id), p3Dev), "one click does not unlink");
    await p2.click(row);
    await waitFor(() => p2.evaluate((id) => !window.VoidFriends.deviceList().some(d => d.id === id), p3Dev), { what: "P2 dropped P3" });
    await waitFor(async () => (await myPub(p3)) !== (await myPub(p2)), { what: "P3 got a new key" });
    await waitFor(async () => (await friends(p3)).length === 0, { what: "P3 friends wiped" });
    assert.notEqual(await p3.evaluate(() => window.VoidFriendStore.meta.dev), p3Dev, "P3 has a new device id");
    assert.equal((await friends(p2)).length, 1, "P2 keeps its friends");
});
