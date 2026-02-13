/* ===============================
   GLOBAL STATE
================================ */
let pc = null;
let ws = null;
let joined = false;

/* ===============================
   DOM
================================ */
const btn = document.getElementById('btn');
const status = document.getElementById('status');
const logo = document.querySelector('.logo-main');

/* ===============================
   EVENTS
================================ */
btn.addEventListener('click', join);

/* ===============================
   VOICE JOIN
================================ */
async function join() {
    if (joined) return;

    btn.classList.add('disabled');
    status.textContent = 'подключение к VOID...';
    logo.classList.remove('glow');

    ws = new WebSocket(`ws://${location.hostname}:3001`);

    const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false }
    });

    pc = new RTCPeerConnection({
        iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
    });

    stream.getTracks().forEach(t => pc.addTrack(t, stream));

    pc.ontrack = e => {
        const audio = document.createElement('audio');
        audio.srcObject = e.streams[0];
        audio.autoplay = true;
        document.body.appendChild(audio);
    };

    pc.onicecandidate = e => {
        if (e.candidate) {
            ws.send(JSON.stringify({ ice: e.candidate }));
        }
    };

    ws.onmessage = async e => {
        const msg = JSON.parse(e.data);

        if (msg.sdp) {
            await pc.setRemoteDescription(msg.sdp);
            if (msg.sdp.type === 'offer') {
                const answer = await pc.createAnswer();
                await pc.setLocalDescription(answer);
                ws.send(JSON.stringify({ sdp: answer }));
            }
        }

        if (msg.ice) {
            pc.addIceCandidate(msg.ice);
        }
    };

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    ws.send(JSON.stringify({ sdp: offer }));

    joined = true;
    status.textContent = 'ты в VOID';
    logo.classList.add('glow');
}

/* ===============================
   PARTICLES (VOID SPACE)
================================ */
function initParticles() {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');

    document.body.appendChild(canvas);
    canvas.style.position = 'fixed';
    canvas.style.inset = 0;
    canvas.style.zIndex = 0;
    canvas.style.pointerEvents = 'none';

    let w, h;

    function resize() {
        w = canvas.width = window.innerWidth;
        h = canvas.height = window.innerHeight;
    }

    window.addEventListener('resize', resize);
    resize();

    const particles = Array.from({ length: 120 }, () => ({
        x: Math.random() * w,
        y: Math.random() * h,
        r: Math.random() * 1.2 + 0.2,
        vx: (Math.random() - 0.5) * 0.15,
        vy: (Math.random() - 0.5) * 0.15,
        a: Math.random() * 0.5 + 0.2
    }));

    function tick() {
        ctx.clearRect(0, 0, w, h);

        for (const p of particles) {
            p.x += p.vx;
            p.y += p.vy;

            if (p.x < 0) p.x = w;
            if (p.x > w) p.x = 0;
            if (p.y < 0) p.y = h;
            if (p.y > h) p.y = 0;

            ctx.beginPath();
            ctx.fillStyle = `rgba(255,255,255,${p.a})`;
            ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
            ctx.fill();
        }

        requestAnimationFrame(tick);
    }

    tick();
}

/* ===============================
   INIT
================================ */
initParticles();
