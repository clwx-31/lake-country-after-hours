// Difficulty levels: one table that every system reads, shown to the player as
// a five-segment meter. Medal thresholds never change, so a gold means the same
// thing on every level; harder levels pay more credits instead.

export interface DifficultyLevel {
  level: 1 | 2 | 3 | 4 | 5;
  label: string;
  blurb: string;
  color: string;
  /** Club rival top speed and cornering, relative to Normal. */
  rivalPace: number;
  /** Police top speed and cornering, relative to Normal. */
  copPace: number;
  /** Police sight range multiplier. */
  copSight: number;
  /** How long a search lasts before you escape (multiplier). */
  searchTime: number;
  /** How long a stopped car takes to be pinned (multiplier; bigger is more forgiving). */
  catchTime: number;
  /** m/s over the posted limit before radar clocks you. */
  radarTolerance: number;
  /** Event time limits (multiplier). */
  timeLimit: number;
  /** Damage taken: your car and Last Set's cargo (multiplier). */
  damage: number;
  /** Police tire-shot hit chance (multiplier). */
  copAccuracy: number;
  /** Rocket reload time (multiplier; smaller is harder). */
  rocketReload: number;
  /** Nitro refill rate (multiplier). */
  nitroRefill: number;
  /** Event and escape payouts (multiplier). */
  payout: number;
}

export const DIFFICULTIES: DifficultyLevel[] = [
  { level: 1, label: 'Cruise', blurb: 'Slow, forgiving police; roomy time limits; extra nitro.', color: '#79d98a', rivalPace: 0.82, copPace: 0.8, copSight: 0.75, searchTime: 0.6, catchTime: 1.6, radarTolerance: 6, timeLimit: 1.25, damage: 0.5, copAccuracy: 0.4, rocketReload: 1.5, nitroRefill: 1.5, payout: 0.8 },
  { level: 2, label: 'Easy', blurb: 'Police ease off sooner; a little extra time and nitro.', color: '#b8e06a', rivalPace: 0.92, copPace: 0.9, copSight: 0.88, searchTime: 0.8, catchTime: 1.25, radarTolerance: 4, timeLimit: 1.12, damage: 0.75, copAccuracy: 0.7, rocketReload: 1.2, nitroRefill: 1.2, payout: 0.9 },
  { level: 3, label: 'Normal', blurb: 'The game as designed.', color: '#ffb347', rivalPace: 1, copPace: 1, copSight: 1, searchTime: 1, catchTime: 1, radarTolerance: 2.2, timeLimit: 1, damage: 1, copAccuracy: 1, rocketReload: 1, nitroRefill: 1, payout: 1 },
  { level: 4, label: 'Hard', blurb: 'Faster rival and police who see further and search longer.', color: '#ff7a3c', rivalPace: 1.07, copPace: 1.08, copSight: 1.15, searchTime: 1.25, catchTime: 0.8, radarTolerance: 1, timeLimit: 0.92, damage: 1.3, copAccuracy: 1.25, rocketReload: 0.85, nitroRefill: 0.9, payout: 1.2 },
  { level: 5, label: 'Insane', blurb: 'Relentless police, a rival at the limit, tight clocks, fragile cargo.', color: '#ff4b4b', rivalPace: 1.13, copPace: 1.16, copSight: 1.3, searchTime: 1.5, catchTime: 0.65, radarTolerance: 0.3, timeLimit: 0.85, damage: 1.6, copAccuracy: 1.5, rocketReload: 0.7, nitroRefill: 0.8, payout: 1.45 },
];

export function difficulty(level: number): DifficultyLevel {
  const n = Number.isFinite(level) ? Math.round(level) : 3;
  return DIFFICULTIES[Math.max(1, Math.min(5, n)) - 1];
}

/** Five-segment meter as HTML (segments filled up to the level, in its colour). */
export function difficultyMeterHtml(level: number) {
  const d = difficulty(level);
  const segs = DIFFICULTIES.map((x) => `<i class="${x.level <= d.level ? 'on' : ''}" style="${x.level <= d.level ? `background:${d.color}` : ''}"></i>`).join('');
  return `<span class="diff-meter" title="Difficulty: ${d.label}"><span class="segs">${segs}</span><b style="color:${d.color}">${d.label}</b></span>`;
}
