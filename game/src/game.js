// Shadow Heist — the engine, rewritten. Top-down stealth on a canvas:
// slip past patrolling sentries, grab every gem, reach the exit unseen.
// Move with WASD or arrows; hold Shift to sneak (slower, quieter, harder
// to spot). Crates block a sentry's sight, bushes hide you outright, and
// a vision cone turning red means break line of sight, fast — the alarm
// drains the moment you do, so a near miss is a second chance, not a loss.

import { LEVELS, TILE } from './levels.js';
import { sfx, setMuted, isMuted } from './audio.js';

// ---- tuning: one place for every number the feel depends on ----
const TUNING = {
  boardW: 24 * TILE,
  boardH: 15 * TILE,
  thiefRadius: 14,
  sentryRadius: 14,
  walkSpeed: 175,
  sneakSpeed: 95,
  coneRange: 200,
  coneHalfAngle: 0.6,
  pickupRadius: 26,
  exitRadius: 30,
  spotRateWalk: 55,
  spotRateSneak: 26,
  suspicionDecay: 22,
  chaseSpeedBoost: 1.35,
  sneakConeShrink: 0.6,
  footstepChance: 2.2,
  hearRadius: 420,
};

// ---- run state ----
let phase = 'title'; // title | playing | caught | levelDone | win
let levelIndex = 0;
let grid = [];
let gems = []; // { x, y, taken }
let exitSpot = { x: 0, y: 0 };
let thief = { x: 0, y: 0, r: TUNING.thiefRadius, facing: 0, sneaking: false };
let sentries = []; // { x, y, dir, route, routeIndex, speed, mode, suspicion, lastSeen, pause }
let pressed = {};
let alarm = 0; // 0..100, the worst sentry suspicion right now
let everSpotted = false; // any sentry fully alerted on this level
let score = 0;
let timeLeft = 0;
let clockId = null;
let strideTimer = 0;
let lastTickSecond = -1;
let frame = 0;

const $ = (id) => document.getElementById(id);
const canvas = $('game');
const paint = canvas.getContext('2d');

// ---- tiles ----
function tileAt(px, py) {
  const tx = Math.floor(px / TILE);
  const ty = Math.floor(py / TILE);
  if (tx < 0 || ty < 0 || ty >= grid.length || tx >= grid[0].length) return '#';
  return grid[ty][tx];
}
const isSolid = (t) => t === '#' || t === 'C';
const blocksSight = (t) => t === '#' || t === 'C';
const inBush = (x, y) => tileAt(x, y) === 'B';

// Straight-line sight between two points, cut by walls and crates.
function canSee(x0, y0, x1, y1) {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const dist = Math.hypot(dx, dy);
  const steps = Math.ceil(dist / 8);
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    if (blocksSight(tileAt(x0 + dx * t, y0 + dy * t))) return false;
  }
  return true;
}

// ---- levels ----
function loadLevel(i) {
  levelIndex = i;
  const def = LEVELS[i];
  grid = def.map.map((row) => row.split(''));
  gems = [];
  sentries = [];
  alarm = 0;
  everSpotted = false;
  timeLeft = def.par;
  for (let y = 0; y < grid.length; y++) {
    for (let x = 0; x < grid[y].length; x++) {
      const cell = grid[y][x];
      const cx = x * TILE + TILE / 2;
      const cy = y * TILE + TILE / 2;
      if (cell === 'P') { thief.x = cx; thief.y = cy; grid[y][x] = '.'; }
      if (cell === 'L') { gems.push({ x: cx, y: cy, taken: false }); grid[y][x] = '.'; }
      if (cell === 'E') { exitSpot = { x: cx, y: cy }; grid[y][x] = '.'; }
    }
  }
  for (const patrol of def.guards) {
    const [sx, sy] = patrol.waypoints[0];
    sentries.push({
      x: sx * TILE + TILE / 2,
      y: sy * TILE + TILE / 2,
      r: TUNING.sentryRadius,
      dir: 0,
      route: patrol.waypoints.map(([wx, wy]) => ({ x: wx * TILE + TILE / 2, y: wy * TILE + TILE / 2 })),
      routeIndex: 1,
      speed: patrol.speed * TILE,
      mode: 'patrol', // patrol | chase | search
      suspicion: 0,
      lastSeen: null,
      pause: 0,
    });
  }
  phase = 'playing';
  hideOverlay();
  refreshHUD();
  clearInterval(clockId);
  clockId = setInterval(() => {
    if (phase !== 'playing') return;
    timeLeft -= 0.1;
    if (timeLeft <= 10 && Math.ceil(timeLeft) !== lastTickSecond) {
      lastTickSecond = Math.ceil(timeLeft);
      if (timeLeft > 0) sfx.click();
    }
    if (timeLeft <= 0) {
      timeLeft = 0;
      caught('Time\u2019s up \u2014 the vault sealed itself.');
    }
    refreshHUD();
  }, 100);
}

// Slide a circle along one axis, stopping at solid tiles.
function slide(body, dx, dy) {
  const nx = body.x + dx;
  if (
    !isSolid(tileAt(nx + Math.sign(dx) * body.r, body.y - body.r + 2)) &&
    !isSolid(tileAt(nx + Math.sign(dx) * body.r, body.y + body.r - 2))
  ) body.x = nx;
  const ny = body.y + dy;
  if (
    !isSolid(tileAt(body.x - body.r + 2, ny + Math.sign(dy) * body.r)) &&
    !isSolid(tileAt(body.x + body.r - 2, ny + Math.sign(dy) * body.r))
  ) body.y = ny;
}

// ---- the tick ----
function update(dt) {
  if (phase !== 'playing') return;

  // --- the thief ---
  const mx =
    (pressed['arrowright'] || pressed['d'] ? 1 : 0) -
    (pressed['arrowleft'] || pressed['a'] ? 1 : 0);
  const my =
    (pressed['arrowdown'] || pressed['s'] ? 1 : 0) -
    (pressed['arrowup'] || pressed['w'] ? 1 : 0);
  thief.sneaking = !!pressed['shift'];
  const pace = thief.sneaking ? TUNING.sneakSpeed : TUNING.walkSpeed;
  if (mx || my) {
    const len = Math.hypot(mx, my);
    const nx = mx / len;
    const ny = my / len;
    thief.facing = Math.atan2(ny, nx);
    slide(thief, nx * pace * dt, ny * pace * dt);
    strideTimer -= dt;
    if (strideTimer <= 0) {
      strideTimer = thief.sneaking ? 0.55 : 0.34;
      if (thief.sneaking) sfx.sneakStep();
    }
  }

  // --- gems ---
  for (const gem of gems) {
    if (!gem.taken && Math.hypot(thief.x - gem.x, thief.y - gem.y) < TUNING.pickupRadius) {
      gem.taken = true;
      score += 100;
      sfx.pickup();
      $('msg').textContent =
        'Loot grabbed! ' + gems.filter((g) => g.taken).length + ' / ' + gems.length;
    }
  }
  const lootedAll = gems.every((g) => g.taken);
  if (lootedAll && Math.hypot(thief.x - exitSpot.x, thief.y - exitSpot.y) < TUNING.exitRadius) {
    levelComplete();
    return;
  }

  // --- sentries ---
  let worst = 0;
  for (const sentry of sentries) {
    // Where is it headed, and how fast?
    let tx, ty;
    let pace = sentry.speed;
    if (sentry.mode === 'chase') {
      tx = sentry.lastSeen.x;
      ty = sentry.lastSeen.y;
      pace = sentry.speed * TUNING.chaseSpeedBoost;
    } else {
      tx = sentry.route[sentry.routeIndex].x;
      ty = sentry.route[sentry.routeIndex].y;
    }
    const dx = tx - sentry.x;
    const dy = ty - sentry.y;
    const dist = Math.hypot(dx, dy);
    if (sentry.mode === 'chase' && dist < 8) {
      sentry.mode = 'search';
      sentry.pause = 1.6;
    } else if (sentry.mode === 'search') {
      sentry.pause -= dt;
      sentry.dir += dt * 1.5; // scan the room
      if (sentry.pause <= 0) sentry.mode = 'patrol';
    } else if (dist > 4) {
      sentry.dir = Math.atan2(dy, dx);
      slide(sentry, (dx / dist) * pace * dt, (dy / dist) * pace * dt);
      if (sentry.mode === 'patrol' && dist < 6) {
        sentry.routeIndex = (sentry.routeIndex + 1) % sentry.route.length;
      }
    }

    // Footsteps: the closer a sentry, the louder its tread.
    const gap = Math.hypot(thief.x - sentry.x, thief.y - sentry.y);
    if (Math.random() < dt * TUNING.footstepChance) {
      sfx.step(Math.max(0, 1 - gap / TUNING.hearRadius));
    }

    // --- vision: range, cone, line of sight, bushes ---
    const hidden = inBush(thief.x, thief.y);
    const reach = TUNING.coneRange * (thief.sneaking ? TUNING.sneakConeShrink : 1);
    const close = gap < reach;
    let ang = Math.atan2(thief.y - sentry.y, thief.x - sentry.x) - sentry.dir;
    while (ang > Math.PI) ang -= Math.PI * 2;
    while (ang < -Math.PI) ang += Math.PI * 2;
    const inside = Math.abs(ang) < TUNING.coneHalfAngle;
    const seen = close && inside && canSee(sentry.x, sentry.y, thief.x, thief.y) && !hidden;
    if (seen) {
      const base = thief.sneaking ? TUNING.spotRateSneak : TUNING.spotRateWalk;
      const rate = base * (1.6 - Math.min(1, gap / TUNING.coneRange));
      sentry.suspicion = Math.min(100, sentry.suspicion + rate * dt);
      sentry.lastSeen = { x: thief.x, y: thief.y };
      if (sentry.suspicion > 50 && sentry.mode === 'patrol') {
        sentry.mode = 'chase';
        sfx.suspicious();
        $('msg').textContent = 'A guard heard something\u2026';
      }
      if (sentry.suspicion >= 100) {
        everSpotted = true;
        sfx.spotted();
        caught('Spotted! The guard raised the alarm.');
        return;
      }
    } else {
      sentry.suspicion = Math.max(0, sentry.suspicion - TUNING.suspicionDecay * dt);
      if (sentry.mode === 'chase' && sentry.suspicion < 25) sentry.mode = 'patrol';
    }
    worst = Math.max(worst, sentry.suspicion);
  }
  alarm = worst;
  refreshHUD();
}

// ---- drawing ----
function draw() {
  const W = TUNING.boardW;
  const H = TUNING.boardH;
  paint.clearRect(0, 0, W, H);

  // Floor, walls, crates, bushes.
  for (let y = 0; y < grid.length; y++) {
    for (let x = 0; x < grid[y].length; x++) {
      const px = x * TILE;
      const py = y * TILE;
      const cell = grid[y][x];
      if (cell === '#') {
        paint.fillStyle = '#2d3436';
        paint.fillRect(px, py, TILE, TILE);
        paint.fillStyle = '#3d4548';
        paint.fillRect(px, py, TILE, 5);
      } else {
        paint.fillStyle = (x + y) % 2 === 0 ? '#3a3f4a' : '#353a45';
        paint.fillRect(px, py, TILE, TILE);
        if (cell === 'C') {
          paint.fillStyle = '#8b5a2b';
          paint.fillRect(px + 4, py + 4, TILE - 8, TILE - 8);
          paint.strokeStyle = '#6c4a2f';
          paint.lineWidth = 2;
          paint.strokeRect(px + 4, py + 4, TILE - 8, TILE - 8);
          paint.beginPath();
          paint.moveTo(px + 4, py + 4);
          paint.lineTo(px + TILE - 4, py + TILE - 4);
          paint.moveTo(px + TILE - 4, py + 4);
          paint.lineTo(px + 4, py + TILE - 4);
          paint.stroke();
        }
        if (cell === 'B') {
          paint.fillStyle = '#27ae60';
          paint.beginPath();
          paint.arc(px + 12, py + 14, 10, 0, Math.PI * 2);
          paint.arc(px + 26, py + 10, 11, 0, Math.PI * 2);
          paint.arc(px + 20, py + 26, 11, 0, Math.PI * 2);
          paint.fill();
          paint.fillStyle = '#2ecc71';
          paint.beginPath();
          paint.arc(px + 16, py + 18, 6, 0, Math.PI * 2);
          paint.arc(px + 28, py + 24, 5, 0, Math.PI * 2);
          paint.fill();
        }
      }
    }
  }

  // Vision cones: gold while calm, red once a sentry is onto you.
  for (const sentry of sentries) {
    const hot = sentry.suspicion > 50;
    const glow = paint.createRadialGradient(
      sentry.x, sentry.y, 10, sentry.x, sentry.y, TUNING.coneRange,
    );
    glow.addColorStop(0, hot ? 'rgba(231,76,60,0.55)' : 'rgba(247,183,49,0.45)');
    glow.addColorStop(1, 'rgba(247,183,49,0)');
    paint.fillStyle = glow;
    paint.beginPath();
    paint.moveTo(sentry.x, sentry.y);
    paint.arc(
      sentry.x, sentry.y, TUNING.coneRange,
      sentry.dir - TUNING.coneHalfAngle, sentry.dir + TUNING.coneHalfAngle,
    );
    paint.closePath();
    paint.fill();
  }

  // Exit: grey and locked until every gem is taken, then green.
  const lootedAll = gems.every((g) => g.taken);
  paint.fillStyle = lootedAll ? '#2ecc71' : '#636e72';
  paint.fillRect(exitSpot.x - 18, exitSpot.y - 18, 36, 36);
  paint.fillStyle = '#dfe6e9';
  paint.font = 'bold 11px sans-serif';
  paint.textAlign = 'center';
  paint.fillText(lootedAll ? 'EXIT' : 'LOCK', exitSpot.x, exitSpot.y + 4);

  // Gems, gently pulsing so they catch the eye at a glance.
  const pulse = 1 + 0.12 * Math.sin(frame * 0.08);
  for (const gem of gems) {
    if (gem.taken) continue;
    paint.fillStyle = '#00cec9';
    paint.beginPath();
    paint.moveTo(gem.x, gem.y - 10 * pulse);
    paint.lineTo(gem.x + 8 * pulse, gem.y);
    paint.lineTo(gem.x, gem.y + 10 * pulse);
    paint.lineTo(gem.x - 8 * pulse, gem.y);
    paint.closePath();
    paint.fill();
    paint.fillStyle = '#ffffff';
    paint.beginPath();
    paint.moveTo(gem.x, gem.y - 5);
    paint.lineTo(gem.x + 3, gem.y);
    paint.lineTo(gem.x, gem.y + 5);
    paint.lineTo(gem.x - 3, gem.y);
    paint.closePath();
    paint.fill();
  }

  // Sentries, with a suspicion ring that fills as they get sure of you.
  for (const sentry of sentries) {
    paint.fillStyle = sentry.suspicion > 50 ? '#e74c3c' : '#e17055';
    paint.beginPath();
    paint.arc(sentry.x, sentry.y, 14, 0, Math.PI * 2);
    paint.fill();
    paint.fillStyle = '#2d3436';
    paint.beginPath();
    paint.arc(
      sentry.x + Math.cos(sentry.dir) * 7,
      sentry.y + Math.sin(sentry.dir) * 7,
      5, 0, Math.PI * 2,
    );
    paint.fill();
    if (sentry.suspicion > 2) {
      paint.strokeStyle = sentry.suspicion > 50 ? '#e74c3c' : '#f7b731';
      paint.lineWidth = 3;
      paint.beginPath();
      paint.arc(
        sentry.x, sentry.y, 19,
        -Math.PI / 2, -Math.PI / 2 + (sentry.suspicion / 100) * Math.PI * 2,
      );
      paint.stroke();
    }
    if (sentry.suspicion > 50) {
      paint.fillStyle = '#e74c3c';
      paint.font = 'bold 16px sans-serif';
      paint.fillText('!', sentry.x, sentry.y - 24);
    }
  }

  // The thief: bright blue with a gold ring, so you can always pick
  // yourself out against the dark floor at a glance.
  paint.fillStyle = '#4a7fb5';
  paint.beginPath();
  paint.arc(thief.x, thief.y, thief.r, 0, Math.PI * 2);
  paint.fill();
  paint.strokeStyle = '#f7b731';
  paint.lineWidth = 2;
  paint.beginPath();
  paint.arc(thief.x, thief.y, thief.r, 0, Math.PI * 2);
  paint.stroke();
  paint.fillStyle = '#f7b731';
  paint.beginPath();
  paint.arc(
    thief.x + Math.cos(thief.facing) * 6,
    thief.y + Math.sin(thief.facing) * 6,
    5, 0, Math.PI * 2,
  );
  paint.fill();
  if (thief.sneaking) {
    paint.strokeStyle = 'rgba(247,183,49,0.8)';
    paint.lineWidth = 2;
    paint.setLineDash([4, 4]);
    paint.beginPath();
    paint.arc(thief.x, thief.y, thief.r + 5, 0, Math.PI * 2);
    paint.stroke();
    paint.setLineDash([]);
  }

  // Darkness: a pool of light around the thief, gloom everywhere else.
  const dark = paint.createRadialGradient(thief.x, thief.y, 90, thief.x, thief.y, 340);
  dark.addColorStop(0, 'rgba(0,0,0,0)');
  dark.addColorStop(1, 'rgba(0,0,0,0.42)');
  paint.fillStyle = dark;
  paint.fillRect(0, 0, W, H);
}

// ---- HUD and flow ----
function refreshHUD() {
  const def = LEVELS[levelIndex];
  $('levelName').textContent = 'Level ' + (levelIndex + 1) + ' \u00b7 ' + def.name;
  $('lootCount').textContent = gems.filter((g) => g.taken).length + ' / ' + gems.length;
  $('score').textContent = score;
  $('timeLeft').textContent = Math.max(0, Math.ceil(timeLeft)) + 's';
  $('alarmBar').style.width = alarm + '%';
  $('alarmBar').classList.toggle('hot', alarm > 50);
  $('alarmLabel').textContent =
    alarm > 50 ? 'SPOTTED!' : alarm > 2 ? 'suspicious\u2026' : 'unseen';
  document.querySelectorAll('.dot').forEach((d, i) => {
    d.classList.toggle('done', i < levelIndex);
    d.classList.toggle('now', i === levelIndex);
  });
}

function showOverlay(html) {
  $('overlay').innerHTML = html;
  $('overlay').classList.remove('hidden');
}
function hideOverlay() {
  $('overlay').classList.add('hidden');
}

function caught(reason) {
  phase = 'caught';
  clearInterval(clockId);
  sfx.caught();
  showOverlay(
    '<h2>Caught!</h2>' +
    '<p>' + reason + '</p>' +
    '<p class="muted">Tip: wait for the cone to swing away, sneak (Shift) past, and let crates break the sentry\u2019s line of sight.</p>' +
    '<button id="retryBtn">Try again</button>',
  );
  $('retryBtn').onclick = () => loadLevel(levelIndex);
}

function levelComplete() {
  phase = 'levelDone';
  clearInterval(clockId);
  const timeBonus = Math.ceil(timeLeft) * 5;
  const ghost = everSpotted ? 0 : 150;
  score += timeBonus + ghost;
  sfx.exit();
  refreshHUD();
  if (levelIndex + 1 >= LEVELS.length) {
    setTimeout(winGame, 900);
    showOverlay(
      '<h2>Level complete!</h2>' +
      '<p>Time bonus: <b>+' + timeBonus + '</b>' +
      (ghost ? ' \u00b7 Ghost bonus: <b>+' + ghost + '</b>' : '') + '</p>' +
      '<p class="muted">One moment\u2026</p>',
    );
  } else {
    showOverlay(
      '<h2>Level ' + (levelIndex + 1) + ' clear!</h2>' +
      '<p>Time bonus: <b>+' + timeBonus + '</b>' +
      (ghost ? ' \u00b7 Ghost bonus: <b>+' + ghost + '</b> (never spotted)' : '') + '</p>' +
      '<p>Next: <b>' + LEVELS[levelIndex + 1].name + '</b> \u2014 more guards, faster patrols.</p>' +
      '<button id="nextBtn">Next level \u2192</button>',
    );
    $('nextBtn').onclick = () => loadLevel(levelIndex + 1);
  }
}

function winGame() {
  phase = 'win';
  clearInterval(clockId);
  sfx.win();
  showOverlay(
    '<h2>Clean getaway!</h2>' +
    '<p class="big">Final score: <b>' + score + '</b></p>' +
    '<p>Three vaults, ' +
    LEVELS.reduce((n, L) => n + (L.map.join('').match(/L/g) || []).length, 0) +
    ' gems \u2014 and the guards never knew you were there. (Or did they?)</p>' +
    '<button id="againBtn">Play again</button>',
  );
  $('againBtn').onclick = () => {
    score = 0;
    loadLevel(0);
  };
}

function showTitle() {
  phase = 'title';
  loadLevel(0);
  phase = 'title';
  draw();
  showOverlay(
    '<h1>Shadow Heist</h1>' +
    '<p class="tag">Top-down stealth \u2014 slip past the guards, grab the gems, vanish.</p>' +
    '<p>Move with <b>WASD / arrows</b>. Hold <b>Shift</b> to sneak: slower, quieter, harder to spot.<br>' +
    'Crates block a guard\u2019s sight. Bushes hide you. A yellow cone means a guard is watching \u2014 if it turns red, break line of sight fast.<br>' +
    'Grab every gem, then reach the green EXIT. 3 vaults, ' +
    LEVELS.reduce((n, L) => n + (L.map.join('').match(/L/g) || []).length, 0) +
    ' gems.</p>' +
    '<button id="playBtn">\u25b6 Start the heist</button>' +
    '<p class="muted small">M = mute \u00b7 R = restart level \u00b7 listen for footsteps: louder means closer.</p>',
  );
  $('playBtn').onclick = () => {
    score = 0;
    loadLevel(0);
  };
}

// ---- loop and input ----
let last = performance.now();
function loop(now) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  frame++;
  if (phase === 'playing') update(dt);
  if (phase === 'playing' || phase === 'title') draw();
  requestAnimationFrame(loop);
}

window.addEventListener('keydown', (e) => {
  pressed[e.key.toLowerCase()] = true;
  if (['arrowup', 'arrowdown', 'arrowleft', 'arrowright', ' '].includes(e.key.toLowerCase())) {
    e.preventDefault();
  }
  if (e.key === 'm' || e.key === 'M') $('muteBtn').click();
  if (e.key === 'r' || e.key === 'R') {
    if (phase === 'playing' || phase === 'caught') loadLevel(levelIndex);
  }
});
window.addEventListener('keyup', (e) => {
  pressed[e.key.toLowerCase()] = false;
});

$('muteBtn').onclick = () => {
  setMuted(!isMuted());
  $('muteBtn').textContent = isMuted() ? '\uD83D\uDD07 Muted' : '\uD83D\uDD0A Sound';
};

// Test hook: lets a play-test script jump to a level or place the thief,
// so screenshots can show every level without playing through.
window.__heist = {
  loadLevel,
  setPlayer(x, y) {
    thief.x = x;
    thief.y = y;
  },
  state() {
    return {
      phase,
      level: levelIndex,
      alarm,
      score,
      loot: gems.filter((g) => g.taken).length,
    };
  },
};

showTitle();
requestAnimationFrame(loop);
