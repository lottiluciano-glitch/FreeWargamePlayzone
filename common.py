import random
import math

TERRAIN_TYPES = ['open','wall','rocks','rough','cover','water','forest','highground',
                 'hstreet_so_ne','hstreet_so_n','hstreet_s_no','hstreet_s_ne','hstreet_se_no','hstreet_se_n','hstreet_s_n', 'qstreet_e_w', 'qstreet_e_n_w', 'qstreet_n_e_s', 'qstreet_n_w_s', 'qstreet_w_s_e', 'qstreet_n_e', 'qstreet_n_w', 'qstreet_s_e', 'qstreet_s_w',
                 'hriver_nw_n_ne', 'hriver_n_ne','hriver_ne_se'] 

TERRAIN_COST = {
    'open': 1,
    'cover': 1,
    'rough': 2,
    'water': 9999,
    'forest': 2,
    'highground': 1,
    'wall': 9999,
    'rocks': 9999,
    'hstreet_so_ne': 0.5,
    'hstreet_so_n': 0.5,
    'hstreet_s_no': 0.5,
    'hstreet_s_ne': 0.5,
    'hstreet_se_no': 0.5,
    'hstreet_se_n': 0.5,
    'hstreet_s_n': 0.5,
    'qstreet_e_w': 0.5,
    'qstreet_e_n_w': 0.5,
    'qstreet_n_e_s': 0.5,
    'qstreet_n_w_s': 0.5,
    'qstreet_w_s_e': 0.5,
    'qstreet_n_e': 0.5,
    'qstreet_n_w': 0.5,
    'qstreet_s_e': 0.5,
    'qstreet_s_w': 0.5,
    'hriver_nw_n_ne': 0,
    'hriver_n_ne': 0,
    'hriver_ne_se': 0
}


# Ranged parameters
DEFAULT_WEAPON = {'name':'Rifle','damage':1,'armouredDmg':0,'range':4,'accuracy':0.70,'ammo':6,'max_ammo':6,'recoil':0.10}
RNG = random.Random(); RNG.seed()


def in_bounds(state, x, y):
    return 0 <= x < state['battlefield']['width'] and 0 <= y < state['battlefield']['height']


def neighbor_deltas(state, x):
    if state['battlefield']['tileMode'] == 'square':
        return [(0, 1), (0, -1), (-1, 0), (1, 0)]
    if x % 2 == 0:
        return [(0, 1), (0, -1), (-1, 0), (-1, -1), (1, 0), (1, -1)]
    return [(0, 1), (0, -1), (-1, 0), (-1, 1), (1, 0), (1, 1)]


def is_adjacent(state, x1, y1, x2, y2):
    for dx, dy in neighbor_deltas(state, x1):
        if x1 + dx == x2 and y1 + dy == y2:
            return True
    return False


def terrain_map(state):
    tdict = {}
    for t in state['battlefield'].get('terrain', []):
        tdict[(t['x'], t['y'])] = t.get('type','open')
    return tdict


def tile_type(state, x, y):
    return terrain_map(state).get((x,y),'open')


def tile_layers(state, x, y):
    ttype = tile_type(state, x, y)
    if not isinstance(ttype, str) or ttype == 'open':
        return ['open']
    return [layer.strip() for layer in ttype.split('|') if layer and layer.strip()]


def terrain_has_layer(state, x, y, *layers):
    tile = set(tile_layers(state, x, y))
    return any(layer in tile for layer in layers)

#remember this is duplicated in battle.js as well, so any changes here should be reflected there for consistency between frontend and backend logic
def tile_cost(unit_ref, action, state, x, y):
    unit = None
    if isinstance(unit_ref, dict):
        unit = unit_ref
    elif isinstance(unit_ref, str):
        _, unit = find_unit(state, unit_ref)

    ttype = tile_type(state, x, y)
    layers = tile_layers(state, x, y)
    if action in ('move', 'run', 'charge'):
        if unit and any(layer in unit.get('impassable', []) for layer in layers):
            return 9999  # Impassable due to unit restriction
        if any(layer in ('rocks', 'water') for layer in layers):
            return 9999  # Impassable
        if any(layer in ('hstreet_so_ne', 'hstreet_so_n', 'hstreet_s_no', 'hstreet_s_ne', 'hstreet_se_no', 'hstreet_se_n', 'hstreet_s_n', 'qstreet_e_w', 'qstreet_e_n_w', 'qstreet_n_e_s', 'qstreet_n_w_s', 'qstreet_w_s_e', 'qstreet_n_e', 'qstreet_n_w', 'qstreet_s_e', 'qstreet_s_w') for layer in layers):
            return 0.5  # Reduced cost for streets
        if any(layer in ('rough', 'wall', 'forest', 'highground') for layer in layers):
            if action == 'move' and unit and unit.get('speed') == 1:
                return 1  # Allow normal cost for slow units moving into difficult terrain
            return 2  # Increased cost for cover and rough terrain
        return 1  # Normal cost for movement
    return TERRAIN_COST.get(ttype, 1)



# Hex LOS helpers
def cube_distance(a, b):
    return max(abs(a[0]-b[0]), abs(a[1]-b[1]), abs(a[2]-b[2]))

def cube_lerp(a, b, t):
    return (a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t)

def cube_round(cube):
    rx = round(cube[0])
    ry = round(cube[1])
    rz = round(cube[2])
    x_diff = abs(rx - cube[0])
    y_diff = abs(ry - cube[1])
    z_diff = abs(rz - cube[2])
    if x_diff > y_diff and x_diff > z_diff:
        rx = -ry - rz
    elif y_diff > z_diff:
        ry = -rx - rz
    else:
        rz = -rx - ry
    return (rx, ry, rz)

def axial_to_cube(q, r):
    x = q
    z = r
    y = -x - z
    return (x, y, z)

def cube_to_axial(cube):
    x, y, z = cube
    q = x
    r = z
    return (q, r)

def hex_line(q1, r1, q2, r2):
    start = axial_to_cube(q1, r1)
    end = axial_to_cube(q2, r2)
    N = cube_distance(start, end)
    results = []
    for i in range(N + 1):
        t = 1.0 / N * i if N > 0 else 0
        lerped = cube_lerp(start, end, t)
        rounded = cube_round(lerped)
        axial = cube_to_axial(rounded)
        results.append(axial)
    return results


def range_distance(state, x1, y1, x2, y2):
    if state['battlefield']['tileMode'] == 'hex':
        q1 = x1
        r1 = y1 - (x1 // 2)
        q2 = x2
        r2 = y2 - (x2 // 2)
        a1 = axial_to_cube(q1, r1)
        a2 = axial_to_cube(q2, r2)
        return cube_distance(a1, a2)
    return math.sqrt ((x1 - x2) ** 2 + (y1 - y2) ** 2)  

# LOS helper with corner clipping & soft cover

def los_clear_and_cover(state, x1, y1, x2, y2):
    tile_mode = state['battlefield']['tileMode']
    occupied = {(u['position']['x'], u['position']['y']) for u in state['red']['units']+state['blue']['units']}
    if tile_mode == 'hex':
        # For hex, use hex line drawing
        q1 = x1
        r1 = y1 - (x1 // 2)
        q2 = x2
        r2 = y2 - (x2 // 2)
        tiles = hex_line(q1, r1, q2, r2)
        pathStr = ' => '.join([f'({q},{r})' for q,r in tiles])
        cover_tiles = 0
        for q, r in tiles[1:-1]:  # exclude start and end
            x = q
            y = r + (q // 2)
            if(x == x2 and y == y2) or (x == x1 and y == y1):
                continue
            if not in_bounds(state, x, y):
                return False, 0,pathStr
            tt = tile_type(state, x, y)
            if terrain_has_layer(state, x, y, 'wall', 'forest', 'highground', 'rocks'):
                return False, 0 ,pathStr
            if (x, y) in occupied:
                return False, 0, pathStr
            if 'cover' in tile_layers(state, x, y):
                cover_tiles += 1
        return True, cover_tiles,pathStr
    else:
        # Square mode with oversampling
        import math
        dx = x2 - x1
        dy = y2 - y1
        dist = math.sqrt(dx**2 + dy**2)
        if dist == 0:
            return True, 0 ,""
        num_samples = max(1, int(dist * 10))  # 10 samples per unit
        tiles_passed = set()
        for i in range(1, num_samples + 1):  # exclude start (i=0), include end if i==num_samples but we'll exclude later
            t = i / num_samples
            px = x1+0.5 + t * dx
            py = y1+0.5 + t * dy
            tx = int(px)
            ty = int(py)
            if in_bounds(state, tx, ty):
                tiles_passed.add((tx, ty))
        # Exclude start and end tiles
        tiles_passed.discard((x1, y1))
        tiles_passed.discard((x2, y2))
        cover_tiles = 0
        for tx, ty in tiles_passed:
            tt = tile_type(state, tx, ty)
            if terrain_has_layer(state, tx, ty, 'wall', 'forest', 'highground', 'rocks'):
                return False, 0,""
            if (tx, ty) in occupied:
                return False, 0,""
            if 'cover' in tile_layers(state, tx, ty):
                cover_tiles += 1
        return True, cover_tiles ,""




def find_unit(state, unit_id):
    for side in ['red','blue']:
        for u in state[side]['units']:
            if u['id'] == unit_id:
                return side, u
    return None, None


def unit_at(state, x, y):
    for side in ['red','blue']:
        for u in state[side]['units']:
            if u['position']['x']==x and u['position']['y']==y:
                return side, u
    return None, None


def add_log(state, msg):
    state['log'].append(msg)