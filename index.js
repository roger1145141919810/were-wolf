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

    // --- 狼人行為 ---
    socket.on('wolfKill', (targetId) => {
        const room = rooms[socket.roomId];
        if (room?.status === 'night_wolf') {
            const player = room.players.find(p => p.id === socket.id);
            if (player?.role === '狼人' && player.isAlive) {
                room.nightAction.wolfVotes[socket.id] = targetId;
                delete room.nightAction.wolfConfirmations[socket.id]; 
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

                if (aliveWolves.length === 1 || (uniqueVotes.length === 1 && uniqueVotes[0] && confirms.every(c => c === true))) {
                    room.nightAction.finalKilledId = uniqueVotes[0];
                }
                syncWolfUI(room);
            }
        }
    });

    // --- 其他角色行為 ---
    socket.on('witchAction', ({ type, targetId }) => {
        const room = rooms[socket.roomId];
        if (room?.status === 'night_witch') {
            const player = room.players.find(p => p.id === socket.id);
            if (player?.role === '女巫' && player.isAlive) {
                if (type === 'save' && room.witchHasSave) {
                    room.nightAction.savedId = targetId;
                    room.witchHasSave = false;
                } else if (type === 'poison' && room.witchHasPoison) {
                    room.nightAction.poisonedId = targetId;
                    room.witchHasPoison = false;
                }
                broadcastUpdate(socket.roomId);
            }
        }
    });

    socket.on('checkRole', (targetId) => {
        const room = rooms[socket.roomId];
        if (room?.status === 'night_seer') {
            const player = room.players.find(p => p.id === socket.id);
            if (player?.role === '預言家' && player.isAlive) {
                const target = room.players.find(p => p.id === targetId);
                const side = target?.role === '狼人' ? '🔴 壞人' : '🔵 好人';
                socket.emit('checkResult', `查驗結果：${target.name} 是 ${side}`);
            }
        }
    });

    // --- 流程控制 ---
    function triggerNight(roomId) {
        const room = rooms[roomId];
        if (!room) return;
        room.nightAction = { wolfVotes: {}, wolfConfirmations: {}, finalKilledId: null, savedId: null, poisonedId: null };

        startNightPhase(roomId, 'night_wolf', "🌙 狼人請殺人 (1:00)...", 60, () => {
            // 狼人結束後，通知女巫死者
            const witch = room.players.find(p => p.role === '女巫' && p.isAlive);
            if (witch) {
                const victim = room.players.find(p => p.id === room.nightAction.finalKilledId);
                io.to(witch.id).emit('witchTarget', { name: victim ? victim.name : "無人死亡" });
            }

            startNightPhase(roomId, 'night_witch', "🧪 女巫請行動...", 15, () => {
                startNightPhase(roomId, 'night_seer', "🔮 預言家請驗人...", 15, () => {
                    settleNight(roomId);
                });
            });
        });
    }

    function startNightPhase(roomId, phase, msg, time, callback) {
        const room = rooms[roomId];
        if (!room) return;
        room.status = phase;
        broadcastUpdate(roomId);
        io.to(roomId).emit('receiveMessage', { name: "系統", text: msg, isSystem: true });
        startTimer(roomId, time, callback);
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
        io.to(roomId).emit('receiveMessage', { 
            name: "系統", 
            text: `🌅 天亮了！${deadNames.length > 0 ? "昨晚死的是：" + deadNames.join(', ') : "昨晚是平安夜。"}`,
            isSystem: true 
        });

        if (!checkGameOver(roomId)) startDay(roomId);
    }

    // --- 白天與投票 ---
    function startDay(roomId) {
        const room = rooms[roomId];
        room.status = 'day';
        room.skipVotes = new Set();
        broadcastUpdate(roomId);
        startTimer(roomId, 600, () => startVoting(roomId));
    }

    socket.on('castSkipVote', () => {
        const room = rooms[socket.roomId];
        if (room?.status === 'day') {
            room.skipVotes.add(socket.id);
            const aliveCount = room.players.filter(p => p.isAlive).length;
            const required = aliveCount - 1;
            io.to(socket.roomId).emit('receiveMessage', { name: "系統", text: `⏩ 跳過投票進度: ${room.skipVotes.size}/${required}` });
            if (room.skipVotes.size >= required) startVoting(socket.roomId);
        }
    });

    function startVoting(roomId) {
        const room = rooms[roomId];
        if (!room) return;
        room.status = 'voting';
        room.votes = {};
        broadcastUpdate(roomId);
        io.to(roomId).emit('receiveMessage', { name: "系統", text: "🗳️ 開始投票 (25s)..." });
        startTimer(roomId, 25, () => settleVote(roomId));
    }

    socket.on('castVote', (targetId) => {
        const room = rooms[socket.roomId];
        if (room?.status === 'voting') {
            room.votes[socket.id] = targetId;
            const aliveCount = room.players.filter(p => p.isAlive).length;
            if (Object.keys(room.votes).length >= aliveCount) settleVote(socket.roomId);
        }
    });

    function settleVote(roomId) {
        const room = rooms[roomId];
        if (!room || room.status !== 'voting') return;
        clearInterval(roomTimers[roomId]);
        
        const tally = {};
        Object.values(room.votes).forEach(id => { if (id) tally[id] = (tally[id] || 0) + 1; });
        
        const alivePlayers = room.players.filter(p => p.isAlive);
        let expelled = null;
        for (const [id, count] of Object.entries(tally)) {
            if (count > alivePlayers.length / 2) {
                expelled = room.players.find(p => p.id === id);
                break;
            }
        }

        if (expelled) {
            expelled.isAlive = false;
            io.to(roomId).emit('receiveMessage', { name: "系統", text: `📢 ${expelled.name} 被處決了。` });
        } else {
            io.to(roomId).emit('receiveMessage', { name: "系統", text: "📢 投票未過半，無人處決。" });
        }

        if (!checkGameOver(roomId)) triggerNight(roomId);
    }

    // --- 基礎工具 ---
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

    function syncWolfUI(room) {
        const aliveWolves = room.players.filter(p => p.role === '狼人' && p.isAlive);
        const data = aliveWolves.map(w => ({
            id: w.id,
            targetId: room.nightAction.wolfVotes[w.id] || null,
            isConfirmed: !!room.nightAction.wolfConfirmations[w.id]
        }));
        aliveWolves.forEach(w => io.to(w.id).emit('updateWolfUI', data));
    }

    function broadcastUpdate(roomId) {
        const room = rooms[roomId];
        if (!room) return;
        io.to(roomId).emit('updatePlayers', { 
            players: room.players, 
            status: room.status,
            nightAction: {
                witchHasSave: room.witchHasSave,
                witchHasPoison: room.witchHasPoison
            }
        });
    }

    socket.on('startGame', () => {
        const room = rooms[socket.roomId];
        if (!room || room.players.length < 6) return;
        room.witchHasSave = true;
        room.witchHasPoison = true;
        const roles = ['狼人', '狼人', '預言家', '女巫', '村民', '村民'].sort(() => Math.random() - 0.5);
        room.players.forEach((p, i) => {
            p.isAlive = true;
            p.role = roles[i];
            io.to(p.id).emit('assignRole', p.role);
        });
        triggerNight(socket.roomId);
    });

    function checkGameOver(roomId) {
        const room = rooms[roomId];
        const alives = room.players.filter(p => p.isAlive);
        const wolves = alives.filter(p => p.role === '狼人');
        const humans = alives.filter(p => p.role !== '狼人');
        
        if (wolves.length === 0) {
            io.to(roomId).emit('gameOver', { winner: "🎉 好人陣營" });
            room.status = 'waiting';
            return true;
        }
        if (wolves.length >= humans.length) {
            io.to(roomId).emit('gameOver', { winner: "🐺 狼人陣營" });
            room.status = 'waiting';
            return true;
        }
        return false;
    }

    socket.on('disconnect', () => {
        const room = rooms[socket.roomId];
        if (room) {
            room.players = room.players.filter(p => p.id !== socket.id);
            if (room.players.length === 0) delete rooms[socket.roomId];
            else broadcastUpdate(socket.roomId);
        }
    });
});

server.listen(process.env.PORT || 3000);
