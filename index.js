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
                skipVotes: new Set(), 
                witchHasSave: true,
                witchHasPoison: true,
                nightAction: { 
                    wolfVotes: {}, 
                    wolfConfirmations: {}, 
                    finalKilledId: null, 
                    savedId: null, 
                    poisonedId: null 
                }
            };
        }
        const room = rooms[roomId];
        if (room.status !== 'waiting') return socket.emit('errorMessage', '❌ 遊戲進行中，無法加入。');
        if (room.players.some(p => p.name === username)) return socket.emit('errorMessage', '❌ 名字已被使用。');

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

    // --- 聊天通訊 ---
    socket.on('sendMessage', (data) => {
        if (!socket.roomId) return;
        io.to(socket.roomId).emit('receiveMessage', { name: data.name, text: data.text });
    });

    socket.on('sendWolfMessage', (data) => {
        const room = rooms[socket.roomId];
        if (room) {
            room.players.filter(p => p.role === '狼人').forEach(w => {
                io.to(w.id).emit('receiveWolfMessage', { name: data.name, text: data.text });
            });
        }
    });

    // --- 遊戲邏輯與流程 ---
    socket.on('startGame', () => {
        const room = rooms[socket.roomId];
        if (!room) return;
        if (room.players.length < 6) return socket.emit('errorMessage', '人數不足 6 人，無法開始。');
        
        room.status = 'playing';
        room.witchHasSave = true;
        room.witchHasPoison = true;
        
        // 角色分配 (根據人數可動態調整)
        const roles = ['狼人', '狼人', '預言家', '女巫', '村民', '村民'].sort(() => Math.random() - 0.5);
        room.players.forEach((p, i) => {
            p.isAlive = true;
            p.role = roles[i];
            io.to(p.id).emit('assignRole', p.role);
        });
        
        triggerNight(socket.roomId);
    });

    socket.on('wolfKill', (targetId) => {
        const room = rooms[socket.roomId];
        if (room?.status === 'night_wolf') {
            const player = room.players.find(p => p.id === socket.id);
            if (player?.role === '狼人' && player.isAlive) {
                room.nightAction.wolfVotes[socket.id] = targetId;
                // 當有人改變目標，取消該房間所有狼人的鎖定狀態
                room.nightAction.wolfConfirmations = {}; 
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
                const confirms = aliveWolves.filter(w => room.nightAction.wolfConfirmations[w.id]);
                
                // 如果所有活著的狼人都確認了同一個目標
                const currentVotes = aliveWolves.map(w => room.nightAction.wolfVotes[w.id]);
                const uniqueVotes = [...new Set(currentVotes)];

                if (confirms.length === aliveWolves.length && uniqueVotes.length === 1) {
                    room.nightAction.finalKilledId = uniqueVotes[0];
                    // 所有人確認後可提前結束此階段
                    clearTimeout(roomTimers[socket.roomId]);
                    nextPhaseFromWolf(socket.roomId);
                }
                syncWolfUI(room);
            }
        }
    });

    // --- 流程控制核心 ---
    function triggerNight(roomId) {
        const room = rooms[roomId];
        if (!room) return;
        room.nightAction = { wolfVotes: {}, wolfConfirmations: {}, finalKilledId: null, savedId: null, poisonedId: null };
        
        startNightPhase(roomId, 'night_wolf', "🌙 狼人請殺人...", 60, () => nextPhaseFromWolf(roomId));
    }

    function nextPhaseFromWolf(roomId) {
        const room = rooms[roomId];
        const witch = room.players.find(p => p.role === '女巫' && p.isAlive);
        if (witch) {
            const victim = room.players.find(p => p.id === room.nightAction.finalKilledId);
            io.to(witch.id).emit('witchTarget', { name: victim ? victim.name : "無人死亡" });
        }
        startNightPhase(roomId, 'night_witch', "🧪 女巫請行動...", 20, () => {
            startNightPhase(roomId, 'night_seer', "🔮 預言家請驗人...", 20, () => { settleNight(roomId); });
        });
    }

    function settleNight(roomId) {
        const room = rooms[roomId];
        if (!room) return;
        let deadIds = [];
        const { finalKilledId, savedId, poisonedId } = room.nightAction;
        
        if (finalKilledId && finalKilledId !== savedId) deadIds.push(finalKilledId);
        if (poisonedId) deadIds.push(poisonedId);
        
        deadIds = [...new Set(deadIds)];
        room.players.forEach(p => { if (deadIds.includes(p.id)) p.isAlive = false; });
        
        const deadNames = room.players.filter(p => deadIds.includes(p.id)).map(p => p.name);
        io.to(roomId).emit('receiveMessage', { name: "系統", text: `🌅 天亮了！${deadNames.length > 0 ? "昨晚死者：" + deadNames.join(', ') : "昨晚是平安夜。"}` });
        
        if (!checkGameOver(roomId)) startDay(roomId);
    }

    // --- 計時器與同步 ---
    function startTimer(roomId, time, callback) {
        if (roomTimers[roomId]) clearInterval(roomTimers[roomId]);
        let timeLeft = time;
        io.to(roomId).emit('timerUpdate', timeLeft);
        
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
            players: room.players.map(p => ({ id: p.id, name: p.name, isAlive: p.isAlive, isHost: p.isHost })), 
            status: room.status,
            nightAction: { witchHasSave: room.witchHasSave, witchHasPoison: room.witchHasPoison }
        });
    }

    function syncWolfUI(room) {
        const aliveWolves = room.players.filter(p => p.role === '狼人' && p.isAlive);
        const data = aliveWolves.map(w => ({
            id: w.id,
            targetId: room.nightAction.wolfVotes[w.id] || null,
            isConfirmed: !!room.nightAction.wolfConfirmations[w.id]
        }));
        aliveWolves.forEach(w => io.to(w.id).emit('updateWolfUI', data));
    }

    function checkGameOver(roomId) {
        const room = rooms[roomId];
        const alives = room.players.filter(p => p.isAlive);
        const wolves = alives.filter(p => p.role === '狼人');
        const humans = alives.filter(p => p.role !== '狼人');

        if (wolves.length === 0) {
            io.to(roomId).emit('gameOver', { winner: "🎉 好人陣營勝利！" });
            resetRoom(roomId);
            return true;
        } else if (wolves.length >= humans.length) {
            io.to(roomId).emit('gameOver', { winner: "🐺 狼人陣營勝利！" });
            resetRoom(roomId);
            return true;
        }
        return false;
    }

    function resetRoom(roomId) {
        const room = rooms[roomId];
        if (room) {
            room.status = 'waiting';
            room.players.forEach(p => { p.role = null; p.isAlive = true; });
            broadcastUpdate(roomId);
        }
    }

    socket.on('disconnect', () => {
        const room = rooms[socket.roomId];
        if (room) {
            room.players = room.players.filter(p => p.id !== socket.id);
            if (room.players.length === 0) {
                clearInterval(roomTimers[socket.roomId]);
                delete rooms[socket.roomId];
            } else {
                if (socket.id === room.hostId) {
                    room.hostId = room.players[0].id;
                    room.players[0].isHost = true;
                }
                broadcastUpdate(socket.roomId);
            }
        }
    });
});

server.listen(process.env.PORT || 3000, () => {
    console.log('Server is running...');
});
