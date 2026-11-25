# Lake Country After Hours

An arcade 3D driving game with four levels, two on real Wisconsin roads and two
made up:

- **Lake Country**: Hartland, Chenequa, Merton and North Lake. Downtown
  Hartland, the WIS 16 freeway, Pine, Beaver and North Lake, and the rolling
  farm roads in between.
- **Holy Hill**: the Kettle Moraine around Holy Hill, Friess Lake and Hubertus,
  the steepest country in southeast Wisconsin. Its hills are exaggerated 1.5×,
  so its roads have about 150 m of relief and dozens of crests.
- **Ironport**: a fictional city built for police chases. Roads run on five
  levels: covered tunnels under three avenues, the street grid, an elevated
  ring 10 m up, and two viaducts at 18 m and 26 m that cross at the Stack. There
  are no lamp posts or trees to hit, and police everywhere.
- **Hollowpeak**: fictional mountain country built for top speed. Six-lane
  speedways tunnel through the peaks in caves, cross the valleys on viaducts and
  run through long lit speed tubes. Steep hill roads climb over the shoulders for
  big air. Its police are **the Wardens**, who know your car on sight.

It has kart-style drifting with mini-turbos, real hills that throw you into the
air, 23 fictional cars (all in the garage from the start, up to the 400 mph
Zenith 400), 22 abilities and 6 weapons that any car can carry, posted radar
cops, pursuits with real stakes, and switchable golden hour, daytime and evening light. Friends
can drive the same map live, race each other and share a leaderboard.

Built with TypeScript, Vite, and Three.js. Every sound is synthesized at runtime
with Web Audio. The map, terrain, fonts, and code are bundled, so the release
runs from a local static server with no network access. Online play lights up
only when the game is opened from its claude.ai artifact link.

## Run it

```sh
cd 3dgame
npm install
npm run dev            # development server: http://localhost:5173/
```

Production build and local release server:

```sh
npm run build          # type-check + bundle into dist/
npm run serve:dist     # http://localhost:4173/ (any static server works; base path is relative)
```

Checks:

```sh
npm test               # unit tests: road graph, terrain and overpasses, lanes, kart handling,
                       # airtime, abilities, payouts/saves, ghost packing
npm run playtest       # end-to-end run of the built release in Chrome with external
                       # network blocked; writes playtest-output/report.json + screenshots
```

`npm run playtest` needs Google Chrome installed (Playwright launches it with
`channel: 'chrome'`). Add `-- --headed` to watch it. Its online check runs two
pages against `scripts/testing/mock-claude.js`, a local stand-in for the
claude.ai room, database, and user capabilities.

## Controls

| Input | Action |
|---|---|
| W / S or ↑ / ↓ | Throttle / brake (hold brake at rest to reverse) |
| A / D or ← / → | Steer |
| Hold Space (while turning) | Drift; release for a mini-turbo |
| Shift · E | Nitro · ability (press again to let go of the Grapple Hook) |
| F | Fire your weapon (hold for the guns and to charge the Rail Cannon) |
| C · hold V | Cycle close/wide camera · rear view |
| M · O · T | Map · online (friends, races, leaderboard) · time of day |
| Esc · R | Pause or back · recover to road (reset when totaled) |
| Enter | Start an event at its beacon, confirm, retry |

## How it drives

- **Arcade grip.** Cars turn on rails at town speeds and widen their line as
  speed rises. They never spin on their own.
- **Kart drift.** Hold Space while steering above about 20 mph. The car hops,
  swings its nose about 25–30° into the corner and holds it. Steering into the
  corner tightens the arc; steering out widens it. Sparks charge from blue to
  orange to purple. Let go for a mini-turbo of 0.7, 1.1 or 1.6 s. A drift keeps
  your speed, and a hard hit cancels it.
- **Airtime.** Roads follow USGS elevation data, so crests launch you at speed.
  Landing after about 0.45 s or more of air pays out a boost and some nitro, and
  the HUD shows your hang time. The Northline's Rally Hop adds extra air
  anywhere.
- **Nitro** refills fastest while drifting (more per spark tier) and in the air.
- **Time of day.** Golden hour, daytime, or evening after rain: press T or use
  Settings. Street lights, wet reflections, lit windows, and headlights follow
  the light.
- **Difficulty meter.** Five levels (Cruise, Easy, Normal, Hard, Insane), set
  from the meter on the title screen, pause menu, or Settings. One table in
  `src/game/difficulty.ts` scales rival pace, police pace/sight/search time and
  how fast they pin you, radar tolerance, event time limits, Last Set cargo
  damage, and nitro refill. Harder levels pay more credits; medal thresholds
  never change. Leaderboard times show the level they were set on.
- **Minimap.** Rotates with the car and is drawn as vectors from the same road,
  building and water data as the world, so it stays sharp at any heading, zoom,
  or screen density. Objectives off the map become pointers on the rim in their
  true direction; clustered pointers spread apart instead of stacking.

## Levels

Pick the level from **Level** on the title screen; the page reloads on the other
map. Cars, paint, abilities, credits and settings are shared between levels;
medals, best times and ghosts are kept per level. `?map=holyhill`,
`?map=ironport`, `?map=hollowpeak` or `?map=lakecountry` in the URL also picks one.

### Ironport

Ironport is generated by `scripts/build-ironport.mjs`; nothing in it is a real
place. It is about 3.6 km square: 150 m blocks with towers downtown and
warehouses toward the edge.

- **Underground.** The Canal, Market and Bessemer Underways run under three
  avenues, 10 m down. Each avenue dives between at-grade crossings: an open cut,
  then a roofed tunnel with lights in the roof, then back up. Skylights let a
  little sky in. The Canal and Market tunnels cross underground at the
  Undercross. At Bessemer Circus four tunnel mouths meet at one intersection.
  Cross streets bridge the cuts, and the roof over each tunnel is a plaza you can
  drive on.
- **Elevated.** The Skyway Loop is a ring 10 m up around downtown, with eight
  ramps down to the cross streets. The Crosstown Viaduct (18 m) and the Highline
  (26 m) cross over the Skyway and each other at the Stack. Four curved ramps
  join them there, and two more join each of them to the Skyway. All decks have
  parapets.
- **Levels matter.** Police can't see you from another level (a deck overhead,
  a tunnel or a cut below) unless they are within about 28 m. The helicopter
  loses you under any roof and circles where it last saw you. It needs about a
  second of clear view to pick you up again, so a skylight flash isn't enough.
  The HUD shows which level you are on.
- **Wanted on sight.** In free roam, any patrol car or posted unit that sees you
  starts a chase (not by the garage door, during events or in Quiet Drive).
  After you escape you get 25 s before the next patrol can pick you up. Nine
  patrol cars mix into traffic, posted units sit on the avenues, and every
  heat level sends two more units than on the other maps.
- **Nothing small to hit.** Street lights hang on wires over the middle of the
  road, tunnel lights are in the roof, and viaduct lights stand on the parapet.
  There are no trees. The solid things are buildings, walls, parapets, and the
  pillars under the elevated roads, which stand in block interiors and never on
  a road or on the plaza over a tunnel.

### Hollowpeak

Hollowpeak is generated by `scripts/build-hollowpeak.mjs`; nothing in it is a
real place. It is 6 km square with peaks around 300 m high.

- **Speedways.** The 18 km Rimway and two crossways are six lanes wide and graded
  at 5% or less, so they can be driven flat out. Where a mountain is in the way
  they go through it in a cave (seven in all). Where a valley drops away they
  cross it on a viaduct.
- **Speed tubes.** Long straights are covered: concrete tubes on open ground,
  and sky-tubes on top of the viaducts. They are lit inside, the helicopter
  can't see into them, and police outside can't see through the walls.
- **Hill roads.** Summit, Ridge and Quarry Roads are narrow and climb at up to
  17%, over crest after crest.
- **The Wardens.** Black interceptors with a red-and-white light bar, Hollowpeak's
  police. Six patrol in traffic. One that sees you starts a chase at two stars
  straight away, and they see through Phantom and Smoke Screen. Hills, caves and
  tubes still block their view, and they are the fastest police in the game.
- Trees are kept at least 22 m back from the speedways.

## Cars

All 23 are in the garage from the start. Everything is much faster than the
first build: measured top speeds run from about 167 mph (Harbor Camper) to 272
mph (Lancer LMP), and the police are faster to match. Then there is the
**Zenith 400**: 401 mph flat out, 0–60 in 1.2 s, 60–0 in 35 ft, 3.4 g of grip
and 250 health, the best in the garage at every figure. It has low drag, so it
keeps pulling past where the others stop.

| Car | Character | Signature |
|---|---|---|
| Finch RS | Hot hatch: light, sharp turn-in | Apex Grip |
| Vesper GT | Coupe: charges drift sparks fastest | Overdrive |
| Foundry V8 | Muscle: torque, long braking, heavy nose | Second Wind |
| Kestrel E | EV: instant shove, stable | Overclock |
| Northline RX | Rally wagon: soft, barely slows off-road | Rally Hop |
| Meridian S | Mid-engine exotic | Focus |
| Sprite | Kei microcar: tightest turning, fragile | Triple Boost |
| Volt Pod | Electric city car | EMP |
| Swallow Spyder | Open roadster | Grapple Hook |
| Vandal R | Rally hatch with a big wing | Glider |
| Dune Runner | Buggy: grass and air are home | Moon Jump |
| Rattler | Hot rod: all engine | Caltrops |
| Bandit 77 | '70s muscle: drifts forever | Smoke Screen |
| Wraith | Stealth coupe | Phantom |
| Monarch V12 | Grand tourer | Bubble Shield |
| Comet X | Electric hypercar | Blink |
| Lancer LMP | Le Mans prototype: fastest of all | Time Warp |
| Ambler | Woodie wagon | Patch Kit |
| Harbor Camper | Pop-top van | Oil Slick |
| Hauler 2500 | Pickup truck | Shockwave |
| Havoc | Armored SUV | Homing Missile |
| Mammoth | Monster truck: lands anything | Superstar |
| Zenith 400 | Land-speed hypercar: 400 mph, best at everything | Overdrive |

The garage shows 0–60 mph, top speed, and 60–0 braking measured from each car's
own simulation, plus health (from 60 for the Sprite to 220 for the Mammoth).
Any car can be test-driven for two minutes.

## Abilities

Every car carries its signature, and the garage's ability grid fits any of the
22 to any car (E to use). The choice is saved per car.

| Ability | What it does | Recharge |
|---|---|---|
| Superstar | 7 s invincible and faster: no damage, flats or arrest; whatever you hit goes flying | 28 s |
| Grapple Hook | Hook a tree, pole or car ahead (within 70 m) and swing around it; letting go gives a boost | 4 s |
| Phantom | 5 s ghost: drive through cars; police lose sight | 22 s |
| Shockwave | Throws every car within 35 m away, stalls police, swats rockets | 16 s |
| Oil Slick | A slick behind you; chasers spin out | 9 s |
| Caltrops | Spikes behind you; chasers blow tires and stall | 14 s |
| Smoke Screen | 4 s of smoke; police behind can't see through it | 18 s |
| Patch Kit | +35% health and one flat fixed | 30 s |
| Bubble Shield | 10 s shield that absorbs three hits (crashes, shots, spikes, rockets) | 24 s |
| Glider | A hop, then wings: a slow, steerable glide (long off a crest) | 12 s |
| Blink | Teleport 40 m ahead through anything (shorter if the spot is blocked) | 9 s |
| Triple Boost | Three boosts, one per press | 14 s after the last |
| Homing Missile | Hits the nearest police unit or rival ahead and stalls it for 5 s | 12 s |
| EMP | Police within 90 m stall; shots, rocket locks, radar and the helicopter are blind for 6 s | 26 s |
| Moon Jump | Straight up, about 7 m | 10 s |
| Time Warp | Everything but you runs at a third of the speed for 4 s | 22 s |
| Apex Grip, Overdrive, Second Wind, Overclock, Rally Hop, Focus | The original six signatures | 9–18 s |

The mechanics are kart-style; names and visuals are this game's own.

## Weapons

Every car also carries a weapon, fired with **F** and picked per car in the
garage (each car has a standard one, marked ★).

| Weapon | How it works |
|---|---|
| Machine Gun | Hold F: 12 rounds a second at whatever is ahead; overheats after about 4 s |
| RPG | Press F: a rocket that steers a little toward the nearest unit; wrecks a cruiser in one hit and can bring down the helicopter; 3 s reload |
| Rear Turret | Hold F: aims itself at whoever is chasing you; overheats after about 4 s |
| Scattergun | Press F: a wide blast that hits and shoves everything within 30 m ahead; 1.2 s reload |
| Mine Layer | Press F: a proximity mine behind you, up to four at once |
| Rail Cannon | Hold F to charge, release: a beam through every car in line; 5 s recharge |

Police units have armor: cruisers take about 100 points of damage, Wardens 170,
and armored units 420, with bullets doing only a quarter to them. A wrecked
unit burns and drops out, and the next one comes from further off. Each wreck
adds heat and pays credits when you get away (more for the helicopter, and no
new helicopter comes for 45 s). Firing where police can see starts a chase.
Weapons hold fire during races and air events, and work in free roam and the
chase events. Shots also knock traffic aside.

## Events

Lake Country:

- **Warm-Up Run** (downtown Hartland): stop in the box on Capitol Drive, drift the turn onto North Avenue for a mini-turbo, hit 60 mph at the trap, fire your signature.
- **Beaver View Loop**: two hilly laps of Beaver Lake Road, Beaver View Road, Deer Trail and Red Fox Run, with boost pads on the straights. Race the club rival or your ghost.
- **Last Set**: carry a snare from The Low Room on Hwy 83 by Pine Lake to The Copper Ear on Capitol Drive before the set starts. Impacts cut the case-condition bonus.
- **Winkleman Air**: Winkleman Road north over the farm hills. Every landing scores airtime, and chained landings multiply.
- **Five-Star Encore**: an opt-in pursuit up North Avenue, west on WIS 16 past the posted units, off at Hwy 83 and north toward Chenequa. Bank at the off-ramp or go for the five-star finish.

Holy Hill (each course has about 100 m of relief):

- **Holy Hill Loop**: one 7.8 km lap around the shrine hill (Holy Hill Road, Saint Augustine, Emerald, Donegal, Carmel Road). Rival or ghost.
- **Shrine Climb**: a sprint up Holy Hill Road from County K, over the shrine's shoulder.
- **Shannon Drop**: a sprint down Shannon Road, 100 m of fall over seventeen crests.
- **Supper Club Run**: get a cake from the Friess Lake Boathouse to The Summit Supper Club by the shrine; hits crack the frosting.
- **Elmwood Air**: a dozen glacial crests in three kilometres; chain landings.
- **Moraine Encore**: the opt-in pursuit, across the moraine to Hubertus.

Ironport (every event is a chase, and each one runs even with Quiet Drive on):

- **Hot Start** (★★): lose them as fast as you can. The clock stops when the search gives up.
- **Underway Escape** (★★★★, helicopter): start at the Canal Underway's mouth and lose the helicopter under the roofs.
- **Five Alarm** (★★★★★): start under the Stack with armored units, rockets, spikes and the marksman.
- **Siege** (★★★★ and it never drops): stay free for three minutes. A medal for every minute.
- **Breakout** (★★★ held): cross the whole city from the Coldwater Lockup to The Lantern on Dock Avenue and stop in the box.

The escape and Breakout medal times are estimates from test drives. Getting
busted or totaled ends any of them.

Hollowpeak:

- **Tube Run**: the North Crossway rim to rim, about 5 km, through a tube, a sky-tube and the cave under Cathedral Rock. Rival or ghost.
- **Rimway**: one 18 km lap of the ring, with three caves, several speed tubes and two sky-tubes.
- **Summit Air**: up Summit Road over the shoulder of Iron Knob; chain the crests.
- **Hunted** (★★★★ held, Wardens): stay free for three minutes.
- **Cave Escape** (★★★): lose the Wardens; the caves and tubes hide you from the air.

## Police

Zero to five stars, defined in `src/sim/heat.ts`. Witnessed crashes start a
chase. **Posted units** sit in the WIS 16 median about every 800 m in each
direction, plus some on the shoulders of the county highways. Their radar clocks
you over the limit (75 mph on the freeway, 55 elsewhere), and a clocked unit
pulls out and joins the chase. During timed events (except the Encore) radar
only warns, so speeding over Winkleman Road's hills never turns into a chase. Units search the last-seen spot, reinforce out of
view, and at higher heat bring interceptors, bonus gates, roadblocks with a
marked open lane, and a five-star finish gate. **Quiet Drive** turns pursuits
off; radar then only warns.

### What a pursuit costs you

| Stars | New threat |
|---|---|
| ★★★ | Cruisers and interceptors shoot at your tires (muzzle flash and tracer; hits blow a tire) |
| ★★★★ | A **helicopter** keeps sight from the air (lose it under tree canopy off main roads or under an overpass, or outrun it); **spike strips** across the road ahead (the shoulders stay open; jumping them is safe) |
| ★★★★★ | **Armored units** join: their turrets lock on (red laser, `ROCKET LOCK` warning and beeps for 1.4 s) and fire rockets whose blasts damage and launch you. The helicopter's marksman paints you with a laser, then shoots at a tire |

- **Damage sticks.** Each car has health (Finch 80 up to Foundry 135) and four
  tires, shown by the speedometer. Hard crashes and police rams hurt (armored
  rams more); one crash never takes more than 45%. A hurt engine smokes and
  loses power; each flat costs speed and grip and pulls the car toward its side,
  with sparks off the rim. Damage is saved per car until it is repaired.
- **Totaled.** At zero health the car dies and burns. Press R to reset: it is
  towed to Lamplight Motor Works and repaired, and you pay the repair bill (plus
  the fine if the police were on you). A timed event ends.
- **Busted** costs a fine that grows with the stars. Escaping pays more the
  hotter it got. Fines and bills never take you below zero credits.
- **Repairs** in the garage cost credits in proportion to the damage.
- The difficulty meter scales police accuracy, rocket reload, and the damage you take.

## Online with friends

Open the game from its claude.ai link while signed in. Everyone viewing it at
the same time shares one live room (O opens the panel):

- **See each other drive.** Each car's position is shared about 15 times a
  second and drawn smoothly for everyone, with a name tag. Friends' cars are
  solid: you can bump them.
- **Race.** Host the Beaver View Loop, Winkleman Air, or Last Set to get a
  4-letter code. Friends press Join, and the host presses Start. Everyone gets a
  grid slot and a countdown, standings update live, and the host can run it
  again.
- **Leaderboard.** Your best for each event is saved to the artifact's shared
  database, and Beaver View Loop bests include a ghost anyone can race from the
  board. Everyone can read the board, but each player can only write their own
  entries (the owner can tidy).

Friends need a Claude account and an invite from the artifact's Share menu.
Contributor access lets them post leaderboard times; viewers can still drive
and race. Without the claude.ai runtime the game is single player.

## Map data and licenses

Map data © OpenStreetMap contributors, licensed under the ODbL 1.0. Elevation:
USGS 3D Elevation Program (public domain) via the AWS Terrain Tiles open
dataset. The derived maps (`public/data/lakecountry.json`, `holyhill.json`), the
terrain heightfields (`*-terrain.json`), provenance, the license text, and
rebuild instructions ship in `public/data/` (copied to `dist/data/`). Each map's
bounds, origin, vertical scale and road grade limit are in `scripts/maps.mjs`.

Holy Hill: bounds S 43.205, W −88.375, N 43.285, E −88.245 (about 10.6 × 8.9 km),
origin 43.245, −88.31, terrain ×1.5 vertically, roads up to 20% grade, and a
9 m level shelf beside each road so the steep hillsides never rise through the
asphalt. Its venues (Moraine Speed Shop, Friess Lake Boathouse, The Summit
Supper Club) are fictional.

Lake Country:

- Bounds: S 43.0700, W −88.4070, N 43.1850, E −88.2800 (about 10.3 × 12.8 km;
  extended north and east to take in all of North Lake and the Village of Merton)
- Origin fixed at 43.1115, −88.3535 so coordinates stay put when the bounds grow
- Snapshot: 2026-11-20T20:29:27Z (Overpass)

```sh
npm run map:fetch      # re-download the OSM extract and the terrain tiles into data/raw-lake/
npm run map:convert    # rebuild public/data/lakecountry.json and lakecountry-terrain.json
node scripts/fetch-lakecountry.mjs --map holyhill     # into data/raw-holyhill/
node scripts/convert-lakecountry.mjs --map holyhill   # public/data/holyhill*.json
```

What is real and what is generated:

- **Real (OSM):** every road and its name, the WIS 16 freeway and ramps,
  bridges, lakes, streams, rail, land use, 3,817 mapped buildings, schools,
  churches, the library, and the village boundaries.
- **Real (USGS):** the ground shape, at 10 m resolution.
- **Generated:** OSM maps few houses here, so about 15,000 houses line the
  mapped residential streets and about 1,100 estate houses sit at the ends of
  real private driveways around the lakes, with docks on the shore. Trees fill
  mapped woods (with an understory), yards and parks, and hedgerows follow the
  edges of real farm fields; Chenequa is wooded by default. Under each overpass the road beneath
  is cut down and the bridge lifted to give about 6 m of clearance (the
  bare-earth elevation data has no gap there).
- **Not in the map:** I-94 runs south of these bounds, so the freeway here is
  WIS 16.

Lamplight Motor Works, The Low Room Rehearsal Studios, The Copper Ear, the club
rival, and all police vehicles are fictional. The map marks fictional places
with ★ and real landmarks with ◆.

Hollowpeak uses no outside data either. `node scripts/build-hollowpeak.mjs`
writes `public/data/hollowpeak.json`, `hollowpeak-terrain.json` (the ground cars
drive on, with each cave cut out) and `hollowpeak-surface.json` (the hill over
each cave). It grades each road with a speed-limited profile, then marks caves
where the hill stands more than about 16 m over the road and bridges where the
valley drops more than 9 m. Bridge ends sit on embankments. Like Ironport's, it
checks grades, crossings and connectivity before writing.

Ironport uses no outside data. `node scripts/build-ironport.mjs` writes
`public/data/ironport.json` and `ironport-terrain.json`. It also checks the result
before writing: every crossing between levels has clearance, grades stay under
11.5%, and every junction is reachable. The file adds `under` (tunnel walls,
roofs, the street-level slabs beside each cut, and barriers) and a level per road
to the usual district format. Junction ids encode position and level,
`level × 1e8 + (x + 2000) × 1e4 + (z + 2000)`, so events and venues name them
directly.

## Layout

```
scripts/       maps (per-map bounds and options), fetch-lakecountry, convert-lakecountry, build-ironport, build-hollowpeak, serve-dist, playtest,
               ability-check, combat-check, view/shot (dev helpers)
scripts/testing/mock-claude.js   local stand-in for the claude.ai room/db/user runtime
public/data/   lakecountry.json, holyhill.json, ironport.json, hollowpeak.json (+ hollowpeak-surface.json), their *-terrain.json, LICENSE-ODbL-1.0.txt, README-DATA.md
src/map/       levels (maps.ts), road graph, terrain, landcover, junction geometry, lanes, venue anchors
src/sim/       arcade vehicle, ground/decks/roofs, abilities, weapons, collisions, AI driver, traffic, heat, pursuit
src/events/    courses, event rules, gates and boost pads
src/render/    world, forest, scenery, time of day, cars, venues, materials, camera, renderer
src/net/       online presence, races, leaderboard
src/audio/     engine/effects synthesis and the generative score
src/ui/        HUD, minimap, map screen, menus, garage, online panel
tests/         vitest suites
```
