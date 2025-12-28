const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

let players = [];
let hostId = null; // 紀錄房長的 ID

io.on('connection', (socket) => {
    // 1. 加入遊戲
    socket.on('joinGame', (username) => {
        // 如果還沒有房長，第一個加入的人自動變成房長
        if (!hostId) {
            hostId = socket.id;
        }
        const player = { id: socket.id, name: username, role: null, isHost: (socket.id === hostId) };
        players.push(player);
        
        io.emit('updatePlayers', players);
        socket.emit('hostStatus', socket.id === hostId); // 告訴該玩家他是不是房長
        console.log(`${username} 加入了，房長狀態: ${player.isHost}`);
    });

    // 2. 搶當房長 (如果原本房長斷線或想換人)
    socket.on('claimHost', () => {
        hostId = socket.id;
        players.forEach(p => p.isHost = (p.id === hostId));
        io.emit('updatePlayers', players);
        io.emit('hostChanged', hostId); // 廣播新房長產生
    });

    // 3. 聊天訊息
    socket.on('sendMessage', (data) => {
        io.emit('receiveMessage', data);
    });

    // 4. 開始遊戲
    socket.on('startGame', () => {
        const roles = ['狼人', '預言家', '女巫', '獵人', '村民', '村民'];
        players.forEach((player, index) => {
            player.role = roles[index % roles.length];
            io.to(player.id).emit('assignRole', player.role);
        });
        io.emit('receiveMessage', { name: "系統", text: "🔥 遊戲開始！身分已發放，請查看下方身分欄。" });
    });

    // 5. 斷線處理
    socket.on('disconnect', () => {
        const wasHost = (socket.id === hostId);
        players = players.filter(p => p.id !== socket.id);
        if (wasHost) {
            hostId = players.length > 0 ? players[0].id : null; // 自動移交給下一個人
            if (hostId) players[0].isHost = true;
        }
        io.emit('updatePlayers', players);
        if (wasHost) io.emit('hostChanged', hostId);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`伺服器跑在 ${PORT}`));
