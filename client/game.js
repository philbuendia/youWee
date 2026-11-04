/* YOUWEE BASEBALL - Atari-era camera-controlled baseball. Vanilla JS, no deps.
 * Logical framebuffer 192x128, 4-color palette, requestAnimationFrame loop.
 * Controls: built-in camera motion (centroid X = move, energy spike = action)
 *           with full keyboard fallback (arrows/A-D move, Space action).
 * Scores POST to /api/score on the same origin (server.py). */
(function () {
  "use strict";

  /* ---------- palette & constants ---------- */
  var PAL = {
    BLACK: "#000000",
    GREEN: "#33ff33",
    AMBER: "#ffb000",
    RED: "#ff3333",
    WHITE: "#e8e8e8"
  };
  var W = 192, H = 128;
  var GROUND_Y = 104;
  var PLATE_X = 96, PLATE_Y = 96;
  var MOUND_X = 96, MOUND_Y = 40;
  var STATE = { MENU: 0, PLAY: 1, OVER: 2 };
  var ROLE = { PITCHER: "pitcher", BATTER: "batter" };
  var PITCH_FRAMES = 90;          // ball travel time mound -> plate
  var HIT_WINDOW = 14;            // frames around arrival that count as hittable
  var TRIGGER_COOLDOWN_MS = 700;  // min gap between motion-triggered actions
  var MOTION_TRIGGER = 0.16;      // normalized energy spike that fires action

  /* ---------- dom ---------- */
  var canvas = document.getElementById("game");
  var ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = false;
  var btnPitcher = document.getElementById("btn-pitcher");
  var btnBatter = document.getElementById("btn-batter");
  var btnCamera = document.getElementById("btn-camera");
  var nameInput = document.getElementById("player-name");
  var camMsg = document.getElementById("camera-msg");
  var netMsg = document.getElementById("net-msg");
  var motionFill = document.getElementById("motion-fill");
  var motionLabel = document.getElementById("motion-label");
  var video = document.getElementById("cam");
  var camBuf = document.getElementById("cam-buffer");
  var camCtx = camBuf.getContext("2d", { willReadFrequently: true });

  /* ---------- audio (square-wave bleeps, created on first gesture) ---------- */
  var audioCtx = null;
  function beep(freq, ms, when) {
    try {
      if (!audioCtx) return;
      var t = audioCtx.currentTime + (when || 0);
      var osc = audioCtx.createOscillator();
      var gain = audioCtx.createGain();
      osc.type = "square";
      osc.frequency.setValueAtTime(freq, t);
      gain.gain.setValueAtTime(0.06, t);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + ms / 1000);
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      osc.start(t);
      osc.stop(t + ms / 1000 + 0.02);
    } catch (e) { /* audio is cosmetic; never break the game */ }
  }
  function unlockAudio() {
    try {
      if (audioCtx) {
        if (audioCtx.state === "suspended" && audioCtx.resume) audioCtx.resume();
        return;
      }
      var AC = window.AudioContext || window.webkitAudioContext;
      if (AC) audioCtx = new AC();
    } catch (e) { audioCtx = null; }
  }
  function jingle(kind) {
    if (kind === "hit") { beep(660, 90); beep(880, 90, 0.09); beep(1320, 140, 0.18); }
    else if (kind === "strike") { beep(220, 120); }
    else if (kind === "out") { beep(330, 100); beep(247, 100, 0.1); beep(165, 200, 0.2); }
    else if (kind === "whiff") { beep(140, 80); }
    else if (kind === "pitch") { beep(440, 60); }
  }

  /* ---------- game state ---------- */
  var game = {
    state: STATE.MENU,
    role: ROLE.BATTER,
    runs: 0,        // batter score
    strikeouts: 0,  // pitcher score
    conceded: 0,    // pitcher: runs given up (3 = game over)
    balls: 0,
    strikes: 0,
    outs: 0,
    inning: 1,
    message: "SELECT ROLE - PRESS ENTER",
    messageTtl: 0,
    scoreSent: false,
    serverNote: ""
  };
  // Player-controlled cursor: batter position OR pitch aim, 0..1 across zone.
  var cursor = 0.5;
  // Live ball: null when idle; {x0,y0,x1,y1,t,inZone,hit,hitV} while live.
  var ball = null;
  // CPU pitch sequencing for batter role.
  var pitchTimer = 0;
  // Batter swing animation frames remaining.
  var swingAnim = 0;
  // Strike-zone target highlight for pitcher role.
  var zoneFlash = 0;
  // Timestamp of game over: restart input is ignored briefly so the
  // final score (and server banner) stays readable.
  var overAt = 0;
  var OVER_RESTART_DELAY_MS = 1500;
  function nowMs() {
    return (typeof performance !== "undefined") ? performance.now() : Date.now();
  }

  function scoreValue() {
    return game.role === ROLE.BATTER ? game.runs : game.strikeouts;
  }
  function setMessage(text, ttl) {
    game.message = text;
    game.messageTtl = ttl || 120;
  }

  function resetGame() {
    game.state = STATE.PLAY;
    game.runs = 0;
    game.strikeouts = 0;
    game.conceded = 0;
    game.balls = 0;
    game.strikes = 0;
    game.outs = 0;
    game.inning = 1;
    game.scoreSent = false;
    game.serverNote = "";
    ball = null;
    swingAnim = 0;
    cursor = 0.5;
    pitchTimer = game.role === ROLE.BATTER ? 40 : 0;
    hideNet();
    if (game.role === ROLE.BATTER) setMessage("BATTER UP - SWING!", 150);
    else setMessage("AIM - SPACE TO PITCH", 150);
  }

  function endGame(reason) {
    game.state = STATE.OVER;
    overAt = nowMs();
    ball = null;
    jingle("out");
    setMessage(reason + " - FINAL " + scoreValue(), 9999);
    submitScore();
  }

  function nextBatter() {
    // At-bat is over: reset the count for the next batter.
    game.balls = 0;
    game.strikes = 0;
    pitchTimer = 50;
  }
  function nextPitch() {
    // Same at-bat continues: the count persists, only re-arm the timer.
    pitchTimer = 50;
  }

  function registerOut() {
    game.outs += 1;
    if (game.outs >= 3) {
      endGame(game.role === ROLE.BATTER ? "3 OUTS" : "3 OUTS - SHUTOUT");
    } else {
      game.inning += 1;
      nextBatter();
      setMessage("OUT " + game.outs + " - INNING " + game.inning, 120);
    }
  }

  /* ---------- pitching & hitting ---------- */
  function cpuPitch() {
    // CPU (as pitcher) targets in or around the zone; aim uses batter cursor
    // only as a miss factor: well-positioned batter sees tougher pitches.
    var inZone = Math.random() < 0.62;
    var targetX = inZone
      ? PLATE_X + (Math.random() * 36 - 18)
      : PLATE_X + (Math.random() < 0.5 ? -1 : 1) * (26 + Math.random() * 14);
    ball = {
      x0: MOUND_X + (Math.random() * 8 - 4), y0: MOUND_Y,
      x1: targetX, y1: PLATE_Y,
      t: 0, inZone: inZone, resolved: false,
      hx: 0, hy: 0, hvx: 0, hvy: 0, flying: false
    };
    jingle("pitch");
  }

  function playerPitch() {
    // Aim maps across and beyond the zone: edges/corner = balls.
    var aimX = 40 + cursor * 112; // 40..152, zone is ~78..114
    var inZone = aimX >= 76 && aimX <= 116;
    ball = {
      x0: MOUND_X, y0: MOUND_Y,
      x1: aimX, y1: PLATE_Y,
      t: 0, inZone: inZone, resolved: false,
      hx: 0, hy: 0, hvx: 0, hvy: 0, flying: false,
      cpuSwung: false
    };
    zoneFlash = 20;
    jingle("pitch");
  }

  function batterSwing() {
    // Shared by keyboard Space and camera motion spike (batter role).
    if (game.state !== STATE.PLAY || game.role !== ROLE.BATTER) return;
    if (swingAnim > 0) return;
    swingAnim = 18;
    if (!ball || ball.flying || ball.resolved) {
      jingle("whiff");
      return;
    }
    var dist = Math.abs(ball.t - PITCH_FRAMES);
    var batterX = 40 + cursor * 112;
    var aimErr = Math.abs(batterX - ball.x1);
    if (dist <= HIT_WINDOW && aimErr < 30) {
      // Contact! Quality from timing + positioning.
      var q = 1 - (dist / HIT_WINDOW) * 0.5 - (aimErr / 30) * 0.5;
      var bases = q > 0.8 ? 4 : (q > 0.6 ? 3 : (q > 0.4 ? 2 : 1));
      ball.flying = true;
      ball.hx = ball.x1; ball.hy = ball.y1;
      ball.hvx = (Math.random() * 4 - 2) + (batterX - ball.x1) * 0.08;
      ball.hvy = -(2.2 + q * 2.2);
      ball.resolved = true;
      game.runs += bases;
      game.balls = 0; game.strikes = 0;
      jingle("hit");
      setMessage(bases === 4 ? "HOME RUN! +" + bases : "HIT! +" + bases + " RUN" + (bases > 1 ? "S" : ""), 140);
      pitchTimer = 110;
    } else {
      // Swinging strike: the pitch is dead (catcher holds it).
      jingle("whiff");
      ball = null;
      addStrike();
    }
  }

  function addStrike() {
    // Batter role: called or swinging strike. Count persists within at-bat.
    game.strikes += 1;
    if (game.strikes >= 3) {
      setMessage("STRUCK OUT!", 120);
      registerOut();
    } else {
      setMessage("STRIKE " + game.strikes, 80);
      nextPitch();
    }
    jingle("strike");
  }

  function addBall() {
    // Batter role: taken pitch outside the zone. Count persists within at-bat.
    game.balls += 1;
    if (game.balls >= 4) {
      game.runs += 1; // walked in
      setMessage("WALK - RUN SCORES", 110);
      nextBatter();
    } else {
      setMessage("BALL " + game.balls, 70);
      nextPitch();
    }
  }

  function pitcherStrike() {
    // Pitcher role: taken or whiffed strike. Count persists within at-bat.
    game.strikes += 1;
    if (game.strikes >= 3) {
      game.strikeouts += 1;
      setMessage("STRIKEOUT! K=" + game.strikeouts, 120);
      registerOut(); // resets count via nextBatter, or ends game
    } else {
      setMessage("STRIKE " + game.strikes, 80);
    }
    jingle("strike");
  }

  function pitcherBall() {
    // Pitcher role: taken pitch outside the zone.
    game.balls += 1;
    if (game.balls >= 4) {
      game.conceded += 1;
      game.balls = 0; game.strikes = 0;
      if (game.conceded >= 3) endGame("WALK - 3 RUNS");
      else setMessage("WALK - " + game.conceded + " RUNS", 110);
    } else {
      setMessage("BALL " + game.balls, 70);
    }
  }

  function pitcherThrow() {
    // Shared by keyboard Space and camera motion spike (pitcher role).
    if (game.state !== STATE.PLAY || game.role !== ROLE.PITCHER) return;
    if (ball) return; // one pitch at a time
    playerPitch();
  }

  function updateCpuBatter() {
    // CPU batter decides once, mid-flight, whether to swing.
    if (!ball || ball.cpuSwung || ball.flying || ball.resolved) return;
    if (ball.t < PITCH_FRAMES * 0.55) return;
    ball.cpuSwung = true;
    swingAnim = 18;
    var chaseProb = ball.inZone ? 0.75 : 0.28;
    if (Math.random() > chaseProb) return; // takes the pitch; resolves at plate
    var contactProb = ball.inZone ? 0.55 : 0.22;
    if (Math.random() < contactProb) {
      ball.flying = true;
      ball.hx = ball.x1; ball.hy = ball.y1;
      ball.hvx = Math.random() * 5 - 2.5;
      ball.hvy = -(1.8 + Math.random() * 2.4);
      ball.resolved = true;
      game.conceded += 1;
      jingle("hit");
      if (game.conceded >= 3) {
        endGame("3 RUNS ALLOWED");
      } else {
        setMessage("HIT ALLOWED - " + game.conceded + " RUNS", 120);
      }
      return;
    }
    // Swung and missed: swinging strike, pitch is over.
    jingle("whiff");
    ball = null;
    pitcherStrike();
  }

  function updateBall() {
    if (!ball) return;
    if (ball.flying) {
      ball.hvy += 0.12;
      ball.hx += ball.hvx;
      ball.hy += ball.hvy;
      if (ball.hy > H + 6 || ball.hx < -6 || ball.hx > W + 6) ball = null;
      return;
    }
    ball.t += 1;
    if (ball.t >= PITCH_FRAMES && !ball.resolved) {
      ball.resolved = true;
      if (game.role === ROLE.BATTER) {
        if (ball.inZone) addStrike();   // frozen take
        else addBall();
      } else {
        // Pitcher role: only taken pitches reach the plate
        // (swings resolve mid-flight in updateCpuBatter).
        if (ball.inZone) pitcherStrike();
        else pitcherBall();
      }
      ball = null;
    }
  }

  /* ---------- score submission ---------- */
  function showNet(text, ok) {
    netMsg.textContent = text;
    netMsg.classList.remove("hidden");
    netMsg.style.borderColor = ok ? "var(--green)" : "var(--red)";
    netMsg.style.color = ok ? "var(--green)" : "var(--red)";
  }
  function hideNet() {
    netMsg.textContent = "";
    netMsg.classList.add("hidden");
  }
  function submitScore() {
    if (game.scoreSent) return;
    game.scoreSent = true;
    var payload = {
      name: (nameInput.value || "PLAYER1").toUpperCase().slice(0, 10),
      role: game.role,
      runs: scoreValue(),
      ts: Date.now()
    };
    if (!window.fetch) {
      showNet("SCORE NOT SENT: fetch unsupported", false);
      return;
    }
    window.fetch("/api/score", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    }).then(function (res) {
      if (!res.ok) throw new Error("HTTP " + res.status);
      return res.json();
    }).then(function (data) {
      game.serverNote = "SERVER OK id=" + (data && data.id != null ? data.id : "?");
      showNet("SCORE SAVED: " + payload.runs + " (" + payload.role + ") " + game.serverNote, true);
    }).catch(function (err) {
      game.serverNote = "OFFLINE - " + err.message;
      showNet("SCORE NOT SAVED (" + err.message + ") - run server.py", false);
    });
  }

  /* ---------- camera motion control ---------- */
  var cam = {
    active: false,
    stream: null,
    prev: null,
    energy: 0,
    smoothX: 0.5,
    lastTrigger: 0,
    denied: false
  };
  var CW = 48, CH = 36;

  function showCamMsg(text) {
    camMsg.textContent = text;
    camMsg.classList.remove("hidden");
  }
  function hideCamMsg() {
    camMsg.textContent = "";
    camMsg.classList.add("hidden");
  }

  function enableCamera() {
    unlockAudio();
    if (cam.active) return;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      cam.denied = true;
      showCamMsg("CAMERA NOT SUPPORTED IN THIS BROWSER - KEYBOARD MODE (ARROWS + SPACE)");
      return;
    }
    navigator.mediaDevices.getUserMedia({ video: { width: 320, height: 240 }, audio: false })
      .then(function (stream) {
        cam.stream = stream;
        cam.active = true;
        cam.denied = false;
        video.srcObject = stream;
        hideCamMsg();
        btnCamera.textContent = "CAMERA ON";
        btnCamera.classList.add("active");
      })
      .catch(function (err) {
        cam.denied = true;
        cam.active = false;
        var why = err && err.name ? err.name : "unavailable";
        showCamMsg("CAMERA DENIED/BLOCKED (" + why + ") - KEYBOARD MODE: ARROWS + SPACE. Click ENABLE CAMERA to retry.");
        btnCamera.textContent = "ENABLE CAMERA";
        btnCamera.classList.remove("active");
      });
  }
  function disableCamera() {
    if (cam.stream) {
      try { cam.stream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) {}
      cam.stream = null;
    }
    cam.active = false;
    cam.prev = null;
    video.srcObject = null;
    btnCamera.textContent = "ENABLE CAMERA";
    btnCamera.classList.remove("active");
  }

  function sampleCamera() {
    if (!cam.active || video.readyState < 2) {
      cam.energy = Math.max(0, cam.energy - 0.05);
      return;
    }
    camCtx.drawImage(video, 0, 0, CW, CH);
    var frame;
    try {
      frame = camCtx.getImageData(0, 0, CW, CH).data;
    } catch (e) { return; }
    if (!cam.prev) {
      cam.prev = new Uint8ClampedArray(frame.length);
      cam.prev.set(frame);
      return;
    }
    var sum = 0, wsum = 0, count = 0;
    for (var y = 0; y < CH; y += 1) {
      for (var x = 0; x < CW; x += 1) {
        var i = (y * CW + x) * 4;
        var lum = (frame[i] + frame[i + 1] + frame[i + 2]) / 3;
        var plum = (cam.prev[i] + cam.prev[i + 1] + cam.prev[i + 2]) / 3;
        var d = Math.abs(lum - plum);
        if (d > 24) { sum += d; wsum += d * x; count += 1; }
      }
    }
    cam.prev.set(frame);
    var norm = Math.min(1, count / (CW * CH * 0.45));
    cam.energy = cam.energy * 0.72 + norm * 0.28;
    if (count > 12) {
      var cx = (wsum / sum) / CW; // 0 left .. 1 right
      cam.smoothX = cam.smoothX * 0.65 + cx * 0.35;
      cursor = Math.min(1, Math.max(0, cam.smoothX));
    }
    var now = (typeof performance !== "undefined") ? performance.now() : Date.now();
    if (cam.energy > MOTION_TRIGGER && now - cam.lastTrigger > TRIGGER_COOLDOWN_MS) {
      cam.lastTrigger = now;
      fireAction();
    }
  }

  function updateMeter() {
    var pct = Math.round(Math.min(1, cam.energy) * 100);
    motionFill.style.width = pct + "%";
    motionLabel.textContent = (cam.active ? "MOTION " : "CAM OFF ") + pct + "%";
  }

  /* ---------- unified input: camera and keyboard drive the same actions ---------- */
  function fireAction() {
    unlockAudio();
    if (game.state === STATE.MENU) { resetGame(); return; }
    if (game.state === STATE.OVER) {
      if (nowMs() - overAt < OVER_RESTART_DELAY_MS) return;
      resetGame();
      return;
    }
    if (game.role === ROLE.BATTER) batterSwing();
    else pitcherThrow();
  }
  function moveCursor(dir) {
    cursor = Math.min(1, Math.max(0, cursor + dir * 0.06));
  }

  var keysDown = {};
  document.addEventListener("keydown", function (e) {
    if (e.target === nameInput) return;
    var k = e.key;
    if (k === " " || k === "ArrowLeft" || k === "ArrowRight" || k === "ArrowUp" || k === "ArrowDown") {
      e.preventDefault();
    }
    if (e.repeat) {
      if (k === "ArrowLeft" || k === "a" || k === "A") moveCursor(-1);
      if (k === "ArrowRight" || k === "d" || k === "D") moveCursor(1);
      return;
    }
    keysDown[k] = true;
    unlockAudio();
    if (k === "1") selectRole(ROLE.PITCHER);
    else if (k === "2") selectRole(ROLE.BATTER);
    else if (k === "Enter") { if (game.state !== STATE.PLAY) fireAction(); }
    else if (k === " ") fireAction();
    else if (k === "m" || k === "M") { if (cam.active) disableCamera(); else enableCamera(); }
    else if (k === "r" || k === "R") resetGame();
    else if (k === "ArrowLeft" || k === "a" || k === "A") moveCursor(-1);
    else if (k === "ArrowRight" || k === "d" || k === "D") moveCursor(1);
  });
  document.addEventListener("keyup", function (e) {
    delete keysDown[e.key];
  });

  function selectRole(role) {
    unlockAudio();
    game.role = role;
    btnPitcher.classList.toggle("active", role === ROLE.PITCHER);
    btnBatter.classList.toggle("active", role === ROLE.BATTER);
    if (game.state !== STATE.PLAY) {
      setMessage(role === ROLE.BATTER ? "BATTER SELECTED - ENTER" : "PITCHER SELECTED - ENTER", 150);
    } else {
      resetGame();
    }
    beep(520, 70);
  }
  btnPitcher.addEventListener("click", function () { selectRole(ROLE.PITCHER); });
  btnBatter.addEventListener("click", function () { selectRole(ROLE.BATTER); });
  btnCamera.addEventListener("click", function () {
    if (cam.active) disableCamera(); else enableCamera();
  });

  /* ---------- rendering (chunky Atari framebuffer) ---------- */
  function px(x, y, w, h, color) {
    ctx.fillStyle = color;
    ctx.fillRect(Math.round(x), Math.round(y), Math.round(w), Math.round(h));
  }
  function text(str, x, y, color, big) {
    ctx.fillStyle = color || PAL.WHITE;
    ctx.font = (big ? "bold 12px" : "8px") + ' "Courier New", monospace';
    ctx.textBaseline = "top";
    ctx.fillText(str, Math.round(x), Math.round(y));
  }

  function drawField() {
    px(0, 0, W, H, PAL.BLACK);
    // stands
    px(0, 0, W, 22, "#0a2a0a");
    for (var i = 0; i < 24; i += 1) {
      px(4 + i * 8, 6 + (i % 3) * 4, 3, 3, i % 2 ? PAL.AMBER : PAL.GREEN);
    }
    // grass + dirt diamond
    px(0, 22, W, GROUND_Y - 22, "#0d3a0d");
    px(MOUND_X - 14, MOUND_Y - 8, 28, 16, "#5a3a1a");   // mound dirt
    px(PLATE_X - 22, PLATE_Y - 10, 44, 16, "#5a3a1a");  // plate dirt
    // base lines
    ctx.strokeStyle = PAL.WHITE;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(PLATE_X, PLATE_Y);
    ctx.lineTo(30, 50);
    ctx.moveTo(PLATE_X, PLATE_Y);
    ctx.lineTo(162, 50);
    ctx.stroke();
    // ground line
    px(0, GROUND_Y, W, 2, PAL.GREEN);
  }

  function drawActors() {
    var batterX = 40 + cursor * 112;
    // pitcher (always drawn; CPU or player)
    px(MOUND_X - 3, MOUND_Y - 12, 6, 12, game.role === ROLE.PITCHER ? PAL.AMBER : PAL.RED);
    px(MOUND_X - 2, MOUND_Y - 15, 4, 3, PAL.WHITE);
    // batter
    var bx = game.role === ROLE.BATTER ? batterX : PLATE_X - 14;
    px(bx - 3, PLATE_Y - 12, 6, 12, game.role === ROLE.BATTER ? PAL.AMBER : PAL.RED);
    px(bx - 2, PLATE_Y - 15, 4, 3, PAL.WHITE);
    // bat
    if (swingAnim > 0) {
      var a = (18 - swingAnim) / 18;
      px(bx + 2 + a * 10, PLATE_Y - 14 + a * 6, 8, 2, PAL.WHITE);
    } else {
      px(bx + 3, PLATE_Y - 16, 2, 8, PAL.WHITE);
    }
    // strike zone box (pitcher role aims here)
    ctx.strokeStyle = zoneFlash > 0 ? PAL.RED : PAL.GREEN;
    ctx.lineWidth = 1;
    ctx.strokeRect(76.5, PLATE_Y - 14.5, 40, 16);
    // aim marker for pitcher
    if (game.role === ROLE.PITCHER && game.state === STATE.PLAY) {
      var ax = 40 + cursor * 112;
      px(ax - 1, PLATE_Y - 18, 3, 3, PAL.RED);
      px(ax - 1, PLATE_Y + 4, 3, 3, PAL.RED);
    }
  }

  function drawBall() {
    if (!ball) return;
    if (ball.flying) {
      px(ball.hx - 2, ball.hy - 2, 4, 4, PAL.WHITE);
      return;
    }
    var p = Math.min(1, ball.t / PITCH_FRAMES);
    var e = p * p; // accelerate toward plate
    var x = ball.x0 + (ball.x1 - ball.x0) * e;
    var y = ball.y0 + (ball.y1 - ball.y0) * e;
    var s = 1 + Math.round(p * 2); // grows as it approaches
    px(x - s / 2, y - s / 2, s, s, PAL.WHITE);
  }

  function drawHud() {
    text("R" + game.runs + " K" + game.strikeouts + " B" + game.balls + " S" + game.strikes + " O" + game.outs, 4, 24, PAL.GREEN);
    text("INN" + game.inning + " " + (game.role === ROLE.BATTER ? "BAT" : "PIT"), 128, 24, PAL.AMBER);
    if (game.messageTtl > 0) {
      var m = game.message.slice(0, 30);
      text(m, Math.max(2, (W - m.length * 5) / 2), 112, PAL.AMBER);
    }
    if (!cam.active) text("KEYS", 172, 112, PAL.RED);
    else text("CAM", 176, 112, PAL.GREEN);
  }

  function drawMenu() {
    drawField();
    text("YOUWEE", 66, 34, PAL.AMBER, true);
    text("BASEBALL", 62, 48, PAL.AMBER, true);
    text(game.role === ROLE.PITCHER ? ">PITCHER  BATTER" : " PITCHER >BATTER", 46, 66, PAL.WHITE);
    text("1/2 OR CLICK", 58, 78, PAL.GREEN);
    text("ENTER TO PLAY", 56, 88, PAL.GREEN);
    text("M=CAMERA SPACE=HIT", 44, 98, PAL.GREEN);
    drawHud();
  }

  function drawOver() {
    drawField();
    text("GAME OVER", 62, 44, PAL.RED, true);
    var s = "FINAL " + scoreValue() + " (" + game.role.toUpperCase() + ")";
    text(s, (W - s.length * 5) / 2, 60, PAL.WHITE);
    text("ENTER / SPACE: AGAIN", 40, 74, PAL.GREEN);
    if (game.serverNote) text(game.serverNote.slice(0, 32), 8, 86, PAL.AMBER);
    drawHud();
  }

  function render() {
    if (game.state === STATE.MENU) { drawMenu(); return; }
    if (game.state === STATE.OVER) { drawOver(); return; }
    drawField();
    drawActors();
    drawBall();
    drawHud();
  }

  /* ---------- main loop ---------- */
  var heldMoveAcc = 0;
  function update() {
    if (game.messageTtl > 0) game.messageTtl -= 1;
    if (swingAnim > 0) swingAnim -= 1;
    if (zoneFlash > 0) zoneFlash -= 1;
    // held-key smooth movement
    heldMoveAcc += 1;
    if (heldMoveAcc % 2 === 0) {
      if (keysDown.ArrowLeft || keysDown.a || keysDown.A) moveCursor(-1);
      if (keysDown.ArrowRight || keysDown.d || keysDown.D) moveCursor(1);
    }
    sampleCamera();
    updateMeter();
    if (game.state !== STATE.PLAY) return;
    if (game.role === ROLE.BATTER) {
      if (!ball) {
        pitchTimer -= 1;
        if (pitchTimer <= 0) cpuPitch();
      }
    } else {
      updateCpuBatter();
    }
    updateBall();
  }

  function loop() {
    try {
      update();
      render();
    } catch (err) {
      // Never hard-crash the cabinet: park on menu with the error visible.
      try {
        game.state = STATE.MENU;
        setMessage("ERR: " + String(err && err.message || err).slice(0, 26), 9999);
        render();
      } catch (e) { /* last resort: leave last frame up */ }
    }
    requestAnimationFrame(loop);
  }

  /* ---------- boot ---------- */
  selectRole(ROLE.BATTER);
  game.state = STATE.MENU;
  setMessage("SELECT ROLE - PRESS ENTER", 9999);
  // Auto-try camera on first user gesture only (autoplay policies forbid sooner).
  document.addEventListener("pointerdown", function autoCam() {
    document.removeEventListener("pointerdown", autoCam);
    enableCamera();
  }, { once: true });
  requestAnimationFrame(loop);
})();
