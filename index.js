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

// 資料結構：rooms = { "123": { hostId: "...", players: [...] } }
let rooms = {};

io.on('connection', (socket) => {
    
    socket.on('joinRoom', ({ roomId, username }) => {
        // 1. 檢查房間是否存在，不存在則創立
        if (!rooms[roomId]) {
            rooms[roomId] = {
                hostId: socket.id,
                players: []
            };
        }

        const currentRoom = rooms[roomId];

        // 2. 檢查同房間內是否有重複名稱
        const isDuplicate = currentRoom.players.some(p => p.name === username);
        if (isDuplicate) {
            socket.emit('errorMessage', '這個名字在房間裡已經有人用囉！');
            return;
        }

        // 3. 加入房間
        socket.join(roomId);
        const player = { 
            id: socket.id, 
            name: username, 
            role: null, 
            isHost: (socket.id === currentRoom.hostId) 
        };
        currentRoom.players.push(player);
        socket.roomId = roomId; // 紀錄玩家在哪個房間

        // 4. 通知房間內所有人更新名單
        io.to(roomId).emit('updatePlayers', currentRoom.players);
        socket.emit('hostStatus', socket.id === currentRoom.hostId);
        console.log(`玩家 ${username} 進入房間 ${roomId}`);
    });

    // 聊天訊息（僅發送給同房間的人）
    socket.on('sendMessage', (data) => {
        if (socket.roomId) {
            io.to(socket.roomId).emit('receiveMessage', data);
        }
    });

    // 房長開始遊戲
    socket.on('startGame', () => {
        const roomId = socket.roomId;
        if (!roomId || !rooms[roomId]) return;
        
        const currentRoom = rooms[roomId];
        const roles = ['狼人', '預言家', '女巫', '獵人', '村民', '村民'];
        
        currentRoom.players.forEach((p, i) => {
            p.role = roles[i % roles.length];
            io.to(p.id).emit('assignRole', p.role);
        });
        io.to(roomId).emit('receiveMessage', { name: "系統", text: "🔥 遊戲開始！身分已發送。", isSystem: true });
    });

    // 斷線處理
    socket.on('disconnect', () => {
        const roomId = socket.roomId;
        if (roomId && rooms[roomId]) {
            const currentRoom = rooms[roomId];
            const wasHost = (socket.id === currentRoom.hostId);
            
            currentRoom.players = currentRoom.players.filter(p => p.id !== socket.id);
            
            if (currentRoom.players.length === 0) {
                delete rooms[roomId]; // 沒人就刪除房間
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
server.listen(PORT, () => console.log(`房間系統伺服器已啟動: ${PORT}`));
