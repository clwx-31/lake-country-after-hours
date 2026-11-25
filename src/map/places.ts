// Invented venues and anchors placed on the real street network. Every name here
// is fictional; real streets and landmarks come only from OpenStreetMap.
import { headingOf } from '../core/math';
import type { District } from './District';

export interface EdgeAnchor {
  /** OSM node IDs of the two junctions bounding the street segment. */
  from: number;
  to: number;
  /** Meters from `from` toward `to`. */
  along: number;
  /** Lateral offset from the centerline (m, + = right of from->to travel). */
  offset?: number;
}

export interface Placed {
  x: number;
  z: number;
  h: number; // heading of from->to travel
  edge: number;
  s: number;
}

export function resolveAnchor(d: District, a: EdgeAnchor): Placed {
  const ia = d.nodeByOsm.get(a.from), ib = d.nodeByOsm.get(a.to);
  if (ia === undefined || ib === undefined) throw new Error(`anchor nodes ${a.from}/${a.to} missing`);
  // Walk the shortest route so anchors may span more than one edge.
  const r = d.route(ia, ib, false);
  if (!r) throw new Error(`anchor ${a.from}->${a.to} unreachable`);
  let remaining = a.along;
  let v = ia;
  for (const ei of r.edges) {
    const e = d.edges[ei];
    if (remaining <= e.length || ei === r.edges[r.edges.length - 1]) {
      const fwd = e.a === v;
      const s = fwd ? Math.min(remaining, e.length) : Math.max(0, e.length - remaining);
      const p = e.path.pointAt(s);
      let h = e.path.headingAt(s);
      if (!fwd) h += Math.PI;
      const off = a.offset ?? 0;
      return { x: p.x - Math.cos(h) * off, z: p.z + Math.sin(h) * off, h, edge: ei, s };
    }
    remaining -= e.length;
    v = d.otherEnd(ei, v);
  }
  throw new Error('anchor walk failed');
}

export interface Venue {
  id: string;
  name: string;
  kind: 'garage' | 'rehearsal' | 'venue';
  anchor: EdgeAnchor;
  side: 1 | -1; // +1 right of travel, -1 left
  width: number;
  depth: number;
  setback: number;
  /** Sign lines on the building (big name, small line). */
  sign: [string, string];
}

const PLACES: Record<string, { garage: Venue; rehearsal: Venue; venue: Venue }> = {
  lakecountry: {
    // Church Street, downtown Hartland, between East Capitol Drive and Lawn Street.
    garage: {
      id: 'garage', name: 'Lamplight Motor Works', kind: 'garage', sign: ['LAMPLIGHT MOTOR WORKS', ''],
      anchor: { from: 233134402, to: 233126170, along: 58 }, side: -1, width: 13, depth: 10, setback: 9.5,
    },
    // State Highway 83 in Chenequa, on the Pine Lake side.
    rehearsal: {
      id: 'rehearsal', name: 'The Low Room Rehearsal Studios', kind: 'rehearsal', sign: ['THE LOW ROOM', 'REHEARSAL STUDIOS'],
      anchor: { from: 232900708, to: 232900787, along: 330 }, side: 1, width: 14, depth: 11, setback: 10,
    },
    // East Capitol Drive downtown, between North Avenue and Church Street.
    venue: {
      id: 'venue', name: 'The Copper Ear', kind: 'venue', sign: ['THE COPPER EAR', 'TONIGHT · LATE SET'],
      anchor: { from: 233232842, to: 233134402, along: 190 }, side: 1, width: 14, depth: 12, setback: 6.5,
    },
  },
  holyhill: {
    // Holy Hill Road east of Saint Augustine Road, on a level stretch.
    garage: {
      id: 'garage', name: 'Moraine Speed Shop', kind: 'garage', sign: ['MORAINE SPEED SHOP', ''],
      anchor: { from: 5448664538, to: 213300031, along: 640 }, side: -1, width: 13, depth: 10, setback: 9.5,
    },
    // North Friess Lake Road, by the lake.
    rehearsal: {
      id: 'rehearsal', name: 'Friess Lake Boathouse', kind: 'rehearsal', sign: ['FRIESS LAKE', 'BOATHOUSE · RENTALS'],
      anchor: { from: 2402537089, to: 213274261, along: 110 }, side: 1, width: 14, depth: 11, setback: 10,
    },
    // Carmel Road below the shrine hill.
    venue: {
      id: 'venue', name: 'The Summit Supper Club', kind: 'venue', sign: ['THE SUMMIT', 'SUPPER CLUB · FISH FRY'],
      anchor: { from: 213274116, to: 1938658035, along: 390 }, side: 1, width: 14, depth: 12, setback: 6.5,
    },
  },
  // Ironport is fictional; junction ids are (x + 2000) * 1e4 + (z + 2000) at street level.
  // The generator keeps these lots clear of buildings.
  ironport: {
    // Birch Street, west side of town.
    garage: {
      id: 'garage', name: 'Undercroft Motors', kind: 'garage', sign: ['UNDERCROFT MOTORS', ''],
      anchor: { from: (-1200 + 2000) * 1e4 + (150 + 2000), to: (-1200 + 2000) * 1e4 + (300 + 2000), along: 70 }, side: -1, width: 13, depth: 10, setback: 9.5,
    },
    // Far northwest: where Breakout starts.
    rehearsal: {
      id: 'rehearsal', name: 'Coldwater Lockup', kind: 'rehearsal', sign: ['COLDWATER', 'SELF STORAGE · 24 HR'],
      anchor: { from: (-1500 + 2000) * 1e4 + (-1350 + 2000), to: (-1500 + 2000) * 1e4 + (-1200 + 2000), along: 75 }, side: 1, width: 14, depth: 11, setback: 10,
    },
    // Dock Avenue, far southeast: where Breakout ends.
    venue: {
      id: 'venue', name: 'The Lantern', kind: 'venue', sign: ['THE LANTERN', 'SOCIAL CLUB · LATE'],
      anchor: { from: (1350 + 2000) * 1e4 + (1200 + 2000), to: (1350 + 2000) * 1e4 + (1350 + 2000), along: 80 }, side: 1, width: 14, depth: 12, setback: 6.5,
    },
  },
  // Hollowpeak is fictional; ids are (x + 5000) * 1e4 + (z + 5000) from scripts/build-hollowpeak.mjs,
  // which levels a pad for each lot.
  hollowpeak: {
    // Ridge Road, just off the North Crossway.
    garage: {
      id: 'garage', name: 'Switchback Garage', kind: 'garage', sign: ['SWITCHBACK GARAGE', ''],
      anchor: { from: 48526150, to: 25235915, along: 160 }, side: -1, width: 13, depth: 10, setback: 9.5,
    },
    // Summit Road at the foot of Iron Knob.
    rehearsal: {
      id: 'rehearsal', name: 'Iron Knob Lodge', kind: 'rehearsal', sign: ['IRON KNOB', 'LODGE · ROOMS'],
      anchor: { from: 69005277, to: 69822708, along: 150 }, side: 1, width: 14, depth: 11, setback: 10,
    },
    // Quarry Road under Cathedral Rock.
    venue: {
      id: 'venue', name: 'The Quarry Diner', kind: 'venue', sign: ['THE QUARRY', 'DINER · OPEN LATE'],
      anchor: { from: 46193550, to: 25214266, along: 170 }, side: 1, width: 14, depth: 12, setback: 6.5,
    },
  },
};

// The active map's venues (live bindings, set by `usePlaces`).
export let GARAGE: Venue = PLACES.lakecountry.garage;
export let REHEARSAL: Venue = PLACES.lakecountry.rehearsal;
export let VENUE: Venue = PLACES.lakecountry.venue;
export let VENUES: Venue[] = [GARAGE, REHEARSAL, VENUE];

export function usePlaces(map: string) {
  const p = PLACES[map] ?? PLACES.lakecountry;
  GARAGE = p.garage;
  REHEARSAL = p.rehearsal;
  VENUE = p.venue;
  VENUES = [GARAGE, REHEARSAL, VENUE];
}

export function venueFrame(d: District, v: Venue) {
  const p = resolveAnchor(d, v.anchor);
  const e = d.edges[p.edge];
  const rx = -Math.cos(p.h), rz = Math.sin(p.h);
  const off = (e.width / 2 + v.setback + v.depth / 2) * v.side;
  const cx = p.x + rx * off, cz = p.z + rz * off;
  // Building faces the street.
  const face = headingOf(-rx * v.side, -rz * v.side);
  const curbOff = (e.width / 2 - 1.3) * v.side;
  return {
    street: p,
    center: { x: cx, z: cz },
    face,
    curb: { x: p.x + rx * curbOff, z: p.z + rz * curbOff },
    front: { x: p.x + rx * (e.width / 2 + v.setback) * v.side, z: p.z + rz * (e.width / 2 + v.setback) * v.side },
  };
}
