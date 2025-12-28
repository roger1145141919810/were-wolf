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
    // --- 房間管理 ---
    socket.on('joinRoom', ({ roomId, username }) => {
        if (!rooms[roomId]) {
            rooms[roomId] = { 
                hostId: socket.id, 
                players: [], 
                status: 'waiting', 
                votes: {}, 
                skipVotes: new Set(), // 白天跳過投票
                witchHasSave: true,
                witchHasPoison: true,
                nightAction: { 
                    wolfVotes: {}, 
                    wolfConfirmations: {}, // 狼人確認狀態
                    finalKilledId: null, 
                    savedId: null, 
                    poisonedId: null 
                }
            };
        }
        const room = rooms[roomId];
        if (room.status !== 'waiting') return socket.emit('errorMessage', '❌ 遊戲進行中。');
        if (room.players.some(p => p.name === username)) return socket.emit('errorMessage', '❌ 名字有人用囉。');

        socket.join(roomId);
        socket.roomId = roomId;
        socket.username = username;

        const player = { 
            id: socket.id, 
            name: username, 
            role: null, 
            isHost: room.players.length === 0, 
            isAlive: true 
        };
        if (player.isHost) room.hostId = socket.id;
        room.players.push(player);

        broadcastUpdate(roomId);
        socket.emit('hostStatus', player.isHost);
    });

    // --- 狼人核心：同步與共識 ---
    socket.on('wolfKill', (targetId) => {
        const room = rooms[socket.roomId];
        if (room?.status === 'night_wolf') {
            const player = room.players.find(p => p.id === socket.id);
            if (player?.role === '狼人' && player.isAlive) {
                room.nightAction.wolfVotes[socket.id] = targetId;
                delete room.nightAction.wolfConfirmations[socket.id]; // 更改目標需重按確認
                syncWolfUI(room);
            }
        }
    });

    socket.on('wolfConfirm', () => {
        const room = rooms[socket.roomId];
        if (room?.status === 'night_wolf') {
            const player = room.players.find(p => p.id === socket.id);
            if (player?.role === '狼人' && player.isAlive && room.nightAction.wolfVotes[socket.id]) {
                room.nightAction.wolfConfirmations[socket.id] = true;
                
                const aliveWolves = room.players.filter(p => p.role === '狼人' && p.isAlive);
                const votes = aliveWolves.map(w => room.nightAction.wolfVotes[w.id]);
                const confirms = aliveWolves.map(w => room.nightAction.wolfConfirmations[w.id]);
                const uniqueVotes = [...new Set(votes)];

                // 判定是否達成共識
                const isConsensus = (aliveWolves.length === 1) || 
                                    (uniqueVotes.length === 1 && confirms.every(c => c === true));

                if (isConsensus) {
                    room.nightAction.finalKilledId = uniqueVotes[0];
                    // 此處不直接跳轉，等待倒數結束或由房長控制，確保體驗流暢
                }
                syncWolfUI(room);
            }
        }
    });

    // --- 白天：民主跳過制 ---
    socket.on('castSkipVote', () => {
        const room = rooms[socket.roomId];
        if (room?.status === 'day') {
            const player = room.players.find(p => p.id === socket.id);
            if (player?.isAlive) {
                room.skipVotes.add(socket.id);
                const aliveCount = room.players.filter(p => p.isAlive).length;
                const required = aliveCount - 1;

                io.to(socket.roomId).emit('receiveMessage', { 
                    name: "系統", text: `⏩ 跳過投票進度: ${room.skipVotes.size}/${required}`, isSystem: true 
                });

                if (room.skipVotes.size >= required) {
                    startVoting(socket.roomId);
                }
            }
        }
    });

    // --- 流程控制：黑夜三階段 ---
    function triggerNight(roomId) {
        const room = rooms[roomId];
        if (!room) return;
        room.nightAction = { wolfVotes: {}, wolfConfirmations: {}, finalKilledId: null, savedId: null, poisonedId: null };

        // 狼人階段延長至 60 秒
        startNightPhase(roomId, 'night_wolf', "🌙 狼人請殺人 (1:00)...", 60, () => {
            startNightPhase(roomId, 'night_witch', "🧪 女巫請行動...", 15, () => {
                startNightPhase(roomId, 'night_seer', "🔮 預言家請驗人...", 15, () => {
                    settleNight(roomId);
                });
            });
            // 通知女巫
            const witch = room.players.find(p => p.role === '女巫' && p.isAlive);
            if (witch) {
                const victim = room.players.find(p => p.id === room.nightAction.finalKilledId);
                io.to(witch.id).emit('witchTarget', { name: victim ? victim.name : "無人死亡" });
            }
        });
    }

    function startDay(roomId) {
        const room = rooms[roomId];
        room.status = 'day';
        room.skipVotes = new Set(); 
        broadcastUpdate(roomId);
        let timeLeft = 600; // 白天 10 分鐘
        startTimer(roomId, timeLeft, () => startVoting(roomId));
    }

    // --- 工具函式 ---
    function syncWolfUI(room) {
        const aliveWolves = room.players.filter(p => p.role === '狼人' && p.isAlive);
        const data = aliveWolves.map(w => ({
            id: w.id,
            targetId: room.nightAction.wolfVotes[w.id] || null,
            isConfirmed: !!room.nightAction.wolfConfirmations[w.id]
        }));
        aliveWolves.forEach(w => io.to(w.id).emit('updateWolfUI', data));
    }

    function startTimer(roomId, time, callback) {
        if (roomTimers[roomId]) clearInterval(roomTimers[roomId]);
        let timeLeft = time;
        roomTimers[roomId] = setInterval(() => {
            timeLeft--;
            io.to(roomId).emit('timerUpdate', timeLeft);
            if (timeLeft <= 0) {
                clearInterval(roomTimers[roomId]);
                callback();
            }
        }, 1000);
    }

    function broadcastUpdate(roomId) {
        const room = rooms[roomId];
        if (!room) return;
        io.to(roomId).emit('updatePlayers', { 
            players: room.players, 
            status: room.status,
            witchStatus: { hasSave: room.witchHasSave, hasPoison: room.witchHasPoison }
        });
    }
    
    // ... 其餘 settleVote, checkGameOver 等邏輯保持不變 ...
});

server.listen(process.env.PORT || 3000);
