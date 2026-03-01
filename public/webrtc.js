/* ========= WEBRTC ========= */

let localStream = null;
let peers = new Map();

async function initMedia() {
    localStream = await navigator.mediaDevices.getUserMedia({
        audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
        },
        video: false
    });

    console.log("🎤 Microphone access granted");
}

function createPeer(userId) {

    const peer = new RTCPeerConnection({
        iceServers: [
            { urls: "stun:stun.l.google.com:19302" }
        ]
    });

    localStream.getTracks().forEach(track => {
        peer.addTrack(track, localStream);
    });

    peer.onicecandidate = (event) => {
        if (event.candidate) {
            sendSocket({
                type: "ice",
                to: userId,
                candidate: event.candidate
            });
        }
    };

    peer.ontrack = (event) => {

        const audio = document.createElement("audio");
        audio.srcObject = event.streams[0];
        audio.autoplay = true;
        audio.playsInline = true;

        document.body.appendChild(audio);
    };

    peers.set(userId, peer);

    return peer;
}

async function callUser(userId) {

    const peer = createPeer(userId);

    const offer = await peer.createOffer();
    await peer.setLocalDescription(offer);

    sendSocket({
        type: "offer",
        to: userId,
        offer
    });
}

async function handleOffer(data) {

    const peer = createPeer(data.from);

    await peer.setRemoteDescription(
        new RTCSessionDescription(data.offer)
    );

    const answer = await peer.createAnswer();
    await peer.setLocalDescription(answer);

    sendSocket({
        type: "answer",
        to: data.from,
        answer
    });
}

async function handleAnswer(data) {

    const peer = peers.get(data.from);
    if (!peer) return;

    await peer.setRemoteDescription(
        new RTCSessionDescription(data.answer)
    );
}

async function handleIce(data) {

    const peer = peers.get(data.from);
    if (!peer) return;

    try {
        await peer.addIceCandidate(data.candidate);
    } catch (e) {
        console.error("ICE error", e);
    }
}

function closeAllConnections() {

    peers.forEach(peer => {
        peer.close();
    });

    peers.clear();

    if (localStream) {
        localStream.getTracks().forEach(track => {
            track.stop();
        });
        localStream = null;
    }

    document.querySelectorAll("audio").forEach(audio => {
        audio.remove();
    });

    console.log("🔴 WebRTC stopped");
}