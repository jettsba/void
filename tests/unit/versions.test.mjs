import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

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
    // Комментарий файла содержит пример с другой версией — его вырезаем.
    const code = read("public/whats-new.js").replace(/\/\*[\s\S]*?\*\//g, "");
    const v = code.match(/version:\s*"([^"]*)"/)?.[1];
    if (v) assert.equal(v, pkg, "public/whats-new.js shows notes for another version");
});
