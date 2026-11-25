import { describe, expect, it } from 'vitest';
import { EVENTS, lastSetPayout, medalFor } from '../src/events/defs';
import { Save, type Storage } from '../src/save/Save';
import { PLAYER_CARS } from '../src/sim/cars';

class MemStore implements Storage {
  m = new Map<string, string>();
  getItem(k: string) { return this.m.get(k) ?? null; }
  setItem(k: string, v: string) { this.m.set(k, v); }
}

describe('payouts, medals, and saves', () => {
  it('Last Set rewards a smooth slower run over a messy sprint', () => {
    const smooth = lastSetPayout(35, 100);
    const messy = lastSetPayout(60, 55);
    expect(smooth).toBeGreaterThan(messy);
  });

  it('medals follow the event thresholds', () => {
    expect(medalFor(EVENTS.circuit, EVENTS.circuit.medals.gold - 1)).toBe('gold');
    expect(medalFor(EVENTS.circuit, EVENTS.circuit.medals.bronze - 1)).toBe('bronze');
    expect(medalFor(EVENTS.circuit, 400)).toBeNull();
    expect(medalFor(EVENTS.lastset, EVENTS.lastset.medals.gold)).toBe('gold');
    expect(medalFor(EVENTS.air, EVENTS.air.medals.silver)).toBe('silver');
  });

  it('awards each attempt once even if retry is hammered', () => {
    const s = new Save(new MemStore());
    const first = s.award('circuit-a1', 'circuit', 1000, 'bronze');
    const again = s.award('circuit-a1', 'circuit', 1000, 'bronze');
    expect(first.paid).toBe(1200);
    expect(again.duplicate).toBe(true);
    expect(s.data.credits).toBe(1200);
    // A better medal later pays only the new tiers.
    const better = s.award('circuit-a2', 'circuit', 1000, 'gold');
    expect(better.medalBonus).toBe(350 + 500);
  });

  it('every car is in the garage from the start, including old saves', () => {
    expect(new Save(new MemStore()).data.owned).toEqual(expect.arrayContaining(PLAYER_CARS));
    const store = new MemStore();
    store.setItem('waukesha-after-hours/save-v1', JSON.stringify({ version: 1, map: 'lakecountry-1', owned: ['finch', 'vesper'], selected: 'vesper' }));
    expect(new Save(store).data.owned).toEqual(expect.arrayContaining(PLAYER_CARS));
    expect(PLAYER_CARS.length).toBeGreaterThanOrEqual(20);
  });

  it('keeps each map\'s medals and times when you switch maps and back', () => {
    const store = new MemStore();
    const lake = new Save(store, 'lakecountry-1');
    lake.award('c1', 'circuit', 1000, 'gold');
    lake.submitBest('circuit', { score: 120, date: '' }, false);
    const hill = new Save(store, 'holyhill-1');
    expect(hill.data.medals).toEqual({});
    expect(hill.data.credits).toBe(2050); // 1000 + bronze, silver and gold bonuses carry over
    hill.award('h1', 'hh-loop', 800, 'silver');
    const back = new Save(store, 'lakecountry-1');
    expect(back.data.medals).toEqual({ circuit: 'gold' });
    expect(back.data.bests.circuit.score).toBe(120);
    expect(back.data.records['holyhill-1'].medals).toEqual({ 'hh-loop': 'silver' });
    expect(new Save(store, 'holyhill-1').data.medals).toEqual({ 'hh-loop': 'silver' });
  });

  it('remembers a fitted ability per car and drops unknown ones', () => {
    const store = new MemStore();
    const s = new Save(store);
    s.data.abilities.finch = 'grapple';
    (s.data.abilities as Record<string, string>).vesper = 'not-a-power';
    s.persist();
    const r = new Save(store);
    expect(r.data.abilities.finch).toBe('grapple');
    expect(r.data.abilities.vesper).toBeUndefined();
  });

  it('moving off the first (Waukesha) map keeps cars and credits but parks its old event records', () => {
    const store = new MemStore();
    store.setItem('waukesha-after-hours/save-v1', JSON.stringify({
      version: 1, credits: 2300, owned: ['finch', 'vesper', 'foundry'], selected: 'foundry', paint: { foundry: '#123456' },
      medals: { circuit: 'gold', drift: 'silver' }, bests: { circuit: { score: 120, date: '' } }, ghosts: {}, awarded: [], settings: {}, stats: {},
    }));
    const s = new Save(store);
    expect(s.data.owned).toContain('foundry');
    expect(s.data.credits).toBe(2300);
    expect(s.data.paint.foundry).toBe('#123456');
    expect(s.data.medals).toEqual({});
    expect(s.data.bests).toEqual({});
    expect(s.data.settings.timeOfDay).toBe('golden');
  });

  it('keeps the better ghost and best time, and survives a reload', () => {
    const store = new MemStore();
    const s = new Save(store);
    expect(s.submitGhost({ course: 'circuit', version: 'v1', car: 'finch', time: 130, dt: 0.05, samples: [0, 0, 0] })).toBe(true);
    expect(s.submitGhost({ course: 'circuit', version: 'v1', car: 'finch', time: 140, dt: 0.05, samples: [1, 1, 1] })).toBe(false);
    expect(s.submitBest('circuit', { score: 130, date: '' }, false).better).toBe(true);
    expect(s.submitBest('circuit', { score: 140, date: '' }, false).better).toBe(false);
    const reloaded = new Save(store);
    expect(reloaded.data.bests.circuit.score).toBe(130);
    expect(reloaded.ghostFor('circuit', 'v1')?.time).toBe(130);
    expect(reloaded.ghostFor('circuit', 'v2')).toBeNull();
  });
});

describe('online ghost packing', () => {
  it('round-trips a ghost through the compact string within a few centimeters', async () => {
    const { packGhost, unpackGhost } = await import('../src/net/Online');
    const samples: number[] = [];
    for (let i = 0; i < 2400; i++) samples.push(-1200 + i * 1.7, 3100 - Math.sin(i / 40) * 300, Math.sin(i / 30) * 3);
    const g = { course: 'circuit', version: 'v', car: 'finch' as const, time: 120, dt: 0.05, samples };
    const packed = packGhost(g);
    expect(packed.data.length).toBeLessThan(2400 * 3 * 2 * 1.4 + 8);
    const back = unpackGhost(packed);
    expect(back.length).toBe(samples.length);
    let worst = 0;
    for (let i = 0; i < samples.length; i++) worst = Math.max(worst, Math.abs(back[i] - samples[i]));
    expect(worst).toBeLessThan(0.06);
  });
});

describe('difficulty meter', () => {
  it('has five levels that get strictly harder and pay strictly more', async () => {
    const { DIFFICULTIES, difficulty } = await import('../src/game/difficulty');
    expect(DIFFICULTIES.map((d) => d.label)).toEqual(['Cruise', 'Easy', 'Normal', 'Hard', 'Insane']);
    for (let i = 1; i < DIFFICULTIES.length; i++) {
      const a = DIFFICULTIES[i - 1], b = DIFFICULTIES[i];
      expect(b.rivalPace).toBeGreaterThan(a.rivalPace);
      expect(b.copPace).toBeGreaterThan(a.copPace);
      expect(b.copSight).toBeGreaterThan(a.copSight);
      expect(b.searchTime).toBeGreaterThan(a.searchTime);
      expect(b.catchTime).toBeLessThan(a.catchTime);
      expect(b.radarTolerance).toBeLessThan(a.radarTolerance);
      expect(b.timeLimit).toBeLessThan(a.timeLimit);
      expect(b.damage).toBeGreaterThan(a.damage);
      expect(b.payout).toBeGreaterThan(a.payout);
      expect(b.copAccuracy).toBeGreaterThan(a.copAccuracy);
      expect(b.rocketReload).toBeLessThan(a.rocketReload);
    }
    const normal = difficulty(3);
    for (const k of ['rivalPace', 'copPace', 'copSight', 'searchTime', 'catchTime', 'timeLimit', 'damage', 'copAccuracy', 'rocketReload', 'nitroRefill', 'payout'] as const) expect(normal[k]).toBe(1);
    expect(difficulty(0).level).toBe(1);
    expect(difficulty(9).level).toBe(5);
  });

  it('defaults old saves to Normal', () => {
    const store = new MemStore();
    store.setItem('waukesha-after-hours/save-v1', JSON.stringify({ version: 1, map: 'lakecountry-1', settings: { master: 0.5 } }));
    expect(new Save(store).data.settings.difficulty).toBe(3);
  });
});
