process.env.TURN_HOST = "turn.example.test";
process.env.TURN_SECRET = "test-secret-test-secret-test-secret";
import "./_env.mjs";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

const H = await import("../../lib/handlers.js");
const { mountTurnEndpoint } = await import("../../lib/turn.js");
const { rooms } = await import("../../lib/state.js");

let ipSeq = 0;
function fakeWs() {
    return {
        readyState: 1,
        _ip: `192.0.2.${++ipSeq}`,
        sent: [],
        send(m) { this.sent.push(JSON.parse(m)); },
        last(type) { return [...this.sent].reverse().find(x => x.type === type); },
    };
}

beforeEach(() => rooms.clear());

test("TURN credentials come only with the member's own user-list, without the userId", () => {
    const ws = fakeWs();
    H.handleCreateRoom(ws, { code: "TURNA" });
    H.handleJoinConfirm(ws, { code: "TURNA", userId: "SECRETUSERID", nickname: "a" });
    const turn = ws.last("user-list").turn;
    assert.ok(Array.isArray(turn.iceServers));
    const relay = turn.iceServers.find(s => s.username);
    assert.match(relay.username, /^\d+:s[0-9a-f]{16}$/);
    assert.ok(!relay.username.includes("SECRETUSERID"));

    const other = fakeWs();
    H.handleJoinRoom(other, { code: "TURNA", userId: "BBBB2222" });
    H.handleJoinConfirm(other, { code: "TURNA", userId: "BBBB2222", nickname: "b" });
    assert.ok(!JSON.stringify(other.sent).includes(relay.username), "nobody else sees my credentials");
});

test("turn-refresh: members only, at most once per 30 s", () => {
    const outsider = fakeWs();
    H.handleTurnRefresh(outsider);
    assert.equal(outsider.sent.length, 0);

    const ws = fakeWs();
    H.handleCreateRoom(ws, { code: "TURNB" });
    H.handleJoinConfirm(ws, { code: "TURNB", userId: "AAAA1111", nickname: "a" });
    H.handleTurnRefresh(ws);
    H.handleTurnRefresh(ws);
    const replies = ws.sent.filter(m => m.type === "turn-credentials");
    assert.equal(replies.length, 1);
    assert.ok(replies[0].turn.iceServers.length > 0);
});

test("legacy HTTP endpoint: rate-limited, short-lived, no userId", () => {
    let handler;
    mountTurnEndpoint({ get: (path, fn) => { handler = fn; } }, () => "203.0.113.9");
    const call = () => {
        const res = {
            code: 200, body: null,
            set() {}, status(c) { this.code = c; return this; }, json(b) { this.body = b; }
        };
        handler({ query: { uid: "VICTIM01" } }, res);
        return res;
    };
    const first = call();
    assert.equal(first.code, 200);
    const relay = first.body.iceServers.find(s => s.username);
    assert.ok(!relay.username.includes("VICTIM01"));
    assert.equal(first.body.ttl, 1800);
    for (let i = 0; i < 4; i++) assert.equal(call().code, 200);
    assert.equal(call().code, 429);
});
