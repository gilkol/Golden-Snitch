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
    gameDurationMs: 40000,
    baseTeleportMs: 1000,
    teleportStepMs: 10,     // shaved off the interval per point scored
    minTeleportMs: 600,     // difficulty floor, reached at 40 points
    minJumpPx: 80,          // consecutive teleports must read as movement
    edgePaddingPx: 8,       // keeps the Snitch's glow clear of the clipped edges
    placementTries: 12,     // attempts to satisfy minJumpPx before giving up
    urgentAtSeconds: 10,    // when the timer turns red
    burstSparks: 6,
    burstLifetimeMs: 500,   // must outlast the CSS spark/ring animations
    maxScores: 15,          // table length; 16th place is forgotten
    maxNameLength: 10,
    defaultName: 'ANON',    // used when the name field is left blank
    scoresKey: 'goldenSnitch.scores.v2',
    adultScoresKey: 'goldenSnitch.scores.adult',
    legacyScoreKey: 'goldenSnitch.highScore', // pre-table number, purged on boot
    legacyScoresKey: 'goldenSnitch.scores',   // named table before the reset, purged on boot
    countdownMs: 5000,
    countdownPhrases: [
      'Ready, Seeker?',
      'Eyes on the Snitch!',
      'Seekers, take your marks!',
      'Are you ready??',
      'Catch it if you can!',
    ],
    defaultTheme: 'random',
    themeChoices: ['night', 'pitch', 'potions', 'ministry', 'gryffindor', 'slytherin', 'forest', 'diagon', 'hogsmeade', 'gringotts'],
    defaultAdultMode: false,
  };

  /* ------------------------------------------------------------------------
     State
     ------------------------------------------------------------------------ */
  const state = {
    score: 0,
    /** score awaiting a name; 0 when there is nothing pending */
    pendingScore: 0,
    running: false,
    /** true while the 5-second "get ready" overlay is showing */
    countingDown: false,
    countdownMs: 0,
    lastPhraseIndex: -1,
    /** ms of gameplay left; decremented by the loop, frozen while hidden. */
    remainingMs: CONFIG.gameDurationMs,
    /** countdown to the next forced teleport, in ms */
    teleportInMs: CONFIG.baseTeleportMs,
    /** timestamp of the previous animation frame */
    lastFrameAt: 0,
    /** last whole second painted to the HUD, so we only write on change */
    lastSecondShown: -1,
    lastCountdownShown: -1,
    /** current snitch position within the playfield, in px */
    snitchX: 0,
    snitchY: 0,
    rafId: 0,
    /** persisted setting: random or a specific scene; reset to Random on each launch */
    themeSetting: 'random',
    /** last painted playfield scene, so Random will not repeat it next round */
    lastPlayfieldTheme: '',
    /** true while Adult Mode is On for this session; Off on each launch */
    adultMode: false,
  };

  /* ------------------------------------------------------------------------
     DOM references
     ------------------------------------------------------------------------ */
  const screens = {
    start: document.getElementById('screen-start'),
    game: document.getElementById('screen-game'),
    gameover: document.getElementById('screen-gameover'),
    scores: document.getElementById('screen-scores'),
    settings: document.getElementById('screen-settings'),
  };

  const el = {
    playfield: document.getElementById('playfield'),
    hud: document.getElementById('hud'),
    snitch: document.getElementById('snitch'),
    countdown: document.getElementById('countdown'),
    countdownNumber: document.getElementById('countdown-number'),
    countdownPhrase: document.getElementById('countdown-phrase'),
    score: document.getElementById('score'),
    highScore: document.getElementById('high-score'),
    timer: document.getElementById('timer'),
    finalScore: document.getElementById('final-score'),
    nameEntry: document.getElementById('name-entry'),
    nameInput: document.getElementById('name-input'),
    savedNote: document.getElementById('saved-note'),
    noRecord: document.getElementById('no-record'),
    gameoverScoresHeading: document.getElementById('gameover-scores-heading'),
    gameoverScores: document.getElementById('gameover-scores'),
    scoresList: document.getElementById('scores-list'),
    scoresEmpty: document.getElementById('scores-empty'),
    adultScoresList: document.getElementById('adult-scores-list'),
    adultScoresEmpty: document.getElementById('adult-scores-empty'),
    btnStart: document.getElementById('btn-start'),
    btnRestart: document.getElementById('btn-restart'),
    btnMenu: document.getElementById('btn-menu'),
    btnScores: document.getElementById('btn-scores'),
    btnScoresBack: document.getElementById('btn-scores-back'),
    btnSettings: document.getElementById('btn-settings'),
    btnSettingsBack: document.getElementById('btn-settings-back'),
    btnSettingsBackground: document.getElementById('btn-settings-background'),
    btnSettingsAdult: document.getElementById('btn-settings-adult'),
    btnBackgroundBack: document.getElementById('btn-background-back'),
    btnAdultBack: document.getElementById('btn-adult-back'),
    settingsHome: document.getElementById('settings-home'),
    settingsBackground: document.getElementById('settings-background'),
    settingsAdult: document.getElementById('settings-adult'),
    themeOptions: document.querySelectorAll('#settings-background .theme-option'),
    adultOptions: document.querySelectorAll('.adult-option'),
    menuBackground: document.getElementById('menu-background'),
    menuAdult: document.getElementById('menu-adult'),
  };

  /* ------------------------------------------------------------------------
     Score table
     Held in memory and mirrored to localStorage. Every storage access is
     guarded because localStorage throws in private-mode Safari and when the
     quota is exhausted; the in-memory copy keeps the game playable either way.
     Always kept sorted high-to-low and capped at CONFIG.maxScores.
     ------------------------------------------------------------------------ */
  let scores = [];
  let adultScores = [];

  function tableFor(adult) {
    return adult ? adultScores : scores;
  }

  function persistTable(adult) {
    const key = adult ? CONFIG.adultScoresKey : CONFIG.scoresKey;
    try {
      window.localStorage.setItem(key, JSON.stringify(tableFor(adult)));
    } catch (err) {
      /* Non-fatal: the table still holds for this session. */
    }
  }

  /** Trim a name to something safe and bounded, or fall back to a default. */
  function sanitizeName(raw) {
    const cleaned = String(raw == null ? '' : raw)
      .replace(/[\u0000-\u001f\u007f]/g, '') // strip control characters
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, CONFIG.maxNameLength);
    return cleaned || CONFIG.defaultName;
  }

  /** Accept an entry only if it survives validation, so bad data can't render. */
  function parseEntry(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const score = Number.parseInt(raw.score, 10);
    if (!Number.isFinite(score) || score <= 0) return null;
    return { name: sanitizeName(raw.name), score: score };
  }

  function loadScoreTable(key) {
    let list = [];

    try {
      const parsed = JSON.parse(window.localStorage.getItem(key));
      if (Array.isArray(parsed)) list = parsed.map(parseEntry).filter(Boolean);
    } catch (err) {
      list = [];
    }

    list.sort(function (a, b) { return b.score - a.score; });
    return list.slice(0, CONFIG.maxScores);
  }

  /**
   * Older keys are deliberately not carried over, so the named table starts
   * empty after a reset; remove them so they cannot linger or be picked up later.
   */
  function purgeLegacyScores() {
    try {
      window.localStorage.removeItem(CONFIG.legacyScoreKey);
      window.localStorage.removeItem(CONFIG.legacyScoresKey);
      window.localStorage.removeItem('goldenSnitch.theme');
      window.localStorage.removeItem('goldenSnitch.adultMode');
    } catch (err) {
      /* Nothing we can do, and nothing depends on it. */
    }
  }

  /* ------------------------------------------------------------------------
     Playfield themes
     Menus stay on the night sky. The playfield paints the chosen scene.
     ------------------------------------------------------------------------ */
  function isThemeSetting(value) {
    return value === 'random' || CONFIG.themeChoices.indexOf(value) !== -1;
  }

  function resolveTheme(setting) {
    if (setting !== 'random') return setting;
    const last = state.lastPlayfieldTheme;
    const pool = last && CONFIG.themeChoices.length > 1
      ? CONFIG.themeChoices.filter(function (theme) { return theme !== last; })
      : CONFIG.themeChoices;
    return pool[Math.floor(Math.random() * pool.length)];
  }

  function applyPlayfieldTheme(theme) {
    el.playfield.setAttribute('data-theme', theme);
    state.lastPlayfieldTheme = theme;
  }

  function syncThemeButtons() {
    el.themeOptions.forEach(function (btn) {
      const selected = btn.getAttribute('data-theme') === state.themeSetting;
      btn.classList.toggle('is-selected', selected);
      btn.setAttribute('aria-pressed', selected ? 'true' : 'false');
    });
  }

  function selectThemeSetting(value) {
    if (!isThemeSetting(value)) return;
    state.themeSetting = value;
    syncThemeButtons();
    syncMenuStatus();
  }

  function isAdultSetting(value) {
    return value === 'on' || value === 'off';
  }

  function syncAdultButtons() {
    const current = state.adultMode ? 'on' : 'off';
    el.adultOptions.forEach(function (btn) {
      const selected = btn.getAttribute('data-adult') === current;
      btn.classList.toggle('is-selected', selected);
      btn.setAttribute('aria-pressed', selected ? 'true' : 'false');
    });
  }

  function selectAdultMode(value) {
    if (!isAdultSetting(value)) return;
    state.adultMode = value === 'on';
    syncAdultButtons();
    syncMenuStatus();
  }

  function themeLabel() {
    const match = Array.prototype.find.call(el.themeOptions, function (btn) {
      return btn.getAttribute('data-theme') === state.themeSetting;
    });
    return match ? match.textContent : 'Random';
  }

  function syncMenuStatus() {
    el.menuBackground.textContent = themeLabel();
    el.menuAdult.textContent = state.adultMode ? 'On' : 'Off';
  }

  function showSettingsPane(name) {
    el.settingsHome.hidden = name !== 'home';
    el.settingsBackground.hidden = name !== 'background';
    el.settingsAdult.hidden = name !== 'adult';
  }

  function topScore() {
    const table = tableFor(state.adultMode);
    return table.length ? table[0].score : 0;
  }

  /** Earns a place if the table has room or the score beats the last entry. */
  function qualifies(score) {
    if (score <= 0) return false;
    const table = tableFor(state.adultMode);
    if (table.length < CONFIG.maxScores) return true;
    return score > table[table.length - 1].score;
  }

  /** Rank a score would take. Ties sit behind equal scores set earlier. */
  function rankFor(score) {
    const table = tableFor(state.adultMode);
    const at = table.findIndex(function (entry) { return score > entry.score; });
    return at === -1 ? table.length : at;
  }

  /**
   * Insert in rank order and drop anything pushed past the last place.
   * Returns the new entry's index, or -1 if it landed outside the table.
   */
  function insertScore(name, score) {
    const adult = state.adultMode;
    const table = tableFor(adult).slice();
    const index = rankFor(score);
    table.splice(index, 0, { name: name, score: score });
    const next = table.slice(0, CONFIG.maxScores);
    if (adult) adultScores = next;
    else scores = next;
    persistTable(adult);
    return index < CONFIG.maxScores ? index : -1;
  }

  /* ------------------------------------------------------------------------
     Screens
     ------------------------------------------------------------------------ */
  function showScreen(name) {
    Object.keys(screens).forEach(function (key) {
      screens[key].classList.toggle('is-active', key === name);
    });
    if (name === 'start') syncMenuStatus();
  }

  /* ------------------------------------------------------------------------
     Score table rendering
     ------------------------------------------------------------------------ */

  /**
   * Paint a score table into a list element.
   *
   * `options.pending` injects the just-finished run at its would-be rank so the
   * player can see where they landed before committing a name. `options.
   * highlight` instead marks an index that is already in the table.
   */
  function renderScores(listEl, options, adult) {
    const opts = options || {};
    const useAdult = adult == null ? state.adultMode : adult;
    const table = tableFor(useAdult);

    const rows = table.map(function (entry) {
      return { name: entry.name, score: entry.score, isNew: false };
    });

    if (opts.pending) {
      rows.splice(rankFor(opts.pending.score), 0, {
        name: opts.pending.name,
        score: opts.pending.score,
        isNew: true,
      });
    } else if (typeof opts.highlight === 'number' && rows[opts.highlight]) {
      rows[opts.highlight].isNew = true;
    }

    listEl.textContent = ''; // clear previous rows

    rows.slice(0, CONFIG.maxScores).forEach(function (row, i) {
      const li = document.createElement('li');
      li.className = 'score-row' + (row.isNew ? ' score-row--new' : '');

      const rank = document.createElement('span');
      rank.className = 'score-rank';
      rank.textContent = String(i + 1);

      // textContent, never innerHTML: names are player input.
      const name = document.createElement('span');
      name.className = 'score-name';
      name.textContent = row.name;

      const value = document.createElement('span');
      value.className = 'score-value';
      value.textContent = String(row.score);

      li.appendChild(rank);
      li.appendChild(name);
      li.appendChild(value);
      listEl.appendChild(li);
    });
  }

  /** What to show in the pending row while the player is still typing. */
  function namePreview() {
    const typed = el.nameInput.value.replace(/\s+/g, ' ').trim();
    return typed ? typed.slice(0, CONFIG.maxNameLength) : '???';
  }

  function pendingEntry() {
    return { name: namePreview(), score: state.pendingScore };
  }

  /**
   * Move the pending score into the table under the entered name.
   */
  function commitPendingScore() {
    if (!state.pendingScore) return;

    const name = sanitizeName(el.nameInput.value);
    const index = insertScore(name, state.pendingScore);
    state.pendingScore = 0;

    el.nameEntry.hidden = true;
    el.savedNote.hidden = false;
    el.savedNote.textContent = 'Saved as ' + name;
    el.highScore.textContent = String(topScore());
    renderScores(el.gameoverScores, { highlight: index });
    setRestartReady(true);
  }

  function setRestartReady(ready) {
    el.btnRestart.classList.toggle('is-waiting', !ready);
    el.btnRestart.setAttribute('aria-disabled', ready ? 'false' : 'true');
    el.btnMenu.classList.toggle('is-waiting', !ready);
    el.btnMenu.setAttribute('aria-disabled', ready ? 'false' : 'true');
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

  /** Home-indicator inset, so the Snitch never sits under the iOS swipe-up gesture. */
  function safeInsetBottom() {
    const raw = getComputedStyle(el.playfield).getPropertyValue('--snitch-safe-bottom');
    const parsed = Number.parseFloat(raw);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  /**
   * Movable area: the playfield inset by the Snitch's own size plus a small
   * padding, so neither the art nor its glow is ever clipped at an edge.
   * The HUD overlays the painting, and the home indicator is painted but not
   * playable, so minY / maxY stay clear of both.
   */
  function placementBounds() {
    const size = snitchSize();
    const pad = CONFIG.edgePaddingPx;
    const top = (el.hud ? el.hud.offsetHeight : 0) + pad;
    const bottom = safeInsetBottom();
    return {
      minX: pad,
      minY: top,
      maxX: Math.max(pad, el.playfield.clientWidth - size - pad),
      maxY: Math.max(top, el.playfield.clientHeight - size - pad - bottom),
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
    if (!state.running) return; // ignore stray taps after time expires, and during countdown
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
  function frameDelta(now) {
    // Never negative (warped clocks) and never more than 100ms (tab resume).
    const delta = Math.min(Math.max(0, now - state.lastFrameAt), 100);
    state.lastFrameAt = now;
    return delta;
  }

  function tick(now) {
    if (state.countingDown) {
      tickCountdown(now);
      return;
    }
    if (!state.running) return;

    const delta = frameDelta(now);

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
     Pre-game countdown
     ------------------------------------------------------------------------ */
  function pickCountdownPhrase() {
    const list = CONFIG.countdownPhrases;
    let index = Math.floor(Math.random() * list.length);
    if (list.length > 1 && index === state.lastPhraseIndex) {
      index = (index + 1) % list.length;
    }
    state.lastPhraseIndex = index;
    return list[index];
  }

  function showCountdownOverlay(seconds) {
    el.countdown.hidden = false;
    el.countdownNumber.textContent = String(seconds);
    el.countdownNumber.classList.remove('is-tick');
    void el.countdownNumber.offsetWidth;
    el.countdownNumber.classList.add('is-tick');
  }

  function hideCountdownOverlay() {
    el.countdown.hidden = true;
    el.countdownNumber.classList.remove('is-tick');
  }

  function tickCountdown(now) {
    state.countdownMs -= frameDelta(now);

    if (state.countdownMs <= 0) {
      hideCountdownOverlay();
      beginPlay();
      return;
    }

    const maxShown = Math.ceil(CONFIG.countdownMs / 1000);
    const seconds = Math.min(maxShown, Math.max(1, Math.ceil(state.countdownMs / 1000)));
    if (seconds !== state.lastCountdownShown) {
      state.lastCountdownShown = seconds;
      showCountdownOverlay(seconds);
    }

    state.rafId = window.requestAnimationFrame(tick);
  }

  function beginPlay() {
    state.countingDown = false;
    state.running = true;
    state.remainingMs = CONFIG.gameDurationMs;
    state.teleportInMs = CONFIG.baseTeleportMs;
    state.lastSecondShown = -1;

    const bounds = placementBounds();
    state.snitchX = (bounds.minX + bounds.maxX) / 2;
    state.snitchY = (bounds.minY + bounds.maxY) / 2;
    teleportSnitch();

    el.snitch.classList.remove('is-hidden');
    renderTimer();
    startLoop();
  }

  /* ------------------------------------------------------------------------
     Lifecycle
     ------------------------------------------------------------------------ */
  function startGame() {
    state.score = 0;
    state.running = false;
    state.countingDown = true;
    state.countdownMs = CONFIG.countdownMs;
    state.lastCountdownShown = -1;
    state.remainingMs = CONFIG.gameDurationMs;
    state.teleportInMs = CONFIG.baseTeleportMs;
    state.lastSecondShown = -1;

    el.score.textContent = '0';
    el.highScore.textContent = String(topScore());
    el.timer.classList.remove('is-urgent');
    el.timer.textContent = String(Math.ceil(CONFIG.gameDurationMs / 1000));

    clearBursts();
    el.snitch.classList.add('is-hidden');
    applyPlayfieldTheme(resolveTheme(state.themeSetting));
    showScreen('game'); // must precede placement: the playfield needs a size

    el.countdownPhrase.textContent = pickCountdownPhrase();
    state.lastCountdownShown = Math.ceil(CONFIG.countdownMs / 1000);
    showCountdownOverlay(state.lastCountdownShown);
    startLoop();
  }

  function endGame() {
    state.running = false;
    state.countingDown = false;
    stopLoop();
    hideCountdownOverlay();
    el.snitch.classList.add('is-hidden');
    clearBursts();

    const earned = qualifies(state.score);
    state.pendingScore = earned ? state.score : 0;

    el.finalScore.textContent = String(state.score);
    el.savedNote.hidden = true;
    el.nameEntry.hidden = !earned;
    el.noRecord.hidden = earned;
    el.gameoverScoresHeading.textContent = state.adultMode ? 'Adult Mode' : 'Top 15';

    if (earned) {
      el.nameInput.value = '';
      renderScores(el.gameoverScores, { pending: pendingEntry() });
      setRestartReady(false);
    } else {
      renderScores(el.gameoverScores, {});
      setRestartReady(true);
    }

    // Deliberately not focusing the field: on a phone that would throw up the
    // keyboard and cover the table the player just earned a place in.
    showScreen('gameover');
  }

  /* ------------------------------------------------------------------------
     Events
     ------------------------------------------------------------------------ */
  el.btnStart.addEventListener('click', startGame);
  el.snitch.addEventListener('pointerdown', onSnitchTap);

  function leaveGameOverIfNamed() {
    if (state.pendingScore) {
      el.nameInput.focus();
      return false;
    }
    return true;
  }

  el.btnRestart.addEventListener('click', function () {
    if (!leaveGameOverIfNamed()) return;
    startGame();
  });

  el.btnMenu.addEventListener('click', function () {
    if (!leaveGameOverIfNamed()) return;
    showScreen('start');
  });

  el.nameEntry.addEventListener('submit', function (event) {
    event.preventDefault();
    commitPendingScore();
    el.nameInput.blur(); // dismiss the mobile keyboard
  });

  // Keep the provisional row in step with what is being typed.
  el.nameInput.addEventListener('input', function () {
    if (!state.pendingScore) return;
    renderScores(el.gameoverScores, { pending: pendingEntry() });
  });

  el.btnScores.addEventListener('click', function () {
    renderScores(el.scoresList, {}, false);
    el.scoresEmpty.hidden = scores.length > 0;
    renderScores(el.adultScoresList, {}, true);
    el.adultScoresEmpty.hidden = adultScores.length > 0;
    showScreen('scores');
  });

  el.btnScoresBack.addEventListener('click', function () {
    showScreen('start');
  });

  el.btnSettings.addEventListener('click', function () {
    syncThemeButtons();
    syncAdultButtons();
    showSettingsPane('home');
    showScreen('settings');
  });

  el.btnSettingsBack.addEventListener('click', function () {
    showScreen('start');
  });

  el.btnSettingsBackground.addEventListener('click', function () {
    syncThemeButtons();
    showSettingsPane('background');
  });

  el.btnSettingsAdult.addEventListener('click', function () {
    syncAdultButtons();
    showSettingsPane('adult');
  });

  el.btnBackgroundBack.addEventListener('click', function () {
    showSettingsPane('home');
  });

  el.btnAdultBack.addEventListener('click', function () {
    showSettingsPane('home');
  });

  el.themeOptions.forEach(function (btn) {
    btn.addEventListener('click', function () {
      selectThemeSetting(btn.getAttribute('data-theme'));
    });
  });

  el.adultOptions.forEach(function (btn) {
    btn.addEventListener('click', function () {
      selectAdultMode(btn.getAttribute('data-adult'));
    });
  });

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
    } else if (state.running || state.countingDown) {
      startLoop();
    }
  });

  window.addEventListener('resize', function () {
    if (state.running) clampSnitchIntoView();
  });

  /* ------------------------------------------------------------------------
     Boot
     ------------------------------------------------------------------------ */
  purgeLegacyScores();
  scores = loadScoreTable(CONFIG.scoresKey);
  adultScores = loadScoreTable(CONFIG.adultScoresKey);
  syncThemeButtons();
  syncAdultButtons();
  syncMenuStatus();
  el.highScore.textContent = String(topScore());
  el.snitch.classList.add('is-hidden');
  showScreen('start');
})();
