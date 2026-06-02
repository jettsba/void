/* Генерирует latest.json (manifest для Tauri Updater) из артефактов
   prod-сборки. Запускается в CI после `tauri build`. Подпись берётся из
   `*.sig` файла рядом с installer'ом — `tauri build` создаёт его автоматически
   когда выставлен TAURI_SIGNING_PRIVATE_KEY env-var.

   Формат manifest — стандартный Tauri Updater v2:
   https://v2.tauri.app/plugin/updater/#dynamic-update-server

   Tauri Updater следует HTTPS-redirect'ам, поэтому "url" может указывать
   на github.com/.../releases/latest/download/... — GitHub автоматом
   перенаправит на актуальный release artifact. */

import fs from "node:fs";
import path from "node:path";

const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
const version = pkg.version;

const releaseDir = path.resolve("src-tauri/target/release");
const installerPath = path.join(
    releaseDir,
    "bundle",
    "nsis",
    "void_setup.exe"
);
const sigPath = installerPath + ".sig";

if (!fs.existsSync(installerPath)) {
    console.error("✗ installer not found:", installerPath);
    process.exit(1);
}
if (!fs.existsSync(sigPath)) {
    console.error(
        "✗ signature not found:", sigPath,
        "— make sure TAURI_SIGNING_PRIVATE_KEY env was set during build"
    );
    process.exit(1);
}

const signature = fs.readFileSync(sigPath, "utf8").trim();

// URL'ы указывают на GitHub Release artifacts. `releases/latest/download/...`
// GitHub автоматом перенаправит на latest published release.
const repo = process.env.GITHUB_REPOSITORY || "jettsba/void";
const releaseUrl = `https://github.com/${repo}/releases/latest/download/void_setup.exe`;

const manifest = {
    version,
    notes: process.env.RELEASE_NOTES || `Release v${version}`,
    pub_date: new Date().toISOString(),
    platforms: {
        "windows-x86_64": {
            url: releaseUrl,
            signature,
        },
    },
};

const outPath = path.resolve("latest.json");
fs.writeFileSync(outPath, JSON.stringify(manifest, null, 2));
console.log("✓ manifest →", path.relative(process.cwd(), outPath));
console.log("  version:  ", version);
console.log("  url:      ", releaseUrl);
console.log("  signature:", signature.slice(0, 40) + "...");
