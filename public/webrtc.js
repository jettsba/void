/* ========= WEBRTC ========= */

let localStream = null;
let peers = new Map();
let audioContext = null;
let analyserMap = new Map();
let audioMap = new Map();
let volumeMap = new Map();

/**
 * Таймеры health-check для каждого пира.
 * Ключ — userId, значение — id таймера. Используется чтобы при следующем
 * изменении состояния отменить предыдущий запланированный recovery.
 */
const peerHealthTimers = new Map();

/** Сколько ждём перед попыткой восстановления, если peer ушёл в "disconnected".
 *  За это время transient проблемы (NAT mapping refresh, кратковременная потеря
 *  пакетов) обычно сами рассасываются. */
const PEER_DISCONNECT_GRACE_MS = 5000;

/** Сколько ждём результата ICE restart, прежде чем переходить к полному rebuild. */
const PEER_ICE_RESTART_TIMEOUT_MS = 8000;

/** Сколько НЕ-инициатор ждёт прежде чем взять recovery в свои руки.
 *  Больше чем grace + ICE restart timeout инициатора — даём ему шанс починить первым. */
const PEER_PASSIVE_REBUILD_TIMEOUT_MS = 15000;

async function initMedia() {
    localStream = await navigator.mediaDevices.getUserMedia({
        audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
        },
        video: false
    });
    createVolumeAnalyser(localStream, clientId);
    console.log("🎤 Microphone access granted");
}

/**
 * Fallback-список STUN-серверов. WebRTC опрашивает их параллельно при сборе
 * ICE-кандидатов и берёт первый ответивший — если один лёг или заблокирован
 * провайдером, остальные подхватят. Чем разнообразнее провайдеры, тем устойчивее.
 *
 * NOTE: для прода в РФ имеет смысл первым в списке поставить свой coturn —
 * это снижает зависимость от внешних сервисов и ускоряет ICE gathering.
 * Пока его нет — гугловые работают и в РФ, Cloudflare как страховка.
 */
const ICE_SERVERS = [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
    { urls: "stun:stun2.l.google.com:19302" },
    { urls: "stun:stun.cloudflare.com:3478" },
    { urls: "stun:stun.nextcloud.com:443" }
];

/**
 * Создать peer-соединение с пиром.
 * isInitiator — true, если ОФФЕР исходит от нас (мы зовём callUser).
 * Это важно для health-check: только инициатор делает ICE restart, чтобы
 * избежать одновременных встречных restart'ов (glare).
 */
function createPeer(userId, isInitiator) {

    const peer = new RTCPeerConnection({
        iceServers: ICE_SERVERS
    });

    peer._isInitiator = !!isInitiator;
    peer._userId = userId;

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
        // Если это ICE restart на существующем peer — у нас уже может быть audio
        // элемент для этого юзера. Переиспользуем его, просто меняем srcObject.
        // Это избегает короткого "пропадания" звука и лишних DOM-узлов.
        let audio = audioMap.get(userId);
        if (!audio) {
            audio = document.createElement("audio");
            audio.autoplay = true;
            audio.playsInline = true;
            document.body.appendChild(audio);
            audioMap.set(userId, audio);
        }
        audio.srcObject = event.streams[0];
        audio.muted = !isSoundOn;
        const savedVolume = volumeMap.get(userId) ?? 1;
        audio.volume = savedVolume;

        // Старый analyser привязан к мёртвому source — пересоздаём.
        // Старый rAF-цикл сам остановится (см. monitorVolume).
        analyserMap.delete(userId);
        createVolumeAnalyser(event.streams[0], userId);
    };

    peer.onconnectionstatechange = () => {
        handlePeerConnectionStateChange(userId);
    };

    peers.set(userId, peer);

    return peer;
}

/**
 * Инициировать соединение с пиром (или перезапустить существующее).
 * opts.iceRestart — поверх существующего peer пересобрать ICE-кандидаты
 *                   (быстрая попытка восстановления, без сброса DTLS).
 * opts.rebuild   — снести существующий peer и создать заново
 *                  (тяжёлая попытка, если ICE restart не помог).
 * Без opts — обычный первый звонок новому участнику.
 */
async function callUser(userId, opts = {}) {

    const { iceRestart = false, rebuild = false } = opts;

    if (rebuild) {
        cleanupPeerSlot(userId);
    }

    let peer = peers.get(userId);
    if (!peer) {
        peer = createPeer(userId, true);
    }

    const offer = await peer.createOffer({ iceRestart });
    await peer.setLocalDescription(offer);

    const message = {
        type: "offer",
        to: userId,
        offer
    };
    if (rebuild) message.rebuild = true;

    sendSocket(message);
}

async function handleOffer(data) {

    // Если другая сторона делает rebuild, она присылает rebuild:true — закрываем
    // свой старый peer и создаём новый. Без этого setRemoteDescription упал бы
    // из-за несоответствия DTLS fingerprint'ов.
    if (data.rebuild) {
        cleanupPeerSlot(data.from);
    }

    let peer = peers.get(data.from);
    if (!peer) {
        peer = createPeer(data.from, false);
    }

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

/* ========= PEER HEALTH ========= */

/**
 * Реакция на смену connectionState у peer-соединения.
 * - connected: всё ок, гасим pending recovery таймер.
 * - disconnected: ждём grace, может само починиться. Если нет — recovery.
 * - failed: точно сломано, recovery без задержки.
 */
function handlePeerConnectionStateChange(userId) {
    const peer = peers.get(userId);
    if (!peer) return;

    const state = peer.connectionState;
    console.log(`peer ${userId}: ${state}`);

    if (state === "connected") {
        clearPeerHealthTimer(userId);
        return;
    }

    if (state === "disconnected") {
        clearPeerHealthTimer(userId);
        const t = setTimeout(() => {
            const p = peers.get(userId);
            if (!p) return;
            if (p.connectionState === "connected") return;
            attemptPeerRecovery(userId);
        }, PEER_DISCONNECT_GRACE_MS);
        peerHealthTimers.set(userId, t);
        return;
    }

    if (state === "failed") {
        clearPeerHealthTimer(userId);
        attemptPeerRecovery(userId);
        return;
    }
}

/**
 * Запустить процедуру восстановления peer-соединения.
 * - Инициатор: ICE restart → если за PEER_ICE_RESTART_TIMEOUT_MS не помогло, full rebuild.
 * - Не-инициатор: ждём PEER_PASSIVE_REBUILD_TIMEOUT_MS пока инициатор сам починит,
 *   потом сами делаем rebuild (становимся новым инициатором).
 */
async function attemptPeerRecovery(userId) {
    const peer = peers.get(userId);
    if (!peer) return;

    if (peer._isInitiator) {
        try {
            console.log(`↻ ICE restart → ${userId}`);
            await callUser(userId, { iceRestart: true });
        } catch (err) {
            console.error("ICE restart failed:", err);
            rebuildPeer(userId);
            return;
        }

        const t = setTimeout(() => {
            const p = peers.get(userId);
            if (!p) return;
            if (p.connectionState === "connected") return;
            console.log(`↻ ICE restart didn't help, rebuilding peer ${userId}`);
            rebuildPeer(userId);
        }, PEER_ICE_RESTART_TIMEOUT_MS);
        peerHealthTimers.set(userId, t);
    } else {
        console.log(`peer ${userId} broken, waiting ${PEER_PASSIVE_REBUILD_TIMEOUT_MS}ms for initiator`);
        const t = setTimeout(() => {
            const p = peers.get(userId);
            if (!p) return;
            if (p.connectionState === "connected") return;
            console.log(`initiator didn't fix peer ${userId}, taking over with rebuild`);
            rebuildPeer(userId);
        }, PEER_PASSIVE_REBUILD_TIMEOUT_MS);
        peerHealthTimers.set(userId, t);
    }
}

/** Пересоздать peer полностью (закрыть старый, новый offer с rebuild:true). */
function rebuildPeer(userId) {
    callUser(userId, { rebuild: true }).catch(err => {
        console.error("Peer rebuild failed:", err);
    });
}

function clearPeerHealthTimer(userId) {
    const t = peerHealthTimers.get(userId);
    if (t) {
        clearTimeout(t);
        peerHealthTimers.delete(userId);
    }
}

/**
 * Полностью убрать всё, что связано с пиром: peer-соединение, audio-элемент,
 * анализатор громкости, health-timer. Используется и для штатного выхода
 * участника, и для rebuild peer-а.
 * Локальный микрофон и self-анализатор НЕ трогаются.
 */
function cleanupPeerSlot(userId) {
    const peer = peers.get(userId);
    if (peer) {
        peer.close();
        peers.delete(userId);
    }

    const audio = audioMap.get(userId);
    if (audio) {
        audio.remove();
        audioMap.delete(userId);
    }

    if (userId !== clientId) {
        analyserMap.delete(userId);
    }

    clearPeerHealthTimer(userId);
}

/* ========= TEARDOWN ========= */

function closeAllConnections() {

    [...peers.keys()].forEach(userId => {
        cleanupPeerSlot(userId);
    });

    if (localStream) {
        localStream.getTracks().forEach(track => {
            track.stop();
        });
        localStream = null;
    }

    // Self-анализатор тоже больше не актуален — стрим остановлен.
    analyserMap.delete(clientId);

    console.log("🔴 WebRTC stopped");
}

/**
 * Закрыть только удалённые peer-соединения, аудио и health-таймеры,
 * НЕ трогая локальный микрофон. Используется при реконнекте сокета:
 * mesh пересоберётся заново, а localStream нам нужен живым.
 */
function closeRemotePeerConnections() {

    [...peers.keys()].forEach(userId => {
        cleanupPeerSlot(userId);
    });

    console.log("↻ Remote peers torn down (local mic preserved)");
}

/* ========= VOLUME ANALYSIS ========= */

function createVolumeAnalyser(stream, userId) {

    if (!audioContext) {
        audioContext = new AudioContext();
    }

    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 256;

    const source = audioContext.createMediaStreamSource(stream);
    source.connect(analyser);

    analyserMap.set(userId, analyser);

    monitorVolume(userId, analyser);
}

function monitorVolume(userId, analyser) {

    const dataArray = new Uint8Array(analyser.frequencyBinCount);

    function checkVolume() {

        // Self-stop: если в analyserMap уже не наш analyser (ICE restart, rebuild,
        // cleanup) — выходим из rAF-цикла, не плодим зомби-loop'ы.
        if (analyserMap.get(userId) !== analyser) return;

        analyser.getByteFrequencyData(dataArray);

        let sum = 0;
        for (let i = 0; i < dataArray.length; i++) {
            sum += dataArray[i];
        }

        const average = sum / dataArray.length;

        if (window.onVolumeChange) {
            window.onVolumeChange(userId, average);
        }

        requestAnimationFrame(checkVolume);
    }

    checkVolume();
}

/**
 * RTT до пира в миллисекундах. Использует данные, которые WebRTC уже считает
 * по STUN keepalive / RTCP — никаких дополнительных пакетов и нагрузки на сервер.
 * Возвращает null если пир ещё не соединён или статистика недоступна.
 */
async function getPeerPing(userId) {
    const peer = peers.get(userId);
    if (!peer) return null;

    try {
        const stats = await peer.getStats();
        let nominated = null;
        let fallback = null;

        stats.forEach(report => {
            if (report.type !== "candidate-pair") return;
            if (report.state !== "succeeded") return;
            if (typeof report.currentRoundTripTime !== "number") return;

            const ms = Math.round(report.currentRoundTripTime * 1000);
            if (report.nominated) nominated = ms;
            else if (fallback == null) fallback = ms;
        });

        return nominated ?? fallback;
    } catch {
        return null;
    }
}
