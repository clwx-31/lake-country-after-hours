// Dev helper: render a map's roads, water, landmarks and junction indices to PNG.
// Usage: node scripts/viz-junctions.mjs <map file> <out.png> <x0> <z0> <x1> <z1> <widthPx>
import fs from 'node:fs';
import { chromium } from 'playwright';
const [file, out, x0s, z0s, x1s, z1s, Ws] = process.argv.slice(2);
const d = JSON.parse(fs.readFileSync(file));
const X0 = +x0s, Z0 = +z0s, X1 = +x1s, Z1 = +z1s, W = +Ws, s = W / (X1 - X0), H = Math.round((Z1 - Z0) * s);
const P = (x, z) => [((x - X0) * s).toFixed(1), ((z - Z0) * s).toFixed(1)];
let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" style="background:#eee">`;
for (const w of d.water) { const q = []; for (let i = 0; i < w.outer.length; i += 2) q.push(P(w.outer[i], w.outer[i + 1]).join(',')); svg += `<polygon points="${q.join(' ')}" fill="#9cf"/>`; }
for (const e of d.edges) {
  const q = []; for (let i = 0; i < e.pts.length; i += 2) q.push(P(e.pts[i], e.pts[i + 1]).join(','));
  const relief = Math.max(...e.ys) - Math.min(...e.ys);
  svg += `<polyline points="${q.join(' ')}" fill="none" stroke="${e.cls === 'primary' ? '#e90' : e.cls === 'secondary' ? '#c60' : e.cls === 'tertiary' ? '#a77' : '#555'}" stroke-width="${Math.max(1.5, e.w * s)}" stroke-opacity="0.75"/>`;
}
const seen = new Set();
for (const e of d.edges) { if (!e.name || seen.has(e.name)) continue; const m = Math.floor(e.pts.length / 4) * 2; const [x, y] = P(e.pts[m], e.pts[m + 1]); if (x < 0 || y < 0 || x > W || y > H) continue; seen.add(e.name); svg += `<text x="${x}" y="${y}" font-size="12" fill="#00a">${e.name}</text>`; }
d.nodes.forEach((n, i) => { const [x, y] = P(n[1], n[2]); if (x < 0 || y < 0 || x > W || y > H) return; svg += `<circle cx="${x}" cy="${y}" r="2.5" fill="#f00"/><text x="${+x + 3}" y="${+y - 3}" font-size="9" fill="#900">${i}</text>`; });
for (const l of d.landmarks) { const [x, y] = P(l.x, l.z); svg += `<text x="${x}" y="${y}" font-size="11" fill="#060">◆${l.name.slice(0, 28)}</text>`; }
svg += '</svg>';
const b = await chromium.launch({ channel: 'chrome' }); const pg = await b.newPage({ viewport: { width: W, height: H } }); await pg.setContent(svg); await pg.screenshot({ path: out }); await b.close();
