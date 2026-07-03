/**
 * ══════════════════════════════════════════════════════════════════════════════
 *  DICE ROLLER POPUP  –  dice-roller.js
 *  Drop this file in static/js/ and add:
 *      <script src="{{ url_for('static', filename='js/dice-roller.js') }}"></script>
 *  in base.html BEFORE battle.js, OR paste the whole block directly into
 *  battle.js just after the IIFE opens.
 *
 *  PUBLIC API
 *  ──────────
 *  window.DiceRoller.roll(diceString)   → Promise<results>
 *
 *  diceString  format:  "Label1:D6 + Label2:D6 + Label3:D12"
 *                        spaces and capitalisation are ignored.
 *
 *  Resolved value  (use it to check results in game logic):
 *  {
 *    rolls: [
 *      { tag: "Attack1", sides: 6, value: 4 },
 *      { tag: "Attack2", sides: 6, value: 2 },
 *      { tag: "Defence", sides: 12, value: 9 },
 *    ],
 *    byTag: { Attack1: 4, Attack2: 2, Defence: 9 },   // quick lookup
 *    total:  15                                        // sum of all dice
 *  }
 *
 *  EXAMPLE (in your attack handler):
 *
 *    const result = await DiceRoller.roll("Attack:D6 + Bonus:D4 + Defence:D12");
 *    if (result.byTag.Attack + result.byTag.Bonus > result.byTag.Defence) {
 *        // hit!
 *    }
 *
 * ══════════════════════════════════════════════════════════════════════════════
 */

(function () {
  'use strict';

  // ── Constants ───────────────────────────────────────────────────────────────
  const ROLL_DURATION_MS  = 1200;   // how long dice spin before landing
  const FRAME_INTERVAL_MS = 60;     // shuffle speed during animation

  // Die-face SVG paths (simplified pips for D4/D6/D8/D10/D12/D20)
  const DIE_COLORS = {
    4:  '#7c3aed', // purple  – D4
    6:  '#2563eb', // blue    – D6
    8:  '#0891b2', // cyan    – D8
    10: '#059669', // green   – D10
    12: '#d97706', // amber   – D12
    20: '#dc2626', // red     – D20
  };

  // ── Helpers ─────────────────────────────────────────────────────────────────
  function randInt(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  /** Parse "Attack1:D6 + Attack2:D6 + Defence:D12" into dice descriptors */
  function parseDiceString(str) {
    return str
      .split('+')
      .map(tok => tok.trim())
      .filter(Boolean)
      .map(tok => {
        const m = tok.match(/^([^:]+)\s*:\s*[Dd](\d+)$/);
        if (!m) throw new Error(`Invalid dice token: "${tok}"`);
        return { tag: m[1].trim(), sides: parseInt(m[2], 10) };
      });
  }

  /** Roll all dice and return the results object */
  function rollDice(descriptors) {
    const rolls = descriptors.map(d => ({
      tag:   d.tag,
      sides: d.sides,
      value: randInt(1, d.sides),
    }));
    const byTag = {};
    let total = 0;
    for (const r of rolls) { byTag[r.tag] = r.value; total += r.value; }
    return { rolls, byTag, total };
  }

  // ── DOM injection ────────────────────────────────────────────────────────────
  function injectDOM() {
    if (document.getElementById('dice-overlay')) return;
    document.body.insertAdjacentHTML('beforeend', `
      <div id="dice-overlay" class="dice-overlay" role="dialog" aria-modal="true" aria-label="Dice roll">
        <div class="dice-popup">
          <div class="dice-popup-header">
            <span class="dice-header-icon">🎲</span>
            <h2 class="dice-popup-title">Rolling…</h2>
          </div>
          <div id="dice-tray" class="dice-tray"></div>
          <div class="dice-popup-footer">
            <button id="dice-close-btn" class="dice-close-btn" disabled>Rolling…</button>
          </div>
        </div>
      </div>
    `);
  }

  // ── Build one die card element ───────────────────────────────────────────────
  function makeDieCard(roll) {
    const color = DIE_COLORS[roll.sides] || '#475569';
    const card = document.createElement('div');
    card.className = 'die-card';
    card.dataset.tag = roll.tag;
    card.innerHTML = `
      <div class="die-face" style="--die-color:${color}">
        <svg class="die-svg" viewBox="0 0 80 80" xmlns="http://www.w3.org/2000/svg">
          ${dieSVG(roll.sides, color)}
        </svg>
        <span class="die-value">?</span>
      </div>
      <div class="die-label">${escHtml(roll.tag)}</div>
      <div class="die-sides">D${roll.sides}</div>
    `;
    return card;
  }

  /** Minimal SVG shapes per die type */
  function dieSVG(sides, color) {
    const dark = shadeColor(color, -30);
    switch (sides) {
      case 4:
        return `<polygon points="40,8 72,68 8,68" fill="${color}" stroke="${dark}" stroke-width="3"/>
                <polygon points="40,8 72,68 40,55" fill="${dark}" opacity="0.35"/>`;
      case 6:
        return `<rect x="8" y="8" width="64" height="64" rx="10" fill="${color}" stroke="${dark}" stroke-width="3"/>
                <rect x="8" y="8" width="64" height="32" rx="10" fill="${dark}" opacity="0.25"/>`;
      case 8:
        return `<polygon points="40,4 76,40 40,76 4,40" fill="${color}" stroke="${dark}" stroke-width="3"/>
                <polygon points="40,4 76,40 40,40" fill="${dark}" opacity="0.3"/>`;
      case 10:
        return `<polygon points="40,6 74,28 74,52 40,74 6,52 6,28" fill="${color}" stroke="${dark}" stroke-width="3"/>
                <polygon points="40,6 74,28 40,34" fill="${dark}" opacity="0.3"/>`;
      case 12:
        return `<polygon points="40,5 62,16 75,38 68,62 48,74 32,74 12,62 5,38 18,16" fill="${color}" stroke="${dark}" stroke-width="3"/>
                <polygon points="40,5 62,16 50,30 30,30 18,16" fill="${dark}" opacity="0.3"/>`;
      default: // D20
        return `<polygon points="40,4 72,22 76,56 54,76 26,76 4,56 8,22" fill="${color}" stroke="${dark}" stroke-width="3"/>
                <polygon points="40,4 72,22 56,28 24,28 8,22" fill="${dark}" opacity="0.3"/>`;
    }
  }

  function shadeColor(hex, pct) {
    const n = parseInt(hex.slice(1), 16);
    const r = Math.max(0, Math.min(255, ((n >> 16) & 0xff) + pct));
    const g = Math.max(0, Math.min(255, ((n >> 8)  & 0xff) + pct));
    const b = Math.max(0, Math.min(255, (n          & 0xff) + pct));
    return `#${((1<<24)|(r<<16)|(g<<8)|b).toString(16).slice(1)}`;
  }

  function escHtml(s) {
    return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  // ── Animate dice rolling ─────────────────────────────────────────────────────
  function animateDice(cards, finalRolls) {
    return new Promise(resolve => {
      const start = Date.now();
      const valueEls = cards.map(c => c.querySelector('.die-value'));

      const tick = () => {
        const elapsed = Date.now() - start;
        if (elapsed >= ROLL_DURATION_MS) {
          // Snap to final values
          finalRolls.forEach((r, i) => {
            valueEls[i].textContent = r.value;
            cards[i].classList.add('landed');
          });
          resolve();
          return;
        }
        // Shuffle
        finalRolls.forEach((r, i) => {
          valueEls[i].textContent = randInt(1, r.sides);
          cards[i].classList.toggle('rolling', true);
        });
        setTimeout(tick, FRAME_INTERVAL_MS);
      };
      tick();
    });
  }

  // ── Main show function ───────────────────────────────────────────────────────
  async function showDicePopup(descriptors, results) {
    const overlay  = document.getElementById('dice-overlay');
    const tray     = document.getElementById('dice-tray');
    //const totalEl  = document.getElementById('dice-total-value');
    const closeBtn = document.getElementById('dice-close-btn');
    const titleEl  = overlay.querySelector('.dice-popup-title');

    tray.innerHTML = '';
    //totalEl.textContent = '—';
    closeBtn.disabled = true;
    closeBtn.textContent = 'Rolling…';
    titleEl.textContent  = 'Rolling…';

    const cards = results.rolls.map(r => {
      const card = makeDieCard(r);
      tray.appendChild(card);
      return card;
    });

    overlay.classList.add('open');

    // Small delay so CSS transition fires
    await new Promise(r => setTimeout(r, 30));

    await animateDice(cards, results.rolls);

    // Reveal total
    //totalEl.textContent = results.total;
    titleEl.textContent = 'Results';
    closeBtn.disabled   = false;
    closeBtn.textContent = 'Continue ▶';

    // Highlight max / min
    const vals = results.rolls.map(r => r.value);
    const max  = Math.max(...vals);
    const min  = Math.min(...vals);
    cards.forEach((c, i) => {
      if (vals[i] === max) c.classList.add('die-max');
      if (vals[i] === min && min !== max) c.classList.add('die-min');
    });

    return new Promise(resolve => {
      const done = () => {
        overlay.classList.remove('open');
        closeBtn.removeEventListener('click', done);
        overlay.removeEventListener('click', onBg);
        document.removeEventListener('keydown', onKey);
        resolve();
      };
      const onBg  = e => { if (e.target === overlay) done(); };
      const onKey = e => { if (e.key === 'Enter' || e.key === 'Escape') done(); };
      closeBtn.addEventListener('click', done);
      overlay.addEventListener('click', onBg);
      document.addEventListener('keydown', onKey);
    });
  }

  // ── Public API ───────────────────────────────────────────────────────────────
  /**
   * Roll dice described by a string like "Attack1:D6 + Attack2:D6 + Defence:D12"
   * Shows the popup, waits for the user to dismiss it, then resolves with:
   *   { rolls, byTag, total }
   *
   * Usage:
   *   const res = await DiceRoller.roll("Attack:D6 + Defence:D12");
   *   if (res.byTag.Attack > res.byTag.Defence) { // hit! }
   */
  async function roll(diceString) {
    injectDOM();
    const descriptors = parseDiceString(diceString);
    const results     = rollDice(descriptors);
    await showDicePopup(descriptors, results);
    return results;
  }

  window.DiceRoller = { roll, parseDiceString, rollDice };
})();    