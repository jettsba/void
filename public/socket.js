/* ========= SOCKET ========= */

let socket = null;

function connectSocket() {
    return new Promise((resolve) => {

        if (socket && socket.readyState === 1) {
            resolve();
            return;
        }

        socket = new WebSocket(`ws://${window.location.host}`);

        socket.addEventListener("open", () => {
            console.log("🟢 Connected to WebSocket");
            if (typeof setConnectionState === "function") {
                setConnectionState("connecting");
            }
            resolve();
        });

        socket.addEventListener("message", (event) => {
            const data = JSON.parse(event.data);
            handleSocketMessage(data);
        });

        socket.addEventListener("close", () => {
            console.log("🔴 Socket closed");
            if (typeof setConnectionState === "function") {
                setConnectionState("ready");
            }
            socket = null;
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
                enterRoomUI();
            }
            break;

        case "join-success":
            sendSocket({
                type: "join-room-confirm",
                code: data.code,
                userId: clientId,
                nickname: currentUsername
            });
            enterRoomUI();
            break;

        case "join-failed":
            alert("Комната не найдена");
            if (typeof setConnectionState === "function") {
                setConnectionState("error");
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