// Dev helper: equips every ability in turn on a straight road with police
// units placed around the car, fires it, and reports a measurable effect.
// Usage: node scripts/ability-check.mjs <outDir> [baseUrl]
import { chromium } from 'playwright';
import fs from 'node:fs';
const [,, out, base = 'http://localhost:5173/'] = process.argv;
fs.mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errs = [];
page.on('pageerror', (e) => errs.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
await page.goto(base + '?map=holyhill');
await page.waitForFunction(() => window.__game, null, { timeout: 180000 });
const G = (fn, arg) => page.evaluate(fn, arg);
await G(() => {
  const g = window.__game;
  g.enterDrive();
  g.save.data.settings.quietDrive = true;
  g.traffic.density = 0;
  // Straight, wooded stretch of Shannon Road.
  const e = g.d.edges.find((x) => x.name === 'Shannon Road' && x.length > 600);
  const p = e.path.pointAt(e.length * 0.3);
  window.__spot = { x: p.x, z: p.z, h: e.path.headingAt(e.length * 0.3), e: e.index, s: e.length * 0.3 };
  window.__reset = (speed = 0) => {
    const s = window.__spot;
    g.pursuit.clearAll();
    g.placePlayer(s.x, s.z, s.h, speed);
    g.player.repair();
    g.setTimeWarp(1);
  };
  /** A police unit `ahead` metres along the road (negative = behind), `side` metres to the right. */
  window.__unit = (ahead, side = 0, type = 'cruiser') => {
    const s = window.__spot, e = g.d.edges[s.e];
    const q = e.path.pointAt(Math.max(1, Math.min(e.length - 1, s.s + ahead)));
    const h = e.path.headingAt(s.s + ahead);
    const u = g.pursuit.makeUnit(type, q.x - Math.cos(h) * side, q.z + Math.sin(h) * side, h, 0);
    u.state = 'chase';
    return u;
  };
});
const wait = (ms) => page.waitForTimeout(ms);
const results = {};
async function check(id, setup, measure, waitMs = 600, shot = false) {
  await G(([id]) => { const g = window.__game; window.__reset(); g.setAbilityFor(g.carId, id); }, [id]);
  await G(setup);
  await wait(150);
  const fired = await G(() => window.__game.ability.trigger(window.__game.player));
  await wait(waitMs);
  if (shot) await page.screenshot({ path: `${out}/${id}.png` });
  const r = await G(measure);
  results[id] = { fired, ...r };
  console.log(id.padEnd(14), JSON.stringify(results[id]));
}
await check('superstar', () => {}, () => { const g = window.__game, p = g.player; return { invincible: !!p.mods.invincible, hurt: p.hurt(30), top: p.mods.topSpeedMul }; }, 500, true);
await check('phantom', () => { window.__unit(25, 0); }, () => { const g = window.__game; return { phase: !!g.player.mods.phase, cloak: +g.pursuit.cloak.toFixed(1), unitSees: g.pursuit.units[0]?.sees }; }, 400, true);
await check('shockwave', () => { window.__unit(14, 2); window.__unit(-12, -2); }, () => { const g = window.__game; return { stalled: g.pursuit.units.filter((u) => u.stall > 0).length, speeds: g.pursuit.units.map((u) => +u.v.speed.toFixed(1)) }; }, 250, true);
await check('oilSlick', () => { const g = window.__game; g.placePlayer(window.__spot.x, window.__spot.z, window.__spot.h, 0); }, () => { const g = window.__game; return { hazards: g.pursuit.hazards.map((h) => h.kind) }; }, 300, false);
// A unit driven over the slick spins out.
results.oilSlick.spin = await G(async () => { const g = window.__game, hz = g.pursuit.hazards[0]; const u = window.__unit(-20, 0); u.v.place(hz.x, hz.z, u.v.h, 6); await new Promise((r) => setTimeout(r, 300)); return { stall: +u.stall.toFixed(2), spin: u.spin }; });
console.log('oilSlick+unit ', JSON.stringify(results.oilSlick.spin));
await page.screenshot({ path: `${out}/oilSlick.png` });
await check('caltrops', () => {}, () => ({ hazards: window.__game.pursuit.hazards.map((h) => h.kind) }), 300, false);
results.caltrops.unit = await G(async () => { const g = window.__game, hz = g.pursuit.hazards[0]; const u = window.__unit(-20, 0); u.v.place(hz.x, hz.z, u.v.h, 6); await new Promise((r) => setTimeout(r, 300)); return { stall: +u.stall.toFixed(2), flats: u.v.flatCount }; });
console.log('caltrops+unit ', JSON.stringify(results.caltrops.unit));
await check('smokeScreen', () => { window.__game.player.vx = Math.sin(window.__spot.h) * 20; window.__game.player.vz = Math.cos(window.__spot.h) * 20; }, () => { const g = window.__game; const u = window.__unit(-60, 0); const L = g.pursuit.los(u.v.x, u.v.z, g.player.x, g.player.z); return { puffs: g.pursuit.smoke.length, blocked: g.pursuit.smokeBetween(u.v.x, u.v.z, g.player.x, g.player.z), los: L }; }, 1500, true);
await check('patchKit', () => { const p = window.__game.player; p.hurt(50); p.popTire(1); window.__before = { h: p.health, f: p.flatCount }; }, () => { const p = window.__game.player; return { before: window.__before, after: { h: +p.health.toFixed(1), f: p.flatCount } }; }, 300);
await check('bubbleShield', () => {}, () => { const p = window.__game.player; const a = p.hurt(20); const left = p.shield; return { shieldStart: 3, hurt: a, left }; }, 300, true);
await check('glider', () => { const p = window.__game.player; p.vx = Math.sin(window.__spot.h) * 30; p.vz = Math.cos(window.__spot.h) * 30; }, () => { const p = window.__game.player; return { airborne: p.airborne, gravity: p.mods.gravityMul, vy: +p.vy.toFixed(2), y: +(p.y - p.groundY).toFixed(2) }; }, 1200, true);
results.glider.airTime = await G(async () => { const p = window.__game.player; const t0 = performance.now(); while (p.airborne && performance.now() - t0 < 8000) await new Promise((r) => setTimeout(r, 50)); return +((performance.now() - t0) / 1000 + 1.2).toFixed(1); });
console.log('glider air s  ', results.glider.airTime);
await check('blink', () => { window.__p0 = { x: window.__game.player.x, z: window.__game.player.z }; }, () => { const p = window.__game.player; return { moved: +Math.hypot(p.x - window.__p0.x, p.z - window.__p0.z).toFixed(1) }; }, 200);
await check('tripleBoost', () => {}, async () => { const g = window.__game, p = g.player; const b1 = +p.boostTime.toFixed(2); g.ability.trigger(p); await new Promise((r) => setTimeout(r, 100)); g.ability.trigger(p); return { boost: b1, charges: g.ability.charges, cooldown: Math.round(g.ability.cooldown) }; }, 100);
await check('homingMissile', () => { window.__target = window.__unit(70, 0); }, () => { const g = window.__game; return { inFlight: g.pursuit.missiles.length, targetStall: +window.__target.stall.toFixed(1) }; }, 1800, true);
await check('emp', () => { window.__unit(30, 2); window.__unit(-40, -2); window.__game.pursuit.heat.forced = true; }, () => { const g = window.__game; return { jam: +g.pursuit.jam.toFixed(1), stalled: g.pursuit.units.filter((u) => u.stall > 0).length }; }, 300, true);
await check('moonJump', () => {}, () => { const p = window.__game.player; return { airborne: p.airborne, height: +(p.y - p.groundY).toFixed(1) }; }, 900, true);
await check('timeWarp', () => {}, () => ({ warp: window.__game.timeWarp }), 400);
await check('grapple', () => { const p = window.__game.player; p.vx = Math.sin(window.__spot.h) * 22; p.vz = Math.cos(window.__spot.h) * 22; }, () => { const g = window.__game; return { active: g.ability.active > 0, anchor: g.ability.anchor?.label ?? null, tether: !!g.player.mods.tether }; }, 300, true);
for (const id of ['apexGrip', 'overdrive', 'secondWind', 'overclock', 'rallyHop', 'focus']) await check(id, () => { const p = window.__game.player; p.vx = Math.sin(window.__spot.h) * 15; p.vz = Math.cos(window.__spot.h) * 15; }, () => ({ status: window.__game.ability.status().mode }), 200);
console.log('errors', errs.length, errs.slice(0, 5).join(' | '));
fs.writeFileSync(`${out}/abilities.json`, JSON.stringify(results, null, 1));
await browser.close();
