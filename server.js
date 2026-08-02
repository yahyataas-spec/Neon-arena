// ==========================================================
//  NEON ARENA - server.js
//  Express + Socket.io ile gercek zamanli coklu oyunculu
//  "trail / territory" (iz birakma + alan kaplama) oyunu.
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
const GRID_W = 60;          // grid genisligi (hucre)
const GRID_H = 40;          // grid yuksekligi (hucre)
const CELL = 20;            // istemcide 1 hucre = 20px (bilgi amacli)
const TICK_MS = 50;         // 20 tick/sn
const SPEED = 0.12;         // hucre / tick
const TURN_RATE = 0.18;     // rad / tick (donus hizi limiti)
const MAX_PLAYERS = 24;
const KILL_BONUS = 10;
const RESPAWN_MS = 2000;

const NAMES = ['Falcon','Viper','Nova','Blaze','Ghost','Volt','Zephyr','Raven',
  'Comet','Nero','Lynx','Storm','Kilo','Onyx','Pixel','Turbo','Nyx','Rogue'];
const COLORS = ['#ff2079','#00e5ff','#7cff00','#ffb700','#b967ff','#ff5c5c',
  '#00ffa3','#ff8ac9','#5cf0ff','#f5ff5c','#ff6a00','#4dff4d'];

// ---------------------------------------------------------
// DURUM
// ---------------------------------------------------------
// territoryGrid / trailGrid: her hucre icin -1 (bos) ya da "slot" (0..MAX_PLAYERS-1)
let territoryGrid = new Array(GRID_W * GRID_H).fill(-1);
let trailGrid = new Array(GRID_W * GRID_H).fill(-1);

const players = {};       // socket.id -> player object
const slotToId = {};      // slot -> socket.id
let freeSlots = [];
for (let i = MAX_PLAYERS - 1; i >= 0; i--) freeSlots.push(i);

function idx(x, y) { return y * GRID_W + x; }
function inBounds(x, y) { return x >= 0 && y >= 0 && x < GRID_W && y < GRID_H; }

function randomFreeSpot() {
  for (let tries = 0; tries < 300; tries++) {
    const x = 3 + Math.floor(Math.random() * (GRID_W - 6));
    const y = 3 + Math.floor(Math.random() * (GRID_H - 6));
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
  p.score = countTerritory(slot) + p.kills * KILL_BONUS;
}

function spawnPlayer(socket) {
  const slot = freeSlots.pop();
  if (slot === undefined) return null; // sunucu dolu

  const spot = randomFreeSpot();
  const p = {
    id: socket.id,
    slot,
    name: NAMES[Math.floor(Math.random() * NAMES.length)] + '-' + Math.floor(Math.random() * 90 + 10),
    color: COLORS[Math.floor(Math.random() * COLORS.length)],
    x: spot.x + 0.5,
    y: spot.y + 0.5,
    cellX: spot.x,
    cellY: spot.y,
    angle: -Math.PI / 2,
    desiredAngle: -Math.PI / 2,
    alive: true,
    trail: [],       // [{x,y}] - o anki gecici iz (hucre koordinatlari)
    score: 9,
    kills: 0,
    deaths: 0
  };
  claimStartArea(slot, spot.x, spot.y);
  players[socket.id] = p;
  slotToId[slot] = socket.id;
  return p;
}

function killPlayer(p, killerSlot) {
  if (!p.alive) return;
  p.alive = false;
  p.deaths++;
  // izini serbest birak
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

  io.to(p.id).emit('youDied', { respawnMs: RESPAWN_MS });

  setTimeout(() => {
    if (!players[p.id]) return; // baglantisi kesilmis olabilir
    const spot = randomFreeSpot();
    p.x = spot.x + 0.5;
    p.y = spot.y + 0.5;
    p.cellX = spot.x;
    p.cellY = spot.y;
    p.angle = -Math.PI / 2;
    p.desiredAngle = -Math.PI / 2;
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

  for (let x = 0; x < GRID_W; x++) {
    pushIfOpen(x, 0); pushIfOpen(x, GRID_H - 1);
  }
  for (let y = 0; y < GRID_H; y++) {
    pushIfOpen(0, y); pushIfOpen(GRID_W - 1, y);
  }
  function pushIfOpen(x, y) {
    const i = idx(x, y);
    if (!blocked[i] && !outside[i]) { outside[i] = 1; queue.push(i); }
  }

  while (queue.length) {
    const i = queue.pop();
    const x = i % GRID_W, y = Math.floor(i / GRID_W);
    const neighbors = [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]];
    for (const [nx, ny] of neighbors) {
      if (!inBounds(nx, ny)) continue;
      const ni = idx(nx, ny);
      if (!blocked[ni] && !outside[ni]) { outside[ni] = 1; queue.push(ni); }
    }
  }

  const affectedSlots = new Set([p.slot]);
  for (let i = 0; i < territoryGrid.length; i++) {
    if (!blocked[i] && !outside[i]) {
      // cevrelenmis hucre -> ele gecir
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

function stepAngle(current, target, maxDelta) {
  let diff = ((target - current + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
  if (diff > maxDelta) diff = maxDelta;
  if (diff < -maxDelta) diff = -maxDelta;
  return current + diff;
}

// ---------------------------------------------------------
// SOCKET.IO BAGLANTILARI
// ---------------------------------------------------------
io.on('connection', (socket) => {
  const p = spawnPlayer(socket);
  if (!p) {
    socket.emit('serverFull');
    socket.disconnect(true);
    return;
  }

  socket.emit('init', {
    id: socket.id,
    gridW: GRID_W,
    gridH: GRID_H,
    cell: CELL,
    you: { name: p.name, color: p.color }
  });

  socket.on('setAngle', (angle) => {
    const pl = players[socket.id];
    if (pl && pl.alive && typeof angle === 'number' && !isNaN(angle)) {
      pl.desiredAngle = angle;
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

    p.angle = stepAngle(p.angle, p.desiredAngle, TURN_RATE);
    p.x += Math.cos(p.angle) * SPEED;
    p.y += Math.sin(p.angle) * SPEED;

    if (p.x < 0 || p.y < 0 || p.x >= GRID_W || p.y >= GRID_H) {
      killPlayer(p, null);
      continue;
    }

    const newCellX = Math.floor(p.x);
    const newCellY = Math.floor(p.y);
    if (newCellX === p.cellX && newCellY === p.cellY) continue;

    p.cellX = newCellX; p.cellY = newCellY;
    const i = idx(newCellX, newCellY);

    // baska/kendi bir ize carpma -> olum
    if (trailGrid[i] !== -1) {
      const trailOwnerSlot = trailGrid[i];
      killPlayer(p, trailOwnerSlot === p.slot ? null : trailOwnerSlot);
      continue;
    }

    if (territoryGrid[i] === p.slot) {
      // kendi topragina donus
      if (p.trail.length > 0) {
        captureArea(p);
      }
    } else {
      // topraksiz/dusman bolge -> iz birak
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
