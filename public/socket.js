/* ========= SOCKET ========= */

let socket = null;

/** Закрыть сокет при отмене входа / ошибке (вызывается из script.js). */
function resetSocketConnection() {
    if (socket) {
        try {
            socket.close();
        } catch (_) {}
        socket = null;
    }
}

function connectSocket() {
    return new Promise((resolve, reject) => {

        if (socket && socket.readyState === 1) {
            resolve();
            return;
        }

        let connectionResolved = false;
        const ws = new WebSocket(`ws://${window.location.host}`);
        socket = ws;

        const timeoutId = setTimeout(() => {
            if (!connectionResolved) {
                connectionResolved = true;
                try {
                    ws.close();
                } catch (_) {}
                socket = null;
                reject(new Error("timeout"));
            }
        }, 15000);

        ws.addEventListener("open", () => {
            if (connectionResolved) return;
            connectionResolved = true;
            clearTimeout(timeoutId);

            console.log("🟢 Connected to WebSocket");
            if (typeof setConnectionState === "function") {
                setConnectionState("connecting");
            }

            ws.addEventListener("message", (event) => {
                const data = JSON.parse(event.data);
                handleSocketMessage(data);
            });

            resolve();
        });

        ws.addEventListener("close", () => {
            if (!connectionResolved) {
                connectionResolved = true;
                clearTimeout(timeoutId);
                socket = null;
                reject(new Error("ws-closed"));
                return;
            }

            console.log("🔴 Socket closed");
            if (typeof setConnectionState === "function") {
                setConnectionState("ready");
            }
            socket = null;
        });

        ws.addEventListener("error", () => {
            if (!connectionResolved) {
                connectionResolved = true;
                clearTimeout(timeoutId);
                try {
                    ws.close();
                } catch (_) {}
                socket = null;
                reject(new Error("ws-error"));
            }
        });
    });
}

function sendSocket(data) {
    if (socket && socket.readyState === 1) {
        socket.send(JSON.stringify(data));
    }
}

function handleSocketMessage(data) {
    switch (data.type) {
        case "room-created":
            if (data.success) {
                sendSocket({
                    type: "join-room-confirm",
                    code: data.code,
                    userId: clientId,
                    nickname: currentUsername
                });
            } else if (typeof abortJoinAttempt === "function") {
                abortJoinAttempt(data.reason || "create-failed");
            }
            break;

        case "join-success":
            sendSocket({
                type: "join-room-confirm",
                code: data.code,
                userId: clientId,
                nickname: currentUsername
            });
            break;

        case "join-failed":
            if (typeof abortJoinAttempt === "function") {
                abortJoinAttempt(data.reason || "room-not-found");
            }
            break;

        case "audio-state":
            updateParticipantAudioState(data.userId, data.mic, data.sound);
            break;

        case "participant-left":
            removeParticipant(data.userId);

            const peer = peers.get(data.userId);
            if (peer) {
                peer.close();
                peers.delete(data.userId);
            }

            break;

        case "new-participant":
            addParticipant(data.userId, data.nickname);
            callUser(data.userId);
            break;

        case "user-list":
            if (!isJoined) {
                enterRoomUI();
            }
            data.users.forEach(user => {
                addParticipant(user.id, user.nickname);

                updateParticipantAudioState(
                    user.id,
                    user.mic,
                    user.sound
                );
            });
            break;

        case "offer":
            handleOffer(data);
            break;

        case "answer":
            handleAnswer(data);
            break;

        case "ice":
            handleIce(data);
            break;
    }
}
