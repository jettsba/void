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

test("whats-new version is either empty or the current one", () => {
    const pkg = JSON.parse(read("package.json")).version;
    /* Файл именно выполняем, а не ищем строку регэкспом: незакрытый комментарий
       (так было в 1.8.1) превращал весь файл в комментарий — регэксп этого не
       видел, а VoidWhatsNew просто не появлялся. */
    const sandbox = { window: {} };
    vm.runInNewContext(read("public/whats-new.js"), sandbox);
    const notes = sandbox.window.VoidWhatsNew;
    assert.ok(notes && typeof notes === "object", "public/whats-new.js must define window.VoidWhatsNew");
    assert.ok(Array.isArray(notes.ru) && Array.isArray(notes.en), "ru/en must be arrays");
    if (notes.version) assert.equal(notes.version, pkg, "public/whats-new.js shows notes for another version");
});
