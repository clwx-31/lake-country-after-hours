// Downloads the Chenequa / Hartland source data (development only):
//  - an OpenStreetMap extract from Overpass -> data/raw-lake/lakecountry.osm.json
//  - Terrarium elevation tiles (zoom 14, USGS 3DEP via AWS Terrain Tiles)
//    -> data/raw-lake/terrain/14_{x}_{y}.png
// Usage: node scripts/fetch-lakecountry.mjs [--map lakecountry|holyhill] [--skip-osm] [--skip-terrain]
// Then: node scripts/convert-lakecountry.mjs --map <same>
import fs from 'node:fs';
import path from 'node:path';
import { mapArg } from './maps.mjs';

const MAP = mapArg();
const { s: S, w: W, n: N, e: E } = MAP.crop;
const OUT = path.resolve(MAP.raw);
const UA = 'osm-district-importer/1.0 (game level build script)';
const args = process.argv.slice(2);
fs.mkdirSync(path.join(OUT, 'terrain'), { recursive: true });

const query = `[out:json][timeout:240][bbox:${S.toFixed(4)},${W.toFixed(4)},${N.toFixed(4)},${E.toFixed(4)}];
(
  way["highway"];
  way["waterway"];
  way["natural"~"water|wood|wetland|scrub|grassland|tree_row|beach"];
  relation["natural"~"water|wood|wetland"];
  way["landuse"];
  relation["landuse"];
  way["leisure"];
  way["amenity"];
  node["amenity"~"school|place_of_worship|library|townhall|fire_station|police"];
  way["building"];
  relation["building"];
  way["railway"];
  way["man_made"~"pier|bridge"];
  node["natural"="tree"];
  relation["boundary"="administrative"]["admin_level"="8"];
  node["place"];
);
out body;
>;
out skel qt;`;

const endpoints = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];

async function fetchOsm() {
  for (let attempt = 0; attempt < 3; attempt++) {
    for (const ep of endpoints) {
      try {
        const res = await fetch(ep, {
          method: 'POST',
          headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded' },
          body: 'data=' + encodeURIComponent(query),
          signal: AbortSignal.timeout(300000),
        });
        const text = await res.text();
        if (res.ok && text.trim().startsWith('{')) return { text, endpoint: ep };
        console.warn(`overpass ${ep}: HTTP ${res.status}`);
      } catch (err) {
        console.warn(`overpass ${ep}: ${err.message}`);
      }
    }
    await new Promise((r) => setTimeout(r, 8000 * (attempt + 1)));
  }
  throw new Error('Overpass unavailable; try again later');
}

// Slippy-map tile range covering the bbox at zoom 14.
const Z = 14;
const tx = (lon) => Math.floor(((lon + 180) / 360) * 2 ** Z);
const ty = (lat) => {
  const r = (lat * Math.PI) / 180;
  return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** Z);
};
const x0 = tx(W), x1 = tx(E), y0 = ty(N), y1 = ty(S);

const meta = {
  source: 'OpenStreetMap',
  endpoint: '',
  bbox: { south: S, west: W, north: N, east: E },
  fetchedAt: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
  terrain: `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${Z}/{x}/{y}.png (x ${x0}-${x1}, y ${y0}-${y1})`,
  license: 'ODbL-1.0',
};

if (!args.includes('--skip-osm')) {
  const { text, endpoint } = await fetchOsm();
  fs.writeFileSync(path.join(OUT, `${MAP.file}.osm.json`), text);
  meta.endpoint = endpoint;
  console.log(`OSM: ${(text.length / 1e6).toFixed(1)} MB from ${endpoint}`);
}
if (!args.includes('--skip-terrain')) {
  let n = 0;
  for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) {
    const file = path.join(OUT, 'terrain', `${Z}_${x}_${y}.png`);
    if (fs.existsSync(file)) continue;
    const res = await fetch(`https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${Z}/${x}/${y}.png`, { headers: { 'User-Agent': UA } });
    if (!res.ok) throw new Error(`terrain tile ${x},${y}: HTTP ${res.status}`);
    fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
    n++;
  }
  console.log(`terrain: ${n} new tiles (${(x1 - x0 + 1) * (y1 - y0 + 1)} total)`);
}
fs.writeFileSync(path.join(OUT, `${MAP.file}.meta.json`), JSON.stringify(meta, null, 2));
