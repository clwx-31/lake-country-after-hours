// Online play through the claude.ai artifact runtime:
//  - room presence: every open copy of the game shares its car (~15 Hz), so
//    friends see each other driving; remote cars are interpolated and solid.
//  - races: a host advertises a race (code + event) in presence; joiners copy
//    the code; the host's `go` (with a sequence number) starts everyone's
//    countdown on the same grid. Presence is display data, never authority.
//  - leaderboard: each player's bests (and Beaver View Loop ghost) live in the
//    shared db under boards/<their id>, readable by everyone, writable only
//    by that player (and the owner, for tidying).
// Everything degrades to single player when `claude.use()` resolves null.
import * as THREE from 'three';
import { CarModel } from '../render/CarModel';
import { textSprite } from '../events/visuals';
import { ALL_EVENTS, EVENTS, EVENT_ORDER, type EventId } from '../events/defs';
import { MAP } from '../map/maps';
import type { Ghost } from '../save/Save';
import { CARS, PLAYER_CARS, type CarId } from '../sim/cars';
import type { PhysBody } from '../sim/Physics';
import type { Vehicle } from '../sim/Vehicle';

/* Minimal shapes of the runtime namespaces this module uses. */
interface Sender { peer: string; by: string | null; isMe: boolean; sameTab: boolean; kind: string; guest: boolean }
interface Peer extends Sender { presence: Readonly<Record<string, unknown>>; updatedAt: number }
interface PeersChange { peers: readonly Peer[]; joined: readonly Peer[]; left: readonly Peer[]; updated: readonly Peer[] }
interface Room {
  presence(patch: Record<string, unknown>): Promise<void>;
  peers(): readonly Peer[];
  onPeers(h: (c: PeersChange) => void, e?: (err: { code: string }) => void): () => void;
  connected(): boolean;
}
interface DocSnap { id: string; exists: boolean; data(): Record<string, unknown> | undefined; metadata: { fromCache: boolean } }
interface DocRef { get(): Promise<DocSnap>; set(d: Record<string, unknown>): Promise<void>; onSnapshot(n: (s: DocSnap) => void, e?: (err: { code: string }) => void): () => void }
interface QuerySnap { docs: DocSnap[] }
interface Collection { onSnapshot(n: (s: QuerySnap) => void, e?: (err: { code: string }) => void): () => void; doc(id: string): DocRef }
interface DB { doc(path: string): DocRef; collection(path: string): Collection }
interface Profile { id: string; name: string; color: string; isMe: boolean; guest: boolean }
interface User { id(): Promise<string | null>; can(c: string): Promise<boolean | null>; profiles(ids: readonly string[]): Promise<Record<string, Profile>> }
interface ClaudeRuntime { use(name: string): Promise<unknown> }

/** Raceable events on the active map (rivals' races on another map are listed but not joinable). */
export const raceEvents = (): EventId[] => EVENT_ORDER.filter((id) => ['circuit', 'air', 'lastset'].includes(EVENTS[id].kind));

export interface RaceState {
  code: string;
  ev: EventId;
  host: boolean;
  st: 'lobby' | 'go' | 'done';
  seq: number;
  prog: number; // meters along the course (or score for air)
  fin: number | null; // final score (time for circuit)
}

export interface RemoteCar {
  peer: string;
  by: string | null;
  car: CarId;
  paint: string;
  model: CarModel;
  label: THREE.Sprite | null;
  labelName: string;
  body: PhysBody;
  snaps: { t: number; x: number; y: number; z: number; h: number; s: number; tier: number }[];
  /** Which map the friend is driving. */
  map: string;
  last: number;
  race: RaceState | null;
  ev: string;
  stars: number;
  color: string;
  /** On the map (false while they sit in menus: listed, but no car). */
  visible: boolean;
}

export interface BoardEntry {
  uid: string;
  score: number;
  time?: number;
  car: CarId;
  at: string;
  ghost?: boolean;
  /** Difficulty level (1-5) the time was set on. */
  diff?: number;
}

export interface OnlineHost {
  scene: THREE.Scene;
  beamTex: THREE.Texture;
  player: Vehicle;
  carId: CarId;
  paint(): string;
  eventId(): string;
  stars(): number;
  /** Is the player out on the map (not on the title or garage screens)? */
  visible(): boolean;
  /** Start a race event at a grid slot (host's go). */
  startRace(ev: EventId, slot: number): void;
  toast(big: string, small?: string, seconds?: number): void;
}

const num = (v: unknown, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const r1 = (v: number) => Math.round(v * 10) / 10;
const r2 = (v: number) => Math.round(v * 100) / 100;
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

/** Ghost samples as a compact string: Int16 deltas (decimeters, centiradians)
 *  from the first sample, base64. ~6 bytes per sample. */
export function packGhost(g: Ghost) {
  const s = g.samples;
  const ox = s[0] ?? 0, oz = s[1] ?? 0;
  const out = new Int16Array(s.length);
  let px = 0, pz = 0, ph = 0;
  for (let i = 0; i < s.length; i += 3) {
    const x = Math.round((s[i] - ox) * 10), z = Math.round((s[i + 1] - oz) * 10), h = Math.round(s[i + 2] * 100);
    out[i] = Math.max(-32768, Math.min(32767, x - px));
    out[i + 1] = Math.max(-32768, Math.min(32767, z - pz));
    out[i + 2] = Math.max(-32768, Math.min(32767, h - ph));
    px += out[i]; pz += out[i + 1]; ph += out[i + 2];
  }
  const bytes = new Uint8Array(out.buffer);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return { ox, oz, data: btoa(bin) };
}

export function unpackGhost(p: { ox: number; oz: number; data: string }): number[] {
  const bin = atob(p.data);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const d = new Int16Array(bytes.buffer, 0, Math.floor(bytes.length / 2));
  const out: number[] = [];
  let x = 0, z = 0, h = 0;
  for (let i = 0; i + 2 < d.length; i += 3) {
    x += d[i]; z += d[i + 1]; h += d[i + 2];
    out.push(p.ox + x / 10, p.oz + z / 10, h / 100);
  }
  return out;
}

export class Online {
  state: 'off' | 'connecting' | 'on' | 'unavailable' = 'off';
  room: Room | null = null;
  db: DB | null = null;
  user: User | null = null;
  myId: string | null = null;
  canWrite: boolean | null = null;
  readonly remotes = new Map<string, RemoteCar>();
  race: RaceState | null = null;
  private startedSeq = -1;
  private sendTimer = 0;
  private names = new Map<string, { name: string; color: string }>();
  private namesPending = false;
  boards: Record<string, BoardEntry> = {}; // key `${uid}|${event}`
  myBoard: Record<string, BoardEntry> = {};
  boardsReady = false;
  onChange: (() => void) | null = null;

  constructor(private host: OnlineHost) {}

  /** Light up online features when the runtime grants them; otherwise stay single player. */
  async init() {
    const rt = (window as unknown as { claude?: ClaudeRuntime }).claude;
    if (!rt?.use) { this.state = 'unavailable'; return; }
    this.state = 'connecting';
    const [room, db, user] = await Promise.all([
      rt.use('room').catch(() => null) as Promise<Room | null>,
      rt.use('db').catch(() => null) as Promise<DB | null>,
      rt.use('user').catch(() => null) as Promise<User | null>,
    ]);
    this.room = room;
    this.db = db;
    this.user = user;
    if (!room) { this.state = 'unavailable'; this.onChange?.(); return; }
    this.state = 'on';
    if (user) {
      this.myId = await user.id().catch(() => null);
      this.canWrite = await user.can('data.write').catch(() => null);
    }
    room.onPeers((c) => this.onPeers(c), () => { this.state = 'unavailable'; this.clearRemotes(); this.onChange?.(); });
    if (db) {
      db.collection('boards').onSnapshot((snap) => {
        const next: Record<string, BoardEntry> = {};
        for (const doc of snap.docs) {
          const d = doc.data();
          const events = (d?.events ?? {}) as Record<string, Record<string, unknown>>;
          for (const [ev, e] of Object.entries(events)) {
            // Keep every map's entries (re-posting rewrites the whole doc); show only this map's.
            if (!(ev in ALL_EVENTS) || typeof e !== 'object' || !e) continue;
            const car = PLAYER_CARS.includes(e.car as CarId) ? (e.car as CarId) : 'vesper';
            next[`${doc.id}|${ev}`] = { uid: doc.id, score: num(e.score), time: num(e.time, undefined as unknown as number), car, at: String(e.at ?? ''), ghost: !!e.ghost, diff: Math.max(1, Math.min(5, Math.round(num(e.diff, 3)))) };
          }
        }
        this.boards = next;
        this.myBoard = {};
        for (const [k, v] of Object.entries(next)) if (v.uid === this.myId) this.myBoard[k.split('|')[1]] = v;
        this.boardsReady = true;
        this.resolveNames();
        this.onChange?.();
      }, () => { this.boardsReady = true; this.onChange?.(); });
    }
    this.onChange?.();
  }

  get active() {
    return this.state === 'on';
  }

  // ------------------------------------------------------------------ presence in
  private onPeers(c: PeersChange) {
    for (const p of c.left) this.removeRemote(p.peer);
    for (const p of [...c.joined, ...c.updated]) {
      if (p.sameTab || p.kind !== 'viewer') continue;
      this.ingest(p);
    }
    this.resolveNames();
    this.onChange?.();
  }

  private ingest(p: Peer) {
    const pr = p.presence ?? {};
    if (pr.v !== 0 && pr.v !== 1) return; // another page version
    let r = this.remotes.get(p.peer);
    const car = PLAYER_CARS.includes(pr.c as CarId) ? (pr.c as CarId) : 'vesper';
    const paint = typeof pr.pt === 'string' && /^#[0-9a-f]{6}$/i.test(pr.pt) ? pr.pt : CARS[car].paints[0];
    if (!r || r.car !== car) {
      if (r) this.disposeRemote(r);
      const model = new CarModel(car, paint, { beamTex: this.host.beamTex });
      this.host.scene.add(model.root);
      const spec = CARS[car];
      r = {
        peer: p.peer, by: p.by, car, paint, model, label: null, labelName: '',
        body: { id: 7000 + this.remotes.size, x: 0, z: 0, h: 0, vx: 0, vz: 0, w: 0, y: 0, mass: spec.mass, inertia: spec.mass * 1.6, halfLength: spec.length / 2, halfWidth: spec.width / 2, solid: true },
        snaps: [], last: 0, race: null, ev: '', stars: 0, color: '#7ad7ff', visible: false, map: 'lakecountry',
      };
      this.remotes.set(p.peer, r);
    } else if (r.paint !== paint) {
      r.paint = paint;
      r.model.setPaint(paint);
    }
    r.by = p.by;
    // Friends on another map are listed but never drawn in this world.
    r.map = typeof pr.m === 'string' ? pr.m : 'lakecountry';
    r.visible = pr.v === 1 && r.map === MAP.id;
    r.model.root.visible = r.visible;
    r.body.solid = r.visible;
    const now = performance.now();
    if (!r.visible) r.snaps.length = 0;
    const snap = { t: now, x: num(pr.x), y: num(pr.y), z: num(pr.z), h: num(pr.h), s: num(pr.s), tier: num(pr.tr) };
    const lastSnap = r.snaps[r.snaps.length - 1];
    if (r.visible && (!lastSnap || lastSnap.x !== snap.x || lastSnap.z !== snap.z || lastSnap.h !== snap.h || now - lastSnap.t > 500)) {
      r.snaps.push(snap);
      if (r.snaps.length > 12) r.snaps.shift();
    }
    r.last = now;
    r.ev = typeof pr.ev === 'string' ? pr.ev : '';
    r.stars = Math.max(0, Math.min(5, Math.round(num(pr.hs))));
    const rc = pr.rc as Record<string, unknown> | undefined;
    if (rc && typeof rc.code === 'string' && /^[A-Z0-9]{4}$/.test(rc.code) && raceEvents().includes(rc.ev as EventId)) {
      r.race = {
        code: rc.code, ev: rc.ev as EventId, host: !!rc.host, st: rc.st === 'go' || rc.st === 'done' ? rc.st : 'lobby',
        seq: Math.round(num(rc.seq)), prog: num(rc.prog), fin: typeof rc.fin === 'number' ? rc.fin : null,
      };
    } else r.race = null;
  }

  private resolveNames() {
    if (!this.user || this.namesPending) return;
    const ids = new Set<string>();
    for (const r of this.remotes.values()) if (r.by) ids.add(r.by);
    for (const b of Object.values(this.boards)) ids.add(b.uid);
    if (this.myId) ids.add(this.myId);
    const want = [...ids].filter((id) => !this.names.has(id));
    if (!want.length) return this.refreshLabels();
    this.namesPending = true;
    this.user.profiles(want).then((ps) => {
      for (const [id, p] of Object.entries(ps)) this.names.set(id, { name: p.name || (p.isMe ? 'You' : 'Driver'), color: p.color || '#7ad7ff' });
    }).catch(() => {}).finally(() => {
      this.namesPending = false;
      this.refreshLabels();
      this.onChange?.();
    });
  }

  nameOf(uid: string | null) {
    if (!uid) return 'Driver';
    return this.names.get(uid)?.name ?? 'Driver';
  }

  private refreshLabels() {
    for (const r of this.remotes.values()) {
      const n = this.nameOf(r.by);
      r.color = (r.by && this.names.get(r.by)?.color) || '#7ad7ff';
      if (n === r.labelName && r.label) continue;
      if (r.label) { r.model.root.remove(r.label); r.label.material.map?.dispose(); r.label.material.dispose(); }
      r.label = textSprite(n, { color: '#ffffff', bg: 'rgba(10,14,20,0.55)', size: 54, width: 384 });
      r.label.position.y = 2.6;
      r.label.scale.multiplyScalar(0.9);
      r.model.root.add(r.label);
      r.labelName = n;
    }
  }

  private removeRemote(peer: string) {
    const r = this.remotes.get(peer);
    if (!r) return;
    this.disposeRemote(r);
    this.remotes.delete(peer);
  }

  private disposeRemote(r: RemoteCar) {
    this.host.scene.remove(r.model.root);
    r.model.dispose();
  }

  private clearRemotes() {
    for (const r of this.remotes.values()) this.disposeRemote(r);
    this.remotes.clear();
  }

  // ------------------------------------------------------------------ presence out
  update(dt: number, raceProg: number | null) {
    if (!this.room || this.state !== 'on') return;
    // Remote cars: interpolate 120 ms in the past; extrapolate briefly on gaps.
    const now = performance.now();
    for (const r of this.remotes.values()) {
      if (!r.visible) continue;
      const t = now - 120;
      const sn = r.snaps;
      if (!sn.length) continue;
      let x = sn[sn.length - 1].x, y = sn[sn.length - 1].y, z = sn[sn.length - 1].z, h = sn[sn.length - 1].h, s = sn[sn.length - 1].s;
      for (let i = sn.length - 1; i > 0; i--) {
        const a = sn[i - 1], b = sn[i];
        if (a.t <= t && t <= b.t) {
          const k = (t - a.t) / Math.max(1, b.t - a.t);
          x = a.x + (b.x - a.x) * k; y = a.y + (b.y - a.y) * k; z = a.z + (b.z - a.z) * k;
          let dh = b.h - a.h;
          dh = Math.atan2(Math.sin(dh), Math.cos(dh));
          h = a.h + dh * k; s = a.s + (b.s - a.s) * k;
          break;
        }
      }
      const lastSnap = sn[sn.length - 1];
      if (t > lastSnap.t) {
        const ahead = Math.min(0.25, (t - lastSnap.t) / 1000);
        x += Math.sin(lastSnap.h) * lastSnap.s * ahead;
        z += Math.cos(lastSnap.h) * lastSnap.s * ahead;
      }
      const b = r.body;
      b.vx = Math.sin(h) * s;
      b.vz = Math.cos(h) * s;
      b.x = x; b.z = z; b.y = y; b.h = h; b.w = 0;
      r.model.pose(x, y, z, h, 0, 0, 0, (now / 1000) * s * 2.5);
      r.model.setLights(false, false);
    }
    // Our own car, ~15 times a second.
    this.sendTimer -= dt;
    if (this.sendTimer > 0) return;
    this.sendTimer = 1 / 15;
    const p = this.host.player;
    if (!this.host.visible()) {
      // In menus: no car on the map, but race membership still travels (3 Hz).
      this.sendTimer = 1 / 3;
      this.room.presence({ v: 0, m: MAP.id, rc: this.race ? { ...this.race } : null }).catch(() => {});
      this.checkRaceStart();
      return;
    }
    const patch: Record<string, unknown> = {
      v: 1, c: this.host.carId, pt: this.host.paint(),
      x: r1(p.x), y: r2(p.y + p.hopY), z: r1(p.z), h: r2(p.h), s: r1(p.speed), tr: p.drifting ? p.driftTier : -1,
      ev: this.host.eventId(), hs: this.host.stars(), m: MAP.id,
    };
    if (this.race) {
      if (raceProg !== null) this.race.prog = Math.round(raceProg);
      patch.rc = { ...this.race };
    } else patch.rc = null;
    this.room.presence(patch).catch(() => {});
    this.checkRaceStart();
  }

  // ------------------------------------------------------------------ races
  hostRace(ev: EventId) {
    let code = '';
    for (let i = 0; i < 4; i++) code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
    this.race = { code, ev, host: true, st: 'lobby', seq: 0, prog: 0, fin: null };
    this.startedSeq = -1;
    this.sendTimer = 0;
    this.onChange?.();
    return code;
  }

  joinRace(code: string) {
    const hostCar = [...this.remotes.values()].find((r) => r.race?.host && r.race.code === code);
    if (!hostCar?.race) return false;
    this.race = { code, ev: hostCar.race.ev, host: false, st: 'lobby', seq: 0, prog: 0, fin: null };
    // A race already running is joined from the next start.
    this.startedSeq = hostCar.race.st === 'go' ? hostCar.race.seq : -1;
    this.sendTimer = 0;
    this.onChange?.();
    return true;
  }

  leaveRace() {
    this.race = null;
    this.sendTimer = 0;
    this.onChange?.();
  }

  /** Host: start (or restart) the race for everyone with the code. */
  startRace() {
    if (!this.race?.host) return;
    this.race.seq++;
    this.race.st = 'go';
    this.race.fin = null;
    this.race.prog = 0;
    this.startedSeq = this.race.seq;
    this.sendTimer = 0;
    this.host.startRace(this.race.ev, this.slotOf(this.race.code));
    this.onChange?.();
  }

  /** Everyone in the race, sorted the same way on every page (by peer label). */
  racers(code: string) {
    const list: { peer: string; uid: string | null; me: boolean; race: RaceState }[] = [];
    for (const r of this.remotes.values()) if (r.race?.code === code) list.push({ peer: r.peer, uid: r.by, me: false, race: r.race });
    if (this.race?.code === code) list.push({ peer: this.myPeer(), uid: this.myId, me: true, race: this.race });
    list.sort((a, b) => (a.peer < b.peer ? -1 : a.peer > b.peer ? 1 : 0));
    return list;
  }

  private myPeer() {
    const me = this.room?.peers().find((p) => p.sameTab);
    return me?.peer ?? '~me';
  }

  private slotOf(code: string) {
    return Math.max(0, this.racers(code).findIndex((r) => r.me));
  }

  private checkRaceStart() {
    if (!this.race || this.race.host) return;
    const hostCar = [...this.remotes.values()].find((r) => r.race?.host && r.race.code === this.race!.code);
    if (!hostCar?.race) return;
    if (hostCar.race.ev !== this.race.ev) this.race.ev = hostCar.race.ev;
    if (hostCar.race.st === 'go' && hostCar.race.seq !== this.startedSeq) {
      this.startedSeq = hostCar.race.seq;
      this.race.st = 'go';
      this.race.fin = null;
      this.race.prog = 0;
      this.host.startRace(this.race.ev, this.slotOf(this.race.code));
      this.onChange?.();
    }
  }

  /** The local event ended: record the race result in presence. */
  finishRace(score: number | null) {
    if (!this.race || this.race.st !== 'go') return;
    this.race.st = 'done';
    this.race.fin = score;
    this.sendTimer = 0;
    this.onChange?.();
  }

  /** Races being hosted right now (for the join list). */
  openRaces() {
    const out: { code: string; ev: EventId; host: string; count: number; running: boolean }[] = [];
    for (const r of this.remotes.values()) {
      if (!r.race?.host) continue;
      out.push({ code: r.race.code, ev: r.race.ev, host: this.nameOf(r.by), count: this.racers(r.race.code).length, running: r.race.st === 'go' });
    }
    return out;
  }

  /** Live standings for the current race: finished first (best score), then by progress. */
  standings() {
    if (!this.race) return [];
    const lower = EVENTS[this.race.ev].lowerIsBetter;
    const rows = this.racers(this.race.code).map((r) => ({
      name: r.me ? 'You' : this.nameOf(r.uid), me: r.me, st: r.race.st, fin: r.race.fin, prog: r.race.prog,
    }));
    rows.sort((a, b) => {
      const af = a.st === 'done' && a.fin !== null, bf = b.st === 'done' && b.fin !== null;
      if (af && bf) return lower ? a.fin! - b.fin! : b.fin! - a.fin!;
      if (af !== bf) return af ? -1 : 1;
      return b.prog - a.prog;
    });
    return rows;
  }

  // ------------------------------------------------------------------ leaderboard
  /** Save a personal best to the shared board when it beats the stored one. */
  async submitBest(ev: EventId, entry: { score: number; time?: number; car: CarId; diff?: number }, ghost: Ghost | null) {
    if (!this.db || !this.myId || this.canWrite === false) return false;
    const lower = EVENTS[ev].lowerIsBetter;
    const prev = this.myBoard[ev];
    if (prev && (lower ? prev.score <= entry.score : prev.score >= entry.score)) return false;
    const events: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(this.myBoard)) events[k] = { score: v.score, time: v.time ?? null, car: v.car, at: v.at, ghost: !!v.ghost, diff: v.diff ?? 3 };
    events[ev] = { score: entry.score, time: entry.time ?? null, car: entry.car, at: new Date().toISOString(), ghost: !!ghost, diff: entry.diff ?? 3 };
    try {
      if (ghost) {
        await this.db.doc(`boards/${this.myId}/ghosts/${ev}`).set({ course: ghost.course, version: ghost.version, car: ghost.car, time: ghost.time, dt: ghost.dt, ...packGhost(ghost) });
      }
      await this.db.doc(`boards/${this.myId}`).set({ events });
      this.myBoard[ev] = { uid: this.myId, score: entry.score, time: entry.time, car: entry.car, at: String((events[ev] as { at: string }).at), ghost: !!ghost, diff: entry.diff ?? 3 };
      return true;
    } catch {
      this.canWrite = false;
      return false;
    }
  }

  /** Top entries for one event, best first. */
  board(ev: EventId, n = 10) {
    const lower = EVENTS[ev].lowerIsBetter;
    return Object.values(this.boards)
      .filter((b) => this.boards[`${b.uid}|${ev}`] === b)
      .sort((a, b) => (lower ? a.score - b.score : b.score - a.score))
      .slice(0, n)
      .map((b) => ({ ...b, name: b.uid === this.myId ? 'You' : this.nameOf(b.uid) }));
  }

  async loadGhost(uid: string, ev: EventId): Promise<Ghost | null> {
    if (!this.db) return null;
    try {
      const snap = await this.db.doc(`boards/${uid}/ghosts/${ev}`).get();
      const d = snap.data();
      if (!snap.exists || !d || typeof d.data !== 'string') return null;
      const car = PLAYER_CARS.includes(d.car as CarId) ? (d.car as CarId) : 'vesper';
      return { course: String(d.course), version: String(d.version), car, time: num(d.time), dt: num(d.dt, 0.05), samples: unpackGhost({ ox: num(d.ox), oz: num(d.oz), data: d.data }) };
    } catch {
      return null;
    }
  }

  /** Remote cars near a point (for collisions). */
  bodiesNear(x: number, z: number, r = 10) {
    const out: PhysBody[] = [];
    for (const rc of this.remotes.values()) {
      if (rc.visible && Math.abs(rc.body.x - x) < r && Math.abs(rc.body.z - z) < r) out.push(rc.body);
    }
    return out;
  }

  peerCount() {
    return this.remotes.size;
  }

  /** Everything the Online panel shows, as a string: redraw only when it changes. */
  panelKey() {
    const parts: string[] = [this.state, String(this.boardsReady), String(this.canWrite)];
    for (const r of this.remotes.values()) parts.push(`${r.peer}:${this.nameOf(r.by)}:${r.car}:${r.ev}:${r.stars}:${r.race ? `${r.race.code}/${r.race.st}/${r.race.seq}/${r.race.fin}` : ''}`);
    if (this.race) parts.push(`me:${this.race.code}/${this.race.st}/${this.race.seq}/${this.race.fin}`);
    for (const [k, b] of Object.entries(this.boards)) parts.push(`${k}:${b.score}`);
    return parts.join('|');
  }
}
