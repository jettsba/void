const express = require('express');
const WebSocket = require('ws');

const app = express();
app.use(express.static('public'));
app.listen(3000, () => console.log('HTTP на 3000'));

const wss = new WebSocket.Server({ port: 3001 });
let clients = [];

wss.on('connection', ws => {
    clients.push(ws);

    ws.on('message', msg => {
        clients.forEach(c => {
            if (c !== ws && c.readyState === WebSocket.OPEN) {
                c.send(msg);
            }
        });
    });

    ws.on('close', () => {
        clients = clients.filter(c => c !== ws);
    });
});
