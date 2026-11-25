// Tuning for every drivable car. Numbers are initial physical values; the garage
// measures 0-60 and braking by running the same simulation used in play.

import { ABILITIES, type AbilityId } from './abilityInfo';
export type { AbilityId } from './abilityInfo';

export type CarId =
  | 'finch' | 'vesper' | 'foundry' | 'kestrel' | 'northline' | 'meridian'
  | 'comet' | 'bandit' | 'hauler' | 'sprite' | 'dune' | 'monarch' | 'lancer' | 'mammoth'
  | 'wraith' | 'swallow' | 'harbor' | 'vandal' | 'volt' | 'havoc' | 'ambler' | 'rattler' | 'zenith'
  | 'cruiser' | 'interceptor' | 'tank' | 'warden';
export type Drive = 'FWD' | 'RWD' | 'AWD';
export type EngineVoice = 'i4' | 'v6' | 'v8' | 'ev' | 'turbo4' | 'v10';

export interface CarSpec {
  id: CarId;
  name: string;
  klass: string;
  feel: string;
  ability: AbilityId;
  abilityName: string;
  abilityLine: string;
  // chassis
  mass: number;
  wheelbase: number;
  frontWeight: number; // static fraction of weight on the front axle
  cgHeight: number;
  track: number;
  length: number;
  width: number;
  height: number;
  wheelRadius: number;
  inertiaScale: number;
  // drivetrain
  drive: Drive;
  frontSplit: number; // AWD torque fraction to the front
  power: number; // W at the wheels
  tractionCap: number; // max drive force N (low-speed torque)
  topSpeed: number; // m/s, sets aero drag
  gears: number[]; // overall ratios (gear * final drive); a single entry means direct drive
  idleRpm: number;
  redline: number;
  // brakes and tires
  brakeForce: number; // N at full pedal
  brakeBias: number; // front share
  muFront: number;
  muRear: number;
  peakSlipFront: number; // rad
  peakSlipRear: number;
  slideGrip: number; // fraction of peak grip kept deep in a slide
  slideFalloff: number; // how quickly grip falls past the peak
  handbrakeGrip: number; // rear grip multiplier with the handbrake on
  offroadGrip: number;
  yawDamping: number;
  tcSlip: number; // rear slip (rad) where traction control starts easing drive
  // steering
  steerMax: number; // rad at standstill
  steerSpeedRef: number; // m/s where steering lock halves
  steerRate: number; // rad/s ramp-in
  // arcade handling
  accel: number; // m/s^2 at launch
  accelCurve: number; // higher = keeps pulling closer to top speed
  turn: number; // rad/s peak yaw rate
  grip: number; // 1/s lateral slip decay
  aLat: number; // m/s^2 cornering limit
  brakeDecel: number; // m/s^2
  driftCharge: number; // mini-turbo charge rate multiplier
  // extras
  nitroForce: number;
  suspension: number; // visual body motion scale
  engine: EngineVoice;
  cylinders: number;
  paints: string[];
  unlock: { credits: number; medals: number } | null;
  playable: boolean;
  /** Hit points before the car is totaled. */
  durability: number;
  /** Aerodynamic drag relative to an ordinary car (the Zenith is slippery). */
  dragScale?: number;
}

const base = {
  inertiaScale: 1,
  frontSplit: 0,
  slideFalloff: 1.2,
  handbrakeGrip: 0.3,
  offroadGrip: 0.72,
  yawDamping: 0.05,
  tcSlip: 0.28,
  suspension: 1,
  playable: true,
  durability: 100,
};


/** Derive a new car from an existing chassis with its own numbers. */
function variant(from: CarSpec, o: Partial<CarSpec> & Pick<CarSpec, 'id' | 'name' | 'klass' | 'feel' | 'ability' | 'paints'>): CarSpec {
  return { ...from, unlock: null, playable: true, ...o, abilityName: '', abilityLine: '' };
}

const CORE: Record<'finch' | 'vesper' | 'foundry' | 'kestrel' | 'northline' | 'meridian' | 'cruiser' | 'interceptor' | 'tank' | 'warden', CarSpec> = {
  finch: {
    ...base,
    id: 'finch',
    durability: 80,
    accel: 9, accelCurve: 2.2, turn: 2.7, grip: 13, aLat: 21, brakeDecel: 17, driftCharge: 1.0, name: 'Finch RS', klass: 'Hot hatch',
    feel: 'Light and darty: the tightest turning car, modest top speed.',
    ability: 'apexGrip', abilityName: 'Apex Grip',
    abilityLine: 'Front tires bite harder for 2 seconds — fire it at turn-in to hold a tight line.',
    mass: 1180, wheelbase: 2.5, frontWeight: 0.61, cgHeight: 0.5, track: 1.52,
    length: 4.05, width: 1.78, height: 1.44, wheelRadius: 0.31, inertiaScale: 0.86,
    drive: 'FWD', power: 158000, tractionCap: 9000, topSpeed: 58,
    gears: [13.8, 8.9, 6.4, 5.0, 4.0, 3.3], idleRpm: 900, redline: 7200,
    brakeForce: 13500, brakeBias: 0.66, muFront: 1.12, muRear: 1.1,
    peakSlipFront: 0.11, peakSlipRear: 0.12, slideGrip: 0.8, slideFalloff: 1.0,
    steerMax: 0.62, steerSpeedRef: 21, steerRate: 4.2,
    nitroForce: 3600, engine: 'i4', cylinders: 4, handbrakeGrip: 0.42,
    paints: ['#e2b53a', '#d7d9db', '#2c6fd1', '#1b1d22', '#3f8f5a'],
    unlock: null,
  },
  vesper: {
    ...base,
    id: 'vesper',
    durability: 90,
    accel: 9.5, accelCurve: 2.0, turn: 2.45, grip: 11, aLat: 20, brakeDecel: 17, driftCharge: 1.25, name: 'Vesper GT', klass: 'Rear-drive coupe',
    feel: 'Long-legged coupe that drifts early and charges mini-turbos fastest.',
    ability: 'overdrive', abilityName: 'Overdrive',
    abilityLine: 'Opens up the engine for 3 seconds: more pull and a higher top speed. Recharges in 12 seconds.',
    mass: 1420, wheelbase: 2.68, frontWeight: 0.52, cgHeight: 0.47, track: 1.56,
    length: 4.45, width: 1.86, height: 1.3, wheelRadius: 0.33,
    drive: 'RWD', power: 235000, tractionCap: 10400, topSpeed: 70,
    gears: [12.6, 8.2, 6.0, 4.7, 3.8, 3.1], idleRpm: 800, redline: 7000,
    brakeForce: 16500, brakeBias: 0.62, muFront: 1.1, muRear: 1.04,
    peakSlipFront: 0.11, peakSlipRear: 0.115, slideGrip: 0.86, slideFalloff: 0.7,
    steerMax: 0.6, steerSpeedRef: 22, steerRate: 3.6, handbrakeGrip: 0.2, tcSlip: 0.62,
    nitroForce: 4200, engine: 'v6', cylinders: 6,
    paints: ['#b3202a', '#e9e5dc', '#14181f', '#5b6770', '#1f4f8a'],
    unlock: null,
  },
  foundry: {
    ...base,
    id: 'foundry',
    durability: 135,
    accel: 10.5, accelCurve: 1.4, turn: 2.0, grip: 10, aLat: 18, brakeDecel: 13.5, driftCharge: 1.0, name: 'Foundry V8', klass: 'Muscle car',
    feel: 'Strong low-end torque, long braking distance, heavy nose.',
    ability: 'secondWind', abilityName: 'Second Wind',
    abilityLine: 'A 3-second surge that builds the longer you hold a straight line; hard turning bleeds it.',
    mass: 1720, wheelbase: 2.86, frontWeight: 0.53, cgHeight: 0.53, track: 1.6,
    length: 4.85, width: 1.94, height: 1.36, wheelRadius: 0.34, inertiaScale: 1.12,
    drive: 'RWD', power: 300000, tractionCap: 13600, topSpeed: 72,
    gears: [10.9, 7.0, 5.0, 3.9, 3.2], idleRpm: 700, redline: 6200,
    brakeForce: 14200, brakeBias: 0.64, muFront: 1.0, muRear: 1.1,
    peakSlipFront: 0.13, peakSlipRear: 0.12, slideGrip: 0.8, slideFalloff: 1.0,
    steerMax: 0.55, steerSpeedRef: 19, steerRate: 2.9, handbrakeGrip: 0.28,
    nitroForce: 4600, engine: 'v8', cylinders: 8, suspension: 1.25,
    paints: ['#1d4a2e', '#c25a17', '#101113', '#d9d4c6', '#6b1520'],
    unlock: { credits: 1800, medals: 2 },
  },
  kestrel: {
    ...base,
    id: 'kestrel',
    durability: 110,
    accel: 10.8, accelCurve: 3.0, turn: 2.1, grip: 13, aLat: 19.5, brakeDecel: 18, driftCharge: 0.9, name: 'Kestrel E', klass: 'Electric sedan',
    feel: 'Instant acceleration, stable chassis, heavy in quick direction changes.',
    ability: 'overclock', abilityName: 'Overclock',
    abilityLine: 'Spend the capacitor on up to 2 seconds of electric thrust; clean braking charges it back.',
    mass: 2080, wheelbase: 2.92, frontWeight: 0.49, cgHeight: 0.46, track: 1.62,
    length: 4.9, width: 1.92, height: 1.42, wheelRadius: 0.34, inertiaScale: 1.32,
    drive: 'AWD', frontSplit: 0.45, power: 300000, tractionCap: 19500, topSpeed: 66,
    gears: [9.0], idleRpm: 0, redline: 16000,
    brakeForce: 22500, brakeBias: 0.6, muFront: 1.06, muRear: 1.08,
    peakSlipFront: 0.12, peakSlipRear: 0.11, slideGrip: 0.84, slideFalloff: 1.1,
    steerMax: 0.56, steerSpeedRef: 21, steerRate: 2.8, handbrakeGrip: 0.4, yawDamping: 0.16,
    nitroForce: 4300, engine: 'ev', cylinders: 0, suspension: 0.7,
    paints: ['#d8dde2', '#28323c', '#3b7c8f', '#7a1f2b', '#0f0f12'],
    unlock: { credits: 2400, medals: 3 },
  },
  northline: {
    ...base,
    id: 'northline',
    durability: 120,
    accel: 9.5, accelCurve: 2.0, turn: 2.4, grip: 12, aLat: 20, brakeDecel: 16, driftCharge: 1.05, name: 'Northline RX', klass: 'Rally wagon',
    feel: 'All-wheel drive on soft springs: barely slows on grass and gravel, loves airtime.',
    ability: 'rallyHop', abilityName: 'Rally Hop',
    abilityLine: 'A controlled hop anywhere: launch off a crest for huge air; land square to keep your speed.',
    mass: 1480, wheelbase: 2.66, frontWeight: 0.57, cgHeight: 0.56, track: 1.56,
    length: 4.6, width: 1.82, height: 1.5, wheelRadius: 0.33,
    drive: 'AWD', frontSplit: 0.4, power: 200000, tractionCap: 11600, topSpeed: 62,
    gears: [13.2, 8.6, 6.2, 4.9, 3.9, 3.2], idleRpm: 850, redline: 7000,
    brakeForce: 17800, brakeBias: 0.6, muFront: 1.1, muRear: 1.08,
    peakSlipFront: 0.12, peakSlipRear: 0.12, slideGrip: 0.86, slideFalloff: 0.8,
    steerMax: 0.6, steerSpeedRef: 21, steerRate: 3.6, handbrakeGrip: 0.26, offroadGrip: 0.93,
    nitroForce: 4000, engine: 'turbo4', cylinders: 4, suspension: 1.55,
    paints: ['#1f5fa8', '#e7e2d3', '#8b2f20', '#2d3b2a', '#c9a227'],
    unlock: { credits: 3600, medals: 5 },
  },
  meridian: {
    ...base,
    id: 'meridian',
    durability: 80,
    accel: 10.6, accelCurve: 2.4, turn: 2.5, grip: 12.5, aLat: 22, brakeDecel: 18, driftCharge: 1.0, name: 'Meridian S', klass: 'Mid-engine exotic',
    feel: 'Fastest at the top end, expensive mistakes, responsive to precise inputs.',
    ability: 'focus', abilityName: 'Focus',
    abilityLine: 'Slows the whole driving world for a moment while your steering stays crisp.',
    mass: 1390, wheelbase: 2.6, frontWeight: 0.42, cgHeight: 0.42, track: 1.64,
    length: 4.5, width: 1.98, height: 1.16, wheelRadius: 0.34, inertiaScale: 0.9,
    drive: 'RWD', power: 420000, tractionCap: 13800, topSpeed: 88,
    gears: [12.0, 8.1, 6.0, 4.8, 3.9, 3.25, 2.75], idleRpm: 1000, redline: 8600,
    brakeForce: 21500, brakeBias: 0.58, muFront: 1.2, muRear: 1.26,
    peakSlipFront: 0.1, peakSlipRear: 0.095, slideGrip: 0.72, slideFalloff: 1.5,
    steerMax: 0.58, steerSpeedRef: 24, steerRate: 4.6, handbrakeGrip: 0.26,
    nitroForce: 4800, engine: 'v10', cylinders: 10, suspension: 0.8,
    paints: ['#e8e3d8', '#f0682a', '#1c1c20', '#2563c9', '#7d2fbf'],
    unlock: { credits: 7000, medals: 8 },
  },
  cruiser: {
    ...base,
    id: 'cruiser',
    accel: 9, accelCurve: 2.0, turn: 2.2, grip: 12, aLat: 19, brakeDecel: 17, driftCharge: 1, name: 'Patrol Cruiser', klass: 'Police', feel: '', ability: 'none', abilityName: '', abilityLine: '',
    mass: 1750, wheelbase: 2.9, frontWeight: 0.55, cgHeight: 0.55, track: 1.6,
    length: 5.0, width: 1.92, height: 1.5, wheelRadius: 0.34, inertiaScale: 1.1,
    drive: 'AWD', frontSplit: 0.4, power: 215000, tractionCap: 13000, topSpeed: 56,
    gears: [11.5, 7.4, 5.4, 4.2, 3.4, 2.9], idleRpm: 750, redline: 6400,
    brakeForce: 19000, brakeBias: 0.62, muFront: 1.04, muRear: 1.04,
    peakSlipFront: 0.12, peakSlipRear: 0.12, slideGrip: 0.82, slideFalloff: 1.0,
    steerMax: 0.58, steerSpeedRef: 21, steerRate: 3.4, nitroForce: 0, engine: 'v6', cylinders: 6,
    paints: ['#16243a'], unlock: null, playable: false, yawDamping: 0.12,
  },
  interceptor: {
    ...base,
    id: 'interceptor',
    accel: 10.5, accelCurve: 2.2, turn: 2.3, grip: 12.5, aLat: 20.5, brakeDecel: 18, driftCharge: 1, name: 'Interceptor', klass: 'Police', feel: '', ability: 'none', abilityName: '', abilityLine: '',
    mass: 1600, wheelbase: 2.8, frontWeight: 0.53, cgHeight: 0.48, track: 1.62,
    length: 4.8, width: 1.95, height: 1.32, wheelRadius: 0.34,
    drive: 'AWD', frontSplit: 0.35, power: 320000, tractionCap: 15000, topSpeed: 72,
    gears: [11.0, 7.2, 5.3, 4.2, 3.4, 2.9], idleRpm: 800, redline: 7000,
    brakeForce: 21000, brakeBias: 0.6, muFront: 1.12, muRear: 1.12,
    peakSlipFront: 0.11, peakSlipRear: 0.11, slideGrip: 0.84, slideFalloff: 1.0,
    steerMax: 0.6, steerSpeedRef: 23, steerRate: 3.8, nitroForce: 0, engine: 'v8', cylinders: 8,
    paints: ['#0d0f14'], unlock: null, playable: false, yawDamping: 0.12,
  },
  warden: {
    ...base,
    id: 'warden',
    accel: 12, accelCurve: 2.4, turn: 2.45, grip: 13.5, aLat: 22, brakeDecel: 19, driftCharge: 1, name: 'Warden', klass: 'Police', feel: '', ability: 'none', abilityName: '', abilityLine: '',
    mass: 1650, wheelbase: 2.9, frontWeight: 0.52, cgHeight: 0.46, track: 1.7,
    length: 4.9, width: 2.02, height: 1.3, wheelRadius: 0.35,
    drive: 'AWD', frontSplit: 0.4, power: 450000, tractionCap: 17000, topSpeed: 88,
    gears: [10.8, 7.1, 5.2, 4.1, 3.3, 2.75, 2.35], idleRpm: 850, redline: 7600,
    brakeForce: 23000, brakeBias: 0.6, muFront: 1.16, muRear: 1.16,
    peakSlipFront: 0.11, peakSlipRear: 0.11, slideGrip: 0.85, slideFalloff: 1.0,
    steerMax: 0.6, steerSpeedRef: 24, steerRate: 4, nitroForce: 0, engine: 'v8', cylinders: 8,
    paints: ['#0b0b0d'], unlock: null, playable: false, yawDamping: 0.12, durability: 160,
  },
  tank: {
    ...base,
    id: 'tank',
    accel: 6.5, accelCurve: 1.6, turn: 1.6, grip: 11, aLat: 14, brakeDecel: 12, driftCharge: 1, name: 'Armored Unit', klass: 'Police', feel: '', ability: 'none', abilityName: '', abilityLine: '',
    mass: 9500, wheelbase: 3.6, frontWeight: 0.55, cgHeight: 1.0, track: 2.1,
    length: 6.4, width: 2.55, height: 2.7, wheelRadius: 0.58, inertiaScale: 1.3,
    drive: 'AWD', frontSplit: 0.5, power: 420000, tractionCap: 60000, topSpeed: 38,
    gears: [9.5, 6.4, 4.6, 3.5, 2.8], idleRpm: 600, redline: 4200,
    brakeForce: 90000, brakeBias: 0.6, muFront: 1.0, muRear: 1.0,
    peakSlipFront: 0.12, peakSlipRear: 0.12, slideGrip: 0.85, slideFalloff: 1.0,
    steerMax: 0.5, steerSpeedRef: 18, steerRate: 2.6, nitroForce: 0, engine: 'v8', cylinders: 8,
    paints: ['#1d2530'], unlock: null, playable: false, yawDamping: 0.2, durability: 1000,
  },
};

const { finch, vesper, foundry, kestrel, northline, meridian } = CORE;

const MORE: Record<Exclude<CarId, keyof typeof CORE>, CarSpec> = {
  comet: variant(kestrel, {
    id: 'comet', name: 'Comet X', klass: 'Electric hypercar', durability: 90,
    feel: 'Silent, savage launch and a top speed only the Lancer beats. Light nose at the limit.',
    ability: 'blink', topSpeed: 92, accel: 12.5, accelCurve: 2.8, turn: 2.35, grip: 13, aLat: 22.5, brakeDecel: 19, driftCharge: 1.05,
    mass: 1650, length: 4.6, width: 2.0, height: 1.18, wheelRadius: 0.35, nitroForce: 5200, suspension: 0.6,
    paints: ['#e9edf2', '#11161d', '#4cc3ff', '#c3ff3a', '#ff3a7a'],
  }),
  bandit: variant(foundry, {
    id: 'bandit', name: 'Bandit 77', klass: "'70s muscle", durability: 140,
    feel: 'Big-block torque and a loose tail: drifts forever, stops late.',
    ability: 'smokeScreen', topSpeed: 76, accel: 11, accelCurve: 1.5, turn: 1.95, grip: 9.5, aLat: 17, brakeDecel: 13, driftCharge: 1.25,
    mass: 1700, length: 5.0, width: 1.95, height: 1.4, wheelRadius: 0.36, nitroForce: 5000, suspension: 1.3,
    paints: ['#101113', '#c8a24a', '#7a1414', '#e9e2d0', '#1d3d7a'],
  }),
  hauler: variant(foundry, {
    id: 'hauler', name: 'Hauler 2500', klass: 'Pickup truck', durability: 170,
    feel: 'Heavy and tall: shrugs off rams, rolls in corners, flies over crests like a sofa.',
    ability: 'shockwave', topSpeed: 64, accel: 9.5, accelCurve: 1.5, turn: 2.0, grip: 10, aLat: 16.5, brakeDecel: 13, driftCharge: 0.95,
    mass: 2400, length: 5.6, width: 2.05, height: 1.95, wheelRadius: 0.42, nitroForce: 5600, suspension: 1.6, offroadGrip: 0.9,
    paints: ['#8b1e1e', '#e6e2d6', '#2b3a2a', '#1a1c20', '#c7782a'],
  }),
  sprite: variant(finch, {
    id: 'sprite', name: 'Sprite', klass: 'Kei microcar', durability: 60,
    feel: 'A shoebox with a turbo: turns on a dime, darts through traffic, made of paper.',
    ability: 'tripleBoost', topSpeed: 54, accel: 10, accelCurve: 2.4, turn: 3.05, grip: 14, aLat: 21, brakeDecel: 18, driftCharge: 1.15,
    mass: 760, length: 3.4, width: 1.48, height: 1.65, wheelRadius: 0.27, nitroForce: 2600, suspension: 1.2,
    paints: ['#f4c542', '#7fd1c7', '#f08aa8', '#f2f0ea', '#3a72c9'],
  }),
  dune: variant(northline, {
    id: 'dune', name: 'Dune Runner', klass: 'Dune buggy', durability: 95,
    feel: 'Long-travel springs: grass, gravel and air are home. Squirmy on fast asphalt.',
    ability: 'moonJump', topSpeed: 64, accel: 10.5, accelCurve: 2.0, turn: 2.65, grip: 11, aLat: 18.5, brakeDecel: 15, driftCharge: 1.2,
    mass: 980, length: 3.9, width: 1.9, height: 1.75, wheelRadius: 0.45, nitroForce: 3400, suspension: 1.9, offroadGrip: 1.0,
    paints: ['#ff8a1e', '#2f8f4e', '#e9e2d0', '#1d6fd1', '#d12c2c'],
  }),
  monarch: variant(vesper, {
    id: 'monarch', name: 'Monarch V12', klass: 'Grand tourer', durability: 120,
    feel: 'Long, plush and very fast: stable at three figures, heavy when you change your mind.',
    ability: 'bubbleShield', topSpeed: 85, accel: 10.6, accelCurve: 2.2, turn: 2.2, grip: 11.5, aLat: 20, brakeDecel: 17, driftCharge: 1.0,
    mass: 1820, length: 4.9, width: 1.96, height: 1.34, wheelRadius: 0.36, nitroForce: 5400, suspension: 0.9, engine: 'v10', cylinders: 12,
    paints: ['#2a3550', '#d8d2c4', '#5b1020', '#101418', '#3d6b56'],
  }),
  lancer: variant(meridian, {
    id: 'lancer', name: 'Lancer LMP', klass: 'Le Mans prototype', durability: 75,
    feel: 'The fastest thing here. Huge grip and downforce at speed; one mistake ends it.',
    ability: 'timeWarp', topSpeed: 96, accel: 11.8, accelCurve: 2.6, turn: 2.4, grip: 14, aLat: 24.5, brakeDecel: 21, driftCharge: 0.95,
    mass: 980, length: 4.9, width: 2.0, height: 1.05, wheelRadius: 0.36, nitroForce: 5000, suspension: 0.5,
    paints: ['#f0f0ea', '#e5262a', '#0f1a2c', '#ffcc00', '#00a37a'],
  }),
  mammoth: variant(northline, {
    id: 'mammoth', name: 'Mammoth', klass: 'Monster truck', durability: 220,
    feel: 'Six-foot tires. Slow to turn, impossible to stop, and it lands everything.',
    ability: 'superstar', topSpeed: 60, accel: 9.2, accelCurve: 1.6, turn: 2.05, grip: 10, aLat: 15, brakeDecel: 12, driftCharge: 1.0,
    mass: 3200, length: 4.8, width: 2.6, height: 2.5, wheelRadius: 0.85, nitroForce: 7600, suspension: 2.2, offroadGrip: 1.0, engine: 'v8', cylinders: 8,
    paints: ['#2c7be5', '#e5262a', '#1a1c20', '#79d98a', '#ff8a1e'],
  }),
  wraith: variant(vesper, {
    id: 'wraith', name: 'Wraith', klass: 'Stealth coupe', durability: 90,
    feel: 'Matte, quiet and quick: sharp turn-in and a tail that steps out on command.',
    ability: 'phantom', topSpeed: 82, accel: 11, accelCurve: 2.2, turn: 2.45, grip: 12, aLat: 21, brakeDecel: 18, driftCharge: 1.2,
    mass: 1480, length: 4.6, width: 1.95, height: 1.28, wheelRadius: 0.34, nitroForce: 4800, suspension: 0.8,
    paints: ['#1a1c20', '#3b3f46', '#5d6a7a', '#2b1f3d', '#e8e8e8'],
  }),
  swallow: variant(finch, {
    id: 'swallow', name: 'Swallow Spyder', klass: 'Open roadster', durability: 75,
    feel: 'Tiny, open-top and eager: the best balance in the garage and a hook for every tree.',
    ability: 'grapple', topSpeed: 72, accel: 10.2, accelCurve: 2.3, turn: 2.8, grip: 13.5, aLat: 22, brakeDecel: 18, driftCharge: 1.1,
    mass: 1020, length: 4.0, width: 1.78, height: 1.2, wheelRadius: 0.32, nitroForce: 3600, suspension: 0.9, engine: 'turbo4',
    paints: ['#b3202a', '#1f5f4a', '#e9e5dc', '#f2c23a', '#1c2a4a'],
  }),
  harbor: variant(foundry, {
    id: 'harbor', name: 'Harbor Camper', klass: 'Camper van', durability: 160,
    feel: 'A pop-top on wheels: leans like a boat, gets there eventually, leaves a mess behind.',
    ability: 'oilSlick', topSpeed: 56, accel: 8.6, accelCurve: 1.8, turn: 2.0, grip: 10, aLat: 15, brakeDecel: 13, driftCharge: 1.0,
    mass: 2500, length: 5.0, width: 2.0, height: 2.15, wheelRadius: 0.36, nitroForce: 5200, suspension: 1.8, engine: 'i4', cylinders: 4,
    paints: ['#7fc6c9', '#e98a3c', '#c84b4b', '#e9e2d0', '#6b8f4a'],
  }),
  vandal: variant(northline, {
    id: 'vandal', name: 'Vandal R', klass: 'Rally hatch', durability: 105,
    feel: 'A homologation special: big wing, sharp diff, and wings of a different kind.',
    ability: 'glider', topSpeed: 70, accel: 10.8, accelCurve: 2.2, turn: 2.7, grip: 13, aLat: 21, brakeDecel: 17, driftCharge: 1.15,
    mass: 1250, length: 4.2, width: 1.85, height: 1.5, wheelRadius: 0.33, nitroForce: 4200, suspension: 1.4, offroadGrip: 0.95,
    paints: ['#f2f0ea', '#1f5fa8', '#d12c2c', '#2d3b2a', '#ffcc00'],
  }),
  volt: variant(kestrel, {
    id: 'volt', name: 'Volt Pod', klass: 'Electric city car', durability: 80,
    feel: 'Instant torque, a tiny footprint and an EMP for anyone who follows too close.',
    ability: 'emp', topSpeed: 60, accel: 11.2, accelCurve: 2.6, turn: 2.9, grip: 13.5, aLat: 20, brakeDecel: 18, driftCharge: 1.0,
    mass: 1100, length: 3.6, width: 1.7, height: 1.6, wheelRadius: 0.3, nitroForce: 3200, suspension: 0.8,
    paints: ['#e8f4f0', '#3ad0a0', '#2563c9', '#ffd23a', '#2a2d33'],
  }),
  havoc: variant(foundry, {
    id: 'havoc', name: 'Havoc', klass: 'Armored SUV', durability: 200,
    feel: 'Plated, heavy and angry. Rams first, asks questions with a missile.',
    ability: 'homingMissile', topSpeed: 68, accel: 10, accelCurve: 1.6, turn: 2.0, grip: 10.5, aLat: 17, brakeDecel: 14, driftCharge: 0.95,
    mass: 2700, length: 5.1, width: 2.1, height: 1.95, wheelRadius: 0.42, nitroForce: 6400, suspension: 1.3, offroadGrip: 0.92,
    paints: ['#3b4235', '#1a1c20', '#5b5f63', '#6b4a2a', '#e6e2d6'],
  }),
  ambler: variant(foundry, {
    id: 'ambler', name: 'Ambler', klass: 'Woodie wagon', durability: 130,
    feel: 'A long, soft family wagon with a toolbox in the back for running repairs.',
    ability: 'patchKit', topSpeed: 62, accel: 9.2, accelCurve: 1.8, turn: 2.2, grip: 11, aLat: 18, brakeDecel: 15, driftCharge: 1.05,
    mass: 1750, length: 5.0, width: 1.9, height: 1.55, wheelRadius: 0.34, nitroForce: 4400, suspension: 1.5, engine: 'v6', cylinders: 6,
    paints: ['#e9dcc0', '#7a2a24', '#2b4a3a', '#3a5a8a', '#c9a227'],
  }),
  zenith: variant(meridian, {
    id: 'zenith', name: 'Zenith 400', klass: 'Land-speed hypercar', durability: 250,
    feel: 'The last word: 400 mph flat out, the best grip and brakes in the garage, and armor to match. Every other car is slower at everything.',
    ability: 'overdrive', topSpeed: 128.9, accel: 15.7, accelCurve: 3.0, dragScale: 0.35, turn: 2.75, grip: 15, aLat: 27, brakeDecel: 24, driftCharge: 1.3,
    mass: 1250, wheelbase: 3.15, length: 5.2, width: 2.06, height: 1.12, wheelRadius: 0.36, nitroForce: 7000, suspension: 0.45,
    power: 1100000, tractionCap: 26000, drive: 'AWD', frontSplit: 0.4, steerMax: 0.6, steerSpeedRef: 30, steerRate: 5,
    gears: [9.5, 6.4, 4.8, 3.8, 3.0, 2.45, 2.0, 1.7], idleRpm: 1100, redline: 9200, engine: 'v10', cylinders: 16,
    paints: ['#f2f2ee', '#0d0f14', '#ff3b2f', '#2f6bff', '#d4af37'],
  }),
  rattler: variant(foundry, {
    id: 'rattler', name: 'Rattler', klass: 'Hot rod', durability: 100,
    feel: 'All engine. Wheelies off the line, snakes under power, and drops spikes for the cops.',
    ability: 'caltrops', topSpeed: 75, accel: 12.2, accelCurve: 1.4, turn: 2.1, grip: 9.5, aLat: 17.5, brakeDecel: 14, driftCharge: 1.3,
    mass: 1150, length: 4.2, width: 1.8, height: 1.45, wheelRadius: 0.36, nitroForce: 4600, suspension: 1.1,
    paints: ['#101113', '#c41e3a', '#e9e2d0', '#2b6cb0', '#d9a21b'],
  }),
};

/**
 * Everything is a lot faster than the first build: top speeds about +50%,
 * launches +40%, more cornering grip and stronger brakes to match. The police
 * get the same treatment (their AI speed caps are raised alongside).
 */
export const SPEED_SCALE = { top: 1.5, accel: 1.4, aLat: 1.22, brake: 1.3, nitro: 1.5 };

export const CARS = { ...CORE, ...MORE } as Record<CarId, CarSpec>;
for (const c of Object.values(CARS)) {
  const k = c.id === 'tank' ? { ...SPEED_SCALE, top: 1.3, accel: 1.3 } : SPEED_SCALE;
  c.topSpeed *= k.top;
  c.accel *= k.accel;
  c.aLat *= k.aLat;
  c.brakeDecel *= k.brake;
  c.nitroForce *= k.nitro;
  if (c.ability !== 'none') {
    c.abilityName = ABILITIES[c.ability].name;
    c.abilityLine = ABILITIES[c.ability].line;
  }
}

/** Garage order: the original six, then the new garage, roughly slow to fast within type, and the Zenith last. */
export const PLAYER_CARS: CarId[] = [
  'finch', 'vesper', 'foundry', 'kestrel', 'northline', 'meridian',
  'sprite', 'volt', 'swallow', 'vandal', 'dune', 'rattler', 'bandit', 'wraith', 'monarch', 'comet', 'lancer',
  'ambler', 'harbor', 'hauler', 'havoc', 'mammoth', 'zenith',
];
/** Every car is in the base game. */
export const STARTER_CARS: CarId[] = [...PLAYER_CARS];
