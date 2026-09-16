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
  cors: { origin: '*' }
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
    level: 1, xp: 0, gold: 0, potions: 1,
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
      { $set: { level: p.level, xp: p.xp, gold: p.gold, potions: p.potions, cls: p.cls } }
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
// 30 Spalten x 20 Zeilen
const MAP_ROWS = [
  '111111111111111111111111111111',
  '100000000000000000000000000001',
  '100111110000111111110000000001',
  '100100000000100000010000000001',
  '100100111110100011010111111001',
  '100000100000000010010000001001',
  '111100100111111010011111101001',
  '100000100100000010000000000001',
  '100111100100111110111111110001',
  '100000000100000000100000000001',
  '100011111100111111100111110001',
  '100010000000100000000100000001',
  '100010111111100111111100011101',
  '100000100000000100000000010001',
  '111110100111110100111111010001',
  '100000000100000000100000010001',
  '100011111100011111100011110001',
  '100000000000000000000000000001',
  '100000000000000000000000000001',
  '111111111111111111111111111111'
];
const MAP_W = MAP_ROWS[0].length;
const MAP_H = MAP_ROWS.length;

function isWall(tx, ty) {
  if (tx < 0 || ty < 0 || tx >= MAP_W || ty >= MAP_H) return true;
  return MAP_ROWS[ty][tx] === '1';
}

function isFloor(tx, ty) {
  return !isWall(tx, ty);
}

// Alle begehbaren Tiles sammeln (fuer Spawns)
const floorTiles = [];
for (let y = 0; y < MAP_H; y++) {
  for (let x = 0; x < MAP_W; x++) {
    if (isFloor(x, y)) floorTiles.push({ x, y });
  }
}
function randomFloorTile() {
  return floorTiles[Math.floor(Math.random() * floorTiles.length)];
}
const SPAWN_POINT = { x: 2 * TILE + TILE / 2, y: 1 * TILE + TILE / 2 };

// ---------------- Klassen-Definitionen ----------------
const CLASSES = {
  krieger: { name: 'Krieger', maxHp: 150, speed: 2.4, dmg: 18, range: 42, cooldown: 500, kind: 'melee', color: '#e74c3c' },
  magier:  { name: 'Magier',  maxHp: 80,  speed: 2.1, dmg: 24, range: 240, cooldown: 750, kind: 'ranged', color: '#3498db' },
  schurke: { name: 'Schurke', maxHp: 100, speed: 3.0, dmg: 13, range: 36, cooldown: 320, kind: 'melee', color: '#2ecc71', crit: 0.25 },
};

function statsForLevel(clsKey, level) {
  const def = CLASSES[clsKey] || CLASSES.krieger;
  const lvlBonus = Math.max(0, level - 1);
  return {
    maxHp: def.maxHp + lvlBonus * 18,
    dmg: def.dmg + lvlBonus * 3
  };
}

// ---------------- Game-State ----------------
const players = {};     // id -> player
const monsters = {};    // id -> monster
const items = {};       // id -> ground item
const projectiles = {}; // id -> projectile

let monsterIdCounter = 0;
let itemIdCounter = 0;
let projectileIdCounter = 0;

const MONSTER_TYPES = {
  goblin: { hp: 40, dmg: 8, speed: 1.3, xp: 15, range: 30, cooldown: 900, color: '#8e7c4d', radius: 12 },
  ork:    { hp: 95, dmg: 16, speed: 0.9, xp: 40, range: 34, cooldown: 1200, color: '#5b4636', radius: 16 }
};
const MAX_MONSTERS = 20;

function spawnMonster() {
  if (Object.keys(monsters).length >= MAX_MONSTERS) return;
  const type = Math.random() < 0.7 ? 'goblin' : 'ork';
  const def = MONSTER_TYPES[type];
  const tile = randomFloorTile();
  const id = 'm' + (monsterIdCounter++);
  monsters[id] = {
    id, type,
    x: tile.x * TILE + TILE / 2,
    y: tile.y * TILE + TILE / 2,
    hp: def.hp, maxHp: def.hp,
    lastAttack: 0,
    targetId: null,
    homeX: tile.x * TILE + TILE / 2,
    homeY: tile.y * TILE + TILE / 2
  };
}

function spawnItem(x, y) {
  const roll = Math.random();
  const type = roll < 0.6 ? 'gold' : 'potion';
  const id = 'i' + (itemIdCounter++);
  items[id] = { id, type, x, y, amount: type === 'gold' ? (5 + Math.floor(Math.random() * 15)) : 1 };
}

// Initiale Monster
for (let i = 0; i < 8; i++) spawnMonster();
setInterval(() => { if (Math.random() < 0.5) spawnMonster(); }, 4000);

// ---------------- Hilfsfunktionen ----------------
function dist(ax, ay, bx, by) {
  return Math.hypot(ax - bx, ay - by);
}

function xpToNextLevel(level) {
  return 80 + level * 60;
}

function circleHitsWall(x, y, radius) {
  const pts = [
    [x - radius, y - radius], [x + radius, y - radius],
    [x - radius, y + radius], [x + radius, y + radius]
  ];
  for (const [px, py] of pts) {
    if (isWall(Math.floor(px / TILE), Math.floor(py / TILE))) return true;
  }
  return false;
}

function tryMove(entity, dx, dy, radius) {
  const nx = entity.x + dx;
  const ny = entity.y + dy;
  if (!circleHitsWall(nx, entity.y, radius)) entity.x = nx;
  if (!circleHitsWall(entity.x, ny, radius)) entity.y = ny;
}

function respawnPlayer(p) {
  p.x = SPAWN_POINT.x;
  p.y = SPAWN_POINT.y;
  p.hp = Math.max(1, Math.floor(p.maxHp * 0.5));
  p.dead = false;
}

function levelUp(p) {
  p.level += 1;
  p.xp -= p.xpNext;
  p.xpNext = xpToNextLevel(p.level);
  p.maxHp += 18;
  p.dmg += 3;
  p.hp = p.maxHp;
  saveAccountProgress(p);
}

function grantXp(p, amount) {
  p.xp += amount;
  while (p.xp >= p.xpNext) levelUp(p);
}

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
      players[socket.id] = {
        id: socket.id,
        username,
        name: name || username,
        cls: account.cls,
        x: SPAWN_POINT.x,
        y: SPAWN_POINT.y,
        hp: stats.maxHp,
        maxHp: stats.maxHp,
        dmg: stats.dmg,
        speed: CLASSES[account.cls].speed,
        level: account.level,
        xp: account.xp,
        xpNext: xpToNextLevel(account.level),
        gold: account.gold,
        potions: account.potions,
        lastAttack: 0,
        dead: false,
        input: { up: false, down: false, left: false, right: false, aimX: 0, aimY: 0 }
      };

      socket.emit('init', {
        you: socket.id,
        map: MAP_ROWS,
        tile: TILE,
        classes: CLASSES
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

    if (def.kind === 'melee') {
      let closest = null, closestDist = Infinity;
      for (const id in monsters) {
        const m = monsters[id];
        const d = dist(p.x, p.y, m.x, m.y);
        if (d < def.range && d < closestDist) { closest = m; closestDist = d; }
      }
      if (closest) {
        let dmg = p.dmg;
        if (def.crit && Math.random() < def.crit) dmg *= 2;
        closest.hp -= dmg;
        io.emit('hit', { x: closest.x, y: closest.y, dmg });
        if (closest.hp <= 0) {
          spawnItem(closest.x, closest.y);
          grantXp(p, MONSTER_TYPES[closest.type].xp);
          delete monsters[closest.id];
        }
      }
    } else {
      const id = 'pr' + (projectileIdCounter++);
      const angle = Math.atan2(p.input.aimY, p.input.aimX) || 0;
      projectiles[id] = {
        id, ownerId: p.id,
        x: p.x, y: p.y,
        vx: Math.cos(angle) * 6, vy: Math.sin(angle) * 6,
        dmg: p.dmg, life: 60
      };
    }
  });

  socket.on('useItem', () => {
    const p = players[socket.id];
    if (!p || p.dead) return;
    if (p.potions > 0 && p.hp < p.maxHp) {
      p.potions -= 1;
      p.hp = Math.min(p.maxHp, p.hp + Math.floor(p.maxHp * 0.4));
    }
  });

  socket.on('chat', (msg) => {
    const p = players[socket.id];
    if (!p || !msg) return;
    const text = String(msg).slice(0, 80);
    io.emit('chat', { name: p.name, text });
  });

  socket.on('disconnect', () => {
    const p = players[socket.id];
    if (p) saveAccountProgress(p);
    delete players[socket.id];
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
      const len = Math.hypot(dx, dy);
      dx = (dx / len) * p.speed * dtScale;
      dy = (dy / len) * p.speed * dtScale;
      tryMove(p, dx, dy, 12);
    }
    // Items einsammeln
    for (const iid in items) {
      const it = items[iid];
      if (dist(p.x, p.y, it.x, it.y) < 20) {
        if (it.type === 'gold') p.gold += it.amount;
        else if (it.type === 'potion') p.potions += 1;
        delete items[iid];
      }
    }
  }

  // Monster-KI
  for (const id in monsters) {
    const m = monsters[id];
    let target = null, targetDist = Infinity;
    for (const pid in players) {
      const p = players[pid];
      if (p.dead) continue;
      const d = dist(m.x, m.y, p.x, p.y);
      if (d < 180 && d < targetDist) { target = p; targetDist = d; }
    }
    if (target) {
      const def = MONSTER_TYPES[m.type];
      if (targetDist > def.range) {
        const angle = Math.atan2(target.y - m.y, target.x - m.x);
        tryMove(m, Math.cos(angle) * def.speed, Math.sin(angle) * def.speed, def.radius);
      } else {
        const now = Date.now();
        if (now - m.lastAttack > def.cooldown) {
          m.lastAttack = now;
          target.hp -= def.dmg;
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
        tryMove(m, Math.cos(angle) * 0.6, Math.sin(angle) * 0.6, MONSTER_TYPES[m.type].radius);
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
    if (isWall(Math.floor(pr.x / TILE), Math.floor(pr.y / TILE))) hitSomething = true;
    for (const mid in monsters) {
      const m = monsters[mid];
      if (dist(pr.x, pr.y, m.x, m.y) < 16) {
        m.hp -= pr.dmg;
        io.emit('hit', { x: m.x, y: m.y, dmg: pr.dmg });
        if (m.hp <= 0) {
          spawnItem(m.x, m.y);
          const owner = players[pr.ownerId];
          if (owner) grantXp(owner, MONSTER_TYPES[m.type].xp);
          delete monsters[mid];
        }
        hitSomething = true;
        break;
      }
    }
    if (hitSomething || pr.life <= 0) delete projectiles[id];
  }

  broadcastState();
}

function broadcastState() {
  const state = {
    players: Object.values(players).map(p => ({
      id: p.id, name: p.name, cls: p.cls, x: p.x, y: p.y,
      hp: p.hp, maxHp: p.maxHp, level: p.level, xp: p.xp, xpNext: p.xpNext,
      gold: p.gold, potions: p.potions, dead: p.dead
    })),
    monsters: Object.values(monsters).map(m => ({
      id: m.id, type: m.type, x: m.x, y: m.y, hp: m.hp, maxHp: m.maxHp
    })),
    items: Object.values(items),
    projectiles: Object.values(projectiles).map(pr => ({ id: pr.id, x: pr.x, y: pr.y }))
  };
  io.emit('state', state);
}

setInterval(tick, 1000 / TICK_RATE);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Leo Dungeon RPG Server laeuft auf Port ${PORT}`);
});
