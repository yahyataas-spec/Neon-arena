// ==========================================================
//  NEON ARENA - server.js
//  Express + Socket.io ile gercek zamanli coklu oyunculu
//  paper.io tarzi 4 yonlu "iz birak / alan kapla" oyunu.
//  Calistirmak icin:
//    npm install express socket.io
//    node server.js
//    -> http://localhost:3000
// ==========================================================

const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;

// ---------------------------------------------------------
// OYUN SABITLERI
// ---------------------------------------------------------
const GRID_W = 110;         // grid genisligi (hucre) - buyutulmus harita
const GRID_H = 74;          // grid yuksekligi (hucre)
const CELL = 20;            // istemcide 1 hucre = 20px (bilgi amacli)
const TICK_MS = 50;         // 20 tick/sn
const SPEED = 0.16;         // hucre / tick
const MAX_PLAYERS = 32;
const KILL_BONUS = 10;
const RESPAWN_MS = 2000;
const MAX_NAME_LEN = 14;

const NAMES = ['Falcon','Viper','Nova','Blaze','Ghost','Volt','Zephyr','Raven',
  'Comet','Nero','Lynx','Storm','Kilo','Onyx','Pixel','Turbo','Nyx','Rogue'];
const COLORS = ['#ff2079','#00e5ff','#7cff00','#ffb700','#b967ff','#ff5c5c',
  '#00ffa3','#ff8ac9','#5cf0ff','#f5ff5c','#ff6a00','#4dff4d'];

const HEX_RE = /^#[0-9a-fA-F]{6}$/;

// Paper.io tarzi 4 yon (yukari, asagi, sol, sag)
const DIRS = [
  { x: 1, y: 0, angle: 0 },
  { x: 0, y: 1, angle: Math.PI / 2 },
  { x: -1, y: 0, angle: Math.PI },
  { x: 0, y: -1, angle: -Math.PI / 2 }
];

function snapDir(angle) {
  const twoPi = Math.PI * 2;
  let a = ((angle % twoPi) + twoPi) % twoPi;
  let best = 0, bestDiff = Infinity;
  for (let i = 0; i < DIRS.length; i++) {
    let da = Math.abs(a - ((DIRS[i].angle % twoPi + twoPi) % twoPi));
    if (da > Math.PI) da = twoPi - da;
    if (da < bestDiff) { bestDiff = da; best = i; }
  }
  return DIRS[best];
}

// ---------------------------------------------------------
// DURUM
// ---------------------------------------------------------
let territoryGrid = new Array(GRID_W * GRID_H).fill(-1);
let trailGrid = new Array(GRID_W * GRID_H).fill(-1);

const players = {};       // socket.id -> player object
const slotToId = {};      // slot -> socket.id
let freeSlots = [];
for (let i = MAX_PLAYERS - 1; i >= 0; i--) freeSlots.push(i);

function idx(x, y) { return y * GRID_W + x; }
function inBounds(x, y) { return x >= 0 && y >= 0 && x < GRID_W && y < GRID_H; }

function sanitizeName(raw) {
  if (typeof raw !== 'string') return null;
  let n = raw.replace(/[<>]/g, '').trim().slice(0, MAX_NAME_LEN);
  return n.length ? n : null;
}

function uniqueName(base) {
  const taken = new Set(Object.values(players).map(p => p.name));
  if (!taken.has(base)) return base;
  for (let i = 2; i < 100; i++) {
    const candidate = `${base}${i}`.slice(0, MAX_NAME_LEN);
    if (!taken.has(candidate)) return candidate;
  }
  return base + Math.floor(Math.random() * 99);
}

function sanitizeColor(raw) {
  return (typeof raw === 'string' && HEX_RE.test(raw)) ? raw : null;
}

function randomFreeSpot() {
  for (let tries = 0; tries < 400; tries++) {
    const x = 4 + Math.floor(Math.random() * (GRID_W - 8));
    const y = 4 + Math.floor(Math.random() * (GRID_H - 8));
    let free = true;
    for (let dx = -2; dx <= 2 && free; dx++) {
      for (let dy = -2; dy <= 2; dy++) {
        const nx = x + dx, ny = y + dy;
        if (!inBounds(nx, ny) || territoryGrid[idx(nx, ny)] !== -1) { free = false; break; }
      }
    }
    if (free) return { x, y };
  }
  return { x: Math.floor(GRID_W / 2), y: Math.floor(GRID_H / 2) };
}

function claimStartArea(slot, cx, cy) {
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      const nx = cx + dx, ny = cy + dy;
      if (inBounds(nx, ny)) territoryGrid[idx(nx, ny)] = slot;
    }
  }
}

function clearPlayerCells(slot) {
  for (let i = 0; i < territoryGrid.length; i++) {
    if (territoryGrid[i] === slot) territoryGrid[i] = -1;
    if (trailGrid[i] === slot) trailGrid[i] = -1;
  }
}

function countTerritory(slot) {
  let c = 0;
  for (let i = 0; i < territoryGrid.length; i++) if (territoryGrid[i] === slot) c++;
  return c;
}

function recalcScore(slot) {
  const id = slotToId[slot];
  const p = players[id];
  if (!p) return;
  p.areaCells = countTerritory(slot);
  p.score = p.areaCells + p.kills * KILL_BONUS;
}

function spawnPlayer(socket, name, color) {
  const slot = freeSlots.pop();
  if (slot === undefined) return null; // sunucu dolu

  const spot = randomFreeSpot();
  const dir = DIRS[0];
  const p = {
    id: socket.id,
    slot,
    name: uniqueName(name || (NAMES[Math.floor(Math.random() * NAMES.length)] + '-' + Math.floor(Math.random() * 90 + 10))),
    color: color || COLORS[Math.floor(Math.random() * COLORS.length)],
    x: spot.x + 0.5,
    y: spot.y + 0.5,
    cellX: spot.x,
    cellY: spot.y,
    dir,
    angle: dir.angle,
    alive: true,
    trail: [],
    score: 0,
    areaCells: 0,
    kills: 0,
    deaths: 0,
    joinedAt: Date.now()
  };
  claimStartArea(slot, spot.x, spot.y);
  players[socket.id] = p;
  slotToId[slot] = socket.id;
  recalcScore(slot);
  return p;
}

function killPlayer(p, killerSlot) {
  if (!p.alive) return;
  p.alive = false;
  p.deaths++;
  for (const c of p.trail) {
    if (trailGrid[idx(c.x, c.y)] === p.slot) trailGrid[idx(c.x, c.y)] = -1;
  }
  p.trail = [];

  if (killerSlot !== null && killerSlot !== undefined && killerSlot !== p.slot) {
    const killerId = slotToId[killerSlot];
    const killer = players[killerId];
    if (killer) {
      killer.kills++;
      recalcScore(killer.slot);
      io.to(killerId).emit('killConfirm', { victim: p.name });
    }
  }

  io.emit('playerDied', { id: p.id, x: p.x, y: p.y, color: p.color });
  io.to(p.id).emit('youDied', { respawnMs: RESPAWN_MS });

  setTimeout(() => {
    if (!players[p.id]) return;
    const spot = randomFreeSpot();
    p.x = spot.x + 0.5;
    p.y = spot.y + 0.5;
    p.cellX = spot.x;
    p.cellY = spot.y;
    p.dir = DIRS[0];
    p.angle = DIRS[0].angle;
    p.alive = true;
    claimStartArea(p.slot, spot.x, spot.y);
    recalcScore(p.slot);
  }, RESPAWN_MS);
}

// Flood-fill ile kapatilan alani hesaplayip oyuncuya ata
function captureArea(p) {
  const blocked = new Uint8Array(GRID_W * GRID_H);
  for (let i = 0; i < territoryGrid.length; i++) {
    if (territoryGrid[i] === p.slot) blocked[i] = 1;
  }
  for (const c of p.trail) blocked[idx(c.x, c.y)] = 1;

  const outside = new Uint8Array(GRID_W * GRID_H);
  const queue = [];

  function pushIfOpen(x, y) {
    const i = idx(x, y);
    if (!blocked[i] && !outside[i]) { outside[i] = 1; queue.push(i); }
  }
  for (let x = 0; x < GRID_W; x++) { pushIfOpen(x, 0); pushIfOpen(x, GRID_H - 1); }
  for (let y = 0; y < GRID_H; y++) { pushIfOpen(0, y); pushIfOpen(GRID_W - 1, y); }

  while (queue.length) {
    const i = queue.pop();
    const x = i % GRID_W, y = Math.floor(i / GRID_W);
    if (x + 1 < GRID_W) pushIfOpen(x + 1, y);
    if (x - 1 >= 0) pushIfOpen(x - 1, y);
    if (y + 1 < GRID_H) pushIfOpen(x, y + 1);
    if (y - 1 >= 0) pushIfOpen(x, y - 1);
  }

  const affectedSlots = new Set([p.slot]);
  for (let i = 0; i < territoryGrid.length; i++) {
    if (!blocked[i] && !outside[i]) {
      const prevOwner = territoryGrid[i];
      if (prevOwner !== -1 && prevOwner !== p.slot) affectedSlots.add(prevOwner);
      territoryGrid[i] = p.slot;
    }
  }
  for (const c of p.trail) {
    const i = idx(c.x, c.y);
    territoryGrid[i] = p.slot;
    trailGrid[i] = -1;
  }
  p.trail = [];

  for (const slot of affectedSlots) recalcScore(slot);
}

// ---------------------------------------------------------
// SOCKET.IO BAGLANTILARI
// ---------------------------------------------------------
io.on('connection', (socket) => {
  socket.emit('connected', {
    gridW: GRID_W, gridH: GRID_H, cell: CELL,
    palette: COLORS
  });

  socket.on('join', (data) => {
    if (players[socket.id]) return; // zaten oyunda
    const name = sanitizeName(data && data.name);
    const color = sanitizeColor(data && data.color);
    const p = spawnPlayer(socket, name, color);
    if (!p) {
      socket.emit('serverFull');
      return;
    }
    socket.emit('init', {
      id: socket.id,
      gridW: GRID_W,
      gridH: GRID_H,
      cell: CELL,
      you: { name: p.name, color: p.color }
    });
  });

  socket.on('setAngle', (angle) => {
    const pl = players[socket.id];
    if (pl && pl.alive && typeof angle === 'number' && !isNaN(angle)) {
      pl.dir = snapDir(angle);
    }
  });

  socket.on('disconnect', () => {
    const pl = players[socket.id];
    if (!pl) return;
    clearPlayerCells(pl.slot);
    freeSlots.push(pl.slot);
    delete slotToId[pl.slot];
    delete players[socket.id];
  });
});

// ---------------------------------------------------------
// OYUN DONGUSU (TICK)
// ---------------------------------------------------------
function tick() {
  for (const id in players) {
    const p = players[id];
    if (!p.alive) continue;

    p.angle = p.dir.angle;
    p.x += p.dir.x * SPEED;
    p.y += p.dir.y * SPEED;

    if (p.x < 0 || p.y < 0 || p.x >= GRID_W || p.y >= GRID_H) {
      p.x = Math.max(0, Math.min(GRID_W - 0.01, p.x));
      p.y = Math.max(0, Math.min(GRID_H - 0.01, p.y));
      killPlayer(p, null);
      continue;
    }

    const newCellX = Math.floor(p.x);
    const newCellY = Math.floor(p.y);
    if (newCellX === p.cellX && newCellY === p.cellY) continue;

    p.cellX = newCellX; p.cellY = newCellY;
    const i = idx(newCellX, newCellY);

    if (trailGrid[i] !== -1) {
      const trailOwnerSlot = trailGrid[i];
      killPlayer(p, trailOwnerSlot === p.slot ? null : trailOwnerSlot);
      continue;
    }

    if (territoryGrid[i] === p.slot) {
      if (p.trail.length > 0) {
        captureArea(p);
      }
    } else {
      p.trail.push({ x: newCellX, y: newCellY });
      trailGrid[i] = p.slot;
    }
  }

  broadcastState();
}

function broadcastState() {
  const playerList = Object.values(players).map(p => ({
    id: p.id,
    slot: p.slot,
    name: p.name,
    color: p.color,
    x: p.x,
    y: p.y,
    angle: p.angle,
    alive: p.alive,
    score: p.score,
    areaCells: p.areaCells,
    trail: p.trail
  }));

  const slotColors = {};
  for (const p of Object.values(players)) slotColors[p.slot] = p.color;

  io.emit('state', {
    players: playerList,
    territory: territoryGrid,
    slotColors,
    totalCells: GRID_W * GRID_H
  });
}

setInterval(tick, TICK_MS);

server.listen(PORT, () => {
  console.log(`Neon Arena sunucusu calisiyor -> http://localhost:${PORT}`);
});
