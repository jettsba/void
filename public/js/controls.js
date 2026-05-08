/* ========= CONTROLS ========= */

function toggleMic() {

    if (!isSoundOn) {
        isSoundOn = true;
        isMicOn = true;
    } else {
        isMicOn = !isMicOn;
    }

    applyAudioState();
}

function toggleSound() {

    const wasOff = !isSoundOn;

    isSoundOn = !isSoundOn;

    if (!isSoundOn) {
        isMicOn = false;
    } else {
        isMicOn = true;
    }

    applyAudioState();
}

function updateMicUI() {
    micBtn.classList.toggle("off", !isMicOn);
}

function updateSoundUI() {
    soundBtn.classList.toggle("off", !isSoundOn);
}

function updateSelfVisualState() {

    const el = document.querySelector(
        `.participant[data-user-id="${clientId}"]`
    );

    if (!el) return;

    el.classList.toggle("muted", !isMicOn);
    el.classList.toggle("deaf", !isSoundOn);
}

function applyAudioState() {

    if (localStream) {
        localStream.getAudioTracks().forEach(track => {
            track.enabled = isMicOn && isSoundOn;
        });
    }

    document.querySelectorAll("audio").forEach(audio => {
        audio.muted = !isSoundOn;
    });

    updateMicUI();
    updateSoundUI();

    updateSelfVisualState();

    sendSocket({
        type: "audio-state",
        room: currentRoomCode,
        userId: clientId,
        mic: isMicOn,
        sound: isSoundOn
    });

}

function updateParticipantAudioState(userId, mic, sound) {

    const el = document.querySelector(
        `.participant[data-user-id="${userId}"]`
    );

    if (!el) return;

    el.classList.toggle("muted", !mic);
    el.classList.toggle("deaf", !sound);
}
