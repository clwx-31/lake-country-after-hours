// Ability catalogue: names and one-line descriptions for the garage picker.
// Every car has a signature ability, and any car can equip any ability.

export type AbilityId =
  | 'apexGrip' | 'overdrive' | 'secondWind' | 'overclock' | 'rallyHop' | 'focus'
  | 'superstar' | 'grapple' | 'phantom' | 'shockwave' | 'oilSlick' | 'caltrops' | 'smokeScreen' | 'patchKit'
  | 'bubbleShield' | 'glider' | 'blink' | 'tripleBoost' | 'homingMissile' | 'emp' | 'moonJump' | 'timeWarp'
  | 'none';

export type AbilityTag = 'Speed' | 'Handling' | 'Air' | 'Defense' | 'Attack' | 'Escape';

export interface AbilityInfo {
  id: Exclude<AbilityId, 'none'>;
  name: string;
  tag: AbilityTag;
  line: string;
  color: string;
}

const list: AbilityInfo[] = [
  { id: 'superstar', name: 'Superstar', tag: 'Attack', color: '#ffd84a', line: 'Seven seconds invincible and faster: no damage, no flats, no arrest, and anything you hit goes flying.' },
  { id: 'grapple', name: 'Grapple Hook', tag: 'Handling', color: '#c9a36a', line: 'Fire a line at a tree, pole or car ahead and swing around it; let go (or it lets go) for a slingshot boost.' },
  { id: 'phantom', name: 'Phantom', tag: 'Escape', color: '#9fd8ff', line: 'Five seconds as a ghost: drive straight through traffic and police, who lose sight of you.' },
  { id: 'shockwave', name: 'Shockwave', tag: 'Attack', color: '#7ad7ff', line: 'A blast that throws every car within 35 m away, stalls police and knocks rockets out of the air.' },
  { id: 'oilSlick', name: 'Oil Slick', tag: 'Attack', color: '#6f6a5a', line: 'Dump a slick behind you. Police and rivals who drive over it spin out.' },
  { id: 'caltrops', name: 'Caltrops', tag: 'Attack', color: '#c8ccd0', line: 'Scatter spikes behind you. Chasers who hit them blow tires and fall back.' },
  { id: 'smokeScreen', name: 'Smoke Screen', tag: 'Escape', color: '#9a9a9a', line: 'Four seconds of thick smoke out the back. Police behind you lose sight through it.' },
  { id: 'patchKit', name: 'Patch Kit', tag: 'Defense', color: '#79d98a', line: 'Restore a third of your health and fix a flat tire, on the move.' },
  { id: 'bubbleShield', name: 'Bubble Shield', tag: 'Defense', color: '#8fd3ff', line: 'Ten seconds of shield that soaks up three hits: crashes, shots, spikes or rockets.' },
  { id: 'glider', name: 'Glider', tag: 'Air', color: '#e8e4d8', line: 'Pop out wings: a hop, then a long, steerable glide. Off a big crest it flies for ages.' },
  { id: 'blink', name: 'Blink', tag: 'Escape', color: '#c08bff', line: 'Teleport 40 m straight ahead, through anything in the way. Keeps your speed.' },
  { id: 'tripleBoost', name: 'Triple Boost', tag: 'Speed', color: '#ff7a3c', line: 'Three quick boosts, one per press. All three come back 14 seconds after the last.' },
  { id: 'homingMissile', name: 'Homing Missile', tag: 'Attack', color: '#ff4b4b', line: 'Locks onto the nearest police unit or rival ahead and knocks it out of the race.' },
  { id: 'emp', name: 'EMP', tag: 'Escape', color: '#5aa8ff', line: 'Police within 90 m stall, weapons and radar go dark, and the helicopter loses you for six seconds.' },
  { id: 'moonJump', name: 'Moon Jump', tag: 'Air', color: '#f2ede4', line: 'Launch straight up, very high. Clear roadblocks, spike strips and the car in front.' },
  { id: 'timeWarp', name: 'Time Warp', tag: 'Escape', color: '#b48cff', line: 'For four seconds everything but you runs at a third of the speed: traffic, police, rockets.' },
  { id: 'apexGrip', name: 'Apex Grip', tag: 'Handling', color: '#e2b53a', line: 'Front tires bite harder for 2 seconds. Fire it at turn-in to hold a tight line.' },
  { id: 'overdrive', name: 'Overdrive', tag: 'Speed', color: '#ff5a4a', line: 'Opens up the engine for 3 seconds: more pull and a higher top speed. Recharges in 12 seconds.' },
  { id: 'secondWind', name: 'Second Wind', tag: 'Speed', color: '#79d98a', line: 'A 3-second surge that builds the longer you hold a straight line; hard turning bleeds it.' },
  { id: 'overclock', name: 'Overclock', tag: 'Speed', color: '#7ad7ff', line: 'Spend the capacitor on up to 2 seconds of electric thrust; clean braking charges it back.' },
  { id: 'rallyHop', name: 'Rally Hop', tag: 'Air', color: '#c9a227', line: 'A controlled hop anywhere: launch off a crest for huge air; land square to keep your speed.' },
  { id: 'focus', name: 'Focus', tag: 'Handling', color: '#b8a6ff', line: 'Slows the whole driving world for a moment while your steering stays crisp.' },
];

export const ABILITIES = Object.fromEntries(list.map((a) => [a.id, a])) as Record<Exclude<AbilityId, 'none'>, AbilityInfo>;
/** Picker order: the new kart-style powers first, then the original six. */
export const ABILITY_IDS = list.map((a) => a.id) as AbilityId[];
