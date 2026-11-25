// Dev helper: open the game in headless Chrome, run a few scripted steps, save screenshots.
// Usage: node scripts/shot.mjs <url> <outPrefix> [js-to-eval-after-load] [waitMs]
import { chromium } from 'playwright';
const [,, url = 'http://localhost:5173/', out = 'playtest-output/shot', script = '', wait = '4000'] = process.argv;
const browser = await chromium.launch({ channel: 'chrome', args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
await page.goto(url);
await page.waitForFunction(() => window.__game, null, { timeout: 60000 });
await page.waitForTimeout(1500);
if (script) {
  const r = await page.evaluate(`(async () => { ${script} })()`);
  if (r !== undefined) console.log('result:', JSON.stringify(r, null, 1));
}
await page.waitForTimeout(Number(wait));
await page.screenshot({ path: `${out}.png` });
const fps = await page.evaluate(() => document.querySelector('.fps')?.textContent);
console.log('fps:', fps);
console.log(logs.slice(0, 30).join('\n'));
await browser.close();
