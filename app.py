import math


from flask import Flask, render_template, request, redirect, url_for, jsonify, abort
import json, uuid, os, threading, datetime, random
from pathlib import Path
from heapq import heappush, heappop

from common import TERRAIN_TYPES, TERRAIN_COST, DEFAULT_WEAPON, RNG 
from common import in_bounds, neighbor_deltas, is_adjacent, terrain_map, tile_type, tile_cost, range_distance, los_clear_and_cover, axial_to_cube, cube_distance
from common import unit_at, find_unit, add_log
from combat import check_victory, resolve_shot, resolve_attack, trigger_overwatch_reactions

app = Flask(__name__)
BASE = Path(__file__).parent
DATA = BASE / 'data'
GAMES_DIR = DATA / 'games'
GAMES_DIR.mkdir(exist_ok=True)
lock = threading.Lock()



# Helpers

##LL Scenario
def save_scenarios():
    write_json(SCENARIOS_PATH, SCENARIOS)

def list_scenarios(type_id):
    return SCENARIOS.get(type_id, {})



def now_iso():
    return datetime.datetime.utcnow().isoformat() + 'Z'

def read_json(p: Path, default=None):
    if not p.exists():
        return default if default is not None else {}
    with p.open('r', encoding='utf-8') as f:
        return json.load(f)

def write_json(p: Path, data):
    with p.open('w', encoding='utf-8') as f:
        json.dump(data, f, indent=2)


# Single source of truth for combat options: (type, default) per key.
# <POF> add new combat options here — this is the ONLY place to touch.
COMBAT_OPTIONS_SCHEMA = {
    'traverseFriendlyUnits':       (bool, True),
    'chargeTraverseFriendlyUnits': (bool, False),
    'enterEnemyTile':              (bool, False),
    'stacking':                    (bool, False),
    'resolutionMethod':            (str,  'weapon_stats'),   # or 'standard'
    'savingThrowsMethod':          (str,  'no_saving'),      # or 'standard'
    'friendlyFire':                (bool, False),
    'contemporaryMelee':           (bool, False),
    'terrainCoverBonus':           (bool, True),
    'moraleChecks':                (bool, False),
    'pinMoraleChecksAsFUBAR':      (bool, False),
    'routThreshold':               (int,  25),
}

def normalize_combat_options(raw_co):
    """Build a fully-populated combatOptions dict from a (possibly partial /
    possibly None) raw dict, applying types and defaults from
    COMBAT_OPTIONS_SCHEMA. Unknown keys in raw_co are silently dropped."""
    raw_co = raw_co or {}
    return {
        key: cast(raw_co.get(key, default))
        for key, (cast, default) in COMBAT_OPTIONS_SCHEMA.items()
    }


##LL Scenario 
SCENARIOS_PATH = DATA / 'game_type_scenarios.json'
SCENARIOS = read_json(SCENARIOS_PATH, default={})

CARDS = read_json(DATA / 'cards.json')['cards']
CARD_MAP = {c['id']: c for c in CARDS}
GAME_TYPES = read_json(DATA / 'game_types.json')['game_types']
# Terrain templates per type (with width/height & units)
TERR_TEMPLATES_PATH = DATA / 'game_type_terrains.json'
TERR_TEMPLATES = read_json(TERR_TEMPLATES_PATH, default={})




# Game state management

def games_index_path():
    return DATA / 'games_index.json'

def game_path(game_id):
    return GAMES_DIR / f'{game_id}.json'


def list_games_by_type(game_type):
    idx = read_json(games_index_path(), {"games": []})
    games = [g for g in idx.get('games', []) if g['type'] == game_type]
    result = []
    for g in games:
        st = read_json(game_path(g['id']))
        g2 = dict(g)
        g2['turn'] = st.get('turn', 1)
        g2['current_player'] = st.get('current_player', 'red')
        result.append(g2)
    open_games = [g for g in result if g.get('status','open') == 'open']
    finished_games = [g for g in result if g.get('status') == 'finished']
    return open_games, finished_games


def get_template_summary(game_type):
    tpl = TERR_TEMPLATES.get(game_type) or {}
    width = int(tpl.get('width', 10))
    height = int(tpl.get('height', 10))
    era = tpl.get('era', 'modern')

    units = tpl.get('units') if isinstance(tpl.get('units'), dict) else {}
    red_units = units.get('red', []) if isinstance(units.get('red', []), list) else []
    blue_units = units.get('blue', []) if isinstance(units.get('blue', []), list) else []

    combat_options = normalize_combat_options(tpl.get('combatOptions'))
    combat_option_labels = {
        'traverseFriendlyUnits': 'Traverse Friendly Units',
        'chargeTraverseFriendlyUnits': 'Charge Traverse Friendly Units',
        'enterEnemyTile': 'Enter Enemy Tile',
        'stacking': 'Stacking',
        'resolutionMethod': 'Resolution Method',
        'savingThrowsMethod': 'Saving Throws Method',
        'friendlyFire': 'Friendly Fire',
        'contemporaryMelee': 'Contemporary Melee',
        'terrainCoverBonus': 'Terrain Cover Bonus',
        'moraleChecks': 'Morale Checks',
        'pinMoraleChecksAsFUBAR': 'Pin Morale Checks As FUBAR',
        'routThreshold': 'Rout Threshold',
    }

    return {
        'era': era,
        'width': width,
        'height': height,
        'red_units': len(red_units),
        'blue_units': len(blue_units),
        'total_units': len(red_units) + len(blue_units),
        'combat_options': [
            {
                'key': k,
                'label': combat_option_labels.get(k, k),
                'value': v,
            }
            for k, v in combat_options.items()
        ],
    }


def create_new_game(game_type: str, name: str, scenario_tpl=None):
    gid = str(uuid.uuid4())
    #ttpl = TERR_TEMPLATES.get(game_type) or {}
    ttpl = scenario_tpl or TERR_TEMPLATES.get(game_type) or {} 

    width = int(ttpl.get('width', 10))
    height = int(ttpl.get('height', 10))
    tileMode = ttpl.get('tileMode', 'square')
    activationMode = ttpl.get('activationMode', 'IGOYGO')
    era = ttpl.get('era', 'modern')
    terr = ttpl.get('terrain', [])
    units_tpl = (ttpl.get('units') or {}) if isinstance(ttpl.get('units'), dict) else {}
    red_tpl = units_tpl.get('red', [])
    blue_tpl = units_tpl.get('blue', [])
    # Carry saved combat options into the live game; fall back to safe defaults
    # so games created before the panel was added still work correctly.
    combatOptions = normalize_combat_options(ttpl.get('combatOptions'))

    #<POF> add more unit properties here as needed (e.g., movement range, special abilities, etc.) as parameter
    def mk_unit(team, i, x, y, name=None, type=None,n_of_figures=None, weapon=None, hp=None, armor=None, sh=None, n_of_attacks=None, experience=None, speed=None, impassable=None,invalidActions=None):        
        return {
            'id': f'{team[:1]}-{uuid.uuid4().hex[:8]}',
            'team': team,
            'name': name or f'{team.capitalize()}#{i}',
            'type': type or 'soldier',   # <-- new line
            'experience': experience or 'seasoned',
            'hp': hp or 3,   
            'max_hp': hp or 3,
            'armor': armor or 0,
            'shields': sh or 0,
            'n_of_attacks': n_of_attacks if n_of_attacks is not None else 1,
            'n_of_figures': n_of_figures if n_of_figures is not None else 1,
            'max_figures': n_of_figures if n_of_figures is not None else 1,
            'speed': speed or 1,
            'impassable': impassable or [], 
            'invalidActions': invalidActions or [],
            #<POF> add more unit properties here as needed (e.g., movement range, special abilities, etc.)
            'weapon': dict(weapon or DEFAULT_WEAPON),

            'position': {'x': x, 'y': y},
            'status': 'normal',
            'recoil_penalty': 0.0,
            'overwatch_ready': False,
            'acted': False,
            'stress': 0,
        }

    red_units = []
    blue_units = []
    if red_tpl or blue_tpl:
        i = 1
        for u in red_tpl:
            x, y = int(u.get('x',0)), int(u.get('y',0))
            nm = u.get('name')
            wp = u.get('weapon')
            ty = u.get('type')
            n_of_figures = u.get('n_of_figures')
            hp = u.get('hp')
            sh = u.get('shield')
            arm = u.get('armor')
            na = u.get('n_of_attacks')
            ex = u.get('experience')
            sp = u.get('speed')
            imp = u.get('impassable')
            ia = u.get('invalidActions')
            #<POF> add more unit properties here as needed (e.g., movement range, special abilities, etc.)
            #<POF> also pass it to mk_unit and store in unit state for later use in game logic
            red_units.append(mk_unit('red', i, x, y, nm,ty, n_of_figures, wp, hp, arm, sh, na, ex, sp,imp, ia )); i += 1
        i = 1
        for u in blue_tpl:
            x, y = int(u.get('x',0)), int(u.get('y',0))
            nm = u.get('name')
            wp = u.get('weapon')
            ty = u.get('type')
            n_of_figures = u.get('n_of_figures')
            hp = u.get('hp')
            sh = u.get('shield')
            arm = u.get('armor')
            na = u.get('n_of_attacks')
            ex = u.get('experience')
            sp = u.get('speed')
            imp = u.get('impassable')
            ia = u.get('invalidActions')
            #<POF> add more unit properties here as needed (e.g., movement range, special abilities, etc.)
            #<POF> also pass it to mk_unit and store in unit state for later use in game logic
            blue_units.append(mk_unit('blue', i, x, y, nm, ty, n_of_figures, wp, hp, arm, sh, na, ex, sp, imp, ia)); i += 1
    else:
        red_units = [mk_unit('red', i+1, 1, min(height-1, i*2)) for i in range(4)]
        blue_units = [mk_unit('blue', i+1, max(0, width-2), min(height-1, i*2)) for i in range(4)]

    deck = [c['id'] for c in CARDS]
    random.shuffle(deck)
    red_hand = [deck.pop(), deck.pop()] if len(deck) >= 2 else deck[:]
    blue_hand = [deck.pop(), deck.pop()] if len(deck) >= 2 else deck[:]

    state = {
        'id': gid,
        'name': name,
        'type': game_type,
        'status': 'open',
        'created_at': now_iso(),
        'updated_at': now_iso(),
        'winner': None,
        'turn': 1,
        'current_player': 'red',
        'turn_state': {'card_played': False, 'begin_phase_executed': False, 'weather': None},
        'battlefield': {'width': width, 'height': height, 'tileMode': tileMode, 'activationMode': activationMode, 'era': era, 'terrain': terr, 'combatOptions': combatOptions},
        'deck': deck,
        'red': {'units': red_units, 'hand': red_hand},
        'blue': {'units': blue_units, 'hand': blue_hand},
        'selected_unit_id': None,
        'log': [f"Game {name} created (type={game_type}, {width}x{height})."],
        'actedUnits': [],  # <-- new line to track acted units in alt-activation mode
    }

    write_json(game_path(gid), state)

    idx = read_json(games_index_path(), {"games": []})
    idx['games'].append({
        'id': gid,
        'type': game_type,
        'name': name,
        'era': era,
        'status': 'open',
        'created_at': now_iso(),
        'updated_at': now_iso(),
        'winner': None
    })
    write_json(games_index_path(), idx)
    return gid


def load_game(game_id):
    p = game_path(game_id)
    if not p.exists():
        abort(404)

    try:
        x = read_json(p)
        return x
    except Exception as e:
        print(f"Error loading game:{game_id} {e}")
        abort(404)


def save_game(state):
    state['updated_at'] = now_iso()
    write_json(game_path(state['id']), state)

    try:
        idx = read_json(games_index_path(), {"games": []})
        for g in idx['games']:
            if g['id'] == state['id']:
                g['updated_at'] = state['updated_at']
                g['status'] = state.get('status', g.get('status','open'))
                g['winner'] = state.get('winner')
                break
        write_json(games_index_path(), idx)
    except Exception as e:
        print(f"Error saving game index: {e}")




def adjacent_enemy(st,unit):
    ux, uy = unit["position"]["x"], unit["position"]["y"]

    for dx,dy in neighbor_deltas(st, ux):
        x, y = ux+dx, uy+dy
        oside, enemy = unit_at(st, x, y)
        if enemy and oside != unit['team']:
            return enemy
    return None



def sanitize_editor_template(data):
    width = int(data.get('width', 10))
    height = int(data.get('height', 10))
    tile_mode = data.get('tileMode', 'square')
    activation_mode = data.get('activationMode', 'IGOYGO')
    era = data.get('era', 'modern')
    terr = data.get('terrain', [])
    units = data.get('units') or {'red': [], 'blue': []}

    # Read and sanitise combatOptions — unknown keys are silently dropped so
    # only explicitly declared options are ever persisted.
    combat_options = normalize_combat_options(data.get('combatOptions'))

    clean_terr = []
    for t in terr:
        x, y = int(t.get('x', -1)), int(t.get('y', -1))
        ty = t.get('type', 'open')
        if 0 <= x < width and 0 <= y < height and ty in TERRAIN_TYPES:
            clean_terr.append({'x': x, 'y': y, 'type': ty})

    occ = set()
    clean_units = {'red': [], 'blue': []}

    # quick helper to check if (x,y) is a wall/rock in clean_terr
    def is_blocking_tile(px, py):
        for tt in clean_terr:
            if tt['x'] == px and tt['y'] == py:
                return tt['type'] in ('wall', 'rocks')
        return False

    for color in ['red', 'blue']:
        for u in (units.get(color) or []):
            x, y = int(u.get('x', -1)), int(u.get('y', -1))
            if 0 <= x < width and 0 <= y < height and (x, y) not in occ and not is_blocking_tile(x, y):
                occ.add((x, y))
                cu = {'x': x, 'y': y}
                if u.get('name'):
                    cu['name'] = u['name']
                if u.get('n_of_figures'):
                    cu['n_of_figures'] = u['n_of_figures']
                if u.get('type'):
                    cu['type'] = u['type']
                if u.get('armor'):
                    cu['armor'] = u['armor']
                if u.get('shield'):
                    cu['shield'] = u['shield']
                if u.get('n_of_attacks'):
                    cu['n_of_attacks'] = u['n_of_attacks']
                if u.get('experience'):
                    cu['experience'] = u['experience']
                if u.get('speed'):
                    cu['speed'] = u['speed']
                if u.get('impassable'):
                    cu['impassable'] = u['impassable']
                if u.get('invalidActions'):
                    cu['invalidActions'] = u['invalidActions']
                # <POF> add more unit properties here as needed
                if u.get('hp'):
                    cu['hp'] = u['hp']
                if isinstance(u.get('weapon'), dict):
                    cu['weapon'] = u['weapon']
                clean_units[color].append(cu)

    return {
        'width': width,
        'height': height,
        'tileMode': tile_mode,
        'activationMode': activation_mode,
        'era': era,
        'terrain': clean_terr,
        'units': clean_units,
        'combatOptions': combat_options,
    }

# A* pathfinding

def astar_path(unit_id, action, state, start, goal):
    sx, sy = start; gx, gy = goal
    if not in_bounds(state, gx, gy):
        return None
    #LL STACKING: allow pathfinding to target occupied tile if it's the final step of a charge and the occupant is the target enemy
    #if unit_at(state, gx, gy)[1] is not None:
    #    return None
    min_step_cost = 0.5

    traverseFriendly = state['battlefield']['combatOptions'].get('traverseFriendlyUnits', False)

    def h(x, y):
        if state['battlefield']['tileMode'] == 'hex':
            q1 = x
            r1 = y - (x // 2)
            q2 = gx
            r2 = gy - (gx // 2)
            return cube_distance(axial_to_cube(q1, r1), axial_to_cube(q2, r2)) * min_step_cost
        return (abs(x - gx) + abs(y - gy)) * min_step_cost

    openh = []
    heappush(openh, (0+h(sx,sy), 0, (sx,sy), None))
    came = {}
    gscore = {(sx,sy):0}
    # LL STACKING 
    occupied = {(u['position']['x'], u['position']['y']) for u in state['red']['units']+state['blue']['units']}
    occupied.discard((sx,sy))
    me = next((u for u in state['red']['units']+state['blue']['units'] if u['id']==unit_id), None)
    while openh:
        f, g, (x,y), prev = heappop(openh)
        if (x,y) in came:
            continue
        came[(x,y)] = prev
        if (x,y)==(gx,gy):
            path=[]; cur=(x,y)
            while cur and cur!=(sx,sy):
                path.append(cur); cur=came[cur]
            path.reverse(); return (g, path)
        for dx,dy in neighbor_deltas(state, x):
            nx, ny = x+dx, y+dy
            if not in_bounds(state, nx, ny):
                continue
            if me.get('impassable') and tile_type(state, nx, ny) in me.get('impassable', []):
                continue
            #if tile_type(state, nx, ny) in ('rocks'):
            #    continue

            # LL STACKING: allow moving into occupied tile if it's the final step of a charge and the occupant is the target enemy
            if (nx,ny) in occupied and not ((nx,ny)==(gx,gy) and action=='charge'):
                if not traverseFriendly and unit_at(state, nx, ny)[0] == me['team']:
                    continue
                if unit_at(state, nx, ny)[0] != me['team']:
                    continue
            step_cost = tile_cost(unit_id,action, state, nx, ny)
            ng = g + step_cost
            if (nx,ny) in gscore and ng >= gscore[(nx,ny)]:
                continue
            gscore[(nx,ny)] = ng
            heappush(openh, (ng + h(nx,ny), ng, (nx,ny), (x,y)))
    return None



def end_turn_logic(state):
    side = state['current_player']
    hand = state[side]['hand']
    deck = state.get('deck', [])
    weather = state['turn_state'].get('weather')    
    begPhaseEx=state['turn_state'].get('begin_phase_executed', False) 
    if len(hand) < 2 and deck:
        hand.append(deck.pop())
    if side == 'blue':
        state['turn'] += 1
        begPhaseEx = False
    # swap player
    state['current_player'] = 'blue' if side=='red' else 'red'
    state['turn_state'] = {'card_played': False, 'begin_phase_executed': begPhaseEx, 'weather': weather}
    state['selected_unit_id'] = None
    cur = state['current_player']
    for u in state[cur]['units']:
        u['acted'] = False
        u['recoil_penalty'] = 0.0
        if u.get('smoked'):
            u['smoked'] = False
        if u['status'] == 'overwatch':
            u['status'] = 'normal'
        u['overwatch_ready'] = False
    oth = 'red' if cur=='blue' else 'blue'
    for u in state[oth]['units']:
        if u['status'] == 'overwatch':
            u['overwatch_ready'] = True

def end_turn_alt_logic(state):
    side = state['current_player']
    deck = state.get('deck', [])
    weather = state['turn_state'].get('weather')    

    
    state['turn'] += 1
    # random initial player
    sides = ['red', 'blue']
    state['current_player'] = random.choice(sides)
    add_log(state, f'The turn start goes to {state["current_player"]}!')

    state['turn_state'] = {'card_played': False, 'begin_phase_executed': False, 'weather': weather}
    state['selected_unit_id'] = None
    cur = 'red'
    hand = state[cur]['hand']
    if len(hand) < 2 and deck:
        hand.append(deck.pop())

    for u in state[cur]['units']:
        u['acted'] = False
        u['recoil_penalty'] = 0.0
        if u.get('smoked'):
            u['smoked'] = False
        if u['status'] != 'overwatch' and u['status'] != 'down':
            u['status'] = 'normal'
            u['overwatch_ready'] = False
    cur = 'blue'
    hand = state[cur]['hand']
    if len(hand) < 2 and deck:
        hand.append(deck.pop())
    for u in state[cur]['units']:
        u['acted'] = False
        u['recoil_penalty'] = 0.0
        if u.get('smoked'):
            u['smoked'] = False
        if u['status'] != 'overwatch' and u['status'] != 'down':
            u['status'] = 'normal'
            u['overwatch_ready'] = False



def swap_turn_logic(state):
    side = state['current_player']
    # swap player
    state['current_player'] = 'blue' if side=='red' else 'red'
    state['selected_unit_id'] = None
    # Note: we do NOT reset 'card_played' or 'begin_phase_executed' here, as it's just a turn swap, not end of turn

def compute_possible_actions(state):
    actions = [
        {'action':'move', 'label':'Move', 'enabled': False},
        {'action':'run', 'label':'Run', 'enabled': False},
        {'action':'attack', 'label':'Attack (Melee)', 'enabled': False},
        {'action':'advance', 'label':'Advance', 'enabled': False},
        {'action':'charge', 'label':'⚡ Charge', 'enabled': False},
        {'action':'shoot', 'label':'Shoot (Ranged)', 'enabled': False},
        {'action':'overwatch', 'label':'Overwatch', 'enabled': False},
        {'action':'down', 'label':'Down', 'enabled': False},
        {'action':'rally', 'label':'Rally', 'enabled': False},
    ]
    sel_id = state.get('selected_unit_id')
    if not sel_id:
        return actions
    side, u = find_unit(state, sel_id)
    if not u or side != state['current_player']:
        return actions
    if u['acted']:
        return actions
    for a in actions:
        a['enabled'] = True
    for a in actions:
        if a['action']=='charge' and adjacent_enemy(state, u) != None:
            a['enabled'] = False

        if a['action']=='shoot' and u['weapon']['ammo'] <= 0:
            a['enabled'] = False
        if a['action']=='rally' and u['stress'] == 0:    
            a['enabled'] = False
        if 'invalidActions' in u and a['action'] in u['invalidActions']:
            a['enabled'] = False
    return actions


# Routes
@app.route('/')
def index():
    return render_template('index.html', game_types=GAME_TYPES)

@app.route('/games', methods=['GET','POST'])
def games():
    if request.method == 'GET':
        game_type = request.args.get('type')
        if not game_type:
            return redirect(url_for('index'))
        open_games, finished_games = list_games_by_type(game_type)
        name = next((t['name'] for t in GAME_TYPES if t['id']==game_type), game_type)
        template_summary = get_template_summary(game_type)
        return render_template('games.html', game_type_id=game_type, game_type_name=name,
                               open_games=open_games, finished_games=finished_games,
                               template_summary=template_summary)
    else:
        game_type = request.form.get('type')
        name = request.form.get('name') or 'New Game'
        with lock:
            gid = create_new_game(game_type, name)
        return redirect(url_for('battle', game_id=gid))

@app.route('/battle/<game_id>')
def battle(game_id):
    return render_template('battle.html', game_id=game_id)

@app.route('/editor/type/<type_id>')
def editor_type(type_id):
    if not any(t['id']==type_id for t in GAME_TYPES):
        abort(404)
    return render_template('editor.html', type_id=type_id)

@app.route('/api/type/<type_id>/terrain', methods=['GET','POST'])
def api_type_terrain(type_id):
    if not any(t['id']==type_id for t in GAME_TYPES):
        abort(404, 'Unknown game type')
    global TERR_TEMPLATES
    if request.method == 'GET':
        tpl = TERR_TEMPLATES.get(type_id, {'width':10,'height':10,'tileMode': 'square','activationMode': 'IGOYGO','era': 'modern','terrain':[],'units':{'red':[],'blue':[]}})
        tpl.setdefault('width',10); tpl.setdefault('height',10)
        tpl.setdefault('tileMode', 'square')
        tpl.setdefault('activationMode', 'IGOYGO')
        tpl.setdefault('era', 'modern') 
        tpl.setdefault('terrain',[]); tpl.setdefault('units',{'red':[],'blue':[]})
        tpl['units'].setdefault('red',[]); tpl['units'].setdefault('blue',[])
        # Ensure combatOptions is always present with safe defaults
        tpl['combatOptions'] = normalize_combat_options(tpl.get('combatOptions'))
        return jsonify(tpl)
    data = request.get_json(force=True)
    TERR_TEMPLATES[type_id] = sanitize_editor_template(data)
    write_json(TERR_TEMPLATES_PATH, TERR_TEMPLATES)
    return jsonify({'ok': True})

@app.route('/api/game/<game_id>/state')
def api_state(game_id):
    st = load_game(game_id)
    def expand_cards(ids):
        return [CARD_MAP[i] for i in ids if i in CARD_MAP]
    st['red']['hand_cards'] = expand_cards(st['red']['hand'])
    st['blue']['hand_cards'] = expand_cards(st['blue']['hand'])
    st['possible_actions'] = compute_possible_actions(st)
    return jsonify(st)

@app.route('/api/game/<game_id>/select_unit', methods=['POST'])
def api_select_unit(game_id):
    st = load_game(game_id)
    data = request.get_json(force=True)
    unit_id = data.get('unit_id')
    side, u = find_unit(st, unit_id)
    if not u:
        abort(400, 'Unit not found')
    st['selected_unit_id'] = unit_id
    #add_log(st, f"Selected unit {u['name']}  {u['type']} {u['status']} ({side})")
    save_game(st)
    return jsonify({'ok': True})

# LL implementation
@app.route('/api/game/<game_id>/play_card', methods=['POST'])
def api_play_card(game_id):
    st = load_game(game_id)
    side = st["current_player"]
    hand = st[side]["hand"]

    data = request.get_json(force=True)
    card_id = data.get("card_id")

    if card_id not in hand:
        abort(400, "Card not in hand")

    card = CARD_MAP.get(card_id)
    if not card:
        abort(400, "Unknown card")

    sel_id = st.get("selected_unit_id")
    unitside, u = find_unit(st, sel_id) if sel_id else (None, None)

    # Remove card from hand immediately
    hand.remove(card_id)
    add_log(st, f"{side.capitalize()} plays card: {card['name']}")
    st["turn_state"]["card_played"] = True

    # Helper targeting logic


    def visible_enemies(unit):
        ux, uy = unit["position"]["x"], unit["position"]["y"]
        enemies = st["blue"]["units"] if side == "red" else st["red"]["units"]
        vis = []
        for e in enemies:
            tx, ty = e["position"]["x"], e["position"]["y"]
            man = range_distance(st, ux, uy, tx, ty)
            los_ok, _ ,pathStr = los_clear_and_cover(st, ux, uy, tx, ty)
            if man >= 1 and los_ok:
                vis.append(e)
        return vis

    # ---- CARD EFFECTS ----

    # 1) Adrenaline: +1 movement range (one turn)
    if card_id == "adrenaline":
        if not u or unitside != side:
            abort(400, "Select a unit first")
        u["adrenaline"] = True
        add_log(st, f"{u['name']} gains +1 move range this turn")

    # 2) Medkit: heal 1 HP
    elif card_id == "medkit":
        if not u or unitside != side:
            abort(400, "Select a unit first")
        if u["hp"] < u["max_hp"]:
            u["hp"] += 1
            add_log(st, f"{u['name']} heals 1 HP")
        else:
            add_log(st, f"{u['name']} is already at full HP")

    # 3) Grenade: deal 1 damage to adjacent enemy
    elif card_id == "grenade":
        if not u or unitside != side:
            abort(400, "Select a unit first")
        enemy = adjacent_enemy(st, u)
        if not enemy:
            abort(400, "No adjacent enemy to grenade")
        enemy["hp"] -= 1
        add_log(st, f"{u['name']} grenades {enemy['name']} for 1 damage")
        if enemy["hp"] <= 0:
            add_log(st, f"{enemy['name']} is eliminated")
            eside = enemy["team"]
            st[eside]["units"] = [x for x in st[eside]["units"] if x["id"] != enemy["id"]]
            check_victory(st)

    # 4) Smoke: smoked = True (cannot be attacked)
    elif card_id == "smoke":
        if not u or unitside != side:
            abort(400, "Select a unit first")
        u["smoked"] = True
        add_log(st, f"{u['name']} is concealed by smoke until next turn")

    # 5) Suppress: target visible enemy goes DOWN
    elif card_id == "suppress":
        if not u or unitside != side:
            abort(400, "Select a unit first")
        vis = visible_enemies(u)
        if not vis:
            abort(400, "No visible enemy to suppress")
        target = vis[0]  # choose first visible
        target["status"] = "down"
        add_log(st, f"{target['name']} is suppressed and goes DOWN")

    # 6) Harden: +1 max HP (once)
    elif card_id == "harden":
        if not u or unitside != side:
            abort(400, "Select a unit first")
        u["max_hp"] += 1
        u["hp"] += 1
        add_log(st, f"{u['name']} permanently gains +1 max HP")

    # 7) Scout: no game effect—just log
    elif card_id == "scout":
        add_log(st, f"{side.capitalize()} scouts the area")

    # 8) Charge: melee attack moves into tile if enemy dies
    elif card_id == "charge":
        if not u or unitside != side:
            abort(400, "Select a unit first")
        u["charge"] = True
        add_log(st, f"{u['name']} will CHARGE on next melee attack")

    # 9) Steady Aim: +1 damage on next attack
    elif card_id == "steady":
        if not u or unitside != side:
            abort(400, "Select a unit first")
        u["steady"] = True
        add_log(st, f"{u['name']} gains +1 damage for next attack")

    # 10) Fortify: overwatch + +1 shield this turn
    elif card_id == "fortify":
        if not u or unitside != side:
            abort(400, "Select a unit first")
        u["status"] = "overwatch"
        u["overwatch_ready"] = True
        u["shields"] = u.get("shields", 0) + 1
        add_log(st, f"{u['name']} is fortified (Overwatch +1 shield)")

    else:
        abort(400, "Card not implemented")

    save_game(st)
    return jsonify({"ok": True})


@app.route('/api/game/<game_id>/action', methods=['POST'])
def api_action(game_id):
    st = load_game(game_id)
    if st.get('status') == 'finished':
        abort(400, 'Game is finished')
    data = request.get_json(force=True)
    action = data.get('action')
    dices = data.get('dices')
    melee_resolution = data.get('melee_resolution')
    add_log(st, f"ACTION API:{melee_resolution}")
    mode = data.get('mode', 'normal')
    combat_resolution = st.get('combat_resolution')
    add_log(st, f"Action requested: {action} with dices {dices}")   
    sel_id = st.get('selected_unit_id')
    side, u = find_unit(st, sel_id)
    if not u or side != st['current_player']:
        abort(400, 'Select one of your units first')

    #if u['status'] == 'down' and (action != 'rally' and action != 'move'):
    #    abort(400, 'Unit is DOWN and must RALLY')

    def can_enter(x,y):
        return tile_type(st,x,y) != 'wall' and tile_type(st,x,y) != 'rocks'

    if action in ('move','run'):
        tgt = data.get('target') or {}
        tx, ty = int(tgt.get('x', -999)), int(tgt.get('y', -999))
        terr =  tile_type(st, tx, ty)

        ux, uy = u['position']['x'], u['position']['y']
        
        base_range = u['speed'] if action == 'move' else u['speed'] * 2
        if u.get('adrenaline'):
            base_range += 1

        res = astar_path(u.get('id'),action, st, (ux,uy), (tx,ty))
        if not res:
            abort(400, 'No path to target')
        total_cost, path = res
 
        if total_cost > base_range:
            abort(400, f'Movement requires cost {total_cost}, exceeds range {base_range}')
        for (sx,sy) in path:
            if trigger_overwatch_reactions(st, u, sx, sy) == 'stopped':
                u['position'] = {'x': sx, 'y': sy}
                u['acted'] = True
                u['adrenaline'] = False
                u['status'] = 'stopped'
                u['overwatch_ready'] = False
                save_game(st)
                return jsonify({'ok': True})
            u['position'] = {'x': sx, 'y': sy}
        u['acted'] = True
        add_log(st, f"{side.capitalize()} {u['name']} {action} to {terr} ({tx},{ty}) [cost {total_cost}/{base_range}]")
        u['adrenaline'] = False
        u['status'] = 'moved'
        u['overwatch_ready'] = False


    elif action == 'attack':
        tgt = data.get('target') or {}
        tx, ty = int(tgt.get('x', -999)), int(tgt.get('y', -999))
        oside, enemy = unit_at(st, tx, ty)
        if not enemy or oside == side:
            abort(400, 'Select an adjacent enemy to attack')
        if not is_adjacent(st, u['position']['x'], u['position']['y'], tx, ty):
            abort(400, 'Attack requires adjacent enemy')
        attack_result = resolve_attack(st, u, enemy, tx, ty,action,melee_resolution)
        if attack_result['status'] == 'smoked':
            abort(400, 'Enemy is concealed by smoke')
        if attack_result['status'] == 'attacker_killed_by_reaction':
            check_victory(st)
            save_game(st)
            return jsonify({'ok': True})
        u['acted'] = True
        if attack_result['status'] == 'missed':
            add_log(st, f"{side.capitalize()} ST:{attack_result['status']} {u['name']} attacks {enemy['name']} but misses")

        u['steady'] = False
        if attack_result['status'] == 'killed':
            add_log(st, f"{enemy['name']} is eliminated")
            if u.get('charge'):
                u['position'] = {'x': tx, 'y': ty}
                u['charge'] = False
        u['status'] = 'fighted'
        u['overwatch_ready'] = False

        check_victory(st)

    elif action == 'charge':
        # Charge: move up to run range towards an enemy, then attack.
        # The client sends: target = enemy tile, path_target = last tile before enemy (adjacent to it).
        tgt = data.get('target') or {}
        ptgt = data.get('path_target') or {}
        tx, ty = int(tgt.get('x', -999)), int(tgt.get('y', -999))
        px, py = int(ptgt.get('x', -999)), int(ptgt.get('y', -999))

        # Validate enemy at target
        oside, enemy = unit_at(st, tx, ty)
        if not enemy or oside == side:
            abort(400, 'Charge: no enemy at target tile')

        ux, uy = u['position']['x'], u['position']['y']

        # The path_target must be adjacent to the enemy VERIFY
        if not is_adjacent(st, px, py, tx, ty):
            abort(400, f'Charge: path target is not adjacent to enemy (near:{px},{py} tgt:{tx},{ty})')

        # Check that path_target is reachable within run range (2 tiles, +1 if adrenaline)
        base_range = u['speed'] * 2  # run range
        if u.get('adrenaline'):
            base_range += 1

        # If attacker is already adjacent to the enemy, no movement needed
        already_adjacent = is_adjacent(st, ux, uy, tx, ty)

        if not already_adjacent:
            # Validate path to path_target
            if not in_bounds(st, px, py):
                abort(400, 'Charge: path target out of bounds')
            res = astar_path(sel_id, 'run', st, (ux, uy), (px, py))
            if not res:
                abort(400, 'Charge: no path to target tile')
            total_cost, path = res
            if total_cost > base_range:
                abort(400, f'Charge: movement cost {total_cost} exceeds run range {base_range}')

            # Move along path (triggering overwatch reactions)
            for (sx, sy) in path:
                if trigger_overwatch_reactions(st, u, sx, sy) == 'stopped':
                    add_log(st, f"{u['name']} charge stopped by overwatch fire at ({sx},{sy})")
                    u['acted'] = True
                    u['position'] = {'x': sx, 'y': sy}
                    save_game(st)
                    return jsonify({'ok': True})
                if trigger_overwatch_reactions(st, u, sx, sy) == 'killed':
                    add_log(st, f"{u['name']} killed by overwatch fire at ({sx},{sy}) while charging")
                    u['acted'] = True
                    check_victory(st)
                    save_game(st)
                    return jsonify({'ok': True})
                
                u['position'] = {'x': sx, 'y': sy}
            add_log(st, f"{side.capitalize()} {u['name']} charges towards ({tx},{ty}), stops at ({px},{py})")
            u['adrenaline'] = False
        else:
            px, py = ux, uy  # stays in place, already adjacent

        # Now execute the melee attack from (px,py) against enemy at (tx,ty)
        if not is_adjacent(st, px, py, tx, ty):
            abort(400, 'Charge: attacker is not adjacent to enemy after movement')

        attack_result = resolve_attack(st, u, enemy, tx, ty,action,melee_resolution)
        if attack_result['status'] == 'smoked':
            abort(400, 'Charge: enemy is concealed by smoke')
        if attack_result['status'] == 'attacker_killed_by_reaction':
            check_victory(st)
            save_game(st)
            return jsonify({'ok': True})

        u['acted'] = True
        if attack_result['status'] == 'missed':
            add_log(st, f"{side.capitalize()} ST:{attack_result['status']} {u['name']} CHARGES and attacks {enemy['name']} but misses")

        u['steady'] = False

        if attack_result['status'] == 'killed':
            add_log(st, f"{enemy['name']} is eliminated")
            # Attacker moves into the vacated tile
            u['position'] = {'x': tx, 'y': ty}
            add_log(st, f"{u['name']} advances into ({tx},{ty})")
            check_victory(st)
        else:
            # Defender survived — attacker stays at path_target (already set above)
            add_log(st, f"{u['name']} remains at ({px},{py})")

        u['status'] = 'fighted'
        u['overwatch_ready'] = False

    elif action == 'shoot':
        tgt = data.get('target') or {}
        tx, ty = int(tgt.get('x', -999)), int(tgt.get('y', -999))
        oside, enemy = unit_at(st, tx, ty)
        if not enemy or oside == side:
            abort(400, 'Select an enemy to shoot')
        res = resolve_shot(st, u, enemy, tx, ty, reaction=False,dices=dices,mode=mode)
        add_log(st, f"Shooting -> {res}")
        if(res == 'smoked' or res == 'no_los'):
            abort(400, 'Enemy is not visible for shooting')
        if(res == 'no_ammo'):
            abort(400, 'No ammo to shoot with')
        if(res == 'out_of_range'):
            abort(400, 'out of range')
        u['acted'] = True
        u['status'] = 'shooted'
        u['overwatch_ready'] = False
        check_victory(st)

    elif action == 'overwatch':
        u['status'] = 'overwatch'
        u['overwatch_ready'] = True
        u['acted'] = True
        add_log(st, f"{u['name']} is on OVERWATCH")
    elif action == 'down':
        u['status'] = 'down'
        u['acted'] = True
        add_log(st, f"{u['name']} goes DOWN")
    elif action == 'rally':
        if u['stress'] == 0:
            abort(400, 'Unit is not Stressed')
        u['status'] = 'normal'
        u['acted'] = True
        u['stress'] = 0
        add_log(st, f"{u['name']} has RALLIED")
    else:
        abort(400, 'Unknown action')

    save_game(st)
    return jsonify({'ok': True})

@app.route('/api/game/<game_id>/end_turn', methods=['POST'])
def api_end_turn(game_id):
    st = load_game(game_id)
    if st.get('status') == 'finished':
        abort(400, 'Game is finished')
    side = st['current_player']
    add_log(st, f"{side.capitalize()} ends turn {st['turn']}")
    end_turn_logic(st)
    save_game(st)
    return jsonify({'ok': True})

@app.route('/api/game/<game_id>/end_turn_alt', methods=['POST'])
def api_end_turn_alt(game_id):
    st = load_game(game_id)
    if st.get('status') == 'finished':
        abort(400, 'Game is finished')
    side = st['current_player']
    add_log(st, f"{side.capitalize()} ends turn {st['turn']}")
    end_turn_alt_logic(st)
    save_game(st)
    return jsonify({'ok': True})

@app.route('/api/game/<game_id>/swap_turn', methods=['POST'])
def api_swap_turn(game_id):
    st = load_game(game_id)
    if st.get('status') == 'finished':
        abort(400, 'Game is finished')
    side = st['current_player']
    add_log(st, f"{side.capitalize()} swaps turn")
    swap_turn_logic(st)
    save_game(st)
    return jsonify({'ok': True})


@app.route('/api/game/<game_id>/mark_begin_phase_executed', methods=['POST'])
def api_mark_begin_phase_executed(game_id):
    st = load_game(game_id)
    st['turn_state']['begin_phase_executed'] = True
    save_game(st)
    return jsonify({'ok': True})

@app.route('/api/game/<game_id>/begin_phase_start', methods=['POST'])
def api_begin_phase_start(game_id):
    st = load_game(game_id)
    if st['turn_state'].get('begin_phase_executed'):
        return jsonify({'ok': True, 'weather': st['turn_state'].get('weather')})

    weatherOptions = ['sunny', 'raining', 'cloudy', 'stormy', 'foggy', 'windy']
    weather = random.choice(weatherOptions)
    st['turn_state']['weather'] = weather
    st['turn_state']['begin_phase_executed'] = True

    add_log(st, f"Begin Phase started (weather: {weather})")
    save_game(st)
    return jsonify({'ok': True, 'weather': weather})

@app.route('/api/game/<game_id>/begin_phase_complete', methods=['POST'])
def api_begin_phase_complete(game_id):
    st = load_game(game_id)
    add_log(st, 'Begin Phase completed')
    save_game(st)
    return jsonify({'ok': True})

@app.route('/api/game/<game_id>/delete', methods=['POST'])
def api_delete_game(game_id):
    with lock:
        p = game_path(game_id)
        if not p.exists():
            abort(404)
        p.unlink()
        idx = read_json(games_index_path(), {"games": []})
        idx['games'] = [g for g in idx['games'] if g['id'] != game_id]
        write_json(games_index_path(), idx)
    return jsonify({'ok': True})

##LL scenario saving
@app.route('/api/type/<type_id>/scenario/<scenario_id>', methods=['GET'])
def api_get_scenario(type_id, scenario_id):
    scenario = SCENARIOS.get(type_id, {}).get(scenario_id)
    if not scenario:
        abort(404, "Scenario not found")
    return jsonify({"ok": True, "scenario_id": scenario_id, "name": scenario["name"], "template": scenario["template"]})

@app.route('/api/type/<type_id>/scenario/save', methods=['POST'])
def api_save_scenario(type_id):
    if not any(t['id'] == type_id for t in GAME_TYPES):
        abort(404, "Unknown game type")

    data = request.get_json(force=True)
    scenario_id = data.get('id') or str(uuid.uuid4())
    name = data.get('name', 'Unnamed Scenario')
    template_source = data.get('template')
    if not isinstance(template_source, dict):
        abort(400, 'Missing scenario template data')

    scenario_template = sanitize_editor_template(template_source)

    SCENARIOS.setdefault(type_id, {})
    SCENARIOS[type_id][scenario_id] = {
        "name": name,
        "created_at": now_iso(),
        "template": scenario_template
    }

    save_scenarios()
    return jsonify({"ok": True, "scenario_id": scenario_id})

@app.route('/api/type/<type_id>/scenarios')
def api_list_scenarios(type_id):
    return jsonify(list_scenarios(type_id))

@app.route('/api/type/<type_id>/scenario/<scenario_id>/start', methods=['POST'])
def api_start_from_scenario(type_id, scenario_id):
    scenario = SCENARIOS.get(type_id, {}).get(scenario_id)
    if not scenario:
        abort(404, "Scenario not found")

    name = request.json.get("name", scenario["name"])
    with lock:
        gid = create_new_game(type_id, name, scenario["template"])

    return jsonify({"ok": True, "game_id": gid})


@app.route('/api/type/<type_id>/scenario/<scenario_id>/delete', methods=['POST'])
def api_delete_scenario(type_id, scenario_id):
    global SCENARIOS

    with lock:
        if type_id not in SCENARIOS:
            abort(404, "Unknown game type")

        if scenario_id not in SCENARIOS[type_id]:
            abort(404, "Scenario not found")

        del SCENARIOS[type_id][scenario_id]

        # Clean up empty types (optional but nice)
        if not SCENARIOS[type_id]:
            del SCENARIOS[type_id]

        save_scenarios()

    return jsonify({'ok': True})


@app.route('/api/game/<game_id>/unit/<unit_id>/attribute', methods=['POST'])
def api_set_unit_attribute(game_id, unit_id):
    """Set a unit attribute and save the game state.
    
    Expected JSON body:
    {
        "attribute": "attribute_name",
        "value": <any_value>
    }
    
    Returns:
    {
        "ok": true,
        "unit_id": "unit_id",
        "attribute": "attribute_name",
        "value": <value>,
        "message": "Attribute updated"
    }
    """
    try:
        st = load_game(game_id)
        data = request.get_json(force=True)
        
        attribute = data.get('attribute')
        value = data.get('value')
        
        if not attribute:
            return jsonify({'ok': False, 'error': 'Missing attribute name'}), 400
        
        side, unit = find_unit(st, unit_id)
        if not unit:
            return jsonify({'ok': False, 'error': 'Unit not found'}), 404
        
        # Set the attribute on the unit
        unit[attribute] = value
        
        # Log the change
        add_log(st, f"Unit {unit['name']} attribute '{attribute}' set to {value}")
        
        # Save the game state
        save_game(st)
        
        return jsonify({
            'ok': True,
            'unit_id': unit_id,
            'attribute': attribute,
            'value': value,
            'message': f"Attribute '{attribute}' updated successfully"
        })
    
    except Exception as e:
        print(f"Error setting unit attribute: {e}")
        return jsonify({'ok': False, 'error': str(e)}), 500


if __name__ == '__main__':
    app.run(host='0.0.0.0', port=5000, debug=True)