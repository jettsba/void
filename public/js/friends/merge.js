/* ===== Friends: device-sync merge (window.VoidFriendMerge) =====
   Pure functions, no crypto, no storage: shared by the device sync channel
   and the manual device transfer, and unit-tested in node
   (tests/unit/friends-merge.test.mjs). See tasks/device-sync-plan.md.

   State = {friends, tombs, prefs}
     friend {pub, s, role, nick, alias, added, aliasAt, seenAt}
       aliasAt — when alias was last set by me (LWW)
       seenAt  — when nick/pub last came from the friend's own status (LWW)
     tomb {id, at}   id = tombId(s): friendship removed, never comes back.
                     Re-befriending creates a new s, so a tomb can't kill it.
     prefs {invisible, invisibleAt}
     device {id, os, app, seen}   one of my devices (same key); seen = last
                     time any of my devices saw it online (max wins)
     revoked {id, at}  device unlinked: dropped from the list, and a device
                     that finds its own id here wipes its key and friends

   merge() is commutative and idempotent, output is canonical (sorted), so
   two devices that exchanged states end up byte-identical. */
(function (root) {
    "use strict";

    const MAX_FRIENDS = 100;
    const MAX_TOMBS = 150;
    const TOMB_TTL_MS = 180 * 86_400_000;
    const PUB_RX = /^[A-Za-z0-9_-]{87}$/;
    const S_RX = /^[A-Za-z0-9_-]{43}$/;
    const ID_RX = /^[A-Za-z0-9_-]{22}$/;
    const DEV_RX = /^[A-Za-z0-9_-]{12}$/;
    const WORD_RX = /^[a-z0-9]{1,12}$/;
    const MAX_DEVICES = 16;
    const MAX_REVOKED = 64;
    const REVOKED_TTL_MS = 365 * 86_400_000;

    function cleanNick(n) {
        return typeof n === "string" ? n.replace(/[\u0000-\u001f\u007f-\u009f]/g, "").trim().slice(0, 32) : "";
    }
    function ts(v) { return Number.isFinite(v) && v > 0 ? Math.floor(v) : 0; }
    function tombId(s) { return String(s).slice(0, 22); }

    /* Deterministic tie-break, so both sides pick the same value. */
    function cmp(a, b) { return a < b ? -1 : a > b ? 1 : 0; }

    function normFriend(f) {
        if (!f || typeof f !== "object") return null;
        if (!PUB_RX.test(f.pub) || !S_RX.test(f.s) || (f.role !== 0 && f.role !== 1)) return null;
        const added = ts(f.added) || 1;
        return {
            pub: f.pub,
            s: f.s,
            role: f.role,
            nick: cleanNick(f.nick),
            alias: cleanNick(f.alias),
            added,
            aliasAt: ts(f.aliasAt) || added,
            seenAt: ts(f.seenAt) || added,
        };
    }

    function normTomb(t) {
        if (Array.isArray(t)) t = { id: t[0], at: t[1] };
        if (!t || !ID_RX.test(t.id)) return null;
        const at = ts(t.at);
        return at ? { id: t.id, at } : null;
    }

    function normDevice(d) {
        if (Array.isArray(d)) d = { id: d[0], os: d[1], app: d[2], seen: d[3] };
        if (!d || !DEV_RX.test(d.id)) return null;
        return {
            id: d.id,
            os: WORD_RX.test(d.os) ? d.os : "other",
            app: WORD_RX.test(d.app) ? d.app : "web",
            seen: ts(d.seen),
        };
    }

    function normRevoked(r) {
        if (Array.isArray(r)) r = { id: r[0], at: r[1] };
        if (!r || !DEV_RX.test(r.id)) return null;
        const at = ts(r.at);
        return at ? { id: r.id, at } : null;
    }

    /* Revoked wins forever; per id the newest `seen` carries the name too,
       tie → lexicographic so both sides agree. */
    function mergeDevices(a, b, now) {
        const revoked = new Map();
        for (const raw of [...(a?.revoked || []), ...(b?.revoked || [])]) {
            const r = normRevoked(raw);
            if (!r) continue;
            const cur = revoked.get(r.id);
            if (!cur || r.at > cur.at) revoked.set(r.id, r);
        }
        const byId = new Map();
        for (const raw of [...(a?.devices || []), ...(b?.devices || [])]) {
            const d = normDevice(raw);
            if (!d || revoked.has(d.id)) continue;
            const cur = byId.get(d.id);
            const key = (x) => x.os + "|" + x.app;
            if (!cur || d.seen > cur.seen || (d.seen === cur.seen && cmp(key(d), key(cur)) > 0)) byId.set(d.id, d);
        }
        const devices = [...byId.values()]
            .sort((x, y) => y.seen - x.seen || cmp(x.id, y.id))
            .slice(0, MAX_DEVICES)
            .sort((x, y) => cmp(x.id, y.id));
        const revList = [...revoked.values()]
            .filter(r => now - r.at < REVOKED_TTL_MS)
            .sort((x, y) => y.at - x.at || cmp(x.id, y.id))
            .slice(0, MAX_REVOKED)
            .sort((x, y) => cmp(x.id, y.id));
        return { devices, revoked: revList };
    }

    function mergeFriend(a, b) {
        const out = { ...a };
        out.added = Math.min(a.added, b.added);
        if (b.aliasAt > a.aliasAt || (b.aliasAt === a.aliasAt && cmp(b.alias, a.alias) > 0)) {
            out.alias = b.alias; out.aliasAt = b.aliasAt;
        }
        const bWins = b.seenAt > a.seenAt ||
            (b.seenAt === a.seenAt && cmp(b.pub + "|" + b.nick, a.pub + "|" + a.nick) > 0);
        if (bWins) { out.pub = b.pub; out.nick = b.nick; out.seenAt = b.seenAt; }
        return out;
    }

    function mergePrefs(a, b) {
        const pa = { invisible: !!a?.invisible, invisibleAt: ts(a?.invisibleAt) };
        const pb = { invisible: !!b?.invisible, invisibleAt: ts(b?.invisibleAt) };
        if (pb.invisibleAt > pa.invisibleAt) return pb;
        if (pb.invisibleAt === pa.invisibleAt && pb.invisible && !pa.invisible) return pb;
        return pa;
    }

    /* opts: {selfPub, now} */
    function merge(a, b, opts = {}) {
        const now = ts(opts.now) || Date.now();
        const selfPub = opts.selfPub || null;

        /* 1. tombs: union, newest at wins */
        const tombs = new Map();
        const addTomb = (t) => {
            const n = normTomb(t);
            if (!n) return;
            const cur = tombs.get(n.id);
            if (!cur || n.at > cur.at) tombs.set(n.id, n);
        };
        for (const t of a?.tombs || []) addTomb(t);
        for (const t of b?.tombs || []) addTomb(t);

        /* 2. friends by s, minus tombed */
        const byS = new Map();
        for (const raw of [...(a?.friends || []), ...(b?.friends || [])]) {
            const f = normFriend(raw);
            if (!f || tombs.has(tombId(f.s))) continue;
            const cur = byS.get(f.s);
            byS.set(f.s, cur ? mergeFriend(cur, f) : f);
        }

        /* 3. one entry per person: re-befriended on one device → newest wins,
              the older friendship gets a deterministic tomb */
        const byPub = new Map();
        for (const f of byS.values()) {
            if (f.pub === selfPub) continue;
            const cur = byPub.get(f.pub);
            if (!cur) { byPub.set(f.pub, f); continue; }
            const [keep, drop] = f.added > cur.added || (f.added === cur.added && cmp(f.s, cur.s) > 0) ? [f, cur] : [cur, f];
            byPub.set(f.pub, keep);
            addTomb({ id: tombId(drop.s), at: keep.added });
        }

        /* 4. caps */
        let friends = [...byPub.values()].sort((x, y) => y.added - x.added || cmp(x.s, y.s));
        const overflow = Math.max(0, friends.length - MAX_FRIENDS);
        friends = friends.slice(0, MAX_FRIENDS).sort((x, y) => cmp(x.s, y.s));
        const tombList = [...tombs.values()]
            .filter(t => now - t.at < TOMB_TTL_MS)
            .sort((x, y) => y.at - x.at || cmp(x.id, y.id))
            .slice(0, MAX_TOMBS)
            .sort((x, y) => cmp(x.id, y.id));

        const dv = mergeDevices(a, b, now);
        return { friends, tombs: tombList, prefs: mergePrefs(a?.prefs, b?.prefs), overflow, devices: dv.devices, revoked: dv.revoked };
    }

    /* Settings: {key: {v, at}}. at = 0 means "never set on this device": it
       never wins and is not sent, so untouched defaults don't fight. */
    function mergeSettings(a, b, keys) {
        const out = {};
        for (const k of keys) {
            const x = a?.[k], y = b?.[k];
            const xa = ts(x?.at), ya = ts(y?.at);
            if (!xa && !ya) continue;
            if (ya > xa || (ya === xa && cmp(JSON.stringify(y.v), JSON.stringify(x.v)) > 0)) out[k] = { v: y.v, at: ya };
            else out[k] = { v: x.v, at: xa };
        }
        return out;
    }

    /* Compact wire form for the sync channel (keeps 100 friends well under
       the 56 KB relay cap). The transfer keeps object form for old clients. */
    const FIELDS = ["pub", "s", "role", "nick", "alias", "added", "aliasAt", "seenAt"];
    function encodeFriends(list) {
        return list.map(f => FIELDS.map(k => f[k]));
    }
    function decodeFriends(list) {
        if (!Array.isArray(list)) return [];
        return list.map(f => Array.isArray(f) ? Object.fromEntries(FIELDS.map((k, i) => [k, f[i]])) : f);
    }
    function encodeTombs(list) { return list.map(t => [t.id, t.at]); }
    function encodeDevices(list) { return (list || []).map(d => [d.id, d.os, d.app, d.seen]); }
    function encodeRevoked(list) { return (list || []).map(r => [r.id, r.at]); }
    function decodeTombs(list) { return Array.isArray(list) ? list.map(normTomb).filter(Boolean) : []; }

    /* Canonical key of a state: equal key = nothing to send. */
    function stateKey(st, settings) {
        const m = merge(st, null, { now: Date.now() });
        return JSON.stringify([encodeFriends(m.friends), encodeTombs(m.tombs),
            m.prefs.invisibleAt ? [m.prefs.invisible, m.prefs.invisibleAt] : 0, settings || {},
            encodeDevices(m.devices), encodeRevoked(m.revoked)]);
    }

    root.VoidFriendMerge = {
        MAX_FRIENDS, MAX_TOMBS, TOMB_TTL_MS,
        MAX_DEVICES, MAX_REVOKED, DEV_RX,
        cleanNick, tombId, normFriend, normDevice, normRevoked,
        merge, mergeDevices, mergeSettings, stateKey,
        encodeFriends, decodeFriends, encodeTombs, decodeTombs, encodeDevices, encodeRevoked,
    };
})(typeof window !== "undefined" ? window : globalThis);
