import "./_env.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.LOG_LEVEL = "info";
const { log } = await import("../../lib/log.js");
const { roomRef } = await import("../../lib/privacy.js");

function capture(fn) {
    const lines = [];
    const orig = { log: console.log, warn: console.warn, error: console.error };
    console.log = console.warn = console.error = (s) => lines.push(String(s));
    try { fn(); } finally { Object.assign(console, orig); }
    return lines;
}

test("raw IP and room code never reach the log line", () => {
    const [line] = capture(() => log.warn("room", "created", { code: "MNXH2", ip: "203.0.113.7", userId: "AB12" }));
    assert.ok(!line.includes("203.0.113.7"), line);
    assert.ok(!line.includes("MNXH2"), line);
    assert.match(line, / ip#[0-9a-f]{6} \([A-Z?]{2,3}\)/);
    assert.ok(line.includes(`room=${roomRef("MNXH2")}`), line);
    assert.ok(line.includes("userId=AB12"), line);
});

test("ordinary fields are printed as before", () => {
    const [line] = capture(() => log.info("boot", "server running", { host: "127.0.0.1", port: 3000 }));
    assert.match(line, /\[boot\] server running host=127\.0\.0\.1 port=3000$/);
});
