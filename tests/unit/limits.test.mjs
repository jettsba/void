/* Лимиты против перебора и сквоттинга. Значения занижены через env, чтобы не
   гонять десятки запросов; файл — отдельный процесс node --test, на другие
   тесты это не влияет. */
process.env.FAILED_JOIN_LIMIT = "4";
process.env.CREATE_ROOM_LIMIT = "3";
process.env.ROOMS_CAP = "6";
import "./_env.mjs";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

const H = await import("../../lib/handlers.js");
const { rooms, ipFailedJoins, ipRoomCreates } = await import("../../lib/state.js");

let ipSeq = 0;
function fakeWs(ip) {
    return {
        readyState: 1,
        _ip: ip || `203.0.113.${++ipSeq}`,
        sent: [],
        send(m) { this.sent.push(JSON.parse(m)); },
    };
}
const join = (ws, code, extra = {}) => {
    H.handleJoinRoom(ws, { code, userId: "PROBE001", ...extra });
    return ws.sent.at(-1);
};
const create = (ws, code) => {
    H.handleCreateRoom(ws, { code });
    return ws.sent.at(-1);
};

beforeEach(() => {
    rooms.clear();
    ipFailedJoins.clear();
    ipRoomCreates.clear();
});

test("code-taken on create-room counts toward the brute-force block", () => {
    for (const c of ["TAKEA", "TAKEB", "TAKEC", "TAKED"]) create(fakeWs(), c);
    const probe = fakeWs();
    assert.equal(create(probe, "TAKEA").reason, "code-taken");
    assert.equal(create(probe, "TAKEB").reason, "code-taken");
    assert.equal(create(probe, "TAKEC").reason, "code-taken");
    assert.equal(create(probe, "TAKED").reason, "code-taken"); // 4-й разный код → блок
    assert.equal(join(probe, "TAKEA").reason, "rate-limited", "join is blocked too");
    assert.equal(create(probe, "FREE1").reason, "rate-limited", "and create-room from a blocked IP");
});

test("full and closed rooms are probes too, but retrying ONE code is free", () => {
    const owner = fakeWs();
    create(owner, "SHUTA");
    H.handleJoinConfirm(owner, { code: "SHUTA", userId: "OWNER001", nickname: "o" });
    H.handleRoomCloseVote(owner, { vote: true });

    const friend = fakeWs();
    for (let i = 0; i < 10; i++) assert.equal(join(friend, "SHUTA").reason, "room-closed");

    const scanner = fakeWs();
    assert.equal(join(scanner, "SHUTA").reason, "room-closed");
    assert.equal(join(scanner, "NOPE1").reason, "room-not-found");
    assert.equal(join(scanner, "NOPE2").reason, "room-not-found");
    assert.equal(join(scanner, "NOPE3").reason, "room-not-found");
    assert.equal(join(scanner, "SHUTA").reason, "rate-limited");
});

test("a successful join doesn't wipe the counter", () => {
    const owner = fakeWs();
    create(owner, "MINE1");
    const scanner = fakeWs();
    join(scanner, "NOPE1");
    join(scanner, "NOPE2");
    join(scanner, "NOPE3");
    assert.equal(join(scanner, "MINE1").type, "join-success");
    H.handleJoinConfirm(scanner, { code: "MINE1", userId: "PROBE001", nickname: "p" });
    assert.equal(join(fakeWs(scanner._ip), "NOPE4").reason, "room-not-found");
    assert.equal(join(fakeWs(scanner._ip), "MINE1").reason, "rate-limited");
});

test("room creation is limited per IP", () => {
    const ws = fakeWs();
    assert.equal(create(ws, "MANY1").success, true);
    assert.equal(create(ws, "MANY2").success, true);
    assert.equal(create(ws, "MANY3").success, true);
    assert.equal(create(ws, "MANY4").reason, "rate-limited");
    assert.equal(create(fakeWs(), "OTHER").success, true, "another IP is unaffected");
});

test("global rooms cap answers server-full", () => {
    for (let i = 0; i < 6; i++) assert.equal(create(fakeWs(), `CAPR${i}`).success, true);
    assert.equal(create(fakeWs(), "CAPRX").reason, "server-full");

    // Ресурект после рестарта упирается в тот же потолок.
    const back = fakeWs();
    H.handleJoinRoom(back, { code: "CAPRY", userId: "AAAA1111", resume: true });
    assert.equal(back.sent.at(-1).reason, "server-full");
});
