// Shadow Heist — engine. Top-down stealth: move with WASD or arrows,
// hold Shift to sneak (slower, quieter, harder to spot). Guards patrol
// with vision cones; crates block their sight, bushes hide you. Grab all
// the loot, then reach the exit unseen. Getting spotted fills the alarm —
// break line of sight before it maxes out and you get a second chance.

import { LEVELS, TILE } from './levels.js';
import { sfx, setMuted, isMuted } from './audio.js';

const $ = (id) => document.getElementById(id);
const cv = $('game');
const ctx = cv.getContext('2d');
const W = 24 * TILE;
const H = 15 * TILE;
const CONE_RANGE = 200;
const CONE_HALF = 0.6; // radians either side of facing

let phase = 'title'; // title | playing | caught | levelDone | win
let level = 0;
let map = [];
let loot = []; // { x, y, taken }
let exit = { x: 0, y: 0 };
let player = { x: 0, y: 0, r: 14, dir: 0, sneaking: false };
let guards = []; // { x, y, dir, wp, wpi, speed, state, sus, lastSeen, wait }
let keys = {};
let alarm = 0; // 0..100, the highest guard suspicion
let spotted = false; // any guard fully alerted this level
let score = 0;
let timeLeft = 0;
let timerId = null;
let stepTimer = 0;
let lastTickSecond = -1;

function tileAt(px, py) {
  const tx = Math.floor(px / TILE), ty = Math.floor(py / TILE);
  if (tx < 0 || ty < 0 || ty >= map.length || tx >= map[0].length) return '#';
  return map[ty][tx];
}
function isSolid(t) { return t === '#' || t === 'C'; }
function blocksSight(t) { return t === '#' || t === 'C'; }

// line of sight between two points, blocked by walls and crates
function hasLOS(x0, y0, x1, y1) {
  const dx = x1 - x0, dy = y1 - y0;
  const dist = Math.hypot(dx, dy);
  const steps = Math.ceil(dist / 8);
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    if (blocksSight(tileAt(x0 + dx * t, y0 + dy * t))) return false;
  }
  return true;
}
function inBush(x, y) { return tileAt(x, y) === 'B'; }

function loadLevel(i) {
  level = i;
  const L = LEVELS[i];
  map = L.map.map((row) => row.split(''));
  loot = [];
  guards = [];
  alarm = 0;
  spotted = false;
  timeLeft = L.par;
  for (let y = 0; y < map.length; y++) {
    for (let x = 0; x < map[y].length; x++) {
      const t = map[y][x];
      const cx = x * TILE + TILE / 2, cy = y * TILE + TILE / 2;
      if (t === 'P') { player.x = cx; player.y = cy; map[y][x] = '.'; }
      if (t === 'L') { loot.push({ x: cx, y: cy, taken: false }); map[y][x] = '.'; }
      if (t === 'E') { exit = { x: cx, y: cy }; map[y][x] = '.'; }
    }
  }
  for (const g of L.guards) {
    const [sx, sy] = g.waypoints[0];
    guards.push({
      x: sx * TILE + TILE / 2, y: sy * TILE + TILE / 2, r: 14,
      dir: 0, wp: g.waypoints.map(([wx, wy]) => ({ x: wx * TILE + TILE / 2, y: wy * TILE + TILE / 2 })),
      wpi: 1, speed: g.speed * TILE, state: 'patrol', sus: 0, lastSeen: null, wait: 0,
    });
  }
  phase = 'playing';
  hideOverlay();
  updateHUD();
  clearInterval(timerId);
  timerId = setInterval(() => {
    if (phase !== 'playing') return;
    timeLeft -= 0.1;
    if (timeLeft <= 10 && Math.ceil(timeLeft) !== lastTickSecond) {
      lastTickSecond = Math.ceil(timeLeft);
      if (timeLeft > 0) sfx.click();
    }
    if (timeLeft <= 0) { timeLeft = 0; caught('Time\'s up — the vault sealed itself.'); }
    updateHUD();
  }, 100);
}

function moveCircle(e, dx, dy) {
  const nx = e.x + dx;
  if (!isSolid(tileAt(nx + Math.sign(dx) * e.r, e.y - e.r + 2)) &&
      !isSolid(tileAt(nx + Math.sign(dx) * e.r, e.y + e.r - 2))) e.x = nx;
  const ny = e.y + dy;
  if (!isSolid(tileAt(e.x - e.r + 2, ny + Math.sign(dy) * e.r)) &&
      !isSolid(tileAt(e.x + e.r - 2, ny + Math.sign(dy) * e.r))) e.y = ny;
}

function update(dt) {
  if (phase !== 'playing') return;
  // --- player ---
  let mx = (keys['arrowright'] || keys['d'] ? 1 : 0) - (keys['arrowleft'] || keys['a'] ? 1 : 0);
  let my = (keys['arrowdown'] || keys['s'] ? 1 : 0) - (keys['arrowup'] || keys['w'] ? 1 : 0);
  player.sneaking = !!keys['shift'];
  const speed = player.sneaking ? 95 : 175;
  if (mx || my) {
    const len = Math.hypot(mx, my);
    mx /= len; my /= len;
    player.dir = Math.atan2(my, mx);
    moveCircle(player, mx * speed * dt, my * speed * dt);
    stepTimer -= dt;
    if (stepTimer <= 0) {
      stepTimer = player.sneaking ? 0.55 : 0.34;
      if (player.sneaking) sfx.sneakStep();
    }
  }
  // loot pickup
  for (const l of loot) {
    if (!l.taken && Math.hypot(player.x - l.x, player.y - l.y) < 26) {
      l.taken = true;
      score += 100;
      sfx.pickup();
      $('msg').textContent = 'Loot grabbed! ' + loot.filter((x) => x.taken).length + ' / ' + loot.length;
    }
  }
  const allLoot = loot.every((l) => l.taken);
  if (allLoot && Math.hypot(player.x - exit.x, player.y - exit.y) < 30) {
    levelComplete();
    return;
  }
  // --- guards ---
  let maxSus = 0;
  for (const g of guards) {
    // target point
    let tx, ty, spd = g.speed;
    if (g.state === 'chase') {
      tx = g.lastSeen.x; ty = g.lastSeen.y; spd = g.speed * 1.35;
    } else {
      tx = g.wp[g.wpi].x; ty = g.wp[g.wpi].y;
    }
    const dx = tx - g.x, dy = ty - g.y;
    const dist = Math.hypot(dx, dy);
    if (g.state === 'chase' && dist < 8) {
      g.state = 'search';
      g.wait = 1.6;
    } else if (g.state === 'search') {
      g.wait -= dt;
      g.dir += dt * 1.5; // look around
      if (g.wait <= 0) g.state = 'patrol';
    } else if (dist > 4) {
      g.dir = Math.atan2(dy, dx);
      moveCircle(g, (dx / dist) * spd * dt, (dy / dist) * spd * dt);
      if (g.state === 'patrol' && dist < 6) g.wpi = (g.wpi + 1) % g.wp.length;
    }
    // guard footsteps: louder when closer to you
    const pd = Math.hypot(player.x - g.x, player.y - g.y);
    stepTimer -= 0;
    if (Math.random() < dt * 2.2) sfx.step(Math.max(0, 1 - pd / 420));
    // --- vision ---
    const hidden = inBush(player.x, player.y);
    const inRange = pd < CONE_RANGE * (player.sneaking ? 0.6 : 1);
    let ang = Math.atan2(player.y - g.y, player.x - g.x) - g.dir;
    while (ang > Math.PI) ang -= Math.PI * 2;
    while (ang < -Math.PI) ang += Math.PI * 2;
    const inCone = Math.abs(ang) < CONE_HALF;
    const seen = inRange && inCone && hasLOS(g.x, g.y, player.x, player.y) && !hidden;
    if (seen) {
      const rate = (player.sneaking ? 26 : 55) * (1.6 - Math.min(1, pd / CONE_RANGE));
      g.sus = Math.min(100, g.sus + rate * dt);
      g.lastSeen = { x: player.x, y: player.y };
      if (g.sus > 50 && g.state === 'patrol') {
        g.state = 'chase';
        sfx.suspicious();
        $('msg').textContent = 'A guard heard something…';
      }
      if (g.sus >= 100) {
        spotted = true;
        sfx.spotted();
        caught('Spotted! The guard raised the alarm.');
        return;
      }
    } else {
      g.sus = Math.max(0, g.sus - 22 * dt);
      if (g.state === 'chase' && g.sus < 25) g.state = 'patrol';
    }
    maxSus = Math.max(maxSus, g.sus);
  }
  alarm = maxSus;
  updateHUD();
}

// ---------- drawing ----------
function draw() {
  ctx.clearRect(0, 0, W, H);
  // floor
  for (let y = 0; y < map.length; y++) {
    for (let x = 0; x < map[y].length; x++) {
      const px = x * TILE, py = y * TILE;
      const t = map[y][x];
      if (t === '#') {
        ctx.fillStyle = '#2d3436';
        ctx.fillRect(px, py, TILE, TILE);
        ctx.fillStyle = '#3d4548';
        ctx.fillRect(px, py, TILE, 5);
      } else {
        ctx.fillStyle = (x + y) % 2 === 0 ? '#3a3f4a' : '#353a45';
        ctx.fillRect(px, py, TILE, TILE);
        if (t === 'C') {
          ctx.fillStyle = '#8b5a2b';
          ctx.fillRect(px + 4, py + 4, TILE - 8, TILE - 8);
          ctx.strokeStyle = '#6c4a2f';
          ctx.lineWidth = 2;
          ctx.strokeRect(px + 4, py + 4, TILE - 8, TILE - 8);
          ctx.beginPath();
          ctx.moveTo(px + 4, py + 4);
          ctx.lineTo(px + TILE - 4, py + TILE - 4);
          ctx.moveTo(px + TILE - 4, py + 4);
          ctx.lineTo(px + 4, py + TILE - 4);
          ctx.stroke();
        }
        if (t === 'B') {
          ctx.fillStyle = '#27ae60';
          ctx.beginPath();
          ctx.arc(px + 12, py + 14, 10, 0, Math.PI * 2);
          ctx.arc(px + 26, py + 10, 11, 0, Math.PI * 2);
          ctx.arc(px + 20, py + 26, 11, 0, Math.PI * 2);
          ctx.fill();
          ctx.fillStyle = '#2ecc71';
          ctx.beginPath();
          ctx.arc(px + 16, py + 18, 6, 0, Math.PI * 2);
          ctx.arc(px + 28, py + 24, 5, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }
  }
  // vision cones (under walls' tops, over floor)
  for (const g of guards) {
    const hot = g.sus > 50;
    const grad = ctx.createRadialGradient(g.x, g.y, 10, g.x, g.y, CONE_RANGE);
    grad.addColorStop(0, hot ? 'rgba(231,76,60,0.55)' : 'rgba(247,183,49,0.45)');
    grad.addColorStop(1, 'rgba(247,183,49,0)');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.moveTo(g.x, g.y);
    ctx.arc(g.x, g.y, CONE_RANGE, g.dir - CONE_HALF, g.dir + CONE_HALF);
    ctx.closePath();
    ctx.fill();
  }
  // exit
  const allLoot = loot.every((l) => l.taken);
  ctx.fillStyle = allLoot ? '#2ecc71' : '#636e72';
  ctx.fillRect(exit.x - 18, exit.y - 18, 36, 36);
  ctx.fillStyle = '#dfe6e9';
  ctx.font = 'bold 11px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(allLoot ? 'EXIT' : 'LOCK', exit.x, exit.y + 4);
  // loot (gently pulsing, so the gems catch the eye at a glance)
  const pulse = 1 + 0.12 * Math.sin(frame * 0.08);
  for (const l of loot) {
    if (l.taken) continue;
    ctx.fillStyle = '#00cec9';
    ctx.beginPath();
    ctx.moveTo(l.x, l.y - 10 * pulse);
    ctx.lineTo(l.x + 8 * pulse, l.y);
    ctx.lineTo(l.x, l.y + 10 * pulse);
    ctx.lineTo(l.x - 8 * pulse, l.y);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.moveTo(l.x, l.y - 5);
    ctx.lineTo(l.x + 3, l.y);
    ctx.lineTo(l.x, l.y + 5);
    ctx.lineTo(l.x - 3, l.y);
    ctx.closePath();
    ctx.fill();
  }
  // guards
  for (const g of guards) {
    ctx.fillStyle = g.sus > 50 ? '#e74c3c' : '#e17055';
    ctx.beginPath();
    ctx.arc(g.x, g.y, 14, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#2d3436';
    ctx.beginPath();
    ctx.arc(g.x + Math.cos(g.dir) * 7, g.y + Math.sin(g.dir) * 7, 5, 0, Math.PI * 2);
    ctx.fill();
    // suspicion ring
    if (g.sus > 2) {
      ctx.strokeStyle = g.sus > 50 ? '#e74c3c' : '#f7b731';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(g.x, g.y, 19, -Math.PI / 2, -Math.PI / 2 + (g.sus / 100) * Math.PI * 2);
      ctx.stroke();
    }
    if (g.sus > 50) {
      ctx.fillStyle = '#e74c3c';
      ctx.font = 'bold 16px sans-serif';
      ctx.fillText('!', g.x, g.y - 24);
    }
  }
  // player (hooded thief: bright blue with a gold ring, so you can
  // always pick yourself out against the dark floor at a glance)
  ctx.fillStyle = '#4a7fb5';
  ctx.beginPath();
  ctx.arc(player.x, player.y, player.r, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = '#f7b731';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(player.x, player.y, player.r, 0, Math.PI * 2);
  ctx.stroke();
  ctx.fillStyle = '#f7b731';
  ctx.beginPath();
  ctx.arc(player.x + Math.cos(player.dir) * 6, player.y + Math.sin(player.dir) * 6, 5, 0, Math.PI * 2);
  ctx.fill();
  if (player.sneaking) {
    ctx.strokeStyle = 'rgba(247,183,49,0.8)';
    ctx.lineWidth = 2;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.arc(player.x, player.y, player.r + 5, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
  }
  // darkness: light radius around the player
  const dark = ctx.createRadialGradient(player.x, player.y, 90, player.x, player.y, 340);
  dark.addColorStop(0, 'rgba(0,0,0,0)');
  dark.addColorStop(1, 'rgba(0,0,0,0.42)');
  ctx.fillStyle = dark;
  ctx.fillRect(0, 0, W, H);
}

// ---------- HUD / flow ----------
function updateHUD() {
  const L = LEVELS[level];
  $('levelName').textContent = 'Level ' + (level + 1) + ' · ' + L.name;
  $('lootCount').textContent = loot.filter((l) => l.taken).length + ' / ' + loot.length;
  $('score').textContent = score;
  $('timeLeft').textContent = Math.max(0, Math.ceil(timeLeft)) + 's';
  $('alarmBar').style.width = alarm + '%';
  $('alarmBar').classList.toggle('hot', alarm > 50);
  $('alarmLabel').textContent = alarm > 50 ? 'SPOTTED!' : alarm > 2 ? 'suspicious…' : 'unseen';
  document.querySelectorAll('.dot').forEach((d, i) => {
    d.classList.toggle('done', i < level);
    d.classList.toggle('now', i === level);
  });
}

function showOverlay(html) {
  $('overlay').innerHTML = html;
  $('overlay').classList.remove('hidden');
}
function hideOverlay() { $('overlay').classList.add('hidden'); }

function caught(reason) {
  phase = 'caught';
  clearInterval(timerId);
  sfx.caught();
  showOverlay(
    '<h2>Caught!</h2>' +
    '<p>' + reason + '</p>' +
    '<p class="muted">Tip: wait for the cone to turn away, sneak (Shift) past, and use crates to break line of sight.</p>' +
    '<button id="retryBtn">Try again</button>'
  );
  $('retryBtn').onclick = () => loadLevel(level);
}

function levelComplete() {
  phase = 'levelDone';
  clearInterval(timerId);
  const timeBonus = Math.ceil(timeLeft) * 5;
  const ghost = spotted ? 0 : 150;
  score += timeBonus + ghost;
  sfx.exit();
  updateHUD();
  if (level + 1 >= LEVELS.length) {
    setTimeout(winGame, 900);
    showOverlay(
      '<h2>Level complete!</h2>' +
      '<p>Time bonus: <b>+' + timeBonus + '</b>' + (ghost ? ' · Ghost bonus: <b>+' + ghost + '</b>' : '') + '</p>' +
      '<p class="muted">One moment…</p>'
    );
  } else {
    showOverlay(
      '<h2>Level ' + (level + 1) + ' clear!</h2>' +
      '<p>Time bonus: <b>+' + timeBonus + '</b>' + (ghost ? ' · Ghost bonus: <b>+' + ghost + '</b> (never spotted)' : '') + '</p>' +
      '<p>Next: <b>' + LEVELS[level + 1].name + '</b> — more guards, faster patrols.</p>' +
      '<button id="nextBtn">Next level →</button>'
    );
    $('nextBtn').onclick = () => loadLevel(level + 1);
  }
}

function winGame() {
  phase = 'win';
  clearInterval(timerId);
  sfx.win();
  showOverlay(
    '<h2>Clean getaway!</h2>' +
    '<p class="big">Final score: <b>' + score + '</b></p>' +
    '<p>Three vaults, ' + LEVELS.reduce((n, L) => n + (L.map.join('').match(/L/g) || []).length, 0) + ' gems — and the guards never knew you were there. (Or did they?)</p>' +
    '<button id="againBtn">Play again</button>'
  );
  $('againBtn').onclick = () => { score = 0; loadLevel(0); };
}

function showTitle() {
  phase = 'title';
  loadLevel(0);
  phase = 'title';
  draw();
  showOverlay(
    '<h1>Shadow Heist</h1>' +
    '<p class="tag">Top-down stealth — slip past the guards, grab the gems, vanish.</p>' +
    '<p>Move with <b>WASD / arrows</b>. Hold <b>Shift</b> to sneak: slower, quieter, harder to spot.<br>' +
    'Crates block a guard\'s sight. Bushes hide you. A yellow cone means a guard is watching — if it turns red, break line of sight fast.<br>' +
    'Grab every gem, then reach the green EXIT. 3 vaults, ' + LEVELS.reduce((n, L) => n + (L.map.join('').match(/L/g) || []).length, 0) + ' gems.</p>' +
    '<button id="playBtn">▶ Start the heist</button>' +
    '<p class="muted small">M = mute · R = restart level · listen for footsteps: louder means closer.</p>'
  );
  $('playBtn').onclick = () => { score = 0; loadLevel(0); };
}

// ---------- loop / input ----------
let last = performance.now();
let frame = 0;
function loop(now) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  frame++;
  if (phase === 'playing') update(dt);
  if (phase === 'playing' || phase === 'title') draw();
  requestAnimationFrame(loop);
}

window.addEventListener('keydown', (e) => {
  keys[e.key.toLowerCase()] = true;
  if (['arrowup', 'arrowdown', 'arrowleft', 'arrowright', ' '].includes(e.key.toLowerCase())) e.preventDefault();
  if (e.key === 'm' || e.key === 'M') $('muteBtn').click();
  if (e.key === 'r' || e.key === 'R') { if (phase === 'playing' || phase === 'caught') loadLevel(level); }
});
window.addEventListener('keyup', (e) => { keys[e.key.toLowerCase()] = false; });

$('muteBtn').onclick = () => {
  setMuted(!isMuted());
  $('muteBtn').textContent = isMuted() ? '🔇 Muted' : '🔊 Sound';
};

// Test hook: lets a play-test script jump to a level or place the
// player, so screenshots can show every level without playing through.
window.__heist = {
  loadLevel,
  setPlayer(x, y) { player.x = x; player.y = y; },
  state() { return { phase, level, alarm, score, loot: loot.filter((l) => l.taken).length }; },
};

showTitle();
requestAnimationFrame(loop);
