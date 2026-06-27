/* ========= AUDIO ========= */
/* Вход/выход в комнату — старые mp3 (audio-in/out), играются И для self, И для
   других участников (синк по существующим WS-broadcast'ам). Остальные событийные
   звуки (mic/sound/screencast/message) — синтез (js/void-sfx.js). ambient/welcome
   — интро-звуки на <audio>. */

/* SFX_BASE_VOLUME выровнен по громкости mp3 входа/выхода (замер краткосрочной
   RMS-громкости: тоглы на базе 0.7 были ~×3.4-4.4 громче «чёрных дыр»; 0.16
   сажает громчайший тоггл ровно на их уровень). */
const SFX_BASE_VOLUME = 0.16;           // база синтеза до мастер-громкости
const ROOM_CLIP_VOLUME = 0.4;           // база mp3 входа/выхода до мастера
let _master = 1;                        // мастер-громкость приложения (0..1)
let _sfxVolume = SFX_BASE_VOLUME;
let _sfxSink = '';
let _voidSfx = null;

/* --- синтез (mic/sound/screencast/message). Ленивая инициализация: AudioContext
   создаётся на первом звуке (autoplay policy — после user-gesture). --- */
function _sfx() {
    if (!_voidSfx && typeof VoidSFX === 'function') {
        _voidSfx = new VoidSFX({ volume: _sfxVolume, sinkId: _sfxSink });
    }
    return _voidSfx;
}

/* --- mp3 входа/выхода: предзагруженный клип, клон на каждый проигрыш (чтобы
   близкие события self/peer не обрезали друг друга). --- */
let _joinClip = null, _leaveClip = null;
function _roomClip(kind) {
    if (kind === 'join') return (_joinClip || (_joinClip = _mkClip('static/audio-in.mp3')));
    return (_leaveClip || (_leaveClip = _mkClip('static/audio-out.mp3')));
}
function _mkClip(src) { const a = new Audio(src); a.preload = 'auto'; return a; }
function _playRoomClip(kind) {
    try {
        const a = _roomClip(kind).cloneNode();
        a.volume = Math.max(0, Math.min(1, ROOM_CLIP_VOLUME * _master));
        if (a.setSinkId && _sfxSink) a.setSinkId(_sfxSink).catch(() => {});
        a.play().catch(() => {});
    } catch (_) {}
}

const VoidSounds = {
    // вход/выход — старый mp3, одинаково для self и для других участников
    selfJoin()  { _playRoomClip('join'); },
    selfLeave() { _playRoomClip('leave'); },
    peerJoin()  { _playRoomClip('join'); },
    peerLeave() { _playRoomClip('leave'); },
    // остальное — синтез
    mic(on)     { on ? _sfx()?.micOn() : _sfx()?.micOff(); },
    sound(on)   { on ? _sfx()?.soundOn() : _sfx()?.soundOff(); },
    screencast(on) { on ? _sfx()?.screencastStart() : _sfx()?.screencastStop(); },
    message()   { _sfx()?.message(); },

    /* Мастер-громкость приложения (0..1). Хук в applyOutputVolumeAll (webrtc.js). */
    setMaster(master) {
        _master = Math.max(0, Math.min(1, master));
        _sfxVolume = SFX_BASE_VOLUME * _master;
        if (_voidSfx) _voidSfx.volume = _sfxVolume;
    },
    /* Устройство вывода (как setSinkId у <audio>). Хук в applyOutputSinkToAll. */
    setSink(id) {
        _sfxSink = id || '';
        if (_voidSfx) _voidSfx.setSink(_sfxSink);
    },
    /* Speaker-test: короткий синтез-тон на КОНКРЕТНОМ устройстве (одноразовый
       контекст с setSinkId именно к нему), затем контекст закрывается. */
    testOnDevice(deviceId) {
        if (typeof VoidSFX !== 'function') return;
        const t = new VoidSFX({ volume: _sfxVolume, sinkId: deviceId || '' });
        t.message();
        setTimeout(() => t.close(), 1500);
    }
};
window.VoidSounds = VoidSounds;

/* Тонкие алиасы под существующие вызовы (self): room.js → playJoin/LeaveSound,
   chat.js → playMessageSound. */
function playJoinSound()    { VoidSounds.selfJoin(); }
function playLeaveSound()   { VoidSounds.selfLeave(); }
function playMessageSound() { VoidSounds.message(); }

/* ambient / welcome — интро-звуки на <audio> (mp3), без изменений. */
function tryStartAudio() {
    if (!hasStartedAudio) {
        ambientSound.volume = 0.2;
        ambientSound.play().catch(() => {});
        hasStartedAudio = true;
    }
}

function playWelcomeSound() {
    welcomeSound.currentTime = 0;
    welcomeSound.volume = 0.4;
    welcomeSound.play().catch(() => {});
}
