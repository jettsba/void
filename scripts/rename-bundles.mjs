/* Post-build: переименовать артефакты под фиксированные имена без версии.
   Запускается после `tauri build`. Источники:
     src-tauri/target/release/void-desktop.exe                 ← portable бинарь
     src-tauri/target/release/bundle/nsis/Void_X.Y.Z_x64-setup.exe ← NSIS инсталлер
   Результат:
     src-tauri/target/release/void_portable.exe
     src-tauri/target/release/bundle/nsis/void_setup.exe
   Подписи (.exe.sig для Tauri Updater) переименовываем тем же шаблоном. */

import fs from "node:fs";
import path from "node:path";

const releaseDir = path.resolve("src-tauri/target/release");
const nsisDir = path.join(releaseDir, "bundle", "nsis");

let ok = true;

// 1. Portable — копия (оригинал оставляем, чтобы NSIS повторного билда не сломался).
const portableSrc = path.join(releaseDir, "void-desktop.exe");
const portableDst = path.join(releaseDir, "void_portable.exe");
if (fs.existsSync(portableSrc)) {
    if (fs.existsSync(portableDst)) fs.unlinkSync(portableDst);
    fs.copyFileSync(portableSrc, portableDst);
    console.log("✓ portable →", path.relative(process.cwd(), portableDst));
} else {
    console.warn("⚠ portable source not found:", portableSrc);
    ok = false;
}

// 2. Installer (и его .sig если есть) — переименовываем.
if (fs.existsSync(nsisDir)) {
    const installers = fs.readdirSync(nsisDir).filter((f) =>
        /_x64-setup\.exe(\.sig)?$/i.test(f)
    );
    for (const f of installers) {
        const sigExt = f.endsWith(".sig") ? ".sig" : "";
        const dst = path.join(nsisDir, `void_setup.exe${sigExt}`);
        if (fs.existsSync(dst)) fs.unlinkSync(dst);
        fs.renameSync(path.join(nsisDir, f), dst);
        console.log("✓ installer →", path.relative(process.cwd(), dst));
    }
    if (installers.length === 0) {
        console.warn("⚠ no NSIS installer found in", nsisDir);
        ok = false;
    }
} else {
    console.warn("⚠ NSIS bundle dir not found:", nsisDir);
    ok = false;
}

process.exit(ok ? 0 : 1);
