const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');

const PORT = Number(process.env.PORT || 4173);
const WIDTH = 1000;
const HEIGHT = 700;
const MAX_WEBSOCKET_MESSAGE_BYTES = 48 * 1024;
const MAX_AVATAR_BYTES = 32 * 1024;
const PUBLIC_DIR = path.join(__dirname, 'public');
const rooms = new Map();
const peers = new Set();
const COLORS = ['#f36b45', '#36b8a1', '#8b72db', '#efa93b', '#e75482', '#4e9ce3', '#85b94c', '#cf70cf'];
const FOODS = [
  { kind: 'burger', label: 'Burger', emoji: '🍔', points: 5, weight: 38 },
  { kind: 'shake', label: 'Milkshake', emoji: '🥤', points: 3, weight: 31 },
  { kind: 'beer', label: 'Beer', emoji: '🍺', points: -1, weight: 20 },
  { kind: 'burnt', label: 'Burnt burger', emoji: '🔥🍔', points: -2, weight: 11 },
];

function rand(min, max) { return Math.random() * (max - min) + min; }
function pickFood() {
  let n = Math.random() * FOODS.reduce((sum, f) => sum + f.weight, 0);
  for (const food of FOODS) { n -= food.weight; if (n <= 0) return food; }
  return FOODS[0];
}
function safeName(value) {
  const name = String(value || '').replace(/[<>\u0000-\u001f]/g, '').trim().slice(0, 16);
  return name || `Player ${Math.floor(rand(10, 99))}`;
}
function decodeAvatar(value) {
  if (typeof value !== 'string' || value.length > 44000) return null;
  const match = /^data:image\/jpeg;base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match) return null;
  const bytes = Buffer.from(match[1], 'base64');
  if (bytes.length < 4 || bytes.length > MAX_AVATAR_BYTES || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) return null;
  return bytes;
}
function makeCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do { code = Array.from({ length: 5 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join(''); } while (rooms.has(code));
  return code;
}
function trayPositions(room) {
  const count = room.players.length;
  const gap = WIDTH / (count + 1);
  return room.players.map((p, i) => ({ id: p.id, x: gap * (i + 1), y: HEIGHT - 55, color: p.color }));
}
function publicRoom(room) {
  const trays = trayPositions(room);
  return {
    type: 'room', code: room.code, status: room.status,
    scoreEvents: room.scoreEvents || [],
    players: room.players.map(({ id, name, color, score, connected, avatar, avatarToken }) => ({
      id, name, color, score, connected,
      avatarUrl: avatar ? `/avatar/${room.code}/${id}/${avatarToken}` : null,
    })),
    hostId: room.hostId,
    trays, objects: room.objects, effect: room.effect, kitty: room.kitty,
    spawned: room.spawned, winner: room.winner, winners: room.winners || [], startedAt: room.startedAt,
    serverNow: Date.now(), width: WIDTH, height: HEIGHT,
  };
}

function makeFrame(text) {
  const body = Buffer.from(text);
  let head;
  if (body.length < 126) {
    head = Buffer.from([0x81, body.length]);
  } else if (body.length < 65536) {
    head = Buffer.alloc(4); head[0] = 0x81; head[1] = 126; head.writeUInt16BE(body.length, 2);
  } else {
    head = Buffer.alloc(10); head[0] = 0x81; head[1] = 127; head.writeBigUInt64BE(BigInt(body.length), 2);
  }
  return Buffer.concat([head, body]);
}
function makeControlFrame(opcode, payload = Buffer.alloc(0)) {
  if (payload.length > 125) payload = payload.subarray(0, 125);
  return Buffer.concat([Buffer.from([0x80 | opcode, payload.length]), payload]);
}
function send(peer, data) {
  if (!peer.socket.destroyed && peer.socket.writable) peer.socket.write(makeFrame(JSON.stringify(data)));
}
function broadcast(room) {
  const packet = publicRoom(room);
  for (const peer of peers) if (peer.roomCode === room.code) send(peer, packet);
}
function sendError(peer, message) { send(peer, { type: 'error', message }); }
function removePlayer(peer) {
  if (!peer.roomCode) return;
  const room = rooms.get(peer.roomCode);
  if (!room) return;
  room.players = room.players.filter(p => p.id !== peer.playerId);
  room.objects = room.objects.filter(o => o.heldBy !== peer.playerId);
  if (!room.players.length) rooms.delete(room.code);
  else {
    if (room.hostId === peer.playerId) room.hostId = room.players.find(p => p.connected)?.id || room.players[0].id;
    if (room.status !== 'lobby' && room.status !== 'over' && room.players.length < 2) room.status = 'lobby';
    broadcast(room);
  }
  peer.roomCode = null; peer.playerId = null;
}
function disconnectPeer(peer) {
  const room = rooms.get(peer.roomCode);
  const player = room?.players.find(p => p.id === peer.playerId);
  if (!room || !player) return;
  player.connected = false;
  player.reconnectUntil = Date.now() + 45000;
  for (const object of room.objects) {
    if (object.heldBy === player.id) {
      object.heldBy = null; object.heldX = undefined; object.heldY = undefined;
      object.vx = rand(-3, 3); object.vy = rand(-3, 3);
    }
  }
  peer.roomCode = null; peer.playerId = null;
  broadcast(room);
}
function enterRoom(peer, room, name, avatarData) {
  if (room.players.length >= 8) return sendError(peer, 'This kitchen is full. The party tops out at 8 players.');
  if (room.status !== 'lobby') return sendError(peer, 'That match is already sizzling. Join before the host starts!');
  const player = {
    id: crypto.randomUUID(), sessionKey: crypto.randomUUID(), avatarToken: crypto.randomUUID(),
    avatar: decodeAvatar(avatarData), name: safeName(name), color: COLORS[room.players.length], score: 0, connected: true,
  };
  room.players.push(player);
  if (!room.hostId) room.hostId = player.id;
  peer.roomCode = room.code; peer.playerId = player.id;
  send(peer, { type: 'welcome', playerId: player.id, sessionKey: player.sessionKey, code: room.code, host: room.hostId === player.id });
  broadcast(room);
}
function spawnFood(room) {
  const food = pickFood();
  room.spawned += 1;
  const angle = rand(0, Math.PI * 2);
  const speed = rand(2.1, 5.6);
  const object = {
    id: crypto.randomUUID(), kind: food.kind, label: food.label, emoji: food.emoji,
    points: food.points, x: rand(170, WIDTH - 170), y: rand(100, HEIGHT - 190),
    vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed,
    radius: food.kind === 'burnt' ? 29 : 25, heldBy: null, thrownBy: null, thrown: false,
    wobble: rand(0, Math.PI * 2), createdAt: Date.now(),
  };
  room.objects.push(object);
  if (room.spawned > 0 && room.spawned % 50 === 0) {
    const direction = Math.random() < 0.5 ? 1 : -1;
    room.kitty = { x: direction === 1 ? -50 : WIDTH + 50, y: rand(100, HEIGHT - 220), direction, born: Date.now() };
  }
}
function startGame(room) {
  room.status = 'playing'; room.winner = null; room.winners = []; room.spawned = 0; room.objects = [];
  room.scoreEvents = [];
  room.effect = { kind: 'calm', label: 'The kitchen is warming up!', until: Date.now() + 2500, gustX: 0, gustY: 0 };
  room.startedAt = Date.now(); room.nextSpawn = Date.now() + 900; room.nextEffect = Date.now() + 9000;
  for (const p of room.players) p.score = 0;
  for (let i = 0; i < 7; i++) spawnFood(room);
}
function handleMessage(peer, message) {
  if (message.type === 'resume') {
    const room = rooms.get(String(message.code || '').toUpperCase().trim());
    const player = room?.players.find(p => p.sessionKey === message.sessionKey && !p.connected && p.reconnectUntil > Date.now());
    if (!room || !player) return sendError(peer, 'That game session has expired. Rejoin from the room code.');
    player.connected = true; delete player.reconnectUntil;
    peer.roomCode = room.code; peer.playerId = player.id;
    send(peer, { type: 'welcome', playerId: player.id, sessionKey: player.sessionKey, code: room.code, host: room.hostId === player.id });
    broadcast(room); return;
  }
  if (message.type === 'create') {
    removePlayer(peer);
    const room = { code: makeCode(), players: [], objects: [], status: 'lobby', hostId: null, winner: null, spawned: 0, effect: null, kitty: null, scoreEvents: [] };
    rooms.set(room.code, room); enterRoom(peer, room, message.name, message.avatar); return;
  }
  if (message.type === 'join') {
    removePlayer(peer);
    const room = rooms.get(String(message.code || '').toUpperCase().trim());
    if (!room) return sendError(peer, 'We couldn’t find that room. Check the code and try again.');
    enterRoom(peer, room, message.name, message.avatar); return;
  }
  const room = rooms.get(peer.roomCode);
  if (!room) return;
  const player = room.players.find(p => p.id === peer.playerId);
  if (!player) return;
  if (message.type === 'start') {
    if (room.hostId !== player.id) return sendError(peer, 'Only the host can start the game.');
    if (room.players.length < 2) return sendError(peer, 'Invite at least one more player before starting.');
    if (room.status === 'lobby' || room.status === 'over') startGame(room);
    broadcast(room); return;
  }
  if (message.type === 'catch' && room.status === 'playing') {
    if (room.objects.some(o => o.heldBy === player.id)) return;
    const object = room.objects.find(o => o.id === message.id && !o.heldBy && !o.thrown);
    if (!object) return;
    object.heldBy = player.id; object.vx = 0; object.vy = 0; object.heldX = object.x; object.heldY = object.y;
    broadcast(room); return;
  }
  if (message.type === 'toss' && room.status === 'playing') {
    const object = room.objects.find(o => o.heldBy === player.id);
    if (!object) return;
    const dx = Number(message.dx), dy = Number(message.dy);
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) return;
    const length = Math.hypot(dx, dy);
    if (!Number.isFinite(length) || length < 1e-6) return;
    const charge = Math.max(0, Math.min(1, Number(message.power) || 0));
    const speed = 5.8 + charge * 8;
    object.vx = (dx / length) * speed; object.vy = (dy / length) * speed;
    object.heldBy = null; object.thrownBy = player.id; object.thrown = true;
    object.createdAt = Date.now();
    broadcast(room); return;
  }
  if (message.type === 'avatar') {
    player.avatar = decodeAvatar(message.avatar);
    player.avatarToken = crypto.randomUUID();
    broadcast(room); return;
  }
  if (message.type === 'leave') removePlayer(peer);
}

function tick() {
  const now = Date.now();
  for (const room of rooms.values()) {
    if (room.status !== 'playing') continue;
    const trays = trayPositions(room);
    if (now >= room.nextSpawn) { spawnFood(room); room.nextSpawn = now + rand(1150, 1850); }
    if (now >= room.nextEffect) {
      const effects = [
        { kind: 'gust', label: 'FAN BLAST!', gustX: rand(-0.18, 0.18), gustY: rand(-0.12, 0.12) },
        { kind: 'slippery', label: 'SLIPPERY COUNTER!', gustX: 0, gustY: 0 },
        { kind: 'bouncy', label: 'EXTRA BOUNCY!', gustX: 0, gustY: 0 },
      ];
      const event = effects[Math.floor(Math.random() * effects.length)];
      room.effect = { ...event, until: now + 3500 };
      room.nextEffect = now + rand(9000, 15000);
    }
    if (room.effect && now > room.effect.until && room.effect.kind !== 'calm') room.effect = { kind: 'calm', label: '', until: now + 1000, gustX: 0, gustY: 0 };

    if (room.kitty) {
      const cat = room.kitty;
      cat.x += cat.direction * 12;
      for (const obj of room.objects) {
        if (obj.heldBy) continue;
        const d = Math.hypot(obj.x - cat.x, obj.y - cat.y);
        if (d < 145) {
          const a = Math.atan2(obj.y - cat.y, obj.x - cat.x);
          const impulse = (1 - d / 145) * 2.5;
          obj.vx += Math.cos(a) * impulse; obj.vy += Math.sin(a) * impulse;
        }
      }
      if (cat.x < -100 || cat.x > WIDTH + 100) room.kitty = null;
    }

    const scored = [];
    const crossed100 = new Set();
    for (const obj of room.objects) {
      if (obj.heldBy) {
        obj.x = obj.heldX ?? obj.x; obj.y = obj.heldY ?? obj.y; obj.wobble += 0.08;
        continue;
      }
      const effect = room.effect?.kind;
      if (effect === 'gust') { obj.vx += (room.effect.gustX || 0) * 0.06; obj.vy += (room.effect.gustY || 0) * 0.06; }
      const drag = effect === 'slippery' ? 0.999 : 0.986;
      obj.vx *= drag; obj.vy *= drag;
      if (effect === 'bouncy') { obj.vx *= 1.002; obj.vy *= 1.002; }
      obj.x += obj.vx; obj.y += obj.vy; obj.wobble += 0.09;
      if (obj.x < obj.radius || obj.x > WIDTH - obj.radius) { obj.x = Math.max(obj.radius, Math.min(WIDTH - obj.radius, obj.x)); obj.vx *= -0.82; }
      if (obj.y < obj.radius || obj.y > HEIGHT - obj.radius - 5) { obj.y = Math.max(obj.radius, Math.min(HEIGHT - obj.radius - 5, obj.y)); obj.vy *= -0.8; }
      if (obj.thrown && obj.thrownBy) {
        const targetTray = trays.find(t => obj.vy > 0 && obj.y >= t.y - 40 && obj.y <= t.y + 35 && Math.abs(obj.x - t.x) <= 54);
        if (targetTray && (obj.points < 0 || targetTray.id === obj.thrownBy)) {
          const recipient = room.players.find(p => p.id === targetTray.id);
          if (recipient) {
            const oldScore = recipient.score;
            recipient.score = Math.max(0, recipient.score + obj.points);
            if (oldScore < 100 && recipient.score >= 100) crossed100.add(recipient.id);
            room.scoreEvents.push({ id: crypto.randomUUID(), playerId: recipient.id, points: obj.points });
            scored.push(obj.id);
          }
        }
        if (Date.now() - obj.createdAt > 9000) scored.push(obj.id);
      }
      // Gentle object-to-object collisions keep the shared counter lively.
      if (!obj.heldBy) {
        for (const other of room.objects) {
          if (other.id <= obj.id || other.heldBy) continue;
          const dx = other.x - obj.x, dy = other.y - obj.y, d = Math.hypot(dx, dy), min = obj.radius + other.radius;
          if (d > 0 && d < min) {
            const nx = dx / d, ny = dy / d, kick = 0.75;
            obj.vx -= nx * kick; obj.vy -= ny * kick; other.vx += nx * kick; other.vy += ny * kick;
          }
        }
      }
    }
    while (room.objects.length > 36) {
      const oldestLoose = room.objects.findIndex(o => !o.heldBy && !o.thrown);
      if (oldestLoose < 0) break;
      room.objects.splice(oldestLoose, 1);
    }
    if (scored.length) {
      room.objects = room.objects.filter(o => !scored.includes(o.id));
      const winners = room.players.filter(p => crossed100.has(p.id));
      if (winners.length) {
        room.status = 'over'; room.winners = winners.map(p => p.id); room.winner = winners.length === 1 ? winners[0].id : null;
        room.objects = room.objects.filter(o => !o.heldBy); broadcast(room);
      }
    }
  }
}
function pruneDisconnectedPlayers() {
  const now = Date.now();
  for (const room of rooms.values()) {
    const expired = room.players.filter(p => !p.connected && p.reconnectUntil <= now).map(p => p.id);
    if (!expired.length) continue;
    room.players = room.players.filter(p => !expired.includes(p.id));
    room.objects = room.objects.filter(o => !expired.includes(o.heldBy));
    if (!room.players.length) { rooms.delete(room.code); continue; }
    if (expired.includes(room.hostId)) room.hostId = room.players.find(p => p.connected)?.id || room.players[0].id;
    if (room.status === 'playing' && room.players.length < 2) room.status = 'lobby';
    broadcast(room);
  }
}
setInterval(() => {
  pruneDisconnectedPlayers();
  for (const room of rooms.values()) room.scoreEvents = [];
  tick();
  for (const room of rooms.values()) {
    if (room.status === 'playing') broadcast(room);
    room.scoreEvents = [];
  }
}, 50).unref();

const server = http.createServer((req, res) => {
  let requestPath = decodeURIComponent((req.url || '/').split('?')[0]);
  if (requestPath === '/health') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end('{"ok":true}'); }
  const avatarPath = /^\/avatar\/([A-Z0-9]{5})\/([a-f0-9-]{36})\/([a-f0-9-]{36})$/i.exec(requestPath);
  if (avatarPath) {
    const room = rooms.get(avatarPath[1].toUpperCase());
    const player = room?.players.find(p => p.id === avatarPath[2] && p.avatarToken === avatarPath[3]);
    if (!player?.avatar) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': player.avatar.length, 'Cache-Control': 'private, no-store' });
    return res.end(player.avatar);
  }
  if (requestPath === '/') requestPath = '/index.html';
  const filePath = path.normalize(path.join(PUBLIC_DIR, requestPath));
  if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    const ext = path.extname(filePath);
    const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml' };
    res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(data);
  });
});

server.on('upgrade', (req, socket) => {
  if (req.url !== '/ws' || !req.headers['sec-websocket-key']) return socket.destroy();
  const accept = crypto.createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  const peer = { socket, buffer: Buffer.alloc(0), roomCode: null, playerId: null, isAlive: true };
  peers.add(peer);
  socket.on('data', chunk => {
    peer.buffer = Buffer.concat([peer.buffer, chunk]);
    while (peer.buffer.length >= 2) {
      const b0 = peer.buffer[0], b1 = peer.buffer[1], opcode = b0 & 0x0f, masked = (b1 & 0x80) !== 0;
      let length = b1 & 0x7f, offset = 2;
      if (length === 126) { if (peer.buffer.length < 4) break; length = peer.buffer.readUInt16BE(2); offset = 4; }
      else if (length === 127) { if (peer.buffer.length < 10) break; length = Number(peer.buffer.readBigUInt64BE(2)); offset = 10; }
      if (length > MAX_WEBSOCKET_MESSAGE_BYTES) { socket.destroy(); return; }
      const maskBytes = masked ? 4 : 0;
      if (peer.buffer.length < offset + maskBytes + length) break;
      const mask = masked ? peer.buffer.subarray(offset, offset + 4) : null;
      offset += maskBytes;
      const payload = Buffer.from(peer.buffer.subarray(offset, offset + length));
      peer.buffer = peer.buffer.subarray(offset + length);
      if (masked) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
      if (opcode === 8) { socket.end(); break; }
      if (opcode === 9) { socket.write(makeControlFrame(10, payload)); continue; }
      if (opcode === 10) { peer.isAlive = true; continue; }
      if (opcode === 1) {
        try { handleMessage(peer, JSON.parse(payload.toString('utf8'))); }
        catch { sendError(peer, 'That move got lost in the kitchen. Please try again.'); }
      }
    }
  });
  socket.on('close', () => { disconnectPeer(peer); peers.delete(peer); });
  socket.on('error', () => { disconnectPeer(peer); peers.delete(peer); });
});

setInterval(() => {
  for (const peer of peers) {
    if (!peer.isAlive) { peer.socket.destroy(); continue; }
    peer.isAlive = false;
    peer.socket.write(makeControlFrame(9, Buffer.from('ping')));
  }
}, 25000).unref();

server.listen(PORT, '0.0.0.0', () => {
  const interfaces = Object.values(os.networkInterfaces()).flat().filter(x => x && x.family === 'IPv4' && !x.internal);
  console.log(`Panic Pantry is ready at http://localhost:${PORT}`);
  if (interfaces.length) console.log(`On the same Wi-Fi, share one of these: ${interfaces.map(x => `http://${x.address}:${PORT}`).join('  ')}`);
});
