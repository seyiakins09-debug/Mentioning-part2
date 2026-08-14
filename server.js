
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const fs = require("fs");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const PORT = process.env.PORT || 10000;
const questions = JSON.parse(fs.readFileSync(path.join(__dirname, "questions.json"), "utf8"));
const rooms = new Map();

app.use(express.static(__dirname));
app.get("/health", (req, res) => res.json({ ok: true, rooms: rooms.size }));

function code() {
  let c;
  do c = Math.random().toString(36).slice(2, 8).toUpperCase();
  while (rooms.has(c));
  return c;
}

function publicRoom(room) {
  return {
    code: room.code,
    hostId: room.hostId,
    started: room.started,
    set: room.set,
    question: room.question,
    timerRunning: room.timerRunning,
    timeLeft: room.timeLeft,
    players: [...room.players.values()].map(p => ({
      id: p.id, name: p.name, xp: p.xp, submitted: p.submitted,
      answer: p.answer, winner: p.winner
    }))
  };
}

function emitRoom(room) {
  io.to(room.code).emit("room:update", publicRoom(room));
}

function currentQuestion(room) {
  return questions.find(q => q.set === room.set && q.round === room.question);
}

function resetQuestion(room) {
  for (const p of room.players.values()) {
    p.submitted = false;
    p.answer = "";
    p.winner = false;
  }
  room.timeLeft = 60;
  room.timerRunning = false;
}

function startTimer(room) {
  if (room.timerRunning) return;
  room.timerRunning = true;
  room.timeLeft = 60;
  emitRoom(room);
  clearInterval(room.timer);
  room.timer = setInterval(() => {
    if (!rooms.has(room.code)) return clearInterval(room.timer);
    room.timeLeft -= 1;
    if (room.timeLeft <= 0) {
      room.timeLeft = 0;
      room.timerRunning = false;
      clearInterval(room.timer);
    }
    emitRoom(room);
  }, 1000);
}

io.on("connection", socket => {
  socket.on("host:create", ({ name }) => {
    const roomCode = code();
    const room = {
      code: roomCode, hostId: socket.id, hostName: name || "HOST",
      players: new Map(), started: false, set: 1, question: 1,
      timeLeft: 60, timerRunning: false, timer: null
    };
    rooms.set(roomCode, room);
    socket.join(roomCode);
    socket.data.room = roomCode;
    socket.data.role = "host";
    socket.emit("host:created", { code: roomCode, hostName: room.hostName });
    emitRoom(room);
  });

  socket.on("room:join", ({ code: roomCode, name }) => {
    const room = rooms.get(String(roomCode || "").trim().toUpperCase());
    if (!room) return socket.emit("error:message", "Room not found. Check the room code.");
    if (room.started) return socket.emit("error:message", "The game has already started.");
    if (!name || !name.trim()) return socket.emit("error:message", "Enter your player name.");
    if ([...room.players.values()].some(p => p.name.toLowerCase() === name.trim().toLowerCase()))
      return socket.emit("error:message", "That player name is already in the room.");
    const player = { id: socket.id, name: name.trim(), xp: 0, submitted: false, answer: "", winner: false };
    room.players.set(socket.id, player);
    socket.join(room.code);
    socket.data.room = room.code;
    socket.data.role = "player";
    socket.emit("player:joined", { code: room.code, name: player.name });
    emitRoom(room);
  });


  socket.on("host:set", ({ set }) => {
    const room = rooms.get(socket.data.room);
    if (!room || room.hostId !== socket.id || room.started) return;
    const n = Number(set);
    if (!Number.isInteger(n) || n < 1 || n > 30) return socket.emit("error:message", "Choose a set from 1 to 30.");
    room.set = n;
    room.question = 1;
    resetQuestion(room);
    emitRoom(room);
  });

  socket.on("host:start", () => {
    const room = rooms.get(socket.data.room);
    if (!room || room.hostId !== socket.id) return;
    if (room.players.size < 1) return socket.emit("error:message", "At least one player must join before starting.");
    room.started = true;
    // Keep the set selected by the host.
    room.question = 1;
    resetQuestion(room);
    emitRoom(room); });

  socket.on("host:startTimer", () => {
    const room = rooms.get(socket.data.room);
    if (!room || room.hostId !== socket.id || !room.started) return; });

  socket.on("player:answer", ({ answer }) => {
    const room = rooms.get(socket.data.room);
    if (!room || socket.data.role !== "player" || !room.started) return;
    const p = room.players.get(socket.id);
    if (!p || p.submitted || room.timeLeft <= 0) return;
    const clean = String(answer || "").trim();
    if (!clean) return socket.emit("error:message", "Enter your answer first.");
    p.answer = clean;
    p.submitted = true;
    emitRoom(room);
  });

  socket.on("host:award", ({ playerId }) => {
    const room = rooms.get(socket.data.room);
    if (!room || room.hostId !== socket.id) return;
    const p = room.players.get(playerId);
    if (!p || !p.submitted) return socket.emit("error:message", "That player has not submitted an answer.");
    for (const x of room.players.values()) x.winner = false;
    p.xp += 200;
    p.winner = true;
    room.timerRunning = false;
    clearInterval(room.timer);
    emitRoom(room);
  });

  socket.on("host:next", () => {
    const room = rooms.get(socket.data.room);
    if (!room || room.hostId !== socket.id || !room.started) return;
    if (room.question < 10) {
      room.question += 1;
    } else if (room.set < 30) {
      room.set += 1;
      room.question = 1;
    } else {
      room.started = false;
      room.timerRunning = false;
      clearInterval(room.timer);
      emitRoom(room);
      return;
    }
    resetQuestion(room);
    emitRoom(room); });


  socket.on("host:home", () => {
    const room = rooms.get(socket.data.room);
    if (!room || room.hostId !== socket.id) return;
    clearInterval(room.timer);
    rooms.delete(room.code);
    socket.leave(room.code);
    socket.data.room = null;
    socket.data.role = null;
    socket.emit("host:home:ok");
  });

  socket.on("host:end", () => {
    const room = rooms.get(socket.data.room);
    if (!room || room.hostId !== socket.id) return;
    room.started = false;
    room.timerRunning = false;
    clearInterval(room.timer);
    emitRoom(room);
  });

  socket.on("disconnect", () => {
    const room = rooms.get(socket.data.room);
    if (!room) return;
    if (room.hostId === socket.id) {
      clearInterval(room.timer);
      io.to(room.code).emit("room:closed", "The host has left the game.");
      rooms.delete(room.code);
    } else {
      room.players.delete(socket.id);
      emitRoom(room);
    }
  });
});

server.listen(PORT, () => console.log(`SEY GAMERZ MENTIONING running on port ${PORT}`));
