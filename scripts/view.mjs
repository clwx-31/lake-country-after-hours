// Dev helper: free camera screenshots. Usage:
// node scripts/view.mjs <outPrefix> '<json list of views>'
// view: { at:[x,z], from:[x,y,z] (relative to ground at `at`), time?, drive?:{x,z,h}, wait? }
import { chromium } from 'playwright';
const [,, out, viewsJson, url = 'http://localhost:5173/'] = process.argv;
const views = JSON.parse(viewsJson);
const browser = await chromium.launch({ channel: 'chrome', args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const logs = [];
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') logs.push(`[${m.type()}] ${m.text()}`); });
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
await page.goto(url);
await page.waitForFunction(() => window.__game, null, { timeout: 90000 });
await page.waitForTimeout(1500);
let i = 0;
for (const v of views) {
  const info = await page.evaluate(async (v) => {
    const g = window.__game;
    if (v.time) { g.save.data.settings.timeOfDay = v.time; g.applySettings(g.save.data.settings); }
    if (v.drive) {
      g.enterDrive();
      g.placePlayer(v.drive.x, v.drive.z, v.drive.h ?? 0, v.drive.speed ?? 0);
      if (v.script) await eval(`(async () => { ${v.script} })()`);
      return g.state();
    }
    g.mode = 'menu'; g.paused = true; g.screens.hide(); g.hud.root.classList.add('hidden');
    const [ax, az] = v.at;
    const gy = g.d.terrain.height(ax, az);
    g.forest.prime(ax, az);
    const cam = g.cam.camera;
    cam.position.set(ax + v.from[0], gy + v.from[1], az + v.from[2]);
    cam.lookAt(ax, gy + (v.lookUp ?? 0), az);
    cam.fov = v.fov ?? 55; cam.updateProjectionMatrix();
    for (let k = 0; k < 30; k++) g.forest.update(cam, 20);
    g.world.updateLod(cam, g.stage.fogFar);
    return { gy };
  }, v);
  await page.waitForTimeout(v.wait ?? 1500);
  const name = `${out}-${i++}${v.name ? '-' + v.name : ''}.png`;
  await page.screenshot({ path: name });
  console.log(name, JSON.stringify(info));
}
const perf = await page.evaluate(() => window.__game.perf());
console.log('perf', JSON.stringify(perf));
console.log(logs.slice(0, 20).join('\n'));
await browser.close();
