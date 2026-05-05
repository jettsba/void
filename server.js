import express from "express";
import { WebSocketServer } from "ws";
import http from "http";

const app = express();
const PORT = process.env.PORT || 3000;

/* ========= STATIC FILES ========= */

app.use(express.static("public"));

const server = http.createServer(app);

server.listen(PORT, "0.0.0.0", () => {
    console.log(`🚀 Server running on http://localhost:${PORT}`);
});

/* ========= WEBSOCKET ========= */

const wss = new WebSocketServer({ server });

/*
Структура rooms:

Map {
  roomCode => {
    users: Map {
      userId => { ws, nickname }
    }
  }
}
*/

const rooms = new Map();

/** Max simultaneous participants per room (enforced at join intent + at confirm for races). */
const MAX_ROOM_USERS = 5;

wss.on("connection", (ws) => {
    console.log("🟢 Client connected");

    ws.on("message", (rawMessage) => {
        try {
            const data = JSON.parse(rawMessage.toString());

            switch (data.type) {

                case "create-room":
                    handleCreateRoom(ws, data);
                    break;

                case "join-room":
                    handleJoinRoom(ws, data);
                    break;

                case "join-room-confirm":
                    handleJoinConfirm(ws, data);
                    break;

                case "leave-room":
                    handleLeaveRoom(ws, data);
                    break;

                case "audio-state":
                    handleAudioState(ws, data);
                    break;

                case "screencast-state":
                    handleScreencastState(ws, data);
                    break;

                case "offer":
                case "answer":
                case "ice":
                    handleSignal(ws, data);
                    break;

                default:
                    console.log("Unknown message type:", data.type);
            }

        } catch (err) {
            console.error("❌ Invalid message:", err);
        }
    });

    ws.on("close", () => {
        handleDisconnect(ws);
    });
});

/* ========= ROOM LOGIC ========= */

function handleCreateRoom(ws, data) {

    const { code, userId, nickname } = data;

    if (rooms.has(code)) {
        ws.send(JSON.stringify({
            type: "room-created",
            success: false,
            reason: "code-taken"
        }));
        return;
    }

    rooms.set(code, {
        users: new Map()
    });

    /** Разрешает ровно один последующий join-room-confirm на этот код с этого сокета. */
    ws.authorizedJoinCode = code;

    ws.send(JSON.stringify({
        type: "room-created",
        success: true,
        code
    }));

    console.log(`✅ Room created: ${code}`);
}

function handleJoinRoom(ws, data) {

    const { code } = data;

    if (!rooms.has(code)) {
        ws.send(JSON.stringify({
            type: "join-failed",
            reason: "room-not-found"
        }));
        return;
    }

    const room = rooms.get(code);
    if (room.users.size >= MAX_ROOM_USERS) {
        ws.send(JSON.stringify({
            type: "join-failed",
            reason: "room-full"
        }));
        return;
    }

    ws.authorizedJoinCode = code;

    ws.send(JSON.stringify({
        type: "join-success",
        code
    }));
}

function handleJoinConfirm(ws, data) {

    const { code, userId, nickname } = data;

    if (ws.authorizedJoinCode !== code) {
        ws.send(JSON.stringify({
            type: "join-failed",
            reason: "join-session-invalid"
        }));
        return;
    }

    ws.authorizedJoinCode = undefined;

    const room = rooms.get(code);

    if (!room) {
        ws.send(JSON.stringify({
            type: "join-failed",
            reason: "room-not-found"
        }));
        return;
    }

    const alreadyIn = room.users.has(userId);
    if (!alreadyIn && room.users.size >= MAX_ROOM_USERS) {
        ws.send(JSON.stringify({
            type: "join-failed",
            reason: "room-full"
        }));
        return;
    }

    ws.roomCode = code;
    ws.userId = userId;

    room.users.set(userId, {
        ws,
        nickname,
        mic: true,
        sound: true,
        screen: false
    });

    if (room.users.size > MAX_ROOM_USERS) {
        room.users.delete(userId);
        ws.roomCode = undefined;
        ws.userId = undefined;
        ws.send(JSON.stringify({
            type: "join-failed",
            reason: "room-full"
        }));
        return;
    }

    const usersList = [];

    room.users.forEach((user, id) => {
        if (id !== userId) {
            usersList.push({
                id,
                nickname: user.nickname,
                mic: user.mic,
                sound: user.sound,
                screen: user.screen
            });
        }
    });

    ws.send(JSON.stringify({
        type: "user-list",
        users: usersList
    }));

    // Сообщаем остальным, что появился новый
    room.users.forEach((user, id) => {
        if (id !== userId && user.ws.readyState === 1) {
            user.ws.send(JSON.stringify({
                type: "new-participant",
                userId,
                nickname,
                screen: false
            }));
        }
    });

    console.log(`👤 ${nickname} (${userId}) joined room ${code}`);
}

function handleScreencastState(ws, data) {
    const room = rooms.get(ws.roomCode);
    if (!room) return;

    const user = room.users.get(ws.userId);
    if (!user) return;

    // Enforce single sharer: reject if another user is already sharing
    if (data.screen) {
        for (const [id, u] of room.users) {
            if (id !== ws.userId && u.screen) {
                ws.send(JSON.stringify({ type: "screencast-rejected" }));
                return;
            }
        }
    }

    user.screen = data.screen;

    room.users.forEach((u, id) => {
        if (id !== ws.userId && u.ws.readyState === 1) {
            u.ws.send(JSON.stringify({
                type: "screencast-state",
                userId: ws.userId,
                screen: data.screen
            }));
        }
    });
}

function handleAudioState(ws, data) {

    const room = rooms.get(ws.roomCode);
    if (!room) return;

    const user = room.users.get(ws.userId);
    if (!user) return;

    user.mic = data.mic;
    user.sound = data.sound;

    room.users.forEach((u, id) => {
        if (id !== ws.userId && u.ws.readyState === 1) {
            u.ws.send(JSON.stringify({
                type: "audio-state",
                userId: ws.userId,
                mic: data.mic,
                sound: data.sound
            }));
        }
    });
}

function handleLeaveRoom(ws, data) {

    const { room, userId } = data;
    const roomData = rooms.get(room);

    if (!roomData) return;

    roomData.users.delete(userId);

    // уведомляем остальных
    roomData.users.forEach((user) => {
        if (user.ws.readyState === 1) {
            user.ws.send(JSON.stringify({
                type: "participant-left",
                userId
            }));
        }
    });

    if (roomData.users.size === 0) {
        rooms.delete(room);
        console.log(`🧹 Room deleted: ${room}`);
    }
}

function handleDisconnect(ws) {

    if (!ws.roomCode) return;

    const room = rooms.get(ws.roomCode);
    if (!room) return;

    room.users.delete(ws.userId);

    room.users.forEach((user) => {
        if (user.ws.readyState === 1) {
            user.ws.send(JSON.stringify({
                type: "participant-left",
                userId: ws.userId
            }));
        }
    });

    if (room.users.size === 0) {
        rooms.delete(ws.roomCode);
    }

    console.log("🔴 Client disconnected");
}

function handleSignal(ws, data) {

    const room = rooms.get(ws.roomCode);
    if (!room) return;

    const targetUser = room.users.get(data.to);
    if (!targetUser) return;

    targetUser.ws.send(JSON.stringify({
        type: data.type,
        from: ws.userId,
        ...data
    }));
}