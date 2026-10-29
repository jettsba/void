/* Renders the DMG background page (src-tauri/macos/dmg-background.py) into
   src-tauri/macos/dmg-background@2x.png (144 dpi) and dmg-background.png (72 dpi).
   Uses the system Chrome through the playwright devDependency; sips is macOS-only. */
import { chromium } from "playwright";
import { execFileSync } from "node:child_process";
import path from "node:path";

const html = path.resolve(process.argv[2] || "");
const out = path.resolve("src-tauri/macos");
const [W, H] = [2560, 1600];  // IMG_W x IMG_H in dmg-background.py

const browser = await chromium.launch({ channel: "chrome" });
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 2 });
await page.goto("file://" + html);
await page.evaluate(() => document.fonts.ready);
const shot2x = path.join(out, "dmg-background@2x.png");
await page.screenshot({ path: shot2x });
await browser.close();

execFileSync("sips", ["-s", "dpiWidth", "144", "-s", "dpiHeight", "144", shot2x], { stdio: "ignore" });
execFileSync("sips", ["-z", String(H), String(W), "-s", "dpiWidth", "72", "-s", "dpiHeight", "72",
    shot2x, "--out", path.join(out, "dmg-background.png")], { stdio: "ignore" });
console.log("✓", path.relative(process.cwd(), shot2x), "+ dmg-background.png");
