const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*", methods: ["GET", "POST"] } });

let rooms = {};

io.on('connection', (socket) => {
    socket.on('joinRoom', ({ roomId, username }) => {
        if (!rooms[roomId]) rooms[roomId] = { hostId: socket.id, players: [], status: 'waiting' };
        const room = rooms[roomId];

        if (room.status === 'playing') return socket.emit('errorMessage', '❌ 遊戲已開始，請等下一局。');
        if (room.players.some(p => p.name === username)) return socket.emit('errorMessage', '❌ 名字重複囉！');

        socket.join(roomId);
        socket.roomId = roomId;
        socket.username = username;

        const player = { id: socket.id, name: username, role: null, isHost: (socket.id === room.hostId), isAlive: true };
        room.players.push(player);

        io.to(roomId).emit('updatePlayers', { players: room.players, status: room.status });
        socket.emit('hostStatus', player.isHost);
    });

    socket.on('kickPlayer', (targetId) => {
        const room = rooms[socket.roomId];
        if (room && socket.id === room.hostId) {
            io.sockets.sockets.get(targetId)?.disconnect();
        }
    });

    socket.on('startGame', () => {
        const room = rooms[socket.roomId];
        if (room && room.players.length >= 6) {
            room.status = 'playing';
            const roles = ['狼人', '狼人', '預言家', '女巫', '村民', '村民'];
            room.players.forEach((p, i) => {
                p.isAlive = true;
                p.role = roles[i % roles.length];
                io.to(p.id).emit('assignRole', p.role);
            });
            io.to(socket.roomId).emit('updatePlayers', { players: room.players, status: room.status });
        }
    });

    socket.on('sendMessage', (data) => {
        if (socket.roomId) io.to(socket.roomId).emit('receiveMessage', data);
    });

    socket.on('disconnect', () => {
        const roomId = socket.roomId;
        if (!roomId || !rooms[roomId]) return;
        const room = rooms[roomId];

        if (room.status === 'waiting') {
            room.players = room.players.filter(p => p.id !== socket.id);
            if (room.players.length > 0 && socket.id === room.hostId) {
                room.hostId = room.players[0].id;
                room.players[0].isHost = true;
            }
        } else {
            const player = room.players.find(p => p.id === socket.id);
            if (player) {
                player.isAlive = false;
                io.to(roomId).emit('receiveMessage', { name: "系統", text: `⚠️ ${player.name} 已離線淘汰！`, isSystem: true });
                checkGameOver(roomId);
            }
        }
        io.to(roomId).emit('updatePlayers', { players: room.players, status: room.status });
    });

    function checkGameOver(roomId) {
        const room = rooms[roomId];
        const alives = room.players.filter(p => p.isAlive);
        const wolves = alives.filter(p => p.role === '狼人');
        const humans = alives.filter(p => p.role !== '狼人');

        let winner = null;
        if (wolves.length === 0) winner = "好人陣營";
        else if (humans.length === 0) winner = "狼人陣營";

        if (winner) {
            io.to(roomId).emit('gameOver', { winner, allRoles: room.players });
            delete rooms[roomId]; // 結算後重置房間
        }
    }
});

server.listen(process.env.PORT || 3000);
