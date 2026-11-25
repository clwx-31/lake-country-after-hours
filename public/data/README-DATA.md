# Map data for Lake Country After Hours

Map data © OpenStreetMap contributors — https://www.openstreetmap.org/copyright

Elevation: USGS 3D Elevation Program (3DEP), public domain, via the AWS Terrain
Tiles open dataset (Terrarium encoding) — https://registry.opendata.aws/terrain-tiles/

`lakecountry.json` is a derived database made from OpenStreetMap data and is
licensed under the Open Database License 1.0 (full text: `LICENSE-ODbL-1.0.txt`
in this folder). You may share and adapt it under the ODbL; credit
"© OpenStreetMap contributors". `lakecountry-terrain.json` is a 10 m heightfield (base64 Uint16, centimeters)
derived from the elevation tiles, with roads and lakes stamped into it.

## Provenance

- OSM source: Overpass API (https://overpass-api.de/api/interpreter), query in `scripts/fetch-lakecountry.mjs`
- Snapshot (download time, UTC): 2026-11-20T20:29:27Z
- Bounds (S, W, N, E): 43.0700, -88.4070, 43.1850, -88.2800 (North Lake and Merton included)
- Terrain tiles: zoom 14, 56 tiles
- Origin: fixed at 43.1115, -88.3535 (the original crop centre); equirectangular meters,
  +X east, +Z south, Y up; heights are meters above a fixed 256 m datum
- Contents: 1,953 junctions, 2,395 road segments (29 bridges), 3,817 OSM building
  footprints, 89 water areas, 753 land-cover areas
- Generated, not mapped: ~15,000 street houses and ~1,100 lakefront estate houses at real driveway
  ends, 494 docks, and the trees. Overpasses are given ~6 m of clearance by lifting the bridge road
  and cutting the road beneath (the bare-earth elevation model has no gap under bridges).

## How to obtain or rebuild the derived data

From the game folder:

```sh
npm run map:fetch      # data/raw-lake/lakecountry.osm.json + data/raw-lake/terrain/*.png
npm run map:convert    # rebuild public/data/lakecountry.json and lakecountry-terrain.json
```

Conversion command used for this build:

```sh
node scripts/convert-lakecountry.mjs
```

Street names, lakes, bridges, land use, village boundaries, and building
footprints are OpenStreetMap data. Lamplight Motor Works, The Low Room Rehearsal
Studios, The Copper Ear, the club rival, and all police vehicles are fictional.

## Holy Hill (second level)

`holyhill.json` and `holyhill-terrain.json` are made the same way and carry the
same licenses (ODbL 1.0 for the map; USGS 3DEP public domain for the terrain).

- OSM source: Overpass API, same query as above, bounds from `scripts/maps.mjs`
- Snapshot (download time, UTC): 2026-11-23T20:00:14Z
- Bounds (S, W, N, E): 43.205, -88.375, 43.285, -88.245 (Holy Hill, Friess Lake, Hubertus, Kettle Moraine)
- Terrain tiles: zoom 14, x 4169-4175, y 6002-6007 (42 tiles)
- Origin: fixed at 43.245, -88.31; heights are meters above the lowest ground minus 2 m,
  then **exaggerated 1.5× vertically** (a game choice, not survey data)
- Roads: up to 20% grade, with a 9 m level shelf beside each road
- Contents: 483 junctions, 612 road segments (5 bridges), 733 OSM building footprints,
  29 water areas, 283 land-cover areas; ~6,200 generated street houses and ~870 estate houses

```sh
node scripts/fetch-lakecountry.mjs --map holyhill
node scripts/convert-lakecountry.mjs --map holyhill
```

## Ironport (third level)

`ironport.json` and `ironport-terrain.json` describe a fictional city. They contain
no OpenStreetMap or USGS data: `scripts/build-ironport.mjs` generates them from
fixed rules and a fixed random seed, and they ship under the same terms as the
rest of the game.

- Size: 3.6 × 3.6 km; street level at y = 30 m, tunnels at 20 m, decks at 40, 48 and 56 m
- Terrain: 451 × 451 samples at 8 m, flat except the tunnel trenches (the step from
  trench floor to street level is hidden under the slabs beside each cut)
- Contents: 615 junctions, 1,063 road segments (92 bridges and decks, 13 tunnel
  segments), 1,972 buildings, 26 tunnel roofs, 1,998 trench wall pieces
- `under`: tunnel roofs and the street-level slabs beside each cut (rectangles),
  trench walls (with the floor height at each end and whether a roof covers them),
  and barriers along open cuts
- Junction ids: `level × 1e8 + (x + 2000) × 1e4 + (z + 2000)` (level 0 street,
  1 tunnel, 2 Skyway, 3 viaduct, 4 Highline)

```sh
node scripts/build-ironport.mjs
```

## Hollowpeak (fourth level)

`hollowpeak.json`, `hollowpeak-terrain.json` and `hollowpeak-surface.json` describe
fictional mountains. Like Ironport they contain no outside data:
`scripts/build-hollowpeak.mjs` generates them from fixed rules and seeds.

- Size: 6 × 6 km; terrain 601 × 601 samples at 10 m, peaks around 300 m
- Roads: the Rimway (18 km ring), North and East Crossways (six lanes, ≤ 5% grade),
  Summit, Ridge and Quarry Roads (two lanes, ≤ 17%)
- `tubes`: covered road edges, each a cave (`cave: 1`, its roof is the hill in
  `hollowpeak-surface.json`) or a speed tube (`cave: 0`), with the half-width
  inside the walls and the roof height
- `hollowpeak-terrain.json` is the ground with each cave cut down to the road;
  `hollowpeak-surface.json` is the same ground before the caves were cut
- Junction ids: `(x + 5000) × 1e4 + (z + 5000)`

```sh
node scripts/build-hollowpeak.mjs
```
