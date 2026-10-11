import "./_env.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";

const { getClientIp, isValidCode, sanitizeNickname, isValidUserId } = await import("../../lib/security.js");
const { isValidSdp } = await import("../../lib/handlers.js");

const req = (remote, xff) => ({ socket: { remoteAddress: remote }, headers: xff ? { "x-forwarded-for": xff } : {} });

test("getClientIp: trusts XFF only from loopback/private proxy, takes the LAST hop", () => {
    // Caddy на хосте → docker-бридж: соединение приходит со шлюза 172.18.0.1.
    assert.equal(getClientIp(req("172.18.0.1", "198.51.100.4")), "198.51.100.4");
    assert.equal(getClientIp(req("::ffff:127.0.0.1", "198.51.100.4")), "198.51.100.4");
    // Клиент сам прислал XFF — Caddy дописал реальный адрес в конец.
    assert.equal(getClientIp(req("127.0.0.1", "1.2.3.4, 198.51.100.4")), "198.51.100.4");
    // Прямое соединение с публичного адреса — XFF подделка, игнорируем.
    assert.equal(getClientIp(req("198.51.100.9", "1.2.3.4")), "198.51.100.9");
});

test("validators", () => {
    assert.ok(isValidCode("ABCDE"));
    assert.ok(!isValidCode("abc"));
    assert.ok(!isValidCode(42));
    assert.ok(isValidUserId("AB12CD34"));
    assert.ok(!isValidUserId("bad id"));
    assert.equal(sanitizeNickname("  ghost\u0007  node  "), "ghost node");
    assert.equal(sanitizeNickname("x".repeat(100)).length, 32);
});

test("isValidSdp: type and size cap (48 KB regression: big screen-share SDP was dropped at 16 KB)", () => {
    const sdp = "v=0\r\n" + "a=x\r\n".repeat(6000); // ~30 KB
    assert.ok(isValidSdp({ type: "offer", sdp }, "offer", 48 * 1024));
    assert.ok(!isValidSdp({ type: "answer", sdp }, "offer", 48 * 1024));
    assert.ok(!isValidSdp({ type: "offer", sdp: "" }, "offer", 48 * 1024));
    assert.ok(!isValidSdp({ type: "offer", sdp: "a".repeat(49 * 1024) }, "offer", 48 * 1024));
});
