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

// ── 預設角色配置 ──
const DEFAULT_ROLES = {
    6:  { wolf:2, seer:1, witch:1, hunter:0, idiot:0, guard:0, villager:2 },
    7:  { wolf:2, seer:1, witch:1, hunter:1, idiot:0, guard:0, villager:2 },
    8:  { wolf:2, seer:1, witch:1, hunter:1, idiot:0, guard:0, villager:3 },
    9:  { wolf:3, seer:1, witch:1, hunter:1, idiot:0, guard:0, villager:3 },
    10: { wolf:3, seer:1, witch:1, hunter:1, idiot:1, guard:0, villager:3 },
    11: { wolf:3, seer:1, witch:1, hunter:1, idiot:1, guard:1, villager:3 },
    12: { wolf:4, seer:1, witch:1, hunter:1, idiot:1, guard:1, villager:3 },
};

function buildRoleArray(cfg) {
    const arr = [];
    for (let i = 0; i < cfg.wolf;    i++) arr.push('狼人');
    for (let i = 0; i < cfg.seer;    i++) arr.push('預言家');
    for (let i = 0; i < cfg.witch;   i++) arr.push('女巫');
    for (let i = 0; i < cfg.hunter;  i++) arr.push('獵人');
    for (let i = 0; i < cfg.idiot;   i++) arr.push('白癡');
    for (let i = 0; i < cfg.guard;   i++) arr.push('守衛');
    for (let i = 0; i < cfg.villager;i++) arr.push('村民');
    return arr;
}

io.on('connection', (socket) => {

    socket.on('joinRoom', ({ roomId, username }) => {
        if (!rooms[roomId]) {
            const count = 6;
            rooms[roomId] = {
                hostId: socket.id, players: [], status: 'waiting',
                votes: {}, skipVotes: new Set(),
                witchHasSave: true, witchHasPoison: false, // poison starts locked
                roleConfig: { ...DEFAULT_ROLES[count] },
                nightAction: { wolfVotes:{}, wolfConfirmations:{}, finalKilledId:null, savedId:null, poisonedId:null, guardTargetId:null, seerChecked:false }
            };
        }
        const room = rooms[roomId];
        if (room.status !== 'waiting') return socket.emit('errorMessage', '❌ 遊戲進行中');
        socket.join(roomId);
        socket.roomId = roomId;
        socket.username = username;
        const player = { id:socket.id, name:username, role:null, isHost:room.players.length===0, isAlive:true, isBot:false, isIdiotRevealed:false };
        if (player.isHost) room.hostId = socket.id;
        room.players.push(player);
        broadcastUpdate(roomId);
    });

    socket.on('addTestBots', () => {
        const room = rooms[socket.roomId];
        if (!room || room.status !== 'waiting') return;
        const total = Object.values(room.roleConfig).reduce((a,b)=>a+b,0);
        const needed = total - room.players.length;
        if (needed <= 0) return;
        for (let i = 1; i <= needed; i++) {
            const botId = `bot_${Math.random().toString(36).substr(2,5)}`;
            room.players.push({ id:botId, name:`機器人${i}號`, role:null, isHost:false, isAlive:true, isBot:true, isIdiotRevealed:false });
        }
        broadcastUpdate(socket.roomId);
    });

    // ── 房主設定角色數量 ──
    socket.on('setRoleConfig', (cfg) => {
        const room = rooms[socket.roomId];
        const me = room?.players.find(p => p.id === socket.id);
        if (!room || room.status !== 'waiting' || !me?.isHost) return;
        const total = Object.values(cfg).reduce((a,b)=>a+b, 0);
        if (total < 6 || total > 12) return socket.emit('errorMessage', '❌ 總人數需介於 6-12 人');
        if (cfg.wolf < 1) return socket.emit('errorMessage', '❌ 至少要 1 名狼人');
        room.roleConfig = cfg;
        // 若機器人超過需要，移除多餘的
        const bots = room.players.filter(p => p.isBot);
        const realPlayers = room.players.filter(p => !p.isBot);
        const botsNeeded = Math.max(0, total - realPlayers.length);
        room.players = [...realPlayers, ...bots.slice(0, botsNeeded)];
        broadcastUpdate(socket.roomId);
        socket.emit('roleConfigUpdated', room.roleConfig);
    });

    socket.on('kickPlayer', (targetId) => {
        const room = rooms[socket.roomId];
        const me = room?.players.find(p => p.id === socket.id);
        if (room?.status === 'waiting' && me?.isHost && socket.id !== targetId) {
            io.to(targetId).emit('kicked');
            room.players = room.players.filter(p => p.id !== targetId);
            const targetSocket = io.sockets.sockets.get(targetId);
            if (targetSocket) targetSocket.leave(socket.roomId);
            broadcastUpdate(socket.roomId);
        }
    });

    socket.on('sendWolfMessage', (d) => {
        const room = rooms[socket.roomId];
        if (!room) return;
        room.players.forEach(p => { if (p.role === '狼人' && !p.isBot) io.to(p.id).emit('receiveWolfMessage', d); });
    });

    socket.on('checkRole', (targetId) => {
        const room = rooms[socket.roomId];
        const me = room?.players.find(p => p.id === socket.id);
        if (room?.status === 'night_seer' && me?.role === '預言家' && me?.isAlive) {
            if (room.nightAction.seerChecked) return socket.emit('errorMessage', '❌ 你今晚已經驗過人了');
            const target = room.players.find(p => p.id === targetId);
            if (target) {
                const result = target.role === '狼人' ? '🐺 壞人' : '🕯️ 好人';
                socket.emit('checkResult', `查驗結果：${target.name} 是 ${result}`);
                room.nightAction.seerChecked = true;
                broadcastUpdate(socket.roomId);
            }
        }
    });

    socket.on('witchAction', ({ type, targetId }) => {
        const room = rooms[socket.roomId];
        const me = room?.players.find(p => p.id === socket.id);
        if (room?.status !== 'night_witch' || me?.role !== '女巫' || !me?.isAlive) return;

        // ── Bug 修復：鎖定防止重複操作 ──
        if (room.nightAction.witchActing) return socket.emit('errorMessage', '❌ 請稍候...');
        room.nightAction.witchActing = true;

        if (type === 'save') {
            if (!room.witchHasSave) { room.nightAction.witchActing = false; return socket.emit('errorMessage', '❌ 你已經沒有解藥了'); }
            if (targetId !== room.nightAction.finalKilledId) { room.nightAction.witchActing = false; return socket.emit('errorMessage', '❌ 此人今晚並未倒下'); }
            room.nightAction.savedId = targetId;
            room.witchHasSave = false;
            socket.emit('errorMessage', '✅ 你已成功救回此人');
        } else if (type === 'poison') {
            if (!room.witchHasPoison) { room.nightAction.witchActing = false; return socket.emit('errorMessage', '❌ 毒藥已用完'); }
            if (room.nightAction.savedId) { room.nightAction.witchActing = false; return socket.emit('errorMessage', '❌ 同一個晚上不能同時使用兩瓶藥'); }
            room.nightAction.poisonedId = targetId;
            room.witchHasPoison = false;
            socket.emit('errorMessage', '✅ 已投毒');
        }

        // 解鎖（短暫 delay 防止極快連點）
        setTimeout(() => { room.nightAction.witchActing = false; }, 500);
        broadcastUpdate(socket.roomId);
    });

    // ── 守衛保護 ──
    socket.on('guardProtect', (targetId) => {
        const room = rooms[socket.roomId];
        const me = room?.players.find(p => p.id === socket.id);
        if (room?.status === 'night_guard' && me?.role === '守衛' && me?.isAlive) {
            if (room.nightAction.lastGuardTargetId === targetId) {
                return socket.emit('errorMessage', '❌ 不能連續兩晚守護同一人');
            }
            room.nightAction.guardTargetId = targetId;
            socket.emit('errorMessage', '✅ 守護成功');
            broadcastUpdate(socket.roomId);
        }
    });

    // ── 獵人射擊 ──
    socket.on('hunterShoot', (targetId) => {
        const room = rooms[socket.roomId];
        const me = room?.players.find(p => p.id === socket.id);
        if (room?.status === 'hunter_shooting' && me?.role === '獵人' && !me?.isAlive) {
            const target = room.players.find(p => p.id === targetId && p.isAlive);
            if (target) {
                target.isAlive = false;
                io.to(socket.roomId).emit('receiveMessage', { name:'系統', text:`🏹 獵人 ${me.name} 帶走了 ${target.name}` });
                room.nightAction.hunterTarget = targetId;
            }
            room.status = room.nightAction.hunterContext || 'day';
            room.nightAction.hunterContext = null;
            broadcastUpdate(socket.roomId);
            if (!checkGameOver(socket.roomId)) {
                if (room.status === 'day') startTimer(socket.roomId, 600, () => startVoting(socket.roomId));
                else triggerNight(socket.roomId);
            }
        }
    });

    socket.on('wolfKill', (targetId) => {
        const room = rooms[socket.roomId];
        const me = room?.players.find(p => p.id === socket.id);
        const target = room?.players.find(p => p.id === targetId);
        // ── 狼人可以自刀：移除 target?.role !== '狼人' 的限制 ──
        if (room?.status === 'night_wolf' && me?.role === '狼人' && me?.isAlive && target?.isAlive) {
            room.nightAction.wolfVotes[socket.id] = targetId;
            delete room.nightAction.wolfConfirmations[socket.id];
            syncWolfUI(room);
        }
    });

    socket.on('wolfConfirm', () => {
        const room = rooms[socket.roomId];
        const me = room?.players.find(p => p.id === socket.id);
        if (room?.status === 'night_wolf' && me?.role === '狼人' && me?.isAlive) {
            room.nightAction.wolfConfirmations[socket.id] = true;
            const myTarget = room.nightAction.wolfVotes[socket.id];
            if (myTarget) {
                room.players.filter(p => p.role === '狼人' && p.isAlive && p.isBot).forEach(bot => {
                    room.nightAction.wolfVotes[bot.id] = myTarget;
                    room.nightAction.wolfConfirmations[bot.id] = true;
                });
            }
            syncWolfUI(room);
            checkWolfConsensus(socket.roomId);
        }
    });

    socket.on('startGame', () => {
        const room = rooms[socket.roomId];
        if (!room) return;
        const total = Object.values(room.roleConfig).reduce((a,b)=>a+b,0);
        if (room.players.length < total) return socket.emit('errorMessage', `❌ 人數不足，需要 ${total} 人`);
        
        room.status = 'night_wolf';
        room.witchHasSave = true;
        room.witchHasPoison = true;
        const roles = buildRoleArray(room.roleConfig).sort(() => Math.random() - 0.5);
        room.players.forEach((p, i) => {
            p.isAlive = true; p.role = roles[i]; p.isIdiotRevealed = false;
            if (!p.isBot) io.to(p.id).emit('assignRole', p.role);
        });
        triggerNight(socket.roomId);
    });

    socket.on('castVote', (targetId) => {
        const room = rooms[socket.roomId];
        const me = room?.players.find(p => p.id === socket.id);
        const target = room?.players.find(p => p.id === targetId);
        // 白癡被揭示後不能投票，但仍在場
        if (room?.status === 'voting' && me?.isAlive && !me?.isIdiotRevealed && target?.isAlive && !room.votes[socket.id]) {
            room.votes[socket.id] = targetId;
            io.to(socket.roomId).emit('updateVotes', room.votes);
            // 計算有投票資格的存活玩家
            const eligibleCount = room.players.filter(p => p.isAlive && !p.isIdiotRevealed).length;
            if (Object.keys(room.votes).length >= eligibleCount) settleVote(socket.roomId);
        }
    });

    socket.on('castSkipVote', () => {
        const room = rooms[socket.roomId];
        if (room?.status === 'day') {
            room.skipVotes.add(socket.id);
            const aliveCount = room.players.filter(p => p.isAlive).length;
            const required = Math.max(1, aliveCount - 1);
            io.to(socket.roomId).emit('receiveMessage', { name:'系統', text:`⏩ ${socket.username} 已準備好投票。目前進度: ${room.skipVotes.size}/${required}` });
            broadcastUpdate(socket.roomId);
            if (room.skipVotes.size >= required) startVoting(socket.roomId);
        }
    });

    // ── Timer ──
    function startTimer(roomId, time, cb) {
        if (roomTimers[roomId]) clearInterval(roomTimers[roomId]);
        let t = time;
        roomTimers[roomId] = setInterval(() => {
            io.to(roomId).emit('timerUpdate', t);
            if (t <= 0) { clearInterval(roomTimers[roomId]); delete roomTimers[roomId]; cb(); }
            t--;
        }, 1000);
    }

    // ── Night Flow ──
    function triggerNight(roomId) {
        const room = rooms[roomId];
        if (!room) return;

        // 守衛先行
        const guard = room.players.find(p => p.role === '守衛' && p.isAlive);
        if (guard) {
            room.status = 'night_guard';
            room.nightAction = {
                wolfVotes:{}, wolfConfirmations:{}, finalKilledId:null,
                savedId:null, poisonedId:null, guardTargetId:null,
                lastGuardTargetId: room.nightAction?.guardTargetId || null,
                seerChecked:false, witchActing:false
            };
            broadcastUpdate(roomId);
            if (guard.isBot) {
                // 守衛機器人隨機選一個人（不選上次的）
                const validTargets = room.players.filter(p => p.isAlive && p.id !== room.nightAction.lastGuardTargetId);
                if (validTargets.length) {
                    const t = validTargets[Math.floor(Math.random()*validTargets.length)];
                    room.nightAction.guardTargetId = t.id;
                }
                startTimer(roomId, 3, () => proceedToWolfPhase(roomId));
            } else {
                startTimer(roomId, 20, () => proceedToWolfPhase(roomId));
            }
        } else {
            room.nightAction = {
                wolfVotes:{}, wolfConfirmations:{}, finalKilledId:null,
                savedId:null, poisonedId:null, guardTargetId:null,
                lastGuardTargetId: null, seerChecked:false, witchActing:false
            };
            proceedToWolfPhase(roomId);
        }
    }

    function proceedToWolfPhase(roomId) {
        const room = rooms[roomId];
        if (!room) return;
        room.status = 'night_wolf';
        broadcastUpdate(roomId);
        setTimeout(() => handleBotActions(roomId, 'night_wolf'), 3000);
        startTimer(roomId, 40, () => triggerWitchPhase(roomId));
    }

    function triggerWitchPhase(roomId) {
        const room = rooms[roomId];
        if (!room) return;
        room.status = 'night_witch';
        const witch = room.players.find(p => p.role === '女巫' && p.isAlive);
        if (witch && !witch.isBot) {
            const killedPlayer = room.players.find(p => p.id === room.nightAction.finalKilledId);
            io.to(witch.id).emit('witchTarget', { name: killedPlayer ? killedPlayer.name : '無人死亡' });
        }
        broadcastUpdate(roomId);
        setTimeout(() => handleBotActions(roomId, 'night_witch'), 3000);
        startTimer(roomId, 20, () => {
            room.status = 'night_seer';
            broadcastUpdate(roomId);
            setTimeout(() => handleBotActions(roomId, 'night_seer'), 3000);
            startTimer(roomId, 20, () => settleNight(roomId));
        });
    }

    function settleNight(roomId) {
        const room = rooms[roomId];
        if (!room) return;
        let deadIds = [];
        const guardId = room.nightAction.guardTargetId;

        if (room.nightAction.finalKilledId &&
            room.nightAction.finalKilledId !== room.nightAction.savedId &&
            room.nightAction.finalKilledId !== guardId) {
            deadIds.push(room.nightAction.finalKilledId);
        }
        if (room.nightAction.poisonedId && room.nightAction.poisonedId !== guardId) {
            deadIds.push(room.nightAction.poisonedId);
        }
        deadIds = [...new Set(deadIds)];

        const toProcess = [];
        room.players.forEach(p => {
            if (deadIds.includes(p.id)) { p.isAlive = false; toProcess.push(p); }
        });

        const names = toProcess.map(p => p.name).join(', ');
        io.to(roomId).emit('receiveMessage', { name:'系統', text:`🌅 天亮了，死者：${names || '平安夜'}` });

        if (checkGameOver(roomId)) return;

        // 獵人死亡觸發射擊
        const deadHunter = toProcess.find(p => p.role === '獵人');
        if (deadHunter && !deadHunter.isBot) {
            room.status = 'hunter_shooting';
            room.nightAction.hunterContext = 'night_end';
            broadcastUpdate(roomId);
            io.to(deadHunter.id).emit('receiveMessage', { name:'系統', text:'🏹 你是獵人，請選擇帶走一名玩家' });
            startTimer(roomId, 15, () => {
                room.status = 'day';
                room.skipVotes = new Set();
                broadcastUpdate(roomId);
                startTimer(roomId, 600, () => startVoting(roomId));
                setTimeout(() => handleBotActions(roomId, 'day'), 5000);
            });
            return;
        }

        room.status = 'day';
        room.skipVotes = new Set();
        broadcastUpdate(roomId);
        startTimer(roomId, 600, () => startVoting(roomId));
        setTimeout(() => handleBotActions(roomId, 'day'), 5000);
    }

    function startVoting(roomId) {
        const room = rooms[roomId];
        if (!room || room.status === 'voting') return;
        if (roomTimers[roomId]) { clearInterval(roomTimers[roomId]); delete roomTimers[roomId]; }
        room.status = 'voting';
        room.votes = {};
        room.skipVotes = new Set();
        broadcastUpdate(roomId);
        io.to(roomId).emit('updateVotes', room.votes);
        setTimeout(() => handleBotActions(roomId, 'voting'), 2000);
        startTimer(roomId, 30, () => settleVote(roomId));
    }

    function settleVote(roomId) {
        const room = rooms[roomId];
        if (!room || room.status !== 'voting') return;

        const tally = {};
        Object.values(room.votes).forEach(id => { if (id) tally[id] = (tally[id]||0) + 1; });
        const aliveCount = room.players.filter(p => p.isAlive).length;
        const half = Math.floor(aliveCount / 2) + 1;
        let maxVotes = 0, expelledId = null;
        for (const [id, count] of Object.entries(tally)) {
            if (count > maxVotes) { maxVotes = count; expelledId = id; }
        }

        // 廣播最終票數
        io.to(roomId).emit('updateVotes', room.votes);

        if (expelledId && maxVotes >= half) {
            const p = room.players.find(p => p.id === expelledId);
            if (p) {
                // 白癡：被放逐時揭示身份，存活但失去投票權
                if (p.role === '白癡' && !p.isIdiotRevealed) {
                    p.isIdiotRevealed = true;
                    io.to(roomId).emit('receiveMessage', { name:'系統', text:`🃏 ${p.name} 是白癡！免死金牌觸發，留下但失去投票權。` });
                    if (!p.isBot) io.to(p.id).emit('errorMessage', '🃏 你是白癡！你被放逐了但你免死，繼續留在場上（失去投票權）');
                    broadcastUpdate(roomId);
                    if (!checkGameOver(roomId)) triggerNight(roomId);
                    return;
                }
                p.isAlive = false;
                io.to(roomId).emit('receiveMessage', { name:'系統', text:`🗳️ ${p.name} 以 ${maxVotes} 票被放逐了。` });

                // 獵人被放逐觸發射擊
                if (p.role === '獵人' && !p.isBot) {
                    room.status = 'hunter_shooting';
                    room.nightAction.hunterContext = 'voting_end';
                    broadcastUpdate(roomId);
                    io.to(p.id).emit('receiveMessage', { name:'系統', text:'🏹 你是獵人，請選擇帶走一名玩家' });
                    startTimer(roomId, 15, () => {
                        if (!checkGameOver(roomId)) triggerNight(roomId);
                    });
                    return;
                }
            }
        } else {
            io.to(roomId).emit('receiveMessage', { name:'系統', text:'🗳️ 投票未過半，無人被放逐。' });
        }

        if (!checkGameOver(roomId)) triggerNight(roomId);
    }

    function checkGameOver(roomId) {
        const room = rooms[roomId];
        if (!room) return false;
        const alives = room.players.filter(p => p.isAlive);
        const wolves = alives.filter(p => p.role === '狼人').length;
        let winner = null;
        if (wolves === 0) winner = '🎉 好人陣營';
        else if (wolves >= alives.length - wolves) winner = '🐺 狼人陣營';
        if (winner) {
            io.to(roomId).emit('gameOver', { winner });
            room.status = 'waiting';
            room.players.forEach(p => { p.isAlive = true; p.role = null; p.isIdiotRevealed = false; });
            room.votes = {}; room.skipVotes = new Set();
            room.nightAction = { wolfVotes:{}, wolfConfirmations:{}, finalKilledId:null, savedId:null, poisonedId:null, guardTargetId:null, seerChecked:false };
            if (roomTimers[roomId]) { clearInterval(roomTimers[roomId]); delete roomTimers[roomId]; }
            broadcastUpdate(roomId);
            return true;
        }
        return false;
    }

    function handleBotActions(roomId, phase) {
        const room = rooms[roomId];
        if (!room || room.status !== phase) return;
        const aliveBots = room.players.filter(p => p.isBot && p.isAlive);
        const alivePlayers = room.players.filter(p => p.isAlive);

        aliveBots.forEach(bot => {
            if (phase === 'night_wolf' && bot.role === '狼人') {
                const targets = alivePlayers; // 狼人可以自刀，不排除狼人
                if (!targets.length) return;
                const target = targets[Math.floor(Math.random() * targets.length)];
                room.nightAction.wolfVotes[bot.id] = target.id;
                room.nightAction.wolfConfirmations[bot.id] = true;
            }
            if (phase === 'night_witch' && bot.role === '女巫') {
                if (room.witchHasSave && room.nightAction.finalKilledId && !room.nightAction.savedId) {
                    room.nightAction.savedId = room.nightAction.finalKilledId;
                    room.witchHasSave = false;
                }
            }
            if (phase === 'night_seer' && bot.role === '預言家') {
                room.nightAction.seerChecked = true;
            }
            if (phase === 'day') room.skipVotes.add(bot.id);
            if (phase === 'voting' && !room.votes[bot.id]) {
                const nonWolf = alivePlayers.filter(p => p.role !== '狼人');
                const t = nonWolf.length ? nonWolf[Math.floor(Math.random()*nonWolf.length)] : alivePlayers[0];
                if (t) room.votes[bot.id] = t.id;
                io.to(roomId).emit('updateVotes', room.votes);
            }
        });

        if (phase === 'night_wolf') { syncWolfUI(room); checkWolfConsensus(roomId); }
        else if (phase === 'day') {
            const required = Math.max(1, room.players.filter(p => p.isAlive).length - 1);
            if (room.skipVotes.size >= required) startVoting(roomId);
        } else if (phase === 'voting') {
            const eligible = room.players.filter(p => p.isAlive && !p.isIdiotRevealed).length;
            if (Object.keys(room.votes).length >= eligible) settleVote(roomId);
        }
    }

    function checkWolfConsensus(roomId) {
        const room = rooms[roomId];
        if (!room || room.status !== 'night_wolf') return;
        const aliveWolves = room.players.filter(p => p.role === '狼人' && p.isAlive);
        const confirms = aliveWolves.filter(w => room.nightAction.wolfConfirmations[w.id]);
        if (confirms.length === aliveWolves.length && aliveWolves.length > 0) {
            const votes = aliveWolves.map(w => room.nightAction.wolfVotes[w.id]);
            const unique = [...new Set(votes)];
            if (unique.length === 1 && unique[0] !== null) {
                room.nightAction.finalKilledId = unique[0];
                if (roomTimers[roomId]) { clearInterval(roomTimers[roomId]); delete roomTimers[roomId]; }
                triggerWitchPhase(roomId);
            }
        }
    }

    function broadcastUpdate(roomId) {
        const r = rooms[roomId];
        if (!r) return;
        io.to(roomId).emit('updatePlayers', {
            players: r.players,
            status: r.status,
            witchPotions: { hasSave: r.witchHasSave, hasPoison: r.witchHasPoison },
            roleConfig: r.roleConfig,
            votes: r.votes,
        });
    }

    function syncWolfUI(room) {
        const aliveWolves = room.players.filter(p => p.role === '狼人' && p.isAlive);
        const data = aliveWolves.map(w => ({
            id: w.id,
            targetId: room.nightAction.wolfVotes[w.id] || null,
            isConfirmed: !!room.nightAction.wolfConfirmations[w.id]
        }));
        aliveWolves.forEach(w => { if (!w.isBot) io.to(w.id).emit('updateWolfUI', data); });
    }

    socket.on('sendMessage', (d) => io.to(socket.roomId).emit('receiveMessage', d));

    socket.on('disconnect', () => {
        const room = rooms[socket.roomId];
        if (room) {
            room.players = room.players.filter(p => p.id !== socket.id);
            const realPlayers = room.players.filter(p => !p.isBot);
            if (realPlayers.length === 0) {
                if (roomTimers[socket.roomId]) clearInterval(roomTimers[socket.roomId]);
                delete rooms[socket.roomId];
            } else {
                if (room.status === 'waiting') room.players = realPlayers;
                if (socket.id === room.hostId) {
                    room.hostId = realPlayers[0].id;
                    realPlayers[0].isHost = true;
                }
                broadcastUpdate(socket.roomId);
            }
        }
    });
});

server.listen(process.env.PORT || 3000, () => console.log('Server running...'));
