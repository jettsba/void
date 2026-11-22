import { test } from "node:test";
import assert from "node:assert/strict";

await import("../../public/js/friends/merge.js");
const M = globalThis.VoidFriendMerge;

const NOW = 1_800_000_000_000;
const pad = (c, n) => c.repeat(n);
let seq = 0;
function fr(over = {}) {
    const i = String(++seq).padStart(4, "0");
    return {
        pub: i + pad("p", 83), s: i + pad("s", 39), role: 0,
        nick: "n" + i, alias: "", added: NOW - 1000 + seq, ...over,
    };
}
const st = (friends = [], tombs = [], prefs = undefined) => ({ friends, tombs, prefs });
const merge = (a, b, o = {}) => M.merge(a, b, { now: NOW, ...o });
const pubs = (m) => m.friends.map(f => f.pub).sort();

test("union of two lists, canonical and identical both ways", () => {
    const a = fr(), b = fr(), c = fr();
    const x = merge(st([a, b]), st([b, c]));
    const y = merge(st([b, c]), st([a, b]));
    assert.equal(x.friends.length, 3);
    assert.deepEqual(x, y);
});

test("idempotent: merging the result again changes nothing", () => {
    const a = fr(), b = fr();
    const once = merge(st([a]), st([b], [{ id: M.tombId(fr().s), at: NOW - 5 }]));
    assert.deepEqual(merge(once, once), once);
    assert.deepEqual(merge(once, null), once);
});

test("tomb wins over the friend on the other device (no resurrection)", () => {
    const a = fr(), b = fr();
    const pc = st([a], [{ id: M.tombId(b.s), at: NOW - 10 }]);   // removed b on pc
    const phone = st([a, b]);
    const m = merge(pc, phone);
    assert.deepEqual(pubs(m), [a.pub]);
    assert.equal(m.tombs.length, 1);
    assert.deepEqual(merge(phone, pc), m);
});

test("re-befriending the same person after removal survives the old tomb", () => {
    const old = fr();
    const again = { ...old, s: pad("z", 43), added: NOW };
    const m = merge(st([], [{ id: M.tombId(old.s), at: NOW - 100 }]), st([again]));
    assert.equal(m.friends.length, 1);
    assert.equal(m.friends[0].s, again.s);
});

test("same pub under two secrets: newest friendship kept, old one tombed", () => {
    const old = fr();
    const fresh = { ...old, s: pad("y", 43), added: old.added + 50 };
    const m = merge(st([old]), st([fresh]));
    assert.equal(m.friends.length, 1);
    assert.equal(m.friends[0].s, fresh.s);
    assert.ok(m.tombs.some(t => t.id === M.tombId(old.s)));
    // and the third device holding only the old one converges too
    assert.deepEqual(merge(m, st([old])).friends, m.friends);
});

test("alias: last write wins; nick/pub: last seen wins; independent fields", () => {
    const base = fr({ aliasAt: NOW - 100, seenAt: NOW - 100 });
    const pc = { ...base, alias: "bro", aliasAt: NOW - 10 };
    const phone = { ...base, nick: "newnick", pub: pad("q", 87), seenAt: NOW - 5 };
    const m = merge(st([pc]), st([phone]));
    assert.equal(m.friends[0].alias, "bro");
    assert.equal(m.friends[0].nick, "newnick");
    assert.equal(m.friends[0].pub, pad("q", 87));
});

test("ties break the same way on both sides", () => {
    const base = fr({ aliasAt: NOW, seenAt: NOW });
    const a = { ...base, alias: "aaa" }, b = { ...base, alias: "bbb" };
    assert.deepEqual(merge(st([a]), st([b])), merge(st([b]), st([a])));
});

test("own pub never lands in the list; junk is dropped", () => {
    const me = fr(), ok = fr();
    const m = merge(st([me, ok, { pub: "x", s: "y" }, null]), null, { selfPub: me.pub });
    assert.deepEqual(pubs(m), [ok.pub]);
});

test("old entries without stamps get them from added", () => {
    const f = fr();
    delete f.alias;
    const n = M.normFriend(f);
    assert.equal(n.aliasAt, f.added);
    assert.equal(n.seenAt, f.added);
    assert.equal(n.alias, "");
});

test("caps: 100 newest friends, tombs pruned by age and count", () => {
    const many = Array.from({ length: 105 }, () => fr());
    const m = merge(st(many.slice(0, 60)), st(many.slice(60)));
    assert.equal(m.friends.length, 100);
    assert.equal(m.overflow, 5);
    assert.ok(!m.friends.some(f => many.slice(0, 5).includes(f)));
    const tombs = Array.from({ length: 200 }, (_, i) => ({ id: pad("t", 18) + String(i).padStart(4, "0"), at: NOW - i * 1000 }));
    tombs.push({ id: pad("o", 22), at: NOW - M.TOMB_TTL_MS - 1 });
    const t = merge(st([], tombs), null);
    assert.equal(t.tombs.length, M.MAX_TOMBS);
    assert.ok(!t.tombs.some(x => x.id === pad("o", 22)));
});

test("prefs: newer invisible toggle wins, unset never wins", () => {
    assert.equal(merge(st([], [], { invisible: true, invisibleAt: NOW - 5 }), st([], [], { invisible: false, invisibleAt: NOW })).prefs.invisible, false);
    assert.equal(merge(st([], [], { invisible: true, invisibleAt: NOW }), st([], [], { invisible: false, invisibleAt: 0 })).prefs.invisible, true);
});

test("settings: LWW per key, untouched (at=0) keys stay out", () => {
    const keys = ["lang", "bgTheme", "nickname"];
    const pc = { lang: { v: "en", at: NOW }, bgTheme: { v: "grid", at: 0 } };
    const phone = { lang: { v: "ru", at: NOW - 1 }, bgTheme: { v: "silence", at: 0 }, nickname: { v: "x", at: NOW - 9 } };
    const m = M.mergeSettings(pc, phone, keys);
    assert.deepEqual(m, { lang: { v: "en", at: NOW }, nickname: { v: "x", at: NOW - 9 } });
    assert.deepEqual(M.mergeSettings(phone, pc, keys), m);
});

test("wire: compact encode/decode round trip, objects still accepted", () => {
    const list = [fr(), fr()].map(M.normFriend);
    assert.deepEqual(M.decodeFriends(M.encodeFriends(list)), list);
    assert.deepEqual(M.decodeFriends(list), list);
    const tombs = [{ id: pad("a", 22), at: NOW }];
    assert.deepEqual(M.decodeTombs(M.encodeTombs(tombs)), tombs);
});

test("size budget: full state fits the 56 KB relay cap", () => {
    const longNick = "ж".repeat(32);
    const list = Array.from({ length: 100 }, () => M.normFriend(fr({ nick: longNick, alias: longNick })));
    const tombs = Array.from({ length: M.MAX_TOMBS }, (_, i) => ({ id: pad("t", 18) + String(i).padStart(4, "0"), at: NOW }));
    const payload = { k: "sy", dev: "abcdefghijkl", f: M.encodeFriends(list), t: M.encodeTombs(tombs),
        p: [true, NOW], set: { nickname: { v: longNick, at: NOW }, lang: { v: "ru", at: NOW } },
        dv: M.encodeDevices(Array.from({ length: M.MAX_DEVICES }, (_, i) => ({ id: dev(i), os: "windows", app: "firefox", seen: NOW }))),
        rv: M.encodeRevoked(Array.from({ length: M.MAX_REVOKED }, (_, i) => ({ id: dev(100 + i), at: NOW }))) };
    const bytes = new TextEncoder().encode(JSON.stringify(payload)).length;
    const sealed = 23 + Math.ceil((12 + bytes + 16) / 3) * 4; // label + b64(iv|ct|tag)
    assert.ok(sealed < 56 * 1024, `sealed ${sealed} B`);
});

test("stateKey: equal for equal content regardless of order", () => {
    const a = fr(), b = fr();
    assert.equal(M.stateKey(st([a, b])), M.stateKey(st([b, a])));
    assert.notEqual(M.stateKey(st([a])), M.stateKey(st([a, b])));
});

/* ---------- my devices ---------- */
function dev(i) { return "d" + String(i).padStart(11, "0"); }
const dst = (devices = [], revoked = []) => ({ friends: [], tombs: [], devices, revoked });

test("devices: union, newest seen wins (name too), canonical both ways", () => {
    const a = dst([{ id: dev(1), os: "mac", app: "app", seen: NOW - 10 }, { id: dev(2), os: "iphone", app: "safari", seen: NOW - 5 }]);
    const b = dst([{ id: dev(1), os: "mac", app: "app", seen: NOW }, { id: dev(3), os: "windows", app: "app", seen: NOW - 1 }]);
    const x = merge(a, b), y = merge(b, a);
    assert.deepEqual(x.devices, y.devices);
    assert.equal(x.devices.length, 3);
    assert.equal(x.devices.find(d => d.id === dev(1)).seen, NOW);
});

test("devices: revoked id is dropped and never comes back", () => {
    const a = dst([{ id: dev(1), os: "mac", app: "app", seen: NOW }, { id: dev(2), os: "iphone", app: "safari", seen: NOW }]);
    const b = dst([], [{ id: dev(2), at: NOW - 100 }]);
    const m = merge(a, b);
    assert.deepEqual(m.devices.map(d => d.id), [dev(1)]);
    assert.deepEqual(m.revoked.map(r => r.id), [dev(2)]);
    /* the unlinked device still reports itself with a newer seen: still out */
    const again = merge(m, dst([{ id: dev(2), os: "iphone", app: "safari", seen: NOW + 999 }]));
    assert.deepEqual(again.devices.map(d => d.id), [dev(1)]);
});

test("devices: junk is filtered, caps hold", () => {
    const m = merge(dst([{ id: "short", os: "mac", app: "app", seen: NOW }, { id: dev(1), os: "<b>", app: "x y", seen: NOW }]), null);
    assert.equal(m.devices.length, 1);
    assert.equal(m.devices[0].os, "other");
    assert.equal(m.devices[0].app, "web");
    const many = Array.from({ length: 40 }, (_, i) => ({ id: dev(i), os: "mac", app: "app", seen: NOW - i }));
    const revs = Array.from({ length: 200 }, (_, i) => ({ id: dev(500 + i), at: NOW - i }));
    const c = merge(dst(many, revs), null);
    assert.equal(c.devices.length, M.MAX_DEVICES);
    assert.equal(c.revoked.length, M.MAX_REVOKED);
    assert.ok(c.devices.some(d => d.id === dev(0)), "keeps the most recently seen");
});

test("stateKey changes when a device is revoked", () => {
    const a = dst([{ id: dev(1), os: "mac", app: "app", seen: NOW }]);
    assert.notEqual(M.stateKey(a), M.stateKey(dst([], [{ id: dev(1), at: NOW }])));
});
