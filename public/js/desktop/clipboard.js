/* ============ Clipboard: копирование картинки (desktop-only) ============
   navigator.clipboard.write() с ClipboardItem для картинок ненадёжен в
   WebView2 (в отличие от writeText, который там работает штатно) — известное
   ограничение движка. На десктопе идём в обход Web Clipboard API и зовём
   нативный tauri-plugin-clipboard-manager напрямую через invoke.

   Кодируем как raw RGBA (JsImage::Rgba{rgba,width,height}), а не как сырые
   PNG/JPEG-байты (JsImage::Bytes) — Bytes идёт через Rust `image`-crate
   декодер, который по докам поддерживает только ico/png под спец-фичами;
   чат шлёт JPEG (см. downscaleImage в chat.js), так что Bytes ненадёжен.
   Rgba декода не требует вообще — раскладываем картинку через canvas сами. */
(function () {
    "use strict";

    if (window.VoidPlatform !== "desktop") return;
    if (!window.__TAURI__ || !window.__TAURI__.core) {
        console.warn("[clipboard] Tauri core API not available");
        return;
    }

    async function decodeToRgba(blobUrl) {
        const img = new Image();
        img.src = blobUrl;
        if (img.decode) {
            await img.decode();
        } else {
            await new Promise((resolve, reject) => {
                img.onload = resolve;
                img.onerror = reject;
            });
        }

        const canvas = document.createElement("canvas");
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0);

        const { data, width, height } = ctx.getImageData(0, 0, canvas.width, canvas.height);
        return { rgba: new Uint8Array(data.buffer, data.byteOffset, data.byteLength), width, height };
    }

    async function copyImage(blobUrl) {
        const { rgba, width, height } = await decodeToRgba(blobUrl);
        await window.__TAURI__.core.invoke("plugin:clipboard-manager|write_image", {
            image: { rgba, width, height }
        });
    }

    window.VoidDesktop = window.VoidDesktop || {};
    window.VoidDesktop.copyImage = copyImage;
})();
