/* ========= WEBRTC ========= */

let localStream = null;
let processedStream = null;
let peers = new Map();
let audioContext = null;
let analyserMap = new Map();
let audioMap = new Map();
let volumeMap = new Map();

/**
 * Граф обработки локального микрофона: source → highpass → lowpass →
 * compressor → destination. Ссылки нужны, чтобы при teardown пройтись по
 * всем нодам и вызвать `disconnect()`. Без этого WebAudio удерживает
 * MediaStreamSource живым, AudioContext не закрывается, на долгих сессиях
 * течёт RAM. См. B14 / M1 / M2 в audit.md.
 */
let audioGraph = null;

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

/** Сколько polite-сторона ждёт прежде чем взять recovery в свои руки.
 *  Больше чем grace + ICE restart timeout impolite-стороны — даём ей шанс
 *  починить первой и не плодить встречные restart'ы. */
const PEER_PASSIVE_REBUILD_TIMEOUT_MS = 15000;

async function initMedia() {
    /* Если в настройках выбран конкретный микрофон — просим именно его.
       Иначе — системный default. Пустую строку в deviceId передавать
       нельзя, поэтому ветвим. */
    const audioConstraints = {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1,
    };
    const savedMicId = window.VoidSettings?.getAudioInId?.() || "";
    if (savedMicId) audioConstraints.deviceId = { exact: savedMicId };

    localStream = await navigator.mediaDevices.getUserMedia({
        audio: audioConstraints,
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

/**
 * Единая точка создания AudioContext с webkit-fallback. Раньше
 * `applyAudioProcessing` делал fallback, а `createVolumeAnalyser` — голый
 * `new AudioContext()`, и старый Safari падал на self-стриме (B11).
 * Возвращает null, если Web Audio не поддерживается вообще.
 */
function getOrCreateAudioContext() {
    if (audioContext) return audioContext;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return null;
    audioContext = new Ctx();
    return audioContext;
}

function applyAudioProcessing(rawStream) {
    if (!getOrCreateAudioContext()) return rawStream;

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

    /* GainNode в конце цепи — управляется ползунком «усиление» из настроек.
       1.0 = unity (нет изменений), <1 = тише, >1 = бустим. Меняется в
       реалтайме без renegotiation — peer.addTrack привязан к выходному
       destination.stream, дальше всё внутри Web Audio. */
    const gain = audioContext.createGain();
    const savedGain = window.VoidSettings?.getAudioInGain?.();
    gain.gain.value = typeof savedGain === "number" ? savedGain : 1.0;

    const destination = audioContext.createMediaStreamDestination();

    source.connect(highpass);
    highpass.connect(lowpass);
    lowpass.connect(compressor);
    compressor.connect(gain);
    gain.connect(destination);

    // Сохраняем ссылки для teardownAudioGraph(). Без этого ноды висят
    // подключёнными к контексту → утечка на каждый join/leave.
    audioGraph = { source, highpass, lowpass, compressor, gain, destination };

    return destination.stream;
}

/**
 * Разрывает граф обработки микрофона. Зовётся в `closeAllConnections` перед
 * закрытием AudioContext'а — чтобы WebAudio отпустил MediaStreamSource и
 * связанные с ним audioWorkletNode'ы.
 */
function teardownAudioGraph() {
    if (!audioGraph) return;
    for (const node of Object.values(audioGraph)) {
        try { node.disconnect(); } catch (_) {}
    }
    audioGraph = null;
}

/* ========= AUDIO IO (settings ↔ peers) =========
 *
 * Output device — `audio.setSinkId(id)` для каждого пир-`<audio>` и для
 * системных звуков (ambient/welcome/join/leave/message). API Chromium / FF 116+;
 * в Safari отсутствует, тогда всё идёт в системный default.
 *
 * Output volume — мастер-множитель (settings.audioOutGain ∈ [0..1]) поверх
 * per-peer (volumeMap[userId] ∈ [0..1]). Финал = clamp(per × master).
 *
 * Input gain — `audioGraph.gain.gain.value` (ровно последняя нода в цепи).
 * Меняется на лету, без renegotiation; peer.addTrack привязан к выходу
 * destination, граф «внутри» не виден другой стороне.
 *
 * Input device — `getUserMedia({audio:{deviceId:...}})`. Заменять трек на
 * лету через `replaceTrack` оставлено на будущее; пока — apply on rejoin.
 */

function getMasterOutputGain() {
    const v = window.VoidSettings?.getAudioOutGain?.();
    return typeof v === "number" ? v : 1.0;
}

function applyOutputVolumeForUser(userId) {
    const audio = audioMap.get(userId);
    if (!audio) return;
    const per = volumeMap.get(userId) ?? 1;
    const master = getMasterOutputGain();
    audio.volume = Math.max(0, Math.min(1, per * master));
}

function applyOutputVolumeAll() {
    for (const userId of audioMap.keys()) {
        applyOutputVolumeForUser(userId);
    }
    /* Системные звуки тоже подчиняются мастеру. Их базовые громкости
       заданы в audio.js (0.2 ambient, 0.4 join/leave/welcome) — умножаем
       master, не перебивая базу. */
    const master = getMasterOutputGain();
    applyMasterToSystemSound(window.ambientSound, 0.2 * master);
    applyMasterToSystemSound(window.welcomeSound, 0.4 * master);
    applyMasterToSystemSound(window.joinSound, 0.4 * master);
    applyMasterToSystemSound(window.leaveSound, 0.4 * master);
    /* messageSound — играется через chat.js, volume там фиксирован 0.5;
       обновим при следующем play(). Менять текущий .volume не имеет
       смысла, потому что playMessageSound сам выставляет его перед play. */
}

function applyMasterToSystemSound(el, finalVolume) {
    if (!el) return;
    el.volume = Math.max(0, Math.min(1, finalVolume));
}

async function applyOutputSinkToAudio(audio) {
    if (!audio || typeof audio.setSinkId !== "function") return;
    const id = window.VoidSettings?.getAudioOutId?.() || "";
    try {
        await audio.setSinkId(id);
    } catch (_) {
        /* устройство пропало / отозвали permission — fallback на default,
           уже стоит. Молчим. */
    }
}

function applyOutputSinkToAll() {
    for (const audio of audioMap.values()) applyOutputSinkToAudio(audio);
    /* Системные звуки тоже маршрутизируем в выбранный output. */
    applyOutputSinkToAudio(window.ambientSound);
    applyOutputSinkToAudio(window.welcomeSound);
    applyOutputSinkToAudio(window.joinSound);
    applyOutputSinkToAudio(window.leaveSound);
    const msg = document.getElementById("messageSound");
    if (msg) applyOutputSinkToAudio(msg);
}

function applyInputGain() {
    if (!audioGraph?.gain) return;
    const v = window.VoidSettings?.getAudioInGain?.();
    audioGraph.gain.gain.value = typeof v === "number" ? v : 1.0;
}

/* Settings-события: слушаем глобально один раз. Хендлер выживает между
   join/leave (audioMap/audioGraph пересоздаются — это нормально). */
document.addEventListener("void:audio-in-gain-changed", applyInputGain);
document.addEventListener("void:audio-out-gain-changed", applyOutputVolumeAll);
document.addEventListener("void:audio-out-device-changed", applyOutputSinkToAll);
/* audio-in-device-changed — применяем при следующем initMedia (apply on
   rejoin). Тут только пишем подсказку в лог, без принудительного reconnect. */
document.addEventListener("void:audio-in-device-changed", (e) => {
    log.info("rtc", "input device queued", { deviceId: e?.detail?.deviceId || "default" });
});

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
 *
 * Перфектная негоциация (https://w3c.github.io/webrtc-pc/#perfect-negotiation-example):
 * каждой паре пиров присваиваем стабильную «вежливую» сторону через сравнение
 * `clientId vs userId` — у двух пиров оценка симметрична, ровно один окажется
 * polite, второй impolite. Polite уступает при glare (откатывает свой offer и
 * принимает встречный), impolite давит. Это полностью убирает m-line drift и
 * гонки на встречных setLocalDescription, которые раньше ломали и
 * renegotiation, и ICE restart.
 *
 * `isChatInitiator` — это уже про другую ось: один из пары должен звать
 * `createDataChannel("chat")`, другой слушать `ondatachannel`. Маппится на
 * порядок вступления в комнату (тот, кто уже сидел и зовёт нового — он же
 * открывает чат-канал).
 */
function createPeer(userId, isChatInitiator) {

    const peer = new RTCPeerConnection({
        iceServers: ICE_SERVERS
    });

    peer._userId = userId;
    /* polite/impolite — детерминированно для пары. Сравнение строк стабильно
       и симметрично: одна сторона видит clientId>userId, другая — наоборот.
       На случай теоретического equals-кейса (не может произойти при валидных
       userId серверной проверки) обе будут impolite — в худшем случае offer
       один раз отклонится и пересогласуется. */
    peer._polite = String(clientId) > String(userId);
    peer._makingOffer = false;
    peer._isSettingRemoteAnswerPending = false;
    /* ICE-кандидаты, прилетевшие раньше setRemoteDescription (например на
       rebuild, когда сторона ещё не получила первый offer): копим тут и
       проливаем сразу после setRemoteDescription. */
    peer._pendingIceCandidates = [];
    /* Помечаем что СЛЕДУЮЩИЙ исходящий offer должен нести rebuild:true —
       сигнал той стороне закрыть свой старый peer и создать новый.
       Используется только в `rebuildPeer`. */
    peer._signalRebuildOnNextOffer = false;
    /* Один отчёт о связности на peer-объект: чем собралось соединение
       (direct/relay) либо что оно провалилось (failed). Уходит в админ-статистику,
       чтобы по реальным данным понять — нужен ли TURN. rebuild создаёт новый
       peer-объект с чистым флагом → считается новой попыткой, так и задумано. */
    peer._iceReported = false;

    /* Хендлеры вешаем ДО addTrack: addTrack синхронно ставит negotiation-needed
       во флаг, который потом превратится в событие в следующем microtask.
       К этому моменту onnegotiationneeded уже должен быть на месте. */
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
                videoEl.muted = true; // audio routed via WebAudio in screen overlay only
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
        /* Финальная громкость = per-peer × master из settings. Через хелпер,
           чтобы оба источника применялись одинаково и при ontrack, и при
           движении ползунка громкости в настройках, и при движении арки. */
        applyOutputVolumeForUser(userId);
        /* Маршрутизируем audio в выбранный output device. На Safari/старых
           браузерах функция setSinkId отсутствует — `applyOutputSinkToAudio`
           тихо вернётся. */
        applyOutputSinkToAudio(audio);

        // Старый analyser привязан к мёртвому source — пересоздаём.
        // Старый rAF-цикл сам остановится (см. monitorVolume).
        analyserMap.delete(userId);
        createVolumeAnalyser(event.streams[0], userId);
    };

    peer.onconnectionstatechange = () => {
        handlePeerConnectionStateChange(userId);
    };

    /* Канон perfect negotiation. Никаких guard'ов на signalingState или роль —
       glare разрешается на стороне получателя через polite/impolite в handleOffer.
       setLocalDescription() без аргументов сам создаёт offer/answer в зависимости
       от текущего signalingState (modern API, поддерживается всеми evergreen
       браузерами начиная с Chrome 80 / FF 75 / Safari 14.1). */
    peer.onnegotiationneeded = async () => {
        try {
            peer._makingOffer = true;
            await peer.setLocalDescription();
            const desc = peer.localDescription;
            // setLocalDescription может в редком случае дать answer, если до
            // того, как наш task пришёл, мы успели получить и применить чужой
            // offer (signalingState уехал в have-remote-offer). Такое бывает
            // на стартовом mesh-handshake: addTrack планирует neg-needed,
            // параллельно прилетает встречный offer и handleOffer его
            // отрабатывает раньше нас. Тогда тут уже создан answer — и
            // отправлять его нужно как answer, не как offer.
            const sdp = screenStream?.active ? patchOpusForStereo(desc.sdp) : desc.sdp;
            const msg = { to: peer._userId, type: desc.type };
            if (desc.type === "offer") msg.offer = { type: desc.type, sdp };
            else msg.answer = { type: desc.type, sdp };
            if (desc.type === "offer" && peer._signalRebuildOnNextOffer) {
                msg.rebuild = true;
                peer._signalRebuildOnNextOffer = false;
            }
            sendSocket(msg);
        } catch (err) {
            log.error("rtc", "negotiation failed", { err: err?.message || String(err) });
        } finally {
            peer._makingOffer = false;
        }
    };

    // Чат поверх WebRTC: DataChannel создаёт инициатор, второй слушает datachannel.
    // Делается ДО первого addTrack/setLocalDescription — иначе первый SDP не
    // будет содержать m=application и позже придётся ренеготировать.
    if (typeof setupChatChannelForPeer === "function") {
        setupChatChannelForPeer(peer, userId, !!isChatInitiator);
    }

    /* Tracks добавляем ПОСЛЕ всех хендлеров (особенно onnegotiationneeded).
       addTrack синхронно ставит negotiation-needed во флаг, событие отдаётся
       в следующий microtask — к этому моменту хендлер уже на месте. */
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
        applyScreenAudioParams(senders);
    }

    peers.set(userId, peer);

    return peer;
}

/**
 * Открыть соединение с новым участником. Создаёт peer, добавляет треки —
 * дальше движок сам сгенерит negotiation-needed → offer уйдёт через
 * onnegotiationneeded.
 *
 * Этот вызов используется ТОЛЬКО для первичного знакомства (получили
 * `new-participant` от сервера). Восстановление существующего peer'а —
 * через `restartPeerIce` или `rebuildPeer`.
 */
function callUser(userId) {
    if (!peers.has(userId)) {
        // isChatInitiator=true — мы уже в комнате, новый юзер только пришёл,
        // значит наш peer открывает чат-канал.
        createPeer(userId, true);
    }
    // Никакого ручного createOffer: addTrack внутри createPeer уже
    // запланировал negotiation-needed.
}

async function handleOffer(data) {

    // Сторона решила сделать full rebuild и прислала rebuild:true. Закрываем
    // свой старый peer (если был) — иначе setRemoteDescription упадёт на
    // несовпадении DTLS fingerprint'ов.
    if (data.rebuild) {
        cleanupPeerSlot(data.from);
    }

    let peer = peers.get(data.from);
    if (!peer) {
        // Получили offer первыми → мы chat-receiver, не chat-initiator.
        peer = createPeer(data.from, false);
    }

    /* Glare detection. Если мы СЕЙЧАС сами генерируем offer (или ждём
       rollback со старого pendingLocalOffer), и пришёл встречный — это
       collision. Polite сторона уступает (сама сделает implicit rollback
       внутри setRemoteDescription({type:"offer"}) в новом API), impolite
       игнорит входящий, продолжая свой. */
    const offerCollision =
        peer.signalingState !== "stable" && !peer._isSettingRemoteAnswerPending;
    const ignoreOffer = !peer._polite && offerCollision;
    if (ignoreOffer) {
        log.debug("rtc", "ignoring colliding offer (impolite)", { from: data.from });
        return;
    }

    try {
        await peer.setRemoteDescription(new RTCSessionDescription(data.offer));
        await drainPendingIce(peer);
        await peer.setLocalDescription();
        sendSocket({
            type: "answer",
            to: data.from,
            answer: peer.localDescription
        });
    } catch (err) {
        log.warn("rtc", "handleOffer failed", { err: err?.message || String(err) });
    }
}

async function handleAnswer(data) {

    const peer = peers.get(data.from);
    if (!peer) return;

    try {
        peer._isSettingRemoteAnswerPending = true;
        await peer.setRemoteDescription(new RTCSessionDescription(data.answer));
    } catch (err) {
        log.warn("rtc", "handleAnswer failed", { err: err?.message || String(err) });
        return;
    } finally {
        peer._isSettingRemoteAnswerPending = false;
    }
    await drainPendingIce(peer);
}

async function handleIce(data) {

    const peer = peers.get(data.from);
    if (!peer) return;

    /* Сетевой пакет с кандидатом мог обогнать соответствующий offer/answer
       (типичная гонка на rebuild и медленных каналах). addIceCandidate в
       таком случае бросает «remote description has not been set» —
       кандидат теряется. Поэтому копим в очередь, проливаем сразу
       после setRemoteDescription. */
    if (!peer.remoteDescription) {
        peer._pendingIceCandidates.push(data.candidate);
        return;
    }

    try {
        await peer.addIceCandidate(data.candidate);
    } catch (err) {
        // В момент glare-rollback попытка добавить кандидат шумит зря.
        if (!peer._isSettingRemoteAnswerPending) {
            log.warn("rtc", "ice error", { err: err?.message || String(err) });
        }
    }
}

async function drainPendingIce(peer) {
    if (!peer._pendingIceCandidates || peer._pendingIceCandidates.length === 0) return;
    const queue = peer._pendingIceCandidates;
    peer._pendingIceCandidates = [];
    for (const c of queue) {
        try {
            await peer.addIceCandidate(c);
        } catch (err) {
            log.warn("rtc", "pending ice add failed", { err: err?.message || String(err) });
        }
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
        reportConnectivity(peer);
        return;
    }

    if (state === "failed" && !peer._iceReported) {
        // Терминальный провал, до connected так и не дошли — это и есть тот
        // случай, где помог бы TURN-релей. Считаем отдельно.
        peer._iceReported = true;
        sendSocket({ type: "ice-report", result: "failed" });
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
 * Активная роль = impolite-сторона (детерминированно одна на пару) — она же
 * делает ICE restart. Polite-сторона ждёт окно и затем делает full rebuild,
 * если impolite за это время не починил.
 *
 * Это нужно чтобы избежать одновременных встречных restart'ов: с perfect
 * negotiation glare уже не ломает SDP, но лишняя работа всё равно ни к чему.
 */
function attemptPeerRecovery(userId) {
    const peer = peers.get(userId);
    if (!peer) return;

    if (!peer._polite) {
        // Impolite — активная сторона.
        log.info("rtc", "ice restart", { userId });
        try {
            peer.restartIce();
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
        // Polite — пассивная сторона. Даём impolite шанс починить.
        log.debug("rtc", "peer broken, waiting for impolite", { userId, ms: PEER_PASSIVE_REBUILD_TIMEOUT_MS });
        const t = setTimeout(() => {
            const p = peers.get(userId);
            if (!p) return;
            if (p.connectionState === "connected") return;
            log.warn("rtc", "impolite didn't fix peer, taking over rebuild", { userId });
            rebuildPeer(userId);
        }, PEER_PASSIVE_REBUILD_TIMEOUT_MS);
        peerHealthTimers.set(userId, t);
    }
}

/**
 * Пересоздать peer полностью: закрыть старый, создать новый, пометить что
 * первый исходящий offer должен нести rebuild:true (сигнал той стороне тоже
 * пересоздать свой peer — иначе DTLS fingerprint не сойдётся).
 */
function rebuildPeer(userId) {
    cleanupPeerSlot(userId);
    const peer = createPeer(userId, true);
    peer._signalRebuildOnNextOffer = true;
    // addTrack внутри createPeer уже запланировал negotiation-needed —
    // offer уйдёт сам, флаг rebuild подхватится в onnegotiationneeded.
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
 * video-элемент, screen-senders, анализатор громкости, health-timer.
 * Используется и для штатного выхода участника, и для rebuild peer-а.
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

    /* B5: videoMap чистился только в `event.track.onended`. При network drop /
       kill -9 / закрытии вкладки `onended` может не прийти — <video> с мёртвым
       stream'ом висит в map'е, а у наблюдателя остаётся открытый оверлей с
       замороженной картинкой. Чистим явно здесь. */
    const videoEl = videoMap.get(userId);
    if (videoEl) {
        videoEl.srcObject = null;
        videoMap.delete(userId);
        if (typeof closeScreenOverlay === "function") closeScreenOverlay();
    }

    /* B4: screenSenders не очищался — после rebuild пира запись оставалась,
       и `stopScreenShare` потом дёргал removeTrack на закрытом peer'е (не
       падает, но мусор). */
    screenSenders.delete(userId);

    if (userId !== clientId) {
        analyserMap.delete(userId);
    }

    if (typeof detachChatChannelForUser === "function") {
        detachChatChannelForUser(userId);
    }

    clearPeerHealthTimer(userId);
    _pingCache.delete(userId);
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
    analyserMap.clear();

    // Web Audio teardown: рвём граф, закрываем контекст. Без этого RAM
    // течёт на каждый цикл join/leave (B14, M1, M2 из audit.md).
    teardownAudioGraph();
    if (audioContext) {
        try { audioContext.close(); } catch (_) {}
        audioContext = null;
    }

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

    /* B11: через общий хелпер с webkit-fallback. Голый `new AudioContext()`
       ронял старый Safari на self-стриме. Если Web Audio нет вообще —
       тихо пропускаем визуализацию громкости (не критичная фича). */
    if (!getOrCreateAudioContext()) return;

    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 256;

    const source = audioContext.createMediaStreamSource(stream);
    source.connect(analyser);

    analyserMap.set(userId, analyser);

    monitorVolume(userId, analyser);
}

function monitorVolume(userId, analyser) {

    const dataArray = new Uint8Array(analyser.frequencyBinCount);
    let lastTick = 0;

    function checkVolume(t) {

        // Self-stop: если в analyserMap уже не наш analyser (ICE restart, rebuild,
        // cleanup) — выходим из rAF-цикла, не плодим зомби-loop'ы.
        if (analyserMap.get(userId) !== analyser) return;

        if (t - lastTick > 33) { // ~30 Hz вместо 60
            lastTick = t;

            analyser.getByteFrequencyData(dataArray);

            let sum = 0;
            for (let i = 0; i < dataArray.length; i++) {
                sum += dataArray[i];
            }

            if (window.onVolumeChange) {
                window.onVolumeChange(userId, sum / dataArray.length);
            }
        }

        requestAnimationFrame(checkVolume);
    }

    requestAnimationFrame(checkVolume);
}

/* ========= SCREEN SHARING ========= */

async function startScreenShare(height = 1080, fps = 30, captureAudio = false) {
    const width = height === 480 ? 854 : height === 720 ? 1280 : 1920;
    /* По дефолту getDisplayMedia({audio:true}) даёт mono 32-48kHz без явных
       constraints — Chrome применяет VoIP-цепочку и opus в voip-mode, итог
       «телефонное» качество для музыки/видео-демки. Просим стерео 48kHz.
       echoCancellation:true — Chrome вычитает из захваченного системного аудио
       всё, что сам же вывел через браузерный аудио-движок (голоса пиров из WebRTC),
       иначе их голоса попадают в screencast-поток и возвращаются к ним эхом.
       noiseSuppression/autoGainControl отключены, чтобы не душить музыку и
       не вызывать ducking (AGC+AEC вместе порождают затихание при разговоре зрителя). */
    const audioConstraints = captureAudio ? {
        echoCancellation: true,
        noiseSuppression: false,
        autoGainControl: false,
        sampleRate: 48000,
        channelCount: 2
    } : false;
    screenStream = await navigator.mediaDevices.getDisplayMedia({
        video: {
            width: { ideal: width },
            height: { ideal: height },
            frameRate: { ideal: fps }
        },
        audio: audioConstraints
    });
    const videoTrack = screenStream.getVideoTracks()[0];
    const audioTrack = screenStream.getAudioTracks()[0];
    /* contentHint="music" — подсказка W3C, что трек НЕ голос. Chrome переключает
       opus из voip-mode в audio-mode (стерео, без DTX, без VAD-подавления). Без
       этого даже после bitrate-бампа звук остаётся «сжатым». */
    if (audioTrack) {
        try { audioTrack.contentHint = "music"; } catch (_) {}
    }
    for (const [userId, peer] of peers) {
        const senders = [];
        if (videoTrack) senders.push(peer.addTrack(videoTrack, screenStream));
        if (audioTrack) senders.push(peer.addTrack(audioTrack, screenStream));
        if (senders.length) screenSenders.set(userId, senders);
        applyScreenAudioParams(senders);
    }
    videoTrack.onended = () => {
        stopScreenShare();
        if (typeof broadcastScreencastState === 'function') broadcastScreencastState(false);
        if (typeof updateScreencastButton === 'function') updateScreencastButton(false);
    };
}

/**
 * SDP-патч для opus: добавляет stereo=1;sprop-stereo=1;maxaveragebitrate=192000
 * к fmtp-строке opus, чтобы браузер договорился на стерео-передачу вместо mono voip.
 * Применяется только в offer/answer, сгенерированных при активном screenStream.
 */
function patchOpusForStereo(sdp) {
    return sdp.replace(
        /(a=fmtp:\d+ .+?(?:minptime=\d+|useinbandfec=\d+)[^\r\n]*)/g,
        (match) => {
            if (match.includes("stereo=1")) return match;
            return match + ";stereo=1;sprop-stereo=1;maxaveragebitrate=192000";
        }
    );
}

/**
 * Поднять параметры encoder'а на screen-audio sender'е: целевой битрейт 192
 * kbps (по дефолту opus сидит на ~32 kbps voip), networkPriority="high"
 * чтобы при congestion'е звук не резался первым. Без этого даже стерео-захват
 * звучит так же зажато, как и узкополосный mono — кодек просто не выдаёт
 * больше bandwidth.
 */
async function applyScreenAudioParams(senders) {
    const audioSender = senders.find(s => s.track?.kind === "audio");
    if (!audioSender) return;
    try {
        const params = audioSender.getParameters();
        if (!params.encodings || !params.encodings.length) params.encodings = [{}];
        params.encodings[0].maxBitrate = 192000;
        params.encodings[0].networkPriority = "high";
        await audioSender.setParameters(params);
    } catch (err) {
        log.warn("rtc", "screen audio setParameters failed", { err: err?.message || String(err) });
    }
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
const _pingCache = new Map(); // userId → { value, ts }
const _PING_CACHE_TTL = 1500;

async function getPeerPing(userId) {
    const peer = peers.get(userId);
    if (!peer) return null;

    const cached = _pingCache.get(userId);
    if (cached && Date.now() - cached.ts < _PING_CACHE_TTL) return cached.value;

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

        const value = nominated ?? fallback;
        _pingCache.set(userId, { value, ts: Date.now() });
        return value;
    } catch {
        return null;
    }
}

/* ========= CONNECTIVITY REPORT =========
 *
 * Сообщаем серверу, КАК собралось peer-соединение — напрямую (host/srflx/prflx)
 * или через relay (TURN). Сервер копит счётчики, админка показывает воронку
 * direct/relay/failed. По этим реальным цифрам потом и решается вопрос — стоит
 * ли вообще поднимать TURN. Никаких лишних пакетов: читаем ту же статистику,
 * что WebRTC уже считает по STUN/RTCP.
 */

/**
 * Определить тип установленного соединения по активной паре кандидатов.
 * Возвращает "relay" если ХОТЯ БЫ одна сторона (локальная или удалённая)
 * сидит на TURN, "direct" если обе пробились напрямую, null — если статистику
 * прочитать не удалось (тогда отчёт не шлём, чтобы не врать в цифрах).
 */
async function classifyConnection(peer) {
    try {
        const stats = await peer.getStats();
        let pair = null;
        stats.forEach(report => {
            if (report.type !== "candidate-pair") return;
            if (report.state !== "succeeded") return;
            if (report.nominated && !pair) pair = report;
        });
        if (!pair) return null;

        const local = stats.get(pair.localCandidateId);
        const remote = stats.get(pair.remoteCandidateId);
        if (!local && !remote) return null;

        const isRelay = c => c && c.candidateType === "relay";
        return (isRelay(local) || isRelay(remote)) ? "relay" : "direct";
    } catch {
        return null;
    }
}

/**
 * Один раз на peer-объект отправить отчёт об успешной связности.
 * Зовётся при переходе peer в "connected".
 */
async function reportConnectivity(peer) {
    if (peer._iceReported) return;
    const result = await classifyConnection(peer);
    if (!result) return;          // статистика недоступна — лучше промолчать
    if (peer._iceReported) return; // мог измениться, пока ждали getStats
    peer._iceReported = true;
    sendSocket({ type: "ice-report", result });
}
