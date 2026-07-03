/* ========= AUDIO ========= */
/* Вход/выход в комнату — старые mp3 (audio-in/out), играются И для self, И для
   других участников (синк по существующим WS-broadcast'ам). Остальные событийные
   звуки (mic/sound/screencast/message) — синтез (js/void-sfx.js). ambient/welcome
   — интро-звуки на <audio>. */

/* SFX_BASE_VOLUME — база синтеза до мастер-громкости. Был 0.16 (выровнен под mp3
   входа/выхода), по фидбеку «тоглы тихие» поднят до 0.22. Пользователь может
   дополнительно регулировать всё через слайдер «громкость звуков приложения»
   (_sfxUserVol 0..1.5) и выключателем (_sfxEnabled). */
const SFX_BASE_VOLUME = 0.22;           // база синтеза до мастера
const ROOM_CLIP_VOLUME = 0.4;           // база mp3 входа/выхода до мастера
let _master = 1;                        // мастер-громкость приложения (0..1)
let _sfxUserVol = 1;                     // пользовательский множитель звуков (0..1.5)
let _sfxEnabled = true;                  // выключатель звуков приложения
let _sfxVolume = SFX_BASE_VOLUME;
let _sfxSink = '';
let _voidSfx = null;

/* Эффективный множитель звуков приложения: 0 когда выключены. */
function _effSfx() { return _sfxEnabled ? _sfxUserVol : 0; }
function _recomputeSfxVolume() {
    _sfxVolume = SFX_BASE_VOLUME * _master * _effSfx();
    if (_voidSfx) _voidSfx.volume = _sfxVolume;
}

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
        const eff = _effSfx();
        if (eff <= 0) return;                 // звуки приложения выключены
        const a = _roomClip(kind).cloneNode();
        a.volume = Math.max(0, Math.min(1, ROOM_CLIP_VOLUME * _master * eff));
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
        _recomputeSfxVolume();
    },
    /* Пользовательская громкость звуков приложения (0..1.5) — слайдер настроек. */
    setSfxVolume(vol) {
        _sfxUserVol = Math.max(0, Math.min(1.5, Number(vol) || 0));
        _recomputeSfxVolume();
    },
    /* Выключатель звуков приложения. */
    setSfxEnabled(on) {
        _sfxEnabled = !!on;
        _recomputeSfxVolume();
    },
    /* Устройство вывода (как setSinkId у <audio>). Хук в applyOutputSinkToAll. */
    setSink(id) {
        _sfxSink = id || '';
        if (_voidSfx) _voidSfx.setSink(_sfxSink);
    },
    /* Speaker-test: hero-звук «lock-in» из pad-палитры (js/void-sfx-pad.js) на
       КОНКРЕТНОМ устройстве (одноразовый контекст с setSinkId, затем закрывается).
       Всегда слышимый уровень (0.6 × master) — независимо от слайдера/выключателя
       звуков приложения (это проверка ВЫХОДА, а не событийный звук). */
    testOnDevice(deviceId) {
        if (typeof VoidSFXPad === 'function') {
            const t = new VoidSFXPad({ volume: 0.6 * _master, sinkId: deviceId || '' });
            t.screencastStart();
            setTimeout(() => t.close(), 3000);
            return;
        }
        /* Фолбэк, если pad-модуль не загрузился — старый короткий тон. */
        if (typeof VoidSFX !== 'function') return;
        const t = new VoidSFX({ volume: SFX_BASE_VOLUME * _master, sinkId: deviceId || '' });
        t.message();
        setTimeout(() => t.close(), 1500);
    }
};
window.VoidSounds = VoidSounds;

/* Настройки «громкость звуков приложения» (слайдер + выключатель) — читаем из
   VoidSettings на старте и слушаем изменения (void:audio-sfx-changed). */
function _applySfxSettings() {
    const S = window.VoidSettings;
    if (!S) return;
    if (typeof S.getSfxEnabled === 'function') VoidSounds.setSfxEnabled(S.getSfxEnabled());
    if (typeof S.getSfxVolume === 'function') VoidSounds.setSfxVolume(S.getSfxVolume());
}
document.addEventListener('void:audio-sfx-changed', _applySfxSettings);
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _applySfxSettings);
} else {
    _applySfxSettings();
}

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
