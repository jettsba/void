/* Генерирует latest.json (manifest для Tauri Updater) из артефактов
   prod-сборки. Запускается в CI после `tauri build`.

   Tauri 2 кладёт `.sig` файл рядом с подписываемым бинарём. Точный путь
   зависит от target — для NSIS обычно `bundle/nsis/void_setup.exe.sig`,
   но может быть и `bundle/nsis/Void_X.Y.Z_x64-setup.exe.sig` (до нашего
   rename-bundles), или `bundle/updater/...`. Поэтому делаем рекурсивный
   поиск всех `.sig` в `target/release` и берём первый.

   Формат manifest — стандартный Tauri Updater v2:
     https://v2.tauri.app/plugin/updater/#dynamic-update-server */

import fs from "node:fs";
import path from "node:path";

const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
const version = pkg.version;

const releaseDir = path.resolve("src-tauri/target/release");

if (!fs.existsSync(releaseDir)) {
    console.error("✗ release dir not found:", releaseDir);
    process.exit(1);
}

// Рекурсивный поиск всех .sig файлов в target/release.
function findSigs(dir, acc = []) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            findSigs(full, acc);
        } else if (entry.isFile() && entry.name.endsWith(".sig")) {
            acc.push(full);
        }
    }
    return acc;
}

const sigs = findSigs(releaseDir);
console.log("found .sig files:", sigs.length);
sigs.forEach((s) => console.log("  -", path.relative(process.cwd(), s)));

if (sigs.length === 0) {
    console.error(
        "✗ no .sig files found — make sure TAURI_SIGNING_PRIVATE_KEY env was set during build."
    );
    process.exit(1);
}

// Выбираем NSIS installer signature (предпочитаем void_setup.exe.sig
// или *_setup.exe.sig, иначе первый попавшийся).
const preferred =
    sigs.find((s) => s.endsWith("void_setup.exe.sig")) ||
    sigs.find((s) => /_setup\.exe\.sig$/i.test(s)) ||
    sigs[0];

console.log("✓ using:", path.relative(process.cwd(), preferred));
const signature = fs.readFileSync(preferred, "utf8").trim();

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
