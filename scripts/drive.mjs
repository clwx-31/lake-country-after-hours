// Dev helper: press real keys in headless Chrome and capture screenshots + state.
// Usage: node scripts/drive.mjs <out-prefix> '<json steps>'
// steps: [{"keys":["KeyW"],"ms":1500,"shot":"name","eval":"js"}]
import { chromium } from 'playwright';
const [,, out = 'playtest-output/d', stepsJson = '[]', url = 'http://localhost:5173/'] = process.argv;
const steps = JSON.parse(stepsJson);
const browser = await chromium.launch({ channel: 'chrome', args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const logs = [];
page.on('console', (m) => { if (m.type() !== 'debug') logs.push(`[${m.type()}] ${m.text()}`); });
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
await page.goto(url);
await page.waitForFunction(() => window.__game, null, { timeout: 60000 });
await page.waitForTimeout(1200);
for (const s of steps) {
  if (s.eval) {
    const r = await page.evaluate(`(async () => { ${s.eval} })()`);
    if (r !== undefined) console.log('eval:', JSON.stringify(r));
  }
  for (const k of s.keys ?? []) await page.keyboard.down(k);
  if (s.tap) for (const k of s.tap) { await page.keyboard.press(k); await page.waitForTimeout(60); }
  if (s.ms) await page.waitForTimeout(s.ms);
  for (const k of s.keys ?? []) await page.keyboard.up(k);
  if (s.shot) await page.screenshot({ path: `${out}-${s.shot}.png` });
  if (s.state) console.log('state:', JSON.stringify(await page.evaluate(() => window.__game.state())));
}
console.log(logs.slice(0, 40).join('\n'));
await browser.close();
