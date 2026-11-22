/* ===== Friends: presence socket + protocol (window.VoidFriends) =====
   Separate WebSocket, independent of the room socket (that one lives only
   while you are in a room). Opened only when there is something to do: at
   least one friend, an open invite link or a transfer in progress.

   Server side: lib/friends.js. Protocol and crypto: tasks/friends-plan.md.
   UI lives in js/friends/ui.js and talks to this module only through the
   API at the bottom + onChange + "void:friends-event" DOM events. */
(function () {
    "use strict";

    const S = window.VoidFriendStore;
    if (!S || !window.crypto?.subtle || !window.indexedDB) return;

    const OFFLINE_DEBOUNCE_MS = 6000;
    const LIVENESS_MS = 75_000;               // server keepalive is every 30 s
    const RECONNECT_DELAYS_MS = [1000, 2000, 4000, 8000, 15000, 30000];
    const LINK_TTL_MS = 24 * 60 * 60 * 1000;
    const TRANSFER_TTL_MS = 10 * 60 * 1000;
    const SESSION_TTL_MS = 10 * 60 * 1000;    // answering an invite request
    const STATUS_POLL_MS = 2000;
    const MAX_DECLINES = 3;               // per person per session, then auto-decline
    const MAX_OWNED_LINKS = 2;            // + friend-code handle + transfer = server cap 4

    let ws = null;
    let reconnectTimer = null;
    let reconnectAttempt = 0;
    let livenessTimer = null;
    let lastServerMsgAt = 0;
    let dayTimer = null;
    let statusTimer = null;

    /* token → {pub, dir} for the current presence set (both directions). */
    let tokenIndex = new Map();
    /* pub → {chans: Map<peer, {tokens:Set, status}>, offTimer, shownOnline} */
    const presence = new Map();
    /* Invites: label h → {kind:"link"|"merge", secret, exp, role:"owner"|"opener", ...} */
    const invites = new Map();
    /* Requests in progress. */
    const incoming = [];                       // {id, via, nick, pub, n, userId?, peer?, h?, at}
    const roomOut = new Map();                 // userId → {n, nick, at}
    const roomFin = new Map();                 // userId → {pub, s, nick}   (accepted, waiting for fin)
    const linkFin = new Map();                 // "h|peer" → {pub, s, nick, peer}
    const declines = new Map();                // userId → times declined this session
    /* userId in my current room → pub of a friend. */
    const roomFriends = new Map();

    let lastStatusJson = "";
    let seq = 0;
    const listeners = new Set();

    function emitChange() {
        for (const fn of listeners) { try { fn(); } catch (e) { console.warn(e); } }
    }
    function event(kind, detail = {}) {
        window.dispatchEvent(new CustomEvent("void:friends-event", { detail: { kind, ...detail } }));
    }
    function myNick() {
        return S.cleanNick(window.currentUsername || (typeof currentUsername !== "undefined" ? currentUsername : "")) || "void";
    }
    function inRoom() {
        return typeof isJoined !== "undefined" && isJoined && typeof currentRoomCode !== "undefined" && !!currentRoomCode;
    }

    /* ---------- socket ---------- */
    function wanted() {
        return !!S.pub && (S.friends.length > 0 || invites.size > 0);
    }

    function wsUrl() {
        return window.VoidWsBase || `wss://${location.host}`;
    }

    function send(msg) {
        if (ws && ws.readyState === 1) {
            try { ws.send(JSON.stringify(msg)); return true; } catch (_) {}
        }
        return false;
    }

    function ensureSocket() {
        if (wanted()) {
            if (!ws && !reconnectTimer) connect();
        } else if (ws) {
            const old = ws;
            ws = null;
            old._intentional = true;
            try { old.close(1000); } catch (_) {}
            dropAllPresence();
        }
    }

    function connect() {
        let sock;
        try { sock = new WebSocket(wsUrl()); } catch (_) { scheduleReconnect(); return; }
        ws = sock;
        sock.addEventListener("open", () => {
            if (ws !== sock) return;
            reconnectAttempt = 0;
            lastServerMsgAt = Date.now();
            startLiveness();
            pushPresence();
            for (const [h, inv] of invites) {
                if (inv.role === "owner" && !inv.used) send({ type: "fr-invite-open", h, multi: !!inv.multi });
            }
        });
        sock.addEventListener("message", (e) => {
            if (ws !== sock) return;
            lastServerMsgAt = Date.now();
            let data;
            try { data = JSON.parse(e.data); } catch (_) { return; }
            if (data && typeof data === "object") onServer(data);
        });
        sock.addEventListener("close", () => {
            if (ws === sock) ws = null;
            stopLiveness();
            if (sock._intentional) return;
            dropAllPresence();
            scheduleReconnect();
        });
        sock.addEventListener("error", () => {});
    }

    function scheduleReconnect(fast) {
        if (reconnectTimer || !wanted()) return;
        const delay = fast ? 500 : RECONNECT_DELAYS_MS[Math.min(reconnectAttempt, RECONNECT_DELAYS_MS.length - 1)];
        reconnectAttempt++;
        reconnectTimer = setTimeout(() => {
            reconnectTimer = null;
            if (!ws && wanted()) connect();
        }, delay + Math.random() * 400);
    }

    function startLiveness() {
        stopLiveness();
        livenessTimer = setInterval(() => {
            if (ws && Date.now() - lastServerMsgAt > LIVENESS_MS) {
                try { ws.close(); } catch (_) {}
            }
        }, 15_000);
    }
    function stopLiveness() {
        if (livenessTimer) { clearInterval(livenessTimer); livenessTimer = null; }
    }

    window.addEventListener("online", () => {
        if (!ws && wanted()) {
            clearTimeout(reconnectTimer);
            reconnectTimer = null;
            reconnectAttempt = 0;
            connect();
        }
    });

    /* ---------- presence ---------- */
    function utcDay(offsetDays) {
        return new Date(Date.now() - offsetDays * 86_400_000).toISOString().slice(0, 10);
    }

    async function pushPresence() {
        scheduleDayRollover();
        const days = [utcDay(0), utcDay(1)];
        const invisible = !!S.prefs.invisible;
        const index = new Map();
        const announce = [], listen = [];
        for (const f of S.friends) {
            for (const day of days) {
                const a = await S.presenceToken(f.s, f.role, day);
                const l = await S.presenceToken(f.s, 1 - f.role, day);
                index.set(a, { pub: f.pub, dir: "announce" });
                index.set(l, { pub: f.pub, dir: "listen" });
                if (!invisible) announce.push(a);
                listen.push(l);
            }
        }
        tokenIndex = index;
        /* Channels whose tokens are gone (friend removed) are dropped here;
           the rest get refreshed by the server's fr-online/fr-offline. */
        for (const pub of [...presence.keys()]) {
            if (!S.find(pub)) presence.delete(pub);
        }
        send({ type: "fr-presence", announce, listen });
        ensureStatusLoop();
        emitChange();
    }

    function scheduleDayRollover() {
        clearTimeout(dayTimer);
        const now = Date.now();
        const next = Math.ceil((now + 1) / 86_400_000) * 86_400_000 + 30_000;
        dayTimer = setTimeout(() => { if (ws) pushPresence(); }, next - now);
    }

    function presenceOf(pub) {
        let p = presence.get(pub);
        if (!p) presence.set(pub, (p = { chans: new Map(), offTimer: null, shownOnline: false }));
        return p;
    }

    function chanUp(pub, peer, token) {
        const p = presenceOf(pub);
        let ch = p.chans.get(peer);
        const isNew = !ch;
        if (!ch) p.chans.set(peer, (ch = { tokens: new Set(), status: null }));
        ch.tokens.add(token);
        if (p.offTimer) { clearTimeout(p.offTimer); p.offTimer = null; }
        if (!p.shownOnline) { p.shownOnline = true; emitChange(); }
        if (isNew) sendStatusTo(pub, peer);
    }

    function chanDown(pub, peer, token) {
        const p = presence.get(pub);
        const ch = p?.chans.get(peer);
        if (!ch) return;
        ch.tokens.delete(token);
        if (ch.tokens.size) return;
        p.chans.delete(peer);
        if (p.chans.size === 0) scheduleOffline(pub);
        else emitChange();
        refreshRoomFriends();
    }

    /* A WS blip on either side = offline then online again within seconds.
       The row should not blink, so "offline" is shown only if it sticks. */
    function scheduleOffline(pub) {
        const p = presence.get(pub);
        if (!p || p.offTimer) return;
        p.offTimer = setTimeout(() => {
            p.offTimer = null;
            if (p.chans.size === 0) {
                p.shownOnline = false;
                refreshRoomFriends();
                emitChange();
            }
        }, OFFLINE_DEBOUNCE_MS);
    }

    function dropAllPresence() {
        for (const [pub, p] of presence) {
            p.chans.clear();
            scheduleOffline(pub);
        }
    }

    /* ---------- status ---------- */
    function myStatus() {
        const room = inRoom() ? currentRoomCode : null;
        const closed = !!(room && typeof roomCloseState !== "undefined" && roomCloseState.closed);
        return {
            k: "st",
            nick: myNick(),
            pub: S.pub,
            room,
            closed,
            uid: room && typeof clientId !== "undefined" ? clientId : null,
        };
    }

    function sealFor(pub, label, obj) {
        const f = S.find(pub);
        if (!f) return Promise.resolve(null);
        return S.seal(f.s, "msg", label, obj);
    }

    async function sendFriendMsg(pub, peer, obj) {
        const ch = presence.get(pub)?.chans.get(peer);
        const label = ch && [...ch.tokens][0];
        if (!label) return;
        const d = await sealFor(pub, label, obj);
        if (d) send({ type: "fr-relay", to: peer, d });
    }

    function sendStatusTo(pub, peer) {
        if (S.prefs.invisible) return;
        sendFriendMsg(pub, peer, myStatus());
    }

    function broadcastStatus() {
        if (S.prefs.invisible) return;
        const st = myStatus();
        for (const [pub, p] of presence) {
            for (const peer of p.chans.keys()) sendFriendMsg(pub, peer, st);
        }
    }

    function ensureStatusLoop() {
        if (statusTimer) return;
        statusTimer = setInterval(pushStatusIfChanged, STATUS_POLL_MS);
    }

    /* New channels get the current status in chanUp; this only pushes
       CHANGES to channels that already have the old one. A broadcast with no
       channels is a no-op, so no "first tick" skip (it used to swallow a room
       change made right after a re-push). Runs on the poll tick and right on
       a join / leave, so friends see the room change at once. */
    function pushStatusIfChanged() {
        if (!ws) return;
        const json = JSON.stringify(myStatus());
        if (json === lastStatusJson) return;
        lastStatusJson = json;
        syncHandle();
        broadcastStatus();
        refreshRoomFriends();
    }

    function friendStatus(pub) {
        const p = presence.get(pub);
        if (!p) return null;
        let best = null;
        for (const ch of p.chans.values()) {
            if (ch.status && (!best || ch.status.at > best.at)) best = ch.status;
        }
        return best;
    }

    function refreshRoomFriends() {
        /* Friends met in this room right now stay marked; ones recognised by
           status are re-derived (they can leave or switch rooms). */
        for (const [uid, entry] of [...roomFriends]) {
            if (!entry.local) roomFriends.delete(uid);
        }
        if (inRoom()) {
            for (const f of S.friends) {
                const st = friendStatus(f.pub);
                if (st && st.room === currentRoomCode && st.uid && !roomFriends.has(st.uid)) {
                    roomFriends.set(st.uid, { pub: f.pub, local: false });
                }
            }
        }
        emitChange();
    }

    /* ---------- server messages ---------- */
    function onServer(m) {
        switch (m.type) {
            case "fr-online": {
                const e = tokenIndex.get(m.t);
                if (e && e.dir === "listen" && typeof m.peer === "string") chanUp(e.pub, m.peer, m.t);
                break;
            }
            case "fr-offline": {
                const e = tokenIndex.get(m.t);
                if (e) chanDown(e.pub, m.peer, m.t);
                break;
            }
            case "fr-msg":
                onRelay(m.from, m.d);
                break;
            case "fr-invite-hit":
                onInviteHit(m.h, m.from, m.d);
                break;
            case "fr-invite-res":
                onInviteRes(m.h, m.ok === true);
                break;
            case "server-restarting":
                if (ws) { const s = ws; ws = null; try { s.close(); } catch (_) {} scheduleReconnect(true); }
                break;
        }
    }

    function splitEnvelope(d) {
        if (typeof d !== "string") return null;
        const i = d.indexOf(".");
        if (i <= 0) return null;
        return { label: d.slice(0, i), body: d.slice(i + 1) };
    }

    async function onRelay(peer, d) {
        const env = splitEnvelope(d);
        if (!env || typeof peer !== "string") return;
        const tok = tokenIndex.get(env.label);
        if (tok) {
            const f = S.find(tok.pub);
            if (!f) return;
            const msg = await S.open(f.s, "msg", env.label, env.body);
            if (msg) onFriendMsg(f, peer, env.label, msg);
            return;
        }
        const inv = invites.get(env.label);
        if (inv) {
            const msg = await S.open(inv.secret, "inv", env.label, env.body);
            if (msg) onInviteMsg(env.label, inv, peer, msg);
        }
    }

    async function onFriendMsg(f, peer, label, msg) {
        if (msg.k === "st") {
            const p = presenceOf(f.pub);
            let ch = p.chans.get(peer);
            if (!ch) {
                p.chans.set(peer, (ch = { tokens: new Set([label]), status: null }));
                if (p.offTimer) { clearTimeout(p.offTimer); p.offTimer = null; }
                p.shownOnline = true;
            }
            const room = typeof msg.room === "string" && ROOM_CODE_RX_SAFE.test(msg.room) ? msg.room : null;
            ch.status = {
                at: ++seq,
                room,
                closed: room ? msg.closed === true : false,
                uid: room && typeof msg.uid === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(msg.uid) ? msg.uid : null,
            };
            await S.updateFriend(f.pub, { nick: msg.nick, pub: msg.pub });
            refreshRoomFriends();
            return;
        }
        if (msg.k === "rm") {
            await S.removeFriend(f.pub);
            presence.delete(f.pub);
            for (const [uid, e] of [...roomFriends]) if (e.pub === f.pub) roomFriends.delete(uid);
            pushPresence();
        }
    }

    const ROOM_CODE_RX_SAFE = /^[A-Z0-9]{3,12}$/;

    /* ---------- in-room requests (over the room DataChannel) ---------- */
    function sendRoom(userId, obj) {
        const ch = typeof chatChannels !== "undefined" ? chatChannels.get(userId) : null;
        if (!ch || ch.readyState !== "open") return false;
        try { ch.send(JSON.stringify({ type: "fr", ...obj })); return true; } catch (_) { return false; }
    }

    async function sendRoomRequest(userId) {
        await S.ready();
        if (roomOut.has(userId) || roomFriends.has(userId)) return false;
        const inc = incoming.find(r => r.via === "room" && r.userId === userId);
        if (inc) return acceptRequest(inc.id);
        if (S.friends.length >= S.MAX_FRIENDS) { event("limit"); return false; }
        const n = S.newNonce();
        if (!sendRoom(userId, { op: "req", pub: S.pub, nick: myNick(), n })) { event("unreachable"); return false; }
        roomOut.set(userId, { n, at: Date.now() });
        emitChange();
        return true;
    }

    async function onRoomMessage(userId, msg) {
        if (!msg || typeof msg.op !== "string") return;
        await S.ready();
        const nick = typeof nicknameMap !== "undefined" ? nicknameMap.get(userId) : "";
        if (msg.op === "req") {
            if (!S.isPub(msg.pub) || !S.isNonce(msg.n) || msg.pub === S.pub) return;
            if (incoming.some(r => r.via === "room" && r.userId === userId)) return;
            /* A re-request after a decline is shown again (the sender asked on
               purpose). Only someone declined MAX_DECLINES times gets an
               automatic "no" — never a silent drop that leaves them waiting. */
            if ((declines.get(userId) || 0) >= MAX_DECLINES) { sendRoom(userId, { op: "dec" }); return; }
            const req = { id: "r" + (++seq), via: "room", userId, pub: msg.pub, n: msg.n, nick: S.cleanNick(nick) || S.cleanNick(msg.nick), at: Date.now() };
            /* Both pressed "+" on each other: that is consent from both sides. */
            if (roomOut.has(userId)) {
                incoming.push(req);
                roomOut.delete(userId);
                return acceptRequest(req.id);
            }
            incoming.push(req);
            emitChange();
            event("incoming", { nick: req.nick });
            return;
        }
        if (msg.op === "acc") {
            const out = roomOut.get(userId);
            if (!out || !S.isPub(msg.pub) || !S.isNonce(msg.n)) return;
            const s = await S.deriveSecret(msg.pub, out.n, msg.n);
            if (!S.macEqual(msg.m, await S.mac(s, "acc"))) return;
            roomOut.delete(userId);
            const entry = await S.addFriend({ pub: msg.pub, s, nick: nick || msg.nick });
            sendRoom(userId, { op: "fin", m: await S.mac(s, "fin") });
            if (entry) befriendedInRoom(userId, entry);
            return;
        }
        if (msg.op === "fin") {
            const p = roomFin.get(userId);
            if (!p || !S.macEqual(msg.m, await S.mac(p.s, "fin"))) return;
            roomFin.delete(userId);
            const entry = await S.addFriend({ pub: p.pub, s: p.s, nick: nick || p.nick });
            if (entry) befriendedInRoom(userId, entry);
            return;
        }
        if (msg.op === "dec") {
            if (roomOut.delete(userId)) { emitChange(); event("declined", { nick }); }
        }
    }

    function befriendedInRoom(userId, entry) {
        roomFriends.set(userId, { pub: entry.pub, local: true });
        event("added", { nick: entry.alias || entry.nick });
        ensureSocket();
        pushPresence();
    }

    /* Requests die with the room connection: no queue anywhere. */
    window.addEventListener("void:participants-changed", () => {
        const here = (uid) => typeof nicknameMap !== "undefined" && nicknameMap.has(uid);
        let changed = false;
        for (let i = incoming.length - 1; i >= 0; i--) {
            if (incoming[i].via === "room" && !here(incoming[i].userId)) { incoming.splice(i, 1); changed = true; }
        }
        for (const uid of [...roomOut.keys()]) if (!here(uid)) { roomOut.delete(uid); changed = true; }
        for (const uid of [...roomFin.keys()]) if (!here(uid)) roomFin.delete(uid);
        for (const uid of [...roomFriends.keys()]) if (!here(uid)) { roomFriends.delete(uid); changed = true; }
        if (changed) emitChange();
        pushStatusIfChanged();
    });

    /* ---------- accept / decline (room and link) ---------- */
    async function acceptRequest(id) {
        const i = incoming.findIndex(r => r.id === id);
        if (i < 0) return false;
        const req = incoming[i];
        incoming.splice(i, 1);
        emitChange();
        if (S.friends.length >= S.MAX_FRIENDS && !S.find(req.pub)) { event("limit"); return false; }
        const n = S.newNonce();
        const s = await S.deriveSecret(req.pub, req.n, n);
        const m = await S.mac(s, "acc");
        if (req.via === "room") {
            roomFin.set(req.userId, { pub: req.pub, s, nick: req.nick });
            return sendRoom(req.userId, { op: "acc", pub: S.pub, nick: myNick(), n, m });
        }
        const inv = invites.get(req.h);
        if (!inv) return false;
        linkFin.set(req.h + "|" + req.peer, { pub: req.pub, s, nick: req.nick, peer: req.peer });
        const d = await S.seal(inv.secret, "inv", req.h, { k: "lk-acc", pub: S.pub, nick: myNick(), n, m });
        return send({ type: "fr-relay", to: req.peer, d });
    }

    async function declineRequest(id) {
        const i = incoming.findIndex(r => r.id === id);
        if (i < 0) return;
        const req = incoming[i];
        incoming.splice(i, 1);
        emitChange();
        if (req.via === "room") {
            declines.set(req.userId, (declines.get(req.userId) || 0) + 1);
            sendRoom(req.userId, { op: "dec" });
        } else {
            const inv = invites.get(req.h);
            if (inv) {
                send({ type: "fr-relay", to: req.peer, d: await S.seal(inv.secret, "inv", req.h, { k: "lk-dec" }) });
                if (!inv.multi) invites.delete(req.h);
                ensureSocket();
            }
        }
    }

    /* ---------- invite links ---------- */
    function appBase() {
        if (window.VoidPlatform === "desktop" || /^tauri:|tauri\.localhost$/.test(location.protocol + location.hostname)) {
            return "https://app.void-room.space";
        }
        return location.origin;
    }

    function expireInvites() {
        const now = Date.now();
        for (const [h, inv] of [...invites]) {
            if (inv.exp < now) {
                invites.delete(h);
                if (inv.role === "owner" && !inv.used) send({ type: "fr-invite-close", h });
                if (inv.kind === "merge") event("transfer-expired");
            }
        }
    }
    setInterval(() => { expireInvites(); ensureSocket(); }, 30_000);

    async function createLink() {
        await S.ready();
        expireInvites();
        const owned = [...invites].filter(([, v]) => v.role === "owner" && v.kind === "link" && !v.used && !v.multi);
        while (owned.length >= MAX_OWNED_LINKS) {
            const [h] = owned.shift();
            invites.delete(h);
            send({ type: "fr-invite-close", h });
        }
        const secret = S.newSecret();
        const h = await S.sha256B64("friend|" + secret);
        invites.set(h, { kind: "link", role: "owner", secret, exp: Date.now() + LINK_TTL_MS, used: false });
        ensureSocket();
        send({ type: "fr-invite-open", h });
        return `${appBase()}/#friend=${secret}`;
    }

    function parseLinkSecret(s) {
        const m = String(s || "").match(/(?:friend[=/])?([A-Za-z0-9_-]{22})$/);
        return m ? m[1] : null;
    }

    async function waitOpen(timeoutMs = 10_000) {
        ensureSocket();
        const until = Date.now() + timeoutMs;
        while (!(ws && ws.readyState === 1)) {
            if (Date.now() > until) return false;
            await new Promise(r => setTimeout(r, 150));
        }
        return true;
    }

    async function useLink(raw) {
        const secret = parseLinkSecret(raw);
        if (!secret) { event("link-invalid"); return false; }
        await S.ready();
        const h = await S.sha256B64("friend|" + secret);
        if (invites.has(h)) { event("link-own"); return false; }
        const n = S.newNonce();
        invites.set(h, { kind: "link", role: "opener", secret, n, exp: Date.now() + SESSION_TTL_MS });
        if (!(await waitOpen())) { invites.delete(h); event("offline"); return false; }
        const d = await S.seal(secret, "inv", h, { k: "lk-req", pub: S.pub, nick: myNick(), n });
        send({ type: "fr-invite-use", h, d });
        emitChange();
        return true;
    }

    function onInviteRes(h, ok) {
        const inv = invites.get(h);
        if (!inv || inv.role !== "opener") return;
        if (ok) {
            event(inv.kind === "merge" ? "transfer-connected" : inv.via === "code" ? "tag-sent" : "link-sent");
            return;
        }
        invites.delete(h);
        emitChange();
        event(inv.kind === "merge" ? "transfer-not-found" : inv.via === "code" ? "tag-not-found" : "link-dead");
        ensureSocket();
    }

    async function onInviteHit(h, peer, d) {
        const inv = invites.get(h);
        if (!inv || inv.role !== "owner" || typeof peer !== "string") return;
        const env = splitEnvelope(d);
        if (!env || env.label !== h) return;
        const msg = await S.open(inv.secret, "inv", h, env.body);
        if (!msg) return;
        if (!inv.multi) {
            inv.used = true;
            inv.exp = Date.now() + SESSION_TTL_MS;
        }
        if (inv.kind === "link" && msg.k === "lk-req") {
            if (!S.isPub(msg.pub) || !S.isNonce(msg.n) || msg.pub === S.pub) return;
            /* The friend code is guessable: one pending request per key, and
               only a handful at once, so nobody floods the requests tab. */
            if (incoming.some(r => r.pub === msg.pub)) return;
            if (inv.multi && incoming.filter(r => r.via === "code").length >= 20) return;
            const via = inv.multi ? "code" : "link";
            incoming.push({ id: "r" + (++seq), via, h, peer, pub: msg.pub, n: msg.n, nick: S.cleanNick(msg.nick), at: Date.now() });
            emitChange();
            event("incoming", { nick: S.cleanNick(msg.nick), via });
            return;
        }
        if (inv.kind === "merge" && msg.k === "mg-req") {
            await S.absorbFriends(msg.friends);
            const out = await S.seal(inv.secret, "inv", h, { k: "mg-data", ...S.exportBundle() });
            send({ type: "fr-relay", to: peer, d: out });
            invites.delete(h);
            event("transfer-done", { role: "source" });
            pushPresence();
        }
    }

    async function onInviteMsg(h, inv, peer, msg) {
        if (inv.kind === "link" && inv.role === "opener") {
            if (msg.k === "lk-acc") {
                if (!S.isPub(msg.pub) || !S.isNonce(msg.n)) return;
                const s = await S.deriveSecret(msg.pub, inv.n, msg.n);
                if (!S.macEqual(msg.m, await S.mac(s, "acc"))) return;
                const entry = await S.addFriend({ pub: msg.pub, s, nick: msg.nick });
                send({ type: "fr-relay", to: peer, d: await S.seal(inv.secret, "inv", h, { k: "lk-fin", m: await S.mac(s, "fin") }) });
                invites.delete(h);
                if (entry) event("added", { nick: entry.alias || entry.nick });
                pushPresence();
            } else if (msg.k === "lk-dec") {
                invites.delete(h);
                event("declined", { via: inv.via || "link" });
                ensureSocket();
            }
            emitChange();
            return;
        }
        if (inv.kind === "link" && inv.role === "owner" && msg.k === "lk-fin") {
            const p = linkFin.get(h + "|" + peer);
            if (!p || !S.macEqual(msg.m, await S.mac(p.s, "fin"))) return;
            linkFin.delete(h + "|" + peer);
            if (!inv.multi) invites.delete(h);
            const entry = await S.addFriend({ pub: p.pub, s: p.s, nick: p.nick });
            if (entry) event("added", { nick: entry.alias || entry.nick });
            pushPresence();
            return;
        }
        if (inv.kind === "merge" && inv.role === "opener" && msg.k === "mg-data") {
            invites.delete(h);
            try {
                await S.adoptBundle(msg);
                await syncHandle();
                event("transfer-done", { role: "target" });
            } catch (_) {
                event("transfer-failed");
            }
            pushPresence();
            emitChange();
        }
    }

    /* ---------- friend code (nick#0198) ---------- */
    /* My code is a multi-use invite on the server (h of the lowercase tag).
       Anyone who knows the tag can derive its key, so this channel is only as
       private as the tag; the friendship security code in the profile is what
       proves nobody sat in the middle. Invisible = not registered at all. */
    let handleH = null;

    async function myTag() {
        await S.ready();
        const code = await S.friendCode(S.pub);
        const nick = S.cleanTagNick(myNick());
        return { nick, code, tag: `${nick}#${code}`, display: `${nick}#${code}` };
    }

    async function tagKeys(tag) {
        return { h: await S.sha256B64("tag-h|" + tag), secret: await S.sha256B64("tag-k|" + tag) };
    }

    let handleBusy = false;
    async function syncHandle() {
        if (handleBusy || !S.pub) return;
        handleBusy = true;
        try {
            const want = S.prefs.invisible ? null : await myTag();
            const keys = want ? await tagKeys(want.tag) : null;
            if (handleH && handleH !== keys?.h) {
                invites.delete(handleH);
                send({ type: "fr-invite-close", h: handleH });
                handleH = null;
            }
            if (keys && !handleH) {
                handleH = keys.h;
                invites.set(keys.h, { kind: "link", role: "owner", multi: true, secret: keys.secret, exp: Infinity });
                ensureSocket();
                send({ type: "fr-invite-open", h: keys.h, multi: true });
            }
            ensureSocket();
        } finally {
            handleBusy = false;
        }
    }

    async function useTag(raw) {
        const t = S.parseTag(raw);
        if (!t) { event("tag-invalid"); return false; }
        if (t.tag === (await myTag()).tag) { event("tag-own"); return false; }
        const { h, secret } = await tagKeys(t.tag);
        const n = S.newNonce();
        invites.set(h, { kind: "link", role: "opener", via: "code", tag: t.tag, secret, n, exp: Date.now() + SESSION_TTL_MS });
        if (!(await waitOpen())) { invites.delete(h); event("offline"); return false; }
        const d = await S.seal(secret, "inv", h, { k: "lk-req", pub: S.pub, nick: myNick(), n });
        send({ type: "fr-invite-use", h, d });
        emitChange();
        return true;
    }

    /* ---------- device transfer ---------- */
    async function transferKeys(code) {
        return {
            h: await S.sha256B64("transfer-h|" + code),
            secret: await S.sha256B64("transfer-k|" + code),
        };
    }

    async function startTransfer() {
        await S.ready();
        cancelTransfer();
        const code = S.newTransferCode();
        const { h, secret } = await transferKeys(code);
        invites.set(h, { kind: "merge", role: "owner", secret, code, exp: Date.now() + TRANSFER_TTL_MS, used: false });
        ensureSocket();
        send({ type: "fr-invite-open", h });
        return { code, exp: Date.now() + TRANSFER_TTL_MS };
    }

    function cancelTransfer() {
        for (const [h, inv] of [...invites]) {
            if (inv.kind !== "merge") continue;
            invites.delete(h);
            if (inv.role === "owner" && !inv.used) send({ type: "fr-invite-close", h });
        }
        ensureSocket();
    }

    async function joinTransfer(raw) {
        const code = S.normalizeTransferCode(raw);
        if (!code) { event("transfer-not-found"); return false; }
        await S.ready();
        const { h, secret } = await transferKeys(code);
        if (invites.get(h)?.role === "owner") { event("transfer-own"); return false; }
        invites.set(h, { kind: "merge", role: "opener", secret, exp: Date.now() + SESSION_TTL_MS });
        if (!(await waitOpen())) { invites.delete(h); event("offline"); return false; }
        const d = await S.seal(secret, "inv", h, { k: "mg-req", friends: S.exportBundle().friends });
        send({ type: "fr-invite-use", h, d });
        return true;
    }

    /* ---------- friend actions ---------- */
    async function removeFriend(pub) {
        const p = presence.get(pub);
        if (p) for (const peer of p.chans.keys()) await sendFriendMsg(pub, peer, { k: "rm" });
        await S.removeFriend(pub);
        presence.delete(pub);
        for (const [uid, e] of [...roomFriends]) if (e.pub === pub) roomFriends.delete(uid);
        pushPresence();
        ensureSocket();
    }

    async function setInvisible(on) {
        await S.setPrefs({ invisible: !!on });
        await syncHandle();
        pushPresence();
        /* Going visible: friends already online learn our status right away. */
        if (!on) broadcastStatus();
    }

    /* ---------- views for the UI ---------- */
    function view(f) {
        const p = presence.get(f.pub);
        const online = !!p?.shownOnline;
        const st = online ? friendStatus(f.pub) : null;
        return {
            pub: f.pub,
            nick: f.nick,
            alias: f.alias,
            name: f.alias || f.nick || "void",
            online,
            room: st?.room || null,
            closed: !!st?.closed,
        };
    }

    function list() {
        const rank = (v) => (v.room ? 0 : v.online ? 1 : 2);
        return S.friends.map(view).sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
    }

    function participantState(userId) {
        if (roomFriends.has(userId)) return "friend";
        if (roomOut.has(userId)) return "sent";
        if (incoming.some(r => r.via === "room" && r.userId === userId)) return "incoming";
        return "none";
    }

    /* Also straight from the last status a friend sent ("in room X as uid"):
       the blob is drawn the moment we join, before any status tick, so the
       label is right from the first frame instead of swapping in later. */
    function friendByUid(userId) {
        let pub = roomFriends.get(userId)?.pub;
        if (!pub && inRoom()) {
            for (const f of S.friends) {
                const st = friendStatus(f.pub);
                if (st && st.uid === userId && st.room === currentRoomCode) { pub = f.pub; break; }
            }
        }
        const f = pub && S.find(pub);
        return f ? view(f) : null;
    }

    function requests() {
        const outgoing = [];
        for (const [uid] of roomOut) {
            outgoing.push({ id: "o-" + uid, nick: (typeof nicknameMap !== "undefined" && nicknameMap.get(uid)) || "", via: "room" });
        }
        for (const [h, inv] of invites) {
            if (inv.kind === "link" && inv.role === "opener") outgoing.push({ id: "l-" + h, nick: inv.tag || "", via: inv.via || "link" });
        }
        return { incoming: incoming.map(r => ({ id: r.id, nick: r.nick, via: r.via, pub: r.pub })), outgoing };
    }

    S.onChange(() => { ensureSocket(); emitChange(); });

    S.ready().then(() => {
        syncHandle();
        ensureStatusLoop();
        emitChange();
    });

    window.VoidFriends = {
        onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
        ready: () => S.ready(),
        list,
        requests,
        participantState,
        friendByUid,
        sendRoomRequest,
        acceptRequest,
        declineRequest,
        onRoomMessage,
        createLink,
        useLink,
        parseLinkSecret,
        startTransfer,
        cancelTransfer,
        joinTransfer,
        removeFriend,
        renameFriend: (pub, alias) => S.updateFriend(pub, { alias }),
        setInvisible,
        get invisible() { return !!S.prefs.invisible; },
        get count() { return S.friends.length; },
        get myPub() { return S.pub; },
        myTag,
        useTag,
        friendCode: (pub) => S.friendCode(pub),
        pairIcons: async (pub) => { const f = S.find(pub); return f ? S.pairIcons(f.s) : null; },
    };
})();
