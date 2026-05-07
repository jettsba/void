/* ========= WEBRTC ========= */

let localStream = null;
let processedStream = null;
let peers = new Map();
let audioContext = null;
let analyserMap = new Map();
let audioMap = new Map();
let volumeMap = new Map();

let screenStream = null;
const videoMap = new Map();
const screenSenders = new Map();

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
            channelCount: 1,
        },
        video: false
    });

    /* Web Audio пайплайн поверх браузерного NS:
       - highpass 85Hz душит гул вентиляторов и низкочастотный rumble;
       - lowpass 8kHz режет верх, где живут «клики» мыши и удары клавиш;
       - compressor выравнивает динамику, чтобы тихая речь не тонула
         на фоне громких транзиентов.
       Анализатор «speaking» по-прежнему сидит на сыром localStream —
       UI отзывается на реальный голос пользователя, а не на отфильтрованный. */
    processedStream = applyAudioProcessing(localStream);

    createVolumeAnalyser(localStream, clientId);
    log.debug("rtc", "mic granted");
}

function applyAudioProcessing(rawStream) {
    if (!audioContext) {
        const Ctx = window.AudioContext || window.webkitAudioContext;
        if (!Ctx) return rawStream;
        audioContext = new Ctx();
    }

    const source = audioContext.createMediaStreamSource(rawStream);

    const highpass = audioContext.createBiquadFilter();
    highpass.type = "highpass";
    highpass.frequency.value = 85;
    highpass.Q.value = 0.7;

    const lowpass = audioContext.createBiquadFilter();
    lowpass.type = "lowpass";
    lowpass.frequency.value = 8000;
    lowpass.Q.value = 0.7;

    const compressor = audioContext.createDynamicsCompressor();
    compressor.threshold.value = -28;
    compressor.knee.value = 12;
    compressor.ratio.value = 4;
    compressor.attack.value = 0.005;
    compressor.release.value = 0.12;

    const destination = audioContext.createMediaStreamDestination();

    source.connect(highpass);
    highpass.connect(lowpass);
    lowpass.connect(compressor);
    compressor.connect(destination);

    return destination.stream;
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

    const outboundStream = processedStream || localStream;
    outboundStream.getTracks().forEach(track => {
        peer.addTrack(track, outboundStream);
    });

    if (screenStream?.active) {
        const senders = [];
        const vt = screenStream.getVideoTracks()[0];
        if (vt) senders.push(peer.addTrack(vt, screenStream));
        const at = screenStream.getAudioTracks()[0];
        if (at) senders.push(peer.addTrack(at, screenStream));
        if (senders.length) screenSenders.set(userId, senders);
    }

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
        if (event.track.kind === 'video') {
            let videoEl = videoMap.get(userId);
            if (!videoEl) {
                videoEl = document.createElement('video');
                videoEl.autoplay = true;
                videoEl.playsInline = true;
                videoMap.set(userId, videoEl);
            }
            videoEl.srcObject = event.streams[0];
            event.track.onended = () => {
                videoMap.delete(userId);
                if (typeof closeScreenOverlay === 'function') {
                    closeScreenOverlay();
                }
            };
            /* Если пользователь успел кликнуть «watch screen» до того,
               как трек приехал — открыть оверлей сейчас. */
            if (typeof notifyScreenVideoReady === 'function') {
                notifyScreenVideoReady(userId);
            }
            return;
        }

        // Screen audio arrives in the same stream as the screen video track.
        // The <video> element already plays that stream — skip creating a mic audio el.
        if (event.streams[0]?.getVideoTracks().length > 0) return;

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

    peer.onnegotiationneeded = async () => {
        if (!peer._isInitiator) return;
        if (peer.signalingState !== 'stable') return;
        try {
            const offer = await peer.createOffer();
            await peer.setLocalDescription(offer);
            sendSocket({ type: 'offer', to: peer._userId, offer: peer.localDescription });
        } catch (e) {
            // m-line drift: после быстрого add/remove track новый offer не
            // совпадает по порядку медиа-секций со старым. Браузер откатывает
            // изменение, существующая связь продолжает работать на прошлом SDP.
            // Полное решение — perfect-negotiation pattern (см. B6 в аудите).
            if (e?.name === 'InvalidAccessError') {
                log.warn("rtc", "renegotiation skipped (m-line drift)", { err: e.message });
            } else {
                log.error("rtc", "renegotiation failed", { err: e?.message || String(e) });
            }
        }
    };

    // Чат поверх WebRTC: DataChannel создаёт инициатор, второй слушает datachannel.
    // Делается ДО setLocalDescription — иначе SDP не будет содержать m=application.
    if (typeof setupChatChannelForPeer === "function") {
        setupChatChannelForPeer(peer, userId, !!isInitiator);
    }

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
        log.warn("rtc", "ice error", { err: e?.message || String(e) });
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
    log.debug("rtc", "peer state", { userId, state });

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
            log.info("rtc", "ice restart", { userId });
            await callUser(userId, { iceRestart: true });
        } catch (err) {
            log.warn("rtc", "ice restart failed", { err: err?.message || String(err) });
            rebuildPeer(userId);
            return;
        }

        const t = setTimeout(() => {
            const p = peers.get(userId);
            if (!p) return;
            if (p.connectionState === "connected") return;
            log.warn("rtc", "ice restart didn't help, rebuilding", { userId });
            rebuildPeer(userId);
        }, PEER_ICE_RESTART_TIMEOUT_MS);
        peerHealthTimers.set(userId, t);
    } else {
        log.debug("rtc", "peer broken, waiting for initiator", { userId, ms: PEER_PASSIVE_REBUILD_TIMEOUT_MS });
        const t = setTimeout(() => {
            const p = peers.get(userId);
            if (!p) return;
            if (p.connectionState === "connected") return;
            log.warn("rtc", "initiator didn't fix peer, taking over rebuild", { userId });
            rebuildPeer(userId);
        }, PEER_PASSIVE_REBUILD_TIMEOUT_MS);
        peerHealthTimers.set(userId, t);
    }
}

/** Пересоздать peer полностью (закрыть старый, новый offer с rebuild:true). */
function rebuildPeer(userId) {
    callUser(userId, { rebuild: true }).catch(err => {
        log.error("rtc", "peer rebuild failed", { err: err?.message || String(err) });
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

    if (typeof detachChatChannelForUser === "function") {
        detachChatChannelForUser(userId);
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

    if (processedStream) {
        processedStream.getTracks().forEach(track => track.stop());
        processedStream = null;
    }

    // Self-анализатор тоже больше не актуален — стрим остановлен.
    analyserMap.delete(clientId);

    log.debug("rtc", "stopped");
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

    log.debug("rtc", "peers torn down (local mic preserved)");
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

/* ========= SCREEN SHARING ========= */

async function startScreenShare(height = 1080, fps = 30, captureAudio = false) {
    const width = height === 480 ? 854 : height === 720 ? 1280 : 1920;
    screenStream = await navigator.mediaDevices.getDisplayMedia({
        video: {
            width: { ideal: width },
            height: { ideal: height },
            frameRate: { ideal: fps }
        },
        audio: captureAudio
    });
    const videoTrack = screenStream.getVideoTracks()[0];
    const audioTrack = screenStream.getAudioTracks()[0];
    for (const [userId, peer] of peers) {
        const senders = [];
        if (videoTrack) senders.push(peer.addTrack(videoTrack, screenStream));
        if (audioTrack) senders.push(peer.addTrack(audioTrack, screenStream));
        screenSenders.set(userId, senders);
    }
    videoTrack.onended = () => {
        stopScreenShare();
        if (typeof broadcastScreencastState === 'function') broadcastScreencastState(false);
        if (typeof updateScreencastButton === 'function') updateScreencastButton(false);
    };
}

function stopScreenShare() {
    for (const [userId, senders] of screenSenders) {
        const peer = peers.get(userId);
        if (peer) {
            for (const sender of senders) peer.removeTrack(sender);
        }
    }
    screenSenders.clear();
    screenStream?.getTracks().forEach(t => t.stop());
    screenStream = null;
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
