import { describe, expect, it } from 'vitest';
import { escapeHtml, plausibleScore, readPresence } from '../src/net/Online';

const bounds = { minX: -1000, maxX: 1000, minZ: -1000, maxZ: 1000 };

describe('online: data from other players is untrusted', () => {
  it('clamps a friend\'s car to the map and to possible speeds', () => {
    const p = readPresence({ v: 1, c: 'zenith', pt: '#ff0000', m: 'ironport', x: 1e12, y: -1e9, z: Number.NaN, h: 1e300, s: 99999, tr: 42, hs: 77, ev: 'ip-hot' }, bounds);
    expect(p.car).toBe('zenith');
    expect(p.x).toBe(1300);
    expect(p.y).toBe(-100);
    expect(p.z).toBe(0);
    expect(p.s).toBe(200);
    expect(p.tier).toBe(3);
    expect(p.stars).toBe(5);
    expect(p.map).toBe('ironport');
    expect(p.ev).toBe('ip-hot');
    expect(Math.abs(p.h)).toBeLessThan(Math.PI * 2);
  });

  it('rejects unknown cars, maps, paints and events', () => {
    const p = readPresence({ v: 1, c: 'tank', pt: 'url(javascript:alert(1))', m: '__proto__', ev: '<img src=x onerror=alert(1)>' }, bounds);
    expect(p.car).toBe('vesper');
    expect(p.paint).toBeNull();
    expect(p.map).toBe('lakecountry');
    expect(p.ev).toBe('');
    expect(readPresence({ v: 7 }, bounds).v).toBe(-1);
  });

  it('hides leaderboard scores no car could post', () => {
    expect(plausibleScore('circuit', 140)).toBe(true);
    expect(plausibleScore('circuit', 3)).toBe(false); // gold is 128 s
    expect(plausibleScore('circuit', -5)).toBe(false);
    expect(plausibleScore('air', 1e9)).toBe(false);
    expect(plausibleScore('air', 30000)).toBe(true);
    expect(plausibleScore('ip-siege', 180)).toBe(true);
    expect(plausibleScore('nope', 10)).toBe(false);
    expect(plausibleScore('constructor', 10)).toBe(false);
    expect(plausibleScore('__proto__', 10)).toBe(false);
  });

  it('escapes names before they go into HTML', () => {
    expect(escapeHtml('<img src=x onerror="alert(1)">')).toBe('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;');
  });
});
