(async function(){

  const TILE_SIZE = 84;           // rendered tile dimensions — change this one value to rescale


  const root = document.getElementById('editor-root');
  if(!root) return;
  const typeId = root.dataset.typeId;
  const mapEl = document.getElementById('map');
  const wInput = document.getElementById('w');
  const hInput = document.getElementById('h');
  const hexInput = document.getElementById('useHex');
  const actInput = document.getElementById('useAltActivation');
  const actCheckInput = document.getElementById('useActivationCheck');
  const modeTerrainBtn = document.getElementById('mode-terrain');
  const modeUnitsBtn = document.getElementById('mode-units');
  const terrainSidePanel = document.getElementById('terrain-tools');
  const unitTools = document.getElementById('unit-tools');
  const eraseBtn = document.getElementById('erase');
  const unitListEl = document.getElementById('unit-list');
  const clearUnitsBtn = document.getElementById('clear-units');

  // ── Eras ─────────────────────────────────────────────────────────────────────

  const ERAS = [
    { id: 'medieval',   name: '⚔️ Medieval' },
    { id: 'napoleonic', name: '🎩 Napoleonic' },
    { id: 'ww2',        name: '🪖 WW2' },
    { id: 'modern',     name: '🔫 Modern' },
    { id: 'nato',       name: '🪖 NATO' },
  ];


  let currentEra = 'modern';

  // Weapon palette — all weapons loaded at startup; WEAPON_PALETTE holds the
  // era-filtered subset used in unit rows.  ALL_WEAPONS holds the full list.

  let WEAPON_PALETTE = [];

  async function loadWeaponsForEra(eraId) {
    try {
      const res = await fetch(`/static/data/${eraId}-weapons.json`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      WEAPON_PALETTE = await res.json();
    } catch (err) {
      console.error(`Failed to load ${eraId}-weapons.json`, err);
      WEAPON_PALETTE = [];
    }
  }



  async function applyEra(eraId) {
    currentEra = eraId;
    await loadWeaponsForEra(eraId);
    await loadUnitTypesForEra(eraId);
    // Refresh unit list so weapon selects update
    renderUnitList();
    renderSelectedUnitDetail();
  }

  function populateEraSelect() {
    const eraSelect = document.getElementById('era-select');
    if (!eraSelect) return;
    eraSelect.innerHTML = '';
    ERAS.forEach(era => {
      const opt = document.createElement('option');
      opt.value = era.id;
      opt.textContent = era.name;
      eraSelect.appendChild(opt);
    });
    eraSelect.value = currentEra;

    eraSelect.addEventListener('change', async () => {
      await applyEra(eraSelect.value);
      render();
    });

  }



  // Unit types — loaded per-era from /static/data/unit-types-{era}.json,
  // exactly like WEAPON_PALETTE.  Each entry: { id, name, icon }
  let UNIT_TYPES = [];
 
  async function loadUnitTypesForEra(eraId) {
    try {
      const res = await fetch(`/static/data/${eraId}-unit-types.json`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      UNIT_TYPES = await res.json();
    } catch (err) {
      console.error(`Failed to load ${eraId}-unit-types.json`, err);
      UNIT_TYPES = [];
    }
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
  function terrainImgSrc(type) { return TERRAIN_SPRITES[type] || TERRAIN_SPRITES['open']; }

  let terrain = [];
  let width = 10, height = 10;
  let brush = 'open';
  let eraser = false;
  let mode = 'terrain';
  let unitTeam = 'red';
  let units = {red:[], blue:[]};
  let selectedUnit = null; // {team, idx}
  let draggedUnit  = null; // {team, idx} — set during drag-and-drop

  let tileMode = 'square'; // default
  let activationMode = 'IGOYGO'; // default

  // ── Combat Options (persisted alongside the type template) ────────────────
  // All keys here become part of state.battlefield in battle.js.
  // Add new fields here + a matching input in the Combat Rules panel.
  const COMBAT_OPTIONS_DEFAULTS = {
    traverseFriendlyUnits: true,
    stacking:              true,
    resolutionMethod:      'weapon_stats',  // or 'standard'
    savingThrowsMethod:    'no_saving',
    friendlyFire:          false,
    contemporaryMelee:     false, 
    terrainCoverBonus:     true,
    moraleChecks:          false,
    pinMoraleChecksAsFUBAR: false,
    routThreshold:         25,
  };
  let combatOptions = { ...COMBAT_OPTIONS_DEFAULTS };

  // UI state helpers
  function setActive(elList, predicate){ elList.forEach(el=> el.classList.toggle('active', predicate(el))); }

  // ── Terrain side-panel: build brush buttons from TERRAIN_SPRITES ──────────
  const terrainBrushListEl = document.getElementById('terrain-brush-list');

  // Pretty label: split on camelCase / underscores, capitalise first word
  function terrainLabel(id) {
    return id.replace(/([a-z])([A-Z])/g, '$1 $2')
             .replace(/_/g, ' ')
             .replace(/\b\w/g, c => c.toUpperCase());
  }

  const terrainBrushBtns = Object.entries(TERRAIN_SPRITES).map(([type, src]) => {
    const btn = document.createElement('button');
    btn.className = 'terrain-brush-btn' + (type === 'open' ? ' active' : '');
    btn.dataset.type = type;

    const preview = document.createElement('div');
    preview.className = 'terrain-preview';

    const img = document.createElement('img');
    img.src = src;
    img.alt = type;
    img.onerror = () => { img.style.display = 'none'; };

    const fallback = document.createElement('span');
    fallback.className = `terrain-preview-fallback t-${type}`;

    preview.appendChild(img);
    preview.appendChild(fallback);

    const label = document.createElement('span');
    label.className = 'terrain-brush-label';
    label.textContent = terrainLabel(type);

    btn.appendChild(preview);
    btn.appendChild(label);

    btn.addEventListener('click', () => {
      brush = type;
      eraser = false;
      setActive(terrainBrushBtns, b => b === btn);
      eraseBtn.classList.remove('active');
    });

    terrainBrushListEl.appendChild(btn);
    return btn;
  });

  eraseBtn.addEventListener('click', () => {
    eraser = true;
    setActive([...terrainBrushBtns], () => false);
    eraseBtn.classList.add('active');
  });

  document.querySelectorAll('.team').forEach(btn=>{
    btn.addEventListener('click',()=>{ unitTeam = btn.dataset.team; setActive([...document.querySelectorAll('.team')], b=>b===btn); });
  });

  modeTerrainBtn.addEventListener('click',()=>{
    mode='terrain';
    terrainSidePanel.style.display='flex';
    unitTools.style.display='none';
    setActive([modeTerrainBtn, modeUnitsBtn], b=>b===modeTerrainBtn);
  });
  modeUnitsBtn.addEventListener('click',()=>{
    mode='units';
    terrainSidePanel.style.display='none';
    unitTools.style.display='inline-flex';
    setActive([modeTerrainBtn, modeUnitsBtn], b=>b===modeUnitsBtn);
  });

  clearUnitsBtn.addEventListener('click',()=>{ units={red:[],blue:[]}; selectedUnit=null; render(); });

  async function apiTerrain(method, payload){
    const res = await fetch(`/api/type/${typeId}/terrain`, {method, headers:{'Content-Type':'application/json'}, body: payload?JSON.stringify(payload):undefined});
    if(!res.ok){ throw new Error(await res.text()); }
    return res.json();
  }

  async function load(){
    // Check if we're editing an existing scenario (e.g. ?scenario=<id>)
    const urlParams = new URLSearchParams(window.location.search);
    const scenarioId = urlParams.get('scenario');

    let tpl;
    if (scenarioId) {
      const res = await fetch(`/api/type/${typeId}/scenario/${scenarioId}`);
      if (!res.ok) {
        console.warn('Could not load scenario, falling back to type template');
        tpl = await (await fetch(`/api/type/${typeId}/terrain`)).json();
      } else {
        const data = await res.json();
        tpl = data.template;
        // Expose to saveScenario() in the page
        window.editingScenarioId = data.scenario_id;
        window.editingScenarioName = data.name;
      }
    } else {
      tpl = await apiTerrain('GET');
    }

    width = tpl.width || 10; height = tpl.height || 10; tileMode = tpl.tileMode ?? 'square'; activationMode = tpl.activationMode ?? 'IGOYGO'; terrain = tpl.terrain || [];
    units = (tpl.units || {red:[],blue:[]});
    wInput.value = width; hInput.value = height;
    if(tileMode == "square"){hexInput.checked = false;} else {hexInput.checked = true;}
    if(activationMode === "IGOYGO"){ 
      actInput.checked = false;
      actCheckInput.checked = false;
    } else {
      actInput.checked = true;
      actCheckInput.checked = activationMode === "Alternate-Check";
    }
    // Restore era (and rebuild weapon palette) before first render.
    if (tpl.era && ERAS.find(e => e.id === tpl.era)) {
      currentEra = tpl.era;
      const eraSelect = document.getElementById('era-select');
      if (eraSelect) eraSelect.value = currentEra;
    }
    // Restore combat options
    if (tpl.combatOptions) {
      combatOptions = { ...COMBAT_OPTIONS_DEFAULTS, ...tpl.combatOptions };
    }
    applyCombatOptionsToUI();
    applyEra(currentEra);

    render();
  }

  // ── Unit sprite resolution (mirrors battle.js) ───────────────────────────
  function spriteForUnit(u) {
    const era  = currentEra || 'modern';
    const base = `/static/img/units/${era}`;
    const team = (u.team === 'red') ? 'red' : 'blue';
    const type = u.type || 'soldier';
    return {
      typeSprite: `${base}/${team}_${type}.png`,
      fallback:   `${base}/${team}_soldier.png`,
    };
  }

  function terrainAt(x,y){ for(const t of terrain){ if(t.x===x && t.y===y) return t.type; } return 'open'; }
  function setTerrain(x,y,type){ 
    const idx = terrain.findIndex(t=>t.x===x && t.y===y); 
    if(type==='open'){ 
      if(idx>=0) terrain.splice(idx,1); 
    } else { 
      if(idx>=0) terrain[idx].type=type; else terrain.push({x,y,type}); 
    } 
  }

  function unitAt(x,y){
    const r = units.red.findIndex(u=>u.x===x&&u.y===y);
    if(r>=0) return {team:'red', idx:r};
    const b = units.blue.findIndex(u=>u.x===x&&u.y===y);
    if(b>=0) return {team:'blue', idx:b};
    return null;
  }

  function toggleUnit(x,y){
    if(['wall','rocks'].includes(terrainAt(x,y))) return; // no units on walls or rocks
    const existing = unitAt(x,y);
    if(existing){ // remove existing
      units[existing.team].splice(existing.idx,1);
      if(selectedUnit && selectedUnit.team===existing.team && selectedUnit.idx===existing.idx) selectedUnit = null;
      return;
    } else {
      // place new
      units[unitTeam].push({x,y});
    }
  }

  function ensureWeaponObject(u){
    if(u.weapon && u.weapon.name) return u.weapon;
    // default to rifle
    const rifle = WEAPON_PALETTE.find(w=>w.id==='rifle');
    return {...rifle};
  }

  function renderSelectedUnitDetail() {
    const detailEl = document.getElementById('selected-unit-detail');
    if (!detailEl) return;
    detailEl.innerHTML = '';

    if (!selectedUnit) {
      const ph = document.createElement('div');
      ph.className = 'unit-detail-placeholder';
      ph.textContent = 'Click a unit on the map or in the list below to edit it.';
      detailEl.appendChild(ph);
      return;
    }

    const { team, idx } = selectedUnit;
    const u = units[team][idx];
    if (!u) { selectedUnit = null; renderSelectedUnitDetail(); return; }

    // ── Header: sprite + team label + position ───────────────────────────
    const hdr = document.createElement('div');
    hdr.className = 'unit-detail-header';

    const miniImg = document.createElement('img');
    miniImg.className = 'unit-detail-mini';
    const spr = spriteForUnit({ ...u, team });
    miniImg.src = spr.typeSprite;
    miniImg.onerror = () => { miniImg.src = spr.fallback; };

    const titleBlock = document.createElement('div');
    const teamLbl = document.createElement('div');
    teamLbl.className = `unit-detail-team unit-detail-team--${team}`;
    teamLbl.textContent = `${team.toUpperCase()} · Unit #${idx + 1}`;
    const posLbl = document.createElement('div');
    posLbl.className = 'unit-detail-pos';
    posLbl.textContent = `Position (${u.x ?? '?'}, ${u.y ?? '?'})`;
    titleBlock.appendChild(teamLbl);
    titleBlock.appendChild(posLbl);
    hdr.appendChild(miniImg);
    hdr.appendChild(titleBlock);
    detailEl.appendChild(hdr);

    // ── Form ────────────────────────────────────────────────────────────
    const form = document.createElement('div');
    form.className = 'unit-detail-form';

    function fieldRow(label, inputEl, infoOnly = false) {
      const row = document.createElement('div');
      row.className = 'unit-detail-field';
      const lbl = document.createElement('label');
      lbl.className = 'unit-detail-label';
      lbl.textContent = label;
      if (infoOnly) {
        lbl.classList.add('info-only');
      }
      row.appendChild(lbl);
      row.appendChild(inputEl);
      return row;
    }

    const autoFields = {};

    // Name
    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.className = 'unit-detail-input';
    nameInput.placeholder = team === 'red' ? `Red#${idx+1}` : `Blue#${idx+1}`;
    nameInput.value = u.name || '';
    nameInput.addEventListener('input', () => {
      u.name = nameInput.value.trim();
      renderUnitList(); // refresh compact list name
    });
    form.appendChild(fieldRow('Name', nameInput));

    // Type
    const typeSel = document.createElement('select');
    typeSel.className = 'unit-detail-input';
    UNIT_TYPES.forEach(t => {
      const opt = document.createElement('option');
      opt.value = t.id; opt.textContent = t.name;
      typeSel.appendChild(opt);
    });
    typeSel.value = u.type || 'soldier';
    typeSel.addEventListener('change', () => {
      u.type = typeSel.value;
      const typeDef = UNIT_TYPES.find(t => t.id === typeSel.value);
      if (typeDef) {

        invalidActionsInput.value =''; // reset these fields since they may be auto-populated from the previous type
        impassableInput.value ='';
        u.invalidActions = [];
        u.impassable = [];
        Object.entries(typeDef).forEach(([key, val]) => {
          if (key === 'id' || key === 'name') return;
          u[key] = val;
          if (autoFields[key]) {
            if (autoFields[key].lookup) {
              const match = WEAPON_PALETTE.find(item => item.name === val || item.id === val);
              if (match) { autoFields[key].input.value = match.id; u[key] = { ...match }; }
            } else {
              autoFields[key].input.value = val;
            }
          }
        });
      }
      // refresh sprite
      const spr2 = spriteForUnit({ ...u, team });
      miniImg.src = spr2.typeSprite;
      miniImg.onerror = () => { miniImg.src = spr2.fallback; };
      render();
    });
    form.appendChild(fieldRow('Type', typeSel));

    // Weapon
    const weapSel = document.createElement('select');
    weapSel.className = 'unit-detail-input';
    WEAPON_PALETTE.forEach(w => {
      const opt = document.createElement('option');
      opt.value = w.id;
      opt.textContent = `${w.name} (R${w.range}/A${Math.round(w.accuracy*100)}%/D${w.damage})`;
      weapSel.appendChild(opt);
    });
    let curWepId = 'rifle';
    if (u.weapon && u.weapon.name) { const m = WEAPON_PALETTE.find(w => w.name === u.weapon.name); if (m) curWepId = m.id; }
    weapSel.value = curWepId;
    weapSel.addEventListener('change', () => { const wp = WEAPON_PALETTE.find(w => w.id === weapSel.value); u.weapon = { ...wp }; });
    form.appendChild(fieldRow('Weapon', weapSel));
    autoFields['weapon'] = { input: weapSel, lookup: true };

    //POF: additional fields 
    const nOfFiguresInput = document.createElement('input');
    nOfFiguresInput.type = 'number'; nOfFiguresInput.min = 1; nOfFiguresInput.className = 'unit-detail-input';
    nOfFiguresInput.value = u.n_of_figures ?? 1;
    nOfFiguresInput.addEventListener('input', () => { u.n_of_figures = +nOfFiguresInput.value; });
    form.appendChild(fieldRow('Number of Figures', nOfFiguresInput));


    // HP
    const hpInput = document.createElement('input');
    hpInput.type = 'number'; hpInput.min = 0; hpInput.className = 'unit-detail-input';
    hpInput.value = u.hp ?? 3;
    hpInput.addEventListener('input', () => { u.hp = +hpInput.value; });
    form.appendChild(fieldRow('HP', hpInput));

    // Shield
    const shieldInput = document.createElement('input');
    shieldInput.type = 'number'; shieldInput.min = 0; shieldInput.className = 'unit-detail-input';
    shieldInput.value = u.shield ?? 0;
    shieldInput.addEventListener('input', () => { u.shield = +shieldInput.value; });
    form.appendChild(fieldRow('Shield', shieldInput));
    autoFields['shield'] = { input: shieldInput };

    // armor class (for damage reduction)
    const armorInput = document.createElement('input');
    armorInput.type = 'number'; armorInput.min = 0; armorInput.className = 'unit-detail-input';
    armorInput.value = u.armor ?? 0;
    armorInput.addEventListener('input', () => { u.armor = +armorInput.value; });
    form.appendChild(fieldRow('Armor', armorInput));
    autoFields['armor'] = { input: armorInput };

    // N of Attacks
    const nAtkInput = document.createElement('input');
    nAtkInput.type = 'number'; nAtkInput.min = 1; nAtkInput.className = 'unit-detail-input';
    nAtkInput.value = u.n_of_attacks ?? 1;
    nAtkInput.addEventListener('input', () => { u.n_of_attacks = Math.max(1, +nAtkInput.value || 1); });
    form.appendChild(fieldRow('Attacks', nAtkInput));
    autoFields['n_of_attacks'] = { input: nAtkInput };

    // Speed
    const speedInput = document.createElement('input');
    speedInput.type = 'number'; speedInput.min = 1; speedInput.className = 'unit-detail-input';
    speedInput.value = u.speed ?? 1;
    speedInput.addEventListener('input', () => { u.speed = Math.max(1, +speedInput.value || 1); });
    form.appendChild(fieldRow('Speed', speedInput));
    autoFields['speed'] = { input: speedInput };

    // Experience
    const EXPERIENCE_LEVELS = [
      { id: 'green', name: '🟢 Green' }, { id: 'seasoned', name: '🟡 Seasoned' },
      { id: 'veteran', name: '🟠 Veteran' }, { id: 'elite', name: '🔴 Elite' },
    ];
    const expSel = document.createElement('select');
    expSel.className = 'unit-detail-input';
    EXPERIENCE_LEVELS.forEach(lvl => {
      const opt = document.createElement('option');
      opt.value = lvl.id; opt.textContent = lvl.name;
      expSel.appendChild(opt);
    });
    expSel.value = u.experience || 'seasoned';
    expSel.addEventListener('change', () => { u.experience = expSel.value; });
    form.appendChild(fieldRow('Experience', expSel));

    detailEl.appendChild(form);

    // impassable terrain types 
    const impassableInput = document.createElement('input');
    impassableInput.type = 'text'; impassableInput.className = 'unit-detail-input ';
    impassableInput.readOnly = true;
    impassableInput.value = u.impassable?.join(', ') ?? '';
    impassableInput.addEventListener('input', () => { u.impassable = impassableInput.value.split(',').map(s => s.trim()); });
    form.appendChild(fieldRow('Impassable', impassableInput,infoOnly=true));
    autoFields['impassable'] = { input: impassableInput };

    // invalid actions
    const invalidActionsInput = document.createElement('input');
    invalidActionsInput.type = 'text'; invalidActionsInput.className = 'unit-detail-input';
    invalidActionsInput.readOnly = true;
    invalidActionsInput.value = u.invalidActions?.join(', ') ?? '';
    invalidActionsInput.addEventListener('input', () => { u.invalidActions = invalidActionsInput.value.split(',').map(s => s.trim()); });
    form.appendChild(fieldRow('Invalid Actions', invalidActionsInput,infoOnly=true));
    autoFields['invalidActions'] = { input: invalidActionsInput };



    // Delete
    const delBtn = document.createElement('button');
    delBtn.className = 'secondary unit-detail-delete';
    delBtn.textContent = '🗑 Remove Unit';
    delBtn.addEventListener('click', () => {
      units[team].splice(idx, 1);
      selectedUnit = null;
      render();
    });
    detailEl.appendChild(delBtn);
  }

  function renderUnitList(){
    unitListEl.innerHTML='';

    const makeRow = (team, u, idx) => {
      const isActive = selectedUnit && selectedUnit.team === team && selectedUnit.idx === idx;
      const row = document.createElement('div');
      row.className = 'unit-row--compact' + (isActive ? ' active' : '');

      const miniWrap = document.createElement('div');
      miniWrap.className = 'mini';
      miniWrap.style.cssText = 'width:28px;height:28px;border-radius:4px;overflow:hidden;flex-shrink:0;background:#111827;';
      const miniImg = document.createElement('img');
      const spr = spriteForUnit({ ...u, team });
      miniImg.src = spr.typeSprite;
      miniImg.onerror = () => { miniImg.src = spr.fallback; };
      miniImg.style.cssText = 'width:100%;height:100%;object-fit:contain;';
      miniWrap.appendChild(miniImg);
      row.appendChild(miniWrap);

      const info = document.createElement('div');
      info.className = 'unit-row-info';
      const nameEl = document.createElement('div');
      nameEl.className = 'unit-row-name';
      nameEl.textContent = u.name || (team === 'red' ? `Red #${idx+1}` : `Blue #${idx+1}`);
      const metaEl = document.createElement('div');
      metaEl.className = 'unit-row-meta';
      metaEl.textContent = `${u.type || 'soldier'} · (${u.x ?? '?'},${u.y ?? '?'})`;
      info.appendChild(nameEl);
      info.appendChild(metaEl);
      row.appendChild(info);

      const badge = document.createElement('div');
      badge.className = `unit-row-badge unit-row-badge--${team}`;
      row.appendChild(badge);

      row.addEventListener('click', () => {
        selectedUnit = { team, idx };
        highlightSelectedOnMap();
        renderUnitList();
        renderSelectedUnitDetail();
      });
      return row;
    };

    // Red section
    if (units.red.length) {
      const hdr = document.createElement('div');
      hdr.style.cssText = 'font-size:10px;font-weight:700;color:var(--red);text-transform:uppercase;letter-spacing:.06em;padding:4px 10px 2px;';
      hdr.textContent = `🔴 Red (${units.red.length})`;
      unitListEl.appendChild(hdr);
      units.red.forEach((u, idx) => unitListEl.appendChild(makeRow('red', u, idx)));
    }

    // Blue section
    if (units.blue.length) {
      const hdr = document.createElement('div');
      hdr.style.cssText = 'font-size:10px;font-weight:700;color:var(--blue);text-transform:uppercase;letter-spacing:.06em;padding:4px 10px 2px;margin-top:4px;';
      hdr.textContent = `🔵 Blue (${units.blue.length})`;
      unitListEl.appendChild(hdr);
      units.blue.forEach((u, idx) => unitListEl.appendChild(makeRow('blue', u, idx)));
    }

    if (!units.red.length && !units.blue.length) {
      const empty = document.createElement('div');
      empty.style.cssText = 'color:#94a3b8;font-size:12px;padding:12px;text-align:center;';
      empty.textContent = 'No units placed yet.';
      unitListEl.appendChild(empty);
    }
  }

  function highlightSelectedOnMap(){
    mapEl.querySelectorAll('.tile').forEach(t=>t.classList.remove('selected'));
    if(!selectedUnit) return;
    const u = units[selectedUnit.team][selectedUnit.idx];
    const cell = mapEl.querySelector(`.tile[data-x="${u.x}"][data-y="${u.y}"]`);
    if(cell) cell.classList.add('selected');
  }

  function render(){
    mapEl.innerHTML='';
    //mapEl.style.gridTemplateColumns = `repeat(${width}, 64px)`;
    mapEl.style.gridTemplateColumns = `repeat(${width}, ${TILE_SIZE}px)`;

    // ✅ expose grid size to CSS


    mapEl.style.setProperty('--bgwidth',  `${TILE_SIZE * width + 16}px`);  // row slot (tile + border gap)
    if (tileMode === 'square') {
      mapEl.style.setProperty('--bgheight',  `${(TILE_SIZE + 0) * height + 16}px`);  // row slot (tile + border gap)
    }else {
      mapEl.style.setProperty('--bgheight',  `${(TILE_SIZE + 0) * height + TILE_SIZE /2 + 16 }px`);  // row slot (tile + border gap)
    }


    const mapKey   = `${tileMode}-${width}x${height}`;
    const fallback = `/static/img/maps/plains-${tileMode}.png`;
    mapEl.style.backgroundImage = `url("/static/img/maps/plains-${mapKey}.png"), url("${fallback}")`;


    for(let y=0;y<height;y++){
      for(let x=0;x<width;x++){

        const t = document.createElement('div');
        t.className = 'tile';
        t.style.width  = `${TILE_SIZE}px`;
        t.style.height = `${TILE_SIZE}px`;
        if (tileMode === 'square') {
          t.style.gridRowStart    = y + 1;
          t.style.gridRowEnd      = y + 1;
          t.style.gridColumnStart = x + 1;
        } else {
          if (x % 2 === 1) {
            t.style.gridRowStart    = y * 2 + 2;
            t.style.gridRowEnd      = y * 2 + 4;
            t.style.gridColumnStart = x + 1;
          } else {
            t.style.gridRowStart    = y * 2 + 1;
            t.style.gridRowEnd      = y * 2 + 3;
            t.style.gridColumnStart = x + 1;
          }
        }

        const tt = terrainAt(x, y);
        if (tt && tt !== 'open') t.classList.add('t-' + tt);
        t.dataset.x = x;
        t.dataset.y = y;
        t.title = `(${x},${y})\n${tt.toUpperCase()}`;

        // ── Terrain image (bottom layer) ─────────────────────────────────────────────
        const terrImg = document.createElement('img');
        terrImg.className = 'terrain-img';
        terrImg.src = terrainImgSrc(tt);
        terrImg.alt = '';
        terrImg.draggable = false;
        terrImg.onerror = () => { terrImg.style.display = 'none'; };
        t.appendChild(terrImg);   // first child → rendered below everything else

        // ── Unit image (top layer) ────────────────────────────────────────────────────
        const ref = unitAt(x, y);
        if (ref) {
          const u = units[ref.team][ref.idx];
          const sprites = spriteForUnit({ ...u, team: ref.team });
          const img = document.createElement('img');
          img.className = 'unit-img';
          img.draggable = true;
          img.alt = ref.team;
          img.src = sprites.typeSprite;
          img.onerror = () => { img.src = sprites.fallback; };

          // ── Drag source ────────────────────────────────────────────────────
          img.addEventListener('dragstart', (e) => {
            draggedUnit = { team: ref.team, idx: ref.idx };
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setDragImage(img, img.width / 2, img.height / 2);
            t.style.opacity = '0.4';
          });
          img.addEventListener('dragend', () => {
            t.style.opacity = '';
            draggedUnit = null;
            mapEl.querySelectorAll('.tile.drag-over').forEach(el => el.classList.remove('drag-over'));
          });


          t.appendChild(img);
        }



        // ── Drop target (every tile) ───────────────────────────────────────
        t.addEventListener('dragover', (e) => {
          if (!draggedUnit) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
          t.classList.add('drag-over');
        });
        t.addEventListener('dragleave', () => t.classList.remove('drag-over'));
        t.addEventListener('drop', (e) => {
          e.preventDefault();
          t.classList.remove('drag-over');
          if (!draggedUnit) return;
          const tx = parseInt(t.dataset.x, 10);
          const ty = parseInt(t.dataset.y, 10);
          const occupant = unitAt(tx, ty);
          const src = draggedUnit;
          // Only allow drop on empty tiles (or same tile = no-op)
          if (occupant && !(occupant.team === src.team && occupant.idx === src.idx)) return;
          units[src.team][src.idx].x = tx;
          units[src.team][src.idx].y = ty;
          selectedUnit = src;
          draggedUnit = null;
          render();
        });

        t.addEventListener('click', () => {
          if (mode === 'terrain') {
            const type = eraser ? 'open' : brush;
            setTerrain(x, y, type);
          } else {
            const refNow = unitAt(x, y);
            if (refNow) { selectedUnit = refNow; } else { toggleUnit(x, y); selectedUnit = null; }
          }
          render();
        });        
        mapEl.appendChild(t);

      }
    }
    highlightSelectedOnMap();
    renderUnitList();
    renderSelectedUnitDetail();
  }

  wInput.addEventListener('change',()=>{ width = Math.max(5, Math.min(30, +wInput.value||10)); selectedUnit=null; render(); });
  hInput.addEventListener('change',()=>{ height = Math.max(5, Math.min(30, +hInput.value||10)); selectedUnit=null; render(); });

  hexInput.addEventListener('change',()=>{ tileMode = hexInput.checked?"hex" :"square"; render(); });
  actInput.addEventListener('change',()=>{ activationMode = actInput.checked? actCheckInput.checked ? "Alternate-Check" : "Alternate" : "IGOYGO"; });
  actCheckInput.addEventListener('change',()=>{ activationMode = actInput.checked? actCheckInput.checked ? "Alternate-Check" : "Alternate" : "IGOYGO"; });

  function getCurrentEditorState() {
    return {
      width,
      height,
      terrain,
      units,
      tileMode,
      activationMode,
      era: currentEra,
      combatOptions,
    };
  }

  // Expose for template-level actions (Save as Scenario button).
  window.getCurrentEditorState = getCurrentEditorState;

  document.getElementById('save').addEventListener('click', async ()=>{
    try{ await apiTerrain('POST', getCurrentEditorState()); alert('Type template saved.'); }
    catch(e){ alert(e.message); }
  });


  // ── Combat Options UI ─────────────────────────────────────────────────────
  /**
   * Reads current combatOptions into the Combat Rules panel inputs.
   * Call once after loading from the API.
   */
  function applyCombatOptionsToUI() {
    const get = id => document.getElementById(id);
    const setCheck = (id, val) => { const el = get(id); if (el) el.checked = !!val; };
    const setVal   = (id, val) => { const el = get(id); if (el) el.value  = val; };

    setCheck('cr-traverse-friendly',  combatOptions.traverseFriendlyUnits);
    setCheck('cr-charge-traverse-friendly',  combatOptions.chargeTraverseFriendlyUnits);
    setCheck('cr-enter-enemy-tile',  combatOptions.enterEnemyTile);
    setCheck('cr-stacking',           combatOptions.stacking);
    setVal  ('cr-resolution-method',  combatOptions.resolutionMethod);
    setVal  ('cr-saving-throws-method', combatOptions.savingThrowsMethod);
    setCheck('cr-friendly-fire',      combatOptions.friendlyFire);
    setCheck('cr-contemporary-melee', combatOptions.contemporaryMelee);
    setCheck('cr-terrain-cover-bonus', combatOptions.terrainCoverBonus);
    setCheck('cr-morale-checks',      combatOptions.moraleChecks);
    setCheck('cr-pin-morale-checks-as-FUBAR', combatOptions.pinMoraleChecksAsFUBAR);
    setVal  ('cr-rout-threshold',     combatOptions.routThreshold);
  }

  /**
   * Wires all Combat Rules inputs so changes update combatOptions immediately.
   * Add a line here whenever a new input is added to the panel.
   */
  function bindCombatOptionsInputs() {
    const bindCheck = (id, key) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.addEventListener('change', () => { combatOptions[key] = el.checked; });
    };
    const bindSelect = (id, key) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.addEventListener('change', () => { combatOptions[key] = el.value; });
    };
    const bindNumber = (id, key) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.addEventListener('change', () => { combatOptions[key] = Number(el.value); });
    };

    bindCheck ('cr-traverse-friendly',  'traverseFriendlyUnits');
    bindCheck ('cr-charge-traverse-friendly',  'chargeTraverseFriendlyUnits');
    bindCheck ('cr-enter-enemy-tile',  'enterEnemyTile');
    bindCheck ('cr-stacking',           'stacking');
    bindSelect('cr-resolution-method',  'resolutionMethod');
    bindSelect ('cr-saving-throws-method', 'savingThrowsMethod');
    bindCheck ('cr-friendly-fire',      'friendlyFire');
    bindCheck ('cr-contemporary-melee', 'contemporaryMelee');
    bindCheck ('cr-terrain-cover-bonus','terrainCoverBonus');
    bindCheck ('cr-morale-checks',      'moraleChecks');
    bindCheck ('cr-pin-morale-checks-as-FUBAR', 'pinMoraleChecksAsFUBAR');
    bindNumber('cr-rout-threshold',     'routThreshold');
  }

  bindCombatOptionsInputs();

  populateEraSelect();
  await applyEra(currentEra);
  load();

})();