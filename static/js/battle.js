(function(){



  let TILE_SIZE = 96;             // rendered tile height — can now be changed live via the zoom control
  const TILE_SIZE_DEFAULT = 96;
  const TILE_SIZE_MIN = 48;
  const TILE_SIZE_MAX = 224;
  const TILE_SIZE_STEP = 16;

  // True flat-top hex geometry derived from TILE_SIZE (the hex's point-to-point width).
  // height = sqrt(3)/2 * width; columns are packed 0.75*width apart so they interlock;
  // odd columns drop by half a hex height (matches the existing x%2 offset scheme).
  function hexGeometry(tileSize) {
    const w = tileSize;
    const h = tileSize * Math.sqrt(3) / 2;
    return { w, h, colStep: w * 0.75, rowStep: h, rowOffset: h / 2 };
  }

  const root = document.getElementById('battle-root');
  if(!root) return;
  const gameId = root.dataset.gameId;

  // Restore the player's preferred tile size for this game, if any was saved.
  try {
    const savedTileSize = parseInt(localStorage.getItem(`battle-tile-size-${gameId}`), 10);
    if (!isNaN(savedTileSize)) {
      TILE_SIZE = Math.max(TILE_SIZE_MIN, Math.min(TILE_SIZE_MAX, savedTileSize));
    }
  } catch (e) { /* localStorage unavailable — ignore */ }
  const el = {
    turnInfo: document.getElementById('turn-info'),
    actions: document.getElementById('action-buttons'),
    bf: document.getElementById('battlefield'),
    bfViewport: document.getElementById('battlefield-viewport'),
    log: document.getElementById('log'),
    redUnits: document.getElementById('red-units'),
    blueUnits: document.getElementById('blue-units'),
    redCards: document.getElementById('red-cards'),
    blueCards: document.getElementById('blue-cards'),
    errorMessage: document.getElementById('error-message'),
    minimap: document.getElementById('battle-minimap'),
    minimapWrap: document.getElementById('battle-minimap-wrap'),
    minimapViewport: document.getElementById('battle-minimap-viewport'),
    minimapCoords: document.getElementById('minimap-coords')

  };

  let state = null;
  let pendingAction = null;
  let advancePhase = null;   // null | 'move' | 'shoot'  — tracks Advance action sub-steps
  let reachable = new Map();
  let listDone=false;
  let minimapBound = false;
  let minimapMeta = null;
  let minimapPosition = 'right'; // 'right' = top-right, 'left' = top-left

  const minimapPanel = el.minimapWrap && el.minimapWrap.closest('.battle-minimap-panel');
  minimapPanel.style.left  = '';
  minimapPanel.style.right = '12px';
  minimapPosition = 'right';



  const MINIMAP_TERRAIN_COLORS = {
    open: '#a8e4ad75',
    wall: '#4b634d',
    rocks: '#4b634d',
    rough: '#7c3aed',
    cover: '#16a34a',
    water: '#2563eb',
    forest: '#14532d',
    highground: '#92400e',
    hstreet_so_ne:'#e4c89e9f',
    hstreet_so_n: '#e4c89e9f',
    hstreet_s_no: '#e4c89e9f',
    hstreet_s_ne: '#e4c89e9f',
    hstreet_se_no: '#e4c89e9f',
    hstreet_se_n: '#e4c89e9f',
    hstreet_s_n: '#e4c89e9f',
    qstreet_e_w: '#e4c89e9f',
    qstreet_e_n_w: '#e4c89e9f',
    qstreet_n_e_s: '#e4c89e9f',
    qstreet_n_w_s: '#e4c89e9f',
    qstreet_w_s_e: '#e4c89e9f',
    qstreet_n_e: '#e4c89e9f',
    qstreet_n_w: '#e4c89e9f',
    qstreet_s_e: '#e4c89e9f',
    qstreet_s_w: '#e4c89e9f'
  };

  //enable stacking
  let stackingEnabled = true; // Set to true to enable unit stacking on the same tile

  //enable traversal of friendly units when calculating movement range
  let traverseFriendlyUnits = true;;


  // ── Alternating Activation state ─────────────────────────────────────────
  // actedUnits: Set of unit IDs that have completed an action this round
  let altActivationEnabled = false;   // toggled by the UI checkbox
  let actedUnits = new Set();         // reset every time a new round begins

  // ── Alternate-Check activation roll ─────────────────────────────────────
  // Only active when activationMode === 'Alternate-Check'
  const ACTIVATION_THRESHOLDS = { green: 5, seasoned: 4, veteran: 3, elite: 2 };

  const MORALE_THRESHOLDS = { green: 8, seasoned: 9, veteran: 10, elite: 10 };

  /**
   * Roll a D6 activation check for the selected unit.
   * Returns { rolled, threshold, success }.
   */
  function rollActivationCheck(unit) {
    const rolled = Math.floor(Math.random() * 6) + 1;
    const threshold = ACTIVATION_THRESHOLDS[unit.experience || 'seasoned'] ?? 5;
    const stress = unit.stress || 0; // each point of stress adds to the activation check threshold
    return { rolled, threshold, stress, success: rolled >= threshold + stress };
  }

  /**
   * If activationMode is 'Alternate-Check', show the roll result popup and
   * return whether the unit is allowed to act.
   * If the check fails, puts the unit into overwatch and handles player swap.
   * Returns true  → proceed with action
   * Returns false → action cancelled (unit went to overwatch)
   */
  async function performActivationCheck(unit) {
    if (state.battlefield.activationMode !== 'Alternate-Check') return true;

    const { rolled, threshold, stress, success } = rollActivationCheck(unit);
    const expLabel = (unit.experience || 'seasoned').charAt(0).toUpperCase() +
                     (unit.experience || 'seasoned').slice(1);

    if (success) {
      await showPhasePopup('Activation Check', [
        { icon: '🎲', label: 'Rolled',      value: `${rolled}`,           highlight: false },
        { icon: '🎯', label: 'Need',         value: `${threshold}+  (${expLabel} Stress: ${stress})`, highlight: false },
        { icon: '✅', label: 'Result',       value: 'ACTIVATED — action proceeds!', highlight: true  },
      ], { icon: '🎲' });

      // if pinMoraleChecksAsFUBAR is enabled, after activation stress is removed
      if (state.battlefield.combatOptions.pinMoraleChecksAsFUBAR) {
        try {
          await api(`/unit/${unit.id}/attribute`, { method: 'POST', body: JSON.stringify({ attribute: 'stress', value: 0 }) });
          state = await api('/state');
        } catch (e) { /* ignore */ }
      }


      return true;
    } else {
      await showPhasePopup('Activation Check — FAILED', [
        { icon: '🎲', label: 'Rolled',      value: `${rolled}`,           highlight: false },
        { icon: '🎯', label: 'Need',         value: `${threshold}+  (${expLabel} Stress: ${stress})`, highlight: false },
        { icon: '❌', label: 'Result',       value: 'FAILED — unit goes to Overwatch', highlight: false },
      ], { icon: '🎲' });

      // if pinMoraleChecksAsFUBAR is enabled, after activation stress is removed
      if (state.battlefield.combatOptions.pinMoraleChecksAsFUBAR) {
        try {
          await api(`/unit/${unit.id}/attribute`, { method: 'POST', body: JSON.stringify({ attribute: 'stress', value: 0 }) });
          state = await api('/state');
        } catch (e) { /* ignore */ }
      }
      // Put unit in overwatch via the server
      try {
        await api('/action', { method: 'POST', body: JSON.stringify({ action: 'overwatch' }) });
        state = await api('/state');
      } catch (e) { /* overwatch may already be set */ }

      // Mark as acted so the unit cannot be selected again this round
      actedUnits.add(unit.id);
      render();

      await handleUnitActedOnFail();
      return false;
    }
  }

    /**
   * Roll a 2 D6 morale check for the selected unit.
   * Returns { rolled, threshold, success }.
   */
   function rollMoraleCheck(unit) {
    const rolled = Math.floor(Math.random() * 6) + 1 + Math.floor(Math.random() * 6) + 1;
    let threshold = MORALE_THRESHOLDS[unit.experience || 'seasoned'] ?? 5;
    threshold -= unit.stress || 0; // each point of stress subtracts from the morale check threshold
    return { rolled, threshold, stress: unit.stress || 0, success: rolled <= threshold };
  }

  async function performMoraleCheck(unit) {
    if (state.battlefield.activationMode === 'Alternate-Check') return true;

    if (unit.stress === 0) return true; // No morale check needed if unit is not stressed


    const { rolled, threshold, stress, success } =  rollMoraleCheck(unit);
    const expLabel = (unit.experience || 'seasoned').charAt(0).toUpperCase() +
                     (unit.experience || 'seasoned').slice(1);

    if (success) {
      await showPhasePopup('Morale Check', [
        { icon: '🎲', label: 'Rolled',      value: `${rolled}`,           highlight: false },
        { icon: '🎯', label: 'Need',         value: `<=${threshold} [stress: ${stress}]  (${expLabel})`, highlight: false },
        { icon: '✅', label: 'Result',       value: 'PASSED — action proceeds! Stress reduced', highlight: true  },
      ], { icon: '🎲' });
      unit.stress = Math.max(0, unit.stress - 1); // reduce stress by 1 on a successful morale check
      await api(`/unit/${unit.id}/attribute`, { method: 'POST', body: JSON.stringify({ attribute: 'stress', value: unit.stress }) });
      state = await api('/state');
      render();    

      return true;
    } else {
      await showPhasePopup('Morale Check — FAILED', [
        { icon: '🎲', label: 'Rolled',      value: `${rolled}`,           highlight: false },
        { icon: '🎯', label: 'Need',         value: `<=${threshold} [stress: ${stress}]  (${expLabel})`, highlight: false },
        { icon: '❌', label: 'Result',       value: 'FAILED — unit goes to Overwatch', highlight: false },
      ], { icon: '🎲' });

      // Put unit in overwatch via the server
      try {
        await api('/action', { method: 'POST', body: JSON.stringify({ action: 'overwatch' }) });
        state = await api('/state');
      } catch (e) { /* overwatch may already be set */ }

      // Mark as acted so the unit cannot be selected again this round
      actedUnits.add(unit.id);
      render();    

      return false;
    }
  }




  /**
   * Called when an activation check fails.
   * Swaps to the opponent ONLY if the opponent still has unacted units.
   * If only the current player has remaining units, they keep the turn
   * (so they can choose another unit).
   */
  async function handleUnitActedOnFail() {
    if (allUnitsActed()) { render(); return; }

    const { red, blue } = remainingCounts();
    const opponent = state.current_player === 'red' ? 'blue' : 'red';
    const opponentHasUnits = (opponent === 'red' ? red : blue) > 0;

    if (opponentHasUnits) {
      // Hand off to opponent
      await api('/swap_turn', { method: 'POST' });
      state = await api('/state');
    }
    // else: only our side still has unacted units — stay with current player

    render();
  }

  async function ensureAlternateCheckAllowsAction() {

    const selId = state.selected_unit_id;
    const actingUnit = selId
      ? [...state.red.units, ...state.blue.units].find(u => u.id === selId)
      : null;

    if (!actingUnit) return true;


    if (moraleChecks && state.battlefield.activationMode !== 'Alternate-Check'){
      const passed = await performMoraleCheck(actingUnit);
      if (!passed) {
        pendingAction = null;
        clearHighlights();
      }

      return passed;
    }


    const allowed = await performActivationCheck(actingUnit);
    if (!allowed) {
      pendingAction = null;
      clearHighlights();
    }

    return allowed;
  }


  const TERRAIN_SPRITES = {
    open:       '/static/img/terrain/open.png',
    wall:       '/static/img/terrain/wall.png',
    rocks:      '/static/img/terrain/rocks.png',
    rough:      '/static/img/terrain/rough.png',
    cover:      '/static/img/terrain/cover.png',
    water:      '/static/img/terrain/water.png',
    forest:     '/static/img/terrain/forest.png',
    highground: '/static/img/terrain/highground.png',
    hstreet_so_ne: '/static/img/terrain/hstreet-so-ne.png',
    hstreet_so_n: '/static/img/terrain/hstreet-so-n.png',
    hstreet_s_no: '/static/img/terrain/hstreet-s-no.png',
    hstreet_s_ne: '/static/img/terrain/hstreet-s-ne.png',
    hstreet_se_no: '/static/img/terrain/hstreet-se-no.png',
    hstreet_se_n: '/static/img/terrain/hstreet-se-n.png',
    hstreet_s_n: '/static/img/terrain/hstreet-s-n.png',
    qstreet_e_w: '/static/img/terrain/qstreet-e-w.png',
    qstreet_e_n_w: '/static/img/terrain/qstreet-e-n-w.png',
    qstreet_n_e_s: '/static/img/terrain/qstreet-n-e-s.png',
    qstreet_n_w_s: '/static/img/terrain/qstreet-n-w-s.png',
    qstreet_w_s_e: '/static/img/terrain/qstreet-w-s-e.png',
    qstreet_n_e: '/static/img/terrain/qstreet-n-e.png',
    qstreet_n_w: '/static/img/terrain/qstreet-n-w.png',
    qstreet_s_e: '/static/img/terrain/qstreet-s-e.png',
    qstreet_s_w: '/static/img/terrain/qstreet-s-w.png'
  };

  function terrainImgSrc(type) {
    return TERRAIN_SPRITES[type] || TERRAIN_SPRITES['open'];
  }



  //LL cache
  let tileCache = new Map(); // key = "x,y" → { tileEl, imgEl, hpEl }
  let battlefieldInitialized = false;
  function tileKey(x, y) {
    return `${x},${y}`;
  }

  function initMinimapBindings() {
    if (minimapBound) return;
    if (!el.bfViewport || !el.minimapWrap || !el.minimap) return;

    minimapBound = true;
    el.bfViewport.addEventListener('scroll', updateMinimapViewportBox);
    window.addEventListener('resize', () => {
      drawMinimap();
      updateMinimapViewportBox();
    });
    el.minimapWrap.addEventListener('click', onMinimapClick);
  }

  function onMinimapClick(e) {
    if (!minimapMeta || !el.bfViewport) return;
    const rect = el.minimap.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    const localX = px - minimapMeta.offsetX;
    const localY = py - minimapMeta.offsetY;

    if (localX < 0 || localY < 0 || localX > minimapMeta.mapW || localY > minimapMeta.mapH) return;

    let tileX, tileY;
    if (minimapMeta.isHex) {
      tileX = Math.max(0, Math.min(minimapMeta.cols - 1, Math.round(localX / minimapMeta.colStep)));
      const rowOff = tileX % 2 === 1 ? minimapMeta.rowOffset : 0;
      tileY = Math.max(0, Math.min(minimapMeta.rows - 1, Math.round((localY - rowOff) / minimapMeta.rowStep)));
    } else {
      tileX = Math.max(0, Math.min(minimapMeta.cols - 1, Math.floor(localX / minimapMeta.scale)));
      tileY = Math.max(0, Math.min(minimapMeta.rows - 1, Math.floor(localY / minimapMeta.scale)));
    }
    centerViewportOnTile(tileX, tileY);
  }

  function centerViewportOnTile(tileX, tileY) {
    if (!el.bfViewport) return;
    const entry = tileCache.get(tileKey(tileX, tileY));
    if (!entry || !entry.tile) return;

    const cx = entry.tile.offsetLeft + entry.tile.offsetWidth / 2;
    const cy = entry.tile.offsetTop + entry.tile.offsetHeight / 2;
    const targetX = cx - el.bfViewport.clientWidth / 2;
    const targetY = cy - el.bfViewport.clientHeight / 2;

    el.bfViewport.scrollTo({
      left: Math.max(0, targetX),
      top: Math.max(0, targetY),
      behavior: 'smooth'
    });
  }

  function drawMinimap() {
    if (!el.minimap || !state) return;
    const ctx = el.minimap.getContext('2d');
    if (!ctx) return;

    const cols = state.battlefield.width;
    const rows = state.battlefield.height;
    const isHex = state.battlefield.tileMode !== 'square';
    const w = el.minimap.width;
    const h = el.minimap.height;

    // Minimap "scale" below is the hex's own point-to-point width in minimap pixels;
    // colStep/rowStep/rowOffset mirror hexGeometry() but in minimap-scale units.
    const logicalCols = isHex ? (cols - 1) * 0.75 + 1 : cols;
    const logicalRows = isHex ? rows * (Math.sqrt(3) / 2) + 0.5 * (Math.sqrt(3) / 2) : rows;
    const scale = Math.max(1, Math.min((w - 8) / logicalCols, (h - 8) / logicalRows));
    const colStep = isHex ? scale * 0.75 : scale;
    const rowStep = isHex ? scale * Math.sqrt(3) / 2 : scale;
    const rowOffset = isHex ? rowStep / 2 : 0;

    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#3f172a07';
    ctx.fillRect(0, 0, w, h);

    const mapW = (cols - 1) * colStep + scale;
    const mapH = (rows - 1) * rowStep + rowStep + rowOffset;
    const offsetX = Math.floor((w - mapW) / 2);
    const offsetY = Math.floor((h - mapH) / 2);

    minimapMeta = { cols, rows, scale, colStep, rowStep, rowOffset, isHex, mapW, mapH, offsetX, offsetY };

    function cellTopLeft(x, y) {
      const cx = offsetX + x * colStep;
      const cy = offsetY + y * rowStep + (isHex && x % 2 === 1 ? rowOffset : 0);
      return [cx, cy];
    }

    const terrMap = new Map();
    (state.battlefield.terrain || []).forEach(t => terrMap.set(tileKey(t.x, t.y), t.type));
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        const terr = terrMap.get(tileKey(x, y)) || 'open';
        ctx.fillStyle = MINIMAP_TERRAIN_COLORS[terr] || MINIMAP_TERRAIN_COLORS.open;
        const [cx, cy] = cellTopLeft(x, y);
        ctx.fillRect(cx, cy, scale, isHex ? rowStep : scale);
      }
    }

    const allUnits = [...state.red.units, ...state.blue.units];
    allUnits.forEach(u => {
      const [cx, cy] = cellTopLeft(u.position.x, u.position.y);
      const ux = cx + scale / 2;
      const uy = cy + (isHex ? rowStep : scale) / 2;
      const r = Math.max(2, scale * 0.35);

      ctx.beginPath();
      ctx.arc(ux, uy, r, 0, Math.PI * 2);
      ctx.fillStyle = u.team === 'red' ? '#ef4444' : '#60a5fa';
      ctx.fill();
    });

    if (state.selected_unit_id) {
      const selected = allUnits.find(u => u.id === state.selected_unit_id);
      if (selected) {
        const [sx, sy] = cellTopLeft(selected.position.x, selected.position.y);
        ctx.strokeStyle = '#22c55e';
        ctx.lineWidth = 2;
        ctx.strokeRect(sx, sy, scale, isHex ? rowStep : scale);
      }
    }

    ctx.strokeStyle = '#64748b';
    ctx.lineWidth = 1;
    ctx.strokeRect(offsetX - 0.5, offsetY - 0.5, mapW + 1, mapH + 1);
  }

  function updateMinimapViewportBox() {
    if (!el.bfViewport || !el.minimapViewport || !minimapMeta) return;

    const contentW = el.bf.scrollWidth;
    const contentH = el.bf.scrollHeight;
    if (!contentW || !contentH) return;

    const visibleW = el.bfViewport.clientWidth;
    const visibleH = el.bfViewport.clientHeight;
    const scrollLeft = el.bfViewport.scrollLeft;
    const scrollTop = el.bfViewport.scrollTop;

    const vwRaw = (visibleW / contentW) * minimapMeta.mapW;
    const vhRaw = (visibleH / contentH) * minimapMeta.mapH;
    const vw = Math.min(minimapMeta.mapW, Math.max(10, vwRaw));
    const vh = Math.min(minimapMeta.mapH, Math.max(10, vhRaw));
    const vxRaw = minimapMeta.offsetX + (scrollLeft / contentW) * minimapMeta.mapW;
    const vyRaw = minimapMeta.offsetY + (scrollTop / contentH) * minimapMeta.mapH;
    const vx = Math.min(minimapMeta.offsetX + minimapMeta.mapW - vw, Math.max(minimapMeta.offsetX, vxRaw));
    const vy = Math.min(minimapMeta.offsetY + minimapMeta.mapH - vh, Math.max(minimapMeta.offsetY, vyRaw));

    el.minimapViewport.style.left = `${vx}px`;
    el.minimapViewport.style.top = `${vy}px`;
    el.minimapViewport.style.width = `${vw}px`;
    el.minimapViewport.style.height = `${vh}px`;

    if (el.minimapCoords) {
      const centerX = Math.floor((scrollLeft + visibleW / 2) / TILE_SIZE);
      const centerY = Math.floor((scrollTop + visibleH / 2) / TILE_SIZE);
      el.minimapCoords.textContent = `(${centerX},${centerY})`;
    }

    // ── Auto-reposition minimap based on scroll position ─────────────────────
    const maxScrollLeft = el.bfViewport.scrollWidth - el.bfViewport.clientWidth;
    const minimapPanel = el.minimapWrap && el.minimapWrap.closest('.battle-minimap-panel');
    if (minimapPanel && maxScrollLeft > 0) {
      const atRight = scrollLeft >= maxScrollLeft - 2;
      const atLeft  = scrollLeft <= 2;

      if (atRight && minimapPosition === 'right') {
        // Fully scrolled right — move minimap to top-left
        minimapPanel.style.right = '';
        minimapPanel.style.left  = '12px';
        minimapPosition = 'left';
      } else if (atLeft && minimapPosition === 'left') {
        // Fully scrolled left while minimap is top-left — move it back to top-right
        minimapPanel.style.left  = '';
        minimapPanel.style.right = '12px';
        minimapPosition = 'right';
      }
    }
  }



  function initBattlefield() {
    tileCache.clear();
    el.bf.innerHTML = '';

    const cols = state.battlefield.width;
    const rows = state.battlefield.height;
    altActivationEnabled = (state.battlefield.activationMode === 'Alternate' || state.battlefield.activationMode === 'Alternate-Check');
   
    const tileMode = state.battlefield.tileMode || 'square';
    const activationMode = state.battlefield.activationMode || 'IGOYGO';
    const mapKey   = `${tileMode}-${cols}x${rows}`;
    const fallback = `/static/img/maps/plains-${tileMode}.png`;
    const mapImg   = `/static/img/maps/plains-${mapKey}.png`;

    const isHex = tileMode !== 'square';
    const hexGeo = isHex ? hexGeometry(TILE_SIZE) : null;
    const UNIT_TILE_SIZE = isHex ? Math.round(Math.min(hexGeo.w, hexGeo.h) - 50) : TILE_SIZE - 50;

    el.bf.style.backgroundImage = `url("${mapImg}"), url("${fallback}")`;
    el.bf.style.setProperty('--tile-size', `${UNIT_TILE_SIZE}px`);
    el.bf.classList.toggle('hex-mode', isHex);

    if (!isHex) {
      // Square mode: unchanged — regular CSS grid, intrinsic sizing.
      el.bf.style.width  = '';
      el.bf.style.height = '';
      el.bf.style.setProperty('--bgwidth',  `${TILE_SIZE * cols + 16}px`);
      el.bf.style.setProperty('--bgheight', `${TILE_SIZE * rows + 20}px`);
      el.bf.style.gridTemplateColumns = `repeat(${cols}, ${TILE_SIZE}px)`;
    } else {
      // Hex mode: true interlocking flat-top hexagons via absolute positioning.
      // Columns are 0.75*width apart (they overlap), odd columns drop by half a hex height.
      const totalW = (cols - 1) * hexGeo.colStep + hexGeo.w;
      const totalH = (rows - 1) * hexGeo.rowStep + hexGeo.h + (cols > 1 ? hexGeo.rowOffset : 0);
      el.bf.style.gridTemplateColumns = 'none';
      el.bf.style.position = 'relative';
      el.bf.style.width  = `${totalW}px`;
      el.bf.style.height = `${totalH}px`;
      el.bf.style.setProperty('--bgwidth',  `${totalW + 16}px`);
      el.bf.style.setProperty('--bgheight', `${totalH + 20}px`);
    }

    for (let y = 0; y < state.battlefield.height; y++) {
      for (let x = 0; x < state.battlefield.width; x++) {

        const t = document.createElement('div');
        t.className = 'tile';
        t.dataset.x = x;
        t.dataset.y = y;

        if (!isHex) {
          t.style.width  = `${TILE_SIZE}px`;
          t.style.height = `${TILE_SIZE}px`;
          t.style.gridRowStart    = y + 1;
          t.style.gridRowEnd      = y + 1;
          t.style.gridColumnStart = x + 1;
        } else {
          t.style.width  = `${hexGeo.w}px`;
          t.style.height = `${hexGeo.h}px`;
          t.style.position = 'absolute';
          t.style.left = `${x * hexGeo.colStep}px`;
          t.style.top  = `${y * hexGeo.rowStep + (x % 2 === 1 ? hexGeo.rowOffset : 0)}px`;
        }

        // Terrain class (keeps CSS colour fallback while image loads)
        const terr = terrainAt(x, y);
        if (terr !== 'open') t.classList.add(`t-${terr}`);

        // ── Terrain image (layer 0) ──────────────────────────────────────────
        const terrImg = document.createElement('img');
        terrImg.className = 'terrain-img';
        terrImg.src = terrainImgSrc(terr);
        terrImg.alt = '';
        terrImg.draggable = false;
        // If the PNG is missing, hide the element so the CSS colour shows through
        terrImg.onerror = () => { terrImg.style.display = 'none'; };
        t.appendChild(terrImg);           // inserted FIRST → z-index 0

        // ── HP badge (layer 3) ───────────────────────────────────────────────
        const hp = document.createElement('div');
        hp.className = 'hp';
        t.appendChild(hp);                // unit-img is inserted between these in updateUnitsOnBattlefield

        t.addEventListener('click', () => onTileClick(x, y));

        el.bf.appendChild(t);

        tileCache.set(tileKey(x, y), {
          tile: t,
          terrImg,   // keep ref so we can swap on terrain edits if needed
          img: null,
          hp
        });
      }
    }

    battlefieldInitialized = true;


  }


  /**
   * Change the rendered tile size on the fly (zoom in/out) mid-battle.
   * Rebuilds the battlefield grid at the new scale, keeps the current
   * scroll position roughly centred on the same tile, redraws the minimap,
   * and remembers the choice per-game in localStorage.
   */
  function setTileSize(px) {
    const clamped = Math.max(TILE_SIZE_MIN, Math.min(TILE_SIZE_MAX, Math.round(px)));
    if (clamped === TILE_SIZE) return;

    // Remember what grid cell is centred in the viewport so the view doesn't jump.
    const isHex = state && state.battlefield.tileMode !== 'square';
    const oldGeo = isHex ? hexGeometry(TILE_SIZE) : null;
    let focusX = 0, focusY = 0;
    const oldSize = TILE_SIZE;
    if (el.bfViewport && oldSize) {
      focusX = (el.bfViewport.scrollLeft + el.bfViewport.clientWidth / 2) / (isHex ? oldGeo.colStep : oldSize);
      focusY = (el.bfViewport.scrollTop + el.bfViewport.clientHeight / 2) / (isHex ? oldGeo.rowStep : oldSize);
    }

    TILE_SIZE = clamped;

    try { localStorage.setItem(`battle-tile-size-${gameId}`, String(TILE_SIZE)); } catch (e) { /* ignore */ }

    // Force a full battlefield rebuild at the new scale.
    battlefieldInitialized = false;
    render();

    // Restore the viewport around the same grid cell at the new scale.
    const newGeo = isHex ? hexGeometry(TILE_SIZE) : null;
    if (el.bfViewport) {
      el.bfViewport.scrollLeft = Math.max(0, focusX * (isHex ? newGeo.colStep : TILE_SIZE) - el.bfViewport.clientWidth / 2);
      el.bfViewport.scrollTop  = Math.max(0, focusY * (isHex ? newGeo.rowStep : TILE_SIZE) - el.bfViewport.clientHeight / 2);
    }

    updateTileZoomControlLabel();
  }

  function updateTileZoomControlLabel() {
    const label = document.getElementById('tile-zoom-label');
    if (label) label.textContent = `${TILE_SIZE}px`;
    const minusBtn = document.getElementById('tile-zoom-out');
    const plusBtn  = document.getElementById('tile-zoom-in');
    if (minusBtn) minusBtn.disabled = TILE_SIZE <= TILE_SIZE_MIN;
    if (plusBtn)  plusBtn.disabled  = TILE_SIZE >= TILE_SIZE_MAX;
  }

  /**
   * Injects a small zoom control (− / size / +/ reset) into the top actions
   * bar so the player can rescale the battlefield at any point during play.
   */
  function injectTileZoomControl() {
    if (document.getElementById('tile-zoom-controls')) {
      updateTileZoomControlLabel();
      return;
    }

    const wrapper = document.createElement('div');
    wrapper.id = 'tile-zoom-controls';
    wrapper.style.cssText = `
      display: inline-flex; align-items: center; gap: 6px;
      font-size: 12px; font-weight: 600; color: #94a3b8;
      background: #111827; border: 1px solid #334155;
      border-radius: 8px; padding: 4px 8px; user-select: none;
    `;

    const btnStyle = `
      background: #1f2937; color: #e2e8f0; border: 1px solid #334155;
      border-radius: 6px; width: 22px; height: 22px; line-height: 1;
      cursor: pointer; font-size: 13px; font-weight: 700;
    `;

    const minusBtn = document.createElement('button');
    minusBtn.id = 'tile-zoom-out';
    minusBtn.type = 'button';
    minusBtn.textContent = '−';
    minusBtn.title = 'Zoom out';
    minusBtn.style.cssText = btnStyle;
    minusBtn.addEventListener('click', () => setTileSize(TILE_SIZE - TILE_SIZE_STEP));

    const label = document.createElement('span');
    label.id = 'tile-zoom-label';
    label.textContent = `${TILE_SIZE}px`;
    label.style.cssText = 'min-width: 42px; text-align: center; cursor: pointer;';
    label.title = 'Reset zoom';
    label.addEventListener('click', () => setTileSize(TILE_SIZE_DEFAULT));

    const plusBtn = document.createElement('button');
    plusBtn.id = 'tile-zoom-in';
    plusBtn.type = 'button';
    plusBtn.textContent = '+';
    plusBtn.title = 'Zoom in';
    plusBtn.style.cssText = btnStyle;
    plusBtn.addEventListener('click', () => setTileSize(TILE_SIZE + TILE_SIZE_STEP));

    wrapper.append('🔍 ', minusBtn, label, plusBtn);

    const grp = document.querySelector('.actions-group');
    if (grp) grp.appendChild(wrapper);

    updateTileZoomControlLabel();
  }



function updateUnitsOnBattlefield() {

  const allUnits = [...state.red.units, ...state.blue.units];

  // Group units by tile key
  const byTile = new Map();
  for (const u of allUnits) {
    const k = tileKey(u.position.x, u.position.y);
    if (!byTile.has(k)) byTile.set(k, []);
    byTile.get(k).push(u);
  }

  function unitTileSignature(units) {
    return units.map(u => [
      u.id,
      u.team,
      u.n_of_figures,
      u.hp,
      u.stress || 0,
      u.status || 'normal',
      u.acted,
      u.smoked ? 1 : 0,
      state.selected_unit_id === u.id ? 1 : 0,
      actedUnits.has(u.id) ? 1 : 0
    ].join(':')).join('|');
  }

  // Clear only tiles whose contents changed.
  tileCache.forEach((entry, k) => {
    const units = byTile.get(k) || [];
    const signature = unitTileSignature(units);
    if (entry.unitSignature === signature) return;

    const { tile, hp } = entry;
    tile.classList.remove('red', 'blue', 'sel', 'smoke', 'down', 'overwatch');
    tile.style.opacity = '';
    tile.querySelectorAll('.unit-stack-slot').forEach(el => el.remove());
    tile.querySelectorAll('.unit-no-stack').forEach(el => el.remove());
    hp.textContent = '';
    entry.unitSignature = null;
  });

  for (const [k, units] of byTile) {
    const entry = tileCache.get(k);
    if (!entry) continue;
    const { tile, hp } = entry;

    if (entry.unitSignature && entry.unitSignature === unitTileSignature(units)) {
      continue;
    }

    const count = units.length;

    for (let i = 0; i < count; i++) {
      const u = units[i];

      // Tile-level classes (last unit wins for team colour, which is fine)
      //tile.classList.add(u.team);
      if (state.selected_unit_id === u.id) tile.classList.add('sel');
      if (u.smoked) tile.classList.add('smoke');
      if (u.status && u.status !== 'normal') tile.classList.add(u.status);

      // Create a positioned wrapper for each unit in the stack
      const slot = document.createElement('div');
      
      slot.className = stackingEnabled && count > 1 ? 'unit-stack-slot' : 'unit-no-stack';
      slot.dataset.unitId = u.id;
      slot.title = u.name || u.type || 'Unit';

      
      // ── NEW: click on a stacked slot selects that specific unit ──
      slot.addEventListener('click', async (e) => {
        e.stopPropagation();          // don't bubble up to the tile's own click handler
        if (pendingAction) return;    // mid-action: let the tile handler deal with it
        if (altActivationEnabled && actedUnits.has(u.id)) return;
        await api('/select_unit', { method: 'POST', body: JSON.stringify({ unit_id: u.id }) });
        await load();
      });
      

      // Pile offset: each unit shifts diagonally so they fan out
      if (count > 1) {
        // spread evenly: index 0 → top-left, last → bottom-right
        const spread = Math.min(10, 6 * (count - 1));
        const step   = count > 1 ? spread / (count - 1) : 0;
        const ox = 5 -spread / 2 + step * i;   // horizontal offset px
        const oy = 5 -spread / 2 + step * i;   // vertical offset px (same axis = diagonal)
        slot.style.transform = `translate(${ox}px, ${oy}px)`;
        slot.style.zIndex    = i + 1;
        // Scale down slightly so stacked sprites don't overflow the tile
        const scale = count >= 3 ? 0.65 : 0.78;
        slot.style.width  = `${scale * 100}%`;
        slot.style.height = `${scale * 100}%`;
      }

      // Team-coloured border ring around the slot
      slot.style.outline = `2px solid var(--${u.team})`;
      slot.style.borderRadius = '4px';
      slot.style.overflow = 'hidden';

      const img = document.createElement('img');
      img.className = 'unit-img';
      img.alt = u.name || u.type || 'Unit';
      img.title = u.name || u.type || 'Unit';

      const sprites = spriteForUnit(u);
      img.src = sprites.typeSprite || sprites.fallback;
      img.onerror = () => { img.src = sprites.fallback; };


      img.addEventListener('click', () => onTileClick(u.position.x, u.position.y));


      slot.appendChild(img);

      // ── Armor shield badge ───────────────────────────────────────────────
      if (u.armor > 0) {
        const shield = document.createElement('div');
        shield.className = 'unit-armor-badge';
        shield.textContent = `🛡️`;
        slot.appendChild(shield);
      }

      // ── Down badge ───────────────────────────────────────────────
      if (u.status === 'down') {
        const down = document.createElement('div');
        down.className = 'unit-down-badge';
        down.textContent = `⬇️`;
        slot.appendChild(down);
      }
      

      // ── Stress badge ───────────────────────────────────────────────
      if (u.stress > 0) {
        const stress = document.createElement('div');
        stress.className = 'unit-stress-badge';
        //stress.textContent = `📍`.repeat(u.stress);
        stress.textContent = `📍${u.stress}`;
        slot.appendChild(stress);
      }
      if (u.status === 'overwatch' && u.overwatch_ready) {
        const overwatch = document.createElement('div');
        overwatch.className = 'unit-overwatch-badge';
        overwatch.textContent = `🎯`;
        slot.appendChild(overwatch);
      }

      tile.insertBefore(slot, hp);
      entry.img = img; // keep last ref (for compat)
    }

    // HP badge: show combined or per-unit summary
    if (count === 1) {
      if(units[0].n_of_figures > 1){
        hp.textContent = `[${units[0].n_of_figures}] hp ${units[0].hp} `;
      } else
        hp.textContent = `hp ${units[0].hp}`;

      if (actedUnits.has(units[0].id)){
        hp.textContent += ' ⛔';
      }
    } else {
      //hp.textContent = units.map(u => u.hp).join('/');
      for (const u of units) {
        if(u.n_of_figures > 1){
          hp.textContent += `[${u.n_of_figures}] `;
        }
        hp.textContent += u.hp;
        if (actedUnits.has(u.id)){  
          hp.textContent += ' ⛔';
        } 
        hp.textContent += '/';
      }
      hp.textContent = hp.textContent.slice(0, -1); // remove trailing slash      
    }

    entry.unitSignature = unitTileSignature(units);
  }
}

function syncActedUnitsFromState() {
  if (!state) return;
  const allUnits = [...state.red.units, ...state.blue.units];
  for (const u of allUnits) {
    if (u.acted) actedUnits.add(u.id);
  }
}


  // --- SOUND EFFECTS ---
  const SFX = {
    adrenaline: new Audio("/static/sfx/generic.mp3"),
    medkit: new Audio("/static/sfx/medikit.mp3"),
    grenade: new Audio("/static/sfx/generic.mp3"),
    smoke: new Audio("/static/sfx/smoke.mp3"),
    suppress: new Audio("/static/sfx/generic.mp3"),
    harden: new Audio("/static/sfx/gun.mp3"),
    scout: new Audio("/static/sfx/gun.mp3"),
    charge: new Audio("/static/sfx/gun.mp3"),
    steady: new Audio("/static/sfx/generic.mp3"),
    fortify: new Audio("/static/sfx/generic.mp3"),

    death: new Audio("/static/sfx/death.mp3"),
    explode: new Audio("/static/sfx/tank-expl.mp3")

  };

  function playCardSound(cardId) {
    const snd = SFX[cardId];
    if (snd) {
        snd.currentTime = 0;
        snd.play().catch(() => {});
    }
  }


  // Map a unit object to a sprite URL.



  // Pick the most specific matching sprite:
  // 1) team_type.png      (e.g. red_sniper.png)
  // 2) team_soldier.png   (fallback)
  function spriteForUnit(u) {
    const era = state.battlefield.era || 'nato';
    const base = `/static/img/units/${era}`;
    const team = (u.team === 'red') ? 'red' : 'blue';
    const type = u.type || 'soldier';

    // Priority 1: type sprite
    const typeSprite = `${base}/${team}_${type}.png`;

    // Priority 2: generic soldier fallback
    const fallback = `${base}/${team}_soldier.png`;

    // We cannot test file existence here (browser-side), so we use
    // a dynamic <img>.onerror fallback pattern:
    return { typeSprite, fallback };
  }
  // Small avatar for list (can reuse main sprite)

  function miniForUnit(u) {
    const sprites = spriteForUnit(u);
    // Minis re-use the same cascading bitmap loading
    return sprites;  
  }

 
  function unitInfoHtml(u) {
    const w = u.weapon || { ammo: 0, range: 0 };
    // Show a small "acted" badge when alt-activation is active
    const actedBadge = ( actedUnits.has(u.id))
      ? `<div style="color:#f59e0b;font-size:10px;font-weight:700;">✔ ACTED</div>`
      : '';
    const EXP_LABELS = { green: '🟢 Green', seasoned: '🟡 Seasoned', veteran: '🟠 Veteran', elite: '🔴 Elite' };
    const expKey = u.experience || 'seasoned';
    const expBadge = `<span class="exp-badge exp-${expKey}">${EXP_LABELS[expKey] || expKey}</span>`;
    const armBadge = u.armor ? `<span class="armor-badge">🛡️ ${u.armor}</span>` : '';
    return `
      <div><strong>${u.name}</strong> ${expBadge} ${armBadge}</div>
      <div>HP  ${u.hp}/${u.max_hp} POS (${u.position.x},${u.position.y}) </div>
      <div>#FIG ${u.n_of_figures}/${u.max_figures} SPD ${u.speed}</div>
      <div>WPN ${w.name || '-'} [R${w.range || 0} A${w.ammo || 0}]</div>
      <div>SHLD ${u.shields} #ATT ${u.n_of_attacks}</div>
      ${u.status !== 'normal' ? `<div>Status: ${u.status.toUpperCase()}</div>` : ''}
      ${actedBadge}
    `;
  }
 
  async function api(path, opts={}){
    const res = await fetch(`/api/game/${gameId}${path}`, {headers:{'Content-Type':'application/json'}, credentials:'same-origin', ...opts});
    if(!res.ok){
      const t = await res.text();
      throw new Error(t || res.statusText);
    }
    return res.json();
  }

  function terrainAt(x,y){
    const terr = state.battlefield.terrain || [];
    for(const t of terr){ if(t.x===x && t.y===y) return t.type; }
    return 'open';
  }

  function unitAt(x,y){
    return [...state.red.units, ...state.blue.units].find(u => u.position.x===x && u.position.y===y);
  }

  function inBounds(x,y){
    return x>=0 && y>=0 && x<state.battlefield.width && y<state.battlefield.height;
  }

  function neighborOffsets(x, tileMode = (state.battlefield.tileMode || 'square')) {
    if (tileMode === 'square') return [[0,1],[0,-1],[-1,0],[1,0]];
    return (x % 2 === 0)
      ? [[0,1],[0,-1],[-1,0],[-1,-1],[1,0],[1,-1]]
      : [[0,1],[0,-1],[-1,0],[-1,1],[1,0],[1,1]];
  }

  function isAdjacent(x1, y1, x2, y2){
    return neighborOffsets(x1).some(([dx,dy]) => x1 + dx === x2 && y1 + dy === y2);
  }

  function isPassableForUnit(unit, x, y){
    if(!inBounds(x,y)) return false;
    const tt = terrainAt(x,y);
    if(unit.impassable && unit.impassable.includes(tt)) return false;
    if(tt === 'rocks') return false;
    return true;
  }

  function tileId(x,y){ return `${x},${y}`; }

  //remember this is duplicated in server pathfinding — any changes here should be reflected there for consistency
  function moveCost(unit,x,y, actionType){
    // Rocks and water are impassable  , other terrains have different costs 

    // Check if terrain is declared impassable for this specific unit 
    if(unit.impassable && unit.impassable.includes(terrainAt(x,y))) return 9999;

    switch (terrainAt(x,y)) {
      case 'rough':
      case 'forest':
      case 'wall':
      case 'highground':
        if(actionType === 'move' && unit.speed === 1) return 1;
        return 2;
      case 'hstreet_so_ne':
      case 'hstreet_so_n':
      case 'hstreet_s_no':
      case 'hstreet_s_ne':
      case 'hstreet_se_no':
      case 'hstreet_se_n':
      case 'hstreet_s_n':
      case 'qstreet_e_w':
      case 'qstreet_e_n_w':
      case 'qstreet_n_e_s':
      case 'qstreet_n_w_s':
      case 'qstreet_w_s_e':
      case 'qstreet_n_e':
      case 'qstreet_n_w':
      case 'qstreet_s_e':
      case 'qstreet_s_w':
        return 0.5; // treat all h_street and q_street variants as normal for running (they just have different visuals)

      case 'water':
      case 'rocks':
        return 9999;
      default:
        return 1;
    }
  }



  function computeReachable(){
    reachable.clear();
    const selId = state.selected_unit_id; if(!selId) return;
    const u = [...state.red.units, ...state.blue.units].find(x=>x.id===selId); if(!u) return;
    const ux = u.position.x, uy = u.position.y;

    const base = (pendingAction==='move' || pendingAction==='advance') ? u.speed : (pendingAction==='run' ? 2*u.speed : 0);
    if(base===0) return;
    const range = base + (u.adrenaline?1:0);

    const pq = [[0, ux, uy]]; const best = new Map(); best.set(tileId(ux,uy),0);
    const seen=new Set();
    while(pq.length){
      pq.sort((a,b)=>a[0]-b[0]);
      const [cost,x,y] = pq.shift(); if(seen.has(tileId(x,y))) continue; seen.add(tileId(x,y));

      for(const [dx,dy] of neighborOffsets(x)){
        const nx=x+dx, ny=y+dy;
        if(!isPassableForUnit(u, nx, ny)) continue;
        //LL STACK: just disabling reachable here should block any stacking possibility 
        //if(!stackingEnabled && unitAt(nx,ny) && !(nx===ux && ny===uy)) continue;
        
        
        if(traverseFriendlyUnits){
          const occ = unitAt(nx, ny);
          if (occ && occ.team !== u.team && !(nx === ux && ny === uy)) {
            if(!enterEnemyTile) continue; // May block movement through non friendly units
          }
        }else{
          if (unitAt(nx, ny) && !(nx === ux && ny === uy)) {
            continue; // Block movement through any units
          }
        }
        const ncost = cost +  moveCost(u,nx,ny, pendingAction);
        if(ncost>range) continue;
        const nid=tileId(nx,ny);
        if(!best.has(nid) || ncost<best.get(nid)){
          best.set(nid, ncost); pq.push([ncost, nx, ny]);
        }
      }
    }
    for(const [k,v] of best){ if(k!==tileId(ux,uy)) reachable.set(k,v); }
  }

  function clearHighlights(){ 
    if(advancePhase === 'shoot') {
      el.bf.querySelectorAll('.tile').forEach(t=>t.classList.remove('reachable','path')); 

    }else
      el.bf.querySelectorAll('.tile').forEach(t=>t.classList.remove('reachable','path','targetable')); 
  }
  function showReachable(){ 
    inv=0
    el.bf.querySelectorAll('.tile').forEach(t=>{ 
      const id=tileId(+t.dataset.x,+t.dataset.y); 
      //LL STACK: if a tile is occupied, it's not reachable, even if it's in range — this prevents any stacking only on the destination tile, 
      // but allows units to move through friendly stacks if traverseFriendlyUnits is enabled. Enemy stacks will still block movement either way.
      if(!stackingEnabled && unitAt(+t.dataset.x,+t.dataset.y) ) {
        inv++;
      }else{
        if(reachable.has(id)) t.classList.add('reachable'); 
      }
    }); 
  }

  // Hex LOS helpers
  function cube_distance(a, b) {
    return Math.max(Math.abs(a[0]-b[0]), Math.abs(a[1]-b[1]), Math.abs(a[2]-b[2]));
  }

  function cube_lerp(a, b, t) {
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
  }

  function cube_round(cube) {
    // Banker's rounding to match Python
    function bankersRound(x) {
      const r = Math.round(x);
      const frac = Math.abs(x % 1);
      if (frac === 0.5) {
        return r % 2 === 0 ? r : r - Math.sign(x);
      }
      return r;
    }
    let rx = bankersRound(cube[0]);
    let ry = bankersRound(cube[1]);
    let rz = bankersRound(cube[2]);
    const x_diff = Math.abs(rx - cube[0]);
    const y_diff = Math.abs(ry - cube[1]);
    const z_diff = Math.abs(rz - cube[2]);
    if (x_diff > y_diff && x_diff > z_diff) {
      rx = -ry - rz;
    } else if (y_diff > z_diff) {
      ry = -rx - rz;
    } else {
      rz = -rx - ry;
    }
    return [rx, ry, rz];
  }

  function axial_to_cube(q, r) {
    const x = q;
    const z = r;
    const y = -x - z;
    return [x, y, z];
  }

  function cube_to_axial(cube) {
    const [x, y, z] = cube;
    const q = x;
    const r = z;
    return [q, r];
  }

  function hex_line(q1, r1, q2, r2) {
    const start = axial_to_cube(q1, r1);
    const end = axial_to_cube(q2, r2);
    const N = cube_distance(start, end);
    const results = [];
    for (let i = 0; i <= N; i++) {
      const t = N > 0 ? 1.0 / N * i : 0;
      const lerped = cube_lerp(start, end, t);
      const rounded = cube_round(lerped);
      const axial = cube_to_axial(rounded);
      results.push(axial);
    }
    return results;
  }

  function losClearAndInRange(x1, y1, x2, y2, maxR) {
    const tileMode = state.battlefield.tileMode;
    if (tileMode === 'hex') {
      // For hex, use hex line drawing
      const q1 = x1;
      const r1 = y1 - (x1 >> 1);  // integer division
      const q2 = x2;
      const r2 = y2 - (x2 >> 1);
      const tiles = hex_line(q1, r1, q2, r2);

      me=unitAt(x1,y1);
      //el.errorMessage.innerHTML = el.errorMessage.innerHTML + ` =>D:(${tiles.length-1}) R:${maxR}  ${q1} , ${r1} => ${q2} , ${r2} . `;

      if(tiles.length -1 > maxR){
        //el.errorMessage.innerHTML = el.errorMessage.innerHTML + ` Out of range. `;
        return false;  
      }

      for (let i = 1; i < tiles.length - 1; i++) {  // exclude start and end
        const [q, r] = tiles[i];
        const x = q;
        const y = r + (q >> 1);
        //el.errorMessage.innerHTML = el.errorMessage.innerHTML + ` T:(${x},${y}) `;

        if (inBounds(x, y)) {
          const occ = unitAt(x, y);
          if (occ && !(x === x1 && y === y1) && !(x === x2 && y === y2))  {

            if(chargeTraverseFriendlyUnits){
              if(occ.team !== me.team){
                return false; // Block LOS through non friendly units
              }
            }else{    
              return false; // blocked by any unit (except self)
            }
          }
          const tt = terrainAt(x, y);
          if (tt === 'wall' || tt === 'forest' || tt === 'highground' || tt === 'rocks') {
            //el.errorMessage.innerHTML = el.errorMessage.innerHTML + `B:(${x},${y}). `;
            return false;
          }
        } 
      }
      return true;
    } else {
      // Square mode with oversampling
      const dx = x2 - x1;
      const dy = y2 - y1;
      const dist = Math.sqrt(dx * dx + dy * dy);
      el.errorMessage.innerHTML = el.errorMessage.innerHTML + ` => Dist: ${dist.toPrecision(3)}. `;
      if (dist === 0) return true;
      if(dist > maxR){
        el.errorMessage.innerHTML = el.errorMessage.innerHTML + ` Out of range D: ${dist.toPrecision(3)} R: ${maxR} . `;
        return false;  
      }        
      const num_samples = Math.max(1, Math.floor(dist * 3));  // 3 samples per unit
      const tiles_passed = new Set();
      for (let i = 1; i <= num_samples; i++) {  // exclude start
        const t = i / num_samples;
        const px = x1 +0.5 + t * dx;
        const py = y1 +0.5 + t * dy;
        const tx = Math.floor(px);
        const ty = Math.floor(py);
        if(tx === x2 && ty === y2) continue;  // skip target tile
        if(tx === x1 && ty === y1) continue;  // skip start tile
        if (inBounds(tx, ty)) {
          tiles_passed.add(`${tx},${ty}`);
        }
      }
      for (const tile of tiles_passed) {
        const [tx, ty] = tile.split(',').map(Number);
        el.errorMessage.innerHTML = el.errorMessage.innerHTML + ` T:(${tx},${ty}) `;

        const occ = unitAt(tx, ty);
        if (occ && !(tx === x1 && ty === y1) && !(tx === x2 && ty === y2))  {

          if(chargeTraverseFriendlyUnits){
            if(occ.team !== me.team){
              el.errorMessage.innerHTML = el.errorMessage.innerHTML + `OF:(${tx},${ty}). `;
              return false; // Block LOS through non friendly units
            }
          }else{    
            el.errorMessage.innerHTML = el.errorMessage.innerHTML + `O:(${tx},${ty}). `;
            return false; // blocked by any unit (except self)
          }
        }

        const tt = terrainAt(tx, ty);
        if (tt === 'wall' || tt === 'forest' || tt === 'highground' || tt === 'rocks'){
            el.errorMessage.innerHTML = el.errorMessage.innerHTML + `B:(${tx},${ty}). `;
            return false;
        } 
      }
      return true;
    }
  };

  function computeTargets(originX, originY){
    const targets = new Set();
    const selId = state.selected_unit_id; if(!selId) return targets;
    const me = [...state.red.units, ...state.blue.units].find(x=>x.id===selId); if(!me) return targets;
    const ux = (originX !== undefined) ? originX : me.position.x;
    const uy = (originY !== undefined) ? originY : me.position.y;
    const maxR = me.weapon.range;
    const enemies = state[state.current_player==='red'?'blue':'red'].units;

    for(const e of enemies){ 
      const tx=e.position.x, ty=e.position.y; 
      const man=Math.abs(ux-tx)+Math.abs(uy-ty);
      if(e.armor > 0 && (!me.weapon.armouredDmg || me.weapon.armouredDmg < 1)) continue; // can't target armoured enemies if weapon can't damage armour
      if(losClearAndInRange(ux,uy,tx,ty,maxR)) 
        targets.add(tileId(tx,ty)); 
      }
    return targets;
  }

  /**
   * Compute which enemy tiles are reachable for a Charge action.
   * A charge target is valid if there exists at least one tile adjacent to the enemy that the attacker can reach within run range.
   * Returns a Set of "x,y" strings for enemy tiles that can be charged.
   */
  function computeChargeTargets() {
    const targets = new Set();
    const selId = state.selected_unit_id; if (!selId) return targets;
    const me = [...state.red.units, ...state.blue.units].find(u => u.id === selId); if (!me) return targets;
    const ux = me.position.x, uy = me.position.y;
    const runRange = (me.speed || 1) * 2 + (me.adrenaline ? 1 : 0);//reduced to run range -1 to account for the final attack step

    const tileMode = state.battlefield.tileMode || 'square';

    // Precompute all tiles reachable within run range (same BFS as computeReachable but with run base)



    const runReachable = new Map();
    {
      const pq = [[0, ux, uy]]; const best = new Map(); best.set(tileId(ux,uy),0);
      const seen = new Set();
      while(pq.length){
        pq.sort((a,b)=>a[0]-b[0]);
        const [cost,x,y] = pq.shift(); if(seen.has(tileId(x,y))) continue; seen.add(tileId(x,y));
        for(const [dx,dy] of neighborOffsets(x, tileMode)){
          const nx=x+dx, ny=y+dy;
          if(!isPassableForUnit(me, nx, ny)) continue;

          //next is useless if LOS is required for the charge
          occ=unitAt(nx,ny);
          if(occ && traverseFriendlyUnits && chargeTraverseFriendlyUnits){
            if(occ.team !== me.team ) continue; // can't pass through other friendly units (except self)
          } else{
            if(occ && !(nx===ux && ny===uy)) continue; // can't pass through any units (except self)
          }
          const ncost = cost + moveCost(me,nx,ny,'charge');
          if(ncost > runRange) continue;
          const nid = tileId(nx,ny);
          if(!best.has(nid) || ncost < best.get(nid)){
            best.set(nid, ncost); pq.push([ncost, nx, ny]);
          }
        }
      }
      for(const [k,v] of best){ if(k!==tileId(ux,uy)) runReachable.set(k,v); }
    }

    // For each enemy, check if any adjacent empty tile (or the attacker's own tile) is reachable
    const enemies = state[state.current_player==='red' ? 'blue' : 'red'].units;
    for(const e of enemies){

      if(e.armor > 0 && (!me.weapon.armouredDmg || me.weapon.armouredDmg < 1)) continue; // can't charge armoured enemies if weapon can't damage armour

      const ex=e.position.x, ey=e.position.y;
      if(!isPassableForUnit(me, ex, ey)) continue ;// can't charge into an impassable tile 


      // If already adjacent, charge is valid with no movement
      if(isAdjacent(ux, uy, ex, ey) ){
        targets.add(tileId(ex,ey));
        continue;
      }

      // LOS required for charge, so check that first before pathfinding
      //This also prevents the charge action from being available if friendly units are blocking the path, since LOS would be blocked in that case as well
      if(!losClearAndInRange(ux, uy, ex, ey, 1000)) continue;  
      

      // Otherwise check if any adjacent-to-enemy tile is in runReachable and not occupied by another unit
      for(const [dx,dy] of neighborOffsets(ex, tileMode)){
        const nx=ex+dx, ny=ey+dy; if(!inBounds(nx,ny)) continue;
        if(!isPassableForUnit(me, nx, ny)) continue;
        const occupant = unitAt(nx,ny);
        if(occupant && !(nx===ux && ny===uy)) continue; // occupied by someone else
        if(runReachable.has(tileId(nx,ny)) || (nx===ux && ny===uy)){
          targets.add(tileId(ex,ey));
          break;
        }
      }
    }
    return targets;
  }

  /**
   * Given a target enemy at (tx,ty), find the best adjacent tile the attacker
   * should stop at to perform the melee attack.
   * Returns {x, y} or null.
   */
  function findChargeStopTile(tx, ty) {
    const selId = state.selected_unit_id; if (!selId) return null;
    const me = [...state.red.units, ...state.blue.units].find(u => u.id === selId); if (!me) return null;
    const ux = me.position.x, uy = me.position.y;
    const tileMode = state.battlefield.tileMode || 'square';

    // If already adjacent, stay in place
    if(isAdjacent(ux, uy, tx, ty)){
      return {x: ux, y: uy};
    }

    const runRange = (me.speed || 1) * 2 + (me.adrenaline ? 1 : 0);
    
    let best = null, bestCost = Infinity;


    //set the reference of validChange for the target tile mode


    for(const [dx,dy] of neighborOffsets(tx, tileMode)){ 
      const nx=tx+dx, ny=ty+dy; if(!inBounds(nx,ny)) continue;
      if(!isPassableForUnit(me, nx, ny)) continue;
      const occupant = unitAt(nx,ny);
      if(occupant && !(nx===ux && ny===uy)) continue;
      // BFS/Dijkstra to find cost from (ux,uy) to (nx,ny)  //ll distance
      const pq = [[0, ux, uy]]; const seen2 = new Map(); seen2.set(tileId(ux,uy),0);
      const visited = new Set();
      let found = false;
      while(pq.length){
        pq.sort((a,b)=>a[0]-b[0]);
        const [cost,cx,cy] = pq.shift();
        if(visited.has(tileId(cx,cy))) continue;
        visited.add(tileId(cx,cy));
        if(cx===nx && cy===ny){
          if(cost <= runRange && cost < bestCost){ bestCost=cost; best={x:nx,y:ny}; }
          found=true; break;
        }
        for(const [ddx,ddy] of neighborOffsets(cx, tileMode)){
          const nnx=cx+ddx, nny=cy+ddy; if(!inBounds(nnx,nny)) continue;
          if(!isPassableForUnit(me, nnx, nny)) continue;
          const occ2 = unitAt(nnx,nny);
          if(!traverseFriendlyUnits) {
             if(occ2 && occ2.team !== me.team) continue;
          } else {
             if(occ2 && !(nnx===ux && nny===uy) && !(nnx===nx && nny===ny)) continue;
          }
          const nc=cost+moveCost(me,nnx,nny,'charge');
          if(!seen2.has(tileId(nnx,nny)) || nc<seen2.get(tileId(nnx,nny))){
            seen2.set(tileId(nnx,nny),nc); pq.push([nc,nnx,nny]);
          }
        }
      }
    }
    return best;
  }

  // ── Alternating Activation helpers ───────────────────────────────────────

  /**
   * Returns true when every living unit on both sides has acted this round.
   */
  function allUnitsActed() {
    const all = [...state.red.units, ...state.blue.units];
    return all.length > 0 && all.every(u => actedUnits.has(u.id));
  }

  /**
   * Count living units that haven't yet acted, split by team.
   */
  function remainingCounts() {
    const red  = state.red.units.filter(u  => !actedUnits.has(u.id)).length;
    const blue = state.blue.units.filter(u => !actedUnits.has(u.id)).length;
    return { red, blue };
  }

  /**
   * Randomly pick the next active team, weighted by their remaining unit count.
   * Returns 'red' or 'blue'.
   */
  function pickNextTeam() {
    const { red, blue } = remainingCounts();
    const total = red + blue;
    if (total === 0) return state.current_player; // shouldn't happen
    const roll = Math.floor(Math.random() * total) + 1; // 1..total
    return roll <= red ? 'red' : 'blue';
  }

  /**
   * Mark the currently selected unit as having acted, then switch active player
   * if alt-activation is enabled.  Call this after every completed action.
   */
  async function handleUnitActed() {
    if (state.battlefield.activationMode === 'IGOYGO') return;

    // Record the unit that just acted
    if (state.selected_unit_id) {
      actedUnits.add(state.selected_unit_id);
    }

    if (allUnitsActed()) {
      // All done — render will show an enabled End Turn button
      render();
      return;
    }


    const { red, blue } = remainingCounts();
    const opponent = state.current_player === 'red' ? 'blue' : 'red';
    const opponentHasUnits = (opponent === 'red' ? red : blue) > 0;
    const currentHasUnits = (state.current_player === 'red' ? red : blue) > 0;

    // In Alternate-Check mode the swap after a *success* does not happen immediately — we first check if the opponent has units left to act. If not, the current player
    if (state.battlefield.activationMode === 'Alternate-Check' && currentHasUnits) {
      render();
      return;
    }

    if (opponentHasUnits) {
      const nextTeam = pickNextTeam();
      if (nextTeam !== state.current_player) {
        await api('/swap_turn', { method: 'POST' });
        state = await api('/state');
      }
    }
    // else: only current player still has unacted units — keep their turn

    render();
  }

  /**
   * Inject the Alternating Activation label into the top-actions bar.
   * Called once after the DOM is ready.
   */
  function injectAltActivationToggle() {
    if (document.getElementById('alt-activation-toggle')) return;

    const wrapper = document.createElement('label');
    wrapper.id = 'alt-activation-toggle';
    wrapper.style.cssText = `
      display: inline-flex; align-items: center; gap: 6px;
      font-size: 12px; font-weight: 600; color: #94a3b8;
      cursor: pointer; user-select: none;
      background: #111827; border: 1px solid #334155;
      border-radius: 8px; padding: 6px 12px;
    `;

    if(state.battlefield.combatOptions.contemporaryMelee){
      wrapper.appendChild(document.createTextNode('💥 Contemporary Melee Mode'));
    }
    
    if(state.battlefield.combatOptions.moraleChecks){
      if (state.battlefield.combatOptions.pinMoraleChecksAsFUBAR)
        wrapper.appendChild(document.createTextNode('😰✔️ Pin and Morale FUBAR Mode'));
      else
        wrapper.appendChild(document.createTextNode('😰✔️ Morale Checks'));

    }

    if(state.battlefield.activationMode === 'Alternate-Check'){
        wrapper.appendChild(document.createTextNode('🔀✔️ Alt-Activation (FUBAR Mode)'));
    } 
    if(state.battlefield.activationMode === 'Alternate'){  
        wrapper.appendChild(document.createTextNode('🔀 Alternating Activation'));
    } 
    if(state.battlefield.activationMode === 'IGOYGO'){  
        wrapper.appendChild(document.createTextNode('🔄 IGOUGO Mode'));
    } 
    

    // Insert into the actions-group div
    const grp = document.querySelector('.actions-group');
    if (grp) grp.prepend(wrapper);
  }

  function render(){
    if(!state) return;

    // Keep local acted cache in sync with server state, including reaction shots.
    syncActedUnitsFromState();

    initMinimapBindings();

    const { red: remRed, blue: remBlue } = remainingCounts();
    const totalRemaining = remRed + remBlue;

    if (altActivationEnabled) {
      el.turnInfo.textContent = `Game ${state.id.slice(0,8)} — Turn ${state.turn} — ${state.current_player.toUpperCase()} to act` + `  |  ⚡ Remaining: 🔴 ${remRed}  🔵 ${remBlue}`;
    } else {
      el.turnInfo.textContent = `Game ${state.id.slice(0,8)} - Turn ${state.turn} - ${state.current_player.toUpperCase()} to act`;
    }

    // Actions
    el.actions.innerHTML = '';
    (state.possible_actions || []).forEach(a => {
      const b = document.createElement('button'); b.className = 'action ' + (a.enabled ? 'enabled' : ''); b.textContent = a.label; b.disabled = !a.enabled;
      b.addEventListener('click', async () => {
        pendingAction = a.action; clearHighlights();
        advancePhase = null;   // reset any in-progress Advance
        el.errorMessage.innerHTML = '';

        if(['overwatch','down','rally'].includes(a.action)){
          performAction(a.action);
          pendingAction = null; // these actions don't require a follow-up selection, so clear immediately
        } else if(a.action==='move' || a.action==='run'){
          computeReachable(); showReachable();
        } else if(a.action==='shoot'){
           el.errorMessage.innerHTML ='';
          const targets = computeTargets();
          el.bf.querySelectorAll('.tile').forEach(t=>{ const x=+t.dataset.x, y=+t.dataset.y; if(targets.has(`${x},${y}`)) t.classList.add('targetable'); });
        }else if(a.action==='attack'){
          const selId = state.selected_unit_id; if(!selId) return;
          const u = [...state.red.units, ...state.blue.units].find(x=>x.id===selId); if(!u) return;
          const ux = u.position.x, uy = u.position.y;
          skip=0;
          el.bf.querySelectorAll('.tile').forEach(t=>{ 
            const x=+t.dataset.x, y=+t.dataset.y; 
            un=unitAt(x,y); 
            if(un && un.team !== state.current_player){ 
              const adjacent = isAdjacent(ux, uy, x, y);
              if(un.armor > 0 && (!u.weapon.armouredDmg || u.weapon.armouredDmg < 1)) {
                skip++;
              } else{  
                if(adjacent) t.classList.add('targetable'); 
              }
            } 
          }); 
        } else if(a.action==='charge'){
          // Highlight enemies reachable by charge (within run range + adjacent step)
          const chargeTargets = computeChargeTargets();
          el.bf.querySelectorAll('.tile').forEach(t=>{
            const x=+t.dataset.x, y=+t.dataset.y;
            if(chargeTargets.has(`${x},${y}`)) t.classList.add('targetable');
          });
        } else if(a.action==='advance'){
          // Advance = move then shoot.  Start with the move phase.
          advancePhase = 'move';
          computeReachable();showReachable();
          
          el.errorMessage.innerHTML = '⚡ Advance: select a tile to move to, then you will pick a shoot target.';
        }
      });
      el.actions.appendChild(b);
    });

    // ── End Turn button ───────────────────────────────────────────────────────
    const endBtn = document.createElement('button');
    endBtn.className = 'action';
    endBtn.textContent = 'End Turn';

    if (altActivationEnabled) {
      // In alt-activation mode: only allow End Turn when all units have acted
      const done = allUnitsActed();
      endBtn.disabled = !done;
      endBtn.title = done
        ? 'All units have acted — end the turn'
        : `Waiting for ${totalRemaining} more unit(s) to act`;
      if (done) endBtn.classList.add('enabled');
    }
    if (!altActivationEnabled) endBtn.classList.add('enabled');

    endBtn.addEventListener('click', async () => {
      if (!altActivationEnabled || allUnitsActed()) {
        if(!altActivationEnabled){
          if (state.current_player === 'blue') {
            await endPhase();
          }
        } else {
          await endPhase();
        }
        
        pendingAction = null; clearHighlights();
        actedUnits.clear();   // new round starts
        if (altActivationEnabled) {
          await api('/end_turn_alt', { method: 'POST' });
        } else {
          await api('/end_turn', { method: 'POST' });
        }

        
        // If IGOUGO mode: Units that spent their reaction last turn begin the new turn as acted.
      
        state = await api('/state');
        const reactedUnits = [...state.red.units, ...state.blue.units].filter(u => u.reacted);
        reactedUnits.forEach(u => actedUnits.add(u.id));

        for (const u of reactedUnits) {
          try {
            await api(`/unit/${u.id}/attribute`, {
              method: 'POST',
              body: JSON.stringify({ attribute: 'reacted', value: false })
            });
          } catch (e) {
            console.warn(`Failed to clear reacted for unit ${u.id}:`, e.message);
          }
          if (!altActivationEnabled) {
            try {
              await api(`/unit/${u.id}/attribute`, {
                method: 'POST',
                body: JSON.stringify({ attribute: 'acted', value: true })
              });
            } catch (e) {
              console.warn(`Failed to set acted for unit ${u.id}:`, e.message);
            }
          }

        }
        if (altActivationEnabled) {
          actedUnits.clear();   // new round starts
        }



        await load();
      }
    });
    el.actions.appendChild(endBtn);

    // Units lists

    const mkUnit = (u, side) => {
      const w = u.weapon || { ammo: 0, range: 0 };
      const d = document.createElement('div');
      d.className = 'unit' + (state.selected_unit_id === u.id ? ' selected' : '');
      d.id='aUnit';
      d.setAttribute('uref', u.id);

      // Build a small header row with a mini image + name


      const hdr = document.createElement('div');
      hdr.className = "unit-header";
      
      hdr.style.display = 'flex';
      hdr.style.alignItems = 'flex-start';
      hdr.style.gap = '8px';

      const miniWrap = document.createElement('div');
      miniWrap.className = 'mini';
      const mini = document.createElement('img');

      const sprites = miniForUnit(u);
      mini.src = sprites.statusSprite;

      mini.onerror = () => {
        if (sprites.typeSprite) {
          mini.src = sprites.typeSprite;
          mini.onerror = () => { mini.src = sprites.fallback; };
        } else {
          mini.src = sprites.fallback;
        }
      };

      mini.alt = u.name;
      miniWrap.appendChild(mini);

      const nameBlock = document.createElement('div');
      nameBlock.className = "text-block";

      nameBlock.style.display = 'flex';
      nameBlock.style.flexDirection = 'column';
      nameBlock.style.lineHeight = '1.2';

      nameBlock.innerHTML = unitInfoHtml(u);

      hdr.appendChild(miniWrap);
      hdr.appendChild(nameBlock);

      d.appendChild(hdr);
    
      d.addEventListener('click', async () => {

        // In alt-activation mode, don't allow selecting a unit that already acted
        if (altActivationEnabled && actedUnits.has(u.id)) return;
        await api('/select_unit', { method: 'POST', body: JSON.stringify({ unit_id: u.id }) });
        await load();
      });
      

      return d;
    };




    // refresh when possible 
    if(listDone){ 
      el.redUnits.querySelectorAll('[uref]').forEach(t=>{
        t.className= 'unit' + (state.selected_unit_id === t.getAttribute('uref') ? ' selected' : '');

        u=state.red.units.find(z=>z.id===t.getAttribute('uref')); 
        if(u){
          t.querySelector('.text-block').innerHTML = unitInfoHtml(u);
        } else t.remove();
      }); 

      el.blueUnits.querySelectorAll('[uref]').forEach(t=>{
        t.className= 'unit' + (state.selected_unit_id === t.getAttribute('uref') ? ' selected' : '');

        u=state.blue.units.find(z=>z.id===t.getAttribute('uref')); 
        if(u){
          t.querySelector('.text-block').innerHTML = unitInfoHtml(u);
        } else t.remove();
      }); 

    } else { 
      el.redUnits.innerHTML=''; el.blueUnits.innerHTML='';
      state.red.units.forEach(u => el.redUnits.appendChild(mkUnit(u,'red')));
      state.blue.units.forEach(u => el.blueUnits.appendChild(mkUnit(u,'blue')));
      listDone=true;
    }

    // Cards
    const mkCard = (c, side) => { const d=document.createElement('div'); d.className='card'; d.innerHTML=`<h5>${c.name}</h5><div class="meta">${c.description}</div>`;
    const b=document.createElement('button'); b.textContent='Play'; b.disabled=state.current_player!==side || state.turn_state.card_played;
    b.addEventListener('click', async ()=>{ if(['unit','enemy_adjacent','enemy_visible'].includes(c.target) && !state.selected_unit_id){ alert('Select a unit first.'); return; }
      
    // 🔊 Play sound immediately (good UX)
    playCardSound(c.id);

    await api('/play_card',{method:'POST', body: JSON.stringify({card_id: c.id})}); await load(); }); d.appendChild(b); return d; };
    el.redCards.innerHTML=''; el.blueCards.innerHTML='';
    state.red.hand_cards.forEach(c => el.redCards.appendChild(mkCard(c,'red')));
    state.blue.hand_cards.forEach(c => el.blueCards.appendChild(mkCard(c,'blue')));

    // Highlight current player panel
    const redPanel = document.querySelector('.side-panel.red');
    const bluePanel = document.querySelector('.side-panel.blue');
    if (state.current_player === 'red') {
      redPanel?.classList.add('active');
      bluePanel?.classList.remove('active');
    } else {
      bluePanel?.classList.add('active');
      redPanel?.classList.remove('active');
    }

    if(totalRemaining === 0){
      redPanel?.classList.remove('active');
      bluePanel?.classList.remove('active');
    }

    // Show current weather in legend
    const weatherEl = document.getElementById('weather-status');
    if (weatherEl) {
      weatherEl.textContent = state.turn_state?.weather || 'Unknown';
    }
    // Show current unit stacking in legend
    const unitStackingEl = document.getElementById('unit-stacking-status');
    if (unitStackingEl) {
      unitStackingEl.textContent =stackingEnabled ? 'Enabled' : 'Disabled';
    }

    // Show current traverse friendly units in legend
    const traverseFriendlyUnitsEl = document.getElementById('traverse-friendly-units-status');
    if (traverseFriendlyUnitsEl) {
      traverseFriendlyUnitsEl.textContent = traverseFriendlyUnits ? 'Enabled' : 'Disabled';
    }
    // Show current combat resolution method in legend
    const combatResolutionEl = document.getElementById('combat-resolution-status');
    if (combatResolutionEl) {
      combatResolutionEl.textContent = resolutionMethod || 'Unknown';
    }
    // Show current saving throws method in legend
    const savingThrowsEl = document.getElementById('saving-throws-status');
    if (savingThrowsEl) {
      savingThrowsEl.textContent = savingThrowsMethod || 'Unknown';
    }
    // Battlefield

    //LL cache
    if (!battlefieldInitialized) {
      initBattlefield();
    }
    updateUnitsOnBattlefield();
    clearHighlights();
    drawMinimap();
    updateMinimapViewportBox();

    

    el.log.innerHTML=''; 
    cnt=0;
    state.log.slice(-50).toReversed().forEach(entry=>{ 
      const d=document.createElement('div'); 
      d.className='log-entry'; 
      d.textContent=entry; 

      // 🔥 Detect unit death
      if (cnt == 0 && entry.includes("is eliminated")){
      if (entry.includes("heavy is eliminated")) {
          SFX['explode'].currentTime = 0;
          SFX['explode'].play().catch(()=>{});
      }else {
          SFX['death'].currentTime = 0;
          SFX['death'].play().catch(()=>{});
      }
      }
      cnt++;

      el.log.appendChild(d); 
    });
  }

  async function onTileClick(x,y){ 
    if(!state) return; 
    if(['move','run','attack','shoot','charge','advance'].includes(pendingAction)){ 
      try{ 

        if(pendingAction==='attack'  || pendingAction==='shoot' ){
          // Before or after the API call — your choice
          const clickedTile = el.bf.querySelector(`.tile[data-x="${x}"][data-y="${y}"]`);
          if(clickedTile){
              if( clickedTile.classList.contains('targetable')) {

                if (!(await ensureAlternateCheckAllowsAction())) {
                  return;
                }

                let diceRequest="Att:D6 + Att:D6 + Bonus:D4 + Def:D6 + Def:D6 ";
            
                if(pendingAction==='shoot' && resolutionMethod === 'experience_stats' ){
                  selectedUnit = [...state.red.units, ...state.blue.units].find(u => u.id === state.selected_unit_id);
                  if(selectedUnit){
                    const shot = selectedUnit['n_of_figures'] * selectedUnit['n_of_attacks']  ; //count total number of shots for the unit
                    diceRequest = "";
                    for(let i=0; i<shot; i++){
                      diceRequest += "Att:D6 + ";
                    }
                    diceRequest += "Bonus:D4 + Def:D6 + Def:D6 ";
                  }

                }

                // Offer the target unit a Down reaction (only for shoot, not melee attack)
                t=unitAt(x, y);
                if (t && t.acted === false) {
                  if (pendingAction === 'shoot') {
                    await offerDownReaction(x, y);
                  }
                }

                const result = await DiceRoller.roll(diceRequest);
                await api('/action',{method:'POST', body: JSON.stringify({action: pendingAction, target: {x,y}, dices: result,melee_resolution: contemporaryMelee})}); 
                pendingAction=null;
                state = await api('/state');
                await handleUnitActed();
              } else{
                pendingAction=null;
              }
          }
        } else if(pendingAction==='charge'){
          const clickedTile = el.bf.querySelector(`.tile[data-x="${x}"][data-y="${y}"]`);
          if(clickedTile && clickedTile.classList.contains('targetable')) {
            if (!(await ensureAlternateCheckAllowsAction())) {
              return;
            }
            // Find the best adjacent tile the attacker can reach to strike from
            const pathTarget = findChargeStopTile(x, y);
            if(!pathTarget) { alert('Cannot reach empty nearby tile to charge this enemy.'); return; }
            const result = await DiceRoller.roll("Att:D6 + Att:D6 + Bonus:D4 + Def:D6 + Def:D6 ");
            await api('/action', {method:'POST', body: JSON.stringify({action:'charge', target:{x,y}, path_target: pathTarget, dices: result,melee_resolution: contemporaryMelee})});
            pendingAction=null;
            state = await api('/state');
            await handleUnitActed();
            updateUnitsOnBattlefield();
          }
          if(clickedTile && !clickedTile.classList.contains('targetable')) {
            pendingAction=null;
          }

        } else if(pendingAction==='advance'){
          // ── Advance: Phase 1 — pick a move destination ──────────────────────
          if(advancePhase === 'move'){
            const clickedTile = el.bf.querySelector(`.tile[data-x="${x}"][data-y="${y}"]`);
            if(clickedTile){
               if(clickedTile.classList.contains('reachable')){
                if(!(await ensureAlternateCheckAllowsAction())) return;

                // Execute the move with the server
                await api('/action',{method:'POST', body: JSON.stringify({action:'move', target:{x,y}, tile: `${clickedTile.className}`})});
                state = await api('/state');
                // Phase 2 — now pick a shoot target from the new position
                advancePhase = 'shoot';
                clearHighlights();
                el.errorMessage.innerHTML = '⚡ Advance: now select a shoot target (or click empty cell to cancel shoot).';
                const targets = computeTargets(x, y);//LL todo
                if(targets.size === 0){
                  // No targets visible after moving — action ends without shooting
                  el.errorMessage.innerHTML = '⚡ Advance: moved, but no targets in range.';
                  advancePhase = null;
                  pendingAction = null;
                  await handleUnitActed();
                  if(!altActivationEnabled) await load();
                } else {
                  el.bf.querySelectorAll('.tile').forEach(t=>{
                    const tx=+t.dataset.x, ty=+t.dataset.y;
                    if(targets.has(`${tx},${ty}`)) t.classList.add('targetable');
                  });
                }
              } else {
                pendingAction=null;
                advancePhase = null;
              }
            }
          // ── Advance: Phase 2 — pick a shoot target ───────────────────────────
          } else if(advancePhase === 'shoot'){
            const clickedTile = el.bf.querySelector(`.tile[data-x="${x}"][data-y="${y}"]`);
            if(clickedTile){
              if(clickedTile.classList.contains('targetable')){ 
                
                t=unitAt(x, y);
                if (t && t.acted === false) {
                  await offerDownReaction(x, y);
                  
                } 

                el.errorMessage.innerHTML = '';
                const result = await DiceRoller.roll("Att:D6 + Att:D6 + Bonus:D4 + Def:D6 + Def:D6 ");
                await api('/action',{method:'POST', body: JSON.stringify({action:'shoot', target:{x,y}, dices: result,combat_resolution: resolutionMethod,mode: 'advance'})});
                advancePhase = null;
                pendingAction = null;
                state = await api('/state');
                await handleUnitActed();
              } else {
                advancePhase = null;
                pendingAction = null;
              }
            }
          }
        } else{
          if(pendingAction==='move'  || pendingAction==='run' ){
              const clickedTile = el.bf.querySelector(`.tile[data-x="${x}"][data-y="${y}"]`); 
              if(clickedTile){

                if(clickedTile.classList.contains('reachable')) {    

                  if (!(await ensureAlternateCheckAllowsAction())) {
                    return;
                  }

                  await api('/action',{method:'POST', body: JSON.stringify({action: pendingAction, target: {x,y}, tile: `${clickedTile.className}`})});
                  pendingAction=null;
                  state = await api('/state');
                  await handleUnitActed();
                  
                }else{
                    pendingAction=null;
                }
              }
            } else {
              await api('/action',{method:'POST', body: JSON.stringify({action: pendingAction, target: {x,y}})});
              pendingAction=null;
              state = await api('/state');

              await handleUnitActed();
            }
        }
        clearHighlights();
        if (!altActivationEnabled) await load();
      }catch(e){ 
        alert(e.message);
        advancePhase = null;
        pendingAction = null;
      } return; 
    }


  }

/**
 * Show a Yes / No prompt for the target unit's Down reaction after being shot at.
 * Returns a Promise that resolves with true (go down) or false (stay up).
 */
function showReactionPrompt(targetUnit) {
  return new Promise(resolve => {
    // Re-use the phase-popup overlay but swap the footer buttons
    const overlay  = document.getElementById('phase-popup-overlay');
    const titleEl  = document.getElementById('phase-popup-title');
    const iconEl   = document.getElementById('phase-popup-icon');
    const bodyEl   = document.getElementById('phase-popup-body');
    const closeBtn = document.getElementById('phase-popup-close');

    iconEl.textContent  = '🎯';
    titleEl.textContent = `Reaction — ${targetUnit.name}`;

    bodyEl.innerHTML = `
      <div class="phase-row phase-row--highlight">
        <span class="phase-row-icon">⬇️</span>
        <span class="phase-row-label">Go Down?</span>
        <span class="phase-row-value">${targetUnit.name} can take cover (Down status) as a reaction to being shot at.</span>
      </div>
      <div class="phase-row">
        <span class="phase-row-icon">ℹ️</span>
        <span class="phase-row-label">Effect</span>
        <span class="phase-row-value">Unit goes Down — gains defensive bonus but uses its activation this turn.</span>
      </div>
    `;

    // Replace the single Continue button with Yes / No
    closeBtn.style.display = 'none';
    const footer = closeBtn.parentElement;

    const yesBtn = document.createElement('button');
    yesBtn.className = 'phase-close-btn';
    yesBtn.textContent = '⬇️ Go Down';
    yesBtn.style.background = '#16a34a';

    const noBtn = document.createElement('button');
    noBtn.className = 'phase-close-btn';
    noBtn.textContent = '🚫 Stay Up';
    noBtn.style.background = '#dc2626';
    noBtn.style.marginLeft = '10px';

    footer.appendChild(yesBtn);
    footer.appendChild(noBtn);
    overlay.classList.add('open');
    requestAnimationFrame(() => yesBtn.focus());

    const done = (choice) => {
      overlay.classList.remove('open');
      closeBtn.style.display = '';
      yesBtn.remove();
      noBtn.remove();
      document.removeEventListener('keydown', onKey);
      resolve(choice);
    };

    const onKey = e => {
      if (e.key === 'Enter' || e.key === 'y') done(true);
      if (e.key === 'Escape' || e.key === 'n') done(false);
    };

    yesBtn.addEventListener('click', () => done(true));
    noBtn.addEventListener('click',  () => done(false));
    document.addEventListener('keydown', onKey);
  });
}

/**
 * After a shoot action, offer the target unit a Down reaction.
 * If accepted: sets status=down and reacted=true on the server,
 * and marks the unit as already acted in the local actedUnits set.
 */
async function offerDownReaction(targetX, targetY) {
  const allUnits = [...state.red.units, ...state.blue.units];
  const targetUnit = allUnits.find(u => u.position.x === targetX && u.position.y === targetY);
  if (!targetUnit) return;                          // unit might have been eliminated
  if (targetUnit.team === state.current_player) return;  // friendly fire — no reaction
  if (targetUnit.status === 'down') return;         // already down

  const goDown = await showReactionPrompt(targetUnit);
  if (!goDown) return;

  // Apply Down status and mark the unit as having reacted
  try {
    await api(`/unit/${targetUnit.id}/attribute`, {
      method: 'POST',
      body: JSON.stringify({ attribute: 'status', value: 'down' })
    });
    await api(`/unit/${targetUnit.id}/attribute`, {
      method: 'POST',
      body: JSON.stringify({ attribute: 'reacted', value: true })
    });
    // Pre-mark as acted locally so it shows the ⛔ badge immediately
    actedUnits.add(targetUnit.id);
    state = await api('/state');
    render();
  } catch (e) {
    console.warn('Down reaction failed:', e.message);
  }
}



function injectPhasePopupDOM() {
  if (document.getElementById('phase-popup-overlay')) return;
  document.body.insertAdjacentHTML('beforeend', `
    <div id="phase-popup-overlay" class="phase-overlay" aria-modal="true" role="dialog" aria-labelledby="phase-popup-title">
      <div class="phase-popup">
        <div class="phase-popup-header">
          <span id="phase-popup-icon" class="phase-icon"></span>
          <h2 id="phase-popup-title"></h2>
        </div>
        <div id="phase-popup-body" class="phase-popup-body"></div>
        <div class="phase-popup-footer">
          <button id="phase-popup-close" class="phase-close-btn" autofocus>Continue ▶</button>
        </div>
      </div>
    </div>
  `);
}



// showPhasePopup displays a modal overlay with information about the current phase, weather, and other details. 
//
//  phaseName  – string title shown in the header
//  sections   – array of section objects, each with:
//               { icon, label, value, highlight }   (all optional except value)
//             OR a plain string (rendered as a paragraph)
//  opts       – optional { icon }  header icon override (emoji / text)
//
//  Returns a Promise that resolves when the user clicks Continue.
//
//  Quick-call compat: showPhasePopup('Begin Phase', 'Simple string message') still works.

function showPhasePopup(phaseName, sections, opts = {}) {
  return new Promise(resolve => {
    const overlay = document.getElementById('phase-popup-overlay');
    const titleEl = document.getElementById('phase-popup-title');
    const iconEl  = document.getElementById('phase-popup-icon');
    const bodyEl  = document.getElementById('phase-popup-body');
    const closeBtn= document.getElementById('phase-popup-close');
    
    // Phase → default icon map
    const PHASE_ICONS = {
      'Begin Phase': '🌅',
      'End Phase':   '🌇',
    };
    iconEl.textContent  = opts.icon || PHASE_ICONS[phaseName] || '⚔️';
    titleEl.textContent = phaseName;

    // Normalise sections arg – accept string for backward compat
    const items = !sections
      ? []
      : typeof sections === 'string'
        ? [sections]
        : Array.isArray(sections)
          ? sections
          : [sections];

    bodyEl.innerHTML = '';
    items.forEach(item => {
      if (typeof item === 'string') {
        const p = document.createElement('p');
        p.className = 'phase-msg';
        p.textContent = item;
        bodyEl.appendChild(p);
      } else {
        // Structured row: { icon, label, value, highlight }
        const row = document.createElement('div');
        row.className = 'phase-row' + (item.highlight ? ' phase-row--highlight' : '');
        row.innerHTML = `
          ${item.icon ? `<span class="phase-row-icon">${item.icon}</span>` : ''}
          <span class="phase-row-label">${item.label || ''}</span>
          <span class="phase-row-value">${item.value ?? ''}</span>
        `;
        bodyEl.appendChild(row);
      }
    });

    overlay.classList.add('open');
    // Ensure keyboard users can confirm immediately.
    requestAnimationFrame(() => closeBtn.focus());

    const done = () => {
      overlay.classList.remove('open');
      closeBtn.removeEventListener('click', done);
      overlay.removeEventListener('click', onOverlayClick);
      document.removeEventListener('keydown', onKey);
      resolve();
    };
    const onOverlayClick = e => { if (e.target === overlay) done(); };
    const onKey = e => { if (e.key === 'Enter' || e.key === 'Escape') done(); };

    closeBtn.addEventListener('click', done);
    overlay.addEventListener('click', onOverlayClick);
    document.addEventListener('keydown', onKey);
     
  });
}




async function beginPhase() {
  const r = await api('/begin_phase_start', { method: 'POST' });
  const weather = r.weather || 'unknown';

  const WEATHER_META = {
    sunny:  { icon: '☀️',  effect: 'No penalties.' },
    raining:{ icon: '🌧️', effect: '-10% accuracy for all ranged attacks.' },
    cloudy: { icon: '☁️',  effect: 'No penalties.' },
    stormy: { icon: '⛈️', effect: '-15% accuracy, movement cost +1.' },
    foggy:  { icon: '🌫️', effect: 'Max shoot range −2.' },
    windy:  { icon: '💨',  effect: 'Grenade range −1.' },
  };
  const wm = WEATHER_META[weather] || { icon: '🌡️', effect: 'Unknown conditions.' };

  await showPhasePopup('Begin Phase', [
    { icon: wm.icon, label: 'Weather',    value: weather.charAt(0).toUpperCase() + weather.slice(1), highlight: true },
    { icon: '⚠️',   label: 'Effect',     value: wm.effect },
    { icon: '🃏',   label: 'Draw phase', value: 'Each player draws up to 2 cards.' },
  ]);

  await api('/begin_phase_complete', { method: 'POST' });
}

async function endPhase() {
  await showPhasePopup('End Phase', [
    { icon: '🔄', label: 'Overwatch units', value: 'Will become ready for reactions.' },
    { icon: '🛡️', label: 'Shields',        value: 'All shields reset to 0.' },
    { icon: '🎯', label: 'Recoil',         value: 'All recoil penalties cleared.' },
  ]);
}


  async function performAction(action){
    try{
      await api('/action',{method:'POST', body: JSON.stringify({action})});
      state = await api('/state');
      await handleUnitActed();
      if (!altActivationEnabled) await load();
    }catch(e){ alert(e.message); }
  }

  async function load(){
    state = await api('/state');
    injectAltActivationToggle();
    injectTileZoomControl();


    if(!state.turn_state.begin_phase_executed){
      await beginPhase();
      await api('/mark_begin_phase_executed',{method:'POST'});
      state = await api('/state');
    }

    //restore acted units at the start of the battle

    syncActedUnitsFromState();
    altActivationEnabled = (state.battlefield.activationMode === 'Alternate' || state.battlefield.activationMode === 'Alternate-Check') ;
    
    // Apply combat options saved by the editor (fall back to safe defaults)
    const co = state.battlefield.combatOptions || {};
    stackingEnabled             = co.stacking              ?? true;
    traverseFriendlyUnits       = co.traverseFriendlyUnits ?? true;
    chargeTraverseFriendlyUnits = co.chargeTraverseFriendlyUnits ?? true;
    enterEnemyTile              = co.enterEnemyTile ?? false;

    resolutionMethod            = co.resolutionMethod || 'weapon_stat';
    savingThrowsMethod            = co.savingThrowsMethod || 'no_saving';
    moraleChecks                 = co.moraleChecks ?? false;
    pinMoraleChecksAsFUBAR        = co.pinMoraleChecksAsFUBAR ?? false;
    contemporaryMelee              = co.contemporaryMelee ?? false;


    // Future options (e.g. co.resolutionMethod, co.friendlyFire, co.moraleChecks)
    // are available here for any battle logic that consumes them.
    render();
  }

  injectPhasePopupDOM();


  load();
})();