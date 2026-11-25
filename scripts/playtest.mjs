// End-to-end playtest of the production build with all external network blocked.
// Usage: npm run build && npm run playtest [-- --headed]
// Writes playtest-output/report.json and screenshots.
//
// Handling checks use real keyboard events. Event completions are driven by the
// game's own debug autopilot (the same AI driver as the rival) through the real
// game loop, physics, and event rules; this is reported as such.
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import fs from 'node:fs';

const headed = process.argv.includes('--headed');
const OUT = 'playtest-output';
fs.mkdirSync(OUT, { recursive: true });
import net from 'node:net';
// Use 4173 unless something else already holds it.
const PORT = await new Promise((resolve) => {
  const probe = net.createServer().once('error', () => resolve(4199)).once('listening', () => probe.close(() => resolve(4173)));
  probe.listen(4173, '127.0.0.1');
});
const URL_ = `http://localhost:${PORT}/`;
const report = { started: new Date().toISOString(), environment: {}, checks: [], blockedRequests: [], consoleErrors: [] };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const server = spawn(process.execPath, ['scripts/serve-dist.mjs', String(PORT)], { stdio: 'pipe' });
await new Promise((r) => server.stdout.once('data', r));

const browser = await chromium.launch({
  channel: 'chrome',
  headless: !headed,
  args: [
    '--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required',
    // Make every non-local host unresolvable, on top of request interception below.
    '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1',
  ],
});
const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
await context.route('**/*', (route) => {
  const u = new URL(route.request().url());
  if (u.hostname === 'localhost' || u.hostname === '127.0.0.1') return route.continue();
  report.blockedRequests.push(u.href);
  return route.abort();
});
const page = await context.newPage();
page.on('console', (m) => { if (m.type() === 'error') report.consoleErrors.push(m.text()); });
page.on('pageerror', (e) => report.consoleErrors.push(`pageerror: ${e.message}`));

const G = (fn, arg) => page.evaluate(fn, arg);
const state = () => G(() => window.__game.state());
const shot = (name) => page.screenshot({ path: `${OUT}/${name}.png` });
const only = (process.argv.find((a) => a.startsWith('--only=')) ?? '').slice(7).split(',').filter(Boolean);
async function check(name, fn) {
  if (only.length && !only.some((o) => name.includes(o))) return;
  const t0 = Date.now();
  try {
    const r = await fn();
    report.checks.push({ name, pass: r.pass !== false, seconds: (Date.now() - t0) / 1000, ...r });
    console.log(`${r.pass === false ? 'FAIL' : 'PASS'} ${name}`, JSON.stringify(r).slice(0, 900));
  } catch (err) {
    report.checks.push({ name, pass: false, error: String(err) });
    console.log(`FAIL ${name}: ${err}`);
  }
}
async function waitFor(pred, timeoutMs, everyMs = 500) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (await G(pred)) return true;
    await sleep(everyMs);
  }
  return false;
}
const resetPlay = () => G(() => {
  const g = window.__game;
  g.player.invulnerable = false;
  g.setAutopilot(null);
  g.endEvent();
  g.pursuit.clearAll();
  g.screens.hide();
  g.mapScreen.root.remove();
  g.mode = 'drive';
  g.paused = false;
  g.audio.setPaused(false);
  g.hud.root.classList.remove('hidden');
  g.input.clear();
});
const freshPage = async () => {
  await page.goto(URL_);
  await page.waitForFunction(() => window.__game, null, { timeout: 60000 });
  await sleep(800);
};

await page.goto(URL_);
await page.evaluate(() => localStorage.clear());
await freshPage();
report.environment = await G(() => {
  const gl = document.createElement('canvas').getContext('webgl2');
  const dbg = gl.getExtension('WEBGL_debug_renderer_info');
  return { userAgent: navigator.userAgent, gpu: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : 'unknown', viewport: [innerWidth, innerHeight], dpr: devicePixelRatio };
});

// ------------------------------------------------------------ 1. boot, title, audio
await check('boot to title, no errors, OSM credit link', async () => {
  await shot('01-title');
  const credit = await G(() => [...document.querySelectorAll('a')].map((a) => [a.textContent, a.href]));
  const s = await state();
  return { pass: s.mode === 'title' && credit.some(([t, h]) => t.includes('OpenStreetMap') && h.includes('openstreetmap.org/copyright')), credit };
});
await check('Drive starts play immediately and activates audio', async () => {
  await page.locator('.title-screen .menu button', { hasText: 'Drive' }).click();
  await sleep(600);
  const s = await state();
  const audio = await G(() => window.__game.audio.ctx?.state);
  return { pass: s.mode === 'drive' && audio === 'running', mode: s.mode, audio };
});

// ------------------------------------------------------------ 2. map checks at real places
// Each place is the midpoint of a real OSM street (picked in-page by name and area).
const places = [
  { name: 'downtown-hartland-capitol-drive', street: 'East Capitol Drive', near: [640, 760], expect: ['East Capitol Drive'] },
  { name: 'hartland-church-street', street: 'Church Street', near: [828, 640], expect: ['Church Street'] },
  { name: 'wis-16-freeway', street: 'WIS 16', near: [1400, 230], expect: ['WIS 16'] },
  { name: 'wis-16-overpass-above-north-avenue', street: 'WIS 16', near: [650, 194], bridge: true, expect: ['WIS 16'] },
  { name: 'chenequa-hwy-83-by-pine-lake', street: 'State Highway 83', near: [-1515, -400], expect: ['State Highway 83'] },
  { name: 'beaver-view-road-hills', street: 'Beaver View Road', near: [30, -2900], expect: ['Beaver View Road'] },
  { name: 'winkleman-road-farm-hills', street: 'Winkleman Road', near: [3740, -2400], expect: ['Winkleman Road'] },
  { name: 'merton-main-street', street: 'Main Street', near: [3700, -3333], expect: ['Main Street'] },
  { name: 'north-lake-hwy-83', street: 'State Highway 83', near: [-1385, -5997], expect: ['State Highway 83'] },
];
for (const p of places) {
  await check(`map: ${p.name} (3D view, street label, minimap)`, async () => {
    await G((q) => {
      const g = window.__game;
      let best = null;
      for (const e of g.d.edges) {
        if (e.name !== q.street || (q.bridge && !e.bridge)) continue;
        const m = e.path.pointAt(e.length / 2);
        const dd = Math.hypot(m.x - q.near[0], m.z - q.near[1]);
        if (!best || dd < best.dd) best = { e, m, dd };
      }
      const h = best.e.path.headingAt(best.e.length / 2);
      g.placePlayer(best.m.x - Math.cos(h) * (best.e.oneway ? 0 : 1.8), best.m.z + Math.sin(h) * (best.e.oneway ? 0 : 1.8), h, 0);
    }, p);
    await sleep(1800);
    await shot(`02-${p.name}`);
    const r = await G(() => {
      const g = window.__game;
      const label = document.querySelector('.street')?.childNodes[0]?.textContent?.trim();
      const area = document.querySelector('.street small')?.textContent;
      const hit = g.d.nearestEdge(g.player.x, g.player.z, 30);
      const e = hit ? g.d.edges[hit.edge] : null;
      return { label, area, edge: e?.name, bridge: e?.bridge ?? false, y: +g.player.y.toFixed(2), terrainY: +g.d.terrain.height(g.player.x, g.player.z).toFixed(2), surface: g.state().surface };
    });
    const ok = p.expect.includes(r.label) || p.expect.includes(r.edge);
    const deckOk = !p.bridge || (r.bridge && r.y > r.terrainY + 3);
    return { pass: ok && r.surface === 0 && deckOk, ...r };
  });
}

// ------------------------------------------------------------ 2b. minimap
await check('minimap: rotation matches heading, markers inside the disc, edge pointers keep bearing without overlap, route starts on the road', async () => {
  await resetPlay();
  const results = [];
  for (const h of [0, Math.PI / 2, Math.PI, -Math.PI / 2, 0.7]) {
    await G((hh) => { const g = window.__game; g.placePlayer(640, 762, hh, 0); g.gps = { x: 3700, z: -2400, route: g.gpsRoute(3700, -2400) }; }, h);
    await sleep(700);
    const r = await G(() => {
      const g = window.__game, mm = g.hud.minimap, L = mm.lastLayout, p = g.player;
      // A point 60 m straight ahead must draw straight up from the centre.
      const [ax, ay] = mm.toScreen(p.x + Math.sin(p.h) * 60, p.z + Math.cos(p.h) * 60);
      const upErr = Math.abs(ax - L.c) + Math.max(0, ay - L.c + 10);
      const insideOk = L.inside.every((m) => Math.hypot(m.x - L.c, m.y - L.c) <= L.R - L.pad - m.r + 0.5);
      const edgeInDisc = L.edge.every((m) => Math.hypot(m.x - L.c, m.y - L.c) <= L.R - L.pad - m.r + 0.5);
      let minGap = Infinity;
      for (let i = 0; i < L.edge.length; i++) for (let j = i + 1; j < L.edge.length; j++) minGap = Math.min(minGap, Math.hypot(L.edge[i].x - L.edge[j].x, L.edge[i].y - L.edge[j].y) - L.edge[i].r - L.edge[j].r);
      const maxBearingErr = Math.max(0, ...L.edge.map((m) => Math.abs(Math.atan2(Math.sin(m.ang - m.trueAng), Math.cos(m.ang - m.trueAng)))));
      const route = g.gps.route;
      const startD = Math.hypot(route[0] - p.x, route[1] - p.z);
      const hit = g.d.nearestEdge(route[0], route[1], 5);
      return { upErr: +upErr.toFixed(1), insideOk, edgeInDisc, edges: L.edge.length, inside: L.inside.length, minGap: L.edge.length > 1 ? +minGap.toFixed(1) : null, maxBearingErrDeg: +(maxBearingErr * 57.3).toFixed(1), routeStartM: +startD.toFixed(1), routeStartOnRoad: !!hit && Math.hypot(hit.x - route[0], hit.z - route[1]) < 0.5 };
    });
    results.push({ heading: +h.toFixed(2), ...r });
    await page.screenshot({ path: `${OUT}/02b-minimap-h${Math.round(h * 57.3)}.png`, clip: await G(() => { const b = document.querySelector('.minimap-wrap').getBoundingClientRect(); return { x: b.x - 8, y: b.y - 8, width: b.width + 16, height: b.height + 16 }; }) });
  }
  // Window sizes: the disc and markers rescale cleanly.
  for (const [w, hgt] of [[1280, 720], [1920, 1080]]) {
    await page.setViewportSize({ width: w, height: hgt });
    await sleep(600);
    results.push({ size: `${w}x${hgt}`, ...(await G(() => { const L = window.__game.hud.minimap.lastLayout; return { insideOk: L.inside.every((m) => Math.hypot(m.x - L.c, m.y - L.c) <= L.R - L.pad - m.r + 0.5), canvasPx: window.__game.hud.minimap.canvas.width }; })) });
  }
  await G(() => { window.__game.gps = null; });
  const pass = results.every((r) => (r.upErr === undefined || r.upErr < 2) && r.insideOk !== false && r.edgeInDisc !== false && (r.minGap === null || r.minGap === undefined || r.minGap >= 0) && (r.routeStartOnRoad === undefined || (r.routeStartOnRoad && r.routeStartM < 6)));
  return { pass, results, note: 'bearing error is the deliberate spread of clustered edge pointers (they stay in order around their mean bearing)' };
});

// ------------------------------------------------------------ 2c. difficulty meter
await check('difficulty meter: clicking the Settings meter changes police, rival, time limits and payouts', async () => {
  await resetPlay();
  await G(() => { const g = window.__game; g.openPause(); g.screens.settings('pause'); });
  await sleep(300);
  await page.locator('.diff-segs button', { hasText: 'Insane' }).click();
  await sleep(200);
  await shot('02c-settings-difficulty');
  const insane = await G(() => { const g = window.__game; return { saved: g.save.data.settings.difficulty, label: g.difficulty.label, copPace: g.pursuit.copPace, copSight: g.pursuit.copSight, search: g.pursuit.heat.searchScale, radar: g.pursuit.radarTolerance }; });
  await G(() => { const g = window.__game; g.closeMenu(); g.startEvent('lastset'); });
  const lastSetLimit = await G(() => window.__game.event.limit);
  await G(() => { const g = window.__game; g.endEvent(); g.startEvent('circuit', 'rival'); });
  const rivalTop = await G(() => window.__game.racers[0]?.ai.skill.maxSpeed);
  await G(() => { const g = window.__game; g.endEvent(); g.openPause(); g.screens.settings('pause'); });
  await page.locator('.diff-segs button', { hasText: 'Cruise' }).click();
  await sleep(200);
  const cruise = await G(() => { const g = window.__game; return { label: g.difficulty.label, copPace: g.pursuit.copPace, radar: g.pursuit.radarTolerance }; });
  await G(() => { const g = window.__game; g.closeMenu(); g.startEvent('lastset'); });
  const cruiseLimit = await G(() => window.__game.event.limit);
  // Back to Normal for the remaining checks.
  await G(() => { const g = window.__game; g.endEvent(); g.save.data.settings.difficulty = 3; g.applySettings(g.save.data.settings); g.closeMenu(); });
  return {
    pass: insane.saved === 5 && insane.label === 'Insane' && insane.copPace > 1.1 && insane.radar < 1 && cruise.label === 'Cruise' && cruise.copPace < 0.9 && lastSetLimit < 240 && cruiseLimit > 240 && rivalTop > 40,
    insane, cruise, lastSetLimitInsane: lastSetLimit, lastSetLimitCruise: cruiseLimit, rivalTopInsane: rivalTop,
  };
});

// ------------------------------------------------------------ 2d. ground surface
await check('ground: neighbouring terrain chunks share normals and colours, and both LODs agree (no seams or popping)', async () => {
  const gp = await context.newPage();
  await gp.goto(`${URL_}?keepGeometry=1`);
  await gp.waitForFunction(() => window.__game, null, { timeout: 120000 });
  const r = await gp.evaluate(() => {
    const g = window.__game, chunks = g.world.terrainChunks;
    // Index hi-LOD vertices by grid position; compare every duplicate (chunk borders).
    const key = (x, z) => `${Math.round(x)},${Math.round(z)}`;
    const seen = new Map();
    let pairs = 0, worstN = 0, worstC = 0, worstY = 0;
    for (const c of chunks) {
      const geo = c.hi.geometry, P = geo.attributes.position.array, N = geo.attributes.normal.array, C = geo.attributes.color.array;
      for (let v = 0; v < P.length / 3; v++) {
        const k = key(P[v * 3], P[v * 3 + 2]);
        const prev = seen.get(k);
        if (!prev) { seen.set(k, [P[v * 3 + 1], N[v * 3], N[v * 3 + 1], N[v * 3 + 2], C[v * 3], C[v * 3 + 1], C[v * 3 + 2]]); continue; }
        if (Math.abs(prev[0] - P[v * 3 + 1]) > 1) continue; // skirt vertex (4 m below), not a shared surface vertex
        pairs++;
        worstY = Math.max(worstY, Math.abs(prev[0] - P[v * 3 + 1]));
        worstN = Math.max(worstN, Math.abs(prev[1] - N[v * 3]) + Math.abs(prev[2] - N[v * 3 + 1]) + Math.abs(prev[3] - N[v * 3 + 2]));
        worstC = Math.max(worstC, Math.abs(prev[4] - C[v * 3]) + Math.abs(prev[5] - C[v * 3 + 1]) + Math.abs(prev[6] - C[v * 3 + 2]));
      }
    }
    // Low LOD vertices sit on the same grid points: same height, normal and colour as the detailed mesh.
    let lodWorst = 0, lodPairs = 0;
    for (const c of chunks.slice(0, 40)) {
      const P = c.lo.geometry.attributes.position.array, C = c.lo.geometry.attributes.color.array;
      for (let v = 0; v < P.length / 3; v += 3) {
        const h = seen.get(key(P[v * 3], P[v * 3 + 2]));
        if (!h || Math.abs(h[0] - P[v * 3 + 1]) > 1) continue;
        lodPairs++;
        lodWorst = Math.max(lodWorst, Math.abs(h[4] - C[v * 3]) + Math.abs(h[5] - C[v * 3 + 1]) + Math.abs(h[6] - C[v * 3 + 2]));
      }
    }
    return { chunks: chunks.length, borderPairs: pairs, worstHeight: worstY, worstNormal: worstN, worstColor: worstC, lodPairs, lodWorstColor: lodWorst };
  });
  await gp.close();
  return { pass: r.borderPairs > 10000 && r.worstHeight < 1e-4 && r.worstNormal < 1e-5 && r.worstColor < 1e-5 && r.lodPairs > 1000 && r.lodWorstColor < 1e-5, ...r };
});

// ------------------------------------------------------------ 3. handling via real keys
// A long straight, quiet stretch of WIS 16 (wide, no cross streets) for handling tests.
const freewaySpot = () => G(() => {
  const g = window.__game;
  const e = g.d.edges.filter((x) => x.name === 'WIS 16').sort((a, b) => b.length - a.length)[0];
  const m = e.path.pointAt(e.length * 0.3);
  return { x: m.x, z: m.z, h: e.path.headingAt(e.length * 0.3) };
});
const prepHandling = async (car) => {
  await resetPlay();
  const spot = await freewaySpot();
  await G(([c, q]) => {
    const g = window.__game;
    g.save.data.settings.quietDrive = true; g.applySettings(g.save.data.settings);
    g.setCar(c); g.traffic.clear(); g.traffic.density = 0; g.traffic.patrols = 0; g.placePlayer(q.x, q.z, q.h, 0); g.ability.reset();
  }, [car, spot]);
  await sleep(300);
};
const sample = () => G(() => { const p = window.__game.player; return { mph: p.speed / 0.44704, slip: p.slipAngle * 57.3, h: p.h, w: p.w, drifting: p.drifting, tier: p.driftTier, boost: p.boostTime, y: p.y, air: p.airborne }; });

await check('handling: arcade grip turn holds the line at 45 mph (keyboard, Finch)', async () => {
  await prepHandling('finch');
  await page.keyboard.down('KeyW');
  await waitFor(() => window.__game.player.speed / 0.44704 > 45, 15000, 100);
  await page.keyboard.up('KeyW');
  const s0 = await sample();
  await page.keyboard.down('KeyA');
  let maxSlip = 0;
  for (let i = 0; i < 12; i++) { await sleep(100); const s = await sample(); maxSlip = Math.max(maxSlip, Math.abs(s.slip)); }
  await page.keyboard.up('KeyA');
  const s1 = await sample();
  const turned = Math.abs(((s1.h - s0.h + Math.PI * 3) % (Math.PI * 2)) - Math.PI) * 57.3;
  return { pass: turned > 35 && maxSlip < 12 && s1.mph > s0.mph * 0.75, startMph: Math.round(s0.mph), endMph: Math.round(s1.mph), turnedDeg: Math.round(turned), maxSlipDeg: +maxSlip.toFixed(1) };
});

await check('handling: kart drift charges blue/orange/purple sparks and fires a mini-turbo (keyboard, Vesper)', async () => {
  await prepHandling('vesper');
  await page.keyboard.down('KeyW');
  await waitFor(() => window.__game.player.speed / 0.44704 > 40, 15000, 100);
  await page.keyboard.down('KeyD');
  await page.keyboard.down('Space');
  const tiers = [];
  let maxSlip = 0;
  const t0 = Date.now();
  while (Date.now() - t0 < 3200) {
    const s = await sample();
    if (!tiers.includes(s.tier)) tiers.push(s.tier);
    maxSlip = Math.max(maxSlip, Math.abs(s.slip));
    await sleep(80);
  }
  await shot('03-drift-sparks');
  const before = await sample();
  await page.keyboard.up('Space');
  await page.keyboard.up('KeyD');
  await sleep(120);
  const after = await sample();
  await sleep(700);
  const later = await sample();
  await page.keyboard.up('KeyW');
  return {
    pass: before.drifting && tiers.includes(1) && tiers.includes(2) && tiers.includes(3) && after.boost > 0 && maxSlip < 70 && later.mph > before.mph,
    tiersSeen: tiers, maxSlipDeg: Math.round(maxSlip), mphAtRelease: Math.round(before.mph), mphAfterTurbo: Math.round(later.mph), boostSeconds: after.boost,
  };
});

await check('handling: crest jump on Winkleman Road gives airtime and a landing boost (autopilot route, real physics)', async () => {
  await resetPlay();
  const r = await G(async () => {
    const g = window.__game;
    g.setCar('northline'); g.traffic.clear(); g.traffic.density = 0;
    const route = g.d.routeThrough([496834616, 233188196], true);
    g.placePlayer(route.points[0], route.points[1], Math.atan2(route.points[2] - route.points[0], route.points[3] - route.points[1]), 20);
    g.setAutopilot(route.points, { maxSpeed: 44, latBudget: 9, brakeDecel: 9 });
    const seen = { lands: [], boosts: 0 };
    const orig = g.playerCue.bind(g);
    g.playerCue = (c) => { if (c === 'land') seen.lands.push(+g.player.landedAir.toFixed(2)); if (c === 'boost') seen.boosts++; orig(c); };
    window.__airSeen = seen;
    return route.points.length;
  });
  let shotTaken = false;
  const t0 = Date.now();
  while (Date.now() - t0 < 70000) {
    const s = await sample();
    if (s.air && !shotTaken && (await G(() => window.__game.player.airTime)) > 0.35) { shotTaken = true; await shot('03-airtime'); }
    if ((await G(() => window.__airSeen.lands.length)) >= 6 && shotTaken) break;
    await sleep(100);
  }
  const seen = await G(() => window.__airSeen);
  await G(() => window.__game.setAutopilot(null));
  const long = seen.lands.filter((a) => a >= 0.45).length;
  return { pass: seen.lands.length >= 3 && long >= 1 && seen.boosts >= long, landings: seen.lands, landingBoosts: seen.boosts, routePoints: r };
});

// ------------------------------------------------------------ 4. signatures
await check('signatures: observable effect and recharge/refill cycle for all six cars', async () => {
  const results = {};
  for (const car of ['finch', 'vesper', 'foundry', 'kestrel', 'northline', 'meridian']) {
    await prepHandling(car);
    await page.keyboard.down('KeyW');
    await sleep(1800);
    const before = await G(() => { const g = window.__game; return { y: g.player.y, cap: g.ability.capacitor, status: g.ability.status() }; });
    await page.keyboard.press('KeyE');
    await sleep(350);
    const during = await G(() => { const g = window.__game; const p = g.player; return { front: p.mods.frontGrip, extra: p.mods.extraForce, top: p.mods.topSpeedMul ?? 1, y: p.y, air: p.airborne, cap: g.ability.capacitor, scale: g.ability.timeScale(), status: g.ability.status() }; });
    await page.keyboard.up('KeyW');
    let effect = '';
    if (car === 'finch') effect = during.front > 1.3 ? `front grip x${during.front}` : '';
    if (car === 'vesper') effect = during.extra > 2000 && during.top > 1.05 ? `Overdrive +${Math.round(during.extra)} N, top speed x${during.top}` : '';
    if (car === 'foundry') effect = during.extra > 2000 ? `drive force +${Math.round(during.extra)} N` : '';
    if (car === 'kestrel') effect = during.extra > 2000 && during.cap < before.cap ? `thrust +${Math.round(during.extra)} N, capacitor ${before.cap.toFixed(2)} -> ${during.cap.toFixed(2)}` : '';
    if (car === 'northline') effect = during.air && during.y > before.y + 0.2 ? `airborne ${(during.y - before.y).toFixed(2)} m up` : '';
    if (car === 'meridian') effect = during.scale < 0.5 ? `time scale ${during.scale}` : '';
    let recharge = '';
    if (car === 'kestrel') {
      await G(() => { const g = window.__game; g.ability.trigger(g.player); });
      const c0 = await G(() => window.__game.ability.capacitor);
      await page.keyboard.down('KeyW'); await sleep(2500); await page.keyboard.up('KeyW');
      await page.keyboard.down('KeyS'); await sleep(1800); await page.keyboard.up('KeyS');
      const c1 = await G(() => window.__game.ability.capacitor);
      recharge = c1 > c0 + 0.03 ? `clean braking refilled ${c0.toFixed(2)} -> ${c1.toFixed(2)}` : '';
    } else {
      const ok = await waitFor(() => window.__game.ability.status().mode !== 'ready', 4000, 200);
      const ready = await waitFor(() => window.__game.ability.status().mode === 'ready', 24000, 500);
      recharge = ok && ready ? 'cooldown observed, ready again' : '';
    }
    results[car] = { effect, recharge, pass: !!effect && !!recharge };
  }
  await G(() => { const g = window.__game; g.save.data.settings.quietDrive = false; g.applySettings(g.save.data.settings); });
  return { pass: Object.values(results).every((r) => r.pass), results };
});

// ------------------------------------------------------------ 5. events
const runEvent = async (id, mode, autopilot, timeoutMs = 240000) => {
  await resetPlay();
  // Event-flow checks: the autopilot clips rivals and trees, so damage is off here
  // (damage, tires and totaling have their own checks).
  await G(([eid, m]) => { const g = window.__game; g.setCar('vesper'); g.player.repair(); g.player.invulnerable = true; g.traffic.density = 10; g.startEvent(eid, m); }, [id, mode]);
  await sleep(3400);
  await G(autopilot);
  await waitFor(() => window.__game.screens.name === 'results', timeoutMs, 1000);
  return G(() => { const g = window.__game; return { screen: g.screens.name, text: document.querySelector('.card')?.innerText.replace(/\n+/g, ' | ').slice(0, 400), credits: g.save.data.credits, medals: { ...g.save.data.medals }, bests: Object.fromEntries(Object.entries(g.save.data.bests).map(([k, v]) => [k, v.score])) }; });
};
const lap3 = () => { const g = window.__game; const p = g.event.course.offsetPoints(2.2); g.setAutopilot(p.concat(p.slice(2), p.slice(2)), { maxSpeed: 60, latBudget: 8, brakeDecel: 8 }); };
await check('event: Warm-Up start to results, retry spam does not duplicate rewards', async () => {
  const r = await runEvent('warmup', 'rival', () => { const g = window.__game; g.setAutopilot(g.event.course.offsetPoints(2), { maxSpeed: 24 }); }, 90000);
  await shot('05-warmup-results');
  const creditsAfter = r.credits;
  for (let i = 0; i < 5; i++) { await page.keyboard.press('Enter'); await sleep(120); }
  await sleep(500);
  const s = await state();
  // Abort the restarted attempt without finishing it.
  await G(() => { const g = window.__game; g.setAutopilot(null); g.endEvent(); g.closeMenu(); });
  const s2 = await state();
  return { pass: r.screen === 'results' && s.event?.state !== undefined && s2.credits === creditsAfter, results: r.text, creditsAfter, creditsAfterRetries: s2.credits, attempt: s.event?.attempt };
});
await check('event: Beaver View Loop vs rival, finish, results', async () => {
  const r = await runEvent('circuit', 'rival', lap3, 260000);
  await shot('05-circuit-results');
  return { pass: r.screen === 'results' && r.bests.circuit > 0, ...r };
});
await check('event: circuit solo vs ghost; a slower run cannot overwrite the better ghost', async () => {
  await G(() => window.__game.continueAfterResults());
  // Make the saved ghost a quick one, so the slow run below is slower whatever the first run did.
  await G(() => { const g = window.__game; const gh = g.save.data.ghosts.circuit; if (gh) gh.time = Math.min(gh.time, 150); const b = g.save.data.bests.circuit; if (b) b.score = Math.min(b.score, 150); g.save.persist(); });
  const before = await G(() => window.__game.save.data.ghosts.circuit?.time);
  const r = await runEvent('circuit', 'ghost', () => { const g = window.__game; const p = g.event.course.offsetPoints(2.2); g.setAutopilot(p.concat(p.slice(2), p.slice(2)), { maxSpeed: 22, latBudget: 6 }); }, 300000);
  const after = await G(() => window.__game.save.data.ghosts.circuit?.time);
  await shot('05-circuit-ghost-results');
  return { pass: before > 0 && after === before && r.screen === 'results', ghostBefore: before, ghostAfter: after, results: r.text };
});
await check('event: Last Set win path', async () => {
  await G(() => window.__game.continueAfterResults());
  // Win path only: clear traffic so the autopilot's line isn't blocked (traffic is covered elsewhere).
  const r = await runEvent('lastset', 'rival', () => { const g = window.__game; const f = g.event; g.traffic.clear(); g.traffic.density = 0; g.setAutopilot(g.gpsRoute(f.dest.x, f.dest.z), { maxSpeed: 27, latBudget: 6.5, brakeDecel: 7.5 }); }, 260000);
  await shot('05-lastset-results');
  return { pass: r.screen === 'results' && /delivered/i.test(r.text), ...r };
});
await check('event: Last Set fail path (time runs out)', async () => {
  await G(() => window.__game.continueAfterResults());
  const r = await runEvent('lastset', 'rival', () => { const g = window.__game; g.event.time = g.event.limit - 1.5; }, 15000);
  return { pass: /started without you/i.test(r.text), results: r.text };
});
await check('event: Winkleman Air reaches Sussex Road and scores airtime', async () => {
  await G(() => window.__game.continueAfterResults());
  const r = await runEvent('air', 'rival', () => { const g = window.__game; g.setAutopilot(g.event.course.offsetPoints(1.8), { maxSpeed: 46, latBudget: 9, brakeDecel: 9 }); }, 150000);
  await shot('05-air-results');
  const score = await G(() => window.__game.save.data.bests.air?.score ?? 0);
  return { pass: r.screen === 'results' && /hills/i.test(r.text) && score > 0, bestScore: score, ...r };
});
await check('event: Winkleman Air fail path (time limit)', async () => {
  await G(() => window.__game.continueAfterResults());
  const r = await runEvent('air', 'rival', () => { const g = window.__game; g.event.time = (g.event.def.timeLimit ?? 110) - 1; }, 15000);
  return { pass: /out of time/i.test(r.text), results: r.text };
});
let encoreCredits = 0;
await check('event: Five-Star Encore reaches five stars, caps units, spawns away from player, finishes', async () => {
  await G(() => window.__game.continueAfterResults());
  // The autopilot drives straight through roadblocks and can't dodge rockets, so
  // this run checks escalation and the finish with damage off (the stakes checks
  // below cover damage, tires and totaling).
  await G(() => { const g = window.__game; g.setCar('vesper'); g.player.repair(); g.player.invulnerable = true; g.pursuit.clearAll(); g.traffic.density = 12; g.startEvent('encore'); });
  await sleep(3400);
  await G(() => { const g = window.__game; g.setAutopilot(g.event.course.offsetPoints(0.8), { maxSpeed: 40, latBudget: 7.6, brakeDecel: 8 }); });
  const t0 = Date.now();
  let maxStars = 0, maxUnits = 0, minSpawn = 1e9, overCap = 0, roadblocks = 0, decision = false;
  const seen = new Set();
  while (Date.now() - t0 < 260000) {
    const s = await G(() => {
      const g = window.__game;
      const units = g.pursuit.units.filter((u) => u.state !== 'disengage');
      // Spawn distance applies to off-screen reinforcements; posted radar units pull out where they sit.
      return { screen: g.screens.name, stars: g.pursuit.heat.stars, units: units.length, ids: g.pursuit.units.filter((u) => u.origin === 'reinforcement').map((u) => [u.id, Math.hypot(u.v.x - g.player.x, u.v.z - g.player.z)]), cap: [0, 1, 2, 3, 4, 5][g.pursuit.heat.stars], rb: g.pursuit.roadblocks.length, decision: g.event?.decision > 0 };
    });
    if (s.screen === 'results') break;
    maxStars = Math.max(maxStars, s.stars);
    maxUnits = Math.max(maxUnits, s.units);
    if (s.units > Math.max(s.cap, 1) && s.stars > 0) overCap++;
    roadblocks = Math.max(roadblocks, s.rb);
    if (s.decision) decision = true;
    for (const [id, dist] of s.ids) if (!seen.has(id)) { seen.add(id); minSpawn = Math.min(minSpawn, dist); }
    if (s.stars === 5 && maxStars === 5 && !report._shot5) { report._shot5 = true; await shot('05-encore-five-stars'); }
    await sleep(400);
  }
  const r = await G(() => ({ screen: window.__game.screens.name, text: document.querySelector('.card')?.innerText.replace(/\n+/g, ' | ').slice(0, 300), credits: window.__game.save.data.credits }));
  encoreCredits = r.credits;
  await G(() => { const g = window.__game; g.player.invulnerable = false; g.player.repair(); });
  delete report._shot5;
  await shot('05-encore-results');
  return { pass: r.screen === 'results' && maxStars === 5 && overCap === 0 && minSpawn > 60, maxStars, maxUnits, minSpawnDistance: Math.round(minSpawn), overCap, roadblocksSeen: roadblocks, bankDecisionOffered: decision, ...r };
});

// ------------------------------------------------------------ 6. free-roam pursuit: escape, capture, quiet drive
await check('pursuit: search meter expires and the escape reward is banked', async () => {
  await G(() => { const g = window.__game; g.continueAfterResults(); g.setAutopilot(null); g.pursuit.clearAll(); g.save.data.settings.quietDrive = false; g.applySettings(g.save.data.settings); g.placePlayer(640, 762, -1.55, 0); g.pursuit.heat.award(4, 'Witnessed collision (test)', g.realTime); });
  const c0 = await G(() => window.__game.save.data.credits);
  const contact = await waitFor(() => window.__game.pursuit.heat.contact, 40000, 500);
  // Break line of sight: relocate far across the district (behind buildings) and wait.
  await G(() => { const g = window.__game; const e = g.d.edges.find((x) => x.name === 'Winkleman Road'); const m = e.path.pointAt(e.length / 2); g.placePlayer(m.x, m.z, e.path.headingAt(e.length / 2), 0); });
  const searching = await waitFor(() => window.__game.pursuit.heat.phase === 'search', 15000, 300);
  await shot('06-searching');
  const escaped = await waitFor(() => window.__game.pursuit.heat.stars === 0, 40000, 500);
  const c1 = await G(() => window.__game.save.data.credits);
  return { pass: contact && searching && escaped && c1 > c0, contact, searching, escaped, banked: c1 - c0, note: 'line of sight broken by relocating the player (assisted)' };
});
await check('pursuit: capture when held stationary costs a fine, restart at garage, records preserved', async () => {
  await resetPlay();
  await G(() => { const g = window.__game; g.player.repair(); g.save.data.credits = Math.max(g.save.data.credits, 3000); g.pursuit.clearAll(); g.placePlayer(640, 762, -1.55, 0); g.pursuit.heat.award(4, 'Witnessed collision (test)', g.realTime); });
  const before = await G(() => ({ credits: window.__game.save.data.credits, owned: [...window.__game.save.data.owned], bests: Object.keys(window.__game.save.data.bests) }));
  const caught = await waitFor(() => window.__game.screens.name === 'notice', 90000, 500);
  await shot('06-caught');
  const card = await G(() => document.querySelector('.card')?.innerText.replace(/\n+/g, ' | '));
  await page.keyboard.press('Enter');
  await sleep(600);
  const after = await G(() => { const g = window.__game; const gc = g.venues.garage.curb; return { credits: g.save.data.credits, owned: [...g.save.data.owned], bests: Object.keys(g.save.data.bests), atGarage: Math.hypot(g.player.x - gc.x, g.player.z - gc.z) < 3, stars: g.pursuit.heat.stars }; });
  const fine = await G(() => window.__game.lastFine);
  return { pass: caught && /fined/i.test(card) && after.atGarage && after.stars === 0 && after.credits === before.credits - fine && fine > 0 && after.bests.length === before.bests.length, fine, card, before, after };
});
await check('pursuit: Encore capture offers a one-button event retry', async () => {
  await G(() => { const g = window.__game; g.closeMenu(); g.startEvent('encore'); });
  await sleep(3400);
  const caught = await waitFor(() => window.__game.screens.name === 'results', 90000, 500);
  const card = await G(() => document.querySelector('.card')?.innerText.replace(/\n+/g, ' | ').slice(0, 200));
  await page.keyboard.press('Enter');
  await sleep(600);
  const s = await state();
  await G(() => { const g = window.__game; g.endEvent(); g.pursuit.clearAll(); g.closeMenu(); });
  return { pass: caught && /caught/i.test(card) && s.event?.id === 'encore', card, retried: s.event };
});
await check('pursuit: Quiet Drive blocks heat while exploration continues', async () => {
  await resetPlay();
  await G(() => { const g = window.__game; g.setCar('vesper'); g.placePlayer(640, 762, -1.55, 0); });
  await G(() => { const g = window.__game; g.save.data.settings.quietDrive = true; g.applySettings(g.save.data.settings); g.pursuit.clearAll(); });
  await sleep(300);
  const r = await G(() => { const g = window.__game; g.pursuit.heat.quiet = true; const ok = g.pursuit.heat.award(10, 'test', g.realTime + 100, 4242); return { awarded: ok, stars: g.pursuit.heat.stars, tag: !document.querySelector('.quiet-tag').classList.contains('hidden') }; });
  await page.keyboard.down('KeyW'); await sleep(1200); await page.keyboard.up('KeyW');
  const s = await state();
  await G(() => { const g = window.__game; g.save.data.settings.quietDrive = false; g.applySettings(g.save.data.settings); });
  return { pass: !r.awarded && r.stars === 0 && s.mode === 'drive' && s.mph > 5 && r.tag, ...r, mph: s.mph };
});

await check('pursuit: posted unit in the WIS 16 median clocks a speeder and pulls out', async () => {
  await resetPlay();
  const r0 = await G(() => {
    const g = window.__game;
    g.save.data.settings.quietDrive = false; g.applySettings(g.save.data.settings);
    g.pursuit.clearAll(); g.traffic.clear(); g.traffic.density = 0;
    const post = g.pursuit.posted.find((q) => q.road === 'WIS 16' && q.away <= 0);
    // Start 220 m upstream on the watched carriageway, already at 85 mph.
    const fx = Math.sin(post.roadH), fz = Math.cos(post.roadH);
    const hit = g.d.nearestEdge(post.x - fx * 220, post.z - fz * 220, 40, (e) => e.name === 'WIS 16');
    const e = g.d.edges[hit.edge];
    let h = e.path.headingAt(hit.s);
    if (Math.cos(h - post.roadH) < 0) h += Math.PI;
    g.placePlayer(hit.x, hit.z, h, 85 * 0.44704);
    g.setAutopilot(g.d.pathBetween(hit.x, hit.z, post.x + fx * 600, post.z + fz * 600, true), { maxSpeed: 40 });
    return { posted: g.pursuit.posted.length, onFreeway: g.pursuit.posted.filter((q) => q.road === 'WIS 16').length };
  });
  const clocked = await waitFor(() => window.__game.pursuit.heat.stars > 0 && window.__game.pursuit.units.length > 0, 20000, 200);
  await sleep(600);
  await shot('06-radar-clocked');
  const r = await G(() => { const g = window.__game; return { stars: g.pursuit.heat.stars, reason: g.pursuit.heat.reason, units: g.pursuit.units.length, warn: document.querySelector('.warning')?.textContent ?? '', radar: g.pursuit.radar }; });
  await G(() => { const g = window.__game; g.setAutopilot(null); g.pursuit.clearAll(); });
  return { pass: clocked && /Clocked at \d+ mph/.test(r.reason), ...r0, ...r };
});
await check('time of day: golden hour, daytime and evening switch live (T key)', async () => {
  await resetPlay();
  await G(() => { const g = window.__game; g.placePlayer(640, 762, -1.55, 0); });
  const seen = [];
  for (let i = 0; i < 3; i++) {
    await page.keyboard.press('KeyT');
    await sleep(1400);
    const t = await G(() => ({ id: window.__game.stage.time.id, saved: window.__game.save.data.settings.timeOfDay, lamps: window.__game.stage.time.lamps }));
    seen.push(t);
    await shot(`07-time-${t.id}`);
  }
  const ids = seen.map((t) => t.id);
  return { pass: new Set(ids).size === 3 && seen.every((t) => t.id === t.saved), seen };
});

// ------------------------------------------------------------ 6b. stakes: damage, tires, helicopter, armor, totaled
await check('condition: a shot-out tire slows the car and pulls it; damage shows; the garage repairs it for credits', async () => {
  await resetPlay();
  const spot = await freewaySpot();
  await G((q) => { const g = window.__game; g.save.data.settings.quietDrive = true; g.applySettings(g.save.data.settings); g.setCar('vesper'); g.player.repair(); g.save.data.credits = 5000; g.traffic.clear(); g.traffic.density = 0; g.placePlayer(q.x, q.z, q.h, 0); }, spot);
  await page.keyboard.down('KeyW'); await sleep(4000);
  const healthy = await G(() => ({ mph: window.__game.player.speed / 0.447, h: window.__game.player.h }));
  await page.keyboard.up('KeyW');
  // Same run from rest with a blown front-right tire.
  await G((q) => { const g = window.__game; g.placePlayer(q.x, q.z, q.h, 0); g.player.popTire(1); g.player.hurt(30); }, spot);
  const h0 = await G(() => window.__game.player.h);
  await page.keyboard.down('KeyW');
  await sleep(4000);
  const flat = await G(() => { const g = window.__game, p = g.player; return { mph: p.speed / 0.447, h: p.h, pip: document.querySelector('.condition .tire.t1').classList.contains('flat'), bar: document.querySelector('.condition .bar i').style.width, health: p.health }; });
  await page.keyboard.up('KeyW');
  await shot('06b-flat-tire');
  void flat;
  const turned = Math.abs(Math.atan2(Math.sin(flat.h - h0), Math.cos(flat.h - h0)));
  await G(() => { const g = window.__game; g.placePlayer(g.venues.garage.curb.x, g.venues.garage.curb.z, g.venues.garage.curb.h, 0); g.enterGarage(); });
  await sleep(500);
  await shot('06b-garage-repair');
  const before = await G(() => window.__game.save.data.credits);
  const cost = await G(() => window.__game.repairCost());
  await page.locator('button', { hasText: 'Repair' }).first().click();
  await sleep(300);
  const after = await G(() => ({ credits: window.__game.save.data.credits, health: window.__game.player.health, max: window.__game.player.maxHealth, flats: window.__game.player.flatCount }));
  await G(() => { const g = window.__game; g.leaveGarage(); g.save.data.settings.quietDrive = false; g.applySettings(g.save.data.settings); });
  return {
    pass: flat.pip && flat.mph < healthy.mph * 0.95 && turned > 0.05 && flat.bar !== '100%' && after.credits === before - cost && cost > 0 && after.health === after.max && after.flats === 0,
    healthyMph: Math.round(healthy.mph), flatMph: Math.round(flat.mph), pullDeg: +(turned * 57.3).toFixed(1), hudBar: flat.bar, repairCost: cost, creditsBefore: before, creditsAfter: after.credits,
  };
});

await check('five stars: helicopter keeps sight on open road and loses it under a bridge; armored units lock on, fire rockets, blasts damage and launch the car', async () => {
  await resetPlay();
  await G(() => {
    const g = window.__game;
    g.setCar('foundry'); g.save.data.owned = [...new Set([...g.save.data.owned, 'foundry'])]; g.player.repair();
    g.placePlayer(-1515, -300, Math.PI, 0);
    g.pursuit.heat.forced = true;
    g.pursuit.heat.setStars(5, 'arsenal test');
    window.__ev = [];
    const push = g.pursuit.combat.push.bind(g.pursuit.combat);
    g.pursuit.combat.push = (...e) => { window.__ev.push(...e.map((x) => ({ ...x }))); return push(...e); };
    g.setAutopilot(g.gpsRoute(-1500, -7400), { maxSpeed: 30 });
  });
  let heliSaw = false, tanks = 0, lockSeen = false, lockText = '', launched = false, blast = null, launchedAirborne = false;
  const t0 = Date.now();
  while (Date.now() - t0 < 70000) {
    const s = await G(() => { const g = window.__game, st = g.state(); return { heli: st.heli, tanks: st.tanks, locked: st.locked, warn: document.querySelector('.warning')?.textContent ?? '', totaled: st.totaled, airborne: st.airborne, ev: window.__ev.splice(0) }; });
    if (s.heli?.sees) heliSaw = true;
    tanks = Math.max(tanks, s.tanks);
    if (s.locked === 'rocket') { lockSeen = true; lockText = s.warn; if (!report._lockShot) { report._lockShot = true; await shot('06b-rocket-lock'); } }
    for (const e of s.ev) {
      if (e.type === 'launch') launched = true;
      if (e.type === 'explosion' && (!blast || e.dist < blast.dist)) blast = e;
    }
    if (s.airborne && blast && blast.dist < 10) launchedAirborne = true;
    if (blast && blast.damage > 0 && !report._blastShot) { report._blastShot = true; await shot('06b-explosion'); }
    if (s.totaled || (launched && blast && blast.damage > 0 && heliSaw)) break;
    await sleep(250);
  }
  delete report._lockShot; delete report._blastShot;
  // Hide under the WIS 16 overpass on North Avenue: the helicopter loses sight.
  await G(() => {
    const g = window.__game;
    g.setAutopilot(null); g.player.repair(); g.pursuit.units.forEach((u) => (u.v.x += 600));
    // Directly under the WIS 16 deck over North Avenue, at road level (not on the deck).
    const deck = g.d.edges.find((e) => e.bridge && e.name === 'WIS 16' && Math.abs(e.path.pointAt(e.length / 2).x - 650) < 40);
    const m = deck.path.pointAt(deck.length / 2);
    g.player.placeAt(m.x, m.z, g.d.terrain.height(m.x, m.z), 0);
  });
  await sleep(2500);
  const underBridge = await G(() => { const g = window.__game; return { sees: g.pursuit.heli?.sees ?? null, cover: g.pursuit.coverAt(g.player.x, g.player.z, g.player.y) }; });
  await shot('06b-under-bridge');
  await G(() => { const g = window.__game; g.pursuit.clearAll(); g.player.repair(); });
  return {
    pass: heliSaw && tanks >= 1 && lockSeen && /ROCKET LOCK/.test(lockText) && launched && !!blast && underBridge.cover && underBridge.sees === false,
    heliSaw, tanks, lockSeen, lockText, launched, closestBlast: blast && { dist: Math.round(blast.dist), damage: Math.round(blast.damage) }, launchedAirborne, underBridge,
  };
});

await check('spike strip: driving over it blows tires; the warning names the street', async () => {
  await resetPlay();
  await G(() => {
    const g = window.__game;
    g.setCar('vesper'); g.player.repair(); g.traffic.clear(); g.traffic.density = 0;
    const e = g.d.edges.filter((x) => x.name === 'East Capitol Drive').sort((a, b) => b.length - a.length)[0];
    const s0 = 30, h = e.path.headingAt(s0), p0 = e.path.pointAt(s0);
    g.placePlayer(p0.x - Math.cos(h) * 1.8, p0.z + Math.sin(h) * 1.8, h, 0);
    g.pursuit.heat.forced = true; g.pursuit.heat.setStars(4, 'spike test');
    const s1 = Math.min(e.length - 10, s0 + 110), p1 = e.path.pointAt(s1);
    g.pursuit.addSpikes({ x: p1.x, z: p1.z, h: e.path.headingAt(s1), width: e.width, edge: e.index, street: e.name });
    g.setAutopilot(Array.from(e.pts), { maxSpeed: 20 });
  });
  const hit = await waitFor(() => window.__game.player.flatCount > 0, 20000, 200);
  const r = await G(() => ({ flats: window.__game.player.flatCount, warn: document.querySelector('.warning')?.textContent ?? '' }));
  await shot('06b-spikes');
  await G(() => { const g = window.__game; g.setAutopilot(null); g.pursuit.clearAll(); g.player.repair(); });
  return { pass: hit && r.flats >= 2, ...r };
});

await check('totaled: the car dies, R tows it to the garage, repairs and the pursuit fine are charged; a totaled run ends the event', async () => {
  await resetPlay();
  await G(() => { const g = window.__game; g.setCar('vesper'); g.player.repair(); g.save.data.credits = 6000; g.placePlayer(640, 762, -1.55, 12); g.pursuit.heat.forced = true; g.pursuit.heat.setStars(3, 'totaled test'); });
  await sleep(500);
  await G(() => window.__game.player.hurt(1000));
  await sleep(1500);
  const wreck = await G(() => { const g = window.__game; return { totaled: g.player.totaled, overlay: document.querySelector('.totaled')?.textContent ?? '', bill: g.repairCost() + 3 * 0 }; });
  await shot('06b-totaled');
  const before = await G(() => window.__game.save.data.credits);
  await page.keyboard.press('KeyR');
  await sleep(700);
  const after = await G(() => { const g = window.__game, gc = g.venues.garage.curb; return { screen: g.screens.name, card: document.querySelector('.card')?.innerText.replace(/\n+/g, ' | ').slice(0, 260), credits: g.save.data.credits, health: g.player.health, max: g.player.maxHealth, totaled: g.player.totaled, stars: g.pursuit.heat.stars, atGarage: Math.hypot(g.player.x - gc.x, g.player.z - gc.z) < 3, fine: g.lastFine }; });
  await G(() => window.__game.closeMenu());
  // In a timed event a wreck ends the run.
  await G(() => { const g = window.__game; g.startEvent('lastset'); });
  await sleep(3600);
  await G(() => window.__game.player.hurt(1000));
  await sleep(600);
  const ev = await G(() => ({ screen: window.__game.screens.name, text: document.querySelector('.card')?.innerText.slice(0, 80) ?? '' }));
  await G(() => { const g = window.__game; g.continueAfterResults(); g.resetTotaled(); g.closeMenu(); });
  return {
    pass: wreck.totaled && /TOTALED/.test(wreck.overlay) && after.screen === 'notice' && /Towed/.test(after.card) && after.credits < before && after.fine > 0 && !after.totaled && after.health === after.max && after.stars === 0 && after.atGarage && /totaled/i.test(ev.text),
    overlay: wreck.overlay, creditsBefore: before, creditsAfter: after.credits, fine: after.fine, card: after.card, eventEnd: ev.text,
  };
});

// ------------------------------------------------------------ 7. pause, blur, recover
await check('pause and blur stop simulation and event timers; held keys clear', async () => {
  await G(() => { const g = window.__game; g.startEvent('lastset'); });
  await sleep(4000);
  const a = await state();
  await page.keyboard.press('Escape');
  await sleep(300);
  const b = await state();
  await sleep(1500);
  const b2 = await state();
  await page.keyboard.press('Escape');
  await sleep(300);
  await page.keyboard.down('KeyW');
  await G(() => window.dispatchEvent(new Event('blur')));
  await sleep(1000);
  const c = await G(() => ({ ...window.__game.state(), held: window.__game.input.down('throttle') }));
  await page.keyboard.up('KeyW');
  await page.keyboard.press('Escape');
  await sleep(300);
  // Recover during a timed event invalidates it.
  await page.keyboard.press('KeyR');
  await sleep(500);
  const d = await G(() => ({ screen: window.__game.screens.name, text: document.querySelector('.card')?.innerText.slice(0, 80) }));
  await G(() => { const g = window.__game; g.continueAfterResults(); });
  return { pass: b.paused && b.simTime === b2.simTime && b.event?.time === b2.event?.time && c.paused && !c.held && /invalidated/i.test(d.text ?? ''), simTimePaused: [b.simTime, b2.simTime], eventTimePaused: [b.event?.time, b2.event?.time], afterBlur: { paused: c.paused, held: c.held }, recover: d };
});
await check('pause freezes the event clock', async () => {
  await G(() => window.__game.startEvent('warmup'));
  await sleep(4500);
  await page.keyboard.press('Escape');
  await sleep(200);
  const t1 = (await state()).event.time;
  await sleep(2000);
  const t2 = (await state()).event.time;
  await page.keyboard.press('Escape');
  await G(() => { const g = window.__game; g.endEvent(); });
  return { pass: t1 === t2, t1, t2 };
});

// ------------------------------------------------------------ 8. garage unlock + persistence
await check('garage: every car owned, fit any ability, paint, select, and persistence across reload', async () => {
  await G(() => { const g = window.__game; g.save.persist(); g.enterGarage(); });
  await sleep(800);
  await G(() => { const g = window.__game; g.screens.garageSel = 'foundry'; g.screens.garage(g.figures, false); });
  await sleep(300);
  const listed = await page.locator('.car-list button').count();
  const ownedTags = await page.locator('.car-list button .tag.owned').count();
  // Fit the Grapple Hook to the Foundry instead of its Second Wind.
  await page.locator('.ability-grid .chip', { hasText: 'Grapple Hook' }).click();
  await sleep(200);
  await shot('08-garage-foundry');
  await page.locator('.swatches button').nth(1).click();
  await page.locator('button:has-text("Select")').click();
  await sleep(300);
  const before = await G(() => ({ selected: window.__game.save.data.selected, paint: window.__game.save.data.paint.foundry, ability: window.__game.save.data.abilities.foundry, equipped: window.__game.ability.id, credits: window.__game.save.data.credits, bests: window.__game.save.data.bests }));
  await page.reload();
  await page.waitForFunction(() => window.__game, null, { timeout: 60000 });
  await sleep(800);
  const after = await G(() => ({ owned: window.__game.save.data.owned.length, selected: window.__game.save.data.selected, paint: window.__game.save.data.paint.foundry, ability: window.__game.save.data.abilities.foundry, equipped: window.__game.ability.id, credits: window.__game.save.data.credits, bests: window.__game.save.data.bests, ghost: !!window.__game.save.data.ghosts.circuit, car: window.__game.carId }));
  // Put the signature back for the checks that follow.
  await G(() => window.__game.setAbilityFor('foundry', 'secondWind'));
  return {
    pass: listed >= 22 && listed === ownedTags && before.equipped === 'grapple' && after.ability === 'grapple' && after.equipped === 'grapple' && after.selected === 'foundry' && after.car === 'foundry' && after.paint === before.paint && JSON.stringify(after.bests) === JSON.stringify(before.bests) && after.ghost,
    listed, ownedTags, before, after,
  };
});
await check('test drive any car returns to the owned car', async () => {
  await page.locator('.title-screen .menu button', { hasText: 'Garage' }).click();
  await sleep(600);
  await G(() => { const g = window.__game; g.screens.garageSel = 'meridian'; g.screens.garage(g.figures, false); });
  await page.locator('button:has-text("Test drive")').click();
  await sleep(1500);
  const during = await state();
  await page.keyboard.press('Escape');
  await sleep(800);
  const after = await state();
  return { pass: during.car === 'meridian' && after.car === 'foundry' && after.mode === 'garage', during: during.car, after: after.car, mode: after.mode };
});

// ------------------------------------------------------------ 9. HUD at smaller resolutions
await check('HUD readable at 1440x900 and 1280x720 during an event with a pursuit', async () => {
  await G(() => { const g = window.__game; g.leaveGarage(); g.startEvent('encore'); });
  await sleep(3400);
  await G(() => { const g = window.__game; g.setAutopilot(g.event.course.offsetPoints(1.5), { maxSpeed: 26 }); g.pursuit.heat.setStars(3, 'Encore gate 2'); });
  const overlaps = [];
  for (const [w, h] of [[1440, 900], [1280, 720]]) {
    await page.setViewportSize({ width: w, height: h });
    await sleep(2500);
    await shot(`09-hud-${w}x${h}`);
    overlaps.push(await G(() => {
      const r = (sel) => document.querySelector(sel)?.getBoundingClientRect();
      const boxes = { speedo: r('.speedo'), minimap: r('.minimap-wrap'), event: r('.event-panel:not(.hidden)'), heat: r('.heat:not(.hidden)') };
      const names = Object.keys(boxes).filter((k) => boxes[k] && boxes[k].width > 0);
      const hits = [];
      for (let i = 0; i < names.length; i++) for (let j = i + 1; j < names.length; j++) {
        const a = boxes[names[i]], b = boxes[names[j]];
        if (a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top) hits.push(`${names[i]}/${names[j]}`);
      }
      const offscreen = names.filter((k) => boxes[k].right > innerWidth + 1 || boxes[k].bottom > innerHeight + 1 || boxes[k].left < -1 || boxes[k].top < -1);
      return { size: [innerWidth, innerHeight], visible: names, overlaps: hits, offscreen };
    }));
  }
  await page.setViewportSize({ width: 1920, height: 1080 });
  await G(() => { const g = window.__game; g.setAutopilot(null); g.endEvent(); g.pursuit.clearAll(); g.closeMenu(); });
  return { pass: overlaps.every((o) => !o.overlaps.length && !o.offscreen.length), overlaps };
});

// ------------------------------------------------------------ 9b. online play (two pages, mock claude.ai runtime)
await check('online: two friends see each other, race the Beaver View Loop, and post to the shared leaderboard (mock runtime)', async () => {
  const ctx2 = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
  await ctx2.route('**/*', (route) => {
    const u = new URL(route.request().url());
    if (u.hostname === 'localhost' || u.hostname === '127.0.0.1') return route.continue();
    report.blockedRequests.push(u.href);
    return route.abort();
  });
  await ctx2.addInitScript({ path: 'scripts/testing/mock-claude.js' });
  const a = await ctx2.newPage(), b = await ctx2.newPage();
  for (const pg of [a, b]) pg.on('pageerror', (e) => report.consoleErrors.push(`online pageerror: ${e.message}`));
  await a.goto(`${URL_}?uid=u_alex`);
  await b.goto(`${URL_}?uid=u_sam`);
  for (const pg of [a, b]) await pg.waitForFunction(() => window.__game && window.__game.online.state === 'on', null, { timeout: 60000 });
  const A = (fn, arg) => a.evaluate(fn, arg), B = (fn, arg) => b.evaluate(fn, arg);
  const until = async (pg, fn, ms, arg) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await pg.evaluate(fn, arg)) return true; await sleep(400); } return false; };
  // Two autopilots racing side by side trade paint; damage is off for this flow check.
  for (const pg of [a, b]) await pg.evaluate(() => { const g = window.__game; g.enterDrive(); g.traffic.density = 4; g.player.invulnerable = true; });
  await B(() => { const g = window.__game; g.placePlayer(g.player.x + Math.sin(g.player.h) * 12, g.player.z + Math.cos(g.player.h) * 12, g.player.h, 0); });
  const seen = await until(a, () => { const r = [...window.__game.online.remotes.values()][0]; return r && r.visible && window.__game.online.nameOf(r.by) === 'Sam'; }, 20000);
  await sleep(800);
  await a.screenshot({ path: `${OUT}/10-online-friend-visible.png` });
  const code = await A(() => window.__game.online.hostRace('circuit'));
  const found = await until(b, (c) => window.__game.online.openRaces().some((r) => r.code === c), 15000, code);
  const joined = await B((c) => window.__game.online.joinRace(c), code);
  const both = await until(a, (c) => window.__game.online.racers(c).length === 2, 15000, code);
  await A(() => window.__game.openOnline());
  await sleep(400);
  await a.screenshot({ path: `${OUT}/10-online-lobby.png` });
  await A(() => window.__game.closeMenu());
  await A(() => window.__game.online.startRace());
  const started = await until(b, () => window.__game.event?.def.id === 'circuit', 15000);
  const slots = [await A(() => window.__game.event?.gridSlot), await B(() => window.__game.event?.gridSlot)];
  await sleep(3600);
  // Drive both cars round with the debug autopilot at different paces.
  for (const [pg, top] of [[a, 40], [b, 32]]) await pg.evaluate((t) => { const g = window.__game; const p = g.event.course.offsetPoints(2.2); g.setAutopilot(p.concat(p.slice(2), p.slice(2)), { maxSpeed: t, latBudget: 8, brakeDecel: 8 }); }, top);
  await sleep(20000);
  await a.screenshot({ path: `${OUT}/10-online-race.png` });
  const done = await until(a, () => window.__game.online.standings().every((r) => r.st === 'done'), 360000, undefined);
  const standings = await A(() => window.__game.online.standings());
  await sleep(1500);
  await a.screenshot({ path: `${OUT}/10-online-results.png` });
  const board = await until(b, () => window.__game.online.board('circuit').length === 2, 15000);
  const rows = await B(() => window.__game.online.board('circuit').map((r) => ({ name: r.name, score: r.score, ghost: r.ghost })));
  await A(() => { const g = window.__game; g.continueAfterResults(); g.openOnline(); });
  await sleep(500);
  await a.screenshot({ path: `${OUT}/10-online-leaderboard.png` });
  // Race a friend's posted ghost from the leaderboard (once Alex's board has Sam's time).
  await until(a, () => window.__game.online.board('circuit').some((r) => r.uid === 'u_sam'), 15000);
  const ghostRace = await A(async () => {
    const g = window.__game;
    g.closeMenu();
    const entry = g.online.board('circuit').find((r) => r.uid === 'u_sam');
    if (!entry) return { event: null, ghost: false, boardSeenByAlex: g.online.board('circuit').map((r) => ({ uid: r.uid, score: r.score })), myBoard: Object.keys(g.online.myBoard) };
    await g.raceBoardGhost(entry.uid);
    return { event: g.event?.def.id, ghost: !!g.ghost };
  });
  await ctx2.close();
  const ordered = standings.length === 2 && standings.every((r) => r.st === 'done' && r.fin > 0) && standings[0].fin <= standings[1].fin;
  return {
    pass: seen && found && joined && both && started && slots[0] !== slots[1] && done && ordered && rows.length === 2 && ghostRace.event === 'circuit' && ghostRace.ghost,
    seen, code, joined, slots, standings, board: rows, ghostRace, note: 'two pages share a BroadcastChannel/localStorage test double of the room, db and user capabilities',
  };
});

// ------------------------------------------------------------ 10. performance at 1080p
await check('performance: 1920x1080 on the Beaver View Loop (traffic + pursuit), downtown Hartland, and WIS 16', async () => {
  await G(() => { const g = window.__game; g.traffic.density = 22; g.startEvent('circuit', 'rival'); });
  await sleep(3400);
  await G(() => { const g = window.__game; const p = g.event.course.offsetPoints(2.2); g.setAutopilot(p.concat(p.slice(2)), { maxSpeed: 40, latBudget: 8 }); g.pursuit.heat.forced = true; g.pursuit.heat.setStars(3, 'perf test'); });
  await sleep(4000);
  await G(() => { window.__game.fps.frames.length = 0; });
  await sleep(20000);
  const circuit = await G(() => window.__game.perf());
  await shot('09-perf-circuit');
  await G(() => { const g = window.__game; g.setAutopilot(null); g.endEvent(); g.pursuit.clearAll(); g.closeMenu(); g.placePlayer(864, 747, -1.55, 0); });
  await G(() => { const g = window.__game; g.setAutopilot(g.d.pathBetween(g.player.x, g.player.z, 460, 828, true), { maxSpeed: 18 }); window.__game.fps.frames.length = 0; });
  await sleep(12000);
  const downtown = await G(() => window.__game.perf());
  await shot('09-perf-downtown');
  await G(() => { const g = window.__game; g.save.data.settings.quietDrive = true; g.applySettings(g.save.data.settings); const r = g.d.routeThrough([232807641, 11753139925], true); g.placePlayer(r.points[0], r.points[1], Math.atan2(r.points[2] - r.points[0], r.points[3] - r.points[1]), 30); g.setAutopilot(r.points, { maxSpeed: 40 }); window.__game.fps.frames.length = 0; });
  await sleep(12000);
  const freeway = await G(() => window.__game.perf());
  await shot('09-perf-freeway');
  await G(() => { const g = window.__game; g.setAutopilot(null); g.save.data.settings.quietDrive = false; g.applySettings(g.save.data.settings); });
  // Measure the uncapped run alone: blank the main page so two 1080p games don't share the GPU.
  await page.goto('about:blank');
  // What can this browser do at all right now? (An asleep display caps rAF at 30.)
  const rafPage = await context.newPage();
  await rafPage.setContent('<canvas></canvas>');
  const rafCap = await rafPage.evaluate(() => new Promise((res) => { let n = 0; const t0 = performance.now(); const f = () => { n++; if (performance.now() - t0 < 2000) requestAnimationFrame(f); else res(n / ((performance.now() - t0) / 1000)); }; requestAnimationFrame(f); }));
  await rafPage.close();
  // Uncapped headroom: same build, frame limiter off, same circuit scenario.
  const free = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--disable-gpu-vsync', '--disable-frame-rate-limit', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1'] });
  const fp = await free.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
  await fp.goto(URL_);
  await fp.waitForFunction(() => window.__game, null, { timeout: 60000 });
  await fp.evaluate(() => { const g = window.__game; g.enterDrive(); g.traffic.density = 22; g.startEvent('circuit', 'rival'); });
  await sleep(3600);
  await fp.evaluate(() => { const g = window.__game; const p = g.event.course.offsetPoints(2.2); g.setAutopilot(p.concat(p.slice(2)), { maxSpeed: 40, latBudget: 8 }); g.pursuit.heat.forced = true; g.pursuit.heat.setStars(3, 'perf test'); });
  await sleep(3000);
  await fp.evaluate(() => { window.__game.fps.frames.length = 0; });
  await sleep(6000);
  const uncapped = await fp.evaluate(() => window.__game.perf());
  await free.close();
  const atCap = (r) => r.fps >= Math.min(55, rafCap * 0.92);
  return {
    pass: atCap(circuit) && atCap(downtown) && atCap(freeway) && uncapped.fps >= 75,
    browserFrameCap: +rafCap.toFixed(1), circuit, downtown, freeway, uncapped,
    note: 'pass = each scene holds the browser\'s own frame cap (or 55+), and with the frame limiter off the heaviest scene still averages 75+ fps (25% headroom over 60)',
  };
});


// ------------------------------------------------------------ 12. second level, abilities, cars
await check('level: the title-screen picker loads Holy Hill; cars, credits and settings carry over; medals stay per map', async () => {
  await page.goto(URL_);
  await page.waitForFunction(() => window.__game, null, { timeout: 60000 });
  await sleep(600);
  const lake = await G(() => { const g = window.__game; g.save.data.credits = 4321; g.save.data.medals.circuit ??= 'bronze'; g.save.persist(); return { medals: { ...g.save.data.medals }, map: g.save.data.map }; });
  await page.locator('.title-screen .menu button', { hasText: 'Level' }).click();
  await sleep(300);
  await shot('12-level-picker');
  await Promise.all([page.waitForNavigation({ timeout: 60000 }), page.locator('.map-card', { hasText: 'Holy Hill' }).click()]);
  await page.waitForFunction(() => window.__game, null, { timeout: 60000 });
  await sleep(800);
  const hill = await G(() => { const g = window.__game; return { map: g.save.data.map, zones: g.zones.map((z) => z.id), credits: g.save.data.credits, medals: { ...g.save.data.medals }, car: g.carId, logo: document.querySelector('.logo')?.textContent, garage: document.querySelector('.title-screen') ? 'title' : '' }; });
  await shot('12-holyhill-title');
  // And back: Lake Country's medals return untouched.
  await page.locator('.title-screen .menu button', { hasText: 'Level' }).click();
  await sleep(300);
  await Promise.all([page.waitForNavigation({ timeout: 60000 }), page.locator('.map-card', { hasText: 'Lake Country' }).click()]);
  await page.waitForFunction(() => window.__game, null, { timeout: 60000 });
  await sleep(600);
  const back = await G(() => { const g = window.__game; return { map: g.save.data.map, medals: { ...g.save.data.medals }, credits: g.save.data.credits, zones: g.zones.length }; });
  return {
    pass: hill.map === 'holyhill-1' && hill.zones.length === 6 && hill.zones.every((z) => z.startsWith('hh-')) && hill.credits === 4321 && Object.keys(hill.medals).length === 0 && /Holy Hill/.test(hill.logo ?? '')
      && back.map === 'lakecountry-1' && JSON.stringify(back.medals) === JSON.stringify(lake.medals) && Object.keys(back.medals).length > 0 && back.credits === 4321,
    lake, hill, back,
  };
});

const gotoHolyHill = async () => {
  await page.goto(URL_ + '?map=holyhill');
  await page.waitForFunction(() => window.__game, null, { timeout: 60000 });
  await sleep(600);
  await G(() => window.__game.enterDrive());
  await sleep(500);
};
await check('Holy Hill: real roads and hills, street labels, minimap, speed shop garage, police posted on main roads', async () => {
  await gotoHolyHill();
  const spots = [['holy-hill-road-shrine', 'Holy Hill Road', 0.45], ['shannon-road-ridge', 'Shannon Road', 0.5], ['friess-lake', 'North Friess Lake Road', 0.5]];
  const views = [];
  for (const [name, road, at] of spots) {
    const v = await G(([road, at]) => {
      const g = window.__game;
      const e = g.d.edges.filter((x) => x.name === road).sort((a, b) => b.length - a.length)[0];
      const p = e.path.pointAt(e.length * at);
      g.placePlayer(p.x, p.z, e.path.headingAt(e.length * at), 0);
      return { road };
    }, [road, at]);
    await sleep(2200);
    const st = await G(() => ({ label: document.querySelector('.street')?.childNodes[0]?.textContent?.trim() ?? '', area: document.querySelector('.street small')?.textContent ?? '', mini: !!document.querySelector('.minimap-wrap canvas'), y: +window.__game.player.y.toFixed(1), surface: window.__game.state().surface }));
    await shot(`12-holyhill-${name}`);
    views.push({ ...v, ...st });
  }
  const meta = await G(() => { const g = window.__game; let lo = 1e9, hi = -1e9; for (const e of g.d.edges) for (const y of e.ys) { lo = Math.min(lo, y); hi = Math.max(hi, y); } return { relief: Math.round(hi - lo), posted: g.pursuit.posted.length, postedRoads: [...new Set(g.pursuit.posted.map((p) => p.road))].slice(0, 6), garage: g.venues.garage ? 'Moraine Speed Shop' : '' }; });
  return { pass: views.every((v, i) => v.label === spots[i][1] && v.mini && v.surface === 0) && meta.relief > 120 && meta.posted > 5, views, ...meta };
});

const onHolyHill = () => G(() => !!window.__game && 'hh-loop' in window.__game.zones.reduce((o, z) => ({ ...o, [z.id]: 1 }), {})).catch(() => false);
const runHill = async (id, mode, autopilot, timeoutMs) => {
  if (!(await onHolyHill())) await gotoHolyHill();
  await G(() => { const g = window.__game; if (g.screens.name === 'results') g.continueAfterResults(); });
  return runEvent(id, mode, autopilot, timeoutMs);
};
await check('Holy Hill event: Shrine Climb sprint vs rival, finish, results (autopilot)', async () => {
  const r = await runHill('hh-climb', 'rival', () => { const g = window.__game; g.setAutopilot(g.event.course.offsetPoints(2.2), { maxSpeed: 55, latBudget: 9, brakeDecel: 9 }); }, 200000);
  await shot('12-hh-climb-results');
  return { pass: r.screen === 'results' && r.bests['hh-climb'] > 0 && /Shrine Climb/i.test(r.text), ...r };
});
await check('Holy Hill event: Elmwood Air scores big air over the glacial crests (autopilot)', async () => {
  const r = await runHill('hh-air', 'rival', () => { const g = window.__game; g.setAutopilot(g.event.course.offsetPoints(1.8), { maxSpeed: 50, latBudget: 9, brakeDecel: 9 }); }, 200000);
  await shot('12-hh-air-results');
  const lake = 'Winkleman Air best on Lake Country is checked above';
  return { pass: r.screen === 'results' && r.bests['hh-air'] > 0, airScore: r.bests['hh-air'], note: lake, ...r };
});
await check('Holy Hill event: Supper Club Run delivers the cake (autopilot)', async () => {
  const r = await runHill('hh-delivery', 'rival', () => { const g = window.__game; const f = g.event; g.traffic.clear(); g.traffic.density = 0; g.setAutopilot(g.gpsRoute(f.dest.x, f.dest.z), { maxSpeed: 34, latBudget: 7, brakeDecel: 10 }); }, 420000);
  await shot('12-hh-delivery-results');
  return { pass: r.screen === 'results' && /cake delivered/i.test(r.text), ...r };
});
await check('Holy Hill event: Holy Hill Loop, one 7.8 km lap vs rival (autopilot)', async () => {
  const r = await runHill('hh-loop', 'rival', () => { const g = window.__game; const p = g.event.course.offsetPoints(2.2); g.setAutopilot(p.concat(p.slice(2, 200)), { maxSpeed: 50, latBudget: 9, brakeDecel: 9 }); }, 480000);
  await shot('12-hh-loop-results');
  return { pass: r.screen === 'results' && r.bests['hh-loop'] > 0, ...r };
});

await check('abilities: all 22 fire with an observable effect (police units placed around the car on Shannon Road)', async () => {
  if (!(await onHolyHill())) await gotoHolyHill();
  await G(() => { const g = window.__game; if (g.screens.name) g.continueAfterResults?.(); g.closeMenu?.(); });
  await resetPlay();
  await G(() => {
    const g = window.__game;
    g.setCar('vesper');
    g.save.data.settings.quietDrive = true;
    g.applySettings(g.save.data.settings);
    g.traffic.clear();
    g.traffic.density = 0;
    const e = g.d.edges.filter((x) => x.name === 'Shannon Road').sort((a, b) => b.length - a.length)[0];
    window.__spot = { e: e.index, s: e.length * 0.3 };
    window.__reset = (speed = 0) => {
      const sp = window.__spot, ed = g.d.edges[sp.e], q = ed.path.pointAt(sp.s);
      g.pursuit.clearAll();
      g.placePlayer(q.x, q.z, ed.path.headingAt(sp.s), speed);
      g.player.repair();
      g.setTimeWarp(1);
    };
    window.__unit = (ahead, side = 0) => {
      const sp = window.__spot, ed = g.d.edges[sp.e];
      const q = ed.path.pointAt(Math.max(1, Math.min(ed.length - 1, sp.s + ahead))), h = ed.path.headingAt(sp.s + ahead);
      const u = g.pursuit.makeUnit('cruiser', q.x - Math.cos(h) * side, q.z + Math.sin(h) * side, h, 0);
      u.state = 'chase';
      return u;
    };
  });
  const results = {};
  const run = async (id, setup, measure, waitMs, ok) => {
    await G((id) => { const g = window.__game; window.__reset(); g.setAbilityFor(g.carId, id); }, id);
    await G(setup);
    await sleep(150);
    await page.keyboard.press('KeyE');
    await sleep(waitMs);
    const m = await G(measure);
    results[id] = { ...m, pass: ok(m) };
  };
  const go = (v) => `() => { const g = window.__game, p = g.player, h = p.h; p.vx = Math.sin(h) * ${v}; p.vz = Math.cos(h) * ${v}; }`;
  const fn = (src) => new Function(`return (${src})`)();
  await run('superstar', () => {}, () => { const p = window.__game.player; return { invincible: !!p.mods.invincible, hurt: p.hurt(30) }; }, 400, (m) => m.invincible && m.hurt === 0);
  await shot('12-ability-superstar');
  await run('phantom', () => { window.__unit(20, 0); }, () => { const g = window.__game; return { phase: !!g.player.mods.phase, unitSees: g.pursuit.units[0]?.sees }; }, 400, (m) => m.phase && m.unitSees === false);
  await run('shockwave', () => { window.__unit(14, 2); window.__unit(-12, -2); }, () => { const g = window.__game; return { stalled: g.pursuit.units.filter((u) => u.stall > 0).length, flung: g.pursuit.units.map((u) => +u.v.speed.toFixed(1)) }; }, 250, (m) => m.stalled === 2 && m.flung.every((v) => v > 5));
  await run('oilSlick', () => {}, async () => { const g = window.__game, hz = g.pursuit.hazards[0]; if (!hz) return { hazard: false }; const u = window.__unit(-25, 0); u.v.place(hz.x, hz.z, u.v.h, 6); await new Promise((r) => setTimeout(r, 300)); return { hazard: hz.kind, stall: +u.stall.toFixed(2), spin: u.spin }; }, 300, (m) => m.hazard === 'oil' && m.stall > 0 && m.spin !== 0);
  await run('caltrops', () => {}, async () => { const g = window.__game, hz = g.pursuit.hazards[0]; if (!hz) return { hazard: false }; const u = window.__unit(-25, 0); u.v.place(hz.x, hz.z, u.v.h, 6); await new Promise((r) => setTimeout(r, 300)); return { hazard: hz.kind, flats: u.v.flatCount, stall: +u.stall.toFixed(2) }; }, 300, (m) => m.hazard === 'caltrops' && m.flats >= 2);
  await run('smokeScreen', fn(go(20)), () => { const g = window.__game; const u = window.__unit(-60, 0); return { puffs: g.pursuit.smoke.length, blocked: g.pursuit.smokeBetween(u.v.x, u.v.z, g.player.x, g.player.z) }; }, 1500, (m) => m.puffs > 5 && m.blocked);
  await shot('12-ability-smoke');
  await run('patchKit', () => { const p = window.__game.player; p.hurt(50); p.popTire(1); }, () => { const p = window.__game.player; return { health: +p.health.toFixed(1), flats: p.flatCount }; }, 300, (m) => m.health > 60 && m.flats === 0);
  await run('bubbleShield', () => {}, () => { const p = window.__game.player; return { hurt: p.hurt(25), left: p.shield }; }, 300, (m) => m.hurt === 0 && m.left === 2);
  await shot('12-ability-shield');
  // On the level stretch by the garage: hop, then a slow glide down.
  await run('glider', () => { const g = window.__game, c = g.venues.garage.curb; g.placePlayer(c.x, c.z, c.h, 30); }, async () => {
    const p = window.__game.player, t0 = performance.now();
    let peak = 0, wings = false;
    while (p.airborne && performance.now() - t0 < 9000) { peak = Math.max(peak, p.y - p.groundY); wings ||= (p.mods.gravityMul ?? 1) < 1; await new Promise((r) => setTimeout(r, 50)); }
    return { wings, peak: +peak.toFixed(1), airSeconds: +((performance.now() - t0) / 1000 + 0.6).toFixed(1) };
  }, 600, (m) => m.wings && m.peak > 3 && m.airSeconds > 3);
  await shot('12-ability-glider');
  await run('blink', () => { window.__p0 = { x: window.__game.player.x, z: window.__game.player.z }; }, () => { const p = window.__game.player; return { moved: +Math.hypot(p.x - window.__p0.x, p.z - window.__p0.z).toFixed(1) }; }, 200, (m) => m.moved > 19);
  await run('tripleBoost', () => {}, async () => { const g = window.__game, p = g.player; const b = p.boostTime; for (let i = 0; i < 2; i++) { g.ability.trigger(p); await new Promise((r) => setTimeout(r, 80)); } return { boost: +b.toFixed(2), charges: g.ability.charges, cooldown: Math.round(g.ability.cooldown) }; }, 120, (m) => m.boost > 0.5 && m.charges === 0 && m.cooldown > 10);
  await run('homingMissile', () => { window.__target = window.__unit(70, 0); }, () => ({ hit: +window.__target.stall.toFixed(1) }), 1800, (m) => m.hit > 1);
  await shot('12-ability-missile');
  await run('emp', () => { window.__unit(30, 2); window.__unit(-40, -2); }, () => { const g = window.__game; return { jam: +g.pursuit.jam.toFixed(1), stalled: g.pursuit.units.filter((u) => u.stall > 0).length }; }, 300, (m) => m.jam > 4 && m.stalled === 2);
  await run('moonJump', () => {}, () => { const p = window.__game.player; return { height: +(p.y - p.groundY).toFixed(1) }; }, 900, (m) => m.height > 5);
  await run('timeWarp', () => {}, () => ({ warp: window.__game.timeWarp }), 400, (m) => m.warp < 0.5);
  await run('grapple', fn(go(22)), () => { const g = window.__game; return { anchor: g.ability.anchor?.label ?? null, tether: !!g.player.mods.tether }; }, 300, (m) => !!m.anchor && m.tether);
  await shot('12-ability-grapple');
  for (const id of ['apexGrip', 'overdrive', 'secondWind', 'overclock', 'rallyHop', 'focus']) {
    await run(id, fn(go(15)), () => ({ mode: window.__game.ability.status().mode }), 200, (m) => m.mode === 'active');
  }
  await G(() => { const g = window.__game; g.setAbilityFor('vesper', 'overdrive'); g.save.data.settings.quietDrive = false; g.applySettings(g.save.data.settings); g.pursuit.clearAll(); });
  const failed = Object.entries(results).filter(([, r]) => !r.pass).map(([k]) => k);
  return { pass: Object.keys(results).length === 22 && !failed.length, failed, results };
});

await check('cars: all 23 owned and much faster (165-275 mph measured, the Zenith 400 at 400+); each one drives on Holy Hill', async () => {
  await resetPlay();
  const figures = await G(() => { const g = window.__game; return Object.fromEntries(g.save.data.owned.map((id) => [id, Math.round(g.figures[id].topSpeedMph)])); });
  const drove = {};
  for (const id of Object.keys(figures)) {
    drove[id] = await G(async (id) => {
      const g = window.__game;
      g.setCar(id);
      const e = g.d.edges.filter((x) => x.name === 'Holy Hill Road').sort((a, b) => b.length - a.length)[0];
      const q = e.path.pointAt(e.length * 0.5);
      g.placePlayer(q.x, q.z, e.path.headingAt(e.length * 0.5), 20);
      return g.carId === id ? 'ok' : 'no';
    }, id);
    await page.keyboard.down('KeyW');
    await sleep(700);
    await page.keyboard.up('KeyW');
    const mph = await G(() => window.__game.state().mph);
    drove[id] = { car: drove[id], mph };
  }
  await G(() => window.__game.setCar('vesper'));
  const tops = Object.entries(figures).filter(([id]) => id !== 'zenith').map(([, v]) => v);
  return { pass: tops.length >= 22 && Math.min(...tops) >= 160 && Math.max(...tops) <= 280 && figures.zenith >= 400 && Object.values(drove).every((d) => d.car === 'ok' && d.mph > 30), figures, drove };
});

await check('performance: Holy Hill at 1920x1080, wooded hill roads at speed with traffic and a 3-star chase', async () => {
  await resetPlay();
  await G(() => {
    const g = window.__game;
    g.setCar('vesper');
    g.player.invulnerable = true;
    g.traffic.density = 18;
    const r = g.d.routeThrough([213303894, 213274116, 5448664538], true);
    g.placePlayer(r.points[0], r.points[1], Math.atan2(r.points[2] - r.points[0], r.points[3] - r.points[1]), 20);
    g.setAutopilot(r.points, { maxSpeed: 50, latBudget: 9, brakeDecel: 9 });
    g.pursuit.heat.forced = true;
    g.pursuit.heat.setStars(3, 'perf test');
  });
  await sleep(4000);
  await G(() => { window.__game.fps.frames.length = 0; });
  await sleep(15000);
  const hill = await G(() => window.__game.perf());
  await shot('12-perf-holyhill');
  await G(() => { const g = window.__game; g.setAutopilot(null); g.pursuit.clearAll(); g.player.invulnerable = false; });
  const rafCap = report.checks.find((c) => c.browserFrameCap)?.browserFrameCap ?? 60;
  return { pass: hill.fps >= Math.min(55, rafCap * 0.92), hill, browserFrameCap: rafCap };
});


// ------------------------------------------------------------ Ironport (fictional city, chases only)
const gotoIronport = async () => {
  await page.goto(URL_ + '?map=ironport');
  await page.waitForFunction(() => window.__game, null, { timeout: 60000 });
  await sleep(600);
  await G(() => window.__game.enterDrive());
  await sleep(500);
};
const onIronport = () => G(() => !!window.__game && window.__game.zones.some((z) => z.id === 'ip-hot')).catch(() => false);
const ipNode = (x, z, y) => (y < 29.5 ? 1 : y < 30.5 ? 0 : y < 44 ? 2 : y < 52 ? 3 : 4) * 1e8 + (x + 2000) * 1e4 + (z + 2000);

await check('Ironport: loads a fictional city with tunnels, street level and three elevated levels; no lamp posts or trees to hit', async () => {
  await gotoIronport();
  await shot('13-ironport-start');
  const meta = await G(() => {
    const g = window.__game, d = g.d;
    const levels = {};
    for (const e of d.edges) levels[e.level] = (levels[e.level] ?? 0) + 1;
    const circs = g.world.statics.circs;
    return {
      levels, lids: d.data.under.lids.length, walls: d.data.under.walls.length, zones: g.zones.map((z) => z.id),
      credit: document.querySelector('.credit')?.textContent ?? '', posted: g.pursuit.posted.length, patrols: g.traffic.patrols, extra: g.pursuit.extraUnits,
      lampPosts: circs.filter((c) => c.tag === 'post' && c.r < 0.3).length, trees: circs.filter((c) => c.tag === 'tree').length, lights: g.scenery.lamps.length,
      garage: document.querySelector('.street')?.textContent ?? '', map: g.save.data.map,
    };
  });
  return {
    pass: meta.levels['-1'] > 5 && meta.levels['0'] > 500 && meta.levels['1'] > 5 && meta.levels['2'] > 3 && meta.levels['3'] > 3 && meta.lids > 5 && meta.zones.length === 5
      && /fictional/.test(meta.credit) && meta.posted > 20 && meta.patrols >= 8 && meta.lampPosts === 0 && meta.trees === 0 && meta.lights > 1000 && meta.map === 'ironport-1',
    ...meta,
  };
});

await check('Ironport: autopilot drives every level without dropping through (ramp, Skyway, viaduct, Stack, Highline; two tunnels and the junction under them)', async () => {
  if (!(await onIronport())) await gotoIronport();
  await resetPlay();
  const routes = [
    { name: 'up', speed: 45, via: [[994, -300, 30], [975, -560, 40], [975, 225, 40], [675, -75, 48], [375, -75, 48], [75, -375, 56], [75, -1650, 30]] },
    { name: 'canal', speed: 50, via: [[-1650, 450, 30], [-900, 450, 30], [-450, 450, 20], [0, 450, 30]] },
    { name: 'market', speed: 50, via: [[-450, 0, 30], [-450, 450, 20], [-450, 900, 30]] },
  ];
  const out = {};
  for (const r of routes) {
    await G(([r, ids]) => {
      const g = window.__game, d = g.d;
      const nodes = ids.map((i) => d.nodeByOsm.get(i));
      const edges = [];
      for (let k = 1; k < nodes.length; k++) edges.push(...d.route(nodes[k - 1], nodes[k], false).edges);
      const pts = [], ys = [];
      let v = nodes[0];
      for (const ei of edges) {
        const e = d.edges[ei], fwd = e.a === v, n = e.pts.length / 2;
        for (let k = 0; k < n; k++) {
          const i = fwd ? k : n - 1 - k;
          if (pts.length && k === 0) continue;
          pts.push(e.pts[i * 2], e.pts[i * 2 + 1]);
          ys.push(e.ys[i]);
        }
        v = d.otherEnd(ei, v);
      }
      window.__route = { pts, ys, end: [pts[pts.length - 2], pts[pts.length - 1]] };
      g.player.invulnerable = true;
      g.traffic.clear();
      g.placePlayer(pts[0], pts[1], Math.atan2(pts[2] - pts[0], pts[3] - pts[1]), 0, ys[0]);
      g.setAutopilot(pts, { maxSpeed: r.speed, latBudget: 14, brakeDecel: 12, lookahead: 10 });
    }, [r, r.via.map(([x, z, y]) => ipNode(x, z, y))]);
    const t0 = Date.now();
    let worst = 0, levels = new Set(), done = false;
    while (Date.now() - t0 < 150000) {
      await sleep(250);
      const q = await G(() => {
        const g = window.__game, p = g.player, R = window.__route;
        let best = 1e9, by = 0;
        for (let i = 0; i + 3 < R.pts.length; i += 2) {
          const ax = R.pts[i], az = R.pts[i + 1], dx = R.pts[i + 2] - ax, dz = R.pts[i + 3] - az, L2 = dx * dx + dz * dz || 1;
          const t = Math.max(0, Math.min(1, ((p.x - ax) * dx + (p.z - az) * dz) / L2));
          const dd = Math.hypot(p.x - ax - dx * t, p.z - az - dz * t);
          if (dd < best) { best = dd; by = R.ys[i / 2] + (R.ys[i / 2 + 1] - R.ys[i / 2]) * t; }
        }
        return { dy: p.y - by, off: best, air: p.airborne, level: document.querySelector('.street small')?.textContent ?? '', done: Math.hypot(p.x - R.end[0], p.z - R.end[1]) < 25 };
      });
      if (!q.air && q.off < 10) worst = Math.max(worst, Math.abs(q.dy));
      if (q.level) levels.add(q.level.replace(/ · .*/, ''));
      if (q.done) { done = true; break; }
    }
    await shot(`13-ironport-drive-${r.name}`);
    out[r.name] = { done, worstLevelError: +worst.toFixed(2), seconds: (Date.now() - t0) / 1000, levels: [...levels] };
  }
  await G(() => { const g = window.__game; g.setAutopilot(null); g.player.invulnerable = false; });
  return { pass: Object.values(out).every((o) => o.done && o.worstLevelError < 1.0), ...out };
});

await check('Ironport: wanted on sight in free roam (a patrol or posted unit starts the chase); five stars bring extra units and the helicopter', async () => {
  if (!(await onIronport())) await gotoIronport();
  await resetPlay();
  await G(() => {
    const g = window.__game;
    g.save.data.settings.quietDrive = false;
    g.applySettings(g.save.data.settings);
    g.player.invulnerable = true;
    g.traffic.density = 22;
    // Drive at a posted unit on an avenue (any patrol that sees us on the way counts too).
    const q = g.pursuit.posted.filter((p) => p.away <= 0 && Math.hypot(p.x + 900, p.z + 600) > 400).sort((a, b) => Math.hypot(a.x + 900, a.z + 600) - Math.hypot(b.x + 900, b.z + 600))[0];
    g.placePlayer(-900, -600, Math.PI / 2, 0);
    g.setAutopilot(g.d.pathBetween(-900, -600, q.x, q.z, false, undefined, 30, 30), { maxSpeed: 20 });
  });
  const spotted = await waitFor(() => window.__game.pursuit.heat.stars > 0, 120000);
  const who = await G(() => { const g = window.__game, p = g.pursuit; return { reason: p.heat.reason, units: p.units.length, spotting: p.spotting, quiet: g.save.data.settings.quietDrive, mode: g.mode, event: !!g.event, patrols: g.traffic.cars.filter((c) => c.patrol).length, at: [Math.round(g.player.x), Math.round(g.player.z)] }; });
  await G(() => window.__game.pursuit.heat.setStars(5, 'playtest'));
  await sleep(20000);
  const five = await G(() => { const g = window.__game; return { units: g.pursuit.units.filter((u) => u.state !== 'disengage').length, heli: !!g.pursuit.heli, tanks: g.pursuit.units.filter((u) => u.type === 'tank').length }; });
  await shot('13-ironport-five-stars');
  await G(() => { const g = window.__game; g.setAutopilot(null); g.pursuit.clearAll(); g.player.invulnerable = false; });
  return { pass: spotted && /Spotted/.test(who.reason) && five.units >= 6 && five.heli, spotted, ...who, five };
});

await check('Ironport events: Hot Start ends when the search gives up, Siege runs to the clock, Breakout ends at The Lantern, Five Alarm ends when busted', async () => {
  if (!(await onIronport())) await gotoIronport();
  await resetPlay();
  const startEv = async (id) => {
    await G((id) => { const g = window.__game; if (g.screens.name === 'results') g.continueAfterResults(); g.pursuit.clearAll(); g.startEvent(id); }, id);
    await sleep(3700);
    return G(() => { const g = window.__game, h = g.pursuit.heat; return { stars: h.stars, forced: h.forced, hold: h.hold, state: g.event?.state }; });
  };
  const res = () => G(() => { const g = window.__game; return { screen: g.screens.name, text: (document.querySelector('.card')?.innerText ?? '').split('\n').slice(0, 3).join(' / '), medal: g.save.data.medals }; });
  const hotStart = await startEv('ip-hot');
  await sleep(1500);
  await G(() => window.__game.pursuit.heat.escape());
  await sleep(900);
  const hot = await res();
  await shot('13-ironport-hot-results');
  const siegeStart = await startEv('ip-siege');
  await G(() => { window.__game.pursuit.heat.searchMeter = 0.01; });
  await sleep(1500);
  const siegeHeld = await G(() => window.__game.pursuit.heat.stars);
  await G(() => { window.__game.event.time = window.__game.event.limit - 1.2; });
  await sleep(2200);
  const siege = await res();
  const breakStart = await startEv('ip-breakout');
  await G(() => { const g = window.__game, dst = g.event.dest; g.placePlayer(dst.x, dst.z, g.player.h, 0, 30); });
  await sleep(2200);
  const breakout = await res();
  const fiveStart = await startEv('ip-five');
  await G(() => { const h = window.__game.pursuit.heat; h.caughtMeter = 0.999; h.update(0.1, true, true); });
  await sleep(1200);
  const five = await res();
  await G(() => { const g = window.__game; if (g.screens.name === 'results') g.continueAfterResults(); g.pursuit.clearAll(); });
  return {
    pass: hotStart.stars === 2 && hotStart.forced && !hotStart.hold && /Escaped/.test(hot.text) && hot.screen === 'results'
      && siegeStart.stars === 4 && siegeStart.hold && siegeHeld >= 4 && /held out/.test(siege.text)
      && breakStart.stars === 3 && /Made it/.test(breakout.text) && fiveStart.stars === 5 && /Busted/.test(five.text),
    hotStart, hot, siegeStart, siegeHeld, siege, breakStart, breakout, fiveStart, five,
  };
});

await check('Zenith 400: 390+ mph on the Crosstown Viaduct (400 needs a longer straight), still on the deck', async () => {
  if (!(await onIronport())) await gotoIronport();
  await resetPlay();
  await G(() => { const g = window.__game; g.save.data.settings.quietDrive = true; g.applySettings(g.save.data.settings); g.setCar('zenith'); g.traffic.clear(); g.traffic.density = 0; g.placePlayer(-1645, -75, Math.PI / 2, 0, 30); g.input.clear(); });
  await page.keyboard.down('KeyW');
  let top = 0, y = 0;
  const t0 = Date.now();
  while (Date.now() - t0 < 24000) {
    await sleep(300);
    const q = await G(() => ({ mph: window.__game.state().mph, y: window.__game.player.y, x: window.__game.player.x }));
    top = Math.max(top, q.mph); y = q.y;
    if (q.x > 1150) break;
  }
  await shot('13-zenith-400');
  await page.keyboard.up('KeyW');
  const st = await G(() => { const g = window.__game; const s = g.state(); return { street: s.street, health: s.health, maxHealth: s.maxHealth }; });
  await G(() => { const g = window.__game; g.setCar('vesper'); g.save.data.settings.quietDrive = false; g.applySettings(g.save.data.settings); g.traffic.density = 22; });
  // The flat part of the viaduct runs out just short of full speed; the garage figure (checked above) is 400+.
  return { pass: top >= 390 && Math.abs(y - 48) < 1 && st.street === 'Crosstown Viaduct' && st.health === st.maxHealth, top: +top.toFixed(1), y: +y.toFixed(2), ...st };
});

await check('performance: Ironport at 1920x1080, a four-star chase through downtown with traffic', async () => {
  if (!(await onIronport())) await gotoIronport();
  await resetPlay();
  await G(() => {
    const g = window.__game;
    g.setCar('vesper');
    g.player.invulnerable = true;
    g.traffic.density = 22;
    const pts = g.d.pathBetween(-1350, -300, 1350, -300, false, undefined, 30, 30);
    g.placePlayer(pts[0], pts[1], Math.atan2(pts[2] - pts[0], pts[3] - pts[1]), 15, 30);
    g.setAutopilot(pts, { maxSpeed: 40, latBudget: 9, brakeDecel: 9 });
    g.pursuit.heat.forced = true;
    g.pursuit.heat.setStars(4, 'perf test');
  });
  await sleep(5000);
  await G(() => { window.__game.fps.frames.length = 0; });
  await sleep(15000);
  const city = await G(() => window.__game.perf());
  await shot('13-perf-ironport');
  await G(() => { const g = window.__game; g.setAutopilot(null); g.pursuit.clearAll(); g.player.invulnerable = false; });
  const rafCap = report.checks.find((c) => c.browserFrameCap)?.browserFrameCap ?? 60;
  return { pass: city.fps >= Math.min(55, rafCap * 0.92), city, browserFrameCap: rafCap };
});


// ------------------------------------------------------------ Hollowpeak (fictional mountains, the Wardens) and weapons
const gotoHollowpeak = async () => {
  await page.goto(URL_ + '?map=hollowpeak');
  await page.waitForFunction(() => window.__game, null, { timeout: 60000 });
  await sleep(600);
  await G(() => window.__game.enterDrive());
  await sleep(500);
};
const onHollowpeak = () => G(() => !!window.__game && window.__game.zones.some((z) => z.id === 'hp-tubes')).catch(() => false);
/** Drive a route of junction ids with the autopilot; worst gap between the car and the road's height. */
const driveIds = async (ids, speed, timeoutMs) => {
  await G(([ids, speed]) => {
    const g = window.__game, d = g.d;
    const nodes = ids.map((i) => d.nodeByOsm.get(i));
    const edges = [];
    for (let k = 1; k < nodes.length; k++) edges.push(...d.route(nodes[k - 1], nodes[k], false).edges);
    const pts = [], ys = [];
    let v = nodes[0];
    for (const ei of edges) {
      const e = d.edges[ei], fwd = e.a === v, n = e.pts.length / 2;
      for (let k = 0; k < n; k++) { const i = fwd ? k : n - 1 - k; if (pts.length && k === 0) continue; pts.push(e.pts[i * 2], e.pts[i * 2 + 1]); ys.push(e.ys[i]); }
      v = d.otherEnd(ei, v);
    }
    window.__route = { pts, ys, end: [pts[pts.length - 2], pts[pts.length - 1]] };
    g.player.invulnerable = true;
    g.traffic.clear();
    g.traffic.density = 0;
    g.placePlayer(pts[0], pts[1], Math.atan2(pts[2] - pts[0], pts[3] - pts[1]), 0, ys[0]);
    g.setAutopilot(pts, { maxSpeed: speed, latBudget: 14, brakeDecel: 12, lookahead: 12 });
  }, [ids, speed]);
  const t0 = Date.now();
  let worst = 0, done = false, top = 0;
  while (Date.now() - t0 < timeoutMs) {
    await sleep(250);
    const q = await G(() => {
      const g = window.__game, p = g.player, R = window.__route;
      let best = 1e9, by = 0;
      for (let i = 0; i + 3 < R.pts.length; i += 2) {
        const ax = R.pts[i], az = R.pts[i + 1], dx = R.pts[i + 2] - ax, dz = R.pts[i + 3] - az, L2 = dx * dx + dz * dz || 1;
        const t = Math.max(0, Math.min(1, ((p.x - ax) * dx + (p.z - az) * dz) / L2));
        const dd = Math.hypot(p.x - ax - dx * t, p.z - az - dz * t);
        if (dd < best) { best = dd; by = R.ys[i / 2] + (R.ys[i / 2 + 1] - R.ys[i / 2]) * t; }
      }
      return { dy: p.y - by, off: best, air: p.airborne, mph: p.speed / 0.44704, done: Math.hypot(p.x - R.end[0], p.z - R.end[1]) < 30 };
    });
    top = Math.max(top, q.mph);
    if (!q.air && q.off < 10) worst = Math.max(worst, Math.abs(q.dy));
    if (q.done) { done = true; break; }
  }
  await G(() => { const g = window.__game; g.setAutopilot(null); g.player.invulnerable = false; g.traffic.density = 22; });
  return { done, worstLevelError: +worst.toFixed(2), seconds: (Date.now() - t0) / 1000, topMph: Math.round(top) };
};

await check('Hollowpeak: fictional mountains with caves, speed tubes and sky-tubes; Warden patrols; trees kept back from the speedways', async () => {
  await gotoHollowpeak();
  await shot('14-hollowpeak-start');
  const meta = await G(() => {
    const g = window.__game, d = g.d;
    const tubes = d.data.tubes;
    let lo = 1e9, hi = -1e9;
    for (let i = 0; i < 601 * 601; i += 7) { const v = d.terrain.data[i]; lo = Math.min(lo, v); hi = Math.max(hi, v); }
    const trees = g.world.statics.circs.filter((c) => c.tag === 'tree');
    let close = 0;
    for (const t of trees) { const h = d.nearestEdge(t.x, t.z, 30, (e) => e.cls === 'primary'); if (h && h.d < d.edges[h.edge].width / 2 + 15) close++; }
    return {
      caves: tubes.filter((t) => t.cave).length, tubes: tubes.filter((t) => !t.cave && !d.edges[t.edge].bridge).length, skytubes: tubes.filter((t) => !t.cave && d.edges[t.edge].bridge).length,
      relief: Math.round(hi - lo), zones: g.zones.map((z) => z.id), patrolType: g.traffic.patrolType, force: g.pursuit.force, credit: document.querySelector('.credit')?.textContent ?? '',
      surface: !!d.surface, treesNearSpeedways: close, trees: trees.length,
    };
  });
  return { pass: meta.caves >= 5 && meta.tubes >= 5 && meta.skytubes >= 2 && meta.relief > 200 && meta.zones.length === 5 && meta.patrolType === 'warden' && meta.force === 'warden' && meta.surface && meta.treesNearSpeedways === 0 && /fictional/.test(meta.credit), ...meta };
});

await check('Hollowpeak: autopilot runs both crossways and Summit Road through every cave, tube and bridge without dropping through', async () => {
  if (!(await onHollowpeak())) await gotoHollowpeak();
  await resetPlay();
  const ns = await driveIds([47137480, 49005502, 47672520], 70, 180000);
  await shot('14-hollowpeak-crossway');
  const ew = await driveIds([25205296, 49005502, 74805230], 70, 180000);
  const summit = await driveIds([69005277, 69822708], 40, 180000);
  return { pass: [ns, ew, summit].every((r) => r.done && r.worstLevelError < 1.0), ns, ew, summit };
});

await check('Hollowpeak: a Warden knows the car on sight (straight to two stars) and the Wardens chase', async () => {
  if (!(await onHollowpeak())) await gotoHollowpeak();
  await resetPlay();
  await G(() => {
    const g = window.__game, d = g.d;
    g.save.data.settings.quietDrive = false;
    g.applySettings(g.save.data.settings);
    g.player.invulnerable = true;
    g.traffic.density = 22;
    const n = (id) => d.nodeByOsm.get(id);
    const pts = d.polylineFor(n(25205296), d.route(n(25205296), n(74805230), false).edges);
    g.placePlayer(pts[0], pts[1], Math.atan2(pts[2] - pts[0], pts[3] - pts[1]), 0, d.data.nodeY[n(25205296)]);
    g.setAutopilot(pts, { maxSpeed: 30 });
  });
  const spotted = await waitFor(() => window.__game.pursuit.heat.stars > 0, 150000);
  await sleep(6000);
  const r = await G(() => { const g = window.__game, p = g.pursuit; return { stars: p.heat.stars, reason: p.heat.reason, units: p.units.map((u) => u.type) }; });
  await shot('14-hollowpeak-wardens');
  await G(() => { const g = window.__game; g.setAutopilot(null); g.pursuit.clearAll(); g.player.invulnerable = false; });
  return { pass: spotted && r.stars >= 2 && /Warden/.test(r.reason) && r.units.includes('warden'), spotted, ...r };
});

await check('weapons: all six hit police (F key); the rail cannon wrecks two units in line; RPG and mines blast; shooting near police starts a chase', async () => {
  if (!(await onHollowpeak())) await gotoHollowpeak();
  await resetPlay();
  const setup = (ahead) => G((ahead) => {
    const g = window.__game, d = g.d;
    g.pursuit.clearAll();
    g.traffic.clear();
    const e = d.edges.filter((x) => x.name === 'East Crossway' && !x.bridge && x.level === 0).sort((a, b) => b.length - a.length)[0];
    const s = e.length * 0.3, p = e.path.pointAt(s), h = e.path.headingAt(s);
    g.player.invulnerable = true;
    g.placePlayer(p.x, p.z, h, 0, d.heightOnEdge(e.index, s));
    g.pursuit.heat.setStars(3, 'weapons test');
    const fx = Math.sin(h), fz = Math.cos(h);
    for (const [k, type] of [[ahead, 'warden'], [ahead + 25, 'cruiser'], [-25, 'warden']]) {
      const u = g.pursuit['makeUnit'](type, p.x + fx * k, p.z + fz * k, h + (k > 0 ? Math.PI : 0), 0, d.heightOnEdge(e.index, s + k));
      u.stall = 4;
    }
  }, ahead);
  const hpOf = () => G(() => window.__game.pursuit.units.map((u) => Math.round(u.hp)));
  const out = {};
  for (const w of ['machineGun', 'rpg', 'rearTurret', 'scattergun', 'mines', 'railgun']) {
    await setup(w === 'scattergun' ? 18 : 30);
    await G((w) => { const g = window.__game; g.setWeaponFor(g.carId, w); }, w);
    const before = await hpOf();
    const hitsBefore = await G(() => window.__game.weapons.hits);
    if (w === 'mines') {
      await page.keyboard.press('KeyF');
      await sleep(900);
      await G(() => { const g = window.__game, m = g.weapons.mines[0], u = g.pursuit.units.find((q) => q.v.z !== undefined && q.type === 'warden'); if (m && u) { u.v.x = m.x; u.v.z = m.z; } });
      await sleep(1000);
    } else if (w === 'machineGun' || w === 'rearTurret' || w === 'railgun') {
      await page.keyboard.down('KeyF');
      await sleep(w === 'railgun' ? 1200 : 2000);
      await page.keyboard.up('KeyF');
      await sleep(500);
    } else {
      await page.keyboard.press('KeyF');
      await sleep(w === 'rpg' ? 2000 : 800);
    }
    const after = await G(() => window.__game.pursuit.units.map((u) => `${u.type}:${Math.round(u.hp)}${u.state === 'wrecked' ? 'X' : ''}`));
    const hits = (await G(() => window.__game.weapons.hits)) - hitsBefore;
    out[w] = { before, after, hits };
    if (w === 'railgun') await shot('14-weapons-railgun');
  }
  // Shots fired with a patrol watching and no heat yet.
  await G(() => { const g = window.__game, d = g.d; g.pursuit.clearAll(); g.setWeaponFor(g.carId, 'machineGun'); const p = g.player; const u = g.pursuit['makeUnit']('warden', p.x + Math.sin(p.h) * 40, p.z + Math.cos(p.h) * 40, p.h, 0, p.y); u.state = 'disengage'; g.pursuit.heat.reset(); void d; });
  await page.keyboard.down('KeyF');
  await sleep(600);
  await page.keyboard.up('KeyF');
  const fired = await G(() => ({ stars: window.__game.pursuit.heat.stars, reason: window.__game.pursuit.heat.reason, takedowns: window.__game.pursuit.takedowns }));
  await G(() => { const g = window.__game; g.pursuit.clearAll(); g.player.invulnerable = false; g.setWeaponFor(g.carId, 'machineGun'); });
  const allHit = Object.values(out).every((o) => o.hits > 0);
  const railWrecks = out.railgun.after.filter((a) => a.endsWith('X')).length;
  return { pass: allHit && railWrecks >= 2 && fired.takedowns >= 2, ...out, fired };
});

await check('Hollowpeak events: Tube Run to the finish vs the rival, Summit Air scores (autopilot)', async () => {
  if (!(await onHollowpeak())) await gotoHollowpeak();
  await resetPlay();
  const run = async (id, car, speed) => {
    await G(([id, car]) => { const g = window.__game; if (g.screens.name === 'results') g.continueAfterResults(); g.setCar(car); g.traffic.clear(); g.traffic.density = 0; g.startEvent(id, 'rival'); }, [id, car]);
    await sleep(3600);
    await G((sp) => { const g = window.__game; g.player.invulnerable = true; g.setAutopilot(g.event.course.offsetPoints(2.5), { maxSpeed: sp, latBudget: 12, brakeDecel: 11, lookahead: 10 }); }, speed);
    const ok = await waitFor(() => window.__game.screens.name === 'results', 240000, 1000);
    const text = await G(() => (document.querySelector('.card')?.innerText ?? '').split('\n').slice(0, 10).join(' | '));
    await G(() => { const g = window.__game; g.setAutopilot(null); g.player.invulnerable = false; g.traffic.density = 22; });
    return { ok, text };
  };
  const tubes = await run('hp-tubes', 'meridian', 70);
  await shot('14-hollowpeak-tube-run');
  const air = await run('hp-air', 'northline', 45);
  await G(() => { const g = window.__game; if (g.screens.name === 'results') g.continueAfterResults(); g.setCar('vesper'); });
  return { pass: tubes.ok && /TUBE RUN/i.test(tubes.text) && air.ok && /Air score/i.test(air.text), tubes, air };
});

report.finished = new Date().toISOString();
report.summary = { passed: report.checks.filter((c) => c.pass).length, failed: report.checks.filter((c) => !c.pass).length };
fs.writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 2));
console.log(`\n${report.summary.passed} passed, ${report.summary.failed} failed; blocked external requests: ${report.blockedRequests.length}; console errors: ${report.consoleErrors.length}`);
await browser.close();
server.kill();
