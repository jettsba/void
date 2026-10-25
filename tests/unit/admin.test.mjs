process.env.ADMIN_STATS_PASSWORD = "correct-horse-battery-staple-2026";
import "./_env.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

const { mountAdminStats } = await import("../../lib/admin-stats.js");

const routes = {};
mountAdminStats({
    get: (path, fn) => { routes[`GET ${path}`] = fn; },
    post: (path, fn) => { routes[`POST ${path}`] = fn; },
});

function call(route, ip, password, query = {}) {
    const headers = {};
    if (password !== undefined) {
        headers.authorization = "Basic " + Buffer.from(`admin:${password}`).toString("base64");
    }
    const res = {
        code: 200, headers: {},
        set(k, v) { this.headers[k] = v; return this; },
        status(c) { this.code = c; return this; },
        type() { return this; },
        send() { return this; },
        redirect(c) { this.code = c; return this; },
    };
    routes[route]({ headers, query, socket: { remoteAddress: ip } }, res);
    return res.code;
}

test("a brute-forcing IP locks only itself; the owner from another IP gets in", () => {
    for (let i = 0; i < 5; i++) assert.equal(call("GET /adminstats", "203.0.113.66", "wrong"), 401);
    assert.equal(call("GET /adminstats", "203.0.113.66", "correct-horse-battery-staple-2026"), 429,
        "locked IP doesn't even reach the password check");
    assert.equal(call("GET /adminstats", "198.51.100.7", "correct-horse-battery-staple-2026"), 200);
});

test("clear-log token rotates daily and is required", () => {
    const pw = "correct-horse-battery-staple-2026";
    const day = new Date().toISOString().slice(0, 10);
    const today = crypto.createHmac("sha256", pw).update(`fails-clear|${day}`).digest("hex").slice(0, 32);
    const legacy = crypto.createHmac("sha256", pw).update("fails-clear").digest("hex").slice(0, 32);
    assert.equal(call("POST /adminstats/fails/clear", "192.0.2.10", pw, { t: legacy }), 403, "the old eternal token is dead");
    assert.equal(call("POST /adminstats/fails/clear", "192.0.2.10", pw, { t: today }), 303);
});
