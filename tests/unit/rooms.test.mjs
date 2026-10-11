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
    H.handleDisconnect(b.ws);
    const back = enter("ROOMD", "BBBB2222");
    assert.ok(back.list, "fresh network drop of a member is let back in");
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

test("deploy: a closed room is resurrected closed, members come back with the pass", () => {
    const pass = "p".repeat(24);
    const first = fakeWs();
    H.handleJoinRoom(first, { code: "ROOMH", userId: "AAAA1111", resume: true, closed: true, pass });
    assert.equal(first.sent.at(-1).type, "join-success");
    assert.equal(rooms.get("ROOMH").closed, true);

    const outsider = enter("ROOMH", "CCCC3333", { resume: true });
    assert.equal(outsider.failed.reason, "room-closed");
    assert.ok(enter("ROOMH", "BBBB2222", { resume: true, closed: true, pass }).list);
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
