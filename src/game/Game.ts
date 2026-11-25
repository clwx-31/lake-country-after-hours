// Top-level orchestrator: fixed-timestep simulation with interpolated rendering,
// and the hand-off between title, free roam, events, pursuits, garage, and menus.
import * as THREE from 'three';
import { Audio, type SirenVoice } from '../audio/Audio';
import { Input } from '../core/Input';
import { clamp, damp, lerp, lerpAngle } from '../core/math';
import { EVENTS, EVENT_ORDER, eventOfKind, type EventId } from '../events/defs';
import {
  AirRun, CircuitRun, EncoreRun, EscapeRun, GetawayRun, LastSetRun, SurviveRun, WarmUpRun, fmtTime,
  type EventHost, type EventResult, type EventRun, type Racer,
} from '../events/runs';
import { Course } from '../events/Course';
import { beacon } from '../events/visuals';
import type { District } from '../map/District';
import { LaneGraph } from '../map/lanes';
import { REHEARSAL, VENUE, GARAGE, VENUES, resolveAnchor, venueFrame } from '../map/places';
import { pointInPolygon } from '../core/math';
import { Forest } from '../render/Forest';
import { TIMES, TIME_ORDER } from '../render/TimeOfDay';
import { CarModel } from '../render/CarModel';
import { ChaseCamera } from '../render/ChaseCamera';
import { Scenery } from '../render/Scenery';
import { Stage } from '../render/Stage';
import { Venues } from '../render/Venues';
import { SURF_GRASS, SURF_ROAD, SURF_WALK, SURF_WATER, World } from '../render/World';
import { glowTexture } from '../render/materials';
import { Save, type Ghost, type Settings } from '../save/Save';
import { AIDriver, type Skill } from '../sim/AIDriver';
import { CARS, type CarId } from '../sim/cars';
import { Ability, Grapple, makeAbility, type AbilityWorld } from '../sim/abilities';
import { DEFAULT_WEAPON, WeaponSystem, type WeaponId, type WeaponTarget, type WeaponWorld } from '../sim/weapons';
import { ABILITIES, type AbilityId } from '../sim/abilityInfo';
import { MAP, MAPS, rememberMap, type MapId } from '../map/maps';
import { HEAT_AWARDS, HEAT_LEVELS } from '../sim/heat';
import { collidePair, collideStatic, type Contact, type PhysBody, type StaticTag, type StaticWorld } from '../sim/Physics';
import { Pursuit } from '../sim/Pursuit';
import { Traffic, type Actor } from '../sim/Traffic';
import { DRIFT_TIERS, Vehicle, defaultMods, measureCar, type DriveInput } from '../sim/Vehicle';
import { Hud, el, type MiniMarker } from '../ui/Hud';
import { Online, escapeHtml } from '../net/Online';
import { Effects } from '../render/Effects';
import { LC } from '../map/Landcover';
import { ROAD_RANK } from '../map/District';
import { difficulty, type DifficultyLevel } from './difficulty';
import { MapScreen, type MapPoint } from '../ui/MapScreen';
import { Screens, type CarFigures } from '../ui/Screens';

export const STEP = 1 / 120;
const TUNNEL_TAGS = new Set<StaticTag>(['building', 'rail', 'barrier', 'boundary', 'obstacle']);
/** Events that are police chases: posted units join in instead of only warning. */
const CHASE_KINDS = new Set(['encore', 'escape', 'survive', 'getaway']);
/** What stops a bullet or a rocket. */
const WEAPON_WALLS = new Set<StaticTag>(['building', 'rail', 'barrier', 'boundary']);

/**
 * Free the JavaScript copy of static geometry once it is on the GPU (the map's
 * houses, roads and terrain are ~0.5 GB of vertex arrays otherwise). Bounds are
 * computed first so frustum culling keeps working without the arrays.
 */
function releaseAfterUpload(roots: THREE.Object3D[]) {
  const seen = new Set<THREE.BufferGeometry>();
  const free = function (this: THREE.BufferAttribute) {
    (this as unknown as { array: ArrayLike<number> | null }).array = null;
  };
  for (const root of roots) {
    root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      const geo = mesh.geometry as THREE.BufferGeometry | undefined;
      if (!geo || seen.has(geo) || (o as THREE.InstancedMesh).isInstancedMesh || (o as THREE.Points).isPoints) return;
      seen.add(geo);
      if (!geo.boundingSphere) geo.computeBoundingSphere();
      if (!geo.boundingBox) geo.computeBoundingBox();
      for (const name of Object.keys(geo.attributes)) (geo.attributes[name] as THREE.BufferAttribute).onUpload(free);
      geo.index?.onUpload(free);
    });
  }
}
type Mode = 'title' | 'drive' | 'garage' | 'menu';

interface AIRacer extends Racer {
  ai: AIDriver;
  model: CarModel;
  stall: number;
  spin: number;
}

const RING_GEO = new THREE.RingGeometry(0.92, 1, 48).rotateX(-Math.PI / 2);
const PHANTOM_MAT = new THREE.MeshBasicMaterial({ color: 0x9fd8ff, transparent: true, opacity: 0.3, depthWrite: false });
const STALLED: DriveInput = { throttle: 0, brake: 0.55, steer: 0, drift: false, nitro: false };

interface StartZone {
  id: EventId;
  x: number;
  z: number;
  h: number;
  obj: THREE.Object3D;
}

export class Game implements EventHost {
  readonly stage: Stage;
  readonly world: World;
  readonly scenery: Scenery;
  readonly forest: Forest;
  readonly venues: Venues;
  readonly lanes: LaneGraph;
  readonly traffic: Traffic;
  readonly pursuit: Pursuit;
  /** The player's weapon (F). */
  readonly weapons: WeaponSystem;
  readonly input = new Input();
  readonly cam: ChaseCamera;
  readonly hud: Hud;
  readonly screens: Screens;
  readonly mapScreen: MapScreen;
  readonly save = new Save(undefined, MAP.saveId);
  readonly audio = new Audio();
  /** Garage figures, measured on first look (22 cars are slow to time all at boot). */
  readonly figures: Record<string, CarFigures> = new Proxy({} as Record<string, CarFigures>, {
    get: (t, k) => (typeof k === 'string' && Object.hasOwn(CARS, k) ? (t[k] ??= measureCar(CARS[k as CarId])) : undefined),
  });
  readonly online: Online;
  difficulty: DifficultyLevel = difficulty(3);
  readonly effects = new Effects();
  private fxClock = 0;
  private rotorClock = 0;
  private lockBeep = 0;
  private conditionSaveAt = 0;
  private boardEv: EventId = eventOfKind('circuit')?.id ?? 'circuit';
  private panelKey = '';
  /** Remote cars we are overlapping (spawned on top of each other): no collisions until apart. */
  private phasing = new Set<string>();
  private raceGrace = 0;
  player!: Vehicle;
  playerModel!: CarModel;
  ability!: Ability;
  carId: CarId = 'vesper';
  nitro = 0.7;
  frozen = false;
  mode: Mode = 'title';
  paused = false;
  simTime = 0;
  realTime = 0;
  event: EventRun | null = null;
  private lastEvent: { id: EventId; mode: 'rival' | 'ghost' | 'online' } | null = null;
  private racers: AIRacer[] = [];
  private ghost: { data: Ghost; model: CarModel } | null = null;
  private zones: StartZone[] = [];
  private contacts: Contact[] = [];
  private acc = 0;
  private last = 0;
  private beamTex = glowTexture(64);
  private lastValid: { x: number; z: number; h: number; y?: number }[] = [];
  private validTimer = 0;
  private surface = SURF_ROAD;
  private surfY = 0;
  private fps = { t: 0, n: 0, value: 0, frames: [] as number[] };
  private gps: { x: number; z: number; route: number[] | null } | null = null;
  private gpsTimer = 0;
  private pursuitId = '';
  private pursuitLive = false;
  private pursuitSeq = 0;
  private testDrive: { car: CarId; left: number } | null = null;
  private garageAngle = 0.6;
  private showcase: CarModel | null = null;
  private caughtPending = false;
  private confirmLatch = false;
  private titleT = 0;
  private menuReturn: Mode = 'drive';
  private frustum = new THREE.Frustum();
  private prevSurface = SURF_ROAD;
  private nitroCueLatch = false;
  private camPos = new THREE.Vector3();
  private keyLight = new THREE.PointLight(0x9fb4ff, 9, 11, 1.4);
  private streetCandidate = '';
  private streetShown = '';
  private streetHold = 0;

  constructor(readonly d: District, canvas: HTMLCanvasElement, readonly uiRoot: HTMLElement) {
    const settings = this.save.data.settings;
    this.stage = new Stage(canvas);
    this.cam = new ChaseCamera(window.innerWidth / window.innerHeight);
    // Keep generated houses and trees off the fictional venues' lots.
    const reserved = VENUES.map((v) => {
      const f = venueFrame(d, v);
      return { x: f.center.x, z: f.center.z, r: Math.hypot(v.width, v.depth) / 2 + 7 };
    });
    // ...and keep parked cars off the garage curb and the event start spots.
    const park = resolveAnchor(d, { ...GARAGE.anchor, along: GARAGE.anchor.along + 7 });
    reserved.push({ x: park.x, z: park.z, r: 14 });
    for (const id of EVENT_ORDER) {
      if (EVENTS[id].kind === 'lastset' || EVENTS[id].kind === 'getaway') continue;
      const p = new Course(d, id, EVENTS[id].waypoints).pose(EVENTS[id].startAlong, 2);
      reserved.push({ x: p.x, z: p.z, r: 16 });
    }
    this.world = new World(d, { lowEffects: settings.lowEffects }, reserved);
    this.forest = new Forest(this.world, settings.lowEffects);
    this.scenery = new Scenery(this.world, settings.lowEffects);
    this.venues = new Venues(d, this.world.statics, (x, z) => this.world.ground.height(x, z, -1e9));
    this.lanes = new LaneGraph(d, this.world.asphalt);
    this.traffic = new Traffic(this.lanes, this.stage.scene, this.beamTex);
    this.traffic.ground = this.world.ground.height;
    this.pursuit = new Pursuit(d, this.lanes, this.stage.scene, this.world.statics, this.traffic, this.beamTex);
    this.pursuit.ground = this.world.ground.height;
    this.pursuit.ceiling = (x, z, y) => this.world.ground.ceiling(x, z, y);
    this.pursuit.effects = this.effects;
    // Cover from the helicopter: tree canopy or a bridge deck overhead.
    this.pursuit.coverAt = (x, z, y) => {
      if (this.world.ground.height(x, z, Infinity) > y + 3) return true; // under a bridge deck
      if (this.world.ground.ceiling(x, z, y) < y + 30) return true; // in a cave or a tube
      const lc = this.world.landcover.at(x, z);
      if (lc !== LC.forest && lc !== LC.woods) return false;
      // Canopy closes over narrow lanes and off-road, not over main roads.
      const hit = this.d.nearestEdge(x, z, 10);
      return !hit || (ROAD_RANK[this.d.edges[hit.edge].cls] ?? 1) < 3;
    };
    this.traffic.patrols = MAP.cops?.patrols ?? 2;
    if (MAP.cops?.force === 'warden') { this.traffic.patrolType = 'warden'; this.pursuit.force = 'warden'; }
    this.weapons = new WeaponSystem(this.weaponWorld());
    this.pursuit.extraUnits = MAP.cops?.extraUnits ?? 0;
    this.pursuit.setupPosted();
    this.cam.ground = (x, z) => this.world.ground.height(x, z, this.player.y + 2);
    this.cam.ceiling = (x, z, y) => this.world.ground.ceiling(x, z, y);
    this.stage.scene.add(this.world.group, this.forest.group, this.scenery.group, this.venues.group, this.keyLight, this.effects.group);
    // Static map geometry never changes after upload: let the GPU copy be the only one.
    // (?keepGeometry keeps the arrays readable for automated geometry checks.)
    if (!new URLSearchParams(location.search).has('keepGeometry')) releaseAfterUpload([this.world.group, this.scenery.group, this.venues.group]);
    this.stage.warmUp([this.world.group, this.scenery.group, this.venues.group], this.cam.camera);
    this.stage.setLamps(this.scenery.lamps);
    this.hud = new Hud(d, { text: d.data.meta.attribution, url: d.data.meta.attributionUrl, terrain: MAP.credits ? undefined : 'Elevation: USGS 3DEP', plain: MAP.credits });
    this.mapScreen = new MapScreen(d, { text: d.data.meta.attribution, url: d.data.meta.attributionUrl });
    this.screens = new Screens(this.handlers(), this.save, { text: d.data.meta.attribution, url: d.data.meta.attributionUrl });
    uiRoot.append(this.hud.root, this.screens.root);
    this.buildZones();
    this.applySettings(settings);

    window.addEventListener('resize', () => {
      this.stage.resize(this.cam.camera);
      if (this.mapScreen.root.isConnected) this.mapScreen.draw();
    });
    window.addEventListener('blur', () => this.autoPause());
    document.addEventListener('visibilitychange', () => { if (document.hidden) this.autoPause(); });
    const unlock = () => this.unlockAudio();
    window.addEventListener('pointerdown', unlock);
    this.input.onAnyKey = unlock;
    let dragging = false, lastX = 0;
    canvas.addEventListener('pointerdown', (e) => { dragging = true; lastX = e.clientX; });
    window.addEventListener('pointerup', () => (dragging = false));
    window.addEventListener('pointermove', (e) => {
      if (dragging && this.mode === 'garage') {
        this.garageAngle += (e.clientX - lastX) * 0.008;
        lastX = e.clientX;
      }
    });

    this.carId = this.save.data.selected;
    this.spawnPlayer(this.carId);
    this.parkAtGarage();

    // Online play (claude.ai room/db/user); single player when unavailable.
    const game = this;
    this.online = new Online({
      scene: this.stage.scene,
      beamTex: this.beamTex,
      bounds: this.d.bounds,
      get player() { return game.player; },
      get carId() { return game.carId; },
      paint: () => this.paintFor(this.carId),
      eventId: () => this.event?.def.id ?? '',
      stars: () => this.pursuit.heat.stars,
      visible: () => this.mode === 'drive' || (this.mode === 'menu' && this.menuReturn === 'drive'),
      startRace: (ev, slot) => this.beginOnlineRace(ev, slot),
      toast: (b, sm, sec) => this.toast(b, sm, sec),
    });
    this.online.onChange = () => {
      if (this.screens.name !== 'online') return;
      const key = this.online.panelKey();
      if (key !== this.panelKey) this.openOnline();
    };
  }

  // ------------------------------------------------------------------ setup
  private buildZones() {
    const add = (id: EventId, x: number, z: number, h: number) => {
      const def = EVENTS[id];
      const obj = beacon(def.color, def.name.toUpperCase(), 'Stop here · Enter');
      obj.position.set(x, this.roadY(x, z), z);
      this.stage.scene.add(obj);
      this.zones.push({ id, x, z, h, obj });
    };
    for (const id of EVENT_ORDER) {
      if (EVENTS[id].kind === 'lastset' || EVENTS[id].kind === 'getaway') {
        const f = venueFrame(this.d, REHEARSAL);
        add(id, f.curb.x, f.curb.z, f.street.h);
      } else {
        const c = new Course(this.d, id, EVENTS[id].waypoints);
        const p = c.pose(EVENTS[id].startAlong, 2);
        add(id, p.x, p.z, p.h);
      }
    }
  }

  start() {
    this.last = performance.now();
    this.enterTitle();
    requestAnimationFrame(this.frame);
    this.online.init().catch((err) => console.warn('online unavailable', err));
  }

  // ------------------------------------------------------------------ online
  openOnline() {
    this.unlockAudio();
    if (this.screens.name !== 'online') {
      this.menuReturn = this.mode === 'title' ? 'title' : this.mode === 'garage' ? 'garage' : 'drive';
      this.mapScreen.root.remove();
    }
    this.mode = 'menu';
    this.paused = true;
    this.audio.setPaused(true);
    this.panelKey = this.online.panelKey();
    this.screens.online(this.online, {
      myCar: CARS[this.carId].name,
      inEvent: !!this.event,
      boardEv: this.boardEv,
      setBoardEv: (ev) => { this.boardEv = ev; this.openOnline(); },
      close: () => this.closeMenu(),
    });
  }

  private beginOnlineRace(ev: EventId, slot: number) {
    if (this.testDrive) this.endTestDrive(false);
    this.removeShowcase();
    this.pursuit.clearAll();
    this.screens.hide();
    this.mapScreen.root.remove();
    this.raceGrace = 4.5;
    this.startEvent(ev, 'online', slot);
    this.toast('Online race', `${EVENTS[ev].name} · grid slot ${slot + 1}`, 2);
  }

  private unlockAudio() {
    const first = !this.audio.ctx;
    this.audio.unlock();
    if (first && this.audio.ctx) {
      this.audio.setEngine(this.player.spec.engine, this.player.spec.cylinders);
      this.applySettings(this.save.data.settings);
    }
  }

  applySettings(s: Settings) {
    this.audio.volumes = { master: s.master, music: s.music, engine: s.engine, effects: s.effects };
    this.audio.applyVolumes();
    this.cam.reducedShake = s.reducedShake;
    this.pursuit.reducedFlashing = s.reducedFlashing;
    if (this.stage.lowEffects !== s.lowEffects || !this.qualitySet) {
      this.stage.time = TIMES[s.timeOfDay];
      this.stage.setQuality(s.lowEffects, this.cam.camera);
      this.scenery.setLowEffects(s.lowEffects);
      this.qualitySet = true;
    } else if (this.stage.time.id !== s.timeOfDay) this.stage.setTime(s.timeOfDay);
    this.scenery.setNight(this.stage.time.lamps > 0);
    this.cam.mode = s.wideCamera ? 1 : 0;
    this.traffic.density = Math.round(22 * s.trafficDensity);
    this.hud.setQuiet(s.quietDrive);
    // Difficulty: one table read by police, heat, events and nitro.
    this.difficulty = difficulty(s.difficulty);
    this.pursuit.copPace = this.difficulty.copPace;
    this.pursuit.copSight = this.difficulty.copSight;
    this.pursuit.radarTolerance = this.difficulty.radarTolerance;
    this.pursuit.heat.searchScale = this.difficulty.searchTime;
    this.pursuit.heat.catchScale = this.difficulty.catchTime;
    this.pursuit.copAccuracy = this.difficulty.copAccuracy;
    this.pursuit.rocketReload = this.difficulty.rocketReload;
  }
  private qualitySet = false;

  private handlers() {
    return {
      drive: () => this.enterDrive(),
      garage: () => this.enterGarage(),
      map: () => this.openMap(),
      resume: () => this.closeMenu(),
      quitToTitle: () => {
        this.endEvent();
        this.pursuit.clearAll();
        this.parkAtGarage();
        this.enterTitle();
      },
      settingsChanged: (s: Settings) => this.applySettings(s),
      startEvent: (id: EventId, mode: 'rival' | 'ghost') => this.startEvent(id, mode),
      cancelBriefing: () => this.closeMenu(),
      retry: () => this.retryEvent(),
      continueAfterResults: () => this.continueAfterResults(),
      selectCar: (id: CarId) => {
        this.save.data.selected = id;
        this.save.persist();
        this.setCar(id);
      },
      unlockCar: (id: CarId) => {
        if (this.save.unlock(id)) this.audio.cue('medal');
      },
      testDrive: (id: CarId) => this.startTestDrive(id),
      paint: (id: CarId, color: string) => {
        this.save.data.paint[id] = color;
        this.save.persist();
        this.showcase?.setPaint(color);
        if (id === this.carId) this.playerModel.setPaint(color);
      },
      previewCar: (id: CarId) => this.previewCar(id),
      leaveGarage: () => this.leaveGarage(),
      click: () => this.audio.cue('click'),
      carCondition: (id: CarId) => {
        if (id === this.carId) return { health: this.player.condition, flats: this.player.flatCount, totaled: this.player.totaled, cost: this.repairCost() };
        const c = this.save.data.condition[id];
        const max = CARS[id].durability;
        const health = c ? c.h / max : 1, flats = c ? c.f.filter(Boolean).length : 0;
        return { health, flats, totaled: false, cost: Math.round(((1 - health) * 700 + flats * 90) / 10) * 10 };
      },
      repairCar: (id: CarId) => {
        if (id === this.carId) {
          const r = this.repairCar();
          this.toast('Repaired', `${r.paid.toLocaleString()} cr`, 1.4);
        } else {
          const c = this.save.data.condition[id];
          if (c) {
            const max = CARS[id].durability;
            this.charge(((1 - c.h / max) * 700 + c.f.filter(Boolean).length * 90));
            delete this.save.data.condition[id];
            this.save.persist();
          }
        }
        this.audio.cue('check');
      },
      online: () => this.openOnline(),
      hostRace: (ev: EventId) => { this.online.hostRace(ev); this.openOnline(); },
      joinRace: (code: string) => { if (!this.online.joinRace(code)) this.toast('Race not found', 'It may have ended', 1.6); this.openOnline(); },
      leaveRace: () => { this.online.leaveRace(); this.openOnline(); },
      startRace: () => this.online.startRace(),
      raceGhost: (uid: string) => this.raceBoardGhost(uid),
      abilityFor: (id: CarId) => this.abilityFor(id),
      weaponFor: (id: CarId) => this.weaponFor(id),
      setWeapon: (car: CarId, id: WeaponId) => { this.setWeaponFor(car, id); this.audio.cue('click'); },
      setAbility: (car: CarId, id: AbilityId) => { this.setAbilityFor(car, id); this.audio.cue('click'); },
      switchMap: (id: MapId) => this.switchMap(id),
    };
  }

  // ------------------------------------------------------------------ player
  paintFor(id: CarId) {
    return this.save.data.paint[id] ?? CARS[id].paints[0];
  }

  spawnPlayer(id: CarId) {
    const prev = this.player;
    if (this.playerModel) {
      this.stage.scene.remove(this.playerModel.root);
      this.playerModel.dispose();
    }
    this.carId = id;
    const v = new Vehicle(CARS[id]);
    v.id = 1;
    v.ground = this.world.ground.height;
    v.ceiling = (x, z, y) => this.world.ground.ceiling(x, z, y);
    if (prev) v.placeAt(prev.x, prev.z, prev.y, prev.h);
    // Damage sticks to each car until it is repaired.
    const saved = this.save.data.condition[id];
    if (saved && !this.testDrive) {
      v.health = Math.max(1, Math.min(v.maxHealth, saved.h));
      saved.f.forEach((f, i) => (v.flats[i] = !!f));
    }
    this.player = v;
    this.playerModel = new CarModel(id, this.paintFor(id), { beamTex: this.beamTex });
    this.stage.scene.add(this.playerModel.root);
    this.equipAbility(this.abilityFor(id));
    this.weapons.equip(this.weaponFor(id));
    this.audio.setEngine(v.spec.engine, v.spec.cylinders);
  }

  /** The ability a car carries: the one picked in the garage, else its signature. */
  weaponFor(id: CarId): WeaponId {
    return this.save.data.weapons[id] ?? DEFAULT_WEAPON[id] ?? 'machineGun';
  }

  setWeaponFor(car: CarId, id: WeaponId) {
    if (id === (DEFAULT_WEAPON[car] ?? 'machineGun')) delete this.save.data.weapons[car];
    else this.save.data.weapons[car] = id;
    this.save.persist();
    if (car === this.carId) this.weapons.equip(id);
  }

  /** What the player's weapons can reach: police units, the helicopter, traffic. */
  private weaponWorld(): WeaponWorld {
    return {
      targets: () => {
        const out: WeaponTarget[] = [];
        for (const u of this.pursuit.units) {
          if (u.state === 'wrecked') continue;
          out.push({ x: u.v.x, y: u.v.y, z: u.v.z, r: 1.7, kind: 'unit', hit: (dmg, ex, fx, fz) => this.pursuit.damageUnit(u, dmg, ex, fx, fz) });
        }
        const h = this.pursuit.heli;
        if (h && !h.leaving) out.push({ x: h.x, y: h.y, z: h.z, r: 4, kind: 'heli', hit: (dmg) => this.pursuit.damageHeli(dmg) });
        for (const c of this.traffic.cars) {
          out.push({
            x: c.body.x, y: c.body.y, z: c.body.z, r: 1.5, kind: 'traffic',
            hit: (dmg, ex, fx, fz) => {
              c.hits += dmg;
              if (c.patrol && c.mode === 'drive') {
                // Shooting a patrol car: it joins the chase on the spot.
                const u = this.pursuit.promote(c);
                this.pursuit.heat.award(HEAT_AWARDS.shotsFired, 'Fired on a patrol car', this.realTime, u.id + 600000);
                this.pursuit.damageUnit(u, dmg, ex, fx, fz);
                return;
              }
              if (!ex && c.hits < 12) return;
              this.traffic.knock(c);
              const dx = c.body.x - fx, dz = c.body.z - fz, d = Math.hypot(dx, dz) || 1;
              c.body.vx += (dx / d) * (ex ? 9 : 3);
              c.body.vz += (dz / d) * (ex ? 9 : 3);
            },
          });
        }
        return out;
      },
      ground: (x, z, y) => this.world.ground.height(x, z, y),
      wall: (x, z, dx, dz, max, y) => this.world.statics.raycast(x, z, dx, dz, max, WEAPON_WALLS, y),
      effects: this.effects,
      scene: this.stage.scene,
      cue: (name) => this.audio.cue(name as never),
      fired: () => this.pursuit.shotsFired(this.player),
    };
  }

  abilityFor(id: CarId): AbilityId {
    return this.save.data.abilities[id] ?? CARS[id].ability;
  }

  /** Swap the player's ability (garage picker); effects of the old one end cleanly. */
  equipAbility(id: AbilityId) {
    if (this.player) {
      this.player.mods = defaultMods();
      this.player.shield = 0;
    }
    this.setTimeWarp(1);
    this.ability = makeAbility(id);
    this.ability.world = this.abilityWorld;
    this.ability.onCue = (c) => this.abilityCue(c);
  }

  // ------------------------------------------------------------------ abilities in the world
  /** Time scale for everything except the player (Time Warp). */
  timeWarp = 1;
  setTimeWarp(scale: number) {
    this.timeWarp = scale;
  }

  private scratchCircles: number[] = [];
  private smokeClock = 0;

  /** What abilities can reach: police, rivals, traffic, trees and the map. */
  private readonly abilityWorld: AbilityWorld = {
    shockwave: (v, radius) => {
      const n = this.pursuit.shockwave(v, radius);
      this.ring(v.x, v.y + 0.6, v.z, radius, 0x7ad7ff);
      this.cam.addTrauma(0.5);
      return n;
    },
    dropHazard: (kind, v) => this.pursuit.dropHazard(kind, v),
    smoke: (v, dt) => {
      this.smokeClock -= dt;
      if (this.smokeClock > 0) return;
      this.smokeClock = 0.06;
      this.pursuit.addSmoke(v);
      const fx = Math.sin(v.h), fz = Math.cos(v.h);
      for (let i = 0; i < 4; i++) {
        const back = v.halfLength + 0.5 + Math.random() * 2;
        this.effects.smokePuff(v.x - fx * back + (Math.random() - 0.5) * 2.5, v.y + 0.6 + Math.random(), v.z - fz * back + (Math.random() - 0.5) * 2.5, 0.15, 1);
      }
    },
    missile: (v) => this.pursuit.fireMissile(v),
    emp: (v, radius, seconds) => {
      const n = this.pursuit.emp(v, radius, seconds);
      this.ring(v.x, v.y + 0.8, v.z, radius, 0x5aa8ff);
      if (n || this.pursuit.heli) this.toast('EMP', `${n} unit${n === 1 ? '' : 's'} stalled · police kit dark ${seconds}s`, 1.6);
      return n;
    },
    grappleTarget: (v) => this.grappleTarget(v),
    blink: (v, dist) => this.blink(v, dist),
    cloak: (seconds) => { this.pursuit.cloak = Math.max(this.pursuit.cloak, seconds); },
    setTimeWarp: (scale) => this.setTimeWarp(scale),
  };

  /** Best grapple anchor ahead: a tree or post at road level, or a car. */
  private grappleTarget(v: Vehicle) {
    const fx = Math.sin(v.h), fz = Math.cos(v.h);
    let best: { x: number; z: number; label: string; follow: (() => { x: number; z: number }) | null } | null = null;
    let bestScore = Infinity;
    const consider = (x: number, z: number, label: string, follow: (() => { x: number; z: number }) | null) => {
      const dx = x - v.x, dz = z - v.z, d = Math.hypot(dx, dz);
      if (d < 8 || d > 70) return;
      const ahead = (dx * fx + dz * fz) / d;
      if (ahead < 0.45) return;
      const score = d * (1.6 - ahead);
      if (score < bestScore) { bestScore = score; best = { x, z, label, follow }; }
    };
    const st = this.world.statics;
    for (const id of st.circlesNear(v.x + fx * 35, v.z + fz * 35, 40, this.scratchCircles)) {
      const c = st.circs[id];
      if ((c.tag !== 'tree' && c.tag !== 'post') || v.y + 1 < c.y0 || v.y > c.y1) continue;
      consider(c.x, c.z, c.tag === 'tree' ? 'tree' : 'pole', null);
    }
    for (const u of this.pursuit.units) consider(u.v.x, u.v.z, 'police car', () => ({ x: u.v.x, z: u.v.z }));
    for (const r of this.racers) consider(r.v.x, r.v.z, 'rival', () => ({ x: r.v.x, z: r.v.z }));
    for (const c of this.traffic.cars) consider(c.body.x, c.body.z, 'car', () => ({ x: c.body.x, z: c.body.z }));
    return best;
  }

  /** Teleport forward onto clear ground; tries shorter hops if the spot is blocked. */
  private blink(v: Vehicle, dist: number) {
    const fx = Math.sin(v.h), fz = Math.cos(v.h);
    for (const k of [1, 0.75, 0.5]) {
      const x = v.x + fx * dist * k, z = v.z + fz * dist * k;
      if (this.world.surfaceAt(x, z) === SURF_WATER) continue;
      const b = this.d.bounds;
      if (x < b.minX || x > b.maxX || z < b.minZ || z > b.maxZ) continue;
      const probe: PhysBody = { id: -1, x, z, h: v.h, vx: 0, vz: 0, w: 0, y: this.world.ground.height(x, z, v.y + 1.5), mass: v.mass, inertia: v.inertia, halfLength: v.halfLength, halfWidth: v.halfWidth, solid: true };
      const hits: Contact[] = [];
      collideStatic(this.world.statics, probe, hits);
      if (hits.some((c) => c.tag === 'building' || c.tag === 'water' || c.tag === 'boundary')) continue;
      this.effects.sparks(v.x, v.y + 0.8, v.z, 30);
      v.x = x;
      v.z = z;
      v.y = probe.y;
      if (v.airborne) v.y = Math.max(v.y, v.py);
      v.savePrev();
      this.effects.sparks(x, v.y + 0.8, z, 30);
      this.ring(x, v.y + 0.6, z, 9, 0xc08bff);
      this.cam.kickFov(8);
      return true;
    }
    return false;
  }

  /** Sound and words for ability cues. */
  private abilityCue(c: string) {
    this.audio.cue(c);
    const info = ABILITIES[c as Exclude<AbilityId, 'none'>];
    if (c === 'superstar') this.toast('Superstar', 'Invincible · ram anything', 1.4);
    else if (c === 'phantom') this.toast('Phantom', 'Through traffic · police lose you', 1.4);
    else if (c === 'timeWarp') this.toast('Time Warp', 'Everything else slows down', 1.2);
    else if (c === 'grapple' && this.ability instanceof Grapple) this.toast('Hooked', `${this.ability.anchor?.label ?? ''} · E lets go`, 0.9);
    else if (c === 'ability-miss') this.toast(this.ability.status().name, this.ability.id === 'grapple' ? 'Nothing to hook ahead' : this.ability.id === 'homingMissile' ? 'No police or rival ahead' : this.ability.id === 'blink' ? 'No clear ground ahead' : 'Nothing to do', 1.1);
    else if (info && (info.tag === 'Attack' || info.tag === 'Escape') && c !== 'emp') this.toast(info.name, '', 0.8);
  }

  /** Expanding ring (shockwave, EMP, blink). */
  private rings: { mesh: THREE.Mesh; t: number; r: number }[] = [];
  private ring(x: number, y: number, z: number, radius: number, color: number) {
    const mesh = new THREE.Mesh(RING_GEO, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
    mesh.position.set(x, y, z);
    this.stage.scene.add(mesh);
    this.rings.push({ mesh, t: 0, r: radius });
  }

  // Player ability visuals (built on first use).
  private bubble: THREE.Mesh | null = null;
  private wings: THREE.Group | null = null;
  private rope: THREE.Mesh | null = null;
  private phaseMats = new Map<THREE.Mesh, THREE.Material | THREE.Material[]>();
  private phaseModel: CarModel | null = null;

  private renderAbilityFx(realDt: number, t: number) {
    const p = this.player;
    const model = this.playerModel;
    // Superstar: the paint cycles through the rainbow.
    if (p.mods.invincible) {
      model.paint.emissive.setHSL((t * 1.6) % 1, 1, 0.5);
      model.paint.emissiveIntensity = 0.9;
    } else if (model.paint.emissiveIntensity > 0) {
      model.paint.emissiveIntensity = 0;
      model.paint.emissive.setRGB(0, 0, 0);
    }
    // Phantom: a see-through ghost of the car.
    const phase = !!p.mods.phase;
    if (phase && this.phaseModel !== model) {
      this.restorePhase();
      this.phaseModel = model;
      model.root.traverse((o) => {
        const m = o as THREE.Mesh;
        if (!m.isMesh) return;
        this.phaseMats.set(m, m.material);
        m.material = PHANTOM_MAT;
      });
    } else if (!phase && this.phaseModel) this.restorePhase();
    // Bubble shield.
    if (p.shield > 0) {
      if (!this.bubble) {
        this.bubble = new THREE.Mesh(new THREE.SphereGeometry(1, 24, 16), new THREE.MeshBasicMaterial({ color: 0x8fd3ff, transparent: true, opacity: 0.18, blending: THREE.AdditiveBlending, depthWrite: false }));
        this.stage.scene.add(this.bubble);
      }
      const r = p.halfLength + 0.9;
      this.bubble.visible = true;
      this.bubble.position.set(model.root.position.x, model.root.position.y + 0.9, model.root.position.z);
      this.bubble.scale.set(r * 0.75, r * 0.55, r);
      this.bubble.rotation.y = model.root.rotation.y;
      (this.bubble.material as THREE.MeshBasicMaterial).opacity = 0.1 + 0.05 * p.shield + 0.04 * Math.sin(t * 9);
    } else if (this.bubble) this.bubble.visible = false;
    // Glider wings while the glider is out.
    const gliding = (p.mods.gravityMul ?? 1) < 1;
    if (gliding && !this.wings) {
      this.wings = new THREE.Group();
      const mat = new THREE.MeshStandardMaterial({ color: 0xf2ede4, roughness: 0.6, side: THREE.DoubleSide });
      const wing = new THREE.Mesh(new THREE.BoxGeometry(7.5, 0.06, 1.3), mat);
      const strut = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.7, 0.08), new THREE.MeshStandardMaterial({ color: 0x222222 }));
      strut.position.y = -0.35;
      this.wings.add(wing, strut);
    }
    if (this.wings) {
      if (gliding && this.wings.parent !== model.body) model.body.add(this.wings);
      this.wings.visible = gliding;
      const top = Math.max(...model.sil.body.map((q) => q[1]), ...(model.sil.roof ?? model.sil.cabin).map((q) => q[1]));
      this.wings.position.set(0, top + 0.75, -0.2);
    }
    // Grapple line.
    const anchor = this.ability instanceof Grapple && this.ability.active > 0 ? this.ability.anchor : null;
    if (anchor) {
      if (!this.rope) {
        // A cable: a thin cylinder from the roof to the anchor, with a hook glint.
        this.rope = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 1, 6).translate(0, 0.5, 0).rotateX(Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0xe8d8b0, emissive: 0x806a40, emissiveIntensity: 0.6, roughness: 0.4 }));
        this.rope.frustumCulled = false;
        this.stage.scene.add(this.rope);
      }
      const r0 = model.root.position;
      const from = new THREE.Vector3(r0.x, r0.y + 1.1, r0.z);
      const to = new THREE.Vector3(anchor.x, this.world.ground.height(anchor.x, anchor.z, r0.y) + 2.2, anchor.z);
      this.rope.position.copy(from);
      this.rope.lookAt(to);
      this.rope.scale.set(1, 1, from.distanceTo(to));
      this.rope.visible = true;
    } else if (this.rope) this.rope.visible = false;
    // Rings expand and fade.
    for (const r of [...this.rings]) {
      r.t += realDt;
      const k = Math.min(1, r.t / 0.5);
      r.mesh.scale.setScalar(Math.max(0.5, r.r * k));
      (r.mesh.material as THREE.MeshBasicMaterial).opacity = 0.8 * (1 - k);
      if (k >= 1) {
        this.stage.scene.remove(r.mesh);
        (r.mesh.material as THREE.Material).dispose();
        this.rings.splice(this.rings.indexOf(r), 1);
      }
    }
  }

  private restorePhase() {
    for (const [m, mat] of this.phaseMats) m.material = mat;
    this.phaseMats.clear();
    this.phaseModel = null;
  }

  setAbilityFor(car: CarId, id: AbilityId) {
    if (id === CARS[car].ability) delete this.save.data.abilities[car];
    else this.save.data.abilities[car] = id;
    this.save.persist();
    if (car === this.carId) this.equipAbility(id);
  }

  /** Load another map: remember the choice, save, and reload the page on it. */
  switchMap(id: MapId) {
    if (!MAPS[id] || id === MAP.id) return;
    this.saveCondition(true);
    this.save.persist();
    const stored = rememberMap(id);
    this.screens.notice('Loading', MAPS[id].name, 'Switching maps…', []);
    // An explicit ?map= wins over storage, so it must follow the choice too.
    const url = new URL(location.href);
    if (!stored || url.searchParams.has('map')) {
      url.searchParams.set('map', id);
      try { location.replace(url.href); return; } catch { /* fall through */ }
    }
    location.reload();
  }

  setCar(id: CarId) {
    if (id === this.carId) return;
    this.spawnPlayer(id);
  }

  parkAtGarage() {
    this.weapons.reset();
    const g = this.venues.garage;
    this.placePlayer(g.curb.x, g.curb.z, g.curb.h, 0);
    this.nitro = 0.7;
    this.ability.reset();
  }

  /** EventHost: call off every unit and clear the heat. */
  endPursuit() {
    this.pursuit.clearAll();
  }

  /** Height of the road surface nearest a point (deck on bridges); with `y`, the road at about that height. */
  roadY(x: number, z: number, y?: number) {
    const hit = (y !== undefined ? this.d.nearestEdge(x, z, 30, undefined, y) : null) ?? this.d.nearestEdge(x, z, 30);
    return hit ? this.d.heightOnEdge(hit.edge, hit.s) : this.d.terrain.height(x, z);
  }

  placePlayer(x: number, z: number, h: number, speed = 0, y?: number) {
    this.player.placeAt(x, z, this.roadY(x, z, y), h);
    this.player.vx = Math.sin(h) * speed;
    this.player.vz = Math.cos(h) * speed;
    this.forest.prime(x, z);
    this.player.mods = defaultMods();
    this.player.shield = 0;
    if (this.ability instanceof Grapple) this.ability.anchor = null;
    this.lastValid = [{ x, z, h }];
    this.cam.snap(this.camTarget(1));
    this.acc = 0;
  }

  // ------------------------------------------------------------------ modes
  private enterTitle() {
    this.mode = 'title';
    this.paused = false;
    this.screens.title();
    this.hud.root.classList.add('hidden');
    this.venues.garage.doorTarget = 1;
  }

  enterDrive() {
    this.unlockAudio();
    this.screens.hide();
    this.removeShowcase();
    this.hud.root.classList.remove('hidden');
    if (this.mode === 'title' || this.mode === 'garage') {
      this.cam.snap(this.camTarget(1));
    }
    // The garage's own block is home; the first new street gets the fade-in card.
    if (!this.introduced) {
      this.introduced = true;
      this.hud.knowStreet(this.d.streetNameAt(this.player.x, this.player.z, this.player.h, this.player.y));
    }
    this.mode = 'drive';
    this.paused = false;
    this.input.clear();
  }
  private introduced = false;

  private autoPause() {
    this.input.clear();
    if (this.mode === 'drive' && !this.paused) this.openPause();
  }

  openPause() {
    this.paused = true;
    this.mode = 'menu';
    this.menuReturn = 'drive';
    this.audio.setPaused(true);
    this.screens.pause(this.pursuit.active, this.save.data.settings.quietDrive, !!this.event);
  }

  closeMenu() {
    this.screens.hide();
    this.mapScreen.root.remove();
    this.audio.setPaused(false);
    if (this.menuReturn === 'title') this.enterTitle();
    else if (this.menuReturn === 'garage') this.enterGarage();
    else {
      this.mode = 'drive';
      this.paused = false;
    }
    this.input.clear();
  }

  openMap() {
    this.unlockAudio();
    this.menuReturn = this.mode === 'title' ? 'title' : this.mode === 'garage' ? 'garage' : 'drive';
    this.mode = 'menu';
    this.paused = true;
    this.screens.hide();
    this.audio.setPaused(true);
    const ms = this.mapScreen;
    ms.points = this.mapPoints();
    ms.player = { x: this.player.x, z: this.player.z, h: this.player.h };
    ms.police = this.pursuit.units.map((u) => ({ x: u.v.x, z: u.v.z }));
    ms.route = this.gps?.route ?? null;
    ms.onSelect = (p, x, z) => {
      const tx = p ? p.x : x, tz = p ? p.z : z;
      const hit = this.d.nearestEdge(tx, tz, 60);
      if (!hit && !p) { this.gps = null; ms.route = null; return; }
      this.gps = { x: tx, z: tz, route: this.gpsRoute(tx, tz) };
      ms.route = this.gps.route;
    };
    ms.onStart = (p) => {
      const id = p.id.replace('event:', '') as EventId;
      const zone = this.zones.find((zz) => zz.id === id);
      if (!zone) return;
      ms.root.remove();
      this.placePlayer(zone.x, zone.z, zone.h, 0);
      this.mode = 'drive';
      this.openBriefing(id);
    };
    ms.onClose = () => this.closeMenu();
    this.uiRoot.append(ms.root);
    ms.open();
  }

  private mapPoints(): MapPoint[] {
    const idle = !this.event && !this.pursuit.active && !this.testDrive;
    const pts: MapPoint[] = this.zones.map((z) => ({
      id: `event:${z.id}`, name: EVENTS[z.id].name, x: z.x, z: z.z, kind: 'event', fictional: true,
      detail: EVENTS[z.id].kind === 'lastset' || EVENTS[z.id].kind === 'getaway' ? `Starts at ${REHEARSAL.name} (fictional)` : MAP.city ? 'Event start' : 'Event start on public streets', canStart: idle,
    }));
    const g = this.venues.garage;
    pts.push({ id: 'garage', name: GARAGE.name, x: g.curb.x, z: g.curb.z, kind: 'garage', fictional: true, detail: 'Your garage' });
    const v = venueFrame(this.d, VENUE);
    pts.push({ id: 'venue', name: VENUE.name, x: v.curb.x, z: v.curb.z, kind: 'venue', fictional: true, detail: MAP.city ? 'Where Breakout ends (fictional)' : MAP.credits ? 'Fictional diner' : 'Fictional music venue' });
    const keep = MAP.mapLandmarks;
    const b = this.d.bounds;
    for (const l of this.d.data.landmarks) {
      if (!keep.includes(l.name) || l.x < b.minX || l.x > b.maxX || l.z < b.minZ || l.z > b.maxZ) continue;
      pts.push({ id: `lm:${l.name}`, name: l.name, x: l.x, z: l.z, kind: 'landmark', fictional: !!MAP.credits, detail: l.addr ?? 'OpenStreetMap' });
    }
    return pts;
  }

  // ------------------------------------------------------------------ garage
  enterGarage() {
    if (this.pursuit.active) return;
    this.unlockAudio();
    this.endEvent();
    if (this.testDrive) this.endTestDrive(false);
    this.mode = 'garage';
    this.paused = false;
    this.mapScreen.root.remove();
    this.hud.root.classList.add('hidden');
    this.venues.garage.doorTarget = 1;
    this.screens.garageSel = this.carId;
    this.previewCar(this.carId);
    this.screens.garage(this.figures, false);
    this.audio.setPaused(false);
  }

  private previewCar(id: CarId) {
    this.removeShowcase();
    this.showcase = new CarModel(id, this.paintFor(id));
    this.stage.scene.add(this.showcase.root);
    this.playerModel.root.visible = false;
  }

  private removeShowcase() {
    if (this.showcase) {
      this.stage.scene.remove(this.showcase.root);
      this.showcase.dispose();
      this.showcase = null;
    }
    this.playerModel.root.visible = true;
  }

  private leaveGarage() {
    const sel = this.save.data.selected;
    this.setCar(sel);
    this.parkAtGarage();
    this.enterDrive();
  }

  private startTestDrive(id: CarId) {
    this.testDrive = { car: id, left: 120 };
    this.spawnPlayer(id);
    this.parkAtGarage();
    this.enterDrive();
    this.toast('Test drive', `${CARS[id].name} · 2:00 · Esc ends early`, 2.4);
  }

  private endTestDrive(returnToGarage = true) {
    if (!this.testDrive) return;
    this.testDrive = null;
    this.spawnPlayer(this.save.data.selected);
    this.parkAtGarage();
    if (returnToGarage) this.enterGarage();
  }

  // ------------------------------------------------------------------ events
  private openBriefing(id: EventId) {
    this.paused = true;
    this.mode = 'menu';
    this.menuReturn = 'drive';
    this.screens.briefing(id, this.hasGhost(id), CARS[this.carId].name);
  }

  /** A saved ghost exists for this circuit and matches its current course. */
  hasGhost(id: EventId) {
    if (EVENTS[id]?.kind !== 'circuit') return false;
    const ghost = this.save.data.ghosts[id];
    return !!ghost && ghost.version === new Course(this.d, id, EVENTS[id].waypoints).version;
  }

  private async raceBoardGhost(uid: string, ev: EventId = this.boardEv) {
    if (EVENTS[ev]?.kind !== 'circuit') return;
    const g = await this.online.loadGhost(uid, ev);
    const course = new Course(this.d, ev, EVENTS[ev].waypoints);
    if (!g || g.version !== course.version) { this.toast('Ghost unavailable', 'It was set on an older version of the course', 2); return; }
    this.startEvent(ev, 'ghost');
    this.showGhost(g);
    this.toast('Ghost race', `${escapeHtml(this.online.nameOf(uid))} · ${fmtTime(g.time)}`, 2);
  }

  startEvent(id: EventId, mode: 'rival' | 'ghost' | 'online' = 'rival', slot = 0) {
    this.endEvent();
    this.screens.hide();
    this.mapScreen.root.remove();
    this.audio.setPaused(false);
    this.lastEvent = { id, mode };
    this.caughtPending = false;
    let run: EventRun;
    switch (EVENTS[id].kind) {
      case 'warmup': run = new WarmUpRun(this, id); break;
      case 'circuit': run = new CircuitRun(this, mode, this.save.data.bests[id]?.splits ?? null, id); break;
      case 'lastset': run = new LastSetRun(this, id); break;
      case 'air': run = new AirRun(this, id); break;
      case 'escape': run = new EscapeRun(this, id); break;
      case 'survive': run = new SurviveRun(this, id); break;
      case 'getaway': run = new GetawayRun(this, id); break;
      default: run = new EncoreRun(this, id); break;
    }
    this.event = run;
    run.gridSlot = slot;
    run.begin();
    if (run instanceof CircuitRun && mode === 'ghost') this.showGhost(this.save.ghostFor(id, run.version));
    this.ability.reset();
    this.nitro = 0.7;
    this.mode = 'drive';
    this.paused = false;
    this.input.clear();
    this.hud.root.classList.remove('hidden');
  }

  private endEvent() {
    if (!this.event) return;
    if (this.lastEvent?.mode === 'online' && this.event.state !== 'done') this.online.finishRace(null);
    this.event.abort();
    this.event.dispose();
    this.event = null;
    this.hud.setEvent(null);
    this.frozen = false;
  }

  finishEvent(run: EventRun, r: EventResult) {
    const id = run.def.id;
    const counted = r.outcome !== 'fail' && r.outcome !== 'invalid';
    // Harder difficulty pays more (medals are unchanged).
    if (counted && this.difficulty.payout !== 1 && r.payout > 0) {
      const before = r.payout;
      r.payout = Math.round(r.payout * this.difficulty.payout);
      r.lines.push([`Difficulty · ${this.difficulty.label}`, `×${this.difficulty.payout} (${before.toLocaleString()} → ${r.payout.toLocaleString()} cr)`]);
    }
    const award = counted ? this.save.award(run.attemptId, id, r.payout, r.medal) : { paid: 0, medalBonus: 0, newMedal: false, duplicate: false };
    const prevBest = this.save.data.bests[id];
    const fmt = (v: number) => (run.def.lowerIsBetter ? fmtTime(v) : v.toLocaleString());
    let newBest = false;
    if (counted && r.score !== null) {
      const res = this.save.submitBest(id, { score: r.score, time: r.time, splits: r.splits, car: this.carId, date: new Date().toISOString() }, !run.def.lowerIsBetter);
      newBest = res.better && !!res.previous;
      if (r.ghost && run instanceof CircuitRun) this.save.submitGhost(r.ghost);
      // Shared leaderboard: only beats this player's own posted best.
      const ghost = r.ghost && run instanceof CircuitRun && r.ghost.version === run.version ? r.ghost : null;
      this.online.submitBest(id, { score: r.score, time: r.time, car: this.carId, diff: this.difficulty.level }, ghost).then((posted) => {
        if (posted) this.toast('Posted to the leaderboard', run.def.name, 1.6);
      });
    }
    if (this.lastEvent?.mode === 'online') this.online.finishRace(counted ? r.score : null);
    if (award.paid > 0) this.audio.cue(r.medal ? 'medal' : 'check');
    this.paused = true;
    this.mode = 'menu';
    this.menuReturn = 'drive';
    this.audio.setPaused(true);
    this.screens.results(id, r, award, prevBest ? fmt(prevBest.score) : '—', newBest, this.lastEvent?.mode === 'online' ? this.raceResultsEl() : undefined);
  }

  /** Live online standings on the results card (refreshes as others finish). */
  private raceResultsEl() {
    const box = el('div');
    const draw = () => {
      if (!box.isConnected && box.dataset.drawn) return false;
      box.dataset.drawn = '1';
      const race = this.online.race;
      if (!race) { box.replaceChildren(); return true; }
      const lower = EVENTS[race.ev].lowerIsBetter;
      box.replaceChildren(el('h3', '', `Race ${race.code}`));
      const grid = el('div', 'result-grid');
      this.online.standings().forEach((row, i) => {
        const n = el('span');
        n.textContent = `${i + 1}. ${row.name}`;
        const v = row.st === 'done' ? (row.fin === null ? 'did not finish' : lower ? fmtTime(row.fin) : row.fin.toLocaleString()) : 'still racing';
        grid.append(n, el('span', '', v));
      });
      box.append(grid);
      return true;
    };
    draw();
    const timer = window.setInterval(() => { if (!draw()) window.clearInterval(timer); }, 700);
    return box;
  }

  private retryEvent() {
    if (!this.lastEvent) return this.closeMenu();
    if (this.lastEvent.mode === 'online') {
      // Online races restart from the host.
      if (this.online.race?.host) { this.online.startRace(); return; }
      this.toast('Waiting for the host', 'They start the next race', 1.6);
      return;
    }
    if (this.pursuit.active || this.caughtPending) this.pursuit.clearAll();
    this.caughtPending = false;
    this.startEvent(this.lastEvent.id, this.lastEvent.mode);
  }

  private continueAfterResults() {
    this.endEvent();
    if (this.caughtPending) {
      this.caughtPending = false;
      this.parkAtGarage();
    }
    this.closeMenu();
  }

  // ------------------------------------------------------------------ host API
  addRacer(id: CarId, paint: string, path: number[], skill: Skill, x: number, z: number, h: number, loop = true): Racer {
    const v = new Vehicle(CARS[id]);
    v.id = 900 + this.racers.length;
    v.ground = this.world.ground.height;
    v.ceiling = (x, z, y) => this.world.ground.ceiling(x, z, y);
    v.placeAt(x, z, this.roadY(x, z), h);
    const ai = new AIDriver(skill);
    ai.setPath(path);
    ai.loop = loop;
    ai.s = ai.path!.project(x, z).s;
    const model = new CarModel(id, paint, { beamTex: this.beamTex });
    this.stage.scene.add(model.root);
    const r: AIRacer = { v, ai, model, progress: 0, stall: 0, spin: 0 };
    this.racers.push(r);
    return r;
  }

  removeRacer(r: Racer) {
    const i = this.racers.indexOf(r as AIRacer);
    if (i < 0) return;
    const ar = this.racers[i];
    this.stage.scene.remove(ar.model.root);
    ar.model.dispose();
    this.racers.splice(i, 1);
  }

  showGhost(g: Ghost | null) {
    if (this.ghost) {
      this.stage.scene.remove(this.ghost.model.root);
      this.ghost = null;
    }
    if (!g) return;
    const model = new CarModel(g.car, '#8fd3ff', { ghost: true });
    this.stage.scene.add(model.root);
    this.ghost = { data: g, model };
  }

  ghostTime(t: number) {
    if (!this.ghost) return;
    const g = this.ghost.data;
    const n = g.samples.length / 3;
    const f = Math.min(n - 1.001, t / g.dt);
    const i = Math.floor(f), k = f - i;
    const s = g.samples;
    const x = lerp(s[i * 3], s[i * 3 + 3] ?? s[i * 3], k);
    const z = lerp(s[i * 3 + 1], s[i * 3 + 4] ?? s[i * 3 + 1], k);
    const h = lerpAngle(s[i * 3 + 2], s[i * 3 + 5] ?? s[i * 3 + 2], k);
    this.ghostY = this.world.ground.height(x, z, this.ghostY + 1);
    this.ghost.model.pose(x, this.ghostY, z, h, 0, 0, 0, t * 20);
    this.ghost.model.root.visible = t / g.dt < n;
  }

  private ghostY = -1e9;

  groundAt(x: number, z: number) {
    return this.roadY(x, z);
  }

  gpsRoute(x: number, z: number) {
    const p = this.player;
    return this.d.pathBetween(p.x, p.z, x, z, true, p.speed > 2 ? Math.atan2(p.vx, p.vz) : p.h, p.y);
  }

  confirmPressed() {
    const v = this.confirmLatch;
    this.confirmLatch = false;
    return v;
  }

  cue(name: string) {
    this.audio.cue(name);
  }

  toast(big: string, small = '', seconds = 2.2) {
    this.hud.toast(big, small, seconds);
  }

  get scene() {
    return this.stage.scene;
  }

  get statics(): StaticWorld {
    return this.world.statics;
  }

  get heat() {
    return this.pursuit.heat;
  }

  // ------------------------------------------------------------------ loop
  /** Debug/playtest: drive the player with the same AI driver the rival uses. */
  autopilot: AIDriver | null = null;
  setAutopilot(points: number[] | null, skill: Partial<Skill> = {}) {
    if (!points) { this.autopilot = null; return; }
    const ai = new AIDriver({ latBudget: 7.5, brakeDecel: 7, brakeOptimism: 1, maxSpeed: 30, lookahead: 6, ...skill });
    ai.setPath(points);
    ai.s = ai.path!.project(this.player.x, this.player.z, 0, 250).s;
    this.autopilot = ai;
  }

  private readDrive(): DriveInput {
    const i = this.input;
    if (this.frozen) return { throttle: 0, brake: 1, steer: 0, drift: false, nitro: false };
    if (this.autopilot) return this.autopilot.drive(this.player, STEP);
    const steer = (i.down('right') ? 1 : 0) - (i.down('left') ? 1 : 0);
    return {
      throttle: i.down('throttle') ? 1 : 0,
      brake: i.down('brake') ? 1 : 0,
      steer,
      drift: i.down('drift'),
      nitro: i.down('nitro') && this.nitro > 0.02,
    };
  }

  private errors = 0;
  private cpuMs: number[] = [];
  private frame = (now: number) => {
    requestAnimationFrame(this.frame);
    try {
      const t0 = performance.now();
      this.frameBody(now);
      this.cpuMs.push(performance.now() - t0);
      if (this.cpuMs.length > 600) this.cpuMs.shift();
    } catch (err) {
      // Never let one subsystem freeze the loop; report the first few failures.
      if (this.errors++ < 5) console.error('frame error', err);
      this.input.endFrame();
    }
  };

  private frameBody(now: number) {
    const realDt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    this.trackFps(realDt);
    this.handleMenuKeys();
    if (this.mode === 'drive' && !this.paused) {
      this.realTime += realDt;
      this.frameLogic(realDt);
      const scale = this.ability.timeScale();
      this.audio.slowmo = scale < 1;
      this.acc += realDt * scale;
      const drive = this.readDrive();
      let steps = 0;
      while (this.acc >= STEP && steps < 24) {
        this.fixedStep(STEP, drive, STEP / scale);
        this.acc -= STEP;
        steps++;
      }
      if (steps >= 24) this.acc = 0;
    }
    this.online.update(realDt, this.event && this.event.state === 'running' ? this.event.raceProgress() : null);
    this.render(this.mode === 'drive' && !this.paused ? this.acc / STEP : 1, realDt);
    this.input.endFrame();
  }

  private trackFps(dt: number) {
    const f = this.fps;
    f.t += dt;
    f.n++;
    f.frames.push(dt);
    if (f.frames.length > 600) f.frames.shift();
    if (f.t >= 0.5) {
      f.value = f.n / f.t;
      f.t = 0;
      f.n = 0;
      this.adaptResolution(f.value);
      this.hud.setFps(this.save.data.settings.showFps ? `${f.value.toFixed(0)} fps` : null);
    }
  }

  /** Weaker GPUs: after ~2 s of sustained low frame rate while driving, step the
   *  render scale down (1.5 -> 1.2 -> 1 -> 0.85) instead of stuttering. */
  private slowWindows = 0;
  private adaptResolution(fps: number) {
    if (this.mode !== 'drive' || this.paused || this.realTime < 4) { this.slowWindows = 0; return; }
    // A steady 30 with even frame times is a browser/OS cap (battery saver), not a struggling GPU.
    const last = this.fps.frames.slice(-30);
    const mean = last.reduce((a, b) => a + b, 0) / Math.max(1, last.length);
    const sd = Math.sqrt(last.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, last.length));
    const capped = fps > 27 && fps < 33 && sd < 0.003;
    this.slowWindows = fps < 45 && !capped ? this.slowWindows + 1 : 0;
    if (this.slowWindows < 4) return;
    this.slowWindows = 0;
    const cap = this.stage.pixelCap;
    const next = cap > 1.25 ? 1.2 : cap > 1.05 ? 1 : cap > 0.9 ? 0.85 : cap;
    if (next === cap) return;
    this.stage.setPixelCap(next, this.cam.camera);
    if (next <= 1) this.toast('Lower render scale', 'Keeping the frame rate up · Settings › Low-effects goes further', 2);
  }

  private handleMenuKeys() {
    const i = this.input;
    const sname = this.screens.name;
    if (this.mode === 'title') {
      if (i.hit('confirm')) this.enterDrive();
      if (i.hit('map')) this.openMap();
      if (i.hit('online')) this.openOnline();
      return;
    }
    if (this.mode === 'garage') {
      if (i.hit('pause') || i.hit('confirm')) this.leaveGarage();
      if (i.down('left')) this.garageAngle -= 0.03;
      if (i.down('right')) this.garageAngle += 0.03;
      return;
    }
    if (this.mode === 'menu') {
      if (this.mapScreen.root.isConnected) {
        if (i.hit('map') || i.hit('pause')) this.closeMenu();
        else if (i.hit('confirm') && this.mapScreen.selected?.canStart) this.mapScreen.onStart?.(this.mapScreen.selected);
        return;
      }
      if (sname === 'online') {
        if (i.hit('pause') || i.hit('online')) this.closeMenu();
        return;
      }
      if (sname === 'briefing') {
        const id = this.screens.briefingId!;
        if (i.hit('confirm')) this.startEvent(id, this.screens.briefingMode);
        else if (i.hit('alt')) this.screens.toggleMode(this.hasGhost(id), CARS[this.carId].name); else if (i.hit('pause')) this.closeMenu();
      } else if (sname === 'results') {
        if (i.hit('confirm')) this.retryEvent();
        else if (i.hit('pause')) this.continueAfterResults();
      } else if (sname === 'notice') {
        if (i.hit('confirm')) (this.screens.root.querySelector('.btn.primary') as HTMLButtonElement | null)?.click();
        else if (i.hit('pause')) {
          const btns = this.screens.root.querySelectorAll<HTMLButtonElement>('.btn');
          (btns[1] ?? btns[0])?.click();
        }
      } else if (sname === 'pause') {
        if (i.hit('pause')) this.closeMenu();
        if (i.hit('map')) this.openMap();
      } else if (i.hit('pause')) this.closeMenu();
      return;
    }
    // Driving.
    if (i.hit('pause')) {
      if (this.testDrive) this.endTestDrive(true);
      else this.openPause();
      return;
    }
    if (i.hit('map')) this.openMap();
    if (i.hit('online')) this.openOnline();
  }

  /** Per-frame logic on real time: abilities, nitro, events, heat, prompts, HUD. */
  private frameLogic(realDt: number) {
    const i = this.input;
    const p = this.player;
    if (i.hit('camera')) this.cam.mode = this.cam.mode === 0 ? 1 : 0;
    if (i.hit('time')) this.cycleTime();
    this.cam.rear = i.down('rear');
    const steer = (i.down('right') ? 1 : 0) - (i.down('left') ? 1 : 0);
    const running = !this.frozen;
    if (i.hit('ability') && running) this.ability.trigger(p);
    if (i.hit('recover') || (this.player.totaled && i.hit('confirm'))) {
      if (this.player.totaled) this.resetTotaled();
      else this.recover();
    }
    const confirm = i.hit('confirm');
    if (confirm) this.confirmLatch = true;
    this.ability.update(realDt, p, { steer, brake: i.down('brake') ? 1 : 0 });
    // Weapons: free roam and chase events; races hold fire.
    const ev = this.event && this.event.state !== 'done' ? this.event.def.kind : null;
    this.weapons.holdFire = !running || this.mode !== 'drive' || (ev !== null && !CHASE_KINDS.has(ev));
    this.weapons.update(realDt, p, i.down('fire'), i.hit('fire'));
    if (p.nitroActive) {
      this.nitro = Math.max(0, this.nitro - realDt * 0.34);
      if (!this.nitroCueLatch) { this.audio.cue('nitro'); this.cam.kickFov(6); this.nitroCueLatch = true; }
    } else {
      this.nitroCueLatch = false;
      // Nitro refills fastest while drifting (more per spark tier) and in the air.
      const drift = p.drifting && p.speed > 8 ? 0.08 + 0.035 * p.driftTier : 0;
      const corner = !p.drifting && Math.abs(p.latAccel) > 4.5 && p.speed > 8 ? 0.04 : 0;
      const air = p.airborne && p.airTime > 0.2 ? 0.1 : 0;
      this.nitro = Math.min(1, this.nitro + realDt * (drift + corner + air + 0.004) * this.difficulty.nitroRefill);
    }
    // Test drive timer.
    if (this.testDrive) {
      this.testDrive.left -= realDt;
      if (this.testDrive.left <= 0) {
        this.toast('Test drive over', 'Back to the garage', 1.5);
        this.endTestDrive(true);
        return;
      }
    }
    // Event clock and rules.
    if (this.event) {
      this.event.frame(realDt);
      // A confirm press is only meaningful in the frame it happened.
      this.confirmLatch = false;
      if (this.event && this.event.state !== 'done') this.hud.setEvent(this.event.hud());
    } else this.hud.setEvent(this.testDrive ? `<div class="title">Test drive · ${CARS[this.testDrive.car].name}</div><div class="main">${fmtTime(this.testDrive.left)}</div><div class="rows"><span>Esc returns to the garage</span></div>` : null);
    if (this.confirmLatch && !this.event) this.confirmLatch = false;

    // Start zones.
    let prompt: string | null = null;
    if (!this.event && !this.pursuit.active && !this.testDrive) {
      for (const z of this.zones) {
        if (Math.hypot(z.x - p.x, z.z - p.z) < 12) {
          prompt = p.speed < 9 ? `<kbd>Enter</kbd> ${EVENTS[z.id].name}` : `Slow down to start ${EVENTS[z.id].name}`;
          if (confirm && p.speed < 9) this.openBriefing(z.id);
          break;
        }
      }
    } else if (this.testDrive && this.zones.some((z) => Math.hypot(z.x - p.x, z.z - p.z) < 12)) {
      prompt = 'Events need a car you own — test drives are free roam only';
    }
    this.hud.prompt(prompt);

    // Pursuit.
    const quiet = this.save.data.settings.quietDrive || !!this.testDrive;
    const cam = this.cam.camera;
    this.frustum.setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse));
    this.pursuit.radarWarnOnly = !!this.event && this.event.state !== 'done' && !CHASE_KINDS.has(this.event.def.kind);
    // Ironport: any officer who sees you starts a chase (not in events, test drives or by the garage door).
    const g = this.venues.garage;
    this.pursuit.spotting = !!MAP.cops?.wantedOnSight && !this.event && !this.testDrive && this.mode === 'drive' && Math.hypot(p.x - g.curb.x, p.z - g.curb.z) > 160;
    this.pursuit.others = this.racers;
    this.pursuit.update(realDt * this.timeWarp, p, cam, this.frustum, quiet);
    // A fresh id per pursuit, however the heat started (crashes raise it in the
    // physics step, after this runs), so each escape banks exactly once.
    if (this.pursuit.active && !this.pursuitLive) {
      this.pursuitLive = true;
      this.pursuitId = `pursuit-${Date.now().toString(36)}-${(this.pursuitSeq++).toString(36)}`;
    }
    this.handleHeatEvents();
    for (const m of this.pursuit.messages.splice(0)) this.toast(m.big, m.small, 2.2);
    const radar = this.pursuit.radar;
    if (radar && radar.t !== this.lastRadar) {
      this.lastRadar = radar.t;
      if (this.realTime - this.radarCueAt > 1.2) { this.audio.cue('radar'); this.radarCueAt = this.realTime; }
      this.radarShown = 2.2;
    }
    this.radarShown = Math.max(0, this.radarShown - realDt);
    // Weapons lock: the loudest warning there is, with a beep.
    const lock = this.pursuit.locked;
    if (lock) {
      this.lockBeep -= realDt;
      if (this.lockBeep <= 0) { this.audio.cue('lockbeep'); this.lockBeep = lock === 'rocket' ? 0.18 : 0.3; }
    } else this.lockBeep = 0;
    // Combat events: sounds, shake, a few words.
    for (const ev of this.pursuit.combat.splice(0)) {
      if (ev.type === 'shot') this.audio.cue('gunshot', Math.max(0.2, 1 - Math.hypot(ev.x - p.x, ev.z - p.z) / 80));
      else if (ev.type === 'launch') { this.audio.cue('launch'); this.toast('Rocket!', 'Swerve', 0.9); }
      else if (ev.type === 'explosion') {
        this.audio.cue('explosion', Math.max(0.25, 1 - ev.dist / 120));
        this.cam.addTrauma(Math.max(0, 0.9 - ev.dist / 40));
        if (ev.damage > 0) this.hud.flashHit(Math.min(1, ev.damage / 40));
      } else if (ev.type === 'spikes') this.audio.cue('tirepop');
      else if (ev.type === 'heli') this.audio.cue('star');
    }
    this.hud.warn(lock === 'rocket' ? 'ROCKET LOCK · SWERVE' : lock === 'marksman' ? 'MARKSMAN · LASER ON YOU' : this.pursuit.warning ?? (this.radarShown > 0 && radar ? `RADAR · ${radar.mph} MPH · ${radar.road}${quiet ? ' · Quiet Drive: warning only' : this.pursuit.radarWarnOnly ? ' · warning only during events' : ''}` : null));
    this.airPop = Math.max(0, this.airPop - realDt);
    if (this.pursuit.finishReached) {
      this.pursuit.finishReached = false;
      this.completeFiveStarRun();
    }
    // GPS reroute.
    if (this.gps) {
      this.gpsTimer -= realDt;
      if (Math.hypot(this.gps.x - p.x, this.gps.z - p.z) < 25) {
        this.toast('Arrived', '', 1.2);
        this.gps = null;
      } else if (this.gpsTimer <= 0) {
        this.gpsTimer = 2;
        this.gps.route = this.gpsRoute(this.gps.x, this.gps.z);
      }
    }
    this.hud.update(realDt);
  }

  private lastRadar = -1;
  private radarCueAt = -9;
  private radarShown = 0;
  private airPop = 0;
  private airPopText = '';

  cycleTime() {
    const st = this.save.data.settings;
    st.timeOfDay = TIME_ORDER[(TIME_ORDER.indexOf(st.timeOfDay) + 1) % TIME_ORDER.length];
    this.save.persist();
    this.applySettings(st);
    this.toast(TIMES[st.timeOfDay].label, 'T cycles · also in Settings', 1.4);
  }

  /** Sound, camera and rewards for the player's kart cues (drift tiers, boosts, jumps). */
  private playerCue(c: string) {
    const p = this.player;
    switch (c) {
      case 'drift': case 'tier1': case 'tier2': case 'tier3': case 'cancel': case 'jump':
        this.audio.cue(c);
        break;
      case 'boost':
        this.audio.cue('boost');
        this.cam.kickFov(7);
        break;
      case 'hurt':
        this.hud.flashHit(0.3);
        this.saveCondition();
        break;
      case 'tire':
        this.audio.cue('tirepop');
        this.cam.addTrauma(0.25);
        this.toast('Tire blown', `${p.flatCount} flat · repair at the garage`, 1.4);
        this.saveCondition();
        break;
      case 'totaled':
        this.onTotaled();
        break;
      case 'shield-hit':
        this.audio.cue('shield-hit');
        this.hud.flashHit(0.15);
        break;
      case 'repaired':
        this.saveCondition(true);
        this.toast('Patched up', `${Math.round(p.condition * 100)}% · ${p.flatCount} flat${p.flatCount === 1 ? '' : 's'} left`, 1.3);
        break;
      case 'land': {
        const air = p.landedAir;
        this.audio.cue('land');
        this.cam.addTrauma(Math.min(0.45, 0.1 + air * 0.18));
        if (air >= 0.45) {
          // Clean air pays out: a boost scaled by hang time, plus nitro.
          p.addBoost(Math.min(1.5, 0.3 + air * 0.7), 8);
          this.nitro = Math.min(1, this.nitro + Math.min(0.3, air * 0.12));
          this.audio.cue('air');
          this.airPopText = `AIR ${air.toFixed(1)}s · BOOST`;
          this.airPop = 1.3;
        }
        this.event?.onLand(air, p.speed);
        break;
      }
    }
  }

  private handleHeatEvents() {
    const heat = this.pursuit.heat;
    if (!this.pursuit.active && this.pursuitLive && !heat.events.some((e) => e.type === 'escaped' || e.type === 'caught')) this.pursuitLive = false;
    for (const ev of heat.drain()) {
      if (ev.type === 'escaped' || ev.type === 'caught') this.pursuitLive = false;
      if (ev.type === 'star') {
        this.audio.cue('star');
        this.toast(`${'★'.repeat(ev.stars)}`, ev.reason, 1.8);
      } else if (ev.type === 'search') this.toast('Searching', 'Stay out of sight', 1.4);
      else if (ev.type === 'reacquired') this.toast('Spotted', 'Pursuit resumed', 1.2);
      else if (ev.type === 'escaped' && this.event instanceof EscapeRun && this.event.state === 'running') {
        this.save.data.stats.escapes++;
        this.save.persist();
        this.pursuit.bonusCredits = 0;
        this.audio.cue('escape');
        this.event.onEscaped(ev.stars);
      } else if (ev.type === 'escaped') {
        const reward = Math.round((ev.reward + this.pursuit.bonusCredits) * this.difficulty.payout);
        const paid = this.save.bank(this.pursuitId, reward);
        this.save.data.stats.escapes++;
        this.save.persist();
        this.pursuit.bonusCredits = 0;
        this.audio.cue('escape');
        this.toast('Escaped', `${'★'.repeat(ev.stars)} · banked ${paid.toLocaleString()} cr`, 3);
      } else if (ev.type === 'caught') this.onCaught(ev.stars);
      else if (ev.type === 'crescendo-start') this.toast('Crescendo', 'Final layer — reach the finish gate', 2);
    }
  }

  /** Busted fine: grows with the stars and the difficulty. */
  private fineFor(stars: number) {
    return Math.round((250 * stars + 150 * Math.max(0, stars - 3)) * this.difficulty.payout / 10) * 10;
  }

  private onCaught(stars: number) {
    // Pinned while wrecked: one bill for the tow, the repairs and the fine.
    if (this.player.totaled) {
      this.resetTotaled(stars);
      return;
    }
    this.audio.cue('busted');
    this.save.data.stats.captures++;
    const fine = this.charge(this.fineFor(stars));
    this.save.persist();
    this.pursuit.bonusCredits = 0;
    this.lastFine = fine;
    const ev = this.event;
    if (ev && ev.state === 'running') {
      this.caughtPending = true;
      ev.onCaught();
      if ((ev.state as string) === 'done') return;
    }
    const hadEvent = this.lastEvent && ev;
    this.endEvent();
    this.paused = true;
    this.mode = 'menu';
    this.menuReturn = 'drive';
    this.audio.setPaused(true);
    const toGarage = () => {
      this.pursuit.clearAll();
      this.parkAtGarage();
      this.closeMenu();
    };
    const buttons: [string, () => void][] = hadEvent
      ? [['Retry event (Enter)', () => { this.pursuit.clearAll(); this.retryEvent(); }], ['Back to the garage (Esc)', toGarage]]
      : [['Back to the garage (Enter)', toGarage]];
    this.screens.notice('Busted', `Held at ${'★'.repeat(stars)} · fined ${fine.toLocaleString()} cr`,
      `You were pinned by a unit. The fine came out of your credits (${this.save.data.credits.toLocaleString()} cr left); your car keeps its damage until you repair it at ${GARAGE.name}.`, buttons);
  }

  private completeFiveStarRun() {
    const heat = this.pursuit.heat;
    const reward = Math.round((HEAT_LEVELS[5].escapeReward * 2 + heat.score + this.pursuit.bonusCredits) * this.difficulty.payout);
    const paid = this.save.bank(`${this.pursuitId}-finish`, reward);
    this.save.data.stats.escapes++;
    this.save.persist();
    heat.reset();
    this.pursuit.standDown();
    this.pursuit.bonusCredits = 0;
    this.audio.cue('medal');
    this.paused = true;
    this.mode = 'menu';
    this.menuReturn = 'drive';
    this.audio.setPaused(true);
    this.screens.notice('Five-star run', 'Run complete', `You reached the finish gate with five stars on you. Banked ${paid.toLocaleString()} cr.`, [
      ['Carry on (Enter)', () => this.closeMenu()], ['Garage (Esc)', () => { this.parkAtGarage(); this.enterGarage(); }],
    ]);
  }

  private stepVehicle(v: Vehicle, dt: number, input: DriveInput, steerDt = dt) {
    v.savePrev();
    const surf = this.world.surfaceAt(v.x, v.z);
    v.surfaceGrip = surf === SURF_GRASS ? v.spec.offroadGrip : surf === SURF_WALK ? 0.95 : 1;
    v.onRoad = surf !== SURF_GRASS;
    v.step(dt, input, steerDt);
    // Fast cars move up to a metre a step: never let one skip through a wall.
    const mx = v.x - v.px, mz = v.z - v.pz, travel = Math.hypot(mx, mz);
    if (travel > 0.45) {
      const hit = this.world.statics.raycast(v.px, v.pz, mx, mz, travel + v.halfWidth, TUNNEL_TAGS, v.y + 0.6);
      if (hit < travel + v.halfWidth * 0.6) {
        const keep = Math.max(0, hit - v.halfWidth * 0.7) / travel;
        v.x = v.px + mx * keep;
        v.z = v.pz + mz * keep;
      }
    }
    // Soft, forgiving district edge.
    const b = this.d.bounds;
    const pushX = v.x < b.minX ? b.minX - v.x : v.x > b.maxX ? b.maxX - v.x : 0;
    const pushZ = v.z < b.minZ ? b.minZ - v.z : v.z > b.maxZ ? b.maxZ - v.z : 0;
    if (pushX) v.vx += (pushX * 7 - v.vx * 2.5) * dt;
    if (pushZ) v.vz += (pushZ * 7 - v.vz * 2.5) * dt;
    return surf;
  }

  private fixedStep(dt: number, drive: DriveInput, steerDt: number) {
    this.simTime += dt;
    const p = this.player;
    this.prevSurface = this.surface;
    this.surface = this.stepVehicle(p, dt, drive, steerDt);
    if (this.surface !== this.prevSurface && p.speed > 4 && (this.surface === SURF_WALK || this.prevSurface === SURF_WALK)) p.kick(-0.5 - p.speed * 0.02);
    for (const c of p.cues.splice(0)) this.playerCue(c);

    // Everyone else runs on the warped clock (Time Warp); stalled cars brake and spin.
    const dtO = dt * this.timeWarp;
    for (const r of this.racers) {
      if (r.stall > 0) r.v.h += r.spin * dtO;
      this.stepVehicle(r.v, dtO, r.stall > 0 ? STALLED : r.ai.drive(r.v, dtO));
      r.v.cues.length = 0;
    }
    for (const u of this.pursuit.units) {
      if (u.stall > 0) u.v.h += u.spin * dtO;
      this.stepVehicle(u.v, dtO, u.stall > 0 ? STALLED : u.ai.drive(u.v, dtO));
      u.v.cues.length = 0;
    }

    const actors: Actor[] = [
      { id: p.id, x: p.x, z: p.z, h: p.h, speed: p.speed, halfLength: p.halfLength },
      ...this.racers.map((r) => ({ id: r.v.id, x: r.v.x, z: r.v.z, h: r.v.h, speed: r.v.speed, halfLength: r.v.halfLength })),
      ...this.pursuit.units.map((u) => ({ id: u.v.id, x: u.v.x, z: u.v.z, h: u.v.h, speed: u.v.speed, halfLength: u.v.halfLength })),
      ...this.traffic.cars.map((c) => ({ id: c.id, x: c.body.x, z: c.body.z, h: c.body.h, speed: c.mode === 'drive' ? c.speed : 0, halfLength: c.body.halfLength })),
    ];
    this.traffic.update(dtO, p.x, p.z, this.cam.camera, actors, this.mode === 'drive');

    // Collisions.
    const contacts = this.contacts;
    contacts.length = 0;
    const dyn: PhysBody[] = [p, ...this.racers.map((r) => r.v), ...this.pursuit.units.map((u) => u.v)];
    for (const b of dyn) collideStatic(this.world.statics, b, contacts);
    // Phantom: the player passes through every other car.
    const ghosting = !!p.mods.phase;
    for (let a = 0; a < dyn.length; a++) for (let b = a + 1; b < dyn.length; b++) {
      if (ghosting && (dyn[a] === p || dyn[b] === p)) continue;
      collidePair(dyn[a], dyn[b], contacts);
    }
    for (const b of dyn) {
      if (ghosting && b === p) continue;
      for (const c of this.traffic.cars) {
        if (Math.abs(c.body.x - b.x) > 8 || Math.abs(c.body.z - b.z) > 8) continue;
        collidePair(b, c.body, contacts);
      }
    }
    // Friends' cars push you (their own page moves them). No contact while
    // overlapping at a shared spawn or during a race start.
    this.raceGrace = Math.max(0, this.raceGrace - dt);
    for (const [peer, r] of this.online.remotes) {
      if (!r.visible) continue;
      const d = Math.hypot(r.body.x - p.x, r.body.z - p.z);
      if (d < 3.2 && !this.phasing.has(peer) && (this.raceGrace > 0 || p.speed < 1)) this.phasing.add(peer);
      if (this.phasing.has(peer)) { if (d > 6) this.phasing.delete(peer); continue; }
      if (d < 9 && this.raceGrace <= 0 && !ghosting) collidePair(p, r.body, contacts);
    }
    for (const c of contacts) this.handleContact(c);

    this.validTimer -= dt;
    if (this.validTimer <= 0 && this.surface === SURF_ROAD && p.speed > 1 && !p.airborne && Math.abs(p.slipAngle) < 0.3) {
      this.validTimer = 0.5;
      this.lastValid.push({ x: p.x, z: p.z, h: p.h, y: p.y });
      if (this.lastValid.length > 12) this.lastValid.shift();
    }
  }

  private handleContact(c: Contact) {
    const p = this.player;
    const heat = this.pursuit.heat;
    const other = c.b;
    const trafficCar = other ? this.traffic.find(other.id) : undefined;
    if (trafficCar && c.impulse / trafficCar.body.mass > 1.2) this.traffic.knock(trafficCar);
    if (c.a !== p && other !== p) return;
    // Superstar: whatever you hit goes flying; you feel nothing.
    if (p.mods.invincible && other && other !== p) {
      const hx = other.x - p.x, hz = other.z - p.z, hl = Math.hypot(hx, hz) || 1;
      other.vx += (hx / hl) * 14 + p.vx * 0.3;
      other.vz += (hz / hl) * 14 + p.vz * 0.3;
      if (trafficCar) this.traffic.knock(trafficCar);
      const k = this.pursuit.units.find((u) => u.v === other) ?? this.racers.find((r) => r.v === other);
      if (k) {
        k.v.vy = Math.max(k.v.vy, 6);
        k.v.airborne = true;
        this.pursuit.stallCar(k, 2.5, (Math.random() < 0.5 ? -1 : 1) * 6);
      }
      this.audio.cue('impact', 0.8);
      this.cam.addTrauma(0.2);
      return;
    }
    const dv = c.dv;
    if (dv > 1.5) {
      this.cam.addTrauma(clamp(dv / 14, 0, 0.8));
      this.audio.cue(dv > 4 ? 'impact' : 'scrape', dv / 12);
    }
    // A real hit knocks you out of a drift (and its charge).
    if (dv > 3 && p.drifting) p.cancelDrift();
    // Damage: hard hits only; police rams hurt more, armored units a lot more.
    if (dv > 5 && !p.totaled) {
      const hitter = other ? this.pursuit.units.find((u) => u.v === other) : undefined;
      const mult = hitter?.type === 'tank' ? 2 : hitter ? 1.15 : 1;
      // One crash can hurt badly but never totals a healthy car by itself.
      p.hurt(Math.min(p.maxHealth * 0.45, (dv - 5) * 3.2 * mult * this.difficulty.damage));
      if (dv > 12 && Math.random() < 0.2) p.popTire(Math.random() < 0.5 ? 0 : 1);
    }
    this.event?.onContact(c);
    if (dv < 4) return;
    const street = this.d.streetNameAt(c.x, c.z, undefined, this.player.y);
    const where = street ? ` — ${street}` : '';
    const unit = other ? this.pursuit.units.find((u) => u.v === other) : undefined;
    if (unit) {
      heat.award(HEAT_AWARDS.hitPolice, `Rammed a patrol unit${where}`, this.realTime, unit.id);
      return;
    }
    if (trafficCar || c.tag === 'parked') {
      const w = this.pursuit.witness(c.x, c.z, this.player.y);
      if (!w) return;
      const id = trafficCar ? trafficCar.id : Math.round(c.x) * 10000 + Math.round(c.z);
      const before = heat.stars;
      const ok = heat.award(trafficCar ? HEAT_AWARDS.witnessedCrash : HEAT_AWARDS.hitParked, `Witnessed collision${where}`, this.realTime, id);
      if (ok && before === 0 && heat.stars > 0 && w.patrol) this.pursuit.promote(w.patrol);
      else if (ok && before === 0 && heat.stars > 0 && w.unit) w.unit.state = 'chase';
    }
  }

  private lastFine = 0;

  /** Take credits (never below zero); returns what was actually paid. */
  private charge(amount: number) {
    const paid = Math.min(this.save.data.credits, Math.max(0, Math.round(amount)));
    this.save.data.credits -= paid;
    return paid;
  }

  /** What the garage charges to fix a car. */
  repairCost(v: Vehicle = this.player) {
    if (v.totaled) return Math.round(900 * this.difficulty.payout / 10) * 10;
    const cost = (1 - v.condition) * 700 + v.flatCount * 90;
    return Math.round(cost / 10) * 10;
  }

  private saveCondition(force = false) {
    if (this.testDrive) return;
    if (!force && this.realTime - this.conditionSaveAt < 1.5) return;
    this.conditionSaveAt = this.realTime;
    const p = this.player;
    if (p.health >= p.maxHealth && !p.flatCount) delete this.save.data.condition[this.carId];
    else this.save.data.condition[this.carId] = { h: Math.round(p.health * 10) / 10, f: [...p.flats] };
    this.save.persist();
  }

  /** Repair at the garage. Charges what you can afford; never leaves you stuck. */
  repairCar() {
    const cost = this.repairCost();
    const paid = this.charge(cost);
    this.player.repair();
    this.saveCondition(true);
    return { cost, paid };
  }

  private onTotaled() {
    // Powers end with the car.
    const ab = this.ability as Ability & { stop?: (v: Vehicle) => void };
    ab.stop?.(this.player);
    this.player.mods = defaultMods();
    this.player.shield = 0;
    this.setTimeWarp(1);
    this.audio.cue('totaled');
    this.cam.addTrauma(0.8);
    this.hud.flashHit(1);
    this.saveCondition(true);
    // A timed event ends here.
    if (this.event && this.event.state === 'running' && this.event.def.kind !== 'encore') this.event.onTotaled();
  }

  /** Reset after being totaled: tow to the garage, pay repairs (and a fine if the police were on you). */
  resetTotaled(starsAtCatch?: number) {
    const stars = starsAtCatch ?? this.pursuit.heat.stars;
    const repair = this.repairCost();
    const repairPaid = this.charge(repair);
    const fineBill = stars > 0 ? this.fineFor(stars) : 0;
    const fine = stars > 0 ? this.charge(fineBill) : 0;
    this.lastFine = fine;
    if (stars > 0) this.save.data.stats.captures++;
    const ev = this.event;
    if (ev && ev.state === 'running') ev.onTotaled();
    this.endEvent();
    this.pursuit.clearAll();
    this.player.repair();
    this.saveCondition(true);
    this.parkAtGarage();
    this.hud.setTotaled(null);
    this.paused = true;
    this.mode = 'menu';
    this.menuReturn = 'drive';
    this.audio.setPaused(true);
    const owed = (bill: number, paid: number) => (paid < bill ? `${bill.toLocaleString()} cr (you paid ${paid.toLocaleString()}; the rest was written off)` : `${bill.toLocaleString()} cr`);
    const lines = [`Repairs ${owed(repair, repairPaid)}`];
    if (stars > 0) lines.push(`fine at ${'★'.repeat(stars)}: ${owed(fineBill, fine)}`);
    this.screens.notice('Totaled', `Towed to ${GARAGE.name}`,
      `${lines.join(' · ')}. You have ${this.save.data.credits.toLocaleString()} cr left. The car is fixed and ready.`,
      [['Back on the road (Enter)', () => this.closeMenu()], ['Garage (Esc)', () => this.enterGarage()]]);
  }

  recover() {
    if (this.frozen) return;
    const p = this.player;
    this.event?.onRecover();
    const pose = this.lastValid.length > 2 ? this.lastValid[this.lastValid.length - 3] : this.lastValid[0];
    const py = pose?.y ?? p.y;
    const hit = this.d.nearestEdge(pose?.x ?? p.x, pose?.z ?? p.z, 250, undefined, py) ?? this.d.nearestEdge(pose?.x ?? p.x, pose?.z ?? p.z, 250);
    if (!hit) return;
    const e = this.d.edges[hit.edge];
    let h = e.path.headingAt(hit.s);
    const ref = pose?.h ?? p.h;
    if (Math.cos(h - ref) < 0) h += Math.PI;
    const off = e.oneway ? 0 : Math.min(2.2, e.width / 4);
    // Recovery keeps pursuit state; units keep chasing.
    const x = hit.x - Math.cos(h) * off, z = hit.z + Math.sin(h) * off;
    p.placeAt(x, z, this.d.heightOnEdge(hit.edge, hit.s), h);
    this.lastValid = [{ x, z, h }];
    this.cam.snap(this.camTarget(1));
    this.toast('Recovered', this.pursuit.active ? 'Heat unchanged' : '', 0.9);
  }

  camTarget(alpha: number) {
    const p = this.player;
    return {
      x: lerp(p.px, p.x, alpha), y: lerp(p.py, p.y, alpha), z: lerp(p.pz, p.z, alpha), h: lerpAngle(p.ph, p.h, alpha),
      vx: p.vx, vz: p.vz, speed: p.speed, yawRate: -p.w, length: p.spec.length, airborne: p.airborne,
    };
  }

  // ------------------------------------------------------------------ render
  private render(alpha: number, realDt: number) {
    const p = this.player;
    const t = this.camTarget(alpha);
    const camera = this.cam.camera;
    const wantY = this.surface === SURF_WALK ? 0.11 : 0;
    this.surfY = lerp(this.surfY, wantY, damp(18, realDt));
    this.playerModel.pose(t.x, t.y + this.surfY + p.hopY, t.z, t.h, p.pitch, p.roll, p.steerAngle, p.wheelRot, p.bump);
    this.playerModel.setLights(p.braking, p.reversing);
    // Soft cool rim light above and behind the player so paint reads against the night.
    const kf = { x: Math.sin(t.h), z: Math.cos(t.h) };
    this.keyLight.position.set(t.x - kf.x * 3.5, t.y + 4.2, t.z - kf.z * 3.5);
    this.keyLight.intensity = this.stage.time.lamps > 0 ? 9 : 0;

    if (this.mode === 'title') this.titleCamera(realDt);
    else if (this.mode === 'garage') this.garageCamera(realDt);
    else if (!this.paused) this.cam.update(realDt, t, this.world.statics);

    for (const r of this.racers) {
      const v = r.v;
      r.model.pose(lerp(v.px, v.x, alpha), lerp(v.py, v.y, alpha), lerp(v.pz, v.z, alpha), lerpAngle(v.ph, v.h, alpha), v.pitch, v.roll, v.steerAngle, v.wheelRot, v.bump);
      r.model.setLights(v.braking, v.reversing);
    }
    this.traffic.render(alpha, this.realTime);
    this.pursuit.render(alpha, this.realTime);
    for (const z of this.zones) z.obj.visible = !this.event && !this.testDrive;

    // Headlight follows the car.
    const hl = this.stage.headlight;
    const fx = Math.sin(t.h), fz = Math.cos(t.h);
    hl.intensity = this.mode === 'garage' ? 0 : this.stage.time.headlights;
    hl.position.set(t.x + fx * 2, t.y + 0.9, t.z + fz * 2);
    hl.target.position.set(t.x + fx * 24, t.y - 0.6, t.z + fz * 24);
    this.stage.updateLights(new THREE.Vector3(t.x, t.y, t.z), camera);
    this.scenery.update(camera);
    this.forest.update(camera);
    this.world.updateLod(camera, this.stage.fogFar);
    this.world.update(realDt);
    this.renderDamageFx(realDt, t);
    this.renderAbilityFx(realDt, this.realTime);
    if (this.pursuit.heli) {
      this.pursuit.renderHeli(this.realTime, p, this.stage.time.lamps > 0 ? 1 : 0.25);
      // Rotor thump, louder as it closes in.
      this.rotorClock -= realDt;
      if (this.rotorClock <= 0 && this.mode === 'drive' && !this.paused) {
        this.rotorClock = 0.085;
        const h = this.pursuit.heli;
        this.audio.cue('rotor', Math.max(0.05, 1 - Math.hypot(h.x - p.x, h.y - p.y, h.z - p.z) / 260));
      }
    }
    this.effects.resize(this.stage.renderer.domElement.height, camera.fov);
    this.effects.update(this.mode === 'drive' && !this.paused ? realDt : 0);
    // Garage door shuts behind you once you drive off; the radio goes quiet with it.
    const g = this.venues.garage;
    const dGarage = Math.hypot(p.x - g.center.x, p.z - g.center.z);
    if (this.mode === 'drive') {
      const want = dGarage < 30 ? 1 : 0;
      if (want !== g.doorTarget) {
        g.doorTarget = want;
        if (want === 0) this.audio.cue('door');
      }
    }
    this.venues.update(realDt);
    camera.getWorldPosition(this.camPos);
    const rx = g.radioPos.x - this.camPos.x, rz = g.radioPos.z - this.camPos.z;
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
    this.audio.setRadio(Math.hypot(rx, rz), (rx * right.x + rz * right.z) / Math.max(1, Math.hypot(rx, rz)), g.doorOpen);

    this.updateAudio(realDt);
    if (this.mode === 'drive') this.updateHud(t);
    this.stage.render(camera);
  }

  private titleCamera(dt: number) {
    this.titleT += dt;
    const p = this.player;
    const fx = Math.sin(p.h), fz = Math.cos(p.h), rx = -fz, rz = fx;
    const back = 5.4 - Math.min(1, this.titleT * 0.04) * 0.8;
    const cam = this.cam.camera;
    // Low, behind the parked car, garage over the right shoulder.
    cam.position.set(p.x - fx * back - rx * 1.6, p.y + 0.9, p.z - fz * back - rz * 1.6);
    cam.lookAt(p.x + fx * 7 + rx * 4.5, p.y + 1.3, p.z + fz * 7 + rz * 4.5);
    if (Math.abs(cam.fov - 52) > 0.1) { cam.fov = 52; cam.updateProjectionMatrix(); }
  }

  private garageCamera(dt: number) {
    const g = this.venues.garage;
    const sc = this.showcase;
    if (!sc) return;
    sc.pose(g.showcase.x, g.showcase.y, g.showcase.z, g.showcase.h, 0, 0, 0.25, 0);
    sc.root.rotation.y = g.showcase.h + this.garageAngle;
    const cam = this.cam.camera;
    const ang = g.face + 0.35;
    const r = 7.2;
    cam.position.set(g.showcase.x + Math.sin(ang) * r, g.showcase.y + 1.7, g.showcase.z + Math.cos(ang) * r);
    cam.lookAt(g.showcase.x, g.showcase.y + 0.75, g.showcase.z);
    if (Math.abs(cam.fov - 46) > 0.1) { cam.fov = 46; cam.updateProjectionMatrix(); }
    void dt;
  }

  private updateAudio(dt: number) {
    if (!this.audio.ctx) return;
    const p = this.player;
    const driving = this.mode === 'drive' && !this.paused;
    const st = driving || this.mode === 'title' || this.mode === 'garage'
      ? {
        rpm: p.rpm, redline: p.spec.redline, idle: p.spec.idleRpm, throttle: driving ? p.throttle : 0, speed: p.speed,
        squeal: driving ? p.tireSqueal : 0, nitro: driving && p.nitroActive, boost: this.ability.active > 0 ? 1 : 0, load: 0,
      }
      : null;
    const cam = this.cam.camera;
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(cam.quaternion);
    const sirens: SirenVoice[] = this.pursuit.units
      .filter((u) => u.state !== 'disengage' && u.state !== 'wrecked')
      .map((u) => {
        const dx = u.v.x - p.x, dz = u.v.z - p.z;
        const dist = Math.hypot(dx, dz);
        const closing = -((u.v.vx - p.vx) * dx + (u.v.vz - p.vz) * dz) / Math.max(1, dist);
        return { id: u.id, dist, pan: (dx * right.x + dz * right.z) / Math.max(1, dist), closing, yelp: dist < 35 };
      })
      .sort((a, b) => a.dist - b.dist)
      .slice(0, 2);
    const heat = this.pursuit.heat;
    const layers = HEAT_LEVELS[heat.stars].musicLayers;
    const fade = heat.phase === 'search' ? heat.searchMeter : 1;
    this.audio.update(dt, st, driving ? sirens : [], layers, fade);
  }

  /** Smoke from a hurt engine, fire when it is nearly gone, sparks from bare rims. */
  private renderDamageFx(dt: number, t: { x: number; y: number; z: number; h: number }) {
    if (this.mode !== 'drive' || this.paused) return;
    const p = this.player;
    this.fxClock += dt;
    const c = p.condition;
    const fx = Math.sin(t.h), fz = Math.cos(t.h);
    const ex = t.x + fx * (p.spec.length * 0.32), ez = t.z + fz * (p.spec.length * 0.32), ey = t.y + 1.0;
    const rate = p.totaled ? 30 : c < 0.15 ? 22 : c < 0.35 ? 12 : c < 0.6 ? 5 : 0;
    if (rate > 0 && Math.random() < rate * dt) this.effects.smokePuff(ex, ey, ez, c < 0.2 ? 1 : 0.3);
    if ((p.totaled || c < 0.12) && Math.random() < 40 * dt) this.effects.fire(ex, ey - 0.2, ez);
    if (p.flatCount && p.speed > 4 && !p.airborne) {
      const rx = -Math.cos(t.h), rz = Math.sin(t.h);
      p.flats.forEach((f, i) => {
        if (!f || Math.random() > Math.min(1, p.speed / 25) * 0.8) return;
        const front = i < 2 ? 1 : -1, side = i % 2 ? 1 : -1;
        const wx = t.x + fx * front * p.spec.wheelbase * 0.5 + rx * side * p.spec.track * 0.5;
        const wz = t.z + fz * front * p.spec.wheelbase * 0.5 + rz * side * p.spec.track * 0.5;
        this.effects.sparks(wx, t.y + 0.1, wz, 2, -fx, -fz, 4);
      });
    }
  }

  private updateHud(t: { x: number; z: number; h: number }) {
    const p = this.player;
    this.hud.setCondition(p.condition, p.flats);
    if (p.totaled) {
      const stars = this.pursuit.heat.stars;
      const bill = this.repairCost() + (stars ? this.fineFor(stars) : 0);
      this.hud.setTotaled(`<div class="big">TOTALED</div><div class="small">Press <kbd>R</kbd> to reset · tow + repairs${stars ? ' + fine' : ''}: ${bill.toLocaleString()} cr</div>`);
    } else this.hud.setTotaled(null);
    this.hud.setSpeed(p.speed / 0.44704, p.reversing ? 'R' : `${p.gear}`);
    this.hud.setBoost(this.nitro, p.nitroActive);
    this.hud.setAbility({ ...this.ability.status(), key: 'E' });
    this.hud.setWeapon(this.weapons.status());
    this.hud.setFocus(this.ability.timeScale() < 1 || this.timeWarp < 1);
    // Hysteresis: a new street name must hold briefly before the HUD switches.
    const seen = this.d.streetNameAt(p.x, p.z, p.speed > 2 ? Math.atan2(p.vx, p.vz) : p.h, p.y);
    if (seen !== this.streetCandidate) { this.streetCandidate = seen; this.streetHold = 0; }
    else this.streetHold += 1 / 60;
    if (this.streetHold > 0.35 || !this.streetShown) this.streetShown = this.streetCandidate;
    const street = this.streetShown;
    this.hud.setStreet(street, MAP.city ? this.levelName(p.x, p.z, p.y) : this.areaName(p.x, p.z), this.townName(p.x, p.z));
    const tier = p.driftTier;
    const lo = tier === 0 ? 0 : DRIFT_TIERS[tier - 1], hi = tier < 3 ? DRIFT_TIERS[tier] : lo + 1;
    this.hud.setKart({
      drifting: p.drifting, tier, next: tier < 3 ? clamp((p.driftTime - lo) / (hi - lo), 0, 1) : 1,
      air: p.airborne ? p.airTime : 0, pop: this.airPop > 0 ? this.airPopText : null,
    });
    const heat = this.pursuit.heat;
    if (heat.stars > 0) {
      const caught = heat.caughtMeter > 0.02;
      this.hud.setHeat({
        stars: heat.stars,
        state: caught ? 'caught' : heat.phase === 'search' ? 'search' : 'pursuit',
        label: caught ? 'CAUGHT' : heat.phase === 'search' ? 'SEARCHING' : 'PURSUIT',
        reason: heat.reason + (heat.crescendo > 0 ? ` · crescendo ${Math.ceil(heat.crescendo)}s` : ''),
        meter: heat.searchMeter, caught: heat.caughtMeter, score: Math.round(heat.score), mult: heat.level.multiplier,
      });
    } else {
      this.hud.setHeat(null);
      this.hud.setQuiet(this.save.data.settings.quietDrive || !!this.testDrive);
    }
    const markers: MiniMarker[] = [];
    for (const u of this.pursuit.units) if (u.state !== 'disengage' && u.state !== 'wrecked') markers.push({ x: u.v.x, z: u.v.z, color: u.type === 'tank' ? '#ff8a3c' : u.sees ? '#ff4b4b' : '#5aa8ff', kind: 'police' });
    const heli = this.pursuit.heli;
    if (heli && !heli.leaving) markers.push({ x: heli.x, z: heli.z, color: heli.sees ? '#ff4b4b' : '#c9ccd2', kind: 'police', label: 'HELI' });
    for (const c of this.traffic.cars) if (c.patrol) markers.push({ x: c.body.x, z: c.body.z, color: '#7b8aa5', kind: 'dot' });
    for (const q of this.pursuit.posted) if (q.away <= 0 && Math.abs(q.x - p.x) < 300 && Math.abs(q.z - p.z) < 300) markers.push({ x: q.x, z: q.z, color: '#5aa8ff', kind: 'dot' });
    if (!this.event) {
      for (const z of this.zones) markers.push({ x: z.x, z: z.z, color: '#' + new THREE.Color(EVENTS[z.id].color).getHexString(), kind: 'event' });
      const g = this.venues.garage;
      markers.push({ x: g.curb.x, z: g.curb.z, color: '#79d98a', kind: 'garage' });
    } else markers.push(...this.event.markers());
    for (const r of this.online.remotes.values()) if (r.visible) markers.push({ x: r.body.x, z: r.body.z, color: r.color, kind: 'rival' });
    const race = this.online.race;
    if (race && this.event && this.lastEvent?.mode === 'online') {
      const lower = EVENTS[race.ev].lowerIsBetter;
      this.hud.setRaceBoard(`RACE ${race.code}`, this.online.standings().map((row) => ({
        name: row.name, me: row.me,
        value: row.st === 'done' ? (row.fin === null ? 'DNF' : lower ? fmtTime(row.fin) : row.fin.toLocaleString()) : row.st === 'go' ? 'racing' : 'ready',
      })));
    } else this.hud.setRaceBoard(null);
    this.hud.setOnline(this.online.active ? `ONLINE · ${this.online.peerCount() + 1} DRIVING${race ? ` · RACE ${race.code}` : ''} · O` : null);
    if (this.pursuit.bonus) markers.push({ x: this.pursuit.bonus.gate.x, z: this.pursuit.bonus.gate.z, color: '#ffd34d', kind: 'gate', label: 'Bonus' });
    for (const r of this.pursuit.roadblocks) markers.push({ x: r.gate.x, z: r.gate.z, color: '#ff9020', kind: 'block' });
    if (this.pursuit.finish) markers.push({ x: this.pursuit.finish.gate.x, z: this.pursuit.finish.gate.z, color: '#ffffff', kind: 'gate', label: 'Finish' });
    const route = this.event?.route() ?? this.gps?.route ?? null;
    this.hud.drawMinimap(t.x, t.z, t.h, markers, route, p.speed);
  }

  private townCache = { x: 1e9, z: 1e9, name: MAP.region };
  private townName(x: number, z: number) {
    const c = this.townCache;
    if (Math.hypot(c.x - x, c.z - z) < 25) return c.name;
    const v = (this.d.data.villages ?? []).find((vv) => pointInPolygon(x, z, vv.p));
    this.townCache = { x, z, name: v ? v.n : MAP.region };
    return this.townCache.name;
  }

  /** Ironport: which level you are on ("Underground", "Street level", "Skyway · 10 m up"). */
  private levelName(x: number, z: number, y: number) {
    const top = this.d.data.under?.top ?? 0;
    const up = Math.round(y - top);
    const roof = this.world.ground.ceiling(x, z, y) < y + 14;
    if (up < -1.5) return roof ? `Underground · ${-up} m down` : `Open cut · ${-up} m down`;
    if (up < 2) return roof ? 'Street level · under the decks' : 'Street level';
    return up < 14 ? `Skyway level · ${up} m up` : up < 22 ? `Viaduct level · ${up} m up` : `Highline level · ${up} m up`;
  }

  private areaCache = { x: 1e9, z: 1e9, name: '' };
  /** "downtown Hartland", "near Arrowhead High School", "by Pine Lake", "Chenequa". */
  private areaName(x: number, z: number) {
    const c = this.areaCache;
    if (Math.hypot(c.x - x, c.z - z) < 25) return c.name;
    let name = '';
    if (this.world.isDowntown(x, z)) name = MAP.downtownName;
    else {
      let best = Infinity;
      for (const l of this.d.data.landmarks) {
        const lake = / Lake$|^Lake /.test(l.name);
        const dd = Math.hypot(l.x - x, l.z - z);
        if (dd < (lake ? 650 : 170) && dd < best) { best = dd; name = lake ? `by ${l.name}` : `near ${l.name}`; }
      }
      if (!name) {
        const v = (this.d.data.villages ?? []).find((vv) => pointInPolygon(x, z, vv.p));
        if (v) name = v.kind === 'city' ? `City of ${v.n}` : `Village of ${v.n}`;
      }
    }
    this.areaCache = { x, z, name };
    return name;
  }

  // ------------------------------------------------------------------ automation hooks
  /** Frame-time statistics for the last ~10 s (used by the playtest script). */
  perf() {
    const f = [...this.fps.frames].sort((a, b) => a - b);
    const avg = f.reduce((s, v) => s + v, 0) / Math.max(1, f.length);
    return {
      fps: 1 / avg,
      p95ms: (f[Math.floor(f.length * 0.95)] ?? 0) * 1000,
      p99ms: (f[Math.floor(f.length * 0.99)] ?? 0) * 1000,
      frames: f.length,
      cpuMsAvg: this.cpuMs.reduce((a, b) => a + b, 0) / Math.max(1, this.cpuMs.length),
      cpuMsP95: [...this.cpuMs].sort((a, b) => a - b)[Math.floor(this.cpuMs.length * 0.95)] ?? 0,
      drawCalls: this.stage.renderer.info.render.calls,
      triangles: this.stage.renderer.info.render.triangles,
      pixelRatio: this.stage.renderer.getPixelRatio(),
      canvas: [this.stage.renderer.domElement.width, this.stage.renderer.domElement.height],
    };
  }

  state() {
    const p = this.player;
    const heat = this.pursuit.heat;
    return {
      mode: this.mode, paused: this.paused, screen: this.screens.name, car: this.carId,
      x: +p.x.toFixed(1), y: +p.y.toFixed(2), z: +p.z.toFixed(1), h: +p.h.toFixed(3), mph: +(p.speed / 0.44704).toFixed(1),
      airborne: p.airborne, drifting: p.drifting, tier: p.driftTier, boost: +p.boostTime.toFixed(2), timeOfDay: this.stage.time.id,
      health: +p.health.toFixed(1), maxHealth: p.maxHealth, flats: [...p.flats], totaled: p.totaled, lastFine: this.lastFine,
      heli: this.pursuit.heli ? { sees: this.pursuit.heli.sees, dist: Math.round(Math.hypot(this.pursuit.heli.x - p.x, this.pursuit.heli.z - p.z)) } : null,
      rockets: this.pursuit.rockets.length, locked: this.pursuit.locked, tanks: this.pursuit.units.filter((u) => u.type === 'tank').length,
      slipDeg: +(p.slipAngle * 57.3).toFixed(1), street: this.d.streetNameAt(p.x, p.z, undefined, p.y),
      surface: this.surface, nitro: +this.nitro.toFixed(2), ability: this.ability.status(), activations: this.ability.activations,
      event: this.event ? { id: this.event.def.id, state: this.event.state, time: +this.event.time.toFixed(2), attempt: this.event.attemptId } : null,
      heat: { stars: heat.stars, phase: heat.phase, search: +heat.searchMeter.toFixed(2), caught: +heat.caughtMeter.toFixed(2), units: this.pursuit.units.length, reason: heat.reason, crescendo: heat.crescendo },
      traffic: this.traffic.cars.length, credits: this.save.data.credits, medals: { ...this.save.data.medals }, owned: [...this.save.data.owned],
      simTime: +this.simTime.toFixed(2), realTime: +this.realTime.toFixed(2),
    };
  }
}
