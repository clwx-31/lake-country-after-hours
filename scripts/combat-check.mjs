// Dev helper: a forced five-star chase on Hwy 83 with the autopilot driving;
// logs condition, helicopter, armored units, rockets and screenshots it.
// Usage: node scripts/combat-check.mjs <outDir> [url]
import { chromium } from 'playwright';
import fs from 'node:fs';
const [,, out, url = 'http://localhost:5173/'] = process.argv;
fs.mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const errs = [];
page.on('pageerror', (e) => errs.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
await page.goto(url);
await page.waitForFunction(() => window.__game, null, { timeout: 180000 });
await page.evaluate(() => {
  const g = window.__game;
  g.enterDrive();
  g.placePlayer(-1515, -300, Math.PI, 0);
  g.pursuit.heat.forced = true;
  g.pursuit.heat.setStars(5, 'combat test');
  window.__log = [];
  const orig = g.playerCue.bind(g);
  g.playerCue = (c) => { if (c === 'tire' || c === 'totaled') window.__log.push(c); orig(c); };
  const origCombat = g.pursuit.combat.push.bind(g.pursuit.combat);
  g.pursuit.combat.push = (...evs) => { for (const e of evs) window.__log.push(e.type + (e.type === 'explosion' ? `@${Math.round(e.dist)}m-${Math.round(e.damage)}hp` : e.type === 'shot' ? (e.hit ? ':hit' : ':miss') : '')); return origCombat(...evs); };
  g.setAutopilot(g.gpsRoute(-1500, -7400), { maxSpeed: 30 });
});
for (let i = 0; i < 20; i++) {
  await page.waitForTimeout(3000);
  const s = await page.evaluate(() => {
    const g = window.__game, st = g.state();
    return { t: Math.round(g.realTime), stars: st.heat.stars, units: st.heat.units, tanks: st.tanks, heli: st.heli, rockets: st.rockets, locked: st.locked, health: st.health, flats: st.flats.filter(Boolean).length, totaled: st.totaled, mph: st.mph, log: window.__log.splice(0) };
  });
  console.log(JSON.stringify(s));
  await page.screenshot({ path: `${out}/combat-${String(i).padStart(2, '0')}.png` });
  if (s.totaled) {
    await page.waitForTimeout(1500);
    await page.screenshot({ path: `${out}/combat-totaled.png` });
    await page.keyboard.press('KeyR');
    await page.waitForTimeout(800);
    await page.screenshot({ path: `${out}/combat-reset.png` });
    console.log('after reset', JSON.stringify(await page.evaluate(() => { const g = window.__game, st = g.state(); return { screen: st.screen, credits: st.credits, health: st.health, totaled: st.totaled, stars: st.heat.stars, card: document.querySelector('.card')?.innerText.replace(/\n+/g, ' | ').slice(0, 220) }; })));
    break;
  }
}
console.log('errors', errs.length, errs.slice(0, 4).join(' | '));
await browser.close();
