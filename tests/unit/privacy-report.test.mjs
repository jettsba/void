import "./_env.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";

const { scrubReport } = await import("../../lib/bug-report.js");

test("bug report: room code and every participant id are replaced with log refs", () => {
    const parsed = { room: "KX7A2", userId: "SELF1234", peers: [{ userId: "PEER5678" }, { userId: "PEER9999" }] };
    const text = JSON.stringify({
        ...parsed,
        url: "https://app.void-room.space/?room=KX7A2",
        history: [
            { msg: "joined", code: "KX7A2", userId: "SELF1234" },
            { msg: "offer from PEER5678 in KX7A2" },
            { msg: "peer PEER9999 left" }
        ]
    });
    const out = scrubReport(text, parsed);
    for (const secret of ["KX7A2", "SELF1234", "PEER5678", "PEER9999"]) {
        assert.ok(!out.includes(secret), `${secret} must not reach the e-mail`);
    }
    assert.match(out, /room:[0-9a-f]{6}/);
    assert.match(out, /user:[0-9a-f]{6}/);
});
