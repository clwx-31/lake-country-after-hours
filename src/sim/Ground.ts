// Layered ground: terrain everywhere, plus decks a car stands on only when it is
// already up at (or near) deck height, so it can also drive underneath. Decks are
// bridge strips (height along the edge), elevated junctions and street-level slabs
// over tunnels (constant height). Where decks stack, the highest one at or below
// the car wins.
import type { District } from '../map/District';
import { PolygonIndex } from '../map/roadGeometry';
import type { Terrain } from '../map/Terrain';

/** What a deck is: an edge strip, a junction, a flat slab, or the roof over a cave or tube. */
export interface DeckInfo {
  edge: number; // -1 for slabs
  node: number; // -1 unless a junction
  y: number; // constant height (junctions, slabs)
  /** Lid over a tunnel (has a ceiling underneath). */
  lid?: boolean;
  /** Roof over a covered road (`edge`): its underside is this far above the road. */
  roofOver?: number;
  /** Roof surface: a hill (heightfield) or this far above the road. */
  hill?: Terrain;
  above?: number;
}

/** A roof over a covered stretch of road: a cave's hill or a tube's top. */
export interface RoofDeck {
  edge: number;
  poly: number[];
  under: number;
  hill?: Terrain;
  above?: number;
}

export class Ground {
  private decks = new PolygonIndex(24);
  readonly info: DeckInfo[] = [];
  private best = 0;
  private bestId = -1;

  constructor(
    private d: District,
    deckPolys: { edge: number; poly: number[] }[],
    flat: { poly: number[]; y: number; node?: number; lid?: boolean }[] = [],
    roofs: RoofDeck[] = [],
  ) {
    for (const dp of deckPolys) this.add(dp.poly, { edge: dp.edge, node: -1, y: 0 });
    for (const f of flat) this.add(f.poly, { edge: -1, node: f.node ?? -1, y: f.y, lid: f.lid });
    for (const r of roofs) this.add(r.poly, { edge: r.edge, node: -1, y: 0, roofOver: r.under, hill: r.hill, above: r.above });
  }

  private add(poly: number[], info: DeckInfo) {
    this.decks.add(poly, this.info.length);
    this.info.push(info);
  }

  /** Surface height of deck `id` at (x, z). */
  deckHeight(id: number, x: number, z: number) {
    const inf = this.info[id];
    if (inf.hill) {
      // The hill, or the hood over a cave mouth where the hill is thinner than the roof.
      const e = this.d.edges[inf.edge];
      const pr = e.path.project(x, z);
      const hood = this.d.heightOnEdge(inf.edge, pr.s) + (inf.roofOver ?? 0) + 1.2 - Math.max(0, pr.d - (e.width / 2 + 3.5));
      return Math.max(inf.hill.height(x, z), hood) + 0.12;
    }
    if (inf.edge < 0) return inf.y;
    const e = this.d.edges[inf.edge];
    return this.d.heightOnEdge(inf.edge, e.path.project(x, z).s) + (inf.above ?? 0);
  }

  /** Underside of deck `id` at (x, z): what a car below would hit. */
  deckUnderside(id: number, x: number, z: number) {
    const inf = this.info[id];
    if (inf.roofOver !== undefined) {
      const e = this.d.edges[inf.edge];
      return this.d.heightOnEdge(inf.edge, e.path.project(x, z).s) + inf.roofOver;
    }
    return this.deckHeight(id, x, z) - (inf.lid ? 1 : 1.4);
  }

  /** Surface height at (x,z) for something currently at height `yHint`. */
  height = (x: number, z: number, yHint = Infinity): number => {
    const t = this.d.terrain.height(x, z);
    if (!this.info.length) return t;
    this.best = t;
    this.bestId = -1;
    this.decks.queryAll(x, z, (id) => {
      const h = this.deckHeight(id, x, z);
      // Stay on a deck only when already up near it.
      if (h > t + 0.3 && h <= yHint + 1.2 && h > this.best) { this.best = h; this.bestId = id; }
    });
    return this.best;
  };

  /** Like height(), plus which deck it came from (-1 = terrain). */
  surface(x: number, z: number, yHint = Infinity) {
    const h = this.height(x, z, yHint);
    return { h, deck: this.bestId };
  }

  /**
   * Underside of the lowest roof over the point for something at height y (a deck,
   * a tunnel lid, a cave's or tube's roof), or Infinity.
   */
  ceiling(x: number, z: number, y: number) {
    let c = Infinity;
    this.decks.queryAll(x, z, (id) => {
      const h = this.deckHeight(id, x, z);
      if (h <= y + 1.2) return;
      const u = this.deckUnderside(id, x, z);
      if (u > y - 0.5 && u < c) c = u;
    });
    return c;
  }

  /** Is (x,z) on a deck for something at height y? */
  onDeck(x: number, z: number, y: number) {
    return this.height(x, z, y) > this.d.terrain.height(x, z) + 0.3;
  }

  /**
   * Is (x,z) covered by a deck other than edge `self` (or junction `selfNode`) whose
   * surface is within `tol` of y? Used to drop rails, fascias and markings where decks
   * merge. `kinds`: 'edges' = road strips and junctions only, 'slabs' = slabs only.
   */
  otherDeckAt(x: number, z: number, y: number, o: { self?: number; selfNode?: number; tol?: number; kinds?: 'all' | 'edges' | 'slabs' } = {}) {
    const tol = o.tol ?? 1.0, kinds = o.kinds ?? 'all';
    let hit = false;
    this.decks.queryAll(x, z, (id) => {
      if (hit) return;
      const inf = this.info[id];
      const slab = (inf.edge < 0 && inf.node < 0) || inf.roofOver !== undefined;
      if (kinds === 'edges' && slab) return;
      if (kinds === 'slabs' && !slab) return;
      if (inf.edge >= 0 && inf.edge === o.self) return;
      if (inf.node >= 0 && inf.node === o.selfNode) return;
      if (Math.abs(this.deckHeight(id, x, z) - y) <= tol) hit = true;
    });
    return hit;
  }
}
