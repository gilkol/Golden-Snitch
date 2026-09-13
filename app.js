/* ==========================================================================
   Golden Snitch — game logic
   Sections: config, state, DOM refs, storage, screens, placement,
             feedback, input, loop, lifecycle, boot
   ========================================================================== */
(function () {
  'use strict';

  /* ------------------------------------------------------------------------
     Config — every tunable number lives here.
     ------------------------------------------------------------------------ */
  const CONFIG = {
    gameDurationMs: 60000,
    baseTeleportMs: 800,
    teleportStepMs: 20,     // shaved off the interval per point scored
    minTeleportMs: 400,     // difficulty floor
    minJumpPx: 80,          // consecutive teleports must read as movement
    edgePaddingPx: 8,       // keeps the Snitch's glow clear of the clipped edges
    placementTries: 12,     // attempts to satisfy minJumpPx before giving up
    urgentAtSeconds: 10,    // when the timer turns red
    burstSparks: 6,
    burstLifetimeMs: 500,   // must outlast the CSS spark/ring animations
    storageKey: 'goldenSnitch.highScore',
  };

  /* ------------------------------------------------------------------------
     State
     ------------------------------------------------------------------------ */
  const state = {
    score: 0,
    highScore: 0,
    running: false,
    /** ms of gameplay left; decremented by the loop, frozen while hidden. */
    remainingMs: CONFIG.gameDurationMs,
    /** countdown to the next forced teleport, in ms */
    teleportInMs: CONFIG.baseTeleportMs,
    /** timestamp of the previous animation frame */
    lastFrameAt: 0,
    /** last whole second painted to the HUD, so we only write on change */
    lastSecondShown: -1,
    /** current snitch position within the playfield, in px */
    snitchX: 0,
    snitchY: 0,
    rafId: 0,
  };

  /* ------------------------------------------------------------------------
     DOM references
     ------------------------------------------------------------------------ */
  const screens = {
    start: document.getElementById('screen-start'),
    game: document.getElementById('screen-game'),
    gameover: document.getElementById('screen-gameover'),
  };

  const el = {
    playfield: document.getElementById('playfield'),
    snitch: document.getElementById('snitch'),
    score: document.getElementById('score'),
    highScore: document.getElementById('high-score'),
    timer: document.getElementById('timer'),
    finalScore: document.getElementById('final-score'),
    recordNew: document.getElementById('record-new'),
    recordOld: document.getElementById('record-old'),
    recordBest: document.getElementById('record-best'),
    btnStart: document.getElementById('btn-start'),
    btnRestart: document.getElementById('btn-restart'),
  };

  /* ------------------------------------------------------------------------
     High-score storage
     localStorage throws in private-mode Safari and when quota is exhausted,
     so every access is guarded; the in-memory value keeps the game working.
     ------------------------------------------------------------------------ */
  function loadHighScore() {
    try {
      const raw = window.localStorage.getItem(CONFIG.storageKey);
      const parsed = Number.parseInt(raw, 10);
      return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
    } catch (err) {
      return 0;
    }
  }

  function saveHighScore(value) {
    try {
      window.localStorage.setItem(CONFIG.storageKey, String(value));
    } catch (err) {
      /* Non-fatal: state.highScore still holds for this session. */
    }
  }

  /* ------------------------------------------------------------------------
     Screens
     ------------------------------------------------------------------------ */
  function showScreen(name) {
    Object.keys(screens).forEach(function (key) {
      screens[key].classList.toggle('is-active', key === name);
    });
  }

  /* ------------------------------------------------------------------------
     Snitch placement
     ------------------------------------------------------------------------ */

  /** Snitch footprint, read from CSS so geometry has a single source of truth. */
  function snitchSize() {
    const raw = getComputedStyle(document.documentElement)
      .getPropertyValue('--snitch-size');
    const parsed = Number.parseFloat(raw);
    return Number.isFinite(parsed) ? parsed : 48;
  }

  /**
   * Movable area: the playfield inset by the Snitch's own size plus a small
   * padding, so neither the art nor its glow is ever clipped at an edge.
   * Returned as min/max because the padding shifts the origin too.
   */
  function placementBounds() {
    const size = snitchSize();
    const pad = CONFIG.edgePaddingPx;
    return {
      minX: pad,
      minY: pad,
      maxX: Math.max(pad, el.playfield.clientWidth - size - pad),
      maxY: Math.max(pad, el.playfield.clientHeight - size - pad),
    };
  }

  function applySnitchPosition() {
    el.snitch.style.transform =
      'translate3d(' + state.snitchX + 'px, ' + state.snitchY + 'px, 0)';
  }

  /**
   * Move the Snitch to a fresh random spot inside the playfield.
   * Rejects candidates closer than CONFIG.minJumpPx to the current position so
   * every teleport is visibly a jump; falls back to the last candidate if the
   * playfield is too small to satisfy that (e.g. a very short viewport).
   */
  function teleportSnitch() {
    const bounds = placementBounds();
    const fromX = state.snitchX;
    const fromY = state.snitchY;
    let x = fromX;
    let y = fromY;

    for (let i = 0; i < CONFIG.placementTries; i += 1) {
      x = bounds.minX + Math.random() * (bounds.maxX - bounds.minX);
      y = bounds.minY + Math.random() * (bounds.maxY - bounds.minY);
      const dx = x - fromX;
      const dy = y - fromY;
      if (Math.hypot(dx, dy) >= CONFIG.minJumpPx) break;
    }

    state.snitchX = x;
    state.snitchY = y;
    applySnitchPosition();
  }

  /** Difficulty curve: 800ms at 0 points, -20ms per point, floored at 400ms. */
  function currentTeleportInterval() {
    return Math.max(
      CONFIG.minTeleportMs,
      CONFIG.baseTeleportMs - state.score * CONFIG.teleportStepMs
    );
  }

  /** Keep the Snitch in bounds after a resize or orientation change. */
  function clampSnitchIntoView() {
    const bounds = placementBounds();
    state.snitchX = Math.min(Math.max(state.snitchX, bounds.minX), bounds.maxX);
    state.snitchY = Math.min(Math.max(state.snitchY, bounds.minY), bounds.maxY);
    applySnitchPosition();
  }

  /* ------------------------------------------------------------------------
     Catch feedback
     ------------------------------------------------------------------------ */

  /** Restart the pop animation even if it is already mid-flight. */
  function playPop() {
    el.snitch.classList.remove('is-caught');
    void el.snitch.offsetWidth; // force reflow so the animation re-triggers
    el.snitch.classList.add('is-caught');
  }

  /** Gold spark fan plus an expanding ring, centred on the catch point. */
  function spawnBurst(centerX, centerY) {
    const burst = document.createElement('div');
    burst.className = 'burst';
    burst.style.transform =
      'translate3d(' + centerX + 'px, ' + centerY + 'px, 0)';

    const ring = document.createElement('span');
    ring.className = 'burst-ring';
    burst.appendChild(ring);

    const step = 360 / CONFIG.burstSparks;
    for (let i = 0; i < CONFIG.burstSparks; i += 1) {
      const spark = document.createElement('span');
      spark.className = 'burst-spark';
      // Slight jitter keeps repeated bursts from looking identical.
      spark.style.setProperty('--angle', i * step + Math.random() * 12 + 'deg');
      burst.appendChild(spark);
    }

    el.playfield.appendChild(burst);
    window.setTimeout(function () {
      burst.remove();
    }, CONFIG.burstLifetimeMs);
  }

  function clearBursts() {
    el.playfield.querySelectorAll('.burst').forEach(function (node) {
      node.remove();
    });
  }

  /* ------------------------------------------------------------------------
     Input
     ------------------------------------------------------------------------ */

  /**
   * `pointerdown` fires on first contact — no ~300ms click delay on touch —
   * and covers mouse, touch and pen in one path.
   */
  function onSnitchTap(event) {
    if (!state.running) return; // ignore stray taps after time expires
    event.preventDefault();

    const half = snitchSize() / 2;
    spawnBurst(state.snitchX + half, state.snitchY + half);
    playPop();

    state.score += 1;
    el.score.textContent = String(state.score);

    // Immediate teleport with a fresh (now shorter) window.
    teleportSnitch();
    state.teleportInMs = currentTeleportInterval();
  }

  /* ------------------------------------------------------------------------
     Main loop
     A single rAF drives both the countdown and the teleport deadline, so the
     two can never drift apart.
     ------------------------------------------------------------------------ */
  function tick(now) {
    if (!state.running) return;

    // Clamp the delta so a long frame (or a resumed tab) can't skip the clock.
    const delta = Math.min(now - state.lastFrameAt, 100);
    state.lastFrameAt = now;

    state.remainingMs -= delta;
    state.teleportInMs -= delta;

    if (state.teleportInMs <= 0) {
      teleportSnitch();
      state.teleportInMs = currentTeleportInterval();
    }

    if (state.remainingMs <= 0) {
      state.remainingMs = 0;
      renderTimer();
      endGame();
      return;
    }

    renderTimer();
    state.rafId = window.requestAnimationFrame(tick);
  }

  /** Paint the countdown only when the displayed second actually changes. */
  function renderTimer() {
    const seconds = Math.ceil(state.remainingMs / 1000);
    if (seconds === state.lastSecondShown) return;
    state.lastSecondShown = seconds;
    el.timer.textContent = String(seconds);
    el.timer.classList.toggle('is-urgent', seconds <= CONFIG.urgentAtSeconds);
  }

  function stopLoop() {
    if (state.rafId) {
      window.cancelAnimationFrame(state.rafId);
      state.rafId = 0;
    }
  }

  function startLoop() {
    stopLoop();
    state.lastFrameAt = performance.now();
    state.rafId = window.requestAnimationFrame(tick);
  }

  /* ------------------------------------------------------------------------
     Lifecycle
     ------------------------------------------------------------------------ */
  function startGame() {
    state.score = 0;
    state.running = true;
    state.remainingMs = CONFIG.gameDurationMs;
    state.teleportInMs = CONFIG.baseTeleportMs;
    state.lastSecondShown = -1;

    el.score.textContent = '0';
    el.highScore.textContent = String(state.highScore);
    el.timer.classList.remove('is-urgent');

    clearBursts();
    showScreen('game'); // must precede placement: the playfield needs a size

    // Start centred, then jump immediately so the first spot is random.
    const bounds = placementBounds();
    state.snitchX = (bounds.minX + bounds.maxX) / 2;
    state.snitchY = (bounds.minY + bounds.maxY) / 2;
    teleportSnitch();

    el.snitch.classList.remove('is-hidden');
    renderTimer();
    startLoop();
  }

  function endGame() {
    state.running = false;
    stopLoop();
    el.snitch.classList.add('is-hidden');
    clearBursts();

    const previousBest = state.highScore;
    const isRecord = state.score > previousBest;

    if (isRecord) {
      state.highScore = state.score;
      saveHighScore(state.highScore);
    }

    el.finalScore.textContent = String(state.score);
    el.highScore.textContent = String(state.highScore);
    el.recordNew.hidden = !isRecord;
    el.recordOld.hidden = isRecord;
    el.recordBest.textContent = String(state.highScore);

    showScreen('gameover');
  }

  /* ------------------------------------------------------------------------
     Events
     ------------------------------------------------------------------------ */
  el.btnStart.addEventListener('click', startGame);
  el.btnRestart.addEventListener('click', startGame);
  el.snitch.addEventListener('pointerdown', onSnitchTap);

  // Long-press on the Snitch would otherwise raise the iOS context menu.
  el.snitch.addEventListener('contextmenu', function (event) {
    event.preventDefault();
  });

  /**
   * Backgrounding the tab freezes rAF, which would otherwise let the clock
   * drain against a stale timestamp on return. Stop on hide, rebase on show.
   */
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) {
      stopLoop();
    } else if (state.running) {
      startLoop();
    }
  });

  window.addEventListener('resize', function () {
    if (state.running) clampSnitchIntoView();
  });

  /* ------------------------------------------------------------------------
     Boot
     ------------------------------------------------------------------------ */
  state.highScore = loadHighScore();
  el.highScore.textContent = String(state.highScore);
  el.snitch.classList.add('is-hidden');
  showScreen('start');
})();
