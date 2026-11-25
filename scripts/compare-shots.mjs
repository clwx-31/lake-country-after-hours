// Dev helper: the same set of views before/after a change, for visual comparison.
// Usage: node scripts/compare-shots.mjs <outDir> [url]
import { chromium } from 'playwright';
import fs from 'node:fs';
const [,, out, url = 'http://localhost:5173/'] = process.argv;
fs.mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 2 });
const logs = [];
page.on('pageerror', (e) => logs.push(`pageerror ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') logs.push(m.text()); });
await page.goto(url);
await page.waitForFunction(() => window.__game, null, { timeout: 120000 });
await page.waitForTimeout(1000);
const aerial = async (name, x, z, from, time = 'golden') => {
  await page.evaluate(([x, z, from, time]) => {
    const g = window.__game;
    g.save.data.settings.timeOfDay = time; g.applySettings(g.save.data.settings);
    g.mode = 'menu'; g.paused = true; g.screens.hide(); g.hud.root.classList.add('hidden');
    const gy = g.d.terrain.height(x, z);
    g.forest.prime(x, z);
    const cam = g.cam.camera;
    cam.position.set(x + from[0], gy + from[1], z + from[2]);
    cam.lookAt(x, gy, z);
    cam.fov = 55; cam.updateProjectionMatrix();
    for (let k = 0; k < 30; k++) g.forest.update(cam, 20);
    g.world.updateLod(cam, g.stage.fogFar);
  }, [x, z, from, time]);
  await page.waitForTimeout(1200);
  await page.screenshot({ path: `${out}/${name}.png` });
};
await aerial('aerial-hartland-residential', 1300, 1150, [0, 140, 70]);
await aerial('aerial-downtown', 640, 760, [-60, 110, 120]);
await aerial('aerial-chenequa', -1100, -2100, [80, 160, 160]);
await aerial('aerial-farms-merton', 3300, -2500, [0, 220, 160]);
await aerial('low-hartland-yards', 1300, 1150, [-50, 9, 60]);
// Chase view + minimap at several headings, with a GPS route and event markers.
const drive = async (name, x, z, h, gps) => {
  const r = await page.evaluate(([x, z, h, gps]) => {
    const g = window.__game;
    g.enterDrive();
    g.placePlayer(x, z, h, 0);
    if (gps) { g.gps = { x: gps[0], z: gps[1], route: g.gpsRoute(gps[0], gps[1]) }; }
    return { street: g.d.streetNameAt(x, z) };
  }, [x, z, h, gps]);
  await page.waitForTimeout(1800);
  await page.screenshot({ path: `${out}/${name}.png` });
  const box = await page.evaluate(() => { const r = document.querySelector('.minimap-wrap').getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; });
  await page.screenshot({ path: `${out}/${name}-minimap.png`, clip: { x: Math.max(0, box.x - 10), y: Math.max(0, box.y - 10), width: box.width + 20, height: box.height + 20 } });
  return r;
};
console.log(await drive('drive-church-st-north', 828, 640, Math.PI, [-1500, -400]));
console.log(await drive('drive-capitol-west', 760, 752, -Math.PI / 2, [3700, -2400]));
console.log(await drive('drive-capitol-east', 600, 760, Math.PI / 2, null));
console.log(logs.join('\n'));
await browser.close();
