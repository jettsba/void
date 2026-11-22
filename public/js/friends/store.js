/* ===== Friends: identity, local storage, crypto (window.VoidFriendStore) =====
   Everything about friends lives on this device only (IndexedDB "void-friends").
   Identity = ECDH P-256 keypair: every WebView we ship has it (Ed25519 does not),
   and ECDH alone covers what we need — a per-friendship secret S plus key
   confirmation by MAC. Signatures are not needed anywhere.

   Friend entry: {pub, s, role, nick, alias, added}
     pub   — their raw public key, b64url (fingerprint + "same person" check)
     s     — friendship secret S, b64url (presence tokens + message key)
     role  — 0/1, fixed at befriending, picks which token direction is mine
   See tasks/friends-plan.md for the protocol. */
(function () {
    "use strict";

    const DB_NAME = "void-friends";
    const STORE = "kv";
    const MAX_FRIENDS = 100;
    const te = new TextEncoder();
    const td = new TextDecoder();
    const subtle = crypto.subtle;

    /* ---------- encoding ---------- */
    function b64u(bytes) {
        const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
        let s = "";
        for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
        return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    }
    function unb64u(str) {
        const s = String(str).replace(/-/g, "+").replace(/_/g, "/");
        const bin = atob(s + "===".slice((s.length + 3) % 4));
        const out = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
        return out;
    }
    function randomBytes(n) { return crypto.getRandomValues(new Uint8Array(n)); }
    function concat(...parts) {
        const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
        let o = 0;
        for (const p of parts) { out.set(p, o); o += p.length; }
        return out;
    }
    function isPub(p) { return typeof p === "string" && /^[A-Za-z0-9_-]{87}$/.test(p); }
    function isNonce(n) { return typeof n === "string" && /^[A-Za-z0-9_-]{22}$/.test(n); }

    /* ---------- IndexedDB ---------- */
    let dbPromise = null;
    function db() {
        if (!dbPromise) {
            dbPromise = new Promise((resolve, reject) => {
                const req = indexedDB.open(DB_NAME, 1);
                req.onupgradeneeded = () => req.result.createObjectStore(STORE);
                req.onsuccess = () => resolve(req.result);
                req.onerror = () => reject(req.error);
            });
            dbPromise.catch(() => { dbPromise = null; });
        }
        return dbPromise;
    }
    async function idbGet(key) {
        const d = await db();
        return new Promise((resolve, reject) => {
            const r = d.transaction(STORE).objectStore(STORE).get(key);
            r.onsuccess = () => resolve(r.result);
            r.onerror = () => reject(r.error);
        });
    }
    async function idbSet(key, value) {
        const d = await db();
        return new Promise((resolve, reject) => {
            const tx = d.transaction(STORE, "readwrite");
            tx.objectStore(STORE).put(value, key);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    }

    let persistAsked = false;
    function askPersist() {
        if (persistAsked) return;
        persistAsked = true;
        try { navigator.storage?.persist?.().catch(() => {}); } catch (_) {}
    }

    /* ---------- state ---------- */
    let identity = null;      // {pub, priv: CryptoKey, jwk}
    let friends = [];
    let prefs = { invisible: false };
    let readyPromise = null;
    const listeners = new Set();

    function emit() { for (const fn of listeners) { try { fn(); } catch (e) { console.warn(e); } } }

    async function importIdentity(rec) {
        const priv = await subtle.importKey("jwk", rec.jwk, { name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
        return { pub: rec.pub, jwk: rec.jwk, priv };
    }

    async function generateIdentity() {
        const kp = await subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
        const raw = new Uint8Array(await subtle.exportKey("raw", kp.publicKey));
        const jwk = await subtle.exportKey("jwk", kp.privateKey);
        return { pub: b64u(raw), jwk, priv: kp.privateKey };
    }

    function ready() {
        if (!readyPromise) {
            readyPromise = (async () => {
                const rec = await idbGet("identity");
                if (rec && isPub(rec.pub) && rec.jwk) {
                    identity = await importIdentity(rec);
                } else {
                    identity = await generateIdentity();
                    await idbSet("identity", { pub: identity.pub, jwk: identity.jwk });
                }
                const list = await idbGet("friends");
                friends = Array.isArray(list) ? list.filter(validFriend) : [];
                const p = await idbGet("prefs");
                if (p && typeof p === "object") prefs = { invisible: !!p.invisible };
                if (friends.length) askPersist();
            })();
            readyPromise.catch(err => {
                console.warn("[friends] storage unavailable", err);
                readyPromise = null;
            });
        }
        return readyPromise;
    }

    function validFriend(f) {
        return f && isPub(f.pub) && typeof f.s === "string" && f.s.length === 43 &&
            (f.role === 0 || f.role === 1);
    }

    function cleanNick(n) {
        return typeof n === "string" ? n.replace(/[\u0000-\u001f\u007f-\u009f]/g, "").trim().slice(0, 32) : "";
    }

    async function saveFriends() {
        await idbSet("friends", friends);
        askPersist();
        emit();
    }

    /* ---------- crypto ---------- */
    async function hkdf(ikm, salt, info, bits = 256) {
        const key = await subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
        return new Uint8Array(await subtle.deriveBits(
            { name: "HKDF", hash: "SHA-256", salt, info: te.encode(info) }, key, bits));
    }

    async function hmac(keyBytes, label) {
        const key = await subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
        return new Uint8Array(await subtle.sign("HMAC", key, te.encode(label)));
    }

    /* S = HKDF(ECDH(me, them), salt = both nonces sorted). Both sides get the
       same bytes without ever sending S. A claimed pub without its private key
       yields a different S, which the MAC exchange then rejects. */
    async function deriveSecret(theirPub, n1, n2) {
        const their = await subtle.importKey("raw", unb64u(theirPub), { name: "ECDH", namedCurve: "P-256" }, false, []);
        const shared = new Uint8Array(await subtle.deriveBits({ name: "ECDH", public: their }, identity.priv, 256));
        const [x, y] = [n1, n2].sort();
        return hkdf(shared, concat(unb64u(x), unb64u(y)), "void-friend-v1");
    }

    async function mac(sBytes, label) { return b64u((await hmac(sBytes, "mac|" + label)).subarray(0, 16)); }

    function macEqual(a, b) {
        if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
        let d = 0;
        for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
        return d === 0;
    }

    /* Presence token: HMAC(S, "on|role|day"), 16 bytes. */
    async function presenceToken(sB64, role, day) {
        return b64u((await hmac(unb64u(sB64), `on|${role}|${day}`)).subarray(0, 16));
    }

    const aesCache = new Map();
    async function aesKey(secretB64, info) {
        const id = info + "|" + secretB64;
        let k = aesCache.get(id);
        if (!k) {
            const raw = await hkdf(unb64u(secretB64), new Uint8Array(0), info);
            k = await subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
            aesCache.set(id, k);
        }
        return k;
    }

    /* Envelope: "<label>.<b64(iv|ciphertext)>"; label is bound as AAD. */
    async function seal(secretB64, info, label, obj) {
        const key = await aesKey(secretB64, info);
        const iv = randomBytes(12);
        const ct = new Uint8Array(await subtle.encrypt(
            { name: "AES-GCM", iv, additionalData: te.encode(label) }, key, te.encode(JSON.stringify(obj))));
        return label + "." + b64u(concat(iv, ct));
    }

    async function open(secretB64, info, label, body) {
        try {
            const key = await aesKey(secretB64, info);
            const raw = unb64u(body);
            const pt = await subtle.decrypt(
                { name: "AES-GCM", iv: raw.subarray(0, 12), additionalData: te.encode(label) }, key, raw.subarray(12));
            const obj = JSON.parse(td.decode(pt));
            return obj && typeof obj === "object" ? obj : null;
        } catch (_) {
            return null;
        }
    }

    async function sha256B64(str) {
        return b64u(await subtle.digest("SHA-256", te.encode(str)));
    }

    /* ---------- friend code + friendship security code ---------- */
    /* Friend code: 4 digits from SHA-256(pub) — "nick#0198", like discord.
       Not unique on its own, only together with the nick; it changes with
       the key (device transfer). */
    const codeCache = new Map();
    async function friendCode(pub) {
        if (!isPub(pub)) return null;
        let c = codeCache.get(pub);
        if (!c) {
            const h = new Uint8Array(await subtle.digest("SHA-256", unb64u(pub)));
            c = String(((h[0] << 16) | (h[1] << 8) | h[2]) % 10000).padStart(4, "0");
            codeCache.set(pub, c);
        }
        return c;
    }

    /* Friendship security code: 5 different icons of the #sas-N sprite from
       HMAC(S). Both sides have the same S, so they see the same icons; a server
       that swapped keys at befriending would have a different S with each. */
    async function pairIcons(sB64) {
        const h = await hmac(unb64u(sB64), "pair-sas");
        const out = [];
        for (const b of h) {
            const i = b % 25;
            if (b >= 250 || out.includes(i)) continue;
            out.push(i);
            if (out.length === 5) break;
        }
        return out;
    }

    function cleanTagNick(n) {
        return cleanNick(n).toLowerCase().replace(/\s+/g, " ");
    }
    /* "Cosmic Core #0198" / "cosmic core#0198" → {nick, code, tag} */
    function parseTag(raw) {
        const m = String(raw || "").trim().match(/^(.+?)\s*#\s*(\d{4})$/);
        if (!m) return null;
        const nick = cleanTagNick(m[1]);
        return nick ? { nick, code: m[2], tag: `${nick}#${m[2]}` } : null;
    }

    /* Transfer code: 16 chars of Crockford base32 (80 bits), shown as XXXX-XXXX-XXXX-XXXX. */
    const B32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
    function newTransferCode() {
        const r = randomBytes(10);
        let bits = 0, val = 0, out = "";
        for (const b of r) {
            val = (val << 8) | b; bits += 8;
            while (bits >= 5) { out += B32[(val >>> (bits - 5)) & 31]; bits -= 5; }
        }
        return out;
    }
    function normalizeTransferCode(s) {
        const c = String(s || "").toUpperCase().replace(/[^0-9A-Z]/g, "")
            .replace(/O/g, "0").replace(/[IL]/g, "1");
        return /^[0-9A-HJKMNP-TV-Z]{16}$/.test(c) ? c : null;
    }

    /* ---------- friends API ---------- */
    function find(pub) { return friends.find(f => f.pub === pub) || null; }

    async function addFriend({ pub, s, nick }) {
        if (!isPub(pub) || pub === identity.pub) return null;
        const entry = {
            pub,
            s,
            role: identity.pub < pub ? 0 : 1,
            nick: cleanNick(nick),
            alias: find(pub)?.alias || "",
            added: Date.now(),
        };
        friends = friends.filter(f => f.pub !== pub);
        if (friends.length >= MAX_FRIENDS) return null;
        friends.push(entry);
        await saveFriends();
        return entry;
    }

    async function removeFriend(pub) {
        const before = friends.length;
        friends = friends.filter(f => f.pub !== pub);
        if (friends.length !== before) await saveFriends();
    }

    async function updateFriend(pub, patch) {
        const f = find(pub);
        if (!f) return;
        let changed = false;
        if (typeof patch.nick === "string") {
            const n = cleanNick(patch.nick);
            if (n && n !== f.nick) { f.nick = n; changed = true; }
        }
        if (typeof patch.alias === "string") {
            const a = cleanNick(patch.alias);
            if (a !== f.alias) { f.alias = a; changed = true; }
        }
        /* New pub comes only from a status sealed with S, i.e. from the friend
           themself (after a device transfer their key changes, S does not). */
        if (isPub(patch.pub) && patch.pub !== f.pub && !find(patch.pub) && patch.pub !== identity.pub) {
            f.pub = patch.pub; changed = true;
        }
        if (changed) await saveFriends();
    }

    async function setPrefs(patch) {
        prefs = { ...prefs, ...patch };
        await idbSet("prefs", prefs);
        emit();
    }

    /* Transfer: export what the other device needs; import merges. */
    function exportBundle() {
        return { identity: { pub: identity.pub, jwk: identity.jwk }, friends: friends.map(f => ({ ...f })) };
    }

    function mergeLists(mine, theirs) {
        const out = mine.map(f => ({ ...f }));
        for (const f of Array.isArray(theirs) ? theirs : []) {
            if (!validFriend(f) || out.some(x => x.pub === f.pub || x.s === f.s)) continue;
            if (out.length >= MAX_FRIENDS) break;
            out.push({ pub: f.pub, s: f.s, role: f.role, nick: cleanNick(f.nick), alias: cleanNick(f.alias), added: Number(f.added) || Date.now() });
        }
        return out;
    }

    /* Source device: union the other device's friends into ours. */
    async function absorbFriends(theirs) {
        friends = mergeLists(friends, theirs).filter(f => f.pub !== identity.pub);
        await saveFriends();
    }

    /* Target device: adopt the source's key and the merged list. */
    async function adoptBundle(bundle) {
        const rec = bundle?.identity;
        if (!rec || !isPub(rec.pub) || !rec.jwk) throw new Error("bad bundle");
        const next = await importIdentity(rec);
        const merged = mergeLists(Array.isArray(bundle.friends) ? bundle.friends.filter(validFriend) : [], friends)
            .filter(f => f.pub !== next.pub);
        identity = next;
        friends = merged;
        await idbSet("identity", { pub: rec.pub, jwk: rec.jwk });
        await saveFriends();
    }

    window.VoidFriendStore = {
        MAX_FRIENDS,
        ready,
        get pub() { return identity?.pub || null; },
        get friends() { return friends; },
        get prefs() { return prefs; },
        onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
        find,
        addFriend,
        removeFriend,
        updateFriend,
        setPrefs,
        exportBundle,
        absorbFriends,
        adoptBundle,
        isPub,
        isNonce,
        cleanNick,
        newNonce: () => b64u(randomBytes(16)),
        newSecret: () => b64u(randomBytes(16)),
        deriveSecret: async (theirPub, n1, n2) => b64u(await deriveSecret(theirPub, n1, n2)),
        mac: (sB64, label) => mac(unb64u(sB64), label),
        macEqual,
        presenceToken,
        seal,
        open,
        sha256B64,
        friendCode,
        pairIcons,
        parseTag,
        cleanTagNick,
        newTransferCode,
        normalizeTransferCode,
    };
})();
