// server.js — Penales 1v1 (Node + Express + Socket.IO)
// Run: npm run dev   (o  npm start)
// Endpoints:
//   GET /health       -> ok
//   GET /matches      -> lista de partidas públicas (para "Ver Partidos")

const express = require('express');
const http = require('http');
const cors = require('cors');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3001;
const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

// ======= Modelo en memoria (MVP) =======
/**
 * matches[matchId] = {
 *   id, status: 'waiting'|'playing'|'finished',
 *   type: 'public'|'private',
 *   code: 'ABCD12' | null,         // para desafíos
 *   players: { A: socketId|null, B: socketId|null },
 *   uids: { A: null|uid, B: null|uid },
 *   spectators: Set<socketId>,
 *   round: 1, maxRounds: 5,
 *   score: { A:0, B:0 },
 *   turn: 'A'|'B',
 *   pending: { kick:null, dive:null } // {angle,power} / {dir}
 * }
 */
const matches = {};
const queue = []; // jugadores esperando "Jugar Rápido"
const socketsMeta = new Map(); // socketId -> { uid, nick, matchId, role: 'A'|'B'|'spec' }

function uid() {
  return Math.random().toString(36).slice(2, 8) + Math.random().toString(36).slice(2, 6);
}
function inviteCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  for (let i = 0; i < 6; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}
function other(role) { return role === 'A' ? 'B' : 'A'; }

function publicMatchesSnapshot() {
  return Object.values(matches)
    .filter(m => m.type === 'public' && m.status !== 'finished')
    .map(m => ({
      id: m.id,
      status: m.status,
      round: m.round,
      maxRounds: m.maxRounds,
      score: m.score,
      spectators: m.spectators.size
    }));
}

// ======= REST mínimo (para “Ver Partidos”) =======
app.get('/health', (_req, res) => res.json({ ok: true }));
app.get('/matches', (_req, res) => res.json(publicMatchesSnapshot()));

// ======= Lógica de juego =======
function createMatch(type = 'public') {
  const id = uid();
  matches[id] = {
    id,
    status: 'waiting',
    type,
    code: type === 'private' ? inviteCode() : null,
    players: { A: null, B: null },
    uids: { A: null, B: null },
    spectators: new Set(),
    round: 1,
    maxRounds: 5,
    score: { A: 0, B: 0 },
    turn: 'A',
    pending: { kick: null, dive: null }
  };
  return matches[id];
}

function startIfReady(m) {
  if (m.players.A && m.players.B && m.status === 'waiting') {
    m.status = 'playing';
    io.to(m.players.A).emit('match_start', { matchId: m.id, youAre: 'A', maxRounds: m.maxRounds });
    io.to(m.players.B).emit('match_start', { matchId: m.id, youAre: 'B', maxRounds: m.maxRounds });
    pushTurn(m);
  }
}

function pushTurn(m) {
  // avisa roles del turno actual
  const kickerId = m.players[m.turn];
  const keeperId = m.players[other(m.turn)];
  io.to(kickerId).emit('your_turn', { role: 'kicker', round: m.round, youAre: m.turn, score: m.score });
  io.to(keeperId).emit('your_turn', { role: 'keeper', round: m.round, youAre: other(m.turn), score: m.score });
  // espectadores reciben estado
  for (const s of m.spectators) {
    io.to(s).emit('score_update', { score: m.score, round: m.round, turn: m.turn });
  }
}

function resolveShot(m) {
  const kick = m.pending.kick;    // { angleDeg, power01 }
  const dive = m.pending.dive;    // { dir }
  m.pending.kick = null;
  m.pending.dive = null;

  // Modelo simple de física/probabilidad:
  const angle = Math.max(-60, Math.min(60, kick.angleDeg));
  const power = Math.max(0, Math.min(1, kick.power01));
  const spread = 6 * (0.2 + power);                     // más power => menos precisión
  const actualAngle = angle + (Math.random() * 2 - 1) * spread;
  const zone = actualAngle < -15 ? 'left' : actualAngle > 15 ? 'right' : 'center';
  const missProb = Math.max(0, power - 0.9) * 2;        // muy fuerte => puede ir afuera
  const isMiss = Math.random() < missProb;

  let result = 'goal';
  if (isMiss) result = 'miss';
  else if (dive.dir === zone) {
    const saveProb = 0.6 - 0.25 * power;                // más power => más difícil atajar
    if (Math.random() < saveProb) result = 'save';
  }

  const shooter = m.turn;
  const keeper = other(m.turn);
  if (result === 'goal') m.score[shooter] += 1;

  // broadcast a jugadores y espectadores
  io.to(m.players.A).emit('shot_result', { result, zone, score: m.score, round: m.round, nextTurn: keeper });
  io.to(m.players.B).emit('shot_result', { result, zone, score: m.score, round: m.round, nextTurn: keeper });
  for (const s of m.spectators) io.to(s).emit('shot_result', { result, zone, score: m.score, round: m.round, nextTurn: keeper });

  // avanzar ronda/turno
  if (shooter === 'B') m.round += 1; // cada dos tiros sube la ronda
  m.turn = other(m.turn);

  // ¿fin?
  const max = m.maxRounds;
  const totalShots = (m.round - 1) * 2 + (m.turn === 'A' ? 0 : 1);
  const maxShots = max * 2;

  // muerte súbita después de 5/5 si empatan
  if (totalShots >= maxShots) {
    if (m.score.A !== m.score.B) {
      finishMatch(m);
      return;
    } else if (m.round > max) {
      // en muerte súbita: si tras el par de tiros se sacan diferencia, termina
      if (m.turn === 'A') { // acabamos de cerrar el par
        if (m.score.A !== m.score.B) { finishMatch(m); return; }
      }
    }
  }
  pushTurn(m);
}

function finishMatch(m) {
  m.status = 'finished';
  const winner = m.score.A > m.score.B ? 'A' : m.score.B > m.score.A ? 'B' : 'draw';
  io.to(m.players.A).emit('match_over', { winner, score: m.score });
  io.to(m.players.B).emit('match_over', { winner, score: m.score });
  for (const s of m.spectators) io.to(s).emit('match_over', { winner, score: m.score });
}

// ======= Socket.IO =======
io.on('connection', (socket) => {
  socketsMeta.set(socket.id, { uid: null, nick: null, matchId: null, role: null });

  socket.on('hello', ({ uid, nick }) => {
    const meta = socketsMeta.get(socket.id) || {};
    meta.uid = uid || ('guest_' + uid());
    meta.nick = nick || 'Invitado';
    socketsMeta.set(socket.id, meta);
    socket.emit('hello_ok', { serverTime: Date.now() });
  });

  // Jugar Rápido (public)
  socket.on('join_queue', () => {
    const meta = socketsMeta.get(socket.id);
    if (!meta) return;

    queue.push(socket.id);

    // si hay 2 en cola -> crear/llenar partida
    while (queue.length >= 2) {
      const sA = queue.shift();
      const sB = queue.shift();
      const m = createMatch('public');
      m.players.A = sA; m.players.B = sB;
      socketsMeta.get(sA).matchId = m.id; socketsMeta.get(sA).role = 'A';
      socketsMeta.get(sB).matchId = m.id; socketsMeta.get(sB).role = 'B';
      startIfReady(m);
    }
  });

  // Crear desafío (private)
  socket.on('create_private', () => {
    const m = createMatch('private');
    m.players.A = socket.id;
    const meta = socketsMeta.get(socket.id) || {};
    meta.matchId = m.id; meta.role = 'A';
    socketsMeta.set(socket.id, meta);
    socket.join(m.id);
    socket.emit('private_created', { matchId: m.id, code: m.code });
  });

  // Unirse por código
  socket.on('join_by_code', ({ code }) => {
    const m = Object.values(matches).find(x => x.code === code && x.status === 'waiting');
    if (!m) return socket.emit('error_msg', { message: 'Código inválido o sala no disponible' });
    if (m.players.B) return socket.emit('error_msg', { message: 'La sala ya está llena' });

    m.players.B = socket.id;
    const meta = socketsMeta.get(socket.id) || {};
    meta.matchId = m.id; meta.role = 'B';
    socketsMeta.set(socket.id, meta);
    socket.join(m.id);
    startIfReady(m);
  });

  // Espectar
  socket.on('spectate_join', ({ matchId }) => {
    const m = matches[matchId];
    if (!m || m.status === 'finished') return socket.emit('error_msg', { message: 'Partido no disponible' });
    m.spectators.add(socket.id);
    const meta = socketsMeta.get(socket.id) || {};
    meta.matchId = matchId; meta.role = 'spec';
    socketsMeta.set(socket.id, meta);
    socket.join(matchId);
    socket.emit('score_update', { score: m.score, round: m.round, turn: m.turn });
  });

  // Inputs de juego
  socket.on('kick', ({ angleDeg, power01 }) => {
    const meta = socketsMeta.get(socket.id);
    if (!meta) return;
    const m = matches[meta.matchId];
    if (!m || m.status !== 'playing') return;

    if (m.players[m.turn] !== socket.id) return; // no es tu turno de patear
    m.pending.kick = {
      angleDeg: Number(angleDeg) || 0,
      power01: Math.max(0, Math.min(1, Number(power01)))
    };
    if (m.pending.kick && m.pending.dive) resolveShot(m);
  });

  socket.on('dive', ({ dir }) => {
    const meta = socketsMeta.get(socket.id);
    if (!meta) return;
    const m = matches[meta.matchId];
    if (!m || m.status !== 'playing') return;

    const keeperId = m.players[other(m.turn)];
    if (keeperId !== socket.id) return; // no es tu turno de atajar
    const normalized = ['left', 'center', 'right'].includes(dir) ? dir : 'center';
    m.pending.dive = { dir: normalized };
    if (m.pending.kick && m.pending.dive) resolveShot(m);
  });

  socket.on('disconnect', () => {
    const meta = socketsMeta.get(socket.id);
    socketsMeta.delete(socket.id);
    // quitar de queue
    const idx = queue.indexOf(socket.id);
    if (idx >= 0) queue.splice(idx, 1);
    // si estaba en un match, finalizar
    if (meta && meta.matchId) {
      const m = matches[meta.matchId];
      if (m && m.status !== 'finished') {
        m.status = 'finished';
        const winner = (m.players.A === socket.id) ? 'B' : 'A';
        io.to(m.players.A).emit('match_over', { winner, score: m.score, reason: 'opponent_disconnected' });
        io.to(m.players.B).emit('match_over', { winner, score: m.score, reason: 'opponent_disconnected' });
        for (const s of m.spectators) io.to(s).emit('match_over', { winner, score: m.score, reason: 'opponent_disconnected' });
      }
    }
  });
});

server.listen(PORT, () => {
  console.log('Penales 1v1 server listening on port', PORT);
});