/* ========= AMBIENT — slow drifting blobs ========= */

function sizeCanvas() {
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    canvas.width = window.innerWidth * dpr;
    canvas.height = window.innerHeight * dpr;
    canvas.style.width = window.innerWidth + "px";
    canvas.style.height = window.innerHeight + "px";
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function seedBlobs() {
    blobs = [];
    const count = 5;
    for (let i = 0; i < count; i++) {
        blobs.push({
            x: Math.random() * window.innerWidth,
            y: Math.random() * window.innerHeight,
            r: 220 + Math.random() * 220,
            vx: (Math.random() - 0.5) * 0.04,
            vy: (Math.random() - 0.5) * 0.04,
            a: 0.02 + Math.random() * 0.016
        });
    }
}

function paint() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    ctx.clearRect(0, 0, w, h);

    blobs.forEach(b => {
        b.x += b.vx;
        b.y += b.vy;
        if (b.x < -b.r) b.x = w + b.r;
        if (b.x > w + b.r) b.x = -b.r;
        if (b.y < -b.r) b.y = h + b.r;
        if (b.y > h + b.r) b.y = -b.r;

        const g = ctx.createRadialGradient(b.x, b.y, 0, b.x, b.y, b.r);
        g.addColorStop(0, `rgba(230,230,232,${b.a})`);
        g.addColorStop(1, "rgba(230,230,232,0)");
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2);
        ctx.fill();
    });

    requestAnimationFrame(paint);
}
