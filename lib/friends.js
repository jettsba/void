/* ========= FRIENDS: presence rendezvous + blind relay =========
 * The server never sees keys, nicks or who is whose friend. Clients register
 * opaque tokens (HMAC of a per-friendship secret and the UTC day); two sockets
 * that registered the same token are friends who are both online. The server
 * only tells them "match on token X" and then relays encrypted blobs between
 * the matched pair. Everything lives in RAM and dies with the socket.
 *
 * Token roles: a client ANNOUNCES "I am online" tokens and LISTENS for its
 * friends' tokens. A match is announce(X) on one socket + listen(X) on another,
 * and only the listener is told. Invisible mode = announce nothing.
 *
 * Invites (friend link, device transfer): the author registers h = SHA-256(T)
 * and the opener presents h once. T itself never reaches the server.
 * A "multi" invite is the friend-code handle (nick#0198): it is not consumed
 * on use and lives while the socket does. First owner of an h keeps it.
 *
 * Tokens and hashes are never logged.
 */

import crypto from "node:crypto";
import { log } from "./log.js";

const TOKEN_RX = /^[A-Za-z0-9_-]{22}$/;
const HASH_RX = /^[A-Za-z0-9_-]{43}$/;
const PEER_RX = /^[A-Za-z0-9_-]{16}$/;

export const FR_MAX_TOKENS = 256;              // per list, per socket (100 friends × 2 days)
export const FR_MAX_INVITES = 4;                // open invites per socket
export const FR_MAX_RELAY_BYTES = 56 * 1024;    // transfer = key + 100 friends, fits under WS 64 KB
const FR_TOTAL_TOKENS_CAP = Number(process.env.FR_TOTAL_TOKENS_CAP) || 500_000;
const INVITE_LINK_TTL_MS = 10 * 60 * 1000;      // pair stays linked while the request is answered
const RELAY_BUCKET_CAP = 150;                   // burst: status to ~100 friends on connect
const RELAY_REFILL_PER_SEC = 5;
const INVITE_USE_PER_MIN = 10;

const announceIndex = new Map();   // token → Set<ws>
const listenIndex = new Map();     // token → Set<ws>
const peers = new Map();           // peerId → ws
const invites = new Map();         // h → {ws, multi}
let totalTokens = 0;

function frState(ws) {
    if (!ws._fr) {
        let id;
        do id = crypto.randomBytes(12).toString("base64url"); while (peers.has(id));
        ws._fr = {
            id,
            announce: new Set(),
            listen: new Set(),
            invites: new Set(),
            links: new Map(),         // peerId → expiresAt (invite pairs)
            bucket: { tokens: RELAY_BUCKET_CAP, at: Date.now() },
            inviteUses: [],
        };
        peers.set(id, ws);
    }
    return ws._fr;
}

function send(ws, msg) {
    if (!ws || ws.readyState !== 1) return;
    try { ws.send(JSON.stringify(msg)); } catch (err) {
        log.warn("ws", "friends send failed", { err: err?.message || String(err) });
    }
}

function indexAdd(index, token, ws) {
    let set = index.get(token);
    if (!set) index.set(token, (set = new Set()));
    set.add(ws);
    totalTokens++;
}

function indexDel(index, token, ws) {
    const set = index.get(token);
    if (!set || !set.delete(ws)) return;
    totalTokens--;
    if (set.size === 0) index.delete(token);
}

function cleanTokenList(list) {
    if (!Array.isArray(list) || list.length > FR_MAX_TOKENS) return null;
    const out = new Set();
    for (const t of list) {
        if (typeof t !== "string" || !TOKEN_RX.test(t)) return null;
        out.add(t);
    }
    return out;
}

/** Full replace of the socket's token sets; notifies only what changed. */
export function handleFriendPresence(ws, data) {
    const announce = cleanTokenList(data?.announce);
    const listen = cleanTokenList(data?.listen);
    if (!announce || !listen) return;
    const st = frState(ws);

    const added = announce.size + listen.size - st.announce.size - st.listen.size;
    if (added > 0 && totalTokens + added > FR_TOTAL_TOKENS_CAP) {
        log.warn("security", "friends token cap reached", { ip: ws._ip });
        return;
    }

    for (const t of st.announce) {
        if (announce.has(t)) continue;
        indexDel(announceIndex, t, ws);
        for (const l of listenIndex.get(t) || []) {
            if (l !== ws) send(l, { type: "fr-offline", t, peer: st.id });
        }
    }
    for (const t of st.listen) {
        if (!listen.has(t)) indexDel(listenIndex, t, ws);
    }
    for (const t of announce) {
        if (st.announce.has(t)) continue;
        indexAdd(announceIndex, t, ws);
        for (const l of listenIndex.get(t) || []) {
            if (l !== ws) send(l, { type: "fr-online", t, peer: st.id });
        }
    }
    for (const t of listen) {
        if (st.listen.has(t)) continue;
        indexAdd(listenIndex, t, ws);
        for (const a of announceIndex.get(t) || []) {
            if (a !== ws) send(ws, { type: "fr-online", t, peer: a._fr.id });
        }
    }
    st.announce = announce;
    st.listen = listen;
}

function tokenLinked(a, b) {
    const sa = a._fr, sb = b._fr;
    if (!sa || !sb) return false;
    for (const t of sa.announce) if (sb.listen.has(t)) return true;
    for (const t of sa.listen) if (sb.announce.has(t)) return true;
    return false;
}

function inviteLinked(a, b) {
    const exp = a._fr?.links.get(b._fr.id);
    if (!exp) return false;
    if (exp < Date.now()) {
        a._fr.links.delete(b._fr.id);
        return false;
    }
    return true;
}

function relayAllowed(st) {
    const now = Date.now();
    const b = st.bucket;
    b.tokens = Math.min(RELAY_BUCKET_CAP, b.tokens + (now - b.at) / 1000 * RELAY_REFILL_PER_SEC);
    b.at = now;
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
}

/** Encrypted blob to a matched peer. Unlinked target = silently dropped. */
export function handleFriendRelay(ws, data) {
    const to = data?.to;
    const d = data?.d;
    if (typeof to !== "string" || !PEER_RX.test(to)) return;
    if (typeof d !== "string" || d.length === 0 || d.length > FR_MAX_RELAY_BYTES) return;
    const st = frState(ws);
    const target = peers.get(to);
    if (!target || target === ws) return;
    if (!tokenLinked(ws, target) && !inviteLinked(ws, target)) return;
    if (!relayAllowed(st)) return;
    send(target, { type: "fr-msg", from: st.id, d });
}

export function handleFriendInviteOpen(ws, data) {
    const h = data?.h;
    if (typeof h !== "string" || !HASH_RX.test(h)) return;
    const st = frState(ws);
    if (st.invites.has(h) || st.invites.size >= FR_MAX_INVITES) return;
    if (invites.has(h)) return;
    invites.set(h, { ws, multi: data.multi === true });
    st.invites.add(h);
}

export function handleFriendInviteClose(ws, data) {
    const h = data?.h;
    const st = ws._fr;
    if (!st || typeof h !== "string" || !st.invites.has(h)) return;
    st.invites.delete(h);
    if (invites.get(h)?.ws === ws) invites.delete(h);
}

/** Opener presents h once: the invite is consumed and the pair gets linked. */
export function handleFriendInviteUse(ws, data) {
    const h = data?.h;
    const d = data?.d;
    if (typeof h !== "string" || !HASH_RX.test(h)) return;
    if (typeof d !== "string" || d.length === 0 || d.length > FR_MAX_RELAY_BYTES) return;
    const st = frState(ws);
    const now = Date.now();
    st.inviteUses = st.inviteUses.filter(at => now - at < 60_000);
    if (st.inviteUses.length >= INVITE_USE_PER_MIN) return;
    st.inviteUses.push(now);

    const inv = invites.get(h);
    const owner = inv?.ws;
    if (!owner || owner === ws || owner.readyState !== 1) {
        send(ws, { type: "fr-invite-res", h, ok: false });
        return;
    }
    if (!inv.multi) {
        invites.delete(h);
        owner._fr.invites.delete(h);
    }
    const exp = now + INVITE_LINK_TTL_MS;
    owner._fr.links.set(st.id, exp);
    st.links.set(owner._fr.id, exp);
    send(owner, { type: "fr-invite-hit", h, from: st.id, d });
    send(ws, { type: "fr-invite-res", h, ok: true });
}

export function handleFriendDisconnect(ws) {
    const st = ws._fr;
    if (!st) return;
    for (const t of st.announce) {
        indexDel(announceIndex, t, ws);
        for (const l of listenIndex.get(t) || []) {
            if (l !== ws) send(l, { type: "fr-offline", t, peer: st.id });
        }
    }
    for (const t of st.listen) indexDel(listenIndex, t, ws);
    for (const h of st.invites) if (invites.get(h)?.ws === ws) invites.delete(h);
    peers.delete(st.id);
    ws._fr = null;
}

/* For tests. */
export function _friendsStats() {
    return { tokens: totalTokens, peers: peers.size, invites: invites.size };
}
