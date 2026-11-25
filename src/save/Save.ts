// Local persistence: unlocks, paint, selected car, settings, medals, best times,
// ghosts (with course version), and the ledger that makes awards idempotent.
import type { TimeId } from '../render/TimeOfDay';
import { CARS, PLAYER_CARS, STARTER_CARS, type AbilityId, type CarId } from '../sim/cars';
import { ABILITY_IDS } from '../sim/abilityInfo';
import { WEAPON_IDS, type WeaponId } from '../sim/weapons';

/** Default map records id. Event bests, ghosts and medals belong to one map version. */
export const MAP_ID = 'lakecountry-1';

/** One map's event records. */
export interface MapRecords {
  medals: Record<string, Medal>;
  bests: Record<string, Best>;
  ghosts: Record<string, Ghost>;
}

export type Medal = 'gold' | 'silver' | 'bronze';
export const MEDAL_RANK: Record<Medal, number> = { bronze: 1, silver: 2, gold: 3 };
export const MEDAL_BONUS: Record<Medal, number> = { bronze: 200, silver: 350, gold: 500 };

export interface Settings {
  master: number;
  music: number;
  engine: number;
  effects: number;
  reducedShake: boolean;
  reducedFlashing: boolean;
  lowEffects: boolean;
  quietDrive: boolean;
  wideCamera: boolean;
  showFps: boolean;
  trafficDensity: number;
  timeOfDay: TimeId;
  playerName: string;
  /** 1 Cruise .. 5 Insane (3 Normal). */
  difficulty: number;
}

export interface Ghost {
  course: string;
  version: string;
  car: CarId;
  time: number;
  /** x, z, h triples sampled every `dt` seconds. */
  dt: number;
  samples: number[];
}

export interface Best {
  score: number;
  time?: number;
  splits?: number[];
  car?: CarId;
  date: string;
}

export interface SaveData {
  version: 1;
  map: string;
  credits: number;
  owned: CarId[];
  selected: CarId;
  paint: Partial<Record<CarId, string>>;
  medals: Record<string, Medal>;
  bests: Record<string, Best>;
  ghosts: Record<string, Ghost>;
  awarded: string[];
  /** Damage carried between sessions: health and flat tires per car. */
  condition: Partial<Record<CarId, { h: number; f: boolean[] }>>;
  /** Equipped ability per car (absent = the car's signature). */
  abilities: Partial<Record<CarId, AbilityId>>;
  /** Weapon fitted per car, when it is not the car's standard one. */
  weapons: Partial<Record<CarId, WeaponId>>;
  /** Event records of the maps that are not loaded right now. */
  records: Record<string, MapRecords>;
  settings: Settings;
  stats: { escapes: number; captures: number; events: number };
}

const KEY = 'waukesha-after-hours/save-v1'; // kept so garages carry over from the first map

export const DEFAULT_SETTINGS: Settings = {
  master: 0.8, music: 0.6, engine: 0.75, effects: 0.8,
  reducedShake: false, reducedFlashing: false, lowEffects: false, quietDrive: false,
  wideCamera: false, showFps: false, trafficDensity: 1, timeOfDay: 'golden', playerName: '', difficulty: 3,
};

export function defaultSave(): SaveData {
  return {
    version: 1, map: MAP_ID, credits: 0, owned: [...STARTER_CARS], selected: 'vesper', paint: {}, medals: {}, bests: {}, ghosts: {},
    awarded: [], condition: {}, abilities: {}, weapons: {}, records: {}, settings: { ...DEFAULT_SETTINGS }, stats: { escapes: 0, captures: 0, events: 0 },
  };
}

export interface Storage {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
}

export class Save {
  data: SaveData;

  constructor(private storage: Storage | null = safeStorage(), readonly mapId = MAP_ID) {
    this.data = this.load();
  }

  private load(): SaveData {
    const mapId = this.mapId;
    try {
      const raw = this.storage?.getItem(KEY);
      if (!raw) return { ...defaultSave(), map: mapId };
      const parsed = JSON.parse(raw) as Partial<SaveData>;
      const base = defaultSave();
      const data: SaveData = {
        ...base,
        ...parsed,
        settings: { ...base.settings, ...(parsed.settings ?? {}) },
        stats: { ...base.stats, ...(parsed.stats ?? {}) },
      } as SaveData;
      data.owned = [...new Set([...STARTER_CARS, ...(data.owned ?? []).filter((c) => PLAYER_CARS.includes(c))])];
      if (!data.records || typeof data.records !== 'object') data.records = {};
      if (parsed.map !== mapId) {
        // Another map was loaded last: park its records and bring this map's back.
        if (parsed.map) data.records[parsed.map] = { medals: data.medals ?? {}, bests: data.bests ?? {}, ghosts: data.ghosts ?? {} };
        const r = data.records[mapId];
        delete data.records[mapId];
        data.map = mapId;
        data.medals = r?.medals ?? {};
        data.bests = r?.bests ?? {};
        data.ghosts = r?.ghosts ?? {};
      }
      if (!data.abilities || typeof data.abilities !== 'object') data.abilities = {};
      for (const [car, a] of Object.entries(data.abilities)) if (!ABILITY_IDS.includes(a as AbilityId)) delete data.abilities[car as CarId];
      if (!data.weapons || typeof data.weapons !== 'object') data.weapons = {};
      for (const [car, w] of Object.entries(data.weapons)) if (!WEAPON_IDS.includes(w as WeaponId)) delete data.weapons[car as CarId];
      if (!['golden', 'day', 'evening'].includes(data.settings.timeOfDay)) data.settings.timeOfDay = 'golden';
      if (![1, 2, 3, 4, 5].includes(data.settings.difficulty)) data.settings.difficulty = 3;
      if (!data.condition || typeof data.condition !== 'object') data.condition = {};
      if (!data.owned.includes(data.selected)) data.selected = 'vesper';
      return data;
    } catch {
      return { ...defaultSave(), map: mapId };
    }
  }

  persist() {
    try {
      this.storage?.setItem(KEY, JSON.stringify(this.data));
    } catch {
      /* storage unavailable (private mode); progress lives for this session only */
    }
  }

  medalCount() {
    return Object.values(this.data.medals).reduce((n, m) => n + MEDAL_RANK[m], 0);
  }

  canUnlock(id: CarId) {
    const u = CARS[id].unlock;
    if (!u || this.data.owned.includes(id)) return { ok: false, by: null as null | 'medals' | 'credits' };
    if (this.medalCount() >= u.medals) return { ok: true, by: 'medals' as const };
    if (this.data.credits >= u.credits) return { ok: true, by: 'credits' as const };
    return { ok: false, by: null };
  }

  unlock(id: CarId) {
    const c = this.canUnlock(id);
    if (!c.ok) return false;
    if (c.by === 'credits') this.data.credits -= CARS[id].unlock!.credits;
    this.data.owned.push(id);
    this.persist();
    return true;
  }

  /**
   * Record an event result exactly once per attempt id. Returns what was paid
   * (0 when the attempt was already awarded).
   */
  award(attemptId: string, eventId: string, payout: number, medal: Medal | null) {
    if (this.data.awarded.includes(attemptId)) return { paid: 0, medalBonus: 0, newMedal: false, duplicate: true };
    this.data.awarded.push(attemptId);
    if (this.data.awarded.length > 400) this.data.awarded.splice(0, this.data.awarded.length - 400);
    let medalBonus = 0;
    let newMedal = false;
    if (medal) {
      const prev = this.data.medals[eventId];
      if (!prev || MEDAL_RANK[medal] > MEDAL_RANK[prev]) {
        // Bonus for each newly reached tier.
        for (const tier of ['bronze', 'silver', 'gold'] as Medal[]) {
          if (MEDAL_RANK[tier] <= MEDAL_RANK[medal] && (!prev || MEDAL_RANK[tier] > MEDAL_RANK[prev])) medalBonus += MEDAL_BONUS[tier];
        }
        this.data.medals[eventId] = medal;
        newMedal = true;
      }
    }
    this.data.credits += payout + medalBonus;
    this.data.stats.events++;
    this.persist();
    return { paid: payout + medalBonus, medalBonus, newMedal, duplicate: false };
  }

  /** Bank a pursuit reward once per pursuit id. */
  bank(id: string, amount: number) {
    if (this.data.awarded.includes(id)) return 0;
    this.data.awarded.push(id);
    this.data.credits += amount;
    this.persist();
    return amount;
  }

  /** Store a best if it beats the previous one. higherIsBetter for scores, lower for times. */
  submitBest(eventId: string, best: Best, higherIsBetter: boolean) {
    const prev = this.data.bests[eventId];
    const better = !prev || (higherIsBetter ? best.score > prev.score : best.score < prev.score);
    if (better) {
      this.data.bests[eventId] = best;
      this.persist();
    }
    return { better, previous: prev ?? null };
  }

  /** A ghost is replaced only by a faster run on the same course version. */
  submitGhost(g: Ghost) {
    const prev = this.data.ghosts[g.course];
    if (prev && prev.version === g.version && prev.time <= g.time) return false;
    this.data.ghosts[g.course] = g;
    this.persist();
    return true;
  }

  ghostFor(course: string, version: string) {
    const g = this.data.ghosts[course];
    return g && g.version === version ? g : null;
  }
}

function safeStorage(): Storage | null {
  try {
    const s = window.localStorage;
    const probe = '__wah_probe';
    s.setItem(probe, '1');
    s.removeItem(probe);
    return s;
  } catch {
    return null;
  }
}
