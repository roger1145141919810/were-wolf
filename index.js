// ... 前方代碼保持不變 (joinRoom, kickPlayer, transferHost, startGame) ...

    // 【白天計時器啟動】 修正：時間到自動進入黑夜
    socket.on('startDayTimer', () => {
        const roomId = socket.roomId;
        const room = rooms[roomId];
        if (!room || socket.id !== room.hostId) return;

        room.status = 'day';
        room.skipVotes = new Set();
        if (roomTimers[roomId]) clearInterval(roomTimers[roomId]);

        let timeLeft = 300; 
        io.to(roomId).emit('timerUpdate', timeLeft);

        roomTimers[roomId] = setInterval(() => {
            timeLeft--;
            io.to(roomId).emit('timerUpdate', timeLeft);
            if (timeLeft <= 0) {
                clearInterval(roomTimers[roomId]);
                // 時間到自動觸發黑夜切換邏輯
                triggerNight(roomId);
            }
        }, 1000);
    });

    // 【跳過白天投票】 修正：優化切換邏輯
    socket.on('castSkipVote', () => {
        const roomId = socket.roomId;
        const room = rooms[roomId];
        if (!room || room.status !== 'day') return;

        room.skipVotes.add(socket.id);
        const aliveCount = room.players.filter(p => p.isAlive).length;
        const required = Math.max(1, aliveCount - 1); 

        io.to(roomId).emit('receiveMessage', { 
            name: "系統", 
            text: `⏭️ ${socket.username} 投票跳過 (${room.skipVotes.size}/${required})`, 
            isSystem: true 
        });

        if (room.skipVotes.size >= required) {
            if (roomTimers[roomId]) clearInterval(roomTimers[roomId]);
            triggerNight(roomId);
        }
    });

    // 【新增核心函數：切換黑夜】
    function triggerNight(roomId) {
        const room = rooms[roomId];
        if (!room) return;

        room.status = 'playing';
        io.to(roomId).emit('receiveMessage', { name: "系統", text: "🌙 天黑請閉眼，進入黑夜階段...", isSystem: true });
        
        // 更新玩家列表狀態，確保前端隱藏白天UI
        io.to(roomId).emit('updatePlayers', { players: room.players, status: room.status });

        // 重新發送身分以觸發前端黑夜視覺 (night class)
        room.players.forEach(p => {
            io.to(p.id).emit('assignRole', p.role);
        });

        // 這裡可以接續黑夜計時邏輯：例如狼人 30 秒倒數
        startNightPhase(roomId);
    }

    // 【新增：黑夜倒數邏輯】
    function startNightPhase(roomId) {
        const room = rooms[roomId];
        let nightTime = 30; // 狼人30秒
        io.to(roomId).emit('timerUpdate', nightTime);

        roomTimers[roomId] = setInterval(() => {
            nightTime--;
            io.to(roomId).emit('timerUpdate', nightTime);
            if (nightTime <= 0) {
                clearInterval(roomTimers[roomId]);
                io.to(roomId).emit('receiveMessage', { name: "系統", text: "⌛ 黑夜操作時間結束。", isSystem: true });
                // 這裡後續接女巫/預言家 10秒
            }
        }, 1000);
    }

// ... 後方代碼保持不變 (checkRole, sendMessage, disconnect, endGame) ...
