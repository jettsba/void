import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const root = new URL("../../", import.meta.url);
const read = (p) => readFileSync(new URL(p, root), "utf8");

test("app version is in sync everywhere it is still written by hand", () => {
    const pkg = JSON.parse(read("package.json")).version;
    const appVersion = read("public/settings.js").match(/const APP_VERSION = "([^"]+)"/)?.[1];
    const cargo = read("src-tauri/Cargo.toml").match(/^version = "([^"]+)"/m)?.[1];
    assert.equal(appVersion, pkg, "public/settings.js APP_VERSION");
    assert.equal(cargo, pkg, "src-tauri/Cargo.toml version");
});

test("tauri.conf.json takes the version from package.json", () => {
    const conf = JSON.parse(read("src-tauri/tauri.conf.json"));
    assert.equal(conf.version, "../package.json");
});

test("changelog is well-formed and never ahead of the app", () => {
    const pkg = JSON.parse(read("package.json")).version;
    /* Файл именно выполняем, а не ищем строки регэкспом: незакрытый комментарий
       (так было в 1.8.1 с whats-new.js) превращал весь файл в комментарий —
       регэксп этого не видел, а данные просто не появлялись. */
    const sandbox = { window: {} };
    vm.runInNewContext(read("public/changelog.js"), sandbox);
    const log = sandbox.window.VoidChangelog;
    assert.ok(Array.isArray(log) && log.length, "public/changelog.js must define a non-empty window.VoidChangelog");
    const cmp = (a, b) => {
        const pa = a.split(".").map(Number), pb = b.split(".").map(Number);
        for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
            const d = (pa[i] || 0) - (pb[i] || 0);
            if (d) return d;
        }
        return 0;
    };
    log.forEach((e, i) => {
        const at = `changelog entry #${i} (${e.version})`;
        assert.match(String(e.version), /^\d+\.\d+(\.\d+)?$/, `${at}: bad version`);
        assert.match(String(e.date), /^\d{4}-\d{2}-\d{2}$/, `${at}: date must be YYYY-MM-DD`);
        assert.ok(Array.isArray(e.ru) && e.ru.length, `${at}: ru must be a non-empty array`);
        assert.ok(!e.en || Array.isArray(e.en), `${at}: en must be an array`);
        for (const line of [...e.ru, ...(e.en || [])]) {
            assert.ok(!/^—/.test(line), `${at}: sub-items start with "- ", not "—": ${line}`);
        }
        if (i) assert.ok(cmp(log[i - 1].version, e.version) > 0, `${at}: entries must go newest first, no duplicates`);
    });
    assert.ok(cmp(log[0].version, pkg) <= 0, `newest changelog entry ${log[0].version} is ahead of package.json ${pkg}`);
});
