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

// 資料結構：rooms = { "房間號碼": { hostId: "ID", players: [] } }
let rooms = {};

io.on('connection', (socket) => {
    console.log('連線連入:', socket.id);

    // 【加入房間邏輯】
    socket.on('joinRoom', ({ roomId, username }) => {
        // 如果房間不存在，則創立
        if (!rooms[roomId]) {
            rooms[roomId] = { hostId: socket.id, players: [] };
        }

        const currentRoom = rooms[roomId];

        // 【防重複名檢查】
        const isDuplicate = currentRoom.players.some(p => p.name === username);
        if (isDuplicate) {
            socket.emit('errorMessage', '❌ 這個名字在房間裡已經有人用囉！');
            return;
        }

        socket.join(roomId);
        socket.roomId = roomId;
        socket.username = username;

        const player = { 
            id: socket.id, 
            name: username, 
            role: null, 
            isHost: (socket.id === currentRoom.hostId) 
        };
        
        currentRoom.players.push(player);

        // 通知房間內所有人
        io.to(roomId).emit('updatePlayers', currentRoom.players);
        socket.emit('hostStatus', player.isHost);
        io.to(roomId).emit('receiveMessage', { name: "系統", text: `歡迎 ${username} 進入村莊！`, isSystem: true });
    });

    // 【搶當房長】
    socket.on('claimHost', () => {
        const roomId = socket.roomId;
        if (!roomId || !rooms[roomId]) return;
        
        rooms[roomId].hostId = socket.id;
        rooms[roomId].players.forEach(p => p.isHost = (p.id === socket.id));
        
        io.to(roomId).emit('updatePlayers', rooms[roomId].players);
        io.to(roomId).emit('hostChanged', socket.id);
        io.to(roomId).emit('receiveMessage', { name: "系統", text: `${socket.username} 已成為新房長 👑`, isSystem: true });
    });

    // 【聊天訊息】
    socket.on('sendMessage', (data) => {
        if (socket.roomId) {
            io.to(socket.roomId).emit('receiveMessage', data);
        }
    });

    // 【修改後的開始遊戲邏輯】
    socket.on('startGame', () => {
        const roomId = socket.roomId;
        if (!rooms[roomId]) return;

        const currentRoom = rooms[roomId];

        // 新增條件：檢查人數是否達到 6 人
        if (currentRoom.players.length < 6) {
            // 只對發送請求的房長回傳錯誤訊息
            socket.emit('errorMessage', `❌ 人數不足！目前只有 ${currentRoom.players.length} 人，至少需要 6 人才能開始遊戲。`);
            return;
        }

        // 定義至少 6 人的角色池（可以根據需求增加更多角色）
        const roles = ['狼人', '狼人', '預言家', '女巫', '獵人', '村民', '村民', '白癡'];
        
        // 洗牌並發放身分
        currentRoom.players.forEach((p, i) => {
            p.role = roles[i % roles.length];
            io.to(p.id).emit('assignRole', p.role);
        });
        
        io.to(roomId).emit('receiveMessage', { name: "系統", text: "🔥 遊戲開始！天黑請閉眼，請查看身分。", isSystem: true });
    });

    // 【斷線處理】
    socket.on('disconnect', () => {
        const roomId = socket.roomId;
        if (roomId && rooms[roomId]) {
            const currentRoom = rooms[roomId];
            const wasHost = (socket.id === currentRoom.hostId);
            
            currentRoom.players = currentRoom.players.filter(p => p.id !== socket.id);
            
            if (currentRoom.players.length === 0) {
                delete rooms[roomId];
            } else if (wasHost) {
                currentRoom.hostId = currentRoom.players[0].id;
                currentRoom.players[0].isHost = true;
                io.to(roomId).emit('hostChanged', currentRoom.hostId);
            }
            io.to(roomId).emit('updatePlayers', currentRoom.players || []);
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`狼人殺法官已就位，Port: ${PORT}`));
