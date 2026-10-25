import "./_env.mjs";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

const H = await import("../../lib/handlers.js");
const { rooms } = await import("../../lib/state.js");

let ipSeq = 0;
function fakeWs() {
    return {
        readyState: 1,
        _ip: `198.51.100.${++ipSeq % 250}`,
        sent: [],
        send(m) { this.sent.push(JSON.parse(m)); },
        last(type) { return [...this.sent].reverse().find(x => x.type === type); },
    };
}

/* Полный вход по протоколу: create (первый) или join → confirm. */
function enter(code, userId, { create = false, ...extra } = {}) {
    const ws = fakeWs();
    if (create) H.handleCreateRoom(ws, { code });
    else H.handleJoinRoom(ws, { code, userId, ...extra });
    const pre = ws.sent.at(-1);
    if (!create && pre.type !== "join-success") return { ws, failed: pre };
    H.handleJoinConfirm(ws, { code, userId, nickname: userId.toLowerCase() });
    return { ws, list: ws.last("user-list") };
}

beforeEach(() => rooms.clear());

test("join → user-list carries a personal leave token", () => {
    const a = enter("ROOMA", "AAAA1111", { create: true });
    const b = enter("ROOMA", "BBBB2222");
    assert.match(a.list.leaveToken, /^[A-Za-z0-9_-]{20,}$/);
    assert.notEqual(a.list.leaveToken, b.list.leaveToken);
    assert.equal(b.list.closed, false);
    assert.deepEqual(b.list.users.map(u => u.id), ["AAAA1111"]);
});

test("leave beacon: someone else's userId without the token is NOT a kick", () => {
    const a = enter("ROOMB", "AAAA1111", { create: true });
    const b = enter("ROOMB", "BBBB2222");
    H.handleBeaconLeave("ROOMB", "BBBB2222");               // старый формат, без токена
    H.handleBeaconLeave("ROOMB", "BBBB2222", "forged-token-forged");
    H.handleBeaconLeave("ROOMB", "BBBB2222", a.list.leaveToken); // чужой токен
    assert.ok(rooms.get("ROOMB").users.has("BBBB2222"));
    assert.ok(!a.ws.sent.some(m => m.type === "participant-left"));

    H.handleBeaconLeave("ROOMB", "BBBB2222", b.list.leaveToken);
    assert.ok(!rooms.get("ROOMB").users.has("BBBB2222"));
    assert.equal(a.ws.last("participant-left").userId, "BBBB2222");
});

test("close vote: closes only when EVERYONE voted, vote can be withdrawn", () => {
    const a = enter("ROOMC", "AAAA1111", { create: true });
    const b = enter("ROOMC", "BBBB2222");

    H.handleRoomCloseVote(a.ws, { vote: true });
    let st = b.ws.last("room-close-state");
    assert.equal(st.closed, false);
    assert.deepEqual(st.closeVotes, ["AAAA1111"]);
    assert.ok(!("pass" in st));

    H.handleRoomCloseVote(a.ws, { vote: false });
    assert.deepEqual(b.ws.last("room-close-state").closeVotes, []);

    H.handleRoomCloseVote(a.ws, { vote: true });
    H.handleRoomCloseVote(b.ws, { vote: true });
    st = b.ws.last("room-close-state");
    assert.equal(st.closed, true);
    assert.match(st.pass, /^[A-Za-z0-9_-]{16,}$/);
    assert.equal(a.ws.last("room-close-state").pass, st.pass);
});

test("closed room: outsider is rejected, pass holder and fresh drop are let back in", () => {
    const a = enter("ROOMD", "AAAA1111", { create: true });
    const b = enter("ROOMD", "BBBB2222");
    H.handleRoomCloseVote(a.ws, { vote: true });
    H.handleRoomCloseVote(b.ws, { vote: true });
    const pass = a.ws.last("room-close-state").pass;

    const outsider = enter("ROOMD", "CCCC3333");
    assert.equal(outsider.failed.reason, "room-closed");
    assert.ok(!JSON.stringify(outsider.ws.sent).includes(pass), "pass must not leak to outsiders");

    // Перезагрузил вкладку: новый userId, но пропуск в sessionStorage.
    const reloaded = enter("ROOMD", "DDDD4444", { pass });
    assert.ok(reloaded.list, "pass holder gets in");
    assert.equal(reloaded.list.closed, true);
    assert.equal(reloaded.list.pass, pass);

    // У B моргнула сеть: сокет умер, пропуска (например, не успел получить) нет.
    // Голый userId больше не пропуск — его знает каждый в комнате.
    const bToken = b.list.leaveToken;
    H.handleDisconnect(b.ws);
    const spoof = enter("ROOMD", "BBBB2222");
    assert.equal(spoof.failed.reason, "room-closed", "someone else's dropped userId without the token stays outside");
    const back = enter("ROOMD", "BBBB2222", { token: bToken });
    assert.ok(back.list, "the member comes back with own session token");
    assert.notEqual(back.list.leaveToken, bToken, "token rotates on every entry");
});

test("open room: a dropped member's userId can't be taken over without the token", () => {
    const a = enter("ROOMJ", "AAAA1111", { create: true });
    const b = enter("ROOMJ", "BBBB2222");
    const bToken = b.list.leaveToken;
    H.handleDisconnect(b.ws);

    assert.equal(enter("ROOMJ", "BBBB2222").failed.reason, "id-collision");
    assert.equal(enter("ROOMJ", "BBBB2222", { token: "x".repeat(22) }).failed.reason, "id-collision");
    assert.ok(enter("ROOMJ", "CCCC3333").list, "a fresh id still walks into an open room");

    const back = enter("ROOMJ", "BBBB2222", { token: bToken });
    assert.ok(back.list);
    // Погашенный токен второй раз не работает.
    H.handleDisconnect(back.ws);
    assert.equal(enter("ROOMJ", "BBBB2222", { token: bToken }).failed.reason, "id-collision");
    assert.ok(a.ws.sent.length > 0);
});

test("reconnect with the token replaces a half-open socket silently", () => {
    const a = enter("ROOMK", "AAAA1111", { create: true });
    const b = enter("ROOMK", "BBBB2222");
    let terminated = false;
    b.ws.terminate = () => { terminated = true; };
    // Старый сокет B сервер ещё считает живым (readyState 1), а B уже на новом.
    const before = a.ws.sent.length;
    const again = enter("ROOMK", "BBBB2222", { token: b.list.leaveToken, resume: true });
    assert.ok(again.list, "owner takes the slot over immediately");
    assert.ok(terminated, "old socket is closed");
    assert.equal(rooms.get("ROOMK").users.get("BBBB2222").ws, again.ws);
    const toA = a.ws.sent.slice(before);
    assert.ok(!toA.some(m => m.type === "participant-left"), "neighbours don't tear the call down");
    // Закрытие старого сокета теперь ни на что не влияет.
    H.handleDisconnect(b.ws);
    assert.ok(rooms.get("ROOMK").users.has("BBBB2222"));

    const thief = enter("ROOMK", "BBBB2222", { resume: true });
    assert.equal(thief.failed.reason, "id-collision", "a live session can't be taken without the token");
});

test("closing on leave: the last non-voter leaving closes the room", () => {
    const a = enter("ROOME", "AAAA1111", { create: true });
    const b = enter("ROOME", "BBBB2222");
    H.handleRoomCloseVote(a.ws, { vote: true });
    H.handleLeaveRoom(b.ws);
    const st = a.ws.last("room-close-state");
    assert.equal(st.closed, true);
    assert.ok(st.pass);
});

test("mid-vote join keeps existing votes and needs the newcomer's vote too", () => {
    const a = enter("ROOMF", "AAAA1111", { create: true });
    enter("ROOMF", "BBBB2222");
    H.handleRoomCloseVote(a.ws, { vote: true });
    const c = enter("ROOMF", "CCCC3333");
    assert.deepEqual(c.list.closeVotes, ["AAAA1111"]);
    assert.equal(rooms.get("ROOMF").closed, false);
});

test("anyone can reopen with one click", () => {
    const a = enter("ROOMG", "AAAA1111", { create: true });
    const b = enter("ROOMG", "BBBB2222");
    H.handleRoomCloseVote(a.ws, { vote: true });
    H.handleRoomCloseVote(b.ws, { vote: true });
    H.handleRoomOpen(b.ws);
    const st = a.ws.last("room-close-state");
    assert.equal(st.closed, false);
    assert.ok(!("pass" in st));
    assert.ok(enter("ROOMG", "CCCC3333").list, "open again for everyone");
});

test("deploy: a closed room is resurrected closed only with the server's ticket", () => {
    // Комната закрылась до рестарта — участники получили пропуск и билет.
    const a = enter("ROOMH", "AAAA1111", { create: true });
    H.handleRoomCloseVote(a.ws, { vote: true });
    const { pass, ticket } = a.ws.last("room-close-state");
    assert.ok(pass && ticket);
    rooms.clear(); // рестарт

    // Чужак, знающий код, со своим пропуском — комната не воскресает вовсе.
    const fake = "f".repeat(24);
    const intruder = fakeWs();
    H.handleJoinRoom(intruder, { code: "ROOMH", userId: "EVIL0000", resume: true, closed: true, pass: fake });
    assert.equal(intruder.sent.at(-1).reason, "room-not-found");
    assert.ok(!rooms.has("ROOMH"));
    // Настоящий билет к чужому пропуску не подходит.
    H.handleJoinRoom(intruder, { code: "ROOMH", userId: "EVIL0000", resume: true, closed: true, pass: fake, ticket });
    assert.ok(!rooms.has("ROOMH"));
    // Подделанная подпись не проходит.
    const forged = ticket.slice(0, -2) + (ticket.endsWith("AA") ? "BB" : "AA");
    H.handleJoinRoom(intruder, { code: "ROOMH", userId: "EVIL0000", resume: true, closed: true, pass, ticket: forged });
    assert.ok(!rooms.has("ROOMH"));

    // Участник с билетом поднимает её закрытой с тем же пропуском.
    const first = fakeWs();
    H.handleJoinRoom(first, { code: "ROOMH", userId: "AAAA1111", resume: true, closed: true, pass, ticket });
    assert.equal(first.sent.at(-1).type, "join-success");
    assert.equal(rooms.get("ROOMH").closed, true);

    const outsider = enter("ROOMH", "CCCC3333", { resume: true });
    assert.equal(outsider.failed.reason, "room-closed");
    assert.ok(enter("ROOMH", "BBBB2222", { resume: true, closed: true, pass }).list);
});

test("deploy: an open room still comes back on a plain resume", () => {
    const first = fakeWs();
    H.handleJoinRoom(first, { code: "ROOMO", userId: "AAAA1111", resume: true });
    assert.equal(first.sent.at(-1).type, "join-success");
    assert.equal(rooms.get("ROOMO").closed, false);
});

test("close quorum counts only live sockets", () => {
    const a = enter("ROOMQ", "AAAA1111", { create: true });
    const b = enter("ROOMQ", "BBBB2222");
    b.ws.readyState = 3; // сокет уже мёртв, heartbeat ещё не пришёл
    H.handleRoomCloseVote(a.ws, { vote: true });
    assert.equal(rooms.get("ROOMQ").closed, true);
});

test("pre-flight → close → confirm: confirm re-checks the closed flag", () => {
    const a = enter("ROOMI", "AAAA1111", { create: true });
    const late = fakeWs();
    H.handleJoinRoom(late, { code: "ROOMI", userId: "CCCC3333" });
    assert.equal(late.sent.at(-1).type, "join-success");
    H.handleRoomCloseVote(a.ws, { vote: true }); // один в комнате — закрыто сразу
    H.handleJoinConfirm(late, { code: "ROOMI", userId: "CCCC3333", nickname: "late" });
    assert.equal(late.sent.at(-1).reason, "room-closed");
});

test("second room on the same socket: the first one is left, not haunted", () => {
    const ws = fakeWs();
    H.handleCreateRoom(ws, { code: "GHOSTA" });
    H.handleJoinConfirm(ws, { code: "GHOSTA", userId: "AAAA1111", nickname: "a" });
    // двойной клик «создать»: вторая комната на том же сокете
    H.handleCreateRoom(ws, { code: "GHOSTB" });
    H.handleJoinConfirm(ws, { code: "GHOSTB", userId: "AAAA1111", nickname: "a" });

    assert.ok(!rooms.has("GHOSTA"));
    assert.equal(rooms.get("GHOSTB").users.size, 1);

    H.handleDisconnect(ws);
    assert.equal(rooms.size, 0);
});

test("rebuild flag passes at most once per 10 s per pair, the offer itself still goes through", () => {
    const a = enter("ROOMR", "AAAA1111", { create: true });
    const b = enter("ROOMR", "BBBB2222");
    const c = enter("ROOMR", "CCCC3333");
    const offer = { type: "offer", sdp: "v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=fingerprint:sha-256 AA\r\n" };
    for (let i = 0; i < 5; i++) H.handleSignal(a.ws, { type: "offer", to: "BBBB2222", offer, rebuild: true });
    const toB = b.ws.sent.filter(m => m.type === "offer");
    assert.equal(toB.length, 5, "every offer is delivered");
    assert.equal(toB.filter(m => m.rebuild).length, 1, "only the first one carries the rebuild flag");
    // Другая пара независима.
    H.handleSignal(a.ws, { type: "offer", to: "CCCC3333", offer, rebuild: true });
    assert.equal(c.ws.last("offer").rebuild, true);
});

test("ice-report: per-socket limit protects the funnel and the failure log", async () => {
    const { stats } = await import("../../lib/state.js");
    const a = enter("ROOMS", "AAAA1111", { create: true });
    const failedBefore = stats.iceFailed, logBefore = stats.iceFailLog.length;
    for (let i = 0; i < 40; i++) H.handleIceReport(a.ws, { result: "failed", diag: { platform: "web" } });
    assert.equal(stats.iceFailed - failedBefore, 10, "only 10 diagnostic snapshots per minute");
    assert.ok(stats.iceFailLog.length - logBefore <= 10);
    assert.ok(stats.iceReportRejected >= 30);
    const directBefore = stats.iceDirect;
    for (let i = 0; i < 40; i++) H.handleIceReport(a.ws, { result: "direct" });
    assert.equal(stats.iceDirect - directBefore, 20, "30 reports per minute in total");
});
