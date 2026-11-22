/* ===== QR in the void style (window.VoidQR) =====
   One renderer for every QR in the app: friend link, device transfer, support
   addresses. Dark "liquid" modules on the soft light card: a module rounds
   only the corners that have no dark neighbour, so runs read as smooth shapes
   while the module grid stays solid (dots / gaps break jsQR, the in-app
   scanner). Dark-on-light stays: inverted codes are not read by every phone
   camera. Finder eyes are rounded squares. Error correction M, quiet zone 3. */
(function () {
    "use strict";

    let lib = null;
    function loadLib() {
        if (window.qrcode) return Promise.resolve();
        if (!lib) {
            lib = new Promise((resolve, reject) => {
                const s = document.createElement("script");
                s.src = "vendor/qrcode.js";
                s.onload = resolve;
                s.onerror = () => { lib = null; reject(new Error("qr lib")); };
                document.head.appendChild(s);
            });
        }
        return lib;
    }

    const PAD = 3;
    const R = 0.42; // free-corner radius, module = 1

    /* One module, rounding the corners named in c (tl, tr, br, bl). */
    function cell(x, y, c) {
        const r = (k) => (c[k] ? R : 0);
        const tl = r(0), tr = r(1), br = r(2), bl = r(3);
        let d = `M${x + tl} ${y}h${1 - tl - tr}`;
        if (tr) d += `a${tr} ${tr} 0 0 1 ${tr} ${tr}`;
        d += `v${1 - tr - br}`;
        if (br) d += `a${br} ${br} 0 0 1 ${-br} ${br}`;
        d += `h${-(1 - br - bl)}`;
        if (bl) d += `a${bl} ${bl} 0 0 1 ${-bl} ${-bl}`;
        d += `v${-(1 - bl - tl)}`;
        if (tl) d += `a${tl} ${tl} 0 0 1 ${tl} ${-tl}`;
        return d + "z";
    }

    function eye(x, y) {
        // 7×7 ring (outer r 1.9, inner 5×5 r 1.1) + 3×3 pupil
        const ring = `M${x + 1.9} ${y}h3.2a1.9 1.9 0 0 1 1.9 1.9v3.2a1.9 1.9 0 0 1-1.9 1.9h-3.2a1.9 1.9 0 0 1-1.9-1.9v-3.2a1.9 1.9 0 0 1 1.9-1.9z`
            + `M${x + 2.1} ${y + 1}h2.8a1.1 1.1 0 0 1 1.1 1.1v2.8a1.1 1.1 0 0 1-1.1 1.1h-2.8a1.1 1.1 0 0 1-1.1-1.1v-2.8a1.1 1.1 0 0 1 1.1-1.1z`;
        const pupil = `M${x + 2.8} ${y + 2}h1.4a0.8 0.8 0 0 1 0.8 0.8v1.4a0.8 0.8 0 0 1-0.8 0.8h-1.4a0.8 0.8 0 0 1-0.8-0.8v-1.4a0.8 0.8 0 0 1 0.8-0.8z`;
        return { ring, pupil };
    }

    async function svg(text, cls = "") {
        await loadLib();
        const q = window.qrcode(0, "M");
        q.addData(String(text));
        q.make();
        const n = q.getModuleCount();
        const inEye = (x, y) => (x < 7 && y < 7) || (x >= n - 7 && y < 7) || (x < 7 && y >= n - 7);
        const dark = (x, y) => x >= 0 && y >= 0 && x < n && y < n && !inEye(x, y) && q.isDark(y, x);
        let dots = "";
        for (let y = 0; y < n; y++) {
            for (let x = 0; x < n; x++) {
                if (!dark(x, y)) continue;
                const up = dark(x, y - 1), dn = dark(x, y + 1), lf = dark(x - 1, y), rt = dark(x + 1, y);
                dots += cell(x + PAD, y + PAD, [!up && !lf, !up && !rt, !dn && !rt, !dn && !lf]);
            }
        }
        let rings = "", pupils = "";
        for (const [x, y] of [[0, 0], [n - 7, 0], [0, n - 7]]) {
            const e = eye(x + PAD, y + PAD);
            rings += e.ring;
            pupils += e.pupil;
        }
        const size = n + PAD * 2;
        return `<svg class="vqr${cls ? " " + cls : ""}" viewBox="0 0 ${size} ${size}" role="img" aria-label="qr">`
            + `<rect class="vqr-bg" width="${size}" height="${size}" rx="1"/>`
            + `<path class="vqr-mod" fill-rule="evenodd" d="${rings}"/>`
            + `<path class="vqr-mod" d="${pupils}${dots}"/></svg>`;
    }

    window.VoidQR = { svg };
})();
