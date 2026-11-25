// Event catalogues, one per map. Routes are lists of real junctions (OSM node
// IDs) on the public street network; every venue name is fictional. Ironport's
// junction ids come from scripts/build-ironport.mjs (see `ip`). Event ids are
// unique across maps (they key saves, ghosts and the shared leaderboard).
import type { Medal } from '../save/Save';

/** Rule set an event runs under. */
export type EventKind = 'warmup' | 'circuit' | 'lastset' | 'air' | 'encore' | 'escape' | 'survive' | 'getaway';
export type EventId = string;

export interface EventDef {
  id: EventId;
  kind: EventKind;
  map: string;
  name: string;
  short: string;
  blurb: string;
  waypoints: number[];
  startAlong: number; // meters along the route for the start grid
  medals: Record<Medal, number>;
  lowerIsBetter: boolean;
  scoreLabel: string;
  color: number;
  timeLimit?: number;
  /** Circuit: laps (default 2) and whether the route closes on itself (default true). */
  laps?: number;
  loop?: boolean;
  /** Banner over the start (air) and the results line. */
  startLabel?: string;
  detail?: string;
  failDetail?: string;
  /** Encore: gate positions along the course, from the waypoint arc lengths. */
  gates?: (nodeS: number[], length: number) => number[];
  bankDetail?: string;
  /** Last Set: what you carry and where, for the toasts and beacon. */
  cargo?: string;
  destLine?: string;
  item?: 'snare' | 'cake';
  /** Pursuit events: the wanted level at the start (and the floor while it runs, for Siege and Breakout). */
  stars?: number;
}

/** Ironport junction id at street level (x, z in metres), as the generator numbers them. */
const ip = (x: number, z: number) => (x + 2000) * 1e4 + (z + 2000);

const LAKE_COUNTRY: Record<string, EventDef> = {
  warmup: {
    id: 'warmup', kind: 'warmup', map: 'lakecountry', name: 'Warm-Up Run', short: 'Warm-Up',
    blurb: 'Out of downtown Hartland: stop in the box on Capitol Drive, drift the turn onto North Avenue for a mini-turbo, hit the speed trap with nitro, and fire your signature before Arrowhead.',
    // Maple Ave/Capitol -> North Ave/Capitol -> North Ave -> North Ave/Arrowhead Campus Dr
    waypoints: [233200666, 233232842, 5817830488, 232801195],
    startAlong: 20,
    medals: { bronze: 1, silver: 3, gold: 4 },
    lowerIsBetter: false,
    scoreLabel: 'Tasks',
    color: 0x79d98a,
  },
  circuit: {
    id: 'circuit', kind: 'circuit', map: 'lakecountry', name: 'Beaver View Loop', short: 'Circuit',
    detail: 'Two laps of the Beaver View Loop.',
    blurb: 'Two laps over the hills north of Beaver Lake: Beaver Lake Road, the climb up Beaver View Road, then Red Fox Run back down. Crests throw you into the air. Race the club rival or your ghost.',
    // Beaver Lake Rd/Red Fox Run -> Beaver View Rd -> Beaver View/Deer Trail -> Deer Trail/Red Fox Run -> back
    waypoints: [233237787, 233124158, 233124079, 233237862, 233237787],
    startAlong: 40,
    medals: { gold: 128, silver: 142, bronze: 160 },
    lowerIsBetter: true,
    scoreLabel: 'Time',
    color: 0xffb347,
  },
  lastset: {
    id: 'lastset', kind: 'lastset', map: 'lakecountry', name: 'Last Set', short: 'Last Set',
    cargo: 'Snare loaded', destLine: 'Get to The Copper Ear on East Capitol Drive, Hartland', item: 'snare',
    blurb: 'The drummer left the snare at The Low Room on Hwy 83 by Pine Lake. Get it to The Copper Ear on Capitol Drive before the set starts. Every hit costs the case-condition bonus, so smooth beats fast.',
    waypoints: [232900708, 233232842],
    startAlong: 0,
    medals: { bronze: 1350, silver: 1600, gold: 1800 },
    lowerIsBetter: false,
    scoreLabel: 'Payout',
    color: 0x5aa8ff,
    timeLimit: 240,
  },
  air: {
    id: 'air', kind: 'air', map: 'lakecountry', name: 'Winkleman Air', short: 'Airtime',
    startLabel: 'WINKLEMAN AIR', detail: 'The whole of Winkleman Road, north to Sussex Road.', failDetail: 'The run counts only if you reach Sussex Road.',
    blurb: 'Run Winkleman Road north over the rolling farm hills. Every crest you catch at speed scores airtime; chain jumps for a multiplier. Crashes break the chain.',
    // County Highway K -> Sussex Road along Winkleman Road
    waypoints: [496834616, 233188196],
    startAlong: 15,
    // Rescaled for the faster cars: the test autopilot (no nitro or ability) scores ~27,000.
    medals: { bronze: 14000, silver: 24000, gold: 34000 },
    lowerIsBetter: false,
    scoreLabel: 'Air score',
    color: 0x7ad7ff,
    timeLimit: 110,
  },
  encore: {
    id: 'encore', kind: 'encore', map: 'lakecountry', name: 'Five-Star Encore', short: 'Encore',
    // Over the freeway on North Ave, out on WIS 16, the Hwy 83 off-ramp (bank), Hwy 83 north.
    gates: (n) => [n[1] + 140, n[2] + 420, n[3] + 40, (n[3] + n[4]) / 2],
    detail: 'Up Hwy 83 to County K with five stars on you.', bankDetail: 'You took the sure thing at the Hwy 83 off-ramp.',
    blurb: 'An opt-in pursuit: up North Avenue, west on the WIS 16 freeway past the posted units, off at Hwy 83 and north through Chenequa. Each gate raises the heat. Bank at the third gate or go for the five-star finish.',
    waypoints: [233232842, 5817830488, 232807641, 11753139925, 232846418],
    startAlong: 20,
    medals: { bronze: 1, silver: 2, gold: 3 },
    lowerIsBetter: false,
    scoreLabel: 'Outcome',
    color: 0xff4b4b,
  },
};

// Holy Hill and the Kettle Moraine (terrain exaggerated 1.5x). Each course has
// about 100 m of relief and 10-30 crests.
const HOLY_HILL: Record<string, EventDef> = {
  'hh-loop': {
    id: 'hh-loop', kind: 'circuit', map: 'holyhill', name: 'Holy Hill Loop', short: 'Loop', laps: 1,
    blurb: 'One long lap of the hills around the shrine: Holy Hill Road east, Saint Augustine and Emerald south, Donegal west, then the climb up Carmel Road past the shrine. Race the club rival or your ghost.',
    detail: 'One lap of the Holy Hill Loop: 7.8 km and 100 m of relief.',
    // Carmel Rd/Holy Hill Rd -> Saint Augustine Rd -> Emerald Dr -> Donegal Rd -> Carmel Rd -> back
    waypoints: [213274116, 5448664538, 3763279179, 213307456, 213274145, 1938657810, 1938658035, 213274116],
    startAlong: 40,
    medals: { gold: 186, silver: 211, bronze: 244 },
    lowerIsBetter: true, scoreLabel: 'Time', color: 0xffb347,
  },
  'hh-climb': {
    id: 'hh-climb', kind: 'circuit', map: 'holyhill', name: 'Shrine Climb', short: 'Climb', laps: 1, loop: false,
    blurb: 'A sprint up Holy Hill Road from County K, over the shoulder of the shrine hill and down to Saint Augustine Road. Uphill the whole first half; keep your speed over the crests.',
    detail: 'Holy Hill Road from County K to Saint Augustine Road.',
    waypoints: [213303894, 213274116, 5448664538],
    startAlong: 15,
    medals: { gold: 82, silver: 93, bronze: 106 },
    lowerIsBetter: true, scoreLabel: 'Time', color: 0xe0a0ff,
  },
  'hh-drop': {
    id: 'hh-drop', kind: 'circuit', map: 'holyhill', name: 'Shannon Drop', short: 'Drop', laps: 1, loop: false,
    blurb: 'Downhill the whole way: Shannon Road falls 100 m from Saint Augustine Road to County K over seventeen crests. Fast, airborne, and easy to overcook.',
    detail: 'Shannon Road, top to bottom.',
    waypoints: [3763279173, 213303900],
    startAlong: 15,
    medals: { gold: 74, silver: 84, bronze: 97 },
    lowerIsBetter: true, scoreLabel: 'Time', color: 0xff7a5c,
  },
  'hh-delivery': {
    id: 'hh-delivery', kind: 'lastset', map: 'holyhill', name: 'Supper Club Run', short: 'Delivery',
    blurb: 'The anniversary cake is waiting at the Friess Lake Boathouse. Get it over the hills to The Summit Supper Club on Carmel Road before the toast. Every hit cracks the frosting, so smooth beats fast.',
    item: 'cake', cargo: 'Cake loaded', destLine: 'Get to The Summit Supper Club on Carmel Road, by the shrine',
    waypoints: [2402537089, 1938658035],
    startAlong: 0,
    medals: { bronze: 1350, silver: 1600, gold: 1800 },
    lowerIsBetter: false, scoreLabel: 'Payout', color: 0x5aa8ff,
    timeLimit: 260,
  },
  'hh-air': {
    id: 'hh-air', kind: 'air', map: 'holyhill', name: 'Elmwood Air', short: 'Airtime',
    blurb: 'Elmwood Road rolls over a dozen glacial crests in three kilometres. Hit them fast for big air; chain landings for a multiplier. Crashes break the chain.',
    startLabel: 'ELMWOOD AIR', detail: 'Elmwood Road, end to end.', failDetail: 'The run counts only if you reach the end of Elmwood Road.',
    waypoints: [2402517903, 2402517908, 213280960],
    startAlong: 15,
    // The test autopilot (no nitro, no ability) scores about 130,000 here.
    medals: { bronze: 70000, silver: 120000, gold: 170000 },
    lowerIsBetter: false, scoreLabel: 'Air score', color: 0x7ad7ff,
    timeLimit: 120,
  },
  'hh-encore': {
    id: 'hh-encore', kind: 'encore', map: 'holyhill', name: 'Moraine Encore', short: 'Encore',
    blurb: 'An opt-in pursuit across the moraine: Holy Hill Road east past the shrine, WI 167 to Hubertus, then Lovers Lane and Hubertus Road. Each gate raises the heat. Bank at the third gate or go for the five-star finish.',
    waypoints: [213328145, 213303894, 5448664538, 10177890665, 213310038],
    gates: (_n, L) => [L * 0.14, L * 0.33, L * 0.52, L * 0.76],
    detail: 'Across the moraine to Hubertus Road with five stars on you.', bankDetail: 'You took the sure thing halfway across the moraine.',
    startAlong: 20,
    medals: { bronze: 1, silver: 2, gold: 3 },
    lowerIsBetter: false, scoreLabel: 'Outcome', color: 0xff4b4b,
  },
};

// Ironport: every event is a police chase.
const IRONPORT: Record<string, EventDef> = {
  'ip-hot': {
    id: 'ip-hot', kind: 'escape', map: 'ironport', name: 'Hot Start', short: 'Hot Start', stars: 2,
    blurb: 'Two stars on you the moment the light goes green on Signal Avenue. Break their line of sight and keep it broken until the search gives up. Tunnels, the Skyway and the level changes are your friends.',
    waypoints: [ip(450, -450), ip(450, -300)],
    startAlong: 30,
    medals: { gold: 40, silver: 70, bronze: 110 },
    lowerIsBetter: true, scoreLabel: 'Escape time', color: 0x5aa8ff, timeLimit: 240,
  },
  'ip-underway': {
    id: 'ip-underway', kind: 'escape', map: 'ironport', name: 'Underway Escape', short: 'Underway', stars: 4,
    blurb: 'Four stars, a helicopter overhead and the Canal Underway mouth straight ahead. The air unit cannot see under a tunnel roof; the cars on the street cannot see down into one. Lose all of them.',
    waypoints: [ip(0, 300), ip(0, 450)],
    startAlong: 40,
    medals: { gold: 70, silver: 110, bronze: 160 },
    lowerIsBetter: true, scoreLabel: 'Escape time', color: 0x79d98a, timeLimit: 300,
  },
  'ip-five': {
    id: 'ip-five', kind: 'escape', map: 'ironport', name: 'Five Alarm', short: 'Five Alarm', stars: 5,
    blurb: 'Five stars under the Stack: armored units with rockets, spike strips, roadblocks and a marksman in the helicopter. Get out of sight on a different level and stay there.',
    waypoints: [ip(-150, 0), ip(150, 0)],
    startAlong: 30,
    medals: { gold: 120, silver: 180, bronze: 260 },
    lowerIsBetter: true, scoreLabel: 'Escape time', color: 0xff4b4b, timeLimit: 420,
  },
  'ip-siege': {
    id: 'ip-siege', kind: 'survive', map: 'ironport', name: 'Siege', short: 'Siege', stars: 4,
    blurb: 'You cannot lose them this time: the heat stays at four stars or more for three minutes. Stay free and stay in one piece. Every minute you last earns a medal.',
    waypoints: [ip(900, -150), ip(900, 0)],
    startAlong: 30,
    medals: { bronze: 60, silver: 120, gold: 180 },
    lowerIsBetter: false, scoreLabel: 'Seconds free', color: 0xffb347, timeLimit: 180,
  },
  'ip-breakout': {
    id: 'ip-breakout', kind: 'getaway', map: 'ironport', name: 'Breakout', short: 'Breakout', stars: 3,
    cargo: 'Three stars and climbing', destLine: 'Get across town to The Lantern on Dock Avenue',
    blurb: 'Out of the Coldwater Lockup in the far northwest with three stars that will not drop. Cross the whole city to The Lantern on Dock Avenue and stop in the box. Pick your levels.',
    waypoints: [ip(-1500, -1350), ip(-1500, -1200)],
    startAlong: 0,
    medals: { gold: 95, silver: 125, bronze: 170 },
    lowerIsBetter: true, scoreLabel: 'Time', color: 0xc08bff, timeLimit: 300,
  },
};

// Hollowpeak: speed, air and the Wardens. Junction ids are (x + 5000) * 1e4 + (z + 5000)
// from scripts/build-hollowpeak.mjs.
const HP = {
  rimSouth: 47137480, rimNorth: 47672520, rimRidge: 25235915, rimWest: 25205296, rimQuarry: 25214266, rimSummit: 69822708, rimEast: 74805230,
  center: 49005502, quarryNS: 46193550, summitEW: 69005277,
};
const HOLLOWPEAK: Record<string, EventDef> = {
  'hp-tubes': {
    id: 'hp-tubes', kind: 'circuit', map: 'hollowpeak', name: 'Tube Run', short: 'Tube Run', laps: 1, loop: false,
    detail: 'The North Crossway, rim to rim.',
    blurb: 'The North Crossway end to end, five kilometres flat out: a speed tube, a sky-tube over the valley, the cave under Cathedral Rock and another tube to finish. Race the club rival or your ghost.',
    waypoints: [HP.rimSouth, HP.center, HP.rimNorth],
    startAlong: 40,
    medals: { gold: 65, silver: 80, bronze: 100 },
    lowerIsBetter: true, scoreLabel: 'Time', color: 0x5aa8ff,
  },
  'hp-rim': {
    id: 'hp-rim', kind: 'circuit', map: 'hollowpeak', name: 'Rimway', short: 'Rimway', laps: 1,
    detail: 'One lap of the Rimway.',
    blurb: 'One lap of the 18 km Rimway: three caves, four speed tubes, a sky-tube, and long sweepers built for 300 mph.',
    waypoints: [HP.rimSouth, HP.rimRidge, HP.rimWest, HP.rimQuarry, HP.rimNorth, HP.rimSummit, HP.rimEast, HP.rimSouth],
    startAlong: 40,
    medals: { gold: 220, silver: 270, bronze: 340 },
    lowerIsBetter: true, scoreLabel: 'Time', color: 0xffb347,
  },
  'hp-air': {
    id: 'hp-air', kind: 'air', map: 'hollowpeak', name: 'Summit Air', short: 'Airtime',
    startLabel: 'SUMMIT AIR', detail: 'Summit Road from the East Crossway to the Rimway.', failDetail: 'The run counts only if you reach the Rimway.',
    blurb: 'Summit Road climbs the shoulder of Iron Knob at 17%: every crest at speed throws you, and chained landings multiply. There is a cave near the top.',
    waypoints: [HP.summitEW, HP.rimSummit],
    startAlong: 20,
    medals: { bronze: 60000, silver: 95000, gold: 130000 },
    lowerIsBetter: false, scoreLabel: 'Air score', color: 0xc9a227, timeLimit: 120,
  },
  'hp-hunted': {
    id: 'hp-hunted', kind: 'survive', map: 'hollowpeak', name: 'Hunted', short: 'Hunted', stars: 4,
    blurb: 'Four stars and the Wardens: they see through Phantom and smoke and they never forget the car. The heat stays on for three minutes. Use the caves, the tubes and the hills, and shoot back if you have to.',
    waypoints: [HP.summitEW, HP.rimEast],
    startAlong: 60,
    medals: { bronze: 60, silver: 120, gold: 180 },
    lowerIsBetter: false, scoreLabel: 'Seconds free', color: 0xff4b4b, timeLimit: 180,
  },
  'hp-caves': {
    id: 'hp-caves', kind: 'escape', map: 'hollowpeak', name: 'Cave Escape', short: 'Caves', stars: 3,
    blurb: 'Three stars and a Warden on your bumper on Quarry Road. The helicopter cannot see into a cave or a tube, and nobody on a hill can see down into one. Lose them all.',
    waypoints: [HP.rimQuarry, HP.quarryNS],
    startAlong: 80,
    medals: { gold: 45, silver: 80, bronze: 130 },
    lowerIsBetter: true, scoreLabel: 'Escape time', color: 0x79d98a, timeLimit: 300,
  },
};

export const CATALOGUES: Record<string, { events: Record<string, EventDef>; order: EventId[] }> = {
  hollowpeak: { events: HOLLOWPEAK, order: ['hp-tubes', 'hp-rim', 'hp-air', 'hp-hunted', 'hp-caves'] },
  lakecountry: { events: LAKE_COUNTRY, order: ['warmup', 'circuit', 'lastset', 'air', 'encore'] },
  holyhill: { events: HOLY_HILL, order: ['hh-loop', 'hh-climb', 'hh-drop', 'hh-delivery', 'hh-air', 'hh-encore'] },
  ironport: { events: IRONPORT, order: ['ip-hot', 'ip-underway', 'ip-five', 'ip-siege', 'ip-breakout'] },
};

/** Every event on every map (leaderboard validation keeps other maps' entries). */
export const ALL_EVENTS: Record<EventId, EventDef> = { ...LAKE_COUNTRY, ...HOLY_HILL, ...IRONPORT, ...HOLLOWPEAK };

/** The active map's events, in menu order (filled by `useEvents`). */
export const EVENTS: Record<EventId, EventDef> = {};
export const EVENT_ORDER: EventId[] = [];

export function useEvents(map: string) {
  const c = CATALOGUES[map] ?? CATALOGUES.lakecountry;
  for (const k of Object.keys(EVENTS)) delete EVENTS[k];
  Object.assign(EVENTS, c.events);
  EVENT_ORDER.length = 0;
  EVENT_ORDER.push(...c.order);
}
useEvents('lakecountry');

/** First event of a kind on the active map (e.g. the circuit for ghost races). */
export function eventOfKind(kind: EventKind): EventDef | null {
  for (const id of EVENT_ORDER) if (EVENTS[id].kind === kind) return EVENTS[id];
  return null;
}

export function medalFor(def: EventDef, score: number): Medal | null {
  const m = def.medals;
  if (def.lowerIsBetter) {
    if (score <= m.gold) return 'gold';
    if (score <= m.silver) return 'silver';
    if (score <= m.bronze) return 'bronze';
    return null;
  }
  if (score >= m.gold) return 'gold';
  if (score >= m.silver) return 'silver';
  if (score >= m.bronze) return 'bronze';
  return null;
}

/** Last Set payout: a smooth, slightly slower run beats a messy sprint. */
export function lastSetPayout(secondsLeft: number, condition: number) {
  return Math.round(500 + 4 * Math.max(0, secondsLeft) + 9 * Math.max(0, Math.min(100, condition)));
}

/** Airtime score for one landing: longer and faster jumps score more; chains multiply. */
export function airScore(seconds: number, speed: number, chain: number) {
  return Math.round(seconds * 700 * (0.6 + speed / 45) * Math.min(chain, 6));
}

export const ENCORE_PRIZES = { gate1: 300, gate2: 650, bank: 1100, finish: 3200 };
