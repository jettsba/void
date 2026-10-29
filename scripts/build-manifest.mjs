/* Генерирует latest.json (manifest для Tauri Updater) из готовых артефактов
   релиза. Запускается в CI джобой publish-desktop, когда обе сборки сдали
   файлы в dist/:
     void_setup.exe.sig            — подпись NSIS-установщика (Windows)
     void_macos.app.tar.gz.sig     — подпись архива .app (macOS, universal)

   Апдейтер на Windows качает void_setup.exe и запускает его тихо; на macOS —
   архив .app и подменяет им бандл. Universal-бинарь один на обе архитектуры,
   поэтому darwin-aarch64 и darwin-x86_64 ведут на один и тот же файл.

   env:
     ARTIFACTS_DIR      — где лежат .sig (по умолчанию dist)
     MANIFEST_BASE_URL  — откуда качать файлы (по умолчанию GitHub latest)
     MANIFEST_OUT       — куда писать манифест (по умолчанию latest.json)
     RELEASE_NOTES      — notes в манифесте

   Формат manifest — стандартный Tauri Updater v2:
     https://v2.tauri.app/plugin/updater/#static-json-file */

import fs from "node:fs";
import path from "node:path";

const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
const version = pkg.version;

const dir = path.resolve(process.env.ARTIFACTS_DIR || "dist");
const repo = process.env.RELEASES_REPO || "jettsba/void";
const base = (process.env.MANIFEST_BASE_URL ||
    `https://github.com/${repo}/releases/latest/download`).replace(/\/+$/, "");

/* Подпись обязательна: манифест без платформы молча оставил бы её юзеров на
   старой версии, а с битой подписью апдейтер откажется ставить — лучше упасть
   здесь, громко. */
function signature(file) {
    const sigPath = path.join(dir, `${file}.sig`);
    if (!fs.existsSync(sigPath)) {
        console.error(`✗ missing ${path.relative(process.cwd(), sigPath)} — was the build signed (TAURI_SIGNING_PRIVATE_KEY)?`);
        process.exit(1);
    }
    return fs.readFileSync(sigPath, "utf8").trim();
}

const win = { url: `${base}/void_setup.exe`, signature: signature("void_setup.exe") };
const mac = { url: `${base}/void_macos.app.tar.gz`, signature: signature("void_macos.app.tar.gz") };

const manifest = {
    version,
    notes: process.env.RELEASE_NOTES || `Release v${version}`,
    pub_date: new Date().toISOString(),
    platforms: {
        "windows-x86_64": win,
        "darwin-aarch64": mac,
        "darwin-x86_64": mac,
    },
};

const outPath = path.resolve(process.env.MANIFEST_OUT || "latest.json");
fs.writeFileSync(outPath, JSON.stringify(manifest, null, 2));
console.log("✓ manifest →", path.relative(process.cwd(), outPath));
console.log("  version:", version);
for (const [platform, { url }] of Object.entries(manifest.platforms)) {
    console.log(`  ${platform.padEnd(15)} ${url}`);
}
