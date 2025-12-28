const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors()); // 允許跨網域連線，讓 GitHub Pages 可以連到 Render

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

    // 1. 玩家加入遊戲
    socket.on('joinGame', (username) => {
        const player = { id: socket.id, name: username, role: null };
        players.push(player);
        io.emit('updatePlayers', players); // 廣播最新名單給所有人
        console.log(`${username} 加入了遊戲`);
    });

    // 2. 聊天訊息轉發 (新增)
    socket.on('sendMessage', (data) => {
        // 接收到訊息後，立刻廣播給所有人（包含發送者自己）
        io.emit('receiveMessage', data);
        console.log(`聊天訊息 - ${data.name}: ${data.text}`);
    });

    // 3. 開始遊戲與發牌
    socket.on('startGame', () => {
        const roles = ['狼人', '預言家', '女巫', '村民', '村民', '村民'];
        // 隨機分配身分
        players.forEach((player, index) => {
            player.role = roles[index % roles.length];
            // 只把身分私下傳給該玩家
            io.to(player.id).emit('assignRole', player.role);
        });
        console.log('遊戲開始，身分已發放');
    });

    // 4. 斷線處理
    socket.on('disconnect', () => {
        players = players.filter(p => p.id !== socket.id);
        io.emit('updatePlayers', players);
        console.log('有玩家離開了');
    });
});

// 使用 Render 提供的 Port，否則預設 3000
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`狼人殺伺服器已啟動！跑在 Port: ${PORT}`);
});
