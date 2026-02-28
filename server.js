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
            success: false
        }));
        return;
    }

    rooms.set(code, {
        users: new Map()
    });

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
            type: "join-failed"
        }));
        return;
    }

    ws.send(JSON.stringify({
        type: "join-success",
        code
    }));
}

function handleJoinConfirm(ws, data) {

    const { code, userId, nickname } = data;
    const room = rooms.get(code);

    if (!room) return;

    ws.roomCode = code;
    ws.userId = userId;

    room.users.set(userId, { ws, nickname });

    // Отправляем список существующих пользователей
    const usersList = [];

    room.users.forEach((user, id) => {
        if (id !== userId) {
            usersList.push({
                id,
                nickname: user.nickname
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
                nickname
            }));
        }
    });

    console.log(`👤 ${nickname} (${userId}) joined room ${code}`);
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