// ==========================================================
//  NEON ARENA - server.js
//  Express + Socket.io ile gercek zamanli coklu oyunculu
//  paper.io tarzi 4 yonlu "iz birak / alan kapla" oyunu.
//
//  Bu surumde eklenen/optimize edilenler:
//   - Territory artik her tick'te TAM gonderilmiyor; sadece
//     degisen hucreler (delta) yayinlaniyor. Yeni baglanan
//     istemci 'init' event'inde tam grid'i bir kez aliyor.
//   - Skor hesaplama O(grid) tarama yerine O(1) sayaçla yapiliyor
//     (slotAreaCount).
//   - setAngle event'i rate-limit'li (asiri hizli spam yok sayilir).
//   - Kafa kafaya çarpışma: ayni hucrede iki canli oyuncu varsa
//     ikisi de elenir.
//   - Benzersiz renk garantisi (uniqueColor).
//   - Öldüren kişinin adı 'youDied' event'inde client'a gonderiliyor.
//   - Basit, kalici (sunucu ayakta oldugu surece) Hall of Fame
//     (en yuksek skorlar) - ayri, seyrek yayinlanan bir event.
//   - Hesap sistemi YERINE, cihaz bazli kalici profil: istemci
//     localStorage'da rastgele bir deviceId tutar, sunucu bu id'ye
//     bagli en iyi skor / toplam kill / oynanan mac sayisini bir
//     JSON dosyasinda (data/profiles.json) SAKLAR - sunucu yeniden
//     baslasa bile kaybolmaz. Sifre/giris yok, sifir surtunme.
//
//  Calistirmak icin:
//    npm install express socket.io
//    node server.js
//    -> http://localhost:3000
// ==========================================================

const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);

// Production'da ALLOWED_ORIGIN env degiskenini kendi domain'ine
// ayarlaman onerilir (orn: https://neon-arena-kqdn.onrender.com)
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';
const io = new Server(server, {
  cors: { origin: ALLOWED_ORIGIN }
});

app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;

// ---------------------------------------------------------
// OYUN SABITLERI
// ---------------------------------------------------------
const GRID_W = 110;         // grid genisligi (hucre)
const GRID_H = 74;          // grid yuksekligi (hucre)
const CELL = 20;            // istemcide 1 hucre = 20px (bilgi amacli)
const TICK_MS = 50;         // 20 tick/sn
const SPEED = 0.16;         // hucre / tick
const MAX_PLAYERS = 32;
const KILL_BONUS = 10;
const RESPAWN_MS = 2000;
const MAX_NAME_LEN = 14;
const MIN_ANGLE_INTERVAL_MS = 40; // setAngle rate-limit (tick'ten biraz kisa)
const HALL_OF_FAME_SIZE = 10;
const HALL_OF_FAME_BROADCAST_MS = 4000;

const NAMES = ['Falcon','Viper','Nova','Blaze','Ghost','Volt','Zephyr','Raven',
  'Comet','Nero','Lynx','Storm','Kilo','Onyx','Pixel','Turbo','Nyx','Rogue'];
const COLORS = ['#ff2079','#00b8d4','#7cc900','#ff9500','#8a3ffc','#ff5c5c',
  '#00b894','#e91e8c','#0fb5d6','#c9a400','#ff6a00','#2ecc71'];

const HEX_RE = /^#[0-9a-fA-F]{6}$/;
const DEVICE_ID_RE = /^[a-zA-Z0-9_-]{8,64}$/;
const PROFILES_FILE = path.join(__dirname, 'data', 'profiles.json');
const PROFILE_SAVE_INTERVAL_MS = 5000;

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

// slot -> kac hucreye sahip (O(1) skor icin)
const slotAreaCount = new Array(MAX_PLAYERS).fill(0);

// Bu tick'te degisen territory hucreleri: index -> yeni slot degeri
let dirtyCells = new Map();

const players = {};       // socket.id -> player object
const slotToId = {};      // slot -> socket.id
let freeSlots = [];
for (let i = MAX_PLAYERS - 1; i >= 0; i--) freeSlots.push(i);

// Sunucu ayakta oldugu surece kalici en iyi skorlar
let hallOfFame = []; // [{name, score}] skora gore azalan

function idx(x, y) { return y * GRID_W + x; }
function inBounds(x, y) { return x >= 0 && y >= 0 && x < GRID_W && y < GRID_H; }

// Territory hucresini gunceller, alan sayaclarini ve dirty-set'i
// tutarli tutar. Her yerde dogrudan atama yerine BUNU kullan.
function setTerritory(i, slot) {
  const prev = territoryGrid[i];
  if (prev === slot) return;
  if (prev !== -1) slotAreaCount[prev]--;
  if (slot !== -1) slotAreaCount[slot] = (slotAreaCount[slot] || 0) + 1;
  territoryGrid[i] = slot;
  dirtyCells.set(i, slot);
}

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

function sanitizeDeviceId(raw) {
  return (typeof raw === 'string' && DEVICE_ID_RE.test(raw)) ? raw : null;
}

// ---------------------------------------------------------
// CIHAZ BAZLI KALICI PROFIL (hesap sistemi yerine hafif alternatif)
// ---------------------------------------------------------
let deviceProfiles = {};   // deviceId -> { name, bestScore, totalKills, gamesPlayed, bestArea }
let profilesDirty = false;

function loadProfiles() {
  try {
    if (fs.existsSync(PROFILES_FILE)) {
      deviceProfiles = JSON.parse(fs.readFileSync(PROFILES_FILE, 'utf8'));
      console.log(`Profiller yuklendi: ${Object.keys(deviceProfiles).length} cihaz`);
    }
  } catch (err) {
    console.error('Profiller okunamadi, bos baslaniyor:', err.message);
    deviceProfiles = {};
  }
}

function saveProfilesIfDirty() {
  if (!profilesDirty) return;
  profilesDirty = false;
  const dir = path.dirname(PROFILES_FILE);
  try {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(PROFILES_FILE, JSON.stringify(deviceProfiles));
  } catch (err) {
    console.error('Profiller kaydedilemedi:', err.message);
  }
}

function getOrCreateProfile(deviceId) {
  if (!deviceProfiles[deviceId]) {
    deviceProfiles[deviceId] = { name: null, bestScore: 0, bestArea: 0, totalKills: 0, gamesPlayed: 0 };
  }
  return deviceProfiles[deviceId];
}

function profileOnJoin(deviceId, name) {
  if (!deviceId) return;
  const prof = getOrCreateProfile(deviceId);
  prof.gamesPlayed++;
  if (name) prof.name = name;
  profilesDirty = true;
}

function profileOnKill(deviceId) {
  if (!deviceId) return;
  const prof = getOrCreateProfile(deviceId);
  prof.totalKills++;
  profilesDirty = true;
}

function profileOnScore(deviceId, score, areaCells) {
  if (!deviceId) return;
  const prof = getOrCreateProfile(deviceId);
  let changed = false;
  if (score > prof.bestScore) { prof.bestScore = score; changed = true; }
  if (areaCells > prof.bestArea) { prof.bestArea = areaCells; changed = true; }
  if (changed) profilesDirty = true;
}

loadProfiles();

// Rengin baska bir aktif oyuncuda kullanilmadigindan emin olur.
function uniqueColor(preferred) {
  const taken = new Set(Object.values(players).map(p => p.color));
  if (preferred && !taken.has(preferred)) return preferred;
  for (const c of COLORS) if (!taken.has(c)) return c;
  // Palet de dolu ise rastgele hafif varyasyon uret
  const base = preferred || COLORS[Math.floor(Math.random() * COLORS.length)];
  const r = Math.min(255, Math.max(0, parseInt(base.slice(1,3),16) + (Math.random()>0.5?20:-20)));
  const g = Math.min(255, Math.max(0, parseInt(base.slice(3,5),16) + (Math.random()>0.5?20:-20)));
  const b = Math.min(255, Math.max(0, parseInt(base.slice(5,7),16) + (Math.random()>0.5?20:-20)));
  return '#' + [r,g,b].map(v => v.toString(16).padStart(2,'0')).join('');
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
      if (inBounds(nx, ny)) setTerritory(idx(nx, ny), slot);
    }
  }
}

function clearPlayerCells(slot) {
  for (let i = 0; i < territoryGrid.length; i++) {
    if (territoryGrid[i] === slot) setTerritory(i, -1);
    if (trailGrid[i] === slot) trailGrid[i] = -1;
  }
}

function recalcScore(slot) {
  const id = slotToId[slot];
  const p = players[id];
  if (!p) return;
  p.areaCells = slotAreaCount[slot] || 0;
  p.score = p.areaCells + p.kills * KILL_BONUS;
  if (p.deviceId) profileOnScore(p.deviceId, p.score, p.areaCells);
}

function updateHallOfFame(name, score) {
  if (score <= 0) return;
  const existing = hallOfFame.find(e => e.name === name);
  if (existing) {
    if (score > existing.score) existing.score = score;
  } else {
    hallOfFame.push({ name, score });
  }
  hallOfFame.sort((a, b) => b.score - a.score);
  if (hallOfFame.length > HALL_OF_FAME_SIZE) hallOfFame.length = HALL_OF_FAME_SIZE;
}

function spawnPlayer(socket, name, color, deviceId) {
  const slot = freeSlots.pop();
  if (slot === undefined) return null; // sunucu dolu

  const spot = randomFreeSpot();
  const dir = DIRS[0];
  const p = {
    id: socket.id,
    slot,
    name: uniqueName(name || (NAMES[Math.floor(Math.random() * NAMES.length)] + '-' + Math.floor(Math.random() * 90 + 10))),
    color: uniqueColor(color),
    deviceId: deviceId || null,
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
    joinedAt: Date.now(),
    lastAngleAt: 0
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

  let killerName = null;
  if (killerSlot !== null && killerSlot !== undefined && killerSlot !== p.slot) {
    const killerId = slotToId[killerSlot];
    const killer = players[killerId];
    if (killer) {
      killer.kills++;
      recalcScore(killer.slot);
      killerName = killer.name;
      if (killer.deviceId) profileOnKill(killer.deviceId);
      io.to(killerId).emit('killConfirm', { victim: p.name });
    }
  }

  updateHallOfFame(p.name, p.score);

  io.emit('playerDied', { id: p.id, x: p.x, y: p.y, color: p.color });
  io.to(p.id).emit('youDied', { respawnMs: RESPAWN_MS, killerName });

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
      setTerritory(i, p.slot);
    }
  }
  for (const c of p.trail) {
    const i = idx(c.x, c.y);
    setTerritory(i, p.slot);
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

  // Istemci baglanir baglanmaz kendi deviceId'sini bildirir; sunucu
  // varsa gecmis profilini (en iyi skor, toplam kill vb.) geri yollar.
  // Bu, sifre/hesap OLMADAN "beni hatirla" hissi verir.
  socket.on('identify', (data) => {
    const deviceId = sanitizeDeviceId(data && data.deviceId);
    if (!deviceId) return;
    socket.deviceId = deviceId;
    const prof = getOrCreateProfile(deviceId);
    socket.emit('profile', prof);
  });

  socket.on('join', (data) => {
    if (players[socket.id]) return; // zaten oyunda
    const name = sanitizeName(data && data.name);
    const color = sanitizeColor(data && data.color);
    const deviceId = sanitizeDeviceId((data && data.deviceId)) || socket.deviceId || null;
    const p = spawnPlayer(socket, name, color, deviceId);
    if (!p) {
      socket.emit('serverFull');
      return;
    }
    profileOnJoin(deviceId, p.name);
    // Yeni baglanan istemciye TAM territory anlik goruntusu -
    // bundan sonraki 'state' event'leri sadece delta gonderecek.
    socket.emit('init', {
      id: socket.id,
      gridW: GRID_W,
      gridH: GRID_H,
      cell: CELL,
      you: { name: p.name, color: p.color },
      territory: territoryGrid,
      slotColors: currentSlotColors(),
      hallOfFame
    });
  });

  socket.on('setAngle', (angle) => {
    const pl = players[socket.id];
    if (!pl || !pl.alive) return;
    if (typeof angle !== 'number' || isNaN(angle)) return;
    const now = Date.now();
    if (now - pl.lastAngleAt < MIN_ANGLE_INTERVAL_MS) return; // rate-limit
    pl.lastAngleAt = now;
    pl.dir = snapDir(angle);
  });

  socket.on('disconnect', () => {
    const pl = players[socket.id];
    if (!pl) return;
    updateHallOfFame(pl.name, pl.score);
    clearPlayerCells(pl.slot);
    freeSlots.push(pl.slot);
    delete slotToId[pl.slot];
    delete players[socket.id];
  });
});

function currentSlotColors() {
  const slotColors = {};
  for (const p of Object.values(players)) slotColors[p.slot] = p.color;
  return slotColors;
}

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

  // Kafa kafaya çarpışma: ayni hucrede birden fazla canli oyuncu varsa
  // hepsi elenir (karsilikli, kill bonusu yok - adil mutual kill).
  const cellMap = new Map();
  for (const id in players) {
    const p = players[id];
    if (!p.alive) continue;
    const key = p.cellX * GRID_H + p.cellY;
    if (!cellMap.has(key)) cellMap.set(key, []);
    cellMap.get(key).push(p);
  }
  for (const group of cellMap.values()) {
    if (group.length > 1) {
      for (const p of group) killPlayer(p, null);
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

  // Sadece bu tick'te degisen hucreler gonderiliyor.
  const territoryDelta = [];
  for (const [i, slot] of dirtyCells) territoryDelta.push(i, slot);
  dirtyCells.clear();

  io.emit('state', {
    players: playerList,
    territoryDelta,           // [idx, slot, idx, slot, ...] duz dizi (kompakt)
    slotColors: currentSlotColors(),
    totalCells: GRID_W * GRID_H
  });
}

setInterval(tick, TICK_MS);

// Hall of Fame'i seyrek yayinla (her tick'te degil - trafik tasarrufu)
setInterval(() => {
  io.emit('hallOfFame', hallOfFame);
}, HALL_OF_FAME_BROADCAST_MS);

// Cihaz profillerini disk'e sadece degistiyse ve seyrek yaz (I/O tasarrufu)
setInterval(saveProfilesIfDirty, PROFILE_SAVE_INTERVAL_MS);
process.on('SIGINT', () => { profilesDirty = true; saveProfilesIfDirty(); process.exit(0); });
process.on('SIGTERM', () => { profilesDirty = true; saveProfilesIfDirty(); process.exit(0); });

server.listen(PORT, () => {
  console.log(`Neon Arena sunucusu calisiyor -> http://localhost:${PORT}`);
});
