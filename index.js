const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*", 
        methods: ["GET", "POST"]
    }
});

let players = [];

io.on('connection', (socket) => {
    console.log('有玩家連線:', socket.id);

    // 玩家加入
    socket.on('joinGame', (username) => {
        const player = { id: socket.id, name: username, role: null };
        players.push(player);
        io.emit('updatePlayers', players);
        console.log(`${username} 加入了遊戲`);
    });

    // 開始遊戲發牌
    socket.on('startGame', () => {
        const roles = ['狼人', '預言家', '女巫', '村民'];
        // 隨機發牌
        players.forEach((player, index) => {
            player.role = roles[index % roles.length];
            io.to(player.id).emit('assignRole', player.role);
        });
        console.log('遊戲開始，身分已發放');
    });

    // 斷線處理
    socket.on('disconnect', () => {
        players = players.filter(p => p.id !== socket.id);
        io.emit('updatePlayers', players);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`伺服器跑在連接埠 ${PORT}`));
