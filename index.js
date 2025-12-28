const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*", methods: ["GET", "POST"] } });

let rooms = {};
let roomTimers = {};

io.on('connection', (socket) => {
    // 【加入房間】
    socket.on('joinRoom', ({ roomId, username }) => {
        if (!rooms[roomId]) rooms[roomId] = { hostId: socket.id, players: [], status: 'waiting', skipVotes: new Set() };
        const room = rooms[roomId];

        if (room.status === 'playing' || room.status === 'day') return socket.emit('errorMessage', '❌ 遊戲進行中，無法進入。');
        if (room.players.some(p => p.name === username)) return socket.emit('errorMessage', '❌ 名字有人用囉。');

        socket.join(roomId);
        socket.roomId = roomId;
        socket.username = username;

        const player = { id: socket.id, name: username, role: null, isHost: (socket.id === room.hostId), isAlive: true, usedPotions: [] };
        room.players.push(player);

        io.to(roomId).emit('updatePlayers', { players: room.players, status: room.status });
        socket.emit('hostStatus', player.isHost);
    });

    // 【房長功能：踢人 & 移交】
    socket.on('kickPlayer', (targetId) => {
        const room = rooms[socket.roomId];
        if (room && socket.id === room.hostId && room.status === 'waiting') {
            io.to(targetId).emit('errorMessage', '你已被房長踢出房間。');
            io.sockets.sockets.get(targetId)?.disconnect();
        }
    });

    socket.on('transferHost', (targetId) => {
        const room = rooms[socket.roomId];
        if (room && socket.id === room.hostId && room.status === 'waiting') {
            const newHost = room.players.find(p => p.id === targetId);
            if (newHost) {
                room.players.forEach(p => p.isHost = false);
                room.hostId = newHost.id;
                newHost.isHost = true;
                io.to(socket.roomId).emit('updatePlayers', { players: room.players, status: room.status });
                io.to(targetId).emit('hostStatus', true);
                socket.emit('hostStatus', false);
                io.to(socket.roomId).emit('receiveMessage', { name: "系統", text: `👑 房長已轉移給 ${newHost.name}。`, isSystem: true });
            }
        }
    });

    // 【核心邏輯：黑夜觸發器】
    function triggerNight(roomId) {
        const room = rooms[roomId];
        if (!room) return;

        if (roomTimers[roomId]) clearInterval(roomTimers[roomId]);
        
        // 🚩 修正：將狀態設為 'night' (或非 'day')，讓前端知道要隱藏按鈕
        room.status = 'playing'; 
        room.skipVotes = new Set(); 

        io.to(roomId).emit('receiveMessage', { name: "系統", text: "🌙 天黑請閉眼，進入黑夜階段...", isSystem: true });
        
        // 🚩 關鍵：立即發送 updatePlayers，強制前端隱藏「跳過按鈕」
        io.to(roomId).emit('updatePlayers', { players: room.players, status: room.status });

        room.players.forEach(p => { io.to(p.id).emit('assignRole', p.role); });

        let nightLeft = 30;
        io.to(roomId).emit('timerUpdate', nightLeft);
        roomTimers[roomId] = setInterval(() => {
            nightLeft--;
            io.to(roomId).emit('timerUpdate', nightLeft);
            if (nightLeft <= 0) {
                clearInterval(roomTimers[roomId]);
                io.to(roomId).emit('receiveMessage', { name: "系統", text: "⌛ 黑夜結束，黎明將至。", isSystem: true });
            }
        }, 1000);
    }

    // 【遊戲流程控制】
    socket.on('startGame', () => {
        const room = rooms[socket.roomId];
        if (!room || room.players.length < 6) return socket.emit('errorMessage', '❌ 至少需要 6 人才能開始。');
        room.status = 'playing';
        const rolesPool = ['狼人', '狼人', '預言家', '女巫', '村民', '村民', '獵人'];
        room.players.forEach((p, i) => {
            p.isAlive = true;
            p.role = rolesPool[i % rolesPool.length];
            io.to(p.id).emit('assignRole', p.role);
        });
        io.to(socket.roomId).emit('updatePlayers', { players: room.players, status: room.status });
    });

    socket.on('startDayTimer', () => {
        const roomId = socket.roomId;
        const room = rooms[roomId];
        if (!room || socket.id !== room.hostId) return;

        room.status = 'day';
        room.skipVotes = new Set();
        if (roomTimers[roomId]) clearInterval(roomTimers[roomId]);

        let timeLeft = 300; 
        io.to(roomId).emit('timerUpdate', timeLeft);
        
        // 🚩 啟動白天時也要同步一次狀態，讓按鈕出現
        io.to(roomId).emit('updatePlayers', { players: room.players, status: room.status });

        roomTimers[roomId] = setInterval(() => {
            timeLeft--;
            io.to(roomId).emit('timerUpdate', timeLeft);
            if (timeLeft <= 0) { triggerNight(roomId); }
        }, 1000);
    });

    socket.on('castSkipVote', () => {
        const roomId = socket.roomId;
        const room = rooms[roomId];
        if (!room || room.status !== 'day') return;

        room.skipVotes.add(socket.id);
        const aliveCount = room.players.filter(p => p.isAlive).length;
        const required = Math.max(1, aliveCount - 1); 

        io.to(roomId).emit('receiveMessage', { name: "系統", text: `⏭️ ${socket.username} 投票跳過 (${room.skipVotes.size}/${required})`, isSystem: true });
        
        if (room.skipVotes.size >= required) { 
            triggerNight(roomId); 
        }
    });

    // 【斷線 & 自動刷新邏輯】
    socket.on('disconnect', () => {
        const roomId = socket.roomId;
        const room = rooms[roomId];
        if (!room) return;

        room.players = room.players.filter(p => p.id !== socket.id);

        if (room.players.length === 0) {
            if (roomTimers[roomId]) clearInterval(roomTimers[roomId]);
            delete rooms[roomId];
            delete roomTimers[roomId];
            return;
        }

        if (room.status !== 'waiting') {
            checkGameOver(roomId);
            const anyAlive = room.players.some(p => p.isAlive);
            if (!anyAlive) {
                io.to(roomId).emit('receiveMessage', { name: "系統", text: "♻️ 所有玩家已淘汰，房間自動重置。", isSystem: true });
                endGame(roomId, "無人");
                return;
            }
        } else if (socket.id === room.hostId) {
            const newHost = room.players[0];
            room.hostId = newHost.id;
            newHost.isHost = true;
            io.to(newHost.id).emit('hostStatus', true);
        }
        io.to(roomId).emit('updatePlayers', { players: room.players, status: room.status });
    });

    function checkGameOver(roomId) {
        const room = rooms[roomId];
        if (!room) return;
        const alives = room.players.filter(p => p.isAlive);
        const wolves = alives.filter(p => p.role === '狼人');
        const humans = alives.filter(p => p.role !== '狼人');

        if (wolves.length === 0) endGame(roomId, "好人陣營");
        else if (humans.length === 0) endGame(roomId, "狼人陣營");
    }

    function endGame(roomId, winner) {
        io.to(roomId).emit('gameOver', { winner, allRoles: rooms[roomId].players });
        rooms[roomId].status = 'waiting';
        rooms[roomId].skipVotes = new Set();
        if (roomTimers[roomId]) {
            clearInterval(roomTimers[roomId]);
            delete roomTimers[roomId];
        }
        // 🚩 遊戲結束也要同步一次狀態
        io.to(roomId).emit('updatePlayers', { players: rooms[roomId].players, status: rooms[roomId].status });
    }

    socket.on('sendMessage', (d) => io.to(socket.roomId).emit('receiveMessage', d));
});

server.listen(process.env.PORT || 3000);
