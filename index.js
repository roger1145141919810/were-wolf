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
    // --- 進入房間與機器人邏輯保持不變 ---
    socket.on('joinRoom', ({ roomId, username }) => {
        if (!rooms[roomId]) {
            rooms[roomId] = { 
                hostId: socket.id, players: [], status: 'waiting', 
                votes: {}, skipVotes: new Set(), witchHasSave: true, witchHasPoison: true,
                nightAction: { wolfVotes: {}, wolfConfirmations: {}, finalKilledId: null, savedId: null, poisonedId: null }
            };
        }
        const room = rooms[roomId];
        if (room.status !== 'waiting') return socket.emit('errorMessage', '❌ 遊戲進行中');
        socket.join(roomId);
        socket.roomId = roomId;
        socket.username = username;
        const player = { id: socket.id, name: username, role: null, isHost: room.players.length === 0, isAlive: true, isBot: false };
        if (player.isHost) room.hostId = socket.id;
        room.players.push(player);
        broadcastUpdate(roomId);
    });

    socket.on('addTestBots', () => {
        const room = rooms[socket.roomId];
        if (!room || room.status !== 'waiting') return;
        const needed = 6 - room.players.length;
        for (let i = 1; i <= needed; i++) {
            const botId = `bot_${Math.random().toString(36).substr(2, 5)}`;
            room.players.push({ id: botId, name: `機器人${i}號`, role: null, isHost: false, isAlive: true, isBot: true });
        }
        broadcastUpdate(socket.roomId);
    });

    // --- 核心修復：狼人頻道通訊 ---
    socket.on('sendWolfMessage', (d) => {
        const room = rooms[socket.roomId];
        if (!room) return;
        // 只發送給房間內身分是狼人的玩家
        room.players.forEach(p => {
            if (p.role === '狼人' && !p.isBot) {
                io.to(p.id).emit('receiveWolfMessage', d);
            }
        });
    });

    // --- 核心修復：預言家技能 ---
    socket.on('checkRole', (targetId) => {
        const room = rooms[socket.roomId];
        const me = room?.players.find(p => p.id === socket.id);
        if (room?.status === 'night_seer' && me?.role === '預言家' && me?.isAlive) {
            const target = room.players.find(p => p.id === targetId);
            const result = target ? (target.role === '狼人' ? '🐺 壞人' : '🕯️ 好人') : '無效目標';
            socket.emit('checkResult', `查驗結果：${target.name} 是 ${result}`);
        }
    });

    // --- 核心修復：女巫技能（僅能救死人） ---
    socket.on('witchAction', ({ type, targetId }) => {
        const room = rooms[socket.roomId];
        const me = room?.players.find(p => p.id === socket.id);
        if (room?.status === 'night_witch' && me?.role === '女巫' && me?.isAlive) {
            if (type === 'save') {
                // 檢查是否還有解藥，且目標是否為今晚被殺的人
                if (room.witchHasSave && targetId === room.nightAction.finalKilledId) {
                    room.nightAction.savedId = targetId;
                    room.witchHasSave = false;
                    socket.emit('errorMessage', '✅ 已使用解藥');
                } else {
                    socket.emit('errorMessage', '❌ 無法救此人（解藥已用完或對象非死者）');
                }
            } else if (type === 'poison') {
                if (room.witchHasPoison) {
                    room.nightAction.poisonedId = targetId;
                    room.witchHasPoison = false;
                    socket.emit('errorMessage', '✅ 已使用毒藥');
                } else {
                    socket.emit('errorMessage', '❌ 毒藥已用完');
                }
            }
            broadcastUpdate(socket.roomId);
        }
    });

    // --- 核心修正：白天發言時間調整為 10 分鐘 ---
    function settleNight(roomId) {
        const room = rooms[roomId];
        if (!room) return;
        let deadIds = [];
        if (room.nightAction.finalKilledId && room.nightAction.finalKilledId !== room.nightAction.savedId) deadIds.push(room.nightAction.finalKilledId);
        if (room.nightAction.poisonedId) deadIds.push(room.nightAction.poisonedId);
        
        deadIds = [...new Set(deadIds)];
        room.players.forEach(p => { if (deadIds.includes(p.id)) p.isAlive = false; });
        
        const names = room.players.filter(p => deadIds.includes(p.id)).map(p => p.name).join(', ');
        io.to(roomId).emit('receiveMessage', { name: "系統", text: `🌅 天亮了，死者：${names || '平安夜'}` });

        if (!checkGameOver(roomId)) {
            room.status = 'day';
            room.skipVotes = new Set();
            broadcastUpdate(roomId);
            
            // 白天發言時間改為 600 秒 (10 分鐘)
            startTimer(roomId, 600, () => startVoting(roomId));
            setTimeout(() => handleBotActions(roomId, 'day'), 5000);
        }
    }

    // --- 狼人與投票邏輯 ---
    socket.on('wolfKill', (targetId) => {
        const room = rooms[socket.roomId];
        if (room?.status === 'night_wolf') {
            room.nightAction.wolfVotes[socket.id] = targetId;
            delete room.nightAction.wolfConfirmations[socket.id]; 
            syncWolfUI(room);
        }
    });

    socket.on('wolfConfirm', () => {
        const room = rooms[socket.roomId];
        if (room?.status === 'night_wolf') {
            room.nightAction.wolfConfirmations[socket.id] = true;
            const aliveWolves = room.players.filter(p => p.role === '狼人' && p.isAlive);
            const myTarget = room.nightAction.wolfVotes[socket.id];
            aliveWolves.forEach(w => {
                if (w.isBot) {
                    room.nightAction.wolfVotes[w.id] = myTarget;
                    room.nightAction.wolfConfirmations[w.id] = true;
                }
            });
            checkWolfConsensus(socket.roomId);
        }
    });

    function triggerNight(roomId) {
        const room = rooms[roomId];
        if (!room) return;
        room.status = 'night_wolf';
        room.nightAction = { wolfVotes: {}, wolfConfirmations: {}, finalKilledId: null, savedId: null, poisonedId: null };
        broadcastUpdate(roomId);
        setTimeout(() => handleBotActions(roomId, 'night_wolf'), 5000);
        startTimer(roomId, 40, () => triggerWitchPhase(roomId));
    }

    function triggerWitchPhase(roomId) {
        const room = rooms[roomId];
        if (!room) return;
        room.status = 'night_witch';
        const witch = room.players.find(p => p.role === '女巫' && p.isAlive);
        if (witch && !witch.isBot) {
            const killedName = room.players.find(p => p.id === room.nightAction.finalKilledId)?.name || "無人死亡";
            io.to(witch.id).emit('witchTarget', { name: killedName });
        }
        broadcastUpdate(roomId);
        setTimeout(() => handleBotActions(roomId, 'night_witch'), 3000);
        startTimer(roomId, 20, () => {
            room.status = 'night_seer';
            broadcastUpdate(roomId);
            startTimer(roomId, 20, () => settleNight(roomId));
        });
    }

    // --- 其餘輔助函數 (startGame, startVoting, settleVote, startTimer, broadcastUpdate, checkGameOver 等) 保持與之前一致 ---
    socket.on('startGame', () => {
        const room = rooms[socket.roomId];
        if (!room || room.players.length < 6) return socket.emit('errorMessage', '人數不足 6 人');
        room.witchHasSave = true; room.witchHasPoison = true;
        const roles = ['狼人', '狼人', '預言家', '女巫', '村民', '村民'].sort(() => Math.random() - 0.5);
        room.players.forEach((p, i) => { p.isAlive = true; p.role = roles[i]; if (!p.isBot) io.to(p.id).emit('assignRole', p.role); });
        triggerNight(socket.roomId);
    });

    socket.on('castVote', (targetId) => {
        const room = rooms[socket.roomId];
        if (room?.status === 'voting') {
            room.votes[socket.id] = targetId;
            const aliveCount = room.players.filter(p => p.isAlive).length;
            if (Object.keys(room.votes).length >= aliveCount) settleVote(socket.roomId);
        }
    });

    socket.on('castSkipVote', () => {
        const room = rooms[socket.roomId];
        if (room?.status === 'day') {
            room.skipVotes.add(socket.id);
            const aliveCount = room.players.filter(p => p.isAlive).length;
            const required = Math.max(1, aliveCount - 1);
            io.to(socket.roomId).emit('receiveMessage', { name: "系統", text: `⏩ 跳過進度: ${room.skipVotes.size}/${required}` });
            if (room.skipVotes.size >= required) startVoting(socket.roomId);
        }
    });

    function startVoting(roomId) {
        const room = rooms[roomId];
        if(!room || room.status === 'voting') return;
        room.status = 'voting';
        room.votes = {};
        broadcastUpdate(roomId);
        setTimeout(() => handleBotActions(roomId, 'voting'), 10000);
        startTimer(roomId, 30, () => settleVote(roomId));
    }

    function settleVote(roomId) {
        const room = rooms[roomId];
        if (!room || room.status !== 'voting') return;
        const tally = {};
        Object.values(room.votes).forEach(id => { if (id) tally[id] = (tally[id] || 0) + 1; });
        let maxVotes = 0, expelledId = null;
        for (const [id, count] of Object.entries(tally)) { if (count > maxVotes) { maxVotes = count; expelledId = id; } }
        if (expelledId) {
            const p = room.players.find(p => p.id === expelledId);
            if (p) { p.isAlive = false; io.to(roomId).emit('receiveMessage', { name: "系統", text: `🗳️ 投票結果：${p.name} 被放逐了。` }); }
        }
        if (!checkGameOver(roomId)) triggerNight(roomId);
    }

    function startTimer(roomId, time, cb) {
        if (roomTimers[roomId]) clearInterval(roomTimers[roomId]);
        let t = time;
        roomTimers[roomId] = setInterval(() => {
            io.to(roomId).emit('timerUpdate', t);
            if (t <= 0) { clearInterval(roomTimers[roomId]); cb(); }
            t--;
        }, 1000);
    }

    function handleBotActions(roomId, phase) {
        const room = rooms[roomId];
        if (!room) return;
        const aliveBots = room.players.filter(p => p.isBot && p.isAlive);
        const alivePlayers = room.players.filter(p => p.isAlive);
        aliveBots.forEach(bot => {
            if (phase === 'night_wolf' && bot.role === '狼人') {
                const target = alivePlayers[Math.floor(Math.random() * alivePlayers.length)];
                room.nightAction.wolfVotes[bot.id] = target.id; room.nightAction.wolfConfirmations[bot.id] = true;
            }
            if (phase === 'night_witch' && bot.role === '女巫') {
                if (room.witchHasSave && room.nightAction.finalKilledId) { room.nightAction.savedId = room.nightAction.finalKilledId; room.witchHasSave = false; }
            }
            if (phase === 'day' && room.status === 'day') room.skipVotes.add(bot.id);
            if (phase === 'voting' && !room.votes[bot.id]) {
                const target = alivePlayers[Math.floor(Math.random() * alivePlayers.length)];
                room.votes[bot.id] = target.id;
            }
        });
        if (phase === 'night_wolf') { syncWolfUI(room); checkWolfConsensus(roomId); }
        else if (phase === 'day') {
            const required = Math.max(1, room.players.filter(p => p.isAlive).length - 1);
            if (room.skipVotes.size >= required) startVoting(roomId);
        } else if (phase === 'voting') {
            const aliveCount = room.players.filter(p => p.isAlive).length;
            if (Object.keys(room.votes).length >= aliveCount) settleVote(roomId);
        }
    }

    function checkWolfConsensus(roomId) {
        const room = rooms[roomId];
        const aliveWolves = room.players.filter(p => p.role === '狼人' && p.isAlive);
        const confirms = aliveWolves.filter(w => room.nightAction.wolfConfirmations[w.id]);
        const votes = aliveWolves.map(w => room.nightAction.wolfVotes[w.id]);
        const uniqueVotes = [...new Set(votes.filter(v => v !== null))];
        if (confirms.length === aliveWolves.length && uniqueVotes.length === 1) {
            room.nightAction.finalKilledId = uniqueVotes[0]; triggerWitchPhase(roomId);
        }
    }

    function broadcastUpdate(roomId) {
        const r = rooms[roomId];
        if (!r) return;
        io.to(roomId).emit('updatePlayers', { players: r.players, status: r.status, witchPotions: { hasSave: r.witchHasSave, hasPoison: r.witchHasPoison } });
    }

    function syncWolfUI(room) {
        const aliveWolves = room.players.filter(p => p.role === '狼人' && p.isAlive);
        const data = aliveWolves.map(w => ({ id: w.id, targetId: room.nightAction.wolfVotes[w.id] || null, isConfirmed: !!room.nightAction.wolfConfirmations[w.id] }));
        aliveWolves.forEach(w => { if (!w.isBot) io.to(w.id).emit('updateWolfUI', data); });
    }

    function checkGameOver(roomId) {
        const room = rooms[roomId];
        const alives = room.players.filter(p => p.isAlive);
        const w = alives.filter(p => p.role === '狼人').length;
        if (w === 0) { io.to(roomId).emit('gameOver', { winner: "🎉 好人陣營" }); return true; }
        if (w >= (alives.length - w)) { io.to(roomId).emit('gameOver', { winner: "🐺 狼人陣營" }); return true; }
        return false;
    }

    socket.on('sendMessage', (d) => io.to(socket.roomId).emit('receiveMessage', d));
    socket.on('disconnect', () => {
        const room = rooms[socket.roomId];
        if (room) {
            room.players = room.players.filter(p => p.id !== socket.id);
            if (room.players.length === 0) { clearInterval(roomTimers[socket.roomId]); delete rooms[socket.roomId]; }
            else { if (socket.id === room.hostId) { room.hostId = room.players[0].id; room.players[0].isHost = true; } broadcastUpdate(socket.roomId); }
        }
    });
});

server.listen(process.env.PORT || 3000, () => console.log('Server running...'));
