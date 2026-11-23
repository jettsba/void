import "./_env.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";

const F = await import("../../lib/friends.js");

function fakeWs() {
    return {
        readyState: 1,
        _ip: "198.51.100.7",
        sent: [],
        send(m) { this.sent.push(JSON.parse(m)); },
        of(type) { return this.sent.filter(x => x.type === type); },
    };
}
const tok = (c) => c.repeat(22);
const hash = (c) => c.repeat(43);
const peerOf = (ws) => ws._fr.id;

test("presence: listener learns about announcer, both orders, only listener is told", () => {
    const a = fakeWs(), b = fakeWs();
    F.handleFriendPresence(a, { announce: [tok("a")], listen: [tok("b")] });
    F.handleFriendPresence(b, { announce: [tok("b")], listen: [tok("a")] });
    // b registered second: b learns about a (listen hit), a learns about b (announce hit)
    assert.deepEqual(b.of("fr-online"), [{ type: "fr-online", t: tok("a"), peer: peerOf(a) }]);
    assert.deepEqual(a.of("fr-online"), [{ type: "fr-online", t: tok("b"), peer: peerOf(b) }]);
    F.handleFriendDisconnect(a); F.handleFriendDisconnect(b);
});

test("invisible: announces nothing — sees friend, friend does not see it", () => {
    const inv = fakeWs(), vis = fakeWs();
    F.handleFriendPresence(vis, { announce: [tok("v")], listen: [tok("i")] });
    F.handleFriendPresence(inv, { announce: [], listen: [tok("v")] });
    assert.equal(inv.of("fr-online").length, 1);
    assert.equal(vis.of("fr-online").length, 0);
    F.handleFriendDisconnect(inv); F.handleFriendDisconnect(vis);
});

test("offline on disconnect and on token removal; state fully dropped", () => {
    const a = fakeWs(), b = fakeWs();
    F.handleFriendPresence(b, { announce: [], listen: [tok("c"), tok("d")] });
    F.handleFriendPresence(a, { announce: [tok("c"), tok("d")], listen: [] });
    F.handleFriendPresence(a, { announce: [tok("d")], listen: [] });          // day rollover drops c
    assert.deepEqual(b.of("fr-offline").map(m => m.t), [tok("c")]);
    F.handleFriendDisconnect(a);
    assert.deepEqual(b.of("fr-offline").map(m => m.t), [tok("c"), tok("d")]);
    F.handleFriendDisconnect(b);
    assert.deepEqual(F._friendsStats(), { tokens: 0, peers: 0, invites: 0 });
});

test("presence validation: bad tokens / oversized lists rejected wholesale", () => {
    const a = fakeWs();
    F.handleFriendPresence(a, { announce: ["short"], listen: [] });
    F.handleFriendPresence(a, { announce: Array.from({ length: 257 }, (_, i) => String(i).padStart(22, "x")), listen: [] });
    assert.equal(a._fr, undefined);
    assert.equal(F._friendsStats().tokens, 0);
});

test("relay: only between matched sockets", () => {
    const a = fakeWs(), b = fakeWs(), stranger = fakeWs();
    F.handleFriendPresence(a, { announce: [tok("e")], listen: [] });
    F.handleFriendPresence(b, { announce: [], listen: [tok("e")] });
    F.handleFriendPresence(stranger, { announce: [], listen: [] });
    F.handleFriendRelay(stranger, { to: peerOf(a), d: "x.y" });
    assert.equal(a.of("fr-msg").length, 0);
    F.handleFriendRelay(b, { to: peerOf(a), d: "x.y" });
    F.handleFriendRelay(a, { to: peerOf(b), d: "x.z" });
    assert.deepEqual(a.of("fr-msg"), [{ type: "fr-msg", from: peerOf(b), d: "x.y" }]);
    assert.deepEqual(b.of("fr-msg"), [{ type: "fr-msg", from: peerOf(a), d: "x.z" }]);
    F.handleFriendRelay(b, { to: peerOf(a), d: "x".repeat(F.FR_MAX_RELAY_BYTES + 1) });
    assert.equal(a.of("fr-msg").length, 1);
    [a, b, stranger].forEach(F.handleFriendDisconnect);
});

test("invite: single use, links the pair for relay, unknown hash says no", () => {
    const owner = fakeWs(), opener = fakeWs(), late = fakeWs();
    F.handleFriendInviteOpen(owner, { h: hash("h") });
    F.handleFriendInviteUse(opener, { h: hash("h"), d: "req" });
    assert.deepEqual(owner.of("fr-invite-hit"), [{ type: "fr-invite-hit", h: hash("h"), from: peerOf(opener), d: "req" }]);
    assert.equal(opener.of("fr-invite-res")[0].ok, true);

    F.handleFriendInviteUse(late, { h: hash("h"), d: "req" });
    assert.equal(late.of("fr-invite-res")[0].ok, false);
    assert.equal(owner.of("fr-invite-hit").length, 1);

    F.handleFriendRelay(owner, { to: peerOf(opener), d: "acc" });
    F.handleFriendRelay(opener, { to: peerOf(owner), d: "fin" });
    F.handleFriendRelay(late, { to: peerOf(owner), d: "spam" });
    assert.equal(opener.of("fr-msg")[0].d, "acc");
    assert.deepEqual(owner.of("fr-msg").map(m => m.d), ["fin"]);
    [owner, opener, late].forEach(F.handleFriendDisconnect);
});

test("invite: per-socket cap and cleanup on disconnect", () => {
    const owner = fakeWs();
    for (const c of "abcde") F.handleFriendInviteOpen(owner, { h: hash(c) });
    assert.equal(F._friendsStats().invites, F.FR_MAX_INVITES);
    F.handleFriendInviteClose(owner, { h: hash("a") });
    assert.equal(F._friendsStats().invites, F.FR_MAX_INVITES - 1);
    F.handleFriendDisconnect(owner);
    assert.equal(F._friendsStats().invites, 0);
});

test("multi invite (friend code handle): not consumed, first owner keeps it", () => {
    const owner = fakeWs(), other = fakeWs(), u1 = fakeWs(), u2 = fakeWs();
    F.handleFriendInviteOpen(owner, { h: hash("t"), multi: true });
    F.handleFriendInviteOpen(other, { h: hash("t"), multi: true });
    F.handleFriendInviteUse(u1, { h: hash("t"), d: "a" });
    F.handleFriendInviteUse(u2, { h: hash("t"), d: "b" });
    assert.deepEqual(owner.of("fr-invite-hit").map(m => m.d), ["a", "b"]);
    assert.equal(other.of("fr-invite-hit").length, 0);
    F.handleFriendRelay(owner, { to: peerOf(u2), d: "acc" });
    assert.equal(u2.of("fr-msg")[0].d, "acc");
    [owner, other, u1, u2].forEach(F.handleFriendDisconnect);
    assert.equal(F._friendsStats().invites, 0);
});

test("invite check: reports open/closed without consuming or linking", () => {
    const owner = fakeWs(), asker = fakeWs();
    F.handleFriendInviteCheck(asker, { h: hash("c") });
    assert.equal(asker.of("fr-invite-alive")[0].ok, false);
    F.handleFriendInviteOpen(owner, { h: hash("c") });
    F.handleFriendInviteCheck(asker, { h: hash("c") });
    F.handleFriendInviteCheck(owner, { h: hash("c") });
    assert.equal(asker.of("fr-invite-alive")[1].ok, true);
    assert.equal(owner.of("fr-invite-alive")[0].ok, false);
    assert.equal(owner.of("fr-invite-hit").length, 0);
    F.handleFriendInviteUse(asker, { h: hash("c"), d: "req" });
    assert.equal(asker.of("fr-invite-res")[0].ok, true);
    [owner, asker].forEach(F.handleFriendDisconnect);
});
