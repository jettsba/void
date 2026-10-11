import "./_env.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";

const { sanitizeIceFailure } = await import("../../lib/stats.js");
const { diagnoseFailure } = await import("../../lib/admin-stats.js");

test("sanitizeIceFailure: whitelist, enums, clamps — client payload is rendered in admin HTML", () => {
    const out = sanitizeIceFailure({
        at: 123,
        room: "abc123",
        platform: "<script>",
        ua: "Mozilla\u0000/5.0 " + "x".repeat(500),
        ice: "failed",
        conn: "bogus",
        attempt: 1e9,
        evil: "drop me",
        net: "4g" // старое имя поля effType — подхватываем с диска
    });
    assert.equal(out.room, "abc123");
    assert.notEqual(out.platform, "<script>");
    assert.ok(!out.ua.includes("\u0000"));
    assert.ok(out.ua.length <= 160);
    assert.equal(out.ice, "failed");
    assert.notEqual(out.conn, "bogus");
    assert.ok(out.attempt <= 99);
    assert.equal(out.effType, "4g");
    assert.ok(!("evil" in out));
    assert.equal(sanitizeIceFailure(null), null);
});

test("sanitizeIceFailure: room ref must be short hex (raw code never stored)", () => {
    assert.equal(sanitizeIceFailure({ room: "ABCDE" }).room, "");
});

test("diagnoseFailure: rule order — most specific verdict wins", () => {
    const quota = diagnoseFailure({ errs: [{ code: 486, url: "turn:turn.example:3478" }], pairs: { succeeded: 1 } });
    assert.match(quota.text, /486/);
    const dtls = diagnoseFailure({ pairs: { succeeded: 2 }, remote: { host: 1 } });
    assert.match(dtls.text, /media\/dtls/);
    // rc=0 при stable: SDP разошлись, а кандидатов не доехало — потеря trickle.
    const lost = diagnoseFailure({ rc: 0, sig: "stable", remote: {} });
    assert.match(lost.text, /zero candidates delivered/);
    // Раньше всё без кандидатов было «signalling lost» (89% лога) — разводим по sig.
    const noAnswer = diagnoseFailure({ sig: "have-local-offer", remote: {} });
    assert.match(noAnswer.text, /never answered/);
});
