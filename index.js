const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// 遊戲資料儲存
let rooms = {};
let roomTimers = {};

io.on('connection', (socket) => {
    console.log('玩家連線:', socket.id);

    // 1. 加入房間
    socket.on('joinRoom', ({ roomId, username }) => {
        socket.join(roomId);
        socket.roomId = roomId;
        socket.username = username;

        if (!rooms[roomId]) {
            rooms[roomId] = {
                id: roomId,
                hostId: socket.id,
                players: [],
                status: 'waiting', // waiting, day, night
                nightActions: {},
                aliveCount: 0
            };
        }

        const room = rooms[roomId];
        room.players.push({
            id: socket.id,
            username,
            role: '平民',
            side: 'good',
            isAlive: true,
            isSheriff: false
        });

        io.to(roomId).emit('updatePlayers', room.players);
    });

    // 2. 開始遊戲 (上帝觸發)
    socket.on('startGame', () => {
        const room = rooms[socket.roomId];
        if (!room || socket.id !== room.hostId) return;

        // 簡單分配角色 (範例：1狼 1預 1守 其餘平民)
        const roles = ['狼人', '預言家', '守衛', '女巫', '平民', '平民'];
        room.players.forEach((p, i) => {
            p.role = roles[i] || '平民';
            p.side = p.role === '狼人' ? 'wolf' : 'good';
            io.to(p.id).emit('assignRole', p.role);
        });

        room.status = 'playing';
        triggerNight(socket.roomId);
    });

    // 3. 黑夜切換邏輯
    function triggerNight(roomId) {
        const room = rooms[roomId];
        room.status = 'night';
        room.nightActions = {}; // 清空昨晚行動
        
        io.to(roomId).emit('receiveMessage', { name: "系統", text: "🌙 天黑請閉眼...", isSystem: true });
        io.to(roomId).emit('phaseChange', 'night');

        let timeLeft = 30;
        roomTimers[roomId] = setInterval(() => {
            timeLeft--;
            io.to(roomId).emit('timerUpdate', timeLeft);
            if (timeLeft <= 0) {
                clearInterval(roomTimers[roomId]);
                resolveNight(roomId);
            }
        }, 1000);
    }

    // 4. 接收角色行動
    socket.on('submitAction', ({ type, targetId }) => {
        const room = rooms[socket.roomId];
        if (!room || room.status !== 'night') return;
        room.nightActions[type] = targetId;
        socket.emit('receiveMessage', { name: "系統", text: "✅ 行動已記錄。", isSystem: true });
    });

    // 5. 黑夜結算 (核心邏輯)
    function resolveNight(roomId) {
        const room = rooms[roomId];
        const actions = room.nightActions;
        let deadId = actions.wolfKill;

        // 同守同救邏輯
        if (actions.guard === deadId && actions.witchSave === deadId) {
            // 依然死亡
        } else if (actions.guard === deadId || actions.witchSave === deadId) {
            deadId = null;
        }

        if (actions.witchPoison) deadId = actions.witchPoison;

        // 執行死亡
        if (deadId) {
            const p = room.players.find(p => p.id === deadId);
            if (p) p.isAlive = false;
        }

        room.status = 'day';
        io.to(roomId).emit('phaseChange', 'day');
        io.to(roomId).emit('updatePlayers', room.players);
        io.to(roomId).emit('receiveMessage', { 
            name: "系統", 
            text: deadId ? `💀 昨晚幾號玩家死亡了。` : "🕊️ 昨晚是平安夜。", 
            isSystem: true 
        });
    }

    socket.on('sendMessage', (msg) => {
        io.to(socket.roomId).emit('receiveMessage', { name: socket.username, text: msg });
    });
});

server.listen(3000, () => console.log('Server running on http://localhost:3000'));
