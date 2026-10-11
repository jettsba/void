import "./_env.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";

const { ipTag, roomRef, countryOf, parseGeoCsv, setGeoTable, ipv4ToInt, ipv6High } =
    await import("../../lib/privacy.js");

const CSV = [
    "0.0.0.0,0.255.255.255,ZZ",
    "1.0.0.0,1.0.0.255,AU",
    "1.0.1.0,77.88.7.255,CN",
    "77.88.8.0,77.88.8.255,RU",
    "77.88.9.0,255.255.255.255,US",
    "::,1fff:ffff:ffff:ffff:ffff:ffff:ffff:ffff,ZZ",
    "2000::,2a02:6b7:ffff:ffff:ffff:ffff:ffff:ffff,DE",
    "2a02:6b8::,2a02:6b8:ffff:ffff:ffff:ffff:ffff:ffff,RU",
    "2a02:6b9::,ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff,NL",
].join("\n");

test("ipv4ToInt / ipv6High parse and reject garbage", () => {
    assert.equal(ipv4ToInt("1.2.3.4"), 0x01020304);
    assert.equal(ipv4ToInt("255.255.255.255"), 0xffffffff);
    assert.equal(ipv4ToInt("1.2.3"), -1);
    assert.equal(ipv4ToInt("1.2.3.256"), -1);
    assert.equal(ipv6High("2a02:6b8::1"), 0x2a0206b800000000n);
    assert.equal(ipv6High("::"), 0n);
    assert.equal(ipv6High("1::2::3"), null);
    assert.equal(ipv6High("::ffff:1.2.3.4"), null);
});

test("countryOf: ranges, LAN, unknown", () => {
    setGeoTable(parseGeoCsv(CSV));
    assert.equal(countryOf("77.88.8.8"), "RU");
    assert.equal(countryOf("::ffff:77.88.8.8"), "RU");
    assert.equal(countryOf("8.8.8.8"), "CN");
    assert.equal(countryOf("200.1.1.1"), "US");
    assert.equal(countryOf("0.1.2.3"), "??"); // ZZ → ??
    assert.equal(countryOf("2a02:6b8::2:242"), "RU");
    assert.equal(countryOf("2001:db8::1"), "DE");
    assert.equal(countryOf("172.18.0.1"), "LAN");
    assert.equal(countryOf("192.168.1.10"), "LAN");
    assert.equal(countryOf("::1"), "LAN");
    assert.equal(countryOf("fd00::1"), "LAN");
    assert.equal(countryOf("not-an-ip"), "??");
});

test("ipTag: stable per IP, opaque, has country", () => {
    setGeoTable(parseGeoCsv(CSV));
    const a = ipTag("77.88.8.8");
    assert.match(a, /^ip#[0-9a-f]{6} \(RU\)$/);
    assert.equal(ipTag("77.88.8.8"), a, "same IP → same tag within the salt period");
    assert.equal(ipTag("::ffff:77.88.8.8"), a, "IPv4-mapped form is the same address");
    assert.notEqual(ipTag("77.88.8.9"), a);
    assert.ok(!a.includes("77.88"), "raw IP must not leak into the tag");
    assert.equal(ipTag(""), "ip#? (??)");
});

test("roomRef: stable, 6 hex, hides the code", () => {
    const r = roomRef("ABCDE");
    assert.match(r, /^[0-9a-f]{6}$/);
    assert.equal(roomRef("ABCDE"), r);
    assert.notEqual(roomRef("ABCDF"), r);
});
