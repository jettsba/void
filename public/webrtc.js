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
/* Desktop-only: AudioContext + Tauri Channel для нативного loopback-захвата
   звука демки (см. startNativeScreenAudio / src-tauri/src/screen_audio.rs).
   Reset в stopNativeScreenAudio. */
let screenAudioCtx = null;
let screenAudioChannel = null;
/* Запомненные параметры активной screen-share: используется в
   applyDirectScreenVideoParams (при добавлении screen-sender'а в новый peer,
   например — re-join во время трансляции). Reset в stopScreenShare. */
let screenTargetHeight = 1080;
let screenTargetFps = 30;
/* Суммарный бюджет аплоада демки (бит/с), делится между зрителями (mesh: один
   video-track уходит N отдельными потоками, аплоад шарера иначе = N × потолок).
   28M подобран как СТРОГО без регресса для нынешних размеров комнаты: при ≤4
   зрителях (комната ≤5) 1080p30-потолок 7M не жмётся (28/4=7M) — байт-в-байт как
   раньше; дальше плавный спад (6 зр → 4.7M, 9 зр → ~3.1M, крепкое 720p+). 60fps-
   потолок (11.2M) на многих зрителях подрежется — осознанно, 45M аплоада на 4
   зрителя всё равно нереалистичен. Основную relay-нагрузку coturn держит отдельный
   3.0M-cap в applyRelayBitrateLimits; бюджет — прежде всего про direct-аплоад
   шарера (иначе 9 зр × 7M = 63M). См. screenViewerCount / reapplyScreenVideoBudget. */
const SCREEN_UPLOAD_BUDGET = 28_000_000;
const videoMap = new Map();
const screenSenders = new Map();

/**
 * Таймеры health-check для каждого пира.
 * Ключ — userId, значение — id таймера. Используется чтобы при следующем
 * изменении состояния отменить предыдущий запланированный recovery.
 */
const peerHealthTimers = new Map();

/**
 * T1.2: zombie peer watchdog. Когда peer в `connected`, ожидаем непрерывный
 * поток audio-пакетов (Chromium шлёт comfort-noise RTP даже при mute, т.е.
 * `track.enabled = false` не обнуляет packetsReceived). Если счётчик не растёт
 * 5+ сек — peer truly dead (kill -9 / BSOD / выдернули LAN ДО pagehide).
 * Не дожидаемся ICE-таймаута (до 13+ сек), сразу rebuildPeer.
 *
 * peerZombieWatchers: userId → { timer, lastCount, lastGrowthAt, startedAt }
 * peerZombieRebuilds: userId → { count, firstAt } — circuit breaker, чтобы
 *   при структурном баге не уйти в бесконечный rebuild-loop.
 */
const peerZombieWatchers = new Map();
const peerZombieRebuilds = new Map();
const ZOMBIE_CHECK_INTERVAL_MS = 2000;
const ZOMBIE_THRESHOLD_MS = 5000;
/* Не триггерим watchdog в первые секунды после connected — нужно дать времени
   первым audio-пакетам долететь и поднять счётчик с нуля. На быстром direct'е
   первый inbound-rtp.packetsReceived появляется за <500мс, на TURN-relay'е
   через high-latency путь может быть до 2 сек. */
const ZOMBIE_WARMUP_MS = 3000;
const ZOMBIE_MAX_REBUILDS_PER_MINUTE = 2;

/**
 * Watchdog'и «черного экрана» по userId. Видео-трек приехал через ontrack,
 * но frame'ы не декодируются (perfect negotiation race, codec mismatch,
 * direction='inactive' из-за глюка SDP). Через 5s после ontrack проверяем
 * inbound-rtp.framesDecoded — если 0, дёргаем ICE restart. Чистится в
 * cleanupPeerSlot. */
const videoDecodeWatchdogs = new Map();
const VIDEO_DECODE_WATCHDOG_MS = 5000;

/**
 * Watchdog'и «застрял в negotiation»: если signalingState вышел из stable
 * (offer отправлен, answer не пришёл — или наоборот) и не вернулся в stable
 * за SIG_STUCK_TIMEOUT_MS, дёргаем ICE restart. Без этого peer может висеть
 * в have-local-offer часами (мы получили реальный кейс на v0.9.10 — стрим
 * шёл, потом юзер пере-запустил screencast с другими параметрами,
 * перенeгоциация утонула, на той стороне чёрный экран). */
const sigStuckTimers = new Map();
const SIG_STUCK_TIMEOUT_MS = 12_000;

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

function buildMicConstraints() {
    /* Если в настройках выбран конкретный микрофон — просим именно его.
       Иначе — системный default. Пустую строку в deviceId передавать
       нельзя, поэтому ветвим. */
    /* M4.2: на дешёвых Android-микрофонах AGC вместе с AEC даёт эффект
       «обрезанных слов» («при…ро…рот») — слышно у собеседника, потому что
       AGC качает gain туда-сюда, а AEC при этом подавляет «эхо» собственной
       речи. У нас в Web-Audio графе есть свой DynamicsCompressor (см.
       applyAudioProcessing) — он берёт на себя выравнивание динамики
       вместо браузерного AGC. NS и AEC оставляем: NS компенсирует фон,
       AEC обязателен на спикерфоне, без него собеседник слышит своё эхо. */
    const isAndroid = /Android/.test(navigator.userAgent);
    /* RNNoise активируется автоматически при наличии AudioWorklet (все Chromium
       66+, Firefox 76+, Safari 14.1+). В этом случае штатный chromium NS
       отключаем — двойная обработка ухудшает сигнал. Если AudioWorklet нет
       (древний браузер / WebView) — fallback на chromium NS. */
    const audioWorkletSupported = typeof AudioWorkletNode !== "undefined";
    /* Пользовательский тумблер шумоподавления (настройки → аудио). Когда выключен —
       не просим штатный NS и не вставляем RNNoise (см. applyAudioProcessing). */
    const noiseEnabled = window.VoidSettings?.getNoiseSuppression?.() !== false;
    const audioConstraints = {
        echoCancellation: true,
        noiseSuppression: noiseEnabled && !audioWorkletSupported,
        autoGainControl: !isAndroid,
        channelCount: 1,
    };
    const savedMicId = window.VoidSettings?.getAudioInId?.() || "";
    if (savedMicId) audioConstraints.deviceId = { exact: savedMicId };
    return audioConstraints;
}

async function initMedia() {
    localStream = await navigator.mediaDevices.getUserMedia({
        audio: buildMicConstraints(),
        video: false
    });

    /* Web Audio пайплайн поверх браузерного NS:
       - highpass 85Hz душит гул вентиляторов и низкочастотный rumble;
       - lowpass 8kHz режет верх, где живут «клики» мыши и удары клавиш;
       - compressor выравнивает динамику, чтобы тихая речь не тонула
         на фоне громких транзиентов.
       Анализатор «speaking» по-прежнему сидит на сыром localStream —
       UI отзывается на реальный голос пользователя, а не на отфильтрованный. */
    processedStream = await applyAudioProcessing(localStream);

    /* F5: микрофонный трек может умереть посреди звонка (USB-устройство
       выдернули, переключили Bluetooth, OS отозвала audio session). Tracks
       уходят в `ended`, peer'ы продолжают передавать тишину, юзер этого
       не знает. Слушаем onended → toast + попытка пересобрать через
       getUserMedia + replaceTrack для всех peers. */
    watchLocalMicTrack(localStream);

    createVolumeAnalyser(localStream, clientId);
    log.debug("rtc", "mic granted");

    /* Fire-and-forget: запрашиваем TURN-creds параллельно с поднятием UI.
       К моменту первого `callUser` (после получения user-list по WS) обычно
       успевает — peer создастся уже с TURN в iceServers. Если не успел —
       первый peer стартует со STUN-only; при необходимости recovery state
       machine пересоберёт его через ICE restart/rebuild уже с TURN.
       Без await — getUserMedia уже отработал, блокировать UI на сетевом
       запросе бессмысленно. */
    ensureTurnCredentials();
}

function watchLocalMicTrack(stream) {
    const track = stream?.getAudioTracks?.()[0];
    if (!track) return;
    track.addEventListener("ended", onLocalMicEnded, { once: true });
}

let _micReinitInFlight = false;

async function onLocalMicEnded() {
    if (_micReinitInFlight) return;
    _micReinitInFlight = true;
    try {
        log.warn("rtc", "local mic track ended unexpectedly");
        if (typeof isJoined !== "undefined" && !isJoined) return;
        if (typeof showRoomToast === "function") {
            showRoomToast(_micT("errors.mic-lost"));
        }
        const ok = await reinitLocalMic();
        if (!ok && typeof showRoomToast === "function") {
            showRoomToast(_micT("errors.mic-lost.failed"));
        }
    } finally {
        _micReinitInFlight = false;
    }
}

function _micT(key) {
    if (typeof _t === "function") return _t(key);
    if (window.VoidI18n?.t) return window.VoidI18n.t(key);
    return key;
}

/**
 * Полная пересборка локального микрофона: новый getUserMedia, новый Web Audio
 * граф, замена трека во всех peer-соединениях через `replaceTrack` (без
 * renegotiation — sender'у можно подменить track в горячую, m=audio остаётся).
 * Возвращает true если получилось, false если getUserMedia провалился.
 */
async function reinitLocalMic() {
    teardownAudioGraph();
    localStream = null;
    processedStream = null;

    try {
        localStream = await navigator.mediaDevices.getUserMedia({
            audio: buildMicConstraints(),
            video: false
        });
    } catch (err) {
        log.error("rtc", "mic re-acquire failed", { err: err?.message || String(err) });
        return false;
    }

    processedStream = await applyAudioProcessing(localStream);
    watchLocalMicTrack(localStream);

    // Self analyser завязан на старый (мёртвый) stream — пересоздаём на новом.
    analyserMap.delete(clientId);
    createVolumeAnalyser(localStream, clientId);

    const newAudioTrack = (processedStream || localStream).getAudioTracks()[0];
    if (newAudioTrack) {
        for (const peer of peers.values()) {
            const sender = peer._micSender;
            if (!sender) continue;
            try {
                await sender.replaceTrack(newAudioTrack);
            } catch (err) {
                log.warn("rtc", "mic replaceTrack failed", { userId: peer._userId, err: err?.message || String(err) });
            }
        }
    }

    /* Применяем текущее isMicOn — getUserMedia всегда возвращает enabled=true,
       а юзер мог быть в muted-режиме. Без applyAudioState peer'ы услышат звук
       вопреки его выключенному микрофону. */
    if (typeof applyAudioState === "function") applyAudioState();

    log.info("rtc", "mic re-initialized");
    return true;
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
    /* Просим 48 kHz: RNNoise работает строго на этой частоте. На многих
       Windows-конфигах source idle 44.1 kHz, без явного указания AudioContext
       подхватывает source-rate и RNNoise отключается с reason="sampleRate=...".
       Браузер сам делает resample 44.1→48, overhead копеечный. Fallback на
       дефолт если конструктор отверг опцию (старый Safari <14.5). */
    try {
        audioContext = new Ctx({ sampleRate: 48000 });
    } catch (_) {
        audioContext = new Ctx();
    }
    /* iOS Safari создаёт AudioContext в state="suspended"; destination.stream
       при этом выдаёт ТИШИНУ, хотя mic-track active. Self-analyser сидит на
       raw localStream — поэтому свой mic-индикатор работает, а собеседник не
       слышит ничего. Лечится явным resume() после user-gesture;
       getOrCreateAudioContext зовётся из initMedia, который запускается из
       click-handler tryJoin / handleCreateClick → user-gesture в стеке.
       statechange-листенер ловит interrupted (входящий звонок / Siri /
       переключение приложений на iOS) и снова resume'ит на возврате. */
    const resumeIfNeeded = () => {
        if (!audioContext) return;
        if (audioContext.state === "suspended" || audioContext.state === "interrupted") {
            audioContext.resume().catch(err =>
                log.warn("rtc", "audio context resume failed", { state: audioContext?.state, err: err?.message || String(err) })
            );
        }
    };
    resumeIfNeeded();
    audioContext.addEventListener("statechange", resumeIfNeeded);
    return audioContext;
}

/* AudioWorklet module load — кэшируем промис addModule НА самом AudioContext
   (`ctx._rnnoiseModulePromise`), а НЕ в модульной переменной. AudioWorklet-
   модули регистрируются per-context; при leave→join старый ctx закрывается
   (stopAllMedia: audioContext.close() + null) и создаётся новый. Глобальный кэш
   тогда отдавал резолв ЗАКРЫТОГО ctx — `await` проходил мгновенно, а
   `new AudioWorkletNode(новый ctx)` падал с «AudioWorklet does not have a valid
   AudioWorkletGlobalScope … addModule first». Свойство на ctx живёт ровно
   столько же, сколько сам ctx: новый ctx ⇒ новый addModule. */
async function createRnnoiseNode(ctx) {
    if (!ctx || !ctx.audioWorklet) return null;
    try {
        if (!ctx._rnnoiseModulePromise) {
            ctx._rnnoiseModulePromise = ctx.audioWorklet.addModule("audio/rnnoise-processor.js?v=1");
        }
        await ctx._rnnoiseModulePromise;
        const node = new AudioWorkletNode(ctx, "rnnoise-processor", {
            numberOfInputs: 1,
            numberOfOutputs: 1,
            channelCount: 1,
            channelCountMode: "explicit",
            channelInterpretation: "speakers"
        });
        node.port.onmessage = (e) => {
            const t = e.data?.type;
            if (t === "ready") log.info("rtc", "rnnoise ready");
            else if (t === "disabled") log.warn("rtc", "rnnoise disabled", { reason: e.data.reason });
            else if (t === "error") log.warn("rtc", "rnnoise error", { msg: e.data.message });
        };
        return node;
    } catch (err) {
        log.warn("rtc", "rnnoise init failed — fallback to passthrough", { err: err?.message || String(err) });
        _rnnoiseModulePromise = null;
        return null;
    }
}

async function applyAudioProcessing(rawStream) {
    if (!getOrCreateAudioContext()) return rawStream;

    const source = audioContext.createMediaStreamSource(rawStream);

    /* RNNoise node вставляется ПЕРЕД filtering — сначала ML-денойз убирает
       стационарный шум (вентилятор, клавиатура, фоновый speech), потом
       наши highpass/lowpass/compressor работают на чистом сигнале. Если
       worklet не поднялся (старый браузер) — фallback на источник напрямую,
       штатный NS в этом случае был включён в buildMicConstraints. Если юзер
       выключил шумоподавление в настройках — RNNoise не вставляем вовсе. */
    const noiseEnabled = window.VoidSettings?.getNoiseSuppression?.() !== false;
    const rnnoise = noiseEnabled ? await createRnnoiseNode(audioContext) : null;

    /* Highpass: 110Hz на десктопе режет гул вентилятора / холодильника /
       сабвуферный rumble. На мобильном — 80Hz: iPhone в speakerphone-режиме
       пишет голос с fundamental 90-110Hz (микрофон у нижней грани, далеко
       от рта), и 110Hz делает голос «тонким, бубнящим». 80Hz держит body
       голоса, при этом всё ещё режет rumble от тряски телефона в руке
       (физическая дрожь обычно <60Hz, системные NS его не лечат). */
    const _isMobile = matchMedia("(hover: none) and (pointer: coarse)").matches;
    const highpass = audioContext.createBiquadFilter();
    highpass.type = "highpass";
    highpass.frequency.value = _isMobile ? 80 : 110;
    highpass.Q.value = 0.7;

    const lowpass = audioContext.createBiquadFilter();
    lowpass.type = "lowpass";
    lowpass.frequency.value = 8000;
    lowpass.Q.value = 0.7;

    /* Compressor чуть агрессивнее (ratio 5 вместо 4, threshold -30 вместо
       -28) — лучше выравнивает динамику, тихая речь не теряется на фоне
       громких транзиентов. Не доводим до «wall of sound» — knee 12 даёт
       плавный заход. */
    const compressor = audioContext.createDynamicsCompressor();
    compressor.threshold.value = -30;
    compressor.knee.value = 12;
    compressor.ratio.value = 5;
    compressor.attack.value = 0.005;
    compressor.release.value = 0.12;

    /* Noise gate: AnalyserNode меряет RMS на выходе компрессора, отдельный
       GainNode (gateGain) гасит сигнал ниже порога. Hysteresis (ON порог
       выше OFF) + hold timer гасят флапание на коротких паузах между
       словами. Лечит тихий фоновый шум (вентилятор, ambient) — то что Chrome
       NS пропускает потому что считает «полезным сигналом». Громкий фон
       (машина за окном, чужие голоса) gate не возьмёт — он выше порога. */
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.2;
    const analyserData = new Float32Array(analyser.fftSize);

    const gateGain = audioContext.createGain();
    gateGain.gain.value = 1;
    const GATE_ON_LIN = Math.pow(10, -50 / 20);   // ~0.00316  (≈ -50 dBFS)
    const GATE_OFF_LIN = Math.pow(10, -56 / 20);  // ~0.00158  (≈ -56 dBFS, hysteresis)
    const GATE_HOLD_MS = 180;
    const GATE_ATTACK_S = 0.01;   // быстро открыть (не cut начало слова)
    const GATE_RELEASE_S = 0.20;  // медленно закрыть (не cut концы фраз)
    const gateState = { open: true, lastSoundAt: performance.now(), running: true };

    function gateTick() {
        if (!gateState.running) return;
        /* T2-bg-fix: rAF в свёрнутой вкладке Chromium троттлится до 1 Гц или
           вовсе паузится. Если gate в этот момент был закрыт (юзер молчал) —
           он залипает до возврата вкладки, и собеседник не слышит ничего,
           даже когда юзер начинает говорить (gate не успевает оценить и
           открыться, пока rAF замёрз). Пока вкладка hidden — форс-открываем
           gate и пропускаем оценку. visibilitychange→hidden ниже делает то
           же самое превентивно (до того как rAF успеет затроттлиться). */
        if (typeof document !== "undefined" && document.hidden) {
            if (!gateState.open) {
                gateState.open = true;
                const t = audioContext.currentTime;
                gateGain.gain.cancelScheduledValues(t);
                gateGain.gain.setValueAtTime(1, t);
            }
            requestAnimationFrame(gateTick);
            return;
        }
        analyser.getFloatTimeDomainData(analyserData);
        let sumSq = 0;
        for (let i = 0; i < analyserData.length; i++) {
            const v = analyserData[i];
            sumSq += v * v;
        }
        const rms = Math.sqrt(sumSq / analyserData.length);
        const now = performance.now();
        if (rms > GATE_ON_LIN) {
            gateState.lastSoundAt = now;
            if (!gateState.open) {
                gateState.open = true;
                const t = audioContext.currentTime;
                gateGain.gain.cancelScheduledValues(t);
                gateGain.gain.setValueAtTime(gateGain.gain.value, t);
                gateGain.gain.linearRampToValueAtTime(1, t + GATE_ATTACK_S);
            }
        } else if (rms < GATE_OFF_LIN && now - gateState.lastSoundAt > GATE_HOLD_MS) {
            if (gateState.open) {
                gateState.open = false;
                const t = audioContext.currentTime;
                gateGain.gain.cancelScheduledValues(t);
                gateGain.gain.setValueAtTime(gateGain.gain.value, t);
                gateGain.gain.linearRampToValueAtTime(0, t + GATE_RELEASE_S);
            }
        }
        requestAnimationFrame(gateTick);
    }
    requestAnimationFrame(gateTick);

    /* GainNode в конце цепи — управляется ползунком «усиление» из настроек.
       1.0 = unity (нет изменений), <1 = тише, >1 = бустим. Меняется в
       реалтайме без renegotiation — peer.addTrack привязан к выходному
       destination.stream, дальше всё внутри Web Audio. */
    const gain = audioContext.createGain();
    const savedGain = window.VoidSettings?.getAudioInGain?.();
    gain.gain.value = typeof savedGain === "number" ? savedGain : 1.0;

    const destination = audioContext.createMediaStreamDestination();

    if (rnnoise) {
        source.connect(rnnoise);
        rnnoise.connect(highpass);
    } else {
        source.connect(highpass);
    }
    highpass.connect(lowpass);
    lowpass.connect(compressor);
    compressor.connect(analyser);
    analyser.connect(gateGain);
    gateGain.connect(gain);
    gain.connect(destination);

    // Сохраняем ссылки для teardownAudioGraph(). gateState хранит флаг
    // running — устанавливается в false при teardown, чтобы rAF-loop
    // вышел сам, не плодя зомби-циклы.
    audioGraph = { source, rnnoise, highpass, lowpass, compressor, analyser, gateGain, gain, destination, gateState };

    return destination.stream;
}

/**
 * Разрывает граф обработки микрофона. Зовётся в `closeAllConnections` перед
 * закрытием AudioContext'а — чтобы WebAudio отпустил MediaStreamSource и
 * связанные с ним audioWorkletNode'ы.
 */
function teardownAudioGraph() {
    if (!audioGraph) return;
    /* gateState — служебный объект (не AudioNode), останавливаем его rAF-loop. */
    if (audioGraph.gateState) audioGraph.gateState.running = false;
    for (const [key, node] of Object.entries(audioGraph)) {
        if (key === "gateState") continue;
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
    /* Событийные звуки (join/leave/mic/sound/screencast/message) — синтез
       (js/void-sfx.js); мастер уходит в VoidSounds (js/audio.js). */
    if (window.VoidSounds) VoidSounds.setMaster(master);
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
    // Событийные звуки — синтез (AudioContext.setSinkId через VoidSounds).
    if (window.VoidSounds) VoidSounds.setSink(window.VoidSettings?.getAudioOutId?.() || "");
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

/* Шумоподавление — переключаем на лету: если уже в комнате, пересобираем
   локальный mic-граф (reinitLocalMic читает настройку в buildMicConstraints +
   applyAudioProcessing). Вне комнаты — применится при следующем initMedia. */
document.addEventListener("void:noise-suppression-changed", () => {
    if (typeof isJoined !== "undefined" && isJoined && typeof localStream !== "undefined" && localStream) {
        reinitLocalMic().catch((err) =>
            log.warn("rtc", "noise toggle reinit failed", { err: err?.message || String(err) }));
    }
});


/* visibility recovery: при возврате вкладки в foreground на iOS контекст
   часто остаётся в "interrupted" — statechange-листенер в
   getOrCreateAudioContext должен это поймать, но на старых WebKit
   событие иногда не стреляет, state «тихо» залипает. Здесь — страховка:
   при visible форсим resume() и для каждого peer-<audio> элемента
   повторно дёргаем play() (после background'а audio часто оказывается
   paused, а play()-promise рапортует фейлом без user-gesture, поэтому
   catch silenced).
   Также: если M1.4 не сработает и звука всё ещё нет, юзер всегда может
   тапнуть на любой контрол (mic/sound toggle) — это пере-эмитит
   user-gesture, и следующий resume() гарантированно пройдёт. */
document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
        /* T2-bg-fix: превентивно форс-открываем mic gate ДО того как rAF
           успеет затроттлиться. Если бы оставили оценку — gate мог закрыться
           в последнем тике и залипнуть, пока вкладка свёрнута: rAF в hidden
           tab у Chromium идёт ~1 Гц или паузится, gate не может оценить и
           открыться. gateTick тоже проверяет document.hidden как safety net. */
        forceOpenMicGate();
        return;
    }

    if (audioContext && (audioContext.state === "suspended" || audioContext.state === "interrupted")) {
        audioContext.resume().catch(() => {});
    }

    /* T2-bg-fix: gate уже принудительно открыт в hidden-ветке, но если был
       какой-то race (visibilitychange→hidden не выстрелил, сразу пришло
       visible) — на возврате тоже форс-открываем. Безопасно: если юзер
       молчит, gateTick через ~200мс закроет gate обратно. */
    forceOpenMicGate();

    /* Диагностика на случай если есть ещё какие-то невидимые баги с mic'ом
       на возврате из background'а — track.muted = true указывал бы на
       Yandex/Energy Saver killed mic, processedStream.active = false на
       отвалившийся audio graph, audioContext.state ≠ "running" на failed
       resume. Все три — повод для toast'а или авто-reinit'а. */
    if (typeof isJoined !== "undefined" && isJoined && localStream) {
        const t = localStream.getAudioTracks?.()[0];
        if (t) {
            log.debug("rtc", "visibility-visible audio check", {
                track: t.readyState,
                muted: t.muted,
                enabled: t.enabled,
                ctx: audioContext?.state || "none",
                processed: processedStream?.active ?? null
            });
            /* Если track реально умер за время фоновой работы (выдернули
               USB, OS прибила сессию) — onLocalMicEnded мог не выстрелить,
               пока вкладка была hidden (event loop тоже мог тормозить).
               Триггерим reinit вручную через тот же путь — там стоит
               _micReinitInFlight guard, повторный no-op безопасен. */
            if (t.readyState === "ended" && typeof onLocalMicEnded === "function") {
                log.warn("rtc", "mic track ended during background, reiniting");
                onLocalMicEnded();
            }
        }
    }

    for (const audio of audioMap.values()) {
        if (audio.paused) {
            const p = audio.play?.();
            if (p?.catch) p.catch(() => {});
        }
    }
});

/**
 * T2-bg-fix: мгновенно открыть mic gate (без ramp'а). Используется в
 * visibilitychange handler'ах — gate-loop с rAF в hidden-tab'е не может
 * сам это сделать. Безопасно вызывать когда graph ещё/уже не создан
 * (early return на null'ах). audioGraph пересоздаётся в applyAudioProcessing
 * на каждый initMedia/reinitLocalMic — текущая ссылка всегда указывает
 * на актуальный live граф.
 */
function forceOpenMicGate() {
    if (!audioGraph || !audioGraph.gateGain || !audioContext) return;
    try {
        const t = audioContext.currentTime;
        audioGraph.gateGain.gain.cancelScheduledValues(t);
        audioGraph.gateGain.gain.setValueAtTime(1, t);
        if (audioGraph.gateState) {
            audioGraph.gateState.open = true;
            audioGraph.gateState.lastSoundAt = performance.now();
        }
    } catch (_) {}
}

/**
 * STUN-серверы — fallback-список для NAT-discovery. WebRTC опрашивает их
 * параллельно и берёт первый ответивший: если один лёг или заблокирован
 * провайдером, остальные подхватят. Чем разнообразнее провайдеры — тем устойчивее.
 *
 * Эти всегда присутствуют в iceServers. TURN-сервер (если сконфигурирован
 * на бэке) добавляется отдельно — см. `ensureTurnCredentials` ниже.
 */
const STATIC_STUN_SERVERS = [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
    { urls: "stun:stun2.l.google.com:19302" },
    { urls: "stun:stun.cloudflare.com:3478" },
    { urls: "stun:stun.nextcloud.com:443" }
];

/**
 * Кешированный iceServers-массив + время истечения TURN-credentials.
 * createPeer читает _iceServersCached СИНХРОННО — это намеренно, чтобы
 * не каскадить async по всем callsite (callUser/handleOffer/rebuildPeer).
 *
 * Заполняется через `ensureTurnCredentials`, которая вызывается из
 * initMedia (один раз на сессию) и затем периодически refresh-таймером.
 * До первого fetch'а массив = только STUN. Если бэк отдал 503 (TURN
 * не настроен) — так и остаётся STUN-only до конца сессии.
 */
let _iceServersCached = STATIC_STUN_SERVERS;
let _turnExpiresAt = 0;
let _turnFetchInFlight = null;

async function fetchTurnCredentials() {
    if (_turnFetchInFlight) return _turnFetchInFlight;
    _turnFetchInFlight = (async () => {
        try {
            const uid = typeof clientId !== "undefined" ? clientId : "anon";
            const res = await fetch(`${window.VoidApiBase || ""}/api/turn-credentials?uid=${encodeURIComponent(uid)}`, {
                credentials: "same-origin"
            });
            if (res.status === 503) {
                // TURN не сконфигурирован на бэке — это норма для dev/portable.
                // Молча остаёмся со STUN-only, не повторяем fetch до перезагрузки.
                _turnExpiresAt = Number.MAX_SAFE_INTEGER;
                return null;
            }
            if (!res.ok) {
                log.warn("rtc", "turn creds fetch failed", { status: res.status });
                return null;
            }
            const data = await res.json();
            if (!Array.isArray(data.iceServers)) return null;
            // Обновляемся за 5 минут до истечения — анти-race с активными звонками.
            const expiresAt = Date.now() + (Math.max(60, data.ttl - 300)) * 1000;
            return { iceServers: data.iceServers, expiresAt };
        } catch (err) {
            log.warn("rtc", "turn creds fetch error", { err: err?.message || String(err) });
            return null;
        } finally {
            _turnFetchInFlight = null;
        }
    })();
    return _turnFetchInFlight;
}

/**
 * Гарантирует, что в `_iceServersCached` лежит свежий набор (STUN + TURN,
 * если бэк его выдаёт). Зовётся:
 *   - из initMedia (после getUserMedia, не блокируя его)
 *   - из setInterval (раз в минуту, дёшево — fetch только при истечении)
 * Идемпотентно: повторный вызов до истечения — no-op.
 */
async function ensureTurnCredentials() {
    if (Date.now() < _turnExpiresAt) return;
    const fresh = await fetchTurnCredentials();
    if (fresh) {
        _iceServersCached = [...STATIC_STUN_SERVERS, ...fresh.iceServers];
        _turnExpiresAt = fresh.expiresAt;
        log.info("rtc", "turn credentials loaded", { servers: fresh.iceServers.length });
    }
}

// Периодический refresh. unref не нужен — это setInterval в браузере, не Node.
setInterval(ensureTurnCredentials, 60_000);

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
        iceServers: _iceServersCached,
        /* Dev-режим force-relay: гоним медиа только через TURN — тест relay-пути
           и битрейт-капа без реального CG-NAT. Требует поднятый TURN (иначе
           кандидатов не будет — это ожидаемо для теста). Обычный режим — "all". */
        iceTransportPolicy: forceRelay ? "relay" : "all"
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
    /* F7: фаза recovery state machine. Защита от зацикливания на нестабильной
       сети: peer прыгает disconnected→connected→disconnected, без фазы каждый
       новый disconnected отменял бы 8s rebuild-таймер активной попытки restart
       и перезапускал grace заново. С фазой повторный disconnected при уже
       активном восстановлении просто игнорится — даём текущей попытке доделать. */
    peer._recoveryPhase = "idle"; // idle | grace | restarting | passive-wait
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
    /* Счётчик срабатываний sig-stuck watchdog. Tier 1 = restartIce, tier 2 =
       rebuildPeer. Сбрасывается на возврате в stable. */
    peer._sigStuckAttempts = 0;

    /* ── Диагностика провала (уходит в failure-лог админки при state=failed) ──
       Собираем ПО ХОДУ, а не постфактум: к моменту failed часть контекста уже не
       восстановить. `_turnAtCreate` — были ли TURN-креды в конфиге на момент
       создания peer'а: creds грузятся асинхронно, первый peer сессии может
       стартовать STUN-only, и это само по себе объяснение провала. */
    peer._createdAt = Date.now();
    peer._turnAtCreate = _iceServersCached.length > STATIC_STUN_SERVERS.length;
    peer._iceErrors = [];

    /* Ошибки STUN/TURN — главный диагностический сигнал. 401/403 от coturn =
       протухшие/битые creds, 701 = сервер недостижим (порт/фаервол). Событие
       шумное (на каждый сервер и каждый кандидат), поэтому дедупим по code+url
       и держим не больше ICE_ERR_CAP уникальных. */
    peer.onicecandidateerror = (event) => {
        if (peer._iceErrors.length >= ICE_ERR_CAP) return;
        const code = event.errorCode || 0;
        const url = event.url || "";
        const hit = peer._iceErrors.find(e => e.code === code && e.url === url);
        if (hit) {
            hit.count += 1;
            return;
        }
        peer._iceErrors.push({ code, url, text: event.errorText || "", count: 1 });
    };

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
                    /* track.ended может быть «временно» (стример пересобирает peer);
                       сохраняем lastWatchedUserId — если в течение auto-reopen
                       окна приедет новый трек, авто-реоткроемся. Если стример
                       реально выключил демку, придёт screencast-state:false. */
                    closeScreenOverlay({ preserveAutoReopen: true });
                }
            };
            /* Hot-swap: оверлей уже открыт для этого user'а, но трек
               пересоздался (sig-stuck rebuild, ICE restart с новым m-line'ом).
               screenOverlayVideo всё ещё держит СТАРЫЙ stream-объект, кадры
               по нему не идут → визуально чёрный экран. Подменяем srcObject
               на новый стрим напрямую, не дожидаясь auto-reopen. */
            if (typeof refreshOverlayStreamIfOpen === 'function') {
                refreshOverlayStreamIfOpen(userId, event.streams[0]);
            }
            /* Watchdog «черный экран»: бывает peer connected, screen-track
               приехал, но frame'ы не декодируются (transceiver direction
               перепутался, codec mismatch, BWE стартовал в 0). Через 5s
               после первого ontrack проверяем framesDecoded; если 0 — дёргаем
               ICE restart, что часто разлепляет негоциацию. Без watchdog'а
               зритель сидит на черном экране, пока не нажмёт re-join. */
            scheduleVideoDecodeWatchdog(peer, userId);
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
        /* iOS Safari часто игнорирует autoplay-атрибут на программно созданном
           <audio> с srcObject, особенно при ICE-restart/rebuild (повторный
           ontrack на существующем элементе). Без явного play() звук не пойдёт
           даже когда контекст и track в порядке. ontrack срабатывает уже
           после user-gesture (вход в комнату был кликом), autoplay-policy
           обычно позволит. Если всё-таки откажет — log warn, и фикс M1.4
           (visibility recovery) поднимет звук на следующем focus'е вкладки. */
        const playPromise = audio.play?.();
        if (playPromise?.catch) {
            playPromise.catch(err =>
                log.warn("rtc", "remote audio play blocked", { userId, err: err?.message || String(err) })
            );
        }

        // Старый analyser привязан к мёртвому source — пересоздаём.
        // Старый rAF-цикл сам остановится (см. monitorVolume).
        analyserMap.delete(userId);
        createVolumeAnalyser(event.streams[0], userId);
    };

    peer.onconnectionstatechange = () => {
        handlePeerConnectionStateChange(userId);
    };

    /* L4: расширенное логирование WebRTC state machines. Раньше логировался
       только `connectionState` через debug — при «у меня нет звука» картины
       не было. ICE state даёт понять где сломалось (checking/disconnected/
       failed). signalingState — где в SDP-обмене застряли. gathering — нет
       ли проблем с сбором кандидатов (NAT/firewall). */
    peer.oniceconnectionstatechange = () => {
        log.info("rtc", "ice state", { userId, state: peer.iceConnectionState });
    };
    peer.onsignalingstatechange = () => {
        log.info("rtc", "signaling state", { userId, state: peer.signalingState });
        if (peer.signalingState === "stable") {
            clearSigStuckTimer(userId);
            peer._sigStuckAttempts = 0;
        } else {
            armSigStuckTimer(peer, userId);
        }
    };
    peer.onicegatheringstatechange = () => {
        log.debug("rtc", "ice gathering", { userId, state: peer.iceGatheringState });
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
            let sdp = desc.sdp;
            if (screenStream?.active) {
                sdp = patchOpusForStereo(sdp);
                /* x-google-* в fmtp видео: бьёт BWE cold-start ramp в зародыше
                   (без него Chrome стартует с 200 kbps и ползёт минуту). */
                sdp = patchVideoStartBitrate(sdp, screenTargetHeight, screenTargetFps);
            }
            /* L6: warn если SDP подбирается к лимиту сервера (32 KB). Каждый
               цикл stopScreenShare → startScreenShare может оставить
               orphan-transceiver'ы → SDP пухнет m-line'ами. Если упрётся в
               лимит, server тихо дропнет offer и negotiation залипнет
               в have-local-offer. */
            if (sdp.length > 24_000) {
                log.warn("rtc", "large sdp", { bytes: sdp.length, type: desc.type, userId: peer._userId });
            }
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
        const sender = peer.addTrack(track, outboundStream);
        /* F5: сохраняем ссылку на mic sender, чтобы при выходе мик-трека в
           `ended` можно было подменить track через replaceTrack без полной
           ренегациации. Один аудио-трек на peer — mic; screen-audio добавляется
           отдельно ниже и в screenSenders, не сюда. */
        if (track.kind === "audio") peer._micSender = sender;
    });

    if (screenStream?.active) {
        const senders = [];
        const vt = screenStream.getVideoTracks()[0];
        if (vt) senders.push(peer.addTrack(vt, screenStream));
        const at = screenStream.getAudioTracks()[0];
        if (at) senders.push(peer.addTrack(at, screenStream));
        if (senders.length) screenSenders.set(userId, senders);
        applyScreenAudioParams(senders);
        /* Video-битрейт этому новому зрителю И пересчёт всем остальным —
           единым пасом ниже, после peers.set (число зрителей выросло → всем
           чуть меньше в рамках SCREEN_UPLOAD_BUDGET). */
        /* H.264 первым — аппаратный энкодер, стабильные 60fps без перегрузки CPU
           (VP9 — софт-энкод, отсюда были фризы). Ставится до первого
           setLocalDescription (onnegotiationneeded ниже), чтобы offer уже шёл
           с H.264 в приоритете. */
        preferH264Video(peer);
    }

    peers.set(userId, peer);

    /* Если идёт наша демка и подключился новый зритель — пересчитать video-бюджет
       на всех пирах под возросшее число зрителей. peers.set обязан быть до этого:
       reapply итерирует screenSenders и делает peers.get(userId). На стороне
       зрителя (screenSenders пуст) — no-op. */
    reapplyScreenVideoBudget();

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

    /* F8: на rebuild ICE-кандидаты от удалённой стороны (с её НОВОГО peer'а)
       могут прилететь раньше rebuild-offer'а — это типичный гонка на медленных
       каналах. Сейчас они сидят в _pendingIceCandidates СТАРОГО локального
       peer'а, который мы сейчас закроем. Сохраняем перед cleanup, чтобы новый
       peer получил их сразу после setRemoteDescription. */
    let carriedPendingIce = null;
    if (data.rebuild) {
        const oldPeer = peers.get(data.from);
        if (oldPeer?._pendingIceCandidates?.length) {
            carriedPendingIce = oldPeer._pendingIceCandidates;
        }
        // Сторона решила сделать full rebuild и прислала rebuild:true. Закрываем
        // свой старый peer (если был) — иначе setRemoteDescription упадёт на
        // несовпадении DTLS fingerprint'ов.
        cleanupPeerSlot(data.from);
    }

    let peer = peers.get(data.from);
    if (!peer) {
        // Получили offer первыми → мы chat-receiver, не chat-initiator.
        peer = createPeer(data.from, false);
    }
    if (carriedPendingIce) {
        peer._pendingIceCandidates.push(...carriedPendingIce);
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
    /* L4: подняли с debug на info — переходы peer state (connecting →
       connected → disconnected → failed) это ключевой сигнал стабильности
       соединения, видеть всегда полезно. */
    log.info("rtc", "peer state", { userId, state, phase: peer._recoveryPhase });

    if (state === "connected") {
        clearPeerHealthTimer(userId);
        peer._recoveryPhase = "idle";
        reportConnectivity(peer);
        reevaluatePeerHealth();
        /* T1.2: peer ожил — стартуем zombie watchdog. Если он был запущен
           ранее (например, после ICE flap connected→disconnected→connected),
           startZombieWatcher сначала остановит предыдущий. */
        startZombieWatcher(userId);
        return;
    }

    if (state === "failed" && !peer._iceReported) {
        // Терминальный провал, до connected так и не дошли — это и есть тот
        // случай, где помог бы TURN-релей. Считаем отдельно + шлём диагностику.
        peer._iceReported = true;
        reportFailure(peer);
    }

    if (state === "disconnected") {
        /* F7: если recovery уже в работе — НЕ перезапускать grace, иначе на
           флапающей сети peer бесконечно качается disconnected→grace→restart,
           отменяя 8s rebuild-таймер каждый раз, и до rebuild дело не доходит.
           Активная попытка пусть отрабатывает свой таймер. */
        if (peer._recoveryPhase === "restarting" || peer._recoveryPhase === "passive-wait") {
            return;
        }
        /* T1.2: вышли из connected — гасим zombie watchdog. Recovery state
           machine берёт управление; если восстановимся обратно в connected,
           watchdog запустится заново. */
        stopZombieWatcher(userId);
        clearPeerHealthTimer(userId);
        peer._recoveryPhase = "grace";
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
        /* failed — терминал, recovery без задержки независимо от фазы.
           ICE state machine больше ничего сама не починит. */
        stopZombieWatcher(userId);
        clearPeerHealthTimer(userId);
        attemptPeerRecovery(userId);
        reevaluatePeerHealth();
        return;
    }
}

/**
 * F20: пересчитать сводное здоровье mesh-связи и обновить футер-индикатор.
 * Trouble = есть хоть один peer в failed или в активной фазе recovery
 * (`restarting` / `passive-wait` — grace 5s пропускаем, это штатная
 * дребезга ICE, не повод пугать юзера). При пустом peers — ok (мы одни в
 * комнате). Если на странице нет setPeerTrouble (например, юнит-тест
 * webrtc.js в отрыве) — просто молчим. */
function reevaluatePeerHealth() {
    if (typeof setPeerTrouble !== "function") return;
    if (typeof isJoined === "undefined" || !isJoined) {
        setPeerTrouble(false);
        return;
    }
    let trouble = false;
    for (const p of peers.values()) {
        if (p.connectionState === "failed") { trouble = true; break; }
        if (p._recoveryPhase === "restarting" || p._recoveryPhase === "passive-wait") {
            trouble = true;
            break;
        }
    }
    setPeerTrouble(trouble);
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
        peer._recoveryPhase = "restarting";
        reevaluatePeerHealth();
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
        peer._recoveryPhase = "passive-wait";
        reevaluatePeerHealth();
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
 * T1.2: запустить zombie watchdog. Старт при переходе peer'а в `connected`.
 * Полный idempotent: повторный вызов сначала стопает предыдущий.
 *
 * Каждые ZOMBIE_CHECK_INTERVAL_MS снимаем `getStats()`, суммируем
 * `inbound-rtp.packetsReceived` по audio-секциям (mic — единственная
 * audio-секция в обычной сессии; screen-audio тоже учитывается, что ок —
 * любой растущий счётчик доказывает живость канала).
 *
 * Если в течение ZOMBIE_THRESHOLD_MS после WARMUP'а счётчик не вырос —
 * считаем peer мёртвым и зовём rebuildPeer. Circuit breaker не даёт уйти
 * в бесконечный rebuild-loop при структурном баге.
 */
function startZombieWatcher(userId) {
    stopZombieWatcher(userId);
    const peer = peers.get(userId);
    if (!peer) return;

    const state = {
        lastCount: -1,
        lastGrowthAt: Date.now(),
        startedAt: Date.now(),
        timer: null
    };

    state.timer = setInterval(async () => {
        const p = peers.get(userId);
        if (!p || p.connectionState !== "connected") {
            stopZombieWatcher(userId);
            return;
        }

        let total = 0;
        try {
            const stats = await p.getStats();
            stats.forEach(r => {
                if (r.type === "inbound-rtp" && r.kind === "audio") {
                    total += r.packetsReceived || 0;
                }
            });
        } catch (_) {
            /* getStats может упасть на закрывающемся peer'е — пропускаем тик,
               следующая итерация (или connectionstatechange) разрулит. */
            return;
        }

        const now = Date.now();

        /* WARMUP: первые ZOMBIE_WARMUP_MS просто захватываем baseline.
           До этого момента 0 пакетов — норма (handshake завершился, RTP
           поток ещё не приехал). */
        if (now - state.startedAt < ZOMBIE_WARMUP_MS) {
            state.lastCount = total;
            state.lastGrowthAt = now;
            return;
        }

        if (total > state.lastCount) {
            state.lastCount = total;
            state.lastGrowthAt = now;
            return;
        }

        if (now - state.lastGrowthAt <= ZOMBIE_THRESHOLD_MS) return;

        /* Circuit breaker: ≤2 rebuild'а в минуту на userId. Дальше — peer
           видимо структурно сломан (signalling рассинхрон / NAT не
           переключается / etc.), очередной rebuild только продлит агонию.
           Логируем error и сдаёмся. UI зафиксирует это через peer-trouble
           индикатор когда recovery state machine переведёт peer в failed. */
        const now2 = Date.now();
        let rebuilds = peerZombieRebuilds.get(userId);
        if (!rebuilds || now2 - rebuilds.firstAt > 60_000) {
            rebuilds = { count: 0, firstAt: now2 };
            peerZombieRebuilds.set(userId, rebuilds);
        }
        rebuilds.count += 1;

        if (rebuilds.count > ZOMBIE_MAX_REBUILDS_PER_MINUTE) {
            log.error("rtc", "zombie watchdog exhausted, peer unrecoverable", {
                userId, attempts: rebuilds.count
            });
            stopZombieWatcher(userId);
            return;
        }

        log.warn("rtc", "zombie peer (no inbound audio), rebuilding", {
            userId,
            staleMs: now - state.lastGrowthAt,
            attempt: rebuilds.count
        });
        stopZombieWatcher(userId);
        rebuildPeer(userId);
        /* rebuildPeer создаст новый peer; его connectionstatechange запустит
           следующий watcher уже на свежем объекте, когда дойдёт до connected. */
    }, ZOMBIE_CHECK_INTERVAL_MS);

    peerZombieWatchers.set(userId, state);
}

function stopZombieWatcher(userId) {
    const s = peerZombieWatchers.get(userId);
    if (s) {
        clearInterval(s.timer);
        peerZombieWatchers.delete(userId);
    }
}

/**
 * Через VIDEO_DECODE_WATCHDOG_MS после ontrack(video) проверяем, что декодер
 * реально получил кадры. Если 0 — дёргаем `peer.restartIce()`: типичные
 * причины (perfect negotiation race, направление transceiver'а уехало в
 * inactive из-за гонки rollback'а) лечатся через restart. Если restart не
 * помог за следующее окно — health-state-machine сама дойдёт до rebuild.
 * Идемпотентно: повторный вызов сбрасывает таймер, чтобы не накапливать.
 */
function scheduleVideoDecodeWatchdog(peer, userId) {
    const prev = videoDecodeWatchdogs.get(userId);
    if (prev) clearTimeout(prev);
    const timer = setTimeout(async () => {
        videoDecodeWatchdogs.delete(userId);
        const p = peers.get(userId);
        if (!p || p !== peer) return;
        if (p.connectionState !== "connected") return;
        try {
            const stats = await p.getStats();
            let decoded = null;
            stats.forEach(r => {
                if (r.type === "inbound-rtp" && r.kind === "video") {
                    decoded = (decoded || 0) + (r.framesDecoded || 0);
                }
            });
            if (decoded === null) return; // нет inbound video — нечего лечить
            if (decoded > 0) return;      // декодер ожил, всё ок
            log.warn("rtc", "video decode stuck, restarting ice", { userId });
            p.restartIce();
        } catch (err) {
            log.warn("rtc", "decode watchdog failed", { err: err?.message || String(err) });
        }
    }, VIDEO_DECODE_WATCHDOG_MS);
    videoDecodeWatchdogs.set(userId, timer);
}

function clearVideoDecodeWatchdog(userId) {
    const t = videoDecodeWatchdogs.get(userId);
    if (t) {
        clearTimeout(t);
        videoDecodeWatchdogs.delete(userId);
    }
}

/**
 * Двух-эшелонный watchdog застрявшей negotiation:
 *   1-е срабатывание: peer.restartIce() — лёгкая попытка, ICE-restart
 *      генерит новый offer с новыми кред'ми ICE.
 *   2-е срабатывание (если за следующие 12с stable так и не пришёл):
 *      rebuildPeer() — закрываем peer, создаём новый, помечаем
 *      _signalRebuildOnNextOffer=true; противоположная сторона при
 *      получении offer'а с rebuild:true тоже пересоздаст свой peer
 *      (см. handleOffer). Это разлепляет ЛЮБУЮ застрявшую negotiation,
 *      потому что начинаем с нуля.
 *
 * Счётчик попыток peer._sigStuckAttempts сбрасывается на stable.
 */
function armSigStuckTimer(peer, userId) {
    const prev = sigStuckTimers.get(userId);
    if (prev) clearTimeout(prev);
    const t = setTimeout(() => {
        sigStuckTimers.delete(userId);
        const p = peers.get(userId);
        if (!p || p !== peer) return;
        if (p.signalingState === "stable") return;

        const attempt = (p._sigStuckAttempts || 0) + 1;
        p._sigStuckAttempts = attempt;

        if (attempt === 1) {
            /* Tier 1: restartIce. Если peer в have-local-offer — restartIce
               сам по себе не разлепит (новый offer не сгенерится пока текущий
               не разрешится). Но если peer в have-remote-offer / другом
               состоянии — может помочь. Если не помог — пройдём в tier 2. */
            log.warn("rtc", "signaling stuck (tier 1), restarting ice", {
                userId, state: p.signalingState
            });
            try {
                p.restartIce();
            } catch (err) {
                log.warn("rtc", "sig-stuck ice restart failed", {
                    err: err?.message || String(err)
                });
            }
            /* Перевзводим таймер вручную — onsignalingstatechange может
               не сработать, если signalingState не меняется при restartIce
               на застрявшем have-local-offer. */
            armSigStuckTimer(p, userId);
            return;
        }

        /* Tier 2 (attempt >= 2): rebuildPeer. Гарантированно разлепляет —
           создаём peer с нуля. Side effect: короткий разрыв медиа на ~1-2с
           пока новый peer не дойдёт до connected. */
        log.warn("rtc", "signaling stuck (tier 2), rebuilding peer", {
            userId, state: p.signalingState
        });
        rebuildPeer(userId);
    }, SIG_STUCK_TIMEOUT_MS);
    sigStuckTimers.set(userId, t);
}

function clearSigStuckTimer(userId) {
    const t = sigStuckTimers.get(userId);
    if (t) {
        clearTimeout(t);
        sigStuckTimers.delete(userId);
    }
}

/**
 * Полностью убрать всё, что связано с пиром: peer-соединение, audio-элемент,
 * video-элемент, screen-senders, анализатор громкости, health-timer.
 * Используется и для штатного выхода участника, и для rebuild peer-а.
 * Локальный микрофон и self-анализатор НЕ трогаются.
 */
function cleanupPeerSlot(userId) {
    /* T1.2: стопаем zombie watchdog первым делом — он держит setInterval
       и getStats() на peer'е, который мы сейчас закроем. peerZombieRebuilds
       НЕ чистим: счётчик переживает rebuild внутри сессии (это и есть
       circuit breaker против infinite loop'а). Очищается по TTL 60s в
       startZombieWatcher или просто остаётся висеть до выхода из комнаты. */
    stopZombieWatcher(userId);
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
       замороженной картинкой. Чистим явно здесь.
       preserveAutoReopen: cleanupPeerSlot часто срабатывает на пересборке
       peer'а (WS reconnect стримера, rebuild) — оставляем lastWatchedUserId
       чтобы notifyScreenVideoReady авто-открыл оверлей на новом треке. */
    const videoEl = videoMap.get(userId);
    if (videoEl) {
        videoEl.srcObject = null;
        videoMap.delete(userId);
        if (typeof closeScreenOverlay === "function") {
            closeScreenOverlay({ preserveAutoReopen: true });
        }
    }

    /* B4: screenSenders не очищался — после rebuild пира запись оставалась,
       и `stopScreenShare` потом дёргал removeTrack на закрытом peer'е (не
       падает, но мусор). */
    screenSenders.delete(userId);

    /* Зритель ушёл во время нашей демки — у оставшихся стало больше бюджета,
       пересчитать video-битрейт под уменьшившееся число зрителей. Не шарим →
       screenSenders пуст → no-op. */
    reapplyScreenVideoBudget();

    if (userId !== clientId) {
        analyserMap.delete(userId);
    }

    if (typeof detachChatChannelForUser === "function") {
        detachChatChannelForUser(userId);
    }

    clearPeerHealthTimer(userId);
    clearVideoDecodeWatchdog(userId);
    clearSigStuckTimer(userId);
    _pingCache.delete(userId);

    /* F20: peer ушёл — пересчитываем сводное здоровье. Если это был
       единственный «трудный» peer — индикатор вернётся в зелёное. */
    reevaluatePeerHealth();
}

/* ========= TEARDOWN ========= */

function closeAllConnections() {

    [...peers.keys()].forEach(userId => {
        cleanupPeerSlot(userId);
    });

    /* T1.2: при выходе из комнаты сбрасываем zombie-rebuild счётчики. Иначе при
       быстром leave→join в той же комнате старый счётчик сразу заклинит
       circuit breaker, и watchdog не сможет починить новый peer. Внутри
       сессии счётчик жив (60s TTL), и это правильно — там он работает как
       защита от бесконечного rebuild-loop'а. */
    peerZombieRebuilds.clear();

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

/* Сигналит desktop-стороне (Rust), что демонстрация началась/закончилась — чтобы
   шим в lib.rs убрал из таскбара окно-индикатор захвата «… предоставляет доступ
   к вашему экрану» (WebView2 спавнит его сам, API подавить нет). На web no-op:
   window.__TAURI__ отсутствует. */
function emitScreencastActive(active) {
    try {
        window.__TAURI__?.event?.emit("void:screencast-active", { active });
    } catch (_) {}
}

/* ===== Desktop: чистый звук демки через нативный WASAPI loopback =====
   Системный звук БЕЗ нашего процесс-дерева (без голосов void), стримится из Rust
   (screen_audio.rs) через Tauri Channel в AudioWorklet-фидер → MediaStreamTrack
   без голосов и без ducking. Подменяет getDisplayMedia audio на desktop.
   Возвращает трек или null (→ caller логирует, демка идёт без звука). */
async function startNativeScreenAudio() {
    const core = window.__TAURI__?.core;
    if (!core?.invoke || !core?.Channel) return null;
    const ctx = new AudioContext({ sampleRate: 48000 });
    /* AudioContext может стартовать suspended (autoplay-политика); startScreenShare
       зовётся из click-хендлера, так что gesture активен — resume пройдёт. Без
       resume MediaStreamDestination не тикает → трек молчит. */
    if (ctx.state === "suspended") { try { await ctx.resume(); } catch (_) {} }
    await ctx.audioWorklet.addModule("audio/screen-audio-feeder.js?v=1");
    const node = new AudioWorkletNode(ctx, "screen-audio-feeder", {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [2]
    });
    const dest = ctx.createMediaStreamDestination();
    node.connect(dest);
    const channel = new core.Channel();
    channel.onmessage = (msg) => {
        /* Raw-кадры PCM из Rust приходят как ArrayBuffer; transferable в worklet. */
        if (msg instanceof ArrayBuffer) {
            node.port.postMessage(msg, [msg]);
        } else if (ArrayBuffer.isView(msg)) {
            const buf = msg.buffer.slice(msg.byteOffset, msg.byteOffset + msg.byteLength);
            node.port.postMessage(buf, [buf]);
        }
    };
    await core.invoke("start_screen_audio", { channel });
    screenAudioCtx = ctx;
    screenAudioChannel = channel;
    return dest.stream.getAudioTracks()[0] || null;
}

function stopNativeScreenAudio() {
    try { window.__TAURI__?.core?.invoke?.("stop_screen_audio"); } catch (_) {}
    screenAudioChannel = null;
    if (screenAudioCtx) {
        const ctx = screenAudioCtx;
        screenAudioCtx = null;
        ctx.close().catch(() => {});
    }
}

async function startScreenShare(height = 1080, fps = 30, captureAudio = false) {
    const width = height === 480 ? 854 : height === 720 ? 1280 : 1920;
    /* На desktop звук демки берём НЕ из getDisplayMedia (он тащит голоса void),
       а нативным WASAPI loopback с исключением нашего процесс-дерева (чисто, без
       ducking). На web/нет-Tauri — старый путь через getDisplayMedia system audio. */
    const isDesktop = window.VoidPlatform === "desktop";
    const useNativeAudio = captureAudio && isDesktop;
    /* audioConstraints применяется ТОЛЬКО на web (на desktop звук берёт нативный
       loopback, см. useNativeAudio). По дефолту getDisplayMedia({audio:true}) даёт
       mono 32-48kHz в opus voip-mode — «телефонно». Просим стерео 48kHz.

       echoCancellation:true на WEB — осознанный компромисс. AEC вычитает из
       захваченного системного звука наш собственный playback (голоса пиров) →
       зритель НЕ слышит сам себя. Цена: AEC при разговоре зрителя поддавливает
       музыку (ducking) — но это меньшее зло, чем слышать свой голос в демке.
       (Чисто без обоих — только на desktop через нативный loopback или на web
       через tab-share, где звук вкладки изолирован сам.)

       noiseSuppression/autoGainControl off — не душить музыку. */
    const audioConstraints = (captureAudio && !useNativeAudio) ? {
        echoCancellation: true,
        noiseSuppression: false,
        autoGainControl: false,
        sampleRate: 48000,
        channelCount: 2
    } : false;
    /* В getDisplayMedia спека ЗАПРЕЩАЕТ min/exact и не гарантирует max
       (только ideal). Если поставить min — браузер бросит «min constraints
       are not supported» ДО показа системного picker'а (так было в 0.9.0,
       видно в багрепорте). Поэтому ideal — единственный source-level хинт;
       реальный cap fps закрепляем на encoder через setParameters.maxFramerate
       в applyDirectScreenVideoParams ниже. */
    /* arming: desktop-сторона заранее ставит WinEvent-хук (до появления окна-
       индикатора), чтобы спрятать его без мелькания. На отмене пикера/ошибке/
       выходе из комнаты шлём active:false — снять хук. На web всё это no-op. */
    try { window.__TAURI__?.event?.emit("void:screencast-arming", {}); } catch (_) {}
    let stream;
    try {
        stream = await navigator.mediaDevices.getDisplayMedia({
            video: {
                width: { ideal: width },
                height: { ideal: height },
                frameRate: { ideal: fps }
            },
            audio: audioConstraints,
            /* Облагораживаем нативный пикер (перекрасить его нельзя — он вне DOM):
               selfBrowserSurface:"exclude" убирает само окно Void из списка;
               surfaceSwitching:"include" даёт сменить источник без повторного пикера;
               systemAudio:"include" — чекбокс «поделиться звуком» в пикере (звук демки
               запрашиваем всегда). Юзер сам выбирает источник: вкладка → чистый звук,
               весь экран → системный звук (несёт голоса, см. voice-leak выше). */
            selfBrowserSurface: "exclude",
            surfaceSwitching: "include",
            systemAudio: (captureAudio && !useNativeAudio) ? "include" : "exclude"
        });
    } catch (e) {
        emitScreencastActive(false); // отмена пикера / ошибка → снять хук
        throw e;
    }
    /* F13: пока юзер выбирал source в нативном промпте, он мог покинуть
       комнату. Tracks уже захвачены (OS-индикатор «вы шарите» горит),
       peer'ов нет — некому передавать. Останавливаем tracks и кидаем
       ошибку, чтобы caller (scNextBtn click handler) обработал как cancel. */
    if (typeof isJoined !== "undefined" && !isJoined) {
        stream.getTracks().forEach(t => t.stop());
        emitScreencastActive(false); // вышел из комнаты пока выбирал → снять хук
        throw new Error("not-joined");
    }
    screenStream = stream;
    emitScreencastActive(true);
    /* Desktop: подменяем источник звука демки на чистый нативный loopback —
       инжектим трек прямо в screenStream, дальше весь downstream-код (contentHint,
       addTrack пирам, patchOpus, teardown в stopScreenShare) работает без изменений.
       Фейл нативного капта (старый Windows / ошибка) → демка без звука + warn,
       но видео не ломаем (population <Win10 2004 ничтожна). */
    if (useNativeAudio) {
        try {
            const nativeTrack = await startNativeScreenAudio();
            if (nativeTrack) screenStream.addTrack(nativeTrack);
            else log.warn("rtc", "native screen audio unavailable, demo without sound");
        } catch (err) {
            log.warn("rtc", "native screen audio capture failed", { err: err?.message || String(err) });
            stopNativeScreenAudio();
        }
    }
    const videoTrack = screenStream.getVideoTracks()[0];
    const audioTrack = screenStream.getAudioTracks()[0];
    /* contentHint="music" — подсказка W3C, что трек НЕ голос. Chrome переключает
       opus из voip-mode в audio-mode (стерео, без DTX, без VAD-подавления). Без
       этого даже после bitrate-бампа звук остаётся «сжатым». */
    if (audioTrack) {
        try { audioTrack.contentHint = "music"; } catch (_) {}
    }
    /* contentHint="detail" — резкость для скрин-контента (текст/код/UI). Это НЕ
       возврат к лагам: 5-10 fps давал НЕ detail, а degradationPreference=
       "maintain-resolution" (держал разрешение, жал fps). Сейчас degradation=
       "balanced" (см. applyDirectScreenVideoParams) — золотая середина: под
       congestion плавно проседают И fps, И разрешение (не 5fps и не 360p). Статика
       почти бесплатна по битрейту → detail держит её резкой. См. W3C MST § contentHint. */
    if (videoTrack) {
        try { videoTrack.contentHint = "detail"; } catch (_) {}
    }
    /* Запоминаем целевые параметры — applyDirectScreenVideoParams читает их
       и для каждого peer'а пересчитывает encoder.maxBitrate/maxFramerate.
       Также пригодится при добавлении нового screen-sender'а в новый peer
       (если кто-то ре-джойнится посреди трансляции). */
    screenTargetHeight = height;
    screenTargetFps = fps;
    for (const [userId, peer] of peers) {
        const senders = [];
        if (videoTrack) senders.push(peer.addTrack(videoTrack, screenStream));
        if (audioTrack) senders.push(peer.addTrack(audioTrack, screenStream));
        if (senders.length) screenSenders.set(userId, senders);
        applyScreenAudioParams(senders);
        preferH264Video(peer);
    }
    /* Video-битрейт — единым пасом ПОСЛЕ цикла, когда screenSenders полностью
       заполнен: так каждый пир получает лимит под итоговое число зрителей
       (иначе ранние пиры считались бы под неполный счёт). relay/direct — внутри. */
    reapplyScreenVideoBudget();
    videoTrack.onended = () => {
        stopScreenShare();
        if (typeof broadcastScreencastState === 'function') broadcastScreencastState(false);
        if (typeof updateScreencastButton === 'function') updateScreencastButton(false);
        // OS «остановить показ» — тоже звук стопа (self здесь, остальные по WS).
        if (window.VoidSounds) VoidSounds.screencast(false);
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
            /* 256k stereo + full-band sample rate + DTX off (DTX режет
               атаки/sustain в музыке когда уровень падает между нотами). */
            return match + ";stereo=1;sprop-stereo=1;maxaveragebitrate=256000;usedtx=0;maxplaybackrate=48000;sprop-maxcapturerate=48000";
        }
    );
}

/**
 * Google-специфичный SDP-патч, КРИТИЧНЫЙ для качества скринкаста:
 * добавляет в fmtp всех видео-кодеков `x-google-start-bitrate` /
 * `x-google-min-bitrate` / `x-google-max-bitrate`. Это override BWE
 * cold-start — без этих параметров libwebrtc стартует с ~200 kbps и
 * ползёт ступенями 320p→480p→720p→1080p за 40-60 секунд probing'а.
 * `degradationPreference` и `encoding.minBitrate` помогают только при
 * congestion'е, а тут речь о начальной оценке полосы.
 *
 * Не стандарт, но respected'ит Chrome / Edge / Yandex (все Chromium 64+).
 * Firefox / Safari тихо игнорят — ну и пусть, у них своё BWE.
 *
 * Парсим SDP посекционно по `m=` строкам, чтобы случайно не задеть аудио-fmtp.
 */
function patchVideoStartBitrate(sdp, height, fps) {
    /* Цифры в КБИТАХ для x-google-* (не байтах, как maxBitrate).
       max — потолок (помогает стабильности BWE, см. rtcbits).
       start — УМЕРЕННЫЙ (≤2.5 Mbps): даёт приличную картинку в первые секунды
       без overshoot'а, дальше GCC доезжает до max сам.

       КРИТИЧНО: x-google-min-bitrate НЕ СТАВИМ. Раньше стоял 25% target'а
       (~2800 kbps на 1080p60) — и это была ГЛАВНАЯ причина лагов/осцилляции
       демки: min форсит энкодер слать не ниже него ДАЖЕ когда сеть не тянет
       (особенно screen-content с тяжёлыми keyframe-всплесками) → congestion →
       packet loss → BWE рушится в пол → min форсит назад → снова loss = вечная
       осцилляция «битрейт в бездну → восстановление → опять падение», у зрителя
       каша (потери), при qLim=none на отправителе. Дефолт Chrome — 30kbps, и
       поднимать его «очень опасно вне полностью контролируемой среды» (rtcbits).
       Floor отдаём congestion control'у — он сам найдёт реальную полосу. */
    const target = height >= 1080 ? (fps >= 60 ? 11200 : 7000)
                  : height >= 720  ? (fps >= 60 ? 5600  : 3500)
                  :                   (fps >= 60 ? 2400  : 1500);
    const start = Math.min(2500, target);
    const max   = target;

    const lines = sdp.split(/\r?\n/);
    let videoPts = null; // Set<string> | null — null когда вне m=video секции
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.startsWith("m=")) {
            if (line.startsWith("m=video ")) {
                videoPts = new Set();
                const parts = line.split(/\s+/);
                for (let j = 3; j < parts.length; j++) {
                    if (/^\d+$/.test(parts[j])) videoPts.add(parts[j]);
                }
            } else {
                videoPts = null;
            }
            continue;
        }
        if (!videoPts) continue;
        if (!line.startsWith("a=fmtp:")) continue;
        const m = line.match(/^a=fmtp:(\d+) (.*)$/);
        if (!m || !videoPts.has(m[1])) continue;
        if (m[2].includes("x-google-start-bitrate")) continue;
        lines[i] = `a=fmtp:${m[1]} ${m[2]};x-google-start-bitrate=${start};x-google-max-bitrate=${max}`;
    }
    return lines.join("\r\n");
}

/**
 * Поставить H.264 первым предпочитаемым кодеком для видео-transceiver'а.
 *
 * ПОЧЕМУ H.264, а не VP9: у VP9 нет аппаратного энкодера почти ни на одной
 * видеокарте — 1080p60 кодируется СОФТОМ на CPU. На слабых машинах энкодер
 * не вытягивает и отваливается → стрим залипает «как будто 10 кадров», пока
 * стример не перезапустит демку. У H.264 аппаратный энкодер (NVENC/QuickSync/
 * AMF) есть практически везде → стабильные 60fps при нулевой нагрузке на CPU.
 * Качество на тексте у H.264 чуть ниже VP9 при равном битрейте, но это с
 * запасом компенсируется detail-хинтом и поднятым потолком битрейта, а главное
 * — уходят фризы (приоритет стабильности).
 *
 * VP9 оставляем ВТОРЫМ (а не выкидываем) — fallback, если у пира нет H.264
 * (редко, но бывает на нестандартных сборках). Дальше остальное (VP8 и пр.).
 *
 * Зовётся ПЕРЕД setLocalDescription, чтобы offer уже содержал H.264 первым.
 * Если getCapabilities/setCodecPreferences не поддержаны — no-op.
 */
function preferH264Video(peer) {
    if (typeof RTCRtpSender === "undefined" || !RTCRtpSender.getCapabilities) return;
    const caps = RTCRtpSender.getCapabilities("video");
    if (!caps || !Array.isArray(caps.codecs)) return;
    const isH264 = c => /H264/i.test(c.mimeType);
    const isVP9  = c => /VP9/i.test(c.mimeType);
    const preferred = [
        ...caps.codecs.filter(isH264),
        ...caps.codecs.filter(isVP9),
        ...caps.codecs.filter(c => !isH264(c) && !isVP9(c))
    ];
    for (const t of peer.getTransceivers()) {
        if (t.sender?.track?.kind !== "video") continue;
        if (typeof t.setCodecPreferences !== "function") continue;
        try {
            t.setCodecPreferences(preferred);
        } catch (err) {
            log.warn("rtc", "setCodecPreferences failed", { err: err?.message || String(err) });
        }
    }
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
        params.encodings[0].maxBitrate = 256000;
        params.encodings[0].networkPriority = "high";
        await audioSender.setParameters(params);
    } catch (err) {
        log.warn("rtc", "screen audio setParameters failed", { err: err?.message || String(err) });
    }
}

/* Число зрителей активной демки = сколько пиров сейчас получают screen-video.
   На это число делится SCREEN_UPLOAD_BUDGET в обоих video-сеттерах. max(1,…)
   защищает от деления на ноль (демка без пиров — теоретически, no-op). */
function screenViewerCount() {
    return Math.max(1, screenSenders.size);
}

/* Пересчитать video-битрейт демки на ВСЕХ пирах под текущее число зрителей.
   Зовётся при старте демки и при изменении состава во время трансляции:
   новый зритель вошёл → всем чуть меньше; зритель ушёл → оставшимся больше.
   Идёт единым пасом (а не по одному пиру в цикле addTrack), чтобы избежать
   гонки setParameters, когда ранние пиры получили битрейт под неполный счёт.
   На стороне зрителя (не шарит) screenSenders пуст → безопасный no-op. */
function reapplyScreenVideoBudget() {
    if (!screenStream?.active || screenSenders.size === 0) return;
    for (const [userId, senders] of screenSenders) {
        const peer = peers.get(userId);
        if (!peer) continue;
        if (peer._isRelay) applyRelayBitrateLimits(peer);
        else applyDirectScreenVideoParams(senders, screenTargetHeight, screenTargetFps);
    }
}

/**
 * Поднять потолок битрейта video-encoder'а для direct-screen sender'а и
 * жёстко закрепить maxFramerate. По дефолту libwebrtc держит ~2-2.5 Mbps
 * на 1080p даже когда сеть свободна — на быстром скролле / видео это
 * выдаёт пиксельные блоки. Цифры подобраны под P2P (LAN/обычный upload):
 *
 *   480p30/60   → 1.5 / 2.4 Mbps
 *   720p30/60   → 3.5 / 5.6 Mbps
 *   1080p30/60  → 7.0 / 11.2 Mbps
 *
 * networkPriority="high" — при congestion'е video не уйдёт ниже mic.
 * maxFramerate — иначе encoder сам решает резать ли fps; на 60fps это
 * частая причина «реальных 30fps» при ideal:60 в constraints.
 *
 * degradationPreference="balanced" — ЗОЛОТАЯ СЕРЕДИНА (осознанный финальный
 * выбор, НЕ флип-флопить). Три варианта и почему именно balanced:
 *   - "maintain-resolution": держит 1080p, режет fps → 5-10 fps под нагрузкой.
 *     Это и были лаги. ОТКЛОНЕНО.
 *   - "maintain-framerate": держит fps, режет разрешение → может упасть до 360p
 *     ради 60fps. «Фпс любой ценой» — не хотим. ОТКЛОНЕНО.
 *   - "balanced": Chromium роняет И fps, И разрешение плавно/пропорционально →
 *     оба адекватны (напр. 900p@45, а не 1080p@5 или 360p@60). ВЫБРАНО.
 * На чистом direct деградации НЕТ вообще (qLim=none) → честные 1080p60. Все три
 * варианта на direct дают 60 — degradationPreference важен ТОЛЬКО под congestion.
 * fps контента это не повышает: фильм 24-30fps так и идёт 30 (дубликаты слать
 * незачем), 60 — на 60fps-источнике (игра/60p). См. W3C MST § degradationPreference.
 *
 * Старт-битрейт (выход из cold-start BWE) — через SDP-патч
 * patchVideoStartBitrate (x-google-start-bitrate / -min-bitrate / -max-bitrate).
 * Не используем encoding.minBitrate: оно нестандарт, Chromium 148 (Edge 148)
 * считает поле read-only и валит весь setParameters → degradationPreference
 * тоже не применяется. SDP-патч надёжнее и работает на всех Chromium-based.
 *
 * Defensive fallback: degradationPreference на корне params — в некоторых
 * версиях Chromium тоже read-only. Если первый setParameters упал — пробуем
 * без degradationPreference, чтобы хотя бы maxBitrate/maxFramerate
 * применились.
 */
async function applyDirectScreenVideoParams(senders, height, fps) {
    const videoSender = senders.find(s => s.track?.kind === "video");
    if (!videoSender) return;
    const base = height >= 1080 ? 7_000_000
                : height >= 720  ? 3_500_000
                : 1_500_000;
    const ceiling = fps >= 60 ? Math.round(base * 1.6) : base;
    /* Делим бюджет аплоада на число зрителей: при 1-4 потолок качества не
       достигает лимита (min берёт ceiling → полное 1080p), при многих зрителях
       — режем, чтобы суммарный аплоад шарера держался около SCREEN_UPLOAD_BUDGET. */
    const viewers = screenViewerCount();
    const maxBitrate = Math.min(ceiling, Math.round(SCREEN_UPLOAD_BUDGET / viewers));

    const apply = async (withDegradation) => {
        const params = videoSender.getParameters();
        if (!params.encodings || !params.encodings.length) params.encodings = [{}];
        const enc = params.encodings[0];
        enc.maxBitrate = maxBitrate;
        enc.maxFramerate = fps;
        enc.networkPriority = "high";
        if (withDegradation) params.degradationPreference = "balanced";
        await videoSender.setParameters(params);
    };

    try {
        await apply(true);
        log.info("rtc", "direct screen video bitrate set", { height, fps, viewers, maxBitrate });
    } catch (err1) {
        try {
            await apply(false);
            log.info("rtc", "direct screen video bitrate set (no degradation pref)", { height, fps, viewers, maxBitrate });
        } catch (err2) {
            log.warn("rtc", "direct screen video setParameters failed", { err: err2?.message || String(err2) });
        }
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
    /* Останавливаем нативный loopback-захват (no-op если не desktop / не шёл). */
    stopNativeScreenAudio();
    screenTargetHeight = 1080;
    screenTargetFps = 30;
    emitScreencastActive(false);
}

/* ===== DEV: peer-HUD (включается из dev-меню «оверлей статистики») =====
   Живой per-peer замер для отладки. По каждому пиру: conn=direct/RELAY (relay =
   потолок ~3 Мбит через 1-vCPU VPS), rtt; для голоса — kbps + loss%; для демки —
   разрешение@fps + kbps + qLim + loss%. Доступ только в dev-режиме (кнопка в
   настройках видна лишь при активном devMode). */
let _hudTimer = null;
const _hudPrev = new Map(); // userId → { vbytes, abytes, ts }

async function _collectPeerHud() {
    if (!peers || peers.size === 0) return null;
    const now = performance.now();
    const lines = [];
    for (const [userId, peer] of peers) {
        let stats;
        try { stats = await peer.getStats(); } catch (_) { continue; }
        let vout = null, aout = null, vrin = null, arin = null, pair = null;
        stats.forEach(r => {
            if (r.type === "outbound-rtp" && r.kind === "video") vout = r;
            else if (r.type === "outbound-rtp" && r.kind === "audio") aout = r;
            else if (r.type === "remote-inbound-rtp" && r.kind === "video") vrin = r;
            else if (r.type === "remote-inbound-rtp" && r.kind === "audio") arin = r;
            else if (r.type === "candidate-pair" && r.nominated && r.state === "succeeded") pair = r;
        });
        const lc = pair && stats.get(pair.localCandidateId);
        const rc = pair && stats.get(pair.remoteCandidateId);
        const conn = (lc?.candidateType === "relay" || rc?.candidateType === "relay") ? "RELAY⚠" : "direct";
        const proto = (lc?.protocol || rc?.protocol || "?").toUpperCase();
        const rtt = pair?.currentRoundTripTime != null ? Math.round(pair.currentRoundTripTime * 1000)
                  : (arin?.roundTripTime != null ? Math.round(arin.roundTripTime * 1000) : "?");
        const prev = _hudPrev.get(userId) || { vbytes: 0, abytes: 0, ts: 0 };
        const dt = prev.ts ? (now - prev.ts) / 1000 : 0;
        const nick = (typeof nicknameMap !== "undefined" && nicknameMap.get?.(userId)) || String(userId).slice(0, 8);
        let line = `${nick}  ${conn} ${proto}  rtt=${rtt}ms`;
        if (aout) {
            const kbps = dt ? Math.round(((aout.bytesSent - prev.abytes) * 8) / 1000 / dt) : 0;
            const loss = arin?.fractionLost != null ? (arin.fractionLost * 100).toFixed(1) : "?";
            line += `\n   voice: ${kbps}kbps loss=${loss}%`;
        }
        if (vout) {
            const kbps = dt ? Math.round(((vout.bytesSent - prev.vbytes) * 8) / 1000 / dt) : 0;
            const loss = vrin?.fractionLost != null ? (vrin.fractionLost * 100).toFixed(1) : "?";
            line += `\n   screen: ${vout.frameWidth || 0}x${vout.frameHeight || 0}@${Math.round(vout.framesPerSecond || 0)} ${kbps}kbps qLim=${vout.qualityLimitationReason || "?"} loss=${loss}%`;
        }
        _hudPrev.set(userId, { vbytes: vout?.bytesSent || 0, abytes: aout?.bytesSent || 0, ts: now });
        lines.push(line);
    }
    return lines.length ? lines.join("\n") : null;
}

function toggleDebugHud() {
    if (_hudTimer) {
        clearInterval(_hudTimer);
        _hudTimer = null;
        _hudPrev.clear();
        document.getElementById("__scDebug")?.remove();
        return;
    }
    const el = document.createElement("div");
    el.id = "__scDebug";
    el.style.cssText = "position:fixed;left:8px;bottom:8px;z-index:2147483647;" +
        "background:rgba(0,0,0,.85);color:#7CFC00;font:11px/1.5 monospace;" +
        "padding:8px 10px;border-radius:4px;pointer-events:none;white-space:pre;max-width:62ch;";
    el.textContent = "peer-hud: запуск…";
    document.body.appendChild(el);
    _hudPrev.clear();
    _hudTimer = setInterval(async () => {
        el.textContent = (await _collectPeerHud()) || "peer-hud: нет активных пиров (нужна комната)";
    }, 1000);
}

/* Диагностический отчёт для кнопки «скопировать диагностику» (dev-настройки). */
async function collectDiagReport() {
    const report = {
        version: window.VoidVersion || null,
        platform: window.VoidPlatform || "web",
        ua: navigator.userAgent,
        room: (typeof currentRoomCode !== "undefined") ? currentRoomCode : null,
        forceRelay: !!forceRelay,
        ts: new Date().toISOString(),
        peers: []
    };
    if (peers) {
        for (const [userId, peer] of peers) {
            let stats;
            try { stats = await peer.getStats(); } catch (_) { continue; }
            let vout = null, pair = null;
            stats.forEach(r => {
                if (r.type === "outbound-rtp" && r.kind === "video") vout = r;
                else if (r.type === "candidate-pair" && r.nominated && r.state === "succeeded") pair = r;
            });
            const lc = pair && stats.get(pair.localCandidateId);
            const rc = pair && stats.get(pair.remoteCandidateId);
            report.peers.push({
                userId,
                nick: (typeof nicknameMap !== "undefined" && nicknameMap.get?.(userId)) || null,
                conn: (lc?.candidateType === "relay" || rc?.candidateType === "relay") ? "relay" : (pair ? "direct" : "n/a"),
                proto: lc?.protocol || null,
                rttMs: pair?.currentRoundTripTime != null ? Math.round(pair.currentRoundTripTime * 1000) : null,
                iceState: peer.iceConnectionState,
                recoveryPhase: peer._recoveryPhase,
                relay: !!peer._isRelay,
                encoder: vout?.encoderImplementation || null,
                screen: vout ? `${vout.frameWidth}x${vout.frameHeight}@${Math.round(vout.framesPerSecond || 0)}` : null
            });
        }
    }
    return report;
}

/* Force-relay: пересобираем активные peer'ы, чтобы новый iceTransportPolicy
   применился (он читается в createPeer при создании peer'а). */
function setForceRelay(on) {
    forceRelay = !!on;
    if (peers) for (const userId of peers.keys()) rebuildPeer(userId);
}

/* Экспорт для dev-настроек (settings.js). HUD включается ТОЛЬКО из dev-меню
   (кнопка «оверлей статистики») — хоткея нет. Вызовы гейтятся devMode в UI. */
if (typeof window !== "undefined") {
    window.__voidToggleHud = toggleDebugHud;
    window.__voidCollectDiag = collectDiagReport;
    window.__voidSetForceRelay = setForceRelay;
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

/* ========= DUMP STATS (L5) =========
 *
 * Диагностический хелпер: собирает getStats со ВСЕХ активных peer'ов и
 * выводит таблицу в консоль. Юзер пишет «лагает / нет звука» — говоришь
 * ему «открой консоль, набери log.dumpStats()», получаешь по каждому
 * peer'у строку с RTT, jitter, packets-lost, bytesSent/Received.
 *
 * Биндим в window.log.dumpStats после первого createPeer, чтобы не делать
 * это на каждый звонок. log.js загружается раньше webrtc.js — window.log
 * гарантированно есть.
 */
async function dumpPeerStats() {
    if (!peers.size) {
        console.info("[stats] no active peers");
        return [];
    }
    const rows = [];
    for (const [userId, peer] of peers) {
        const row = {
            userId,
            state: peer.connectionState,
            ice: peer.iceConnectionState,
            sig: peer.signalingState
        };
        try {
            const stats = await peer.getStats();
            stats.forEach(r => {
                if (r.type === "candidate-pair" && r.nominated && r.state === "succeeded") {
                    row.rtt_ms = Math.round((r.currentRoundTripTime || 0) * 1000);
                    row.sent_kb = Math.round((r.bytesSent || 0) / 1024);
                    row.recv_kb = Math.round((r.bytesReceived || 0) / 1024);
                }
                if (r.type === "inbound-rtp" && r.kind === "audio") {
                    row.in_jitter_ms = Math.round((r.jitter || 0) * 1000);
                    row.in_lost = r.packetsLost || 0;
                    row.in_packets = r.packetsReceived || 0;
                }
                if (r.type === "outbound-rtp" && r.kind === "audio") {
                    row.out_packets = r.packetsSent || 0;
                    row.out_retrans = r.retransmittedPacketsSent || 0;
                }
            });
        } catch (err) {
            row.error = err?.message || String(err);
        }
        rows.push(row);
    }
    console.table(rows);
    return rows;
}

if (typeof window !== "undefined" && window.log) {
    window.log.dumpStats = dumpPeerStats;
    window.log.bugReport = bugReport;
}

/**
 * One-liner для багрепортов: собирает всё, что нужно мне для диагностики, в
 * один JSON. Юзер делает `copy(await log.bugReport())` → пастит сообщение.
 * Внутри:
 *   - history: ring buffer log'а (последние 300 записей)
 *   - peers: getStats по каждому активному peer'у
 *   - окружение: версия, URL, userAgent, viewport, online-status
 *   - идентификаторы текущей сессии: room code + clientId
 */
async function bugReport() {
    const peerStats = peers.size ? await dumpPeerStats() : [];
    const history = window.log?.dump?.() || [];
    const report = {
        ts: new Date().toISOString(),
        version: window.VoidVersion || "unknown",
        url: location.href,
        userAgent: navigator.userAgent,
        viewport: { w: innerWidth, h: innerHeight, dpr: devicePixelRatio },
        online: navigator.onLine,
        room: typeof currentRoomCode !== "undefined" ? currentRoomCode : null,
        userId: typeof clientId !== "undefined" ? clientId : null,
        peerCount: peers.size,
        peers: peerStats,
        history
    };
    log.info("boot", "bug report generated", {
        entries: history.length, peers: peerStats.length
    });
    return JSON.stringify(report, null, 2);
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

/** Кап уникальных ICE-ошибок на peer (см. onicecandidateerror в createPeer). */
const ICE_ERR_CAP = 6;

/**
 * Peer ушёл в "failed" — шлём отчёт вместе с диагностическим слепком, чтобы в
 * админке было видно не только «5% не собрались», но и ПОЧЕМУ: TURN не выдал
 * relay-кандидатов / UDP заблокирован / creds отвергнуты / remote-кандидаты не
 * доехали вовсе.
 *
 * Порядок важен. Синхронную часть снимаем ПЕРВОЙ: сразу после этого вызова
 * recovery state machine может закрыть peer (rebuildPeer), и getStats отвалится.
 * Поэтому stats-часть — best-effort в try/catch, а сам отчёт уходит в любом
 * случае: счётчик iceFailed терять нельзя.
 *
 * Приватность: из статистики берём только ТИПЫ кандидатов и их количество.
 * Никаких адресов/портов — ни своих, ни пира.
 */
async function reportFailure(peer) {
    const diag = {
        ms: Date.now() - (peer._createdAt || Date.now()),
        turn: !!peer._turnAtCreate,
        relayOnly: !!forceRelay,
        ice: peer.iceConnectionState,
        gather: peer.iceGatheringState,
        sig: peer.signalingState,
        errs: peer._iceErrors || [],
        platform: (typeof IS_DESKTOP !== "undefined" && IS_DESKTOP) ? "desktop" : "web",
        ua: navigator.userAgent.slice(0, 160),
        net: navigator.connection?.effectiveType || "",
        local: {},
        remote: {},
        pairs: {}
    };

    try {
        const stats = await peer.getStats();
        const bump = (obj, key) => { if (key) obj[key] = (obj[key] || 0) + 1; };
        stats.forEach(r => {
            if (r.type === "local-candidate") bump(diag.local, r.candidateType);
            else if (r.type === "remote-candidate") bump(diag.remote, r.candidateType);
            else if (r.type === "candidate-pair") bump(diag.pairs, r.state);
        });
    } catch (err) {
        // Peer уже закрыт recovery-веткой — отправим то, что успели снять синхронно.
        log.debug("rtc", "failure diag stats unavailable", { err: err?.message || String(err) });
    }

    sendSocket({ type: "ice-report", result: "failed", diag });
}

/**
 * Один раз на peer-объект отправить отчёт об успешной связности.
 * Зовётся при переходе peer в "connected". Дополнительно — при relay
 * понижает битрейт video-sender'ов (screencast) для экономии трафика
 * на TURN-сервере; voice трогать нет смысла (Opus и так ~32-48 kbps).
 */
async function reportConnectivity(peer) {
    if (peer._iceReported) return;
    const result = await classifyConnection(peer);
    if (!result) return;          // статистика недоступна — лучше промолчать
    if (peer._iceReported) return; // мог измениться, пока ждали getStats
    peer._iceReported = true;
    sendSocket({ type: "ice-report", result });

    if (result === "relay") {
        peer._isRelay = true;
        await applyRelayBitrateLimits(peer);
    }
}

/**
 * При connection через TURN-relay режем битрейт VIDEO-sender'ов.
 *
 * Зачем: voice (Opus, ~48 kbps) на TURN-сервере не нагружает канал; резать
 * его не нужно. А screencast через relay идёт через VPS дважды (ingress от
 * стримера + egress зрителю), так что video лимитируем.
 *
 * Цифры: maxBitrate 3.0 Mbps (ПОТОЛОК на пик движения), старт с полного
 * разрешения (scaleResolutionDownBy 1), 30 fps, degradationPreference="balanced".
 * ВАЖНО про экономику: cap — это ПОТОЛОК, а не постоянный битрейт. Скрин-контент
 * взрывной: статика (чтение) почти бесплатна, к 3 Mbps подходит лишь на активном
 * движении. СРЕДНИЙ битрейт relay-зрителя ≪ cap → поднятие 2→3 Mbps даёт запас
 * резкости на движении, почти не меняя средний egress сервера. balanced: на пике
 * плавно проседают И fps, И разрешение (раньше "maintain-resolution" ронял fps в
 * пол 5-10 — это и были лаги). Трафик безлимитный, узкое место — 1 vCPU coturn.
 *
 * НЕ трогаем audio-sender'ы — ни mic (voice), ни screen-audio (music-mode
 * 256 kbps, критично для качества демки и в общем балансе это копейки).
 */
async function applyRelayBitrateLimits(peer) {
    const senders = peer.getSenders ? peer.getSenders() : [];
    /* Тот же бюджет-на-зрителя, что и для direct: relay-потолок 3.0 Mbps, но при
       большом числе зрителей делённый бюджет опускает его ещё ниже (напр. 9
       зрителей → ~1.7 Mbps), удерживая суммарную relay-нагрузку coturn. */
    const viewers = screenViewerCount();
    const videoCap = Math.min(3_000_000, Math.round(SCREEN_UPLOAD_BUDGET / viewers));
    for (const sender of senders) {
        if (!sender.track) continue;
        if (sender.track.kind !== "video") continue;
        const apply = async (withDegradation) => {
            const params = sender.getParameters();
            if (!params.encodings || !params.encodings.length) params.encodings = [{}];
            const enc = params.encodings[0];
            enc.maxBitrate = videoCap;
            enc.scaleResolutionDownBy = 1; // старт с полного; balanced даунскейлит сам
            enc.maxFramerate = 30;
            if (withDegradation) params.degradationPreference = "balanced";
            await sender.setParameters(params);
        };
        try {
            await apply(true);
            log.info("rtc", "relay video bitrate capped", { userId: peer._userId, viewers, videoCap });
        } catch (err1) {
            try {
                await apply(false);
                log.info("rtc", "relay video bitrate capped (no degradation pref)", { userId: peer._userId, viewers, videoCap });
            } catch (err2) {
                log.warn("rtc", "relay video bitrate cap failed", { err: err2?.message || String(err2) });
            }
        }
    }
}
