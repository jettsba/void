/* ========= AUDIO ========= */

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

function playJoinSound() {
    joinSound.currentTime = 0;
    joinSound.volume = 0.4;
    joinSound.play().catch(() => {});
}

function playLeaveSound() {
    leaveSound.currentTime = 0;
    leaveSound.volume = 0.4;
    leaveSound.play().catch(() => {});
}
