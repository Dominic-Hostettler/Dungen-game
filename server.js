// ============================================================
// LEO DUNGEON RPG - Server
// Autoritativer Echtzeit-Multiplayer-Server (Node.js + Socket.io)
// ============================================================

const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const { MongoClient } = require('mongodb');
const bcrypt = require('bcryptjs');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  perMessageDeflate: true
});

app.use(express.static(path.join(__dirname, 'public')));

// ---------------- Datenbank (Accounts / dauerhafter Fortschritt) ----------------
const MONGO_URI = process.env.MONGO_URI || '';
let accountsCol = null;

async function initDb() {
  if (!MONGO_URI) {
    console.warn('WARNUNG: MONGO_URI ist nicht gesetzt. Accounts werden NICHT gespeichert (nur In-Memory, geht bei Neustart verloren).');
    return;
  }
  try {
    const client = new MongoClient(MONGO_URI);
    await client.connect();
    const db = client.db('leo_dungeon_rpg');
    accountsCol = db.collection('accounts');
    await accountsCol.createIndex({ username: 1 }, { unique: true });
    console.log('MongoDB verbunden - Accounts werden dauerhaft gespeichert.');
  } catch (err) {
    console.error('MongoDB-Verbindung fehlgeschlagen:', err.message);
  }
}
initDb();

async function loadAccount(username) {
  if (!accountsCol) return null;
  return accountsCol.findOne({ username });
}

async function createAccount(username, passwordHash, cls) {
  const doc = {
    username, passwordHash, cls,
    level: 1, xp: 0, gold: 0, potions: 1, speedPotions: 0,
    upgDmg: 0, upgHp: 0, upgSpeed: 0,
    createdAt: new Date()
  };
  if (accountsCol) await accountsCol.insertOne(doc);
  return doc;
}

async function saveAccountProgress(p) {
  if (!accountsCol || !p.username) return;
  try {
    await accountsCol.updateOne(
      { username: p.username },
      { $set: {
        level: p.level, xp: p.xp, gold: p.gold, potions: p.potions, speedPotions: p.speedPotions, cls: p.cls,
        upgDmg: p.upgDmg, upgHp: p.upgHp, upgSpeed: p.upgSpeed
      } }
    );
  } catch (err) {
    console.error('Speichern fehlgeschlagen fuer', p.username, err.message);
  }
}

// ---------------- Konfiguration ----------------
const TILE = 32;
const TICK_RATE = 20; // Server-Ticks pro Sekunde
const MAX_PLAYERS_PER_DUNGEON = 6;

// Dungeon-Layout: 1 = Wand, 0 = Boden
// Prozedural generiert (Randomized-DFS-Raumgraph), garantiert zusammenhaengend.
function generateDungeon(gridW, gridH, cellSize) {
  const W = gridW * cellSize + 1;
  const H = gridH * cellSize + 1;
  const grid = [];
  for (let y = 0; y < H; y++) grid.push(new Array(W).fill('1'));

  const idx = (gx, gy) => gy * gridW + gx;
  const visited = new Uint8Array(gridW * gridH);
  const stack = [[0, 0]];
  visited[idx(0, 0)] = 1;
  const edges = [];

  while (stack.length) {
    const [cx, cy] = stack[stack.length - 1];
    const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    const options = [];
    for (const [dx, dy] of dirs) {
      const nx = cx + dx, ny = cy + dy;
      if (nx >= 0 && ny >= 0 && nx < gridW && ny < gridH && !visited[idx(nx, ny)]) options.push([nx, ny]);
    }
    if (options.length) {
      const [nx, ny] = options[Math.floor(Math.random() * options.length)];
      visited[idx(nx, ny)] = 1;
      edges.push([[cx, cy], [nx, ny]]);
      stack.push([nx, ny]);
    } else {
      stack.pop();
    }
  }

  const margin = 1;
  function carveRoom(gx, gy) {
    // Zufaellige Raumgroesse pro Zelle (zentriert), mehr Abwechslung statt immer gleicher Quadrate
    const maxSize = cellSize - 2 * margin;
    const size = Math.max(4, maxSize - Math.floor(Math.random() * 3));
    const off = Math.floor((maxSize - size) / 2);
    const sx = gx * cellSize + margin + off, sy = gy * cellSize + margin + off;
    for (let y = 0; y < size; y++) {
      const row = grid[sy + y];
      for (let x = 0; x < size; x++) row[sx + x] = '0';
    }
  }
  function roomCenter(gx, gy) {
    return { x: gx * cellSize + Math.floor(cellSize / 2), y: gy * cellSize + Math.floor(cellSize / 2) };
  }
  function carveCorridor(a, b) {
    let x = a.x, y = a.y;
    const horizFirst = Math.random() < 0.5;
    if (horizFirst) {
      while (x !== b.x) { grid[y][x] = '0'; x += x < b.x ? 1 : -1; }
      while (y !== b.y) { grid[y][x] = '0'; y += y < b.y ? 1 : -1; }
    } else {
      while (y !== b.y) { grid[y][x] = '0'; y += y < b.y ? 1 : -1; }
      while (x !== b.x) { grid[y][x] = '0'; x += x < b.x ? 1 : -1; }
    }
    grid[b.y][b.x] = '0';
  }

  for (let gy = 0; gy < gridH; gy++) for (let gx = 0; gx < gridW; gx++) carveRoom(gx, gy);
  for (const [a, b] of edges) carveCorridor(roomCenter(a[0], a[1]), roomCenter(b[0], b[1]));

  // Zusaetzliche zufaellige Verbindungen zwischen Nachbarzellen -> Schleifen statt reinem Baum,
  // das macht das Layout weniger vorhersehbar / abwechslungsreicher
  for (let gy = 0; gy < gridH; gy++) {
    for (let gx = 0; gx < gridW; gx++) {
      if (gx + 1 < gridW && Math.random() < 0.12) carveCorridor(roomCenter(gx, gy), roomCenter(gx + 1, gy));
      if (gy + 1 < gridH && Math.random() < 0.12) carveCorridor(roomCenter(gx, gy), roomCenter(gx, gy + 1));
    }
  }

  return grid.map(r => r.join(''));
}

function makeArena(w, h) {
  const rows = [];
  for (let y = 0; y < h; y++) {
    let row = '';
    for (let x = 0; x < w; x++) {
      row += (x === 0 || y === 0 || x === w - 1 || y === h - 1) ? '1' : '0';
    }
    rows.push(row);
  }
  return rows;
}

function buildMapInfo(rows, w, h) {
  function isWall(tx, ty) {
    if (tx < 0 || ty < 0 || tx >= w || ty >= h) return true;
    return rows[ty][tx] === '1';
  }
  function isFloor(tx, ty) { return !isWall(tx, ty); }
  const floor = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (isFloor(x, y)) floor.push({ x, y });
    }
  }
  return { rows, w, h, isWall, isFloor, floor };
}

// ---------------- Dungeon-Stufen (abhaengig vom Spieler-Level) ----------------
const DUNGEON_TIER_DEFS = [
  { key: 'tier1', name: 'Anfänger-Dungeon', minLevel: 1, gridW: 25, gridH: 5, cellSize: 10, monsterMult: 1, lootMult: 1 },
  { key: 'tier2', name: 'Fortgeschrittenen-Dungeon', minLevel: 10, gridW: 25, gridH: 5, cellSize: 10, monsterMult: 2.6, lootMult: 1.6 },
  { key: 'tier3', name: 'Experten-Dungeon', minLevel: 25, gridW: 25, gridH: 5, cellSize: 10, monsterMult: 5, lootMult: 2.4 }
];
const DUNGEON_TIERS = {};
for (const def of DUNGEON_TIER_DEFS) {
  const rows = generateDungeon(def.gridW, def.gridH, def.cellSize);
  DUNGEON_TIERS[def.key] = { ...def, rows, map: buildMapInfo(rows, rows[0].length, rows.length) };
}
const DEFAULT_TIER_KEY = DUNGEON_TIER_DEFS[0].key;
function tierForLevel(level) {
  let chosen = DUNGEON_TIER_DEFS[0];
  for (const def of DUNGEON_TIER_DEFS) if (level >= def.minLevel) chosen = def;
  return chosen.key;
}
function isDungeonTier(zone) { return !!DUNGEON_TIERS[zone]; }

const ARENA_ROWS = makeArena(20, 13);
const ARENA = buildMapInfo(ARENA_ROWS, ARENA_ROWS[0].length, ARENA_ROWS.length);
const BOSSROOM_ROWS = makeArena(24, 16);
const BOSSROOM = buildMapInfo(BOSSROOM_ROWS, BOSSROOM_ROWS[0].length, BOSSROOM_ROWS.length);

function mapFor(zone) {
  if (zone === 'arena') return ARENA;
  if (zone === 'bossroom') return BOSSROOM;
  if (DUNGEON_TIERS[zone]) return DUNGEON_TIERS[zone].map;
  return DUNGEON_TIERS[DEFAULT_TIER_KEY].map;
}

function randomFloorTile(zone) {
  const m = mapFor(zone);
  return m.floor[Math.floor(Math.random() * m.floor.length)];
}
function randomTierSpawn(zone) {
  const t = randomFloorTile(zone || DEFAULT_TIER_KEY);
  return { x: t.x * TILE + TILE / 2, y: t.y * TILE + TILE / 2 };
}
const ARENA_SPAWN_TILE = ARENA.floor[Math.floor(ARENA.floor.length / 2)];
const ARENA_SPAWN = { x: ARENA_SPAWN_TILE.x * TILE + TILE / 2, y: ARENA_SPAWN_TILE.y * TILE + TILE / 2 };
const BOSSROOM_ENTRY_TILE = BOSSROOM.floor[Math.floor(BOSSROOM.floor.length * 0.15)];
const BOSSROOM_ENTRY = { x: BOSSROOM_ENTRY_TILE.x * TILE + TILE / 2, y: BOSSROOM_ENTRY_TILE.y * TILE + TILE / 2 };
const BOSSROOM_CENTER_TILE = BOSSROOM.floor[Math.floor(BOSSROOM.floor.length / 2)];
const BOSSROOM_CENTER = { x: BOSSROOM_CENTER_TILE.x * TILE + TILE / 2, y: BOSSROOM_CENTER_TILE.y * TILE + TILE / 2 };

// ---------------- Klassen-Definitionen ----------------
const CLASSES = {
  krieger: { name: 'Krieger', maxHp: 150, speed: 2.4, dmg: 18, range: 42, cooldown: 500, kind: 'melee', color: '#e74c3c' },
  magier:  { name: 'Magier',  maxHp: 80,  speed: 2.1, dmg: 24, range: 240, cooldown: 750, kind: 'ranged', color: '#3498db' },
  schurke: { name: 'Schurke', maxHp: 100, speed: 3.0, dmg: 13, range: 36, cooldown: 320, kind: 'melee', color: '#2ecc71', crit: 0.25 }
};

function statsForLevel(clsKey, level) {
  const def = CLASSES[clsKey] || CLASSES.krieger;
  const lvlBonus = Math.max(0, level - 1);
  return {
    maxHp: def.maxHp + lvlBonus * 18,
    dmg: def.dmg + lvlBonus * 3
  };
}

function recomputeStats(p) {
  const base = statsForLevel(p.cls, p.level);
  p.maxHp = base.maxHp + p.upgHp * 15;
  p.dmg = base.dmg + p.upgDmg * 2;
  p.speed = CLASSES[p.cls].speed + p.upgSpeed * 0.12;
  p.hp = Math.min(p.hp, p.maxHp);
}

const SHOP_ITEMS = {
  potion: { label: 'Heiltrank', baseCost: 12, scale: 0, maxCount: null },
  speedpotion: { label: 'Tempo-Trank (15s +60% Tempo)', baseCost: 15, scale: 0, maxCount: null },
  dmg: { label: 'Waffe schärfen (+2 Schaden)', baseCost: 25, scale: 20, maxCount: 10 },
  hp: { label: 'Rüstung verstärken (+15 max. HP)', baseCost: 25, scale: 20, maxCount: 10 },
  speed: { label: 'Leichtere Stiefel (+Tempo)', baseCost: 30, scale: 25, maxCount: 5 }
};
function shopCost(itemKey, currentCount) {
  const def = SHOP_ITEMS[itemKey];
  return def.baseCost + def.scale * currentCount;
}

// ---------------- Game-State ----------------
const players = {};     // id -> player
const monsters = {};    // id -> monster
const tpaRequests = {}; // targetSocketId -> { fromId, expiresAt }
const items = {};       // id -> ground item
const projectiles = {}; // id -> projectile

let monsterIdCounter = 0;
let itemIdCounter = 0;
let projectileIdCounter = 0;

const MONSTER_TYPES = {
  goblin: { hp: 40, dmg: 8, speed: 1.3, xp: 15, range: 30, cooldown: 900, color: '#8e7c4d', radius: 12 },
  ork:    { hp: 95, dmg: 16, speed: 0.9, xp: 40, range: 34, cooldown: 1200, color: '#5b4636', radius: 16 },
  boss:   { hp: 900, dmg: 32, speed: 1.0, xp: 400, range: 48, cooldown: 900, color: '#c0392b', radius: 26, name: 'Dungeon-Wächter' }
};
const MAX_MONSTERS_PER_TIER = 100;

function spawnMonster(zone) {
  zone = zone || DEFAULT_TIER_KEY;
  const tierDef = DUNGEON_TIERS[zone];
  if (!tierDef) return;
  const countInZone = Object.values(monsters).reduce((n, m) => n + ((m.zone || DEFAULT_TIER_KEY) === zone ? 1 : 0), 0);
  if (countInZone >= MAX_MONSTERS_PER_TIER) return;
  const type = Math.random() < 0.7 ? 'goblin' : 'ork';
  const def = MONSTER_TYPES[type];
  const tile = randomFloorTile(zone);
  const id = 'm' + (monsterIdCounter++);
  const mult = tierDef.monsterMult;
  monsters[id] = {
    id, type, zone, mult,
    x: tile.x * TILE + TILE / 2,
    y: tile.y * TILE + TILE / 2,
    hp: Math.round(def.hp * mult), maxHp: Math.round(def.hp * mult),
    lastAttack: 0,
    targetId: null,
    homeX: tile.x * TILE + TILE / 2,
    homeY: tile.y * TILE + TILE / 2
  };
}

function spawnItem(x, y, zone) {
  zone = zone || DEFAULT_TIER_KEY;
  const roll = Math.random();
  const type = roll < 0.6 ? 'gold' : 'potion';
  const id = 'i' + (itemIdCounter++);
  const lootMult = (DUNGEON_TIERS[zone] && DUNGEON_TIERS[zone].lootMult) || 1;
  const amount = type === 'gold' ? Math.round((5 + Math.floor(Math.random() * 15)) * goldMult() * lootMult) : 1;
  items[id] = { id, type, x, y, amount, zone };
}

// Initiale Monster pro Dungeon-Stufe
for (const key in DUNGEON_TIERS) {
  for (let i = 0; i < 35; i++) spawnMonster(key);
}
setInterval(() => {
  for (const key in DUNGEON_TIERS) {
    for (let i = 0; i < 2; i++) { if (Math.random() < 0.7) spawnMonster(key); }
  }
}, 3000);

// ---------------- Hilfsfunktionen ----------------
function dist(ax, ay, bx, by) {
  return Math.hypot(ax - bx, ay - by);
}

function xpToNextLevel(level) {
  return 80 + level * 60;
}

// ---------------- Events (Doppel-Gold / Doppel-XP) ----------------
let goldEventUntil = 0;
let xpEventUntil = 0;
function goldMult() { return Date.now() < goldEventUntil ? 2 : 1; }
function xpMult() { return Date.now() < xpEventUntil ? 2 : 1; }

function circleHitsWall(mapInfo, x, y, radius) {
  const pts = [
    [x - radius, y - radius], [x + radius, y - radius],
    [x - radius, y + radius], [x + radius, y + radius]
  ];
  for (const [px, py] of pts) {
    if (mapInfo.isWall(Math.floor(px / TILE), Math.floor(py / TILE))) return true;
  }
  return false;
}

function tryMove(mapInfo, entity, dx, dy, radius) {
  const nx = entity.x + dx;
  const ny = entity.y + dy;
  if (!circleHitsWall(mapInfo, nx, entity.y, radius)) entity.x = nx;
  if (!circleHitsWall(mapInfo, entity.x, ny, radius)) entity.y = ny;
}

// ---------------- Truhen ----------------
const CHEST_COUNT_PER_TIER = 14;
const CHEST_RESPAWN_MS = 90000;
const chests = {};
(function initChests() {
  let counter = 1;
  for (const key in DUNGEON_TIERS) {
    const floor = DUNGEON_TIERS[key].map.floor;
    const step = Math.floor(floor.length / (CHEST_COUNT_PER_TIER + 1));
    for (let i = 1; i <= CHEST_COUNT_PER_TIER; i++) {
      const tile = floor[step * i];
      const id = 'c' + (counter++);
      chests[id] = {
        id, zone: key,
        x: tile.x * TILE + TILE / 2,
        y: tile.y * TILE + TILE / 2,
        looted: false,
        respawnAt: 0
      };
    }
  }
})();

function applyPvpDamage(target, dmg, attacker) {
  target.hp -= dmg;
  io.emit('hit', { x: target.x, y: target.y, dmg });
  if (target.hp <= 0 && !target.dead) {
    target.dead = true;
    setTimeout(() => respawnPlayer(target), 2000);
  }
}

function respawnPlayer(p) {
  let sp;
  if (p.zone === 'arena') {
    sp = ARENA_SPAWN;
  } else if (p.zone === 'bossroom') {
    sp = BOSSROOM_ENTRY;
  } else {
    // Beim Respawn automatisch in die zum aktuellen Level passende Stufe wechseln
    p.zone = tierForLevel(p.level);
    sp = randomTierSpawn(p.zone);
  }
  p.x = sp.x;
  p.y = sp.y;
  p.hp = isDungeonTier(p.zone) ? Math.max(1, Math.floor(p.maxHp * 0.5)) : p.maxHp;
  p.dead = false;
}

function levelUp(p) {
  p.level += 1;
  p.xp -= p.xpNext;
  p.xpNext = xpToNextLevel(p.level);
  recomputeStats(p);
  p.hp = p.maxHp;
  saveAccountProgress(p);
}

function grantXp(p, amount) {
  p.xp += Math.round(amount * xpMult());
  while (p.xp >= p.xpNext) levelUp(p);
}

// ---------------- Boss-Zyklus (alle 10 Minuten) ----------------
const BOSS_INTERVAL_MS = 10 * 60 * 1000;
let bossId = null;
function spawnBoss() {
  const id = 'boss' + Date.now();
  monsters[id] = {
    id, type: 'boss', zone: 'bossroom',
    x: BOSSROOM_CENTER.x,
    y: BOSSROOM_CENTER.y,
    hp: MONSTER_TYPES.boss.hp, maxHp: MONSTER_TYPES.boss.hp,
    lastAttack: 0, targetId: null,
    homeX: BOSSROOM_CENTER.x, homeY: BOSSROOM_CENTER.y
  };
  bossId = id;
  io.emit('announcement', `👑 Der ${MONSTER_TYPES.boss.name} ist im Boss-Raum erschienen! Teleportiere dich über das Menü dorthin!`);
}
function bossCycle() {
  if (bossId && monsters[bossId]) delete monsters[bossId];
  spawnBoss();
}
setTimeout(() => {
  bossCycle();
  setInterval(bossCycle, BOSS_INTERVAL_MS);
}, 45000); // erster Boss 45s nach Serverstart, danach alle 10 Minuten

function onMonsterKilled(m, killer) {
  if (m.type === 'boss') {
    bossId = null;
    for (let i = 0; i < 4; i++) spawnItem(m.x + (Math.random() * 40 - 20), m.y + (Math.random() * 40 - 20), 'bossroom');
    if (killer) killer.potions += 2;
    io.emit('announcement', `🏆 ${killer ? killer.name : 'Jemand'} hat den Boss besiegt! Riesiger Loot-Regen!`);
  } else {
    spawnItem(m.x, m.y, m.zone || DEFAULT_TIER_KEY);
  }
  if (killer) grantXp(killer, Math.round(MONSTER_TYPES[m.type].xp * (m.mult || 1)));
}

// ---------------- Admin ----------------
const ADMIN_USERNAMES = new Set(
  (process.env.ADMIN_USERNAMES || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
);

// ---------------- Socket-Handling ----------------
io.on('connection', (socket) => {
  socket.on('auth', async (data) => {
    try {
      const mode = data && data.mode === 'register' ? 'register' : 'login';
      const username = (data && data.username ? String(data.username) : '').trim().toLowerCase().slice(0, 20);
      const password = data && data.password ? String(data.password) : '';
      const name = (data && data.name ? String(data.name) : username).trim().slice(0, 16) || 'Held';

      if (!username || username.length < 3) {
        return socket.emit('authError', 'Benutzername muss mind. 3 Zeichen haben.');
      }
      if (!password || password.length < 4) {
        return socket.emit('authError', 'Passwort muss mind. 4 Zeichen haben.');
      }
      if (!accountsCol) {
        return socket.emit('authError', 'Datenbank nicht verbunden - Accounts sind aktuell deaktiviert. (MONGO_URI fehlt auf dem Server)');
      }

      let account = await loadAccount(username);

      if (mode === 'register') {
        if (account) return socket.emit('authError', 'Dieser Benutzername ist bereits vergeben.');
        const classKey = CLASSES[data && data.cls] ? data.cls : 'krieger';
        const hash = await bcrypt.hash(password, 10);
        account = await createAccount(username, hash, classKey);
      } else {
        if (!account) return socket.emit('authError', 'Diesen Account gibt es nicht. Bitte zuerst registrieren.');
        const ok = await bcrypt.compare(password, account.passwordHash);
        if (!ok) return socket.emit('authError', 'Falsches Passwort.');
      }

      const stats = statsForLevel(account.cls, account.level);
      const loginTier = tierForLevel(account.level);
      const loginSpawn = randomTierSpawn(loginTier);
      players[socket.id] = {
        id: socket.id,
        username,
        name: name || username,
        cls: account.cls,
        zone: loginTier,
        x: loginSpawn.x,
        y: loginSpawn.y,
        hp: stats.maxHp,
        maxHp: stats.maxHp,
        dmg: stats.dmg,
        speed: CLASSES[account.cls].speed,
        level: account.level,
        xp: account.xp,
        xpNext: xpToNextLevel(account.level),
        gold: account.gold,
        potions: account.potions,
        speedPotions: account.speedPotions || 0,
        speedBoostUntil: 0,
        upgDmg: account.upgDmg || 0,
        upgHp: account.upgHp || 0,
        upgSpeed: account.upgSpeed || 0,
        isAdmin: ADMIN_USERNAMES.has(username),
        lastAttack: 0,
        dead: false,
        input: { up: false, down: false, left: false, right: false, aimX: 0, aimY: 0 }
      };
      recomputeStats(players[socket.id]);
      players[socket.id].hp = players[socket.id].maxHp;

      const dungeonTiersPayload = {};
      for (const key in DUNGEON_TIERS) {
        const t = DUNGEON_TIERS[key];
        dungeonTiersPayload[key] = { name: t.name, minLevel: t.minLevel, rows: t.rows };
      }
      socket.emit('init', {
        you: socket.id,
        dungeonTiers: dungeonTiersPayload,
        arenaMap: ARENA_ROWS,
        bossRoomMap: BOSSROOM_ROWS,
        tile: TILE,
        classes: CLASSES,
        isAdmin: players[socket.id].isAdmin
      });
    } catch (err) {
      console.error('Auth-Fehler:', err.message);
      socket.emit('authError', 'Es ist ein Fehler aufgetreten. Bitte versuch es erneut.');
    }
  });

  socket.on('input', (inp) => {
    const p = players[socket.id];
    if (!p || !inp) return;
    p.input = {
      up: !!inp.up, down: !!inp.down, left: !!inp.left, right: !!inp.right,
      aimX: Number(inp.aimX) || 0, aimY: Number(inp.aimY) || 0
    };
  });

  socket.on('attack', () => {
    const p = players[socket.id];
    if (!p || p.dead) return;
    const now = Date.now();
    const def = CLASSES[p.cls];
    if (now - p.lastAttack < def.cooldown) return;
    p.lastAttack = now;

    if (p.zone === 'arena') {
      // PvP: Gegner sind andere Spieler in der Arena
      if (def.kind === 'melee') {
        let closest = null, closestDist = Infinity;
        for (const id in players) {
          const other = players[id];
          if (id === p.id || other.zone !== 'arena' || other.dead) continue;
          const d = dist(p.x, p.y, other.x, other.y);
          if (d < def.range && d < closestDist) { closest = other; closestDist = d; }
        }
        if (closest) {
          let dmg = p.dmg;
          if (def.crit && Math.random() < def.crit) dmg *= 2;
          applyPvpDamage(closest, dmg, p);
        }
      } else {
        const id = 'pr' + (projectileIdCounter++);
        const angle = Math.atan2(p.input.aimY, p.input.aimX) || 0;
        projectiles[id] = {
          id, ownerId: p.id, zone: 'arena',
          x: p.x, y: p.y,
          vx: Math.cos(angle) * 6, vy: Math.sin(angle) * 6,
          dmg: p.dmg, life: 60
        };
      }
      return;
    }

    if (def.kind === 'melee') {
      let closest = null, closestDist = Infinity;
      for (const id in monsters) {
        const m = monsters[id];
        if ((m.zone || DEFAULT_TIER_KEY) !== p.zone) continue;
        const d = dist(p.x, p.y, m.x, m.y);
        if (d < def.range && d < closestDist) { closest = m; closestDist = d; }
      }
      if (closest) {
        let dmg = p.dmg;
        if (def.crit && Math.random() < def.crit) dmg *= 2;
        closest.hp -= dmg;
        io.emit('hit', { x: closest.x, y: closest.y, dmg });
        if (closest.hp <= 0) {
          onMonsterKilled(closest, p);
          delete monsters[closest.id];
        }
      }
    } else {
      const id = 'pr' + (projectileIdCounter++);
      const angle = Math.atan2(p.input.aimY, p.input.aimX) || 0;
      projectiles[id] = {
        id, ownerId: p.id, zone: p.zone,
        x: p.x, y: p.y,
        vx: Math.cos(angle) * 6, vy: Math.sin(angle) * 6,
        dmg: p.dmg, life: 60
      };
    }
  });

  socket.on('joinArena', () => {
    const p = players[socket.id];
    if (!p || p.dead) return;
    p.zone = 'arena';
    p.x = ARENA_SPAWN.x; p.y = ARENA_SPAWN.y;
    p.hp = p.maxHp;
  });

  socket.on('leaveArena', () => {
    const p = players[socket.id];
    if (!p) return;
    p.zone = tierForLevel(p.level);
    const sp = randomTierSpawn(p.zone);
    p.x = sp.x; p.y = sp.y;
    p.hp = p.maxHp;
    p.dead = false;
  });

  socket.on('joinBossRoom', () => {
    const p = players[socket.id];
    if (!p || p.dead) return;
    if (!bossId || !monsters[bossId]) return socket.emit('shopError', 'Aktuell ist kein Boss aktiv.');
    p.zone = 'bossroom';
    p.x = BOSSROOM_ENTRY.x; p.y = BOSSROOM_ENTRY.y;
    p.hp = p.maxHp;
  });

  socket.on('leaveBossRoom', () => {
    const p = players[socket.id];
    if (!p) return;
    p.zone = tierForLevel(p.level);
    const sp = randomTierSpawn(p.zone);
    p.x = sp.x; p.y = sp.y;
    p.hp = p.maxHp;
    p.dead = false;
  });

  socket.on('teleportRequest', (data) => {
    const p = players[socket.id];
    const target = players[data && data.targetId];
    if (!p || !target || p.dead || target.id === p.id) return;
    tpaRequests[target.id] = { fromId: p.id, expiresAt: Date.now() + 30000 };
    io.to(target.id).emit('tpaIncoming', { fromId: p.id, fromName: p.name });
    socket.emit('tpaSent', { targetName: target.name });
  });

  socket.on('tpaAccept', (data) => {
    const p = players[socket.id]; // derjenige, der die Anfrage annimmt (Ziel)
    const req = tpaRequests[socket.id];
    if (!p || !req) return;
    if (data && data.fromId && data.fromId !== req.fromId) return;
    if (Date.now() > req.expiresAt) { delete tpaRequests[socket.id]; return; }
    const requester = players[req.fromId];
    delete tpaRequests[socket.id];
    if (!requester || requester.dead) return;

    requester.zone = p.zone;
    requester.x = p.x + (Math.random() * 30 - 15);
    requester.y = p.y + (Math.random() * 30 - 15);
    if (circleHitsWall(mapFor(requester.zone), requester.x, requester.y, 12)) {
      requester.x = p.x; requester.y = p.y;
    }
    io.to(requester.id).emit('tpaResult', { accepted: true, otherName: p.name });
    socket.emit('tpaResult', { accepted: true, otherName: requester.name, asTarget: true });
  });

  socket.on('tpaDeny', (data) => {
    const req = tpaRequests[socket.id];
    if (!req) return;
    delete tpaRequests[socket.id];
    const requester = players[req.fromId];
    const me = players[socket.id];
    if (requester) io.to(requester.id).emit('tpaResult', { accepted: false, otherName: me ? me.name : '' });
  });

  socket.on('travelToTier', (data) => {
    const p = players[socket.id];
    if (!p || p.dead) return;
    const key = data && data.tier;
    const tierDef = DUNGEON_TIERS[key];
    if (!tierDef) return;
    if (p.level < tierDef.minLevel) {
      return socket.emit('shopError', `Benötigt Level ${tierDef.minLevel} (du bist Level ${p.level}).`);
    }
    p.zone = key;
    const sp = randomTierSpawn(key);
    p.x = sp.x; p.y = sp.y;
    p.hp = p.maxHp;
    p.dead = false;
  });

  socket.on('openChest', (data) => {
    const p = players[socket.id];
    if (!p || p.dead || !isDungeonTier(p.zone)) return;
    const chest = chests[data && data.chestId];
    if (!chest || chest.looted || chest.zone !== p.zone) return;
    if (dist(p.x, p.y, chest.x, chest.y) > 44) return;

    chest.looted = true;
    chest.respawnAt = Date.now() + CHEST_RESPAWN_MS;
    const lootMult = (DUNGEON_TIERS[p.zone] && DUNGEON_TIERS[p.zone].lootMult) || 1;
    const gold = Math.round((20 + Math.floor(Math.random() * 40)) * goldMult() * lootMult);
    const gotPotion = Math.random() < 0.35;
    p.gold += gold;
    if (gotPotion) p.potions += 1;
    socket.emit('lootResult', { gold, potion: gotPotion });
    saveAccountProgress(p);
  });

  socket.on('useItem', () => {
    const p = players[socket.id];
    if (!p || p.dead) return;
    if (p.potions > 0 && p.hp < p.maxHp) {
      p.potions -= 1;
      p.hp = Math.min(p.maxHp, p.hp + Math.floor(p.maxHp * 0.4));
    }
  });

  socket.on('buyItem', (data) => {
    const p = players[socket.id];
    if (!p || p.dead) return;
    const type = data && data.type;
    const def = SHOP_ITEMS[type];
    if (!def) return;

    if (type === 'potion') {
      const cost = shopCost('potion', 0);
      if (p.gold < cost) return socket.emit('shopError', 'Nicht genug Gold.');
      p.gold -= cost;
      p.potions += 1;
    } else if (type === 'speedpotion') {
      const cost = shopCost('speedpotion', 0);
      if (p.gold < cost) return socket.emit('shopError', 'Nicht genug Gold.');
      p.gold -= cost;
      p.speedPotions += 1;
    } else {
      const countKey = type === 'dmg' ? 'upgDmg' : (type === 'hp' ? 'upgHp' : 'upgSpeed');
      const current = p[countKey];
      if (def.maxCount !== null && current >= def.maxCount) {
        return socket.emit('shopError', 'Maximum für dieses Upgrade erreicht.');
      }
      const cost = shopCost(type, current);
      if (p.gold < cost) return socket.emit('shopError', 'Nicht genug Gold.');
      p.gold -= cost;
      p[countKey] += 1;
      recomputeStats(p);
    }
    saveAccountProgress(p);
  });

  socket.on('useSpeedPotion', () => {
    const p = players[socket.id];
    if (!p || p.dead) return;
    if (p.speedPotions > 0) {
      p.speedPotions -= 1;
      p.speedBoostUntil = Date.now() + 15000;
      saveAccountProgress(p);
    }
  });

  socket.on('chat', (msg) => {
    const p = players[socket.id];
    if (!p || !msg) return;
    const text = String(msg).slice(0, 80);
    io.emit('chat', { name: p.name, text });
  });

  // ---- Admin-Aktionen: serverseitig IMMER erneut gegen isAdmin geprueft ----
  socket.on('adminGiveGold', (data) => {
    const p = players[socket.id];
    if (!p || !p.isAdmin) return;
    const amount = Math.max(1, Math.min(9999, parseInt(data && data.amount, 10) || 50));
    if (data && data.target === 'self') {
      p.gold += amount;
      saveAccountProgress(p);
    } else {
      for (const id in players) {
        players[id].gold += amount;
        saveAccountProgress(players[id]);
      }
      io.emit('announcement', `🎉 ${p.name} lässt Gold regnen: +${amount} Gold für alle!`);
    }
  });

  socket.on('adminGivePotions', (data) => {
    const p = players[socket.id];
    if (!p || !p.isAdmin) return;
    const amount = Math.max(1, Math.min(20, parseInt(data && data.amount, 10) || 3));
    if (data && data.target === 'self') {
      p.potions += amount;
      saveAccountProgress(p);
    } else {
      for (const id in players) {
        players[id].potions += amount;
        saveAccountProgress(players[id]);
      }
      io.emit('announcement', `🧪 ${p.name} verteilt ${amount} Heiltränke an alle!`);
    }
  });

  socket.on('adminAnnounce', (data) => {
    const p = players[socket.id];
    if (!p || !p.isAdmin) return;
    const text = String((data && data.text) || '').slice(0, 140).trim();
    if (!text) return;
    io.emit('announcement', `📢 ${text}`);
  });

  socket.on('adminSpawnWave', () => {
    const p = players[socket.id];
    if (!p || !p.isAdmin) return;
    for (let i = 0; i < 10; i++) spawnMonster();
    io.emit('announcement', `👹 ${p.name} hat eine Monsterwelle beschworen!`);
  });

  socket.on('adminHealAll', () => {
    const p = players[socket.id];
    if (!p || !p.isAdmin) return;
    for (const id in players) {
      const pl = players[id];
      pl.hp = pl.maxHp;
      pl.dead = false;
    }
    io.emit('announcement', `💚 ${p.name} hat alle vollständig geheilt!`);
  });

  socket.on('adminEventGold', () => {
    const p = players[socket.id];
    if (!p || !p.isAdmin) return;
    goldEventUntil = Date.now() + 5 * 60000;
    io.emit('announcement', `💰 ${p.name} startet ein Doppel-Gold-Event! (5 Minuten)`);
  });

  socket.on('adminEventXp', () => {
    const p = players[socket.id];
    if (!p || !p.isAdmin) return;
    xpEventUntil = Date.now() + 5 * 60000;
    io.emit('announcement', `✨ ${p.name} startet ein Doppel-XP-Event! (5 Minuten)`);
  });

  socket.on('adminSpawnBoss', () => {
    const p = players[socket.id];
    if (!p || !p.isAdmin) return;
    bossCycle();
    io.emit('announcement', `👑 ${p.name} hat den Boss sofort herbeigerufen!`);
  });

  socket.on('disconnect', () => {
    const p = players[socket.id];
    if (p) saveAccountProgress(p);
    delete players[socket.id];
    delete tpaRequests[socket.id];
    for (const targetId in tpaRequests) {
      if (tpaRequests[targetId].fromId === socket.id) delete tpaRequests[targetId];
    }
  });
});

// Autosave alle 30 Sekunden, falls der Server mal ohne "disconnect" beendet wird
setInterval(() => {
  for (const id in players) saveAccountProgress(players[id]);
}, 30000);

// ---------------- Game-Loop ----------------
function tick() {
  const dtScale = 1;

  // Spieler bewegen
  for (const id in players) {
    const p = players[id];
    if (p.dead) continue;
    const inp = p.input;
    let dx = 0, dy = 0;
    if (inp.up) dy -= 1;
    if (inp.down) dy += 1;
    if (inp.left) dx -= 1;
    if (inp.right) dx += 1;
    if (dx !== 0 || dy !== 0) {
      const boosted = Date.now() < p.speedBoostUntil;
      const effSpeed = p.speed * (boosted ? 1.6 : 1);
      const len = Math.hypot(dx, dy);
      dx = (dx / len) * effSpeed * dtScale;
      dy = (dy / len) * effSpeed * dtScale;
      tryMove(mapFor(p.zone), p, dx, dy, 12);
    }
    if (!isDungeonTier(p.zone) && p.zone !== 'bossroom') continue;
    // Items einsammeln (nur passend zur eigenen Zone)
    for (const iid in items) {
      const it = items[iid];
      if ((it.zone || DEFAULT_TIER_KEY) !== p.zone) continue;
      if (dist(p.x, p.y, it.x, it.y) < 20) {
        if (it.type === 'gold') p.gold += it.amount;
        else if (it.type === 'potion') p.potions += 1;
        delete items[iid];
      }
    }
  }

  // Truhen: respawnen nach Cooldown
  for (const cid in chests) {
    const c = chests[cid];
    if (c.looted && Date.now() > c.respawnAt) c.looted = false;
  }

  // Monster-KI
  for (const id in monsters) {
    const m = monsters[id];
    const mZone = m.zone || DEFAULT_TIER_KEY;
    const mMap = mapFor(mZone);
    let target = null, targetDist = Infinity;
    for (const pid in players) {
      const p = players[pid];
      if (p.dead || p.zone !== mZone) continue;
      const d = dist(m.x, m.y, p.x, p.y);
      if (d < 180 && d < targetDist) { target = p; targetDist = d; }
    }
    if (target) {
      const def = MONSTER_TYPES[m.type];
      if (targetDist > def.range) {
        const angle = Math.atan2(target.y - m.y, target.x - m.x);
        tryMove(mMap, m, Math.cos(angle) * def.speed, Math.sin(angle) * def.speed, def.radius);
      } else {
        const now = Date.now();
        if (now - m.lastAttack > def.cooldown) {
          m.lastAttack = now;
          const dmg = Math.round(def.dmg * (m.mult || 1));
          target.hp -= dmg;
          io.to(target.id).emit('hit', { x: target.x, y: target.y, dmg });
          if (target.hp <= 0 && !target.dead) {
            target.dead = true;
            setTimeout(() => respawnPlayer(target), 3000);
          }
        }
      }
    } else {
      // zurueck zum Ausgangspunkt schlendern
      const d = dist(m.x, m.y, m.homeX, m.homeY);
      if (d > 10) {
        const angle = Math.atan2(m.homeY - m.y, m.homeX - m.x);
        tryMove(mMap, m, Math.cos(angle) * 0.6, Math.sin(angle) * 0.6, MONSTER_TYPES[m.type].radius);
      }
    }
  }

  // Projektile
  for (const id in projectiles) {
    const pr = projectiles[id];
    pr.x += pr.vx;
    pr.y += pr.vy;
    pr.life -= 1;
    let hitSomething = false;
    const pMap = mapFor(pr.zone);
    if (pMap.isWall(Math.floor(pr.x / TILE), Math.floor(pr.y / TILE))) hitSomething = true;

    if (!hitSomething && pr.zone === 'arena') {
      for (const pid in players) {
        const other = players[pid];
        if (pid === pr.ownerId || other.zone !== 'arena' || other.dead) continue;
        if (dist(pr.x, pr.y, other.x, other.y) < 16) {
          const owner = players[pr.ownerId];
          applyPvpDamage(other, pr.dmg, owner);
          hitSomething = true;
          break;
        }
      }
    } else if (!hitSomething) {
      for (const mid in monsters) {
        const m = monsters[mid];
        if ((m.zone || DEFAULT_TIER_KEY) !== pr.zone) continue;
        if (dist(pr.x, pr.y, m.x, m.y) < 16) {
          m.hp -= pr.dmg;
          io.emit('hit', { x: m.x, y: m.y, dmg: pr.dmg });
          if (m.hp <= 0) {
            onMonsterKilled(m, players[pr.ownerId]);
            delete monsters[mid];
          }
          hitSomething = true;
          break;
        }
      }
    }
    if (hitSomething || pr.life <= 0) delete projectiles[id];
  }

  broadcastState();
}

function broadcastState() {
  const state = {
    players: Object.values(players).map(p => ({
      id: p.id, name: p.name, cls: p.cls, x: p.x, y: p.y, zone: p.zone,
      hp: p.hp, maxHp: p.maxHp, level: p.level, xp: p.xp, xpNext: p.xpNext,
      gold: p.gold, potions: p.potions, speedPotions: p.speedPotions, speedBoostUntil: p.speedBoostUntil, dead: p.dead,
      upgDmg: p.upgDmg, upgHp: p.upgHp, upgSpeed: p.upgSpeed
    })),
    monsters: Object.values(monsters).map(m => ({
      id: m.id, type: m.type, zone: m.zone || DEFAULT_TIER_KEY, x: m.x, y: m.y, hp: m.hp, maxHp: m.maxHp
    })),
    items: Object.values(items),
    chests: Object.values(chests).map(c => ({ id: c.id, x: c.x, y: c.y, looted: c.looted })),
    projectiles: Object.values(projectiles).map(pr => ({ id: pr.id, x: pr.x, y: pr.y, zone: pr.zone })),
    events: {
      goldRemaining: Math.max(0, goldEventUntil - Date.now()),
      xpRemaining: Math.max(0, xpEventUntil - Date.now()),
      bossAlive: !!(bossId && monsters[bossId])
    }
  };
  io.emit('state', state);
}

setInterval(tick, 1000 / TICK_RATE);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Leo Dungeon RPG Server laeuft auf Port ${PORT}`);
});
