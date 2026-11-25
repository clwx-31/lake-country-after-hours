// Data-driven wanted level. Pure logic: no rendering, no physics, so the
// transitions (pursuit -> search -> escape / caught) can be tested directly.

export type UnitType = 'cruiser' | 'interceptor' | 'tank' | 'warden';

export interface HeatLevel {
  stars: number;
  minPoints: number;
  maxUnits: number;
  roster: UnitType[]; // unit types in join order
  searchTime: number; // seconds for the search meter to clear
  sight: number; // virtual sight range (m)
  multiplier: number;
  musicLayers: number;
  escapeReward: number;
  bonusGate?: boolean;
  roadblocks?: boolean;
  crescendo?: number; // seconds
  /** A police helicopter joins and keeps sight from the air. */
  helicopter?: boolean;
  /** Spike strips across the road ahead. */
  spikes?: boolean;
  /** The helicopter's marksman shoots at tires. */
  marksman?: boolean;
}

/** Cruisers and interceptors shoot at tires from this many stars. */
export const SHOOT_FROM_STARS = 3;

export const HEAT_LEVELS: HeatLevel[] = [
  { stars: 0, minPoints: 0, maxUnits: 0, roster: [], searchTime: 0, sight: 120, multiplier: 1, musicLayers: 0, escapeReward: 0 },
  { stars: 1, minPoints: 1, maxUnits: 1, roster: ['cruiser'], searchTime: 9, sight: 140, multiplier: 1, musicLayers: 1, escapeReward: 150 },
  { stars: 2, minPoints: 9, maxUnits: 2, roster: ['cruiser', 'cruiser'], searchTime: 12, sight: 150, multiplier: 1.5, musicLayers: 2, escapeReward: 350 },
  { stars: 3, minPoints: 20, maxUnits: 3, roster: ['cruiser', 'cruiser', 'interceptor'], searchTime: 15, sight: 165, multiplier: 2, musicLayers: 3, escapeReward: 650, bonusGate: true },
  { stars: 4, minPoints: 34, maxUnits: 4, roster: ['cruiser', 'cruiser', 'interceptor', 'cruiser'], searchTime: 18, sight: 175, multiplier: 2.5, musicLayers: 4, escapeReward: 1000, bonusGate: true, roadblocks: true, helicopter: true, spikes: true },
  { stars: 5, minPoints: 52, maxUnits: 5, roster: ['cruiser', 'interceptor', 'tank', 'cruiser', 'tank'], searchTime: 21, sight: 185, multiplier: 3, musicLayers: 5, escapeReward: 1500, bonusGate: true, roadblocks: true, crescendo: 75, helicopter: true, spikes: true, marksman: true },
];

/** Heat points for distinct actions. Collisions are debounced per body and globally. */
export const HEAT_AWARDS = {
  witnessedCrash: 4,
  hitPolice: 6,
  hitParked: 2,
  pursuitMinute: 7,
  bonusGate: 6,
  roadblockRun: 5,
  speedTrap: 4, // clocked by a posted unit
  spotted: 1, // Ironport: seen by any officer
  shotsFired: 5, // firing a weapon where police can see
  copDown: 8, // wrecking a unit or the helicopter
  eventGate: 0, // event milestones set stars directly
};
export const DEBOUNCE = { perBody: 4, global: 1.5 };
export const CAUGHT = { fill: 3.2, drain: 1.6, speed: 3, radius: 11 };
export const LOS_GRACE = 1.6; // seconds without sight before Searching

export type HeatPhase = 'calm' | 'pursuit' | 'search';
export type HeatEvent =
  | { type: 'star'; stars: number; reason: string }
  | { type: 'search' }
  | { type: 'reacquired' }
  | { type: 'escaped'; reward: number; stars: number }
  | { type: 'caught'; stars: number }
  | { type: 'crescendo-start' }
  | { type: 'crescendo-end' };

export function starsFor(points: number) {
  let s = 0;
  for (const l of HEAT_LEVELS) if (points >= l.minPoints) s = l.stars;
  return s;
}

export class HeatState {
  /** Difficulty: search length and time-to-pin multipliers. */
  searchScale = 1;
  catchScale = 1;
  points = 0;
  stars = 0;
  phase: HeatPhase = 'calm';
  reason = '';
  searchMeter = 1;
  caughtMeter = 0;
  sinceSeen = 0;
  score = 0;
  crescendo = 0;
  crescendoUsed = false;
  quiet = false;
  /** Encore and other events may force pursuit even in Quiet Drive. */
  forced = false;
  /** The search cannot end this pursuit (Encore, Siege, Breakout). */
  hold = false;
  /** A unit has had eyes on the player since this pursuit began. */
  contact = false;
  private sinceStart = 0;
  private lastAward = -99;
  private bodyAward = new Map<number, number>();
  private pursuitClock = 0;
  readonly events: HeatEvent[] = [];

  get level() {
    return HEAT_LEVELS[this.stars];
  }

  get active() {
    return this.stars > 0;
  }

  /**
   * Award heat for an action. Returns true if it counted. A single award can
   * raise the wanted level by at most one star.
   */
  award(points: number, reason: string, now: number, bodyId?: number): boolean {
    if (this.quiet && !this.forced) return false;
    if (points <= 0) return false;
    if (bodyId !== undefined) {
      if (now - this.lastAward < DEBOUNCE.global) return false;
      const last = this.bodyAward.get(bodyId);
      if (last !== undefined && now - last < DEBOUNCE.perBody) return false;
      this.bodyAward.set(bodyId, now);
      this.lastAward = now;
    }
    const before = this.stars;
    const cap = before < 5 ? HEAT_LEVELS[before + 1].minPoints : Infinity;
    this.points = Math.min(this.points + points, Math.max(cap, this.points));
    this.raiseTo(starsFor(this.points), reason);
    if (before === 0) this.enterPursuit(reason);
    return true;
  }

  /** Event milestones (Encore gates) set the level directly. */
  setStars(stars: number, reason: string) {
    stars = Math.max(0, Math.min(5, stars));
    if (stars <= this.stars) return;
    const before = this.stars;
    this.points = Math.max(this.points, HEAT_LEVELS[stars].minPoints);
    this.raiseTo(stars, reason);
    if (before === 0) this.enterPursuit(reason);
  }

  private raiseTo(stars: number, reason: string) {
    while (this.stars < stars) {
      this.stars++;
      this.reason = reason;
      this.events.push({ type: 'star', stars: this.stars, reason });
      const lvl = HEAT_LEVELS[this.stars];
      if (lvl.crescendo && !this.crescendoUsed) {
        this.crescendo = lvl.crescendo;
        this.crescendoUsed = true;
        this.events.push({ type: 'crescendo-start' });
      }
    }
  }

  private enterPursuit(reason: string) {
    this.phase = 'pursuit';
    this.reason = reason;
    this.sinceSeen = 0;
    this.searchMeter = 1;
    this.contact = false;
    this.sinceStart = 0;
  }

  /**
   * Advance with real seconds. `seen` = any engaged unit currently has the
   * player in sight. `pinned` = player nearly stationary with an engaged unit close.
   */
  update(dt: number, seen: boolean, pinned: boolean) {
    if (this.stars === 0) {
      this.phase = 'calm';
      return;
    }
    if (this.crescendo > 0) {
      this.crescendo = Math.max(0, this.crescendo - dt);
      if (this.crescendo === 0) this.events.push({ type: 'crescendo-end' });
    }
    if (this.phase === 'pursuit') {
      this.score += dt * 12 * this.level.multiplier;
      this.pursuitClock += dt;
      if (this.pursuitClock >= 60) {
        this.pursuitClock -= 60;
        this.award(HEAT_AWARDS.pursuitMinute, 'Sustained pursuit', Number.POSITIVE_INFINITY);
      }
      this.sinceStart += dt;
      if (seen) this.contact = true;
      // Units first have to find you: searching starts only after contact, or
      // once responders have had a fair chance to arrive.
      if (seen || (!this.contact && this.sinceStart < 20)) this.sinceSeen = 0;
      else {
        this.sinceSeen += dt;
        if (this.sinceSeen >= LOS_GRACE) {
          this.phase = 'search';
          this.searchMeter = 1;
          this.events.push({ type: 'search' });
        }
      }
    } else if (this.phase === 'search') {
      if (seen) {
        this.phase = 'pursuit';
        this.sinceSeen = 0;
        this.events.push({ type: 'reacquired' });
      } else {
        this.searchMeter = Math.max(0, this.searchMeter - dt / (this.level.searchTime * this.searchScale));
        // Some opt-in pursuit events keep the heat on until they end.
        if (this.hold) this.searchMeter = Math.max(this.searchMeter, 0.12);
        if (this.searchMeter === 0) this.escape();
      }
    }
    // Caught meter fills only while pinned; it drains when the player pulls free.
    if (pinned && this.phase !== 'calm') this.caughtMeter = Math.min(1, this.caughtMeter + dt / (CAUGHT.fill * this.catchScale));
    else this.caughtMeter = Math.max(0, this.caughtMeter - dt / CAUGHT.drain);
    if (this.caughtMeter >= 1) {
      const stars = this.stars;
      this.reset();
      this.events.push({ type: 'caught', stars });
    }
  }

  escape() {
    const lvl = this.level;
    const reward = Math.round(lvl.escapeReward + this.score);
    const stars = this.stars;
    this.reset();
    this.events.push({ type: 'escaped', reward, stars });
  }

  reset() {
    this.points = 0;
    this.stars = 0;
    this.phase = 'calm';
    this.searchMeter = 1;
    this.caughtMeter = 0;
    this.sinceSeen = 0;
    this.score = 0;
    this.crescendo = 0;
    this.crescendoUsed = false;
    this.pursuitClock = 0;
    this.reason = '';
    this.contact = false;
    this.sinceStart = 0;
    this.bodyAward.clear();
  }

  drain() {
    return this.events.splice(0, this.events.length);
  }
}
