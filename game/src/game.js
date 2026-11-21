// Shadow Heist — top-down stealth game.
//
// You are the thief. Slip past the patrolling guards, grab every gem,
// then reach the exit without being seen. Walls and crates block sight;
// bushes hide you; sneaking (Shift) is slow but hard to notice.
//
// Plain canvas 2D, no libraries, no network: everything the game needs
// is in this folder.

(function () {
  'use strict';

  var TILE = 40;
  var COLS = 24;
  var ROWS = 15;
  var VIEW_W = COLS * TILE; // 960
  var VIEW_H = ROWS * TILE; // 600

  var SIGHT_RANGE = 185;
  var SIGHT_HALF_ANGLE = 0.62; // ~35 degrees each side
  var CHASE_SPEED = 138;
  var CATCH_DIST = 26;
  var SPOT_DIST = 42; // point blank: no hiding from that

  var canvas = document.getElementById('game');
  var ctx = canvas.getContext('2d');

  var hudLevel = document.getElementById('hud-level');
  var hudLoot = document.getElementById('hud-loot');
  var hudTime = document.getElementById('hud-time');
  var hudScore = document.getElementById('hud-score');
  var hudStatus = document.getElementById('hud-status');
  var detectFill = document.getElementById('detect-fill');
  var dots = document.querySelectorAll('.lvl-dot');
  var soundBtn = document.getElementById('btn-sound');

  var overlays = {
    start: document.getElementById('ov-start'),
    clear: document.getElementById('ov-clear'),
    caught: document.getElementById('ov-caught'),
    win: document.getElementById('ov-win'),
    pause: document.getElementById('ov-pause'),
  };
  var clearStats = document.getElementById('clear-stats');
  var caughtWhy = document.getElementById('caught-why');
  var winStats = document.getElementById('win-stats');

  // ---------------------------------------------------------------- state

  var state = 'menu'; // menu | playing | paused | caught | clear | win
  var levelIndex = 0;
  var level = null; // parsed level
  var player = null;
  var guards = [];
  var gems = [];
  var exitDoor = null;
  var timeLeft = 0;
  var score = 0;
  var scoreAtLevelStart = 0; // retrying a level gives the points back
  var lootGot = 0;
  var lootTotal = 0;
  var spottedThisLevel = false;
  var spottedThisRun = false;
  var doorAnnounced = false;
  var elapsed = 0;

  var keys = {};
  var stepAcc = 0;
  var guardStepAcc = [];

  // ------------------------------------------------------------ level setup

  function tileAt(col, row) {
    if (col < 0 || col >= COLS || row < 0 || row >= ROWS) return '#';
    return level.map[row][col];
  }

  function isSolid(col, row) {
    var t = tileAt(col, row);
    return t === '#' || t === 'C';
  }

  function isBush(col, row) {
    return tileAt(col, row) === 'B';
  }

  function tileCenter(col, row) {
    return { x: col * TILE + TILE / 2, y: row * TILE + TILE / 2 };
  }

  function loadLevel(index) {
    var def = window.SH_LEVELS[index];
    levelIndex = index;
    level = {
      name: def.name,
      time: def.time,
      map: def.map,
      guards: def.guards,
    };
    gems = [];
    guards = [];
    var start = { x: TILE * 1.5, y: TILE * 1.5 };

    for (var row = 0; row < ROWS; row++) {
      for (var col = 0; col < COLS; col++) {
        var ch = level.map[row][col];
        var c = tileCenter(col, row);
        if (ch === 'P') start = { x: c.x, y: c.y };
        if (ch === '*') gems.push({ x: c.x, y: c.y, taken: false, phase: Math.random() * 6 });
        if (ch === 'E') exitDoor = { x: c.x, y: c.y, open: false };
      }
    }

    player = {
      x: start.x, y: start.y, r: 13, cr: 11,
      dir: 0, sneaking: false, moving: false,
    };

    level.guards.forEach(function (g) {
      var s = tileCenter(g.x, g.y);
      guards.push({
        x: s.x, y: s.y, r: 13,
        dir: Math.PI / 2,
        path: g.path.map(function (p) { return tileCenter(p[0], p[1]); }),
        wp: 1, // next waypoint index
        pause: 0,
        speed: g.speed,
        mode: 'patrol', // patrol | investigate | chase | return
        suspicion: 0,
        lastSeen: { x: s.x, y: s.y },
        lostTimer: 0,
        lookTimer: 0,
        lookDir: 0,
        target: null,
      });
    });
    guardStepAcc = guards.map(function () { return 0; });

    lootGot = 0;
    lootTotal = gems.length;
    timeLeft = level.time;
    spottedThisLevel = false;
    doorAnnounced = false;
    updateHud();
  }

  // -------------------------------------------------------------- collision

  function circleHitsSolid(x, y, r) {
    var c0 = Math.floor((x - r) / TILE);
    var c1 = Math.floor((x + r) / TILE);
    var r0 = Math.floor((y - r) / TILE);
    var r1 = Math.floor((y + r) / TILE);
    for (var row = r0; row <= r1; row++) {
      for (var col = c0; col <= c1; col++) {
        if (!isSolid(col, row)) continue;
        var bx = Math.max(col * TILE, Math.min(x, col * TILE + TILE));
        var by = Math.max(row * TILE, Math.min(y, row * TILE + TILE));
        var dx = x - bx;
        var dy = y - by;
        if (dx * dx + dy * dy < r * r) return true;
      }
    }
    return false;
  }

  function moveCircle(body, dx, dy) {
    // collision radius is a touch smaller than the drawn one, so the thief
    // slips around doorframe corners instead of snagging on them
    var r = body.cr || body.r;
    if (dx !== 0 && !circleHitsSolid(body.x + dx, body.y, r)) body.x += dx;
    if (dy !== 0 && !circleHitsSolid(body.x, body.y + dy, r)) body.y += dy;
  }

  // ---------------------------------------------------------------- vision

  function losClear(x0, y0, x1, y1) {
    var dx = x1 - x0;
    var dy = y1 - y0;
    var dist = Math.hypot(dx, dy);
    var steps = Math.max(1, Math.ceil(dist / 6));
    for (var i = 1; i < steps; i++) {
      var t = i / steps;
      var col = Math.floor((x0 + dx * t) / TILE);
      var row = Math.floor((y0 + dy * t) / TILE);
      if (isSolid(col, row)) return false;
    }
    return true;
  }

  function angleDiff(a, b) {
    var d = a - b;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    return d;
  }

  function guardSees(g) {
    var dx = player.x - g.x;
    var dy = player.y - g.y;
    var dist = Math.hypot(dx, dy);
    if (dist > SIGHT_RANGE) return false;
    if (dist > SPOT_DIST) {
      var ang = Math.atan2(dy, dx);
      if (Math.abs(angleDiff(ang, g.dir)) > SIGHT_HALF_ANGLE) return false;
    }
    return losClear(g.x, g.y, player.x, player.y);
  }

  function playerHidden() {
    var col = Math.floor(player.x / TILE);
    var row = Math.floor(player.y / TILE);
    return isBush(col, row);
  }

  // --------------------------------------------------------------- guard AI

  function guardWalkTo(g, tx, ty, speed, dt) {
    var dx = tx - g.x;
    var dy = ty - g.y;
    var dist = Math.hypot(dx, dy);
    if (dist < 4) return true;
    var step = Math.min(dist, speed * dt);
    var nx = g.x + (dx / dist) * step;
    var ny = g.y + (dy / dist) * step;
    g.dir = Math.atan2(dy, dx);
    if (!circleHitsSolid(nx, ny, g.r)) {
      g.x = nx;
      g.y = ny;
    }
    return dist - step < 4;
  }

  function updateGuard(g, i, dt) {
    var sees = guardSees(g);
    var dist = Math.hypot(player.x - g.x, player.y - g.y);

    // --- suspicion
    if (sees) {
      var rate = 0.95 * (1 - 0.55 * (dist / SIGHT_RANGE));
      if (player.sneaking) rate *= 0.45;
      if (playerHidden()) rate *= 0.12;
      if (!player.moving) rate *= 0.75;
      g.suspicion += rate * dt;
      g.lastSeen = { x: player.x, y: player.y };
      g.lostTimer = 0;
    } else {
      g.suspicion = Math.max(0, g.suspicion - 0.22 * dt);
      if (g.mode === 'chase') g.lostTimer += dt;
    }
    if (dist < SPOT_DIST && g.mode !== 'chase') g.suspicion = 1;
    if (g.suspicion > 1) g.suspicion = 1;

    // --- mode changes
    if (g.suspicion >= 1 && g.mode !== 'chase') {
      g.mode = 'chase';
      spottedThisLevel = true;
      spottedThisRun = true;
      window.SH_SOUND.alarm();
    } else if (g.suspicion >= 0.45 && g.mode === 'patrol') {
      g.mode = 'investigate';
      g.target = { x: g.lastSeen.x, y: g.lastSeen.y };
      window.SH_SOUND.suspicious();
    }

    // --- behaviour
    if (g.mode === 'patrol') {
      if (g.pause > 0) {
        g.pause -= dt;
      } else {
        var wp = g.path[g.wp];
        if (guardWalkTo(g, wp.x, wp.y, g.speed, dt)) {
          g.wp = (g.wp + 1) % g.path.length;
          g.pause = 1.5; // linger at each end: a readable window to slip past
        }
      }
    } else if (g.mode === 'investigate') {
      if (g.lookTimer > 0) {
        g.lookTimer -= dt;
        g.dir += dt * 1.6; // scan the room
        if (g.lookTimer <= 0) g.mode = 'return';
      } else if (guardWalkTo(g, g.target.x, g.target.y, g.speed * 1.25, dt)) {
        g.lookTimer = 1.2;
      }
    } else if (g.mode === 'chase') {
      if (sees) {
        guardWalkTo(g, player.x, player.y, CHASE_SPEED, dt);
        g.lostTimer = 0;
      } else if (g.lostTimer > 2.5) {
        g.mode = 'return';
        g.suspicion = 0.5;
      } else {
        guardWalkTo(g, g.lastSeen.x, g.lastSeen.y, CHASE_SPEED * 0.85, dt);
      }
      if (dist < CATCH_DIST) {
        endCaught('A guard grabbed you in the open.');
      }
    } else if (g.mode === 'return') {
      // head back to the nearest waypoint, then resume the patrol
      var best = 0;
      var bestD = Infinity;
      g.path.forEach(function (p, idx) {
        var d = Math.hypot(p.x - g.x, p.y - g.y);
        if (d < bestD) { bestD = d; best = idx; }
      });
      var dest = g.path[best];
      if (guardWalkTo(g, dest.x, dest.y, g.speed * 1.1, dt)) {
        g.wp = (best + 1) % g.path.length;
        g.mode = 'patrol';
      }
    }

    // --- footsteps: you can hear a guard coming before you see him
    guardStepAcc[i] += dt * (g.mode === 'chase' ? 2.2 : 1.4);
    if (guardStepAcc[i] > 0.55) {
      guardStepAcc[i] = 0;
      if (dist < 340) window.SH_SOUND.guardStep(dist);
    }
  }

  // ---------------------------------------------------------------- update

  function update(dt) {
    if (state !== 'playing') return;
    elapsed += dt;
    timeLeft -= dt;
    if (timeLeft <= 0) {
      timeLeft = 0;
      endCaught('Out of time — the gallery lights came on.');
      return;
    }

    // --- player movement
    var mx = 0;
    var my = 0;
    if (keys['arrowleft'] || keys['a']) mx -= 1;
    if (keys['arrowright'] || keys['d']) mx += 1;
    if (keys['arrowup'] || keys['w']) my -= 1;
    if (keys['arrowdown'] || keys['s']) my += 1;
    player.moving = mx !== 0 || my !== 0;
    player.sneaking = !!keys['shift'];
    if (player.moving) {
      var len = Math.hypot(mx, my);
      var speed = player.sneaking ? 88 : 155;
      var dx = (mx / len) * speed * dt;
      var dy = (my / len) * speed * dt;
      player.dir = Math.atan2(dy, dx);
      moveCircle(player, dx, dy);
      stepAcc += dt * (player.sneaking ? 1.8 : 2.9);
      if (stepAcc > 1) {
        stepAcc = 0;
        window.SH_SOUND.step(player.sneaking);
      }
    }

    // --- gems
    gems.forEach(function (gem) {
      if (gem.taken) return;
      if (Math.hypot(player.x - gem.x, player.y - gem.y) < 26) {
        gem.taken = true;
        lootGot += 1;
        score += 100;
        window.SH_SOUND.pickup();
        if (lootGot === lootTotal && !doorAnnounced) {
          doorAnnounced = true;
          exitDoor.open = true;
          window.SH_SOUND.unlockDoor();
        }
        updateHud();
      }
    });

    // --- exit
    if (exitDoor.open &&
        Math.hypot(player.x - exitDoor.x, player.y - exitDoor.y) < 30) {
      endClear();
      return;
    }

    // --- guards
    guards.forEach(function (g, i) { updateGuard(g, i, dt); });

    updateHud();
  }

  // ------------------------------------------------------------- state flow

  function showOverlay(name) {
    Object.keys(overlays).forEach(function (k) {
      overlays[k].classList.toggle('hidden', k !== name);
    });
  }

  function hideOverlays() {
    Object.keys(overlays).forEach(function (k) {
      overlays[k].classList.add('hidden');
    });
  }

  function startGame() {
    window.SH_SOUND.unlock();
    window.SH_SOUND.click();
    score = 0;
    scoreAtLevelStart = 0;
    spottedThisRun = false;
    loadLevel(0);
    state = 'playing';
    hideOverlays();
    updateHud();
  }

  function endCaught(reason) {
    if (state !== 'playing') return;
    state = 'caught';
    caughtWhy.textContent = reason;
    window.SH_SOUND.caught();
    showOverlay('caught');
  }

  function endClear() {
    var bonus = 250 + Math.ceil(timeLeft) * 5;
    score += bonus;
    state = 'clear';
    window.SH_SOUND.levelClear();
    clearStats.textContent =
      'Loot ' + lootGot + ' / ' + lootTotal +
      '  ·  time bonus +' + bonus +
      (spottedThisLevel ? '  ·  spotted once' : '  ·  never spotted');
    updateHud();
    showOverlay('clear');
  }

  function retryLevel() {
    window.SH_SOUND.click();
    score = scoreAtLevelStart;
    loadLevel(levelIndex);
    state = 'playing';
    hideOverlays();
  }

  function nextLevel() {
    window.SH_SOUND.click();
    if (levelIndex + 1 >= window.SH_LEVELS.length) {
      endWin();
      return;
    }
    scoreAtLevelStart = score;
    loadLevel(levelIndex + 1);
    state = 'playing';
    hideOverlays();
  }

  function endWin() {
    if (!spottedThisRun) score += 500; // ghost bonus
    state = 'win';
    window.SH_SOUND.win();
    winStats.textContent =
      'Final score ' + score +
      (spottedThisRun ? '  ·  spotted along the way' : '  ·  GHOST — never spotted once (+500)');
    updateHud();
    showOverlay('win');
  }

  function togglePause() {
    if (state === 'playing') {
      state = 'paused';
      showOverlay('pause');
    } else if (state === 'paused') {
      state = 'playing';
      hideOverlays();
    }
  }

  // ------------------------------------------------------------------- HUD

  function updateHud() {
    hudLevel.textContent = 'Level ' + (levelIndex + 1) + ' · ' + level.name;
    hudLoot.textContent = 'Loot ' + lootGot + ' / ' + lootTotal;
    var t = Math.max(0, Math.ceil(timeLeft));
    hudTime.textContent = t + 's';
    hudTime.classList.toggle('low', t <= 15);
    hudScore.textContent = '' + score;

    var maxSuspicion = 0;
    var chasing = false;
    guards.forEach(function (g) {
      if (g.suspicion > maxSuspicion) maxSuspicion = g.suspicion;
      if (g.mode === 'chase') chasing = true;
    });
    detectFill.style.width = Math.round(maxSuspicion * 100) + '%';
    detectFill.classList.toggle('hot', chasing);

    if (chasing) {
      hudStatus.textContent = 'SPOTTED!';
      hudStatus.className = 'status spotted';
    } else if (maxSuspicion >= 0.45) {
      hudStatus.textContent = 'suspicious…';
      hudStatus.className = 'status wary';
    } else if (playerHidden()) {
      hudStatus.textContent = 'hidden in the bush';
      hudStatus.className = 'status hidden';
    } else {
      hudStatus.textContent = 'unseen';
      hudStatus.className = 'status calm';
    }

    dots.forEach(function (dot, i) {
      dot.classList.toggle('done', i < levelIndex);
      dot.classList.toggle('now', i === levelIndex);
    });
  }

  // ---------------------------------------------------------------- render

  function drawFloor() {
    for (var row = 0; row < ROWS; row++) {
      for (var col = 0; col < COLS; col++) {
        ctx.fillStyle = (row + col) % 2 === 0 ? '#202736' : '#1c2230';
        ctx.fillRect(col * TILE, row * TILE, TILE, TILE);
      }
    }
  }

  function drawWallsAndCrates() {
    for (var row = 0; row < ROWS; row++) {
      for (var col = 0; col < COLS; col++) {
        var ch = tileAt(col, row);
        var x = col * TILE;
        var y = row * TILE;
        if (ch === '#') {
          ctx.fillStyle = '#12161f';
          ctx.fillRect(x, y, TILE, TILE);
          ctx.fillStyle = '#2c3448';
          ctx.fillRect(x, y, TILE, 4);
        } else if (ch === 'C') {
          ctx.fillStyle = '#6b4a26';
          ctx.fillRect(x + 3, y + 3, TILE - 6, TILE - 6);
          ctx.strokeStyle = '#8a5f30';
          ctx.lineWidth = 2;
          ctx.strokeRect(x + 3, y + 3, TILE - 6, TILE - 6);
          ctx.beginPath();
          ctx.moveTo(x + 6, y + 6);
          ctx.lineTo(x + TILE - 6, y + TILE - 6);
          ctx.moveTo(x + TILE - 6, y + 6);
          ctx.lineTo(x + 6, y + TILE - 6);
          ctx.stroke();
        }
      }
    }
  }

  function drawBushes() {
    for (var row = 0; row < ROWS; row++) {
      for (var col = 0; col < COLS; col++) {
        if (tileAt(col, row) !== 'B') continue;
        var cx = col * TILE + TILE / 2;
        var cy = row * TILE + TILE / 2;
        ctx.fillStyle = '#2e7d4f';
        [[-8, 4, 11], [8, 6, 12], [0, -7, 12], [-2, -2, 10]].forEach(function (b) {
          ctx.beginPath();
          ctx.arc(cx + b[0], cy + b[1], b[2], 0, Math.PI * 2);
          ctx.fill();
        });
        ctx.fillStyle = '#3a9a62';
        ctx.beginPath();
        ctx.arc(cx - 4, cy - 4, 5, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  function drawGems() {
    gems.forEach(function (gem) {
      if (gem.taken) return;
      var pulse = 1 + 0.15 * Math.sin(elapsed * 4 + gem.phase);
      var s = 9 * pulse;
      ctx.save();
      ctx.translate(gem.x, gem.y);
      ctx.shadowColor = '#39d0d8';
      ctx.shadowBlur = 12;
      ctx.fillStyle = '#39d0d8';
      ctx.beginPath();
      ctx.moveTo(0, -s);
      ctx.lineTo(s * 0.7, 0);
      ctx.lineTo(0, s);
      ctx.lineTo(-s * 0.7, 0);
      ctx.closePath();
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.fillStyle = '#d8fbff';
      ctx.beginPath();
      ctx.moveTo(0, -s * 0.45);
      ctx.lineTo(s * 0.28, 0);
      ctx.lineTo(0, s * 0.45);
      ctx.lineTo(-s * 0.28, 0);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    });
  }

  function drawExit() {
    var x = exitDoor.x - 17;
    var y = exitDoor.y - 17;
    ctx.fillStyle = exitDoor.open ? '#1f7a44' : '#3a4152';
    ctx.fillRect(x, y, 34, 34);
    ctx.strokeStyle = exitDoor.open ? '#46d17c' : '#5a6378';
    ctx.lineWidth = 2;
    ctx.strokeRect(x, y, 34, 34);
    ctx.fillStyle = exitDoor.open ? '#c9ffe0' : '#9aa3b5';
    ctx.font = 'bold 9px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(exitDoor.open ? 'EXIT' : 'LOCK', exitDoor.x, exitDoor.y);
  }

  function drawCone(g) {
    var color = g.mode === 'chase'
      ? '255, 90, 70'
      : g.mode === 'investigate' ? '255, 170, 60' : '255, 205, 90';
    var grad = ctx.createRadialGradient(g.x, g.y, 10, g.x, g.y, SIGHT_RANGE);
    grad.addColorStop(0, 'rgba(' + color + ', 0.34)');
    grad.addColorStop(1, 'rgba(' + color + ', 0)');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.moveTo(g.x, g.y);
    ctx.arc(g.x, g.y, SIGHT_RANGE, g.dir - SIGHT_HALF_ANGLE, g.dir + SIGHT_HALF_ANGLE);
    ctx.closePath();
    ctx.fill();
  }

  function drawGuard(g) {
    drawCone(g);
    ctx.fillStyle = '#e5484d';
    ctx.beginPath();
    ctx.arc(g.x, g.y, g.r, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#8f1d22';
    ctx.lineWidth = 2;
    ctx.stroke();
    // facing eye
    ctx.fillStyle = '#1c1010';
    ctx.beginPath();
    ctx.arc(g.x + Math.cos(g.dir) * 6, g.y + Math.sin(g.dir) * 6, 4, 0, Math.PI * 2);
    ctx.fill();
    // suspicion arc above the guard
    if (g.suspicion > 0.05) {
      ctx.strokeStyle = g.suspicion >= 1 ? '#ff5a46' : '#ffc857';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(g.x, g.y, g.r + 6, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * g.suspicion);
      ctx.stroke();
    }
  }

  function drawPlayer() {
    var hidden = playerHidden();
    ctx.save();
    ctx.globalAlpha = hidden ? 0.55 : 1;
    if (player.sneaking) {
      ctx.strokeStyle = '#ffd166';
      ctx.setLineDash([4, 4]);
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(player.x, player.y, player.r + 5, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    ctx.fillStyle = '#4a90e2';
    ctx.beginPath();
    ctx.arc(player.x, player.y, player.r, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#1d4e89';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.fillStyle = '#ffd166';
    ctx.beginPath();
    ctx.arc(player.x + Math.cos(player.dir) * 6, player.y + Math.sin(player.dir) * 6, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  function render() {
    ctx.clearRect(0, 0, VIEW_W, VIEW_H);
    drawFloor();
    drawExit();
    drawGems();
    drawBushes();
    drawWallsAndCrates();
    guards.forEach(drawGuard);
    if (player) drawPlayer();
  }

  // ------------------------------------------------------------------ loop

  var last = 0;
  function frame(ts) {
    var dt = Math.min(0.05, (ts - last) / 1000 || 0);
    last = ts;
    update(dt);
    render();
    requestAnimationFrame(frame);
  }

  // ----------------------------------------------------------------- input

  window.addEventListener('keydown', function (e) {
    var k = e.key.toLowerCase();
    if (['arrowup', 'arrowdown', 'arrowleft', 'arrowright', ' '].indexOf(k) !== -1) {
      e.preventDefault();
    }
    keys[k] = true;
    if (k === 'p' || k === 'escape') togglePause();
    if (k === 'm') {
      var on = window.SH_SOUND.toggle();
      soundBtn.textContent = on ? '🔊 Sound' : '🔇 Muted';
    }
    if (k === 'enter') {
      if (state === 'menu') startGame();
      else if (state === 'clear') nextLevel();
      else if (state === 'caught') retryLevel();
      else if (state === 'win') startGame();
    }
  });

  window.addEventListener('keyup', function (e) {
    keys[e.key.toLowerCase()] = false;
  });

  document.getElementById('btn-start').addEventListener('click', startGame);
  document.getElementById('btn-next').addEventListener('click', nextLevel);
  document.getElementById('btn-retry').addEventListener('click', retryLevel);
  document.getElementById('btn-again').addEventListener('click', startGame);
  document.getElementById('btn-resume').addEventListener('click', togglePause);
  soundBtn.addEventListener('click', function () {
    window.SH_SOUND.unlock();
    var on = window.SH_SOUND.toggle();
    soundBtn.textContent = on ? '🔊 Sound' : '🔇 Muted';
  });

  // ------------------------------------------------------- boot + test hook

  loadLevel(0);
  state = 'menu';
  showOverlay('start');
  updateHud();
  requestAnimationFrame(frame);

  // Read-only handle for automated smoke tests (never used by the game).
  window.__heist = {
    state: function () { return state; },
    level: function () { return levelIndex + 1; },
    loot: function () { return lootGot + '/' + lootTotal; },
    score: function () { return score; },
    timeLeft: function () { return Math.ceil(timeLeft); },
    player: function () { return { x: Math.round(player.x), y: Math.round(player.y) }; },
    guards: function () {
      return guards.map(function (g) {
        return { x: Math.round(g.x), y: Math.round(g.y), mode: g.mode, suspicion: +g.suspicion.toFixed(2) };
      });
    },
  };
})();
