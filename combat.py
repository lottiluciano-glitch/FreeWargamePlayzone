import random

from common import DEFAULT_WEAPON, RNG
from common import is_adjacent, tile_type, range_distance, los_clear_and_cover
from common import add_log

def check_victory(state):
    if not state['red']['units']:
        state['status'] = 'finished'; state['winner'] = 'blue'; add_log(state, 'Blue wins!')
    elif not state['blue']['units']:
        state['status'] = 'finished'; state['winner'] = 'red'; add_log(state, 'Red wins!')


def resolve_shot(state, shooter, target, at_x, at_y, reaction=False,dices=None,mode=None):
    if shooter['weapon']['ammo'] <= 0:
        return 'no_ammo'
    if target.get('smoked'):
        return 'smoked'
    
    ux, uy = shooter['position']['x'], shooter['position']['y']
    tx, ty = at_x, at_y
    man = range_distance(state, ux, uy, tx, ty)
    if man < 1 or man > shooter['weapon']['range']:
        return 'out_of_range'
    los_ok, cover_tiles ,pathStr= los_clear_and_cover(state, ux, uy, tx, ty)
    if not los_ok:
        #return 'no_los', ux, uy, tx, ty, pathStr
        return 'no_los'
    

    #GET THE SELECTED RESOLUTION METHOD (weapon_stats or experience_stats) FROM COMBAT OPTIONS    
    combatOptions = state['battlefield'].get('combatOptions')
    resolutionMethod = combatOptions.get('resolutionMethod') if combatOptions else 'weapon_stats'
    savingThrowsMethod = combatOptions.get('savingThrowsMethod') if combatOptions else 'no_saving'
    add_log(state, f" Combat mode {resolutionMethod} Saving throws mode: {savingThrowsMethod} ")

    #compute probability to hit FOR WEAPON_STATS RESOLUTION METHOD

    if resolutionMethod == 'weapon_stats':
        acc = shooter['weapon']['accuracy'] - shooter.get('recoil_penalty',0.0) - min(0.3, 0.1*cover_tiles)
        acc = max(0.05, min(0.95, acc))
        bonus_description = f"Notes: base is {acc} "

        target_tile= tile_type(state, tx, ty)
        if target_tile in ('cover','forest'):
            acc = max(0.05,  acc - 0.1)  # -10% accuracy if target is in cover or woods
            bonus_description += "-10% to hit for target in cover/woods. "

        if target_tile in ('wall','rough'):
            acc = max(0.05,  acc - 0.2)  # -20% accuracy if target is in wall or rough
            bonus_description += "-20% to hit for target in wall/rough. "

        if target.get('status') == 'down':
            acc = max(0.05,  acc - 0.2)  # -20% accuracy if target is down
            bonus_description += "-20% to hit for target down. "

        # High ground accuracy bonus
        if target_tile == 'highground':
            acc = max(0.05,  acc - 0.1)  # -10% accuracy if target is in high ground
            bonus_description += "-10% to hit for target in high ground. "


    if resolutionMethod == 'experience_stats':
        bonus_description = "Notes: base is D6 3+ "
        # if using experience-based resolution, compute the required d6 roll to hit based on shooter's experience
        d6ToHit = 3 + (shooter.get('experience') == 'green') 
        if shooter.get('experience') == 'green':
            bonus_description += "Base +1 to hit for green experience. "
        target_tile= tile_type(state, tx, ty)

        if target_tile in ('cover','forest'):
            d6ToHit += 1  # +1 to hit roll if target is in cover or woods
            bonus_description += "+1 to hit for target in cover/woods. "

        if target_tile in ('wall','rough'):
            d6ToHit += 2  # +2 to hit roll if target is in wall or rough
            bonus_description += "+2 to hit for target in wall/rough. "

        if target.get('armor',0) < 1 and target.get('n_of_figures') < 3:
            d6ToHit += 1  # +1 to hit roll if target has fewer than 3 figures and not a vehicle (i.e., small team)
            bonus_description += "+1 to hit for small team target. "

        if target.get('status') == 'down':
            d6ToHit += 2  # +2 to hit roll if target is down
            bonus_description += "+2 to hit for target down. "

        if  shooter['weapon']['range'] > 2 and man == 1:
            d6ToHit -= 1  # -1 to hit roll point blank shooting 
            bonus_description += "-1 to hit for point blank shooting. "
        
        if mode == 'advance':
            d6ToHit += 1  # +1 to hit roll if it's an advance action
            bonus_description += "+1 to hit for advance action. "
        



    shootingFigures = shooter['n_of_figures']    
    someHit=0
    rolled=""
    for f in range(max(1, int(shootingFigures))):
        for a in range(shooter.get('n_of_attacks', 1)):

            #------------------------------------------------
            #compute hit based on selected resolution method
            #------------------------------------------------
            if resolutionMethod == 'weapon_stats':
                hit = RNG.random() <= acc
                rolled=""
            if resolutionMethod == 'experience_stats':
                diceResult= random.randint(1,6) 
                if dices and 'rolls' in dices and len(dices['rolls'])>0:
                    externalDice = dices['rolls'].pop(0)
                    if externalDice is not None:
                        diceResult = externalDice['value']
                rolled = f" Rolled a {diceResult}. "
                hit = diceResult >= d6ToHit


            if target['armor'] > 0:
                #an anti-tank weapon will generate at list 1 damage even if the armor negate the damage
                dmg = max(1, shooter['weapon']['armouredDmg'] - target['armor']  + (1 if shooter.get('steady') else 0))
                add_log(state, f"ARMORED: SHELL: {shooter['weapon']['armouredDmg']} ARMOR: {target['armor']} ")
            else:
                dmg = shooter['weapon']['damage'] + (1 if shooter.get('steady') else 0)
            # not sure if the folowing  make sense set it to 0 for the moment
            #cover_bonus_shield = 1 if tile_type(state, tx, ty)=='cover' else 0
            cover_bonus_shield = 0


            effective_shields = target.get('shields',0) + cover_bonus_shield
            if hit:
                someHit += 1
                add_log(state, f"{shooter['name']} Figure {f+1} Attack {a+1}: {'(OVR)' if reaction else ''} hits {target['name']} for {dmg} damage . {bonus_description} {rolled} ")
                #veteran or more get hits on  D6=5+, seasoned on 4+, green on 3+
                toDamage = 5 
                if target['experience'] == 'green':
                    toDamage = 3
                if target['experience'] == 'seasoned':
                    toDamage = 4  
                diceToDamage= random.randint(1,6)
                if diceToDamage >= toDamage or (savingThrowsMethod == 'no_saving'):
                    if savingThrowsMethod == 'experience_stats':
                        add_log(state, f"Damage roll {diceToDamage} >= {toDamage} [{target['experience']}], DAMAGED!")
                    if effective_shields>0:
                        used = min(effective_shields, dmg)
                        persist = target.get('shields',0)
                        if persist >= used:
                            target['shields'] = persist - used
                        else:
                            target['shields'] = 0
                        dmg -= used
                    if dmg>0:
                        target['hp'] -= dmg
                    if target['hp'] <= 0:
                        if target['n_of_figures'] > 1:
                            target['n_of_figures'] -= 1
                            target['hp'] = target['max_hp']
                            add_log(state, f"{target['name']} loses a figure but is still standing with {target['n_of_figures']} figures left!")
                        else:    
                            break
                else:
                    add_log(state, f"Damage roll {diceToDamage} < {toDamage} [{target['experience']}], so no damage applies!")
            else:
                add_log(state, f"{shooter['name']} Figure {f+1} Attack {a+1}: {'(OVR)' if reaction else ''} misses {target['name']} . {bonus_description} {rolled}")        
    shooter['weapon']['ammo'] -= 1
    shooter['recoil_penalty'] = shooter.get('recoil_penalty',0.0) + shooter['weapon']['recoil']
    shooter['steady'] = False
    if someHit > 0:

        if target.get('n_of_figures', 1) >1 and someHit >= target.get('n_of_figures', 1):
            add_log(state, f"{shooter['name']} {'(OVR)' if reaction else ''} hits so many figures that {target['name']} is disbanded!")
            side_t = target['team']
            state[side_t]['units'] = [x for x in state[side_t]['units'] if x['id'] != target['id']]
            check_victory(state)
            return 'disbanded'
        
        #add_log(state, f"{shooter['name']} {'(OVR)' if reaction else ''} hits {target['name']} for {shooter['weapon']['damage']} dmg")
        target['stress'] = target.get('stress', 0) + 1  # increase stress on hit
        if target['hp'] <= 0:
            add_log(state, f"{target['name']} {target['type']} is eliminated")
            side_t = target['team']
            state[side_t]['units'] = [x for x in state[side_t]['units'] if x['id'] != target['id']]
            check_victory(state)
            return 'killed'
        else:
            return 'stopped' if reaction else 'hit'
    else:
        add_log(state, f"{shooter['name']} {'(OVR)' if reaction else ''} misses {target['name']} ")
    return 'hit' if someHit > 0 else 'miss'


def resolve_attack(state, attacker, target, at_x, at_y,action,melee_resolution, allow_reaction=True):
    if not is_adjacent(state, attacker['position']['x'], attacker['position']['y'], at_x, at_y):
        return {'status': 'not_adjacent', 'damage': 0, 'cover_bonus': 0}
    if target.get('smoked'):
        return {'status': 'smoked', 'damage': 0, 'cover_bonus': 0}

    #GET THE SELECTED RESOLUTION METHOD (weapon_stats or experience_stats) FROM COMBAT OPTIONS    
    combatOptions = state['battlefield'].get('combatOptions')
    resolutionMethod = combatOptions.get('resolutionMethod') if combatOptions else 'weapon_stats'
    savingThrowsMethod = combatOptions.get('savingThrowsMethod') if combatOptions else 'no_saving'
    add_log(state, f" Combat mode {resolutionMethod} Saving throws mode: {savingThrowsMethod} ")


    defenderHasReacted=False
    # Defender in overwatch reacts before the melee attacker resolves the attack.
    # Guard with allow_reaction to avoid recursive reaction loops.
    if allow_reaction and target.get('status') == 'overwatch' and target.get('overwatch_ready'):
        add_log(state, f"{target['name']} reacts from OVERWATCH against {attacker['name']} before melee")
        target['overwatch_ready'] = False
        target['status'] = 'reacted'
        target['acted'] = True
        reaction_result = resolve_attack(
            state,
            target,
            attacker,
            attacker['position']['x'],
            attacker['position']['y'],
            'attack',
            melee_resolution,
            allow_reaction=False,
        )
        defenderHasReacted=True
        add_log(state, f"CounterOverwatchMelee -> {reaction_result.get('status')}")
        if reaction_result.get('status') == 'killed':
            return {'status': 'attacker_killed_by_reaction', 'damage': 0, 'cover_bonus': 0}

    weapon=attacker.get('weapon') or DEFAULT_WEAPON
    attackerFigures = attacker.get('n_of_figures', 1)


    acc = weapon.get('accuracy') - weapon.get('recoil_penalty',0.0) 
    acc = max(0.05, min(0.95, acc))

    #if charge, apply +10% accuracy bonus (not for reaction, as in this case 'attack' is forced)
    if action == 'charge':
        acc = min(0.95, acc + 0.10)
        add_log(state, f"Charge: +10% accuracy bonus applied. New accuracy: {acc:.2f}")

    if attacker.get('stress', 0) > 0:
        acc = max(0.05, acc - 0.10)  # -10% accuracy if attacker is stressed
        add_log(state, f"Attacker is stressed: -10% accuracy penalty applied. New accuracy: {acc:.2f}")
        
    if target['armor'] > 0:
        #an anti-tank weapon will generate at list 1 damage even if the armor negate the damage
        dmg = max(1, attacker['weapon']['armouredDmg'] - target['armor']  + (1 if attacker.get('steady') else 0))
    else:
        dmg = attacker['weapon']['damage'] + (1 if attacker.get('steady') else 0)

    # melee attack with shooting weapon suffers accuracy malus but can still hit with low damage  
    if weapon.get('range', 1) > 1:
        malus=True
        dmg = 1
    else:
        malus=False

    cover_bonus = 1 if tile_type(state, at_x, at_y) == 'cover' else 0

    someHit=False
    for f in range(max(1, int(attackerFigures))):
        for a in range(attacker.get('n_of_attacks', 1)):
            aResult = RNG.random()
            hit = aResult <= acc
            if hit:
                someHit = True
                add_log(state, f"{attacker['name']} Figure {f+1} Attack {a+1}:  hits {target['name']}  {aResult:.2f} <= {acc:.2f}")

                #veteran or more get hits on  D6=5+, seasoned on 4+, green on 3+
                toDamage = 5 
                if target['experience'] == 'green':
                    toDamage = 3
                if target['experience'] == 'seasoned':
                    toDamage = 4  
                diceToDamage= random.randint(1,6)
                if diceToDamage >= toDamage or (savingThrowsMethod == 'no_saving'):

                    if malus:
                        dmg = max(1, round(dmg / 2))  # apply malus to damage
                    damage = dmg
                    effective_shields = target.get('shields', 0) + cover_bonus
                    if effective_shields > 0:
                        used = min(effective_shields, damage)
                        persist = target.get('shields', 0)
                        if persist >= used:
                            target['shields'] = persist - used
                        else:
                            target['shields'] = 0
                        damage -= used
                    if damage > 0:
                        target['hp'] -= damage
                        add_log(state, f"{attacker['name']} Figure {f+1} Attack {a+1}:  hits {target['name']} for {damage} damage!")

                    if target['hp'] <= 0:
                        if target['n_of_figures'] > 1:
                            target['n_of_figures'] -= 1
                            target['hp'] = target['max_hp']
                            add_log(state, f"{target['name']} loses a figure but is still standing with {target['n_of_figures']} figures left!") 
                        else:
                            side_t = target['team']
                            state[side_t]['units'] = [x for x in state[side_t]['units'] if x['id'] != target['id']]
                            check_victory(state)
                            return {'status': 'killed', 'damage': damage, 'cover_bonus': cover_bonus}
                else:
                    add_log(state, f"Damage roll {diceToDamage} < {toDamage} [{target['experience']}], so no damage applies!")        
            else:
                add_log(state, f"{attacker['name']} Figure {f+1} Attack {a+1}:  misses {target['name']}  {aResult:.2f} > {acc:.2f}")           
    add_log(state, f"END OF {attacker['name']} ATTACK")
    if melee_resolution and allow_reaction and not defenderHasReacted:
        add_log(state, f"{target['name']} fights against {attacker['name']} in melee")
        target['overwatch_ready'] = False
        target['status'] = 'reacted'
        target['acted'] = True
        reaction_result = resolve_attack(
            state,
            target,
            attacker,
            attacker['position']['x'],
            attacker['position']['y'],
            'attack',
            melee_resolution,
            allow_reaction=False,
        )
        defenderHasReacted=True
        add_log(state, f"Defender Melee -> {reaction_result.get('status')}")
        if reaction_result.get('status') == 'killed':
            return {'status': 'attacker_killed_in_melee', 'damage': 0, 'cover_bonus': 0}        

    if not someHit:
            return {'status': 'missed', 'damage': 0, 'cover_bonus': 0}
    else:
            target['stress'] = target.get('stress', 0) + 1  # increase stress on hit
            return {'status': 'hit', 'damage': damage, 'cover_bonus': cover_bonus}


def trigger_overwatch_reactions(state, moving_unit, step_x, step_y):
    enemy_side = 'red' if moving_unit['team']=='blue' else 'blue'
    enemies = state[enemy_side]['units']
    for s in enemies:
        # if unit is killed by a previous overwatch reaction, other units should not react to it anymore
        if moving_unit['hp'] > 0 and s['status'] == 'overwatch' and s.get('overwatch_ready') and s['weapon']['ammo']>0:
            ux, uy = s['position']['x'], s['position']['y']
            man = range_distance(state, ux, uy, step_x, step_y)
            if 1 <= man <= s['weapon']['range']:
                los_ok, _ ,pathStr  = los_clear_and_cover(state, ux, uy, step_x, step_y)
                if los_ok:
                    res = resolve_shot(state, s, moving_unit, step_x, step_y, reaction=True,dices=None,mode = None)
                    add_log(state, f"OverwatchShooting -> {res}")
                    s['overwatch_ready'] = False
                    s['status'] = 'reacted'  # reset overwatch status after reaction shot
                    s['acted'] = True  # mark as acted 
                    if res == 'killed':
                        return 'killed'
                    if res == 'stopped':
                        return 'stopped'
                    
    return 'continue'