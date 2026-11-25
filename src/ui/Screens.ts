// DOM menus: title, pause, settings, controls, event briefing, results, garage.
import { ALL_EVENTS, EVENTS, EVENT_ORDER, type EventId } from '../events/defs';
import { fmtTime, type EventResult } from '../events/runs';
import type { Save, Settings } from '../save/Save';
import { TIMES, TIME_ORDER, type TimeId } from '../render/TimeOfDay';
import { CARS, PLAYER_CARS, type CarId } from '../sim/cars';
import { el } from './Hud';
import { raceEvents, type Online } from '../net/Online';
import { GARAGE } from '../map/places';
import { ABILITIES, ABILITY_IDS, type AbilityId } from '../sim/abilityInfo';
import { DEFAULT_WEAPON, WEAPONS, WEAPON_IDS, type WeaponId } from '../sim/weapons';
import { MAPS, MAP, type MapId } from '../map/maps';
import { DIFFICULTIES, difficulty, difficultyMeterHtml } from '../game/difficulty';

export interface CarFigures {
  zeroTo60: number;
  topSpeedMph: number;
  brake60Ft: number;
  gripG: number;
}

export interface ScreenHandlers {
  drive(): void;
  garage(): void;
  map(): void;
  resume(): void;
  quitToTitle(): void;
  settingsChanged(s: Settings): void;
  startEvent(id: EventId, mode: 'rival' | 'ghost'): void;
  cancelBriefing(): void;
  retry(): void;
  continueAfterResults(): void;
  selectCar(id: CarId): void;
  unlockCar(id: CarId): void;
  testDrive(id: CarId): void;
  paint(id: CarId, color: string): void;
  previewCar(id: CarId): void;
  leaveGarage(): void;
  click(): void;
  online(): void;
  /** Condition of a car (health 0..1, flats) and what fixing it costs. */
  carCondition(id: CarId): { health: number; flats: number; totaled: boolean; cost: number };
  repairCar(id: CarId): void;
  hostRace(ev: EventId): void;
  joinRace(code: string): void;
  leaveRace(): void;
  startRace(): void;
  raceGhost(uid: string): void;
  /** Ability carried by a car, and equipping another one. */
  abilityFor(id: CarId): AbilityId;
  setAbility(car: CarId, id: AbilityId): void;
  weaponFor(id: CarId): WeaponId;
  setWeapon(car: CarId, id: WeaponId): void;
  /** Save the choice and load the other map. */
  switchMap(id: MapId): void;
}

const CONTROLS: [string, string][] = [
  ['W / ↑', 'Throttle'], ['S / ↓', 'Brake · hold at rest to reverse'], ['A D / ← →', 'Steer'],
  ['Hold Space', 'Drift (while turning) · release for mini-turbo'], ['Shift', 'Nitro'], ['E', 'Ability (pick any in the garage)'], ['F', 'Fire your weapon (hold for guns; pick one in the garage)'],
  ['C', 'Cycle close / wide camera'], ['Hold V', 'Rear view'], ['M', 'Map'], ['T', 'Time of day'], ['O', 'Online: friends & leaderboard'],
  ['Esc', 'Pause / back'], ['R', 'Recover to road · reset when totaled'], ['Enter', 'Start event / confirm'],
];

export class Screens {
  readonly root = el('div');
  private current: HTMLElement | null = null;
  name = '';
  private briefMode: 'rival' | 'ghost' = 'rival';
  private briefId: EventId | null = null;
  garageSel: CarId = 'vesper';

  constructor(private h: ScreenHandlers, private save: Save, private attribution: { text: string; url: string }) {}

  hide() {
    this.current?.remove();
    this.current = null;
    this.name = '';
  }

  private mount(name: string, node: HTMLElement) {
    this.hide();
    this.name = name;
    this.current = node;
    this.root.append(node);
    node.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => this.h.click()));
  }

  private button(label: string, fn: () => void, cls = '') {
    const b = el('button', cls, label) as HTMLButtonElement;
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      fn();
    });
    return b;
  }

  /** Menu button that shows the difficulty meter and cycles the level. */
  private difficultyButton(redraw: () => void) {
    const st = this.save.data.settings;
    const b = this.button('', () => {
      st.difficulty = (st.difficulty % 5) + 1;
      this.save.persist();
      this.h.settingsChanged(st);
      redraw();
    }, 'diff-btn');
    b.innerHTML = `Difficulty ${difficultyMeterHtml(st.difficulty)}`;
    b.title = `${difficulty(st.difficulty).blurb} Click to change.`;
    return b;
  }

  title() {
    const s = el('div', 'screen title-screen');
    s.append(el('div', 'logo', MAP.logo));
    s.append(el('div', 'tagline', `${MAP.tagline} ${PLAYER_CARS.length} fictional cars, ${ABILITY_IDS.length} abilities.`));
    const m = el('div', 'menu');
    m.append(
      this.button('Drive', () => this.h.drive(), 'sel'),
      this.button(`Level · ${MAP.name}`, () => this.mapPicker()),
      this.button('Garage', () => this.h.garage()),
      this.button('Map', () => this.h.map()),
      this.button('Online · Friends', () => this.h.online()),
      this.button('Settings', () => this.settings('title')),
      this.button('Controls', () => this.controls('title')),
      this.difficultyButton(() => this.title()),
    );
    s.append(m);
    s.append(el('div', 'tagline', MAP.credits
      ? `${MAP.credits} · Press <kbd>Enter</kbd> to drive`
      : `Map data <a style="color:#ffb347;pointer-events:auto" href="${this.attribution.url}" target="_blank" rel="noopener">${this.attribution.text}</a> · ODbL · Elevation: USGS 3DEP · Press <kbd>Enter</kbd> to drive`));
    this.mount('title', s);
  }

  /** Level select: each map is a real place with its own events. */
  mapPicker() {
    const s = el('div', 'screen dim');
    const c = el('div', 'card wide');
    c.append(el('div', 'kicker', 'Level'), el('h2', '', 'Choose a map'));
    const row = el('div', 'map-cards');
    for (const m of Object.values(MAPS)) {
      const card = this.button(`<b>${m.name}</b><span>${m.blurb}</span>${m.id === MAP.id ? '<em>Loaded</em>' : '<em>Load (the page reloads)</em>'}`, () => {
        if (m.id !== MAP.id) this.h.switchMap(m.id);
        else this.title();
      }, `map-card${m.id === MAP.id ? ' sel' : ''}`);
      row.append(card);
    }
    c.append(row, el('p', '', 'Cars, paint, abilities, credits and settings are shared. Medals, best times and ghosts are kept per map.'));
    const back = el('div', 'row');
    back.append(this.button('Back (Esc)', () => this.title(), 'btn'));
    c.append(back);
    s.append(c);
    this.mount('mappick', s);
  }

  pause(inPursuit: boolean, quiet: boolean, inEvent: boolean) {
    const s = el('div', 'screen dim');
    const c = el('div', 'card');
    c.append(el('div', 'kicker', 'Paused'), el('h2', '', `${MAP.name} After Hours`));
    const m = el('div', 'menu');
    m.style.width = '100%';
    const garageBtn = this.button(inPursuit ? 'Garage (not during a pursuit)' : 'Garage', () => this.h.garage());
    (garageBtn as HTMLButtonElement).disabled = inPursuit;
    m.append(
      this.button('Resume', () => this.h.resume(), 'sel'),
      this.button('Map', () => this.h.map()),
      this.button('Online · Friends', () => this.h.online()),
      garageBtn,
      this.button(`Quiet Drive: ${quiet ? 'On' : 'Off'}`, () => {
        this.save.data.settings.quietDrive = !quiet;
        this.save.persist();
        this.h.settingsChanged(this.save.data.settings);
        this.pause(inPursuit, !quiet, inEvent);
      }),
      this.difficultyButton(() => this.pause(inPursuit, quiet, inEvent)),
      this.button('Settings', () => this.settings('pause')),
      this.button('Controls', () => this.controls('pause')),
      this.button(inEvent ? 'Quit event to title' : 'Quit to title', () => this.h.quitToTitle()),
    );
    c.append(m);
    c.append(el('p', '', 'Simulation and event timers are stopped while this menu is open.'));
    s.append(c);
    this.mount('pause', s);
  }

  settings(back: 'title' | 'pause') {
    const st = this.save.data.settings;
    const s = el('div', 'screen dim');
    const c = el('div', 'card settings');
    c.append(el('div', 'kicker', 'Settings'), el('h2', '', 'Sound, comfort & display'));
    const slider = (label: string, key: 'master' | 'music' | 'engine' | 'effects') => {
      const l = el('label', '', label);
      const i = el('input') as HTMLInputElement;
      i.type = 'range'; i.min = '0'; i.max = '1'; i.step = '0.05'; i.value = String(st[key]);
      i.addEventListener('input', () => { st[key] = Number(i.value); this.save.persist(); this.h.settingsChanged(st); });
      l.append(i);
      return l;
    };
    const check = (label: string, key: 'reducedShake' | 'reducedFlashing' | 'lowEffects' | 'quietDrive' | 'wideCamera' | 'showFps') => {
      const l = el('label', '', label);
      const i = el('input') as HTMLInputElement;
      i.type = 'checkbox'; i.checked = st[key];
      i.addEventListener('change', () => { st[key] = i.checked; this.save.persist(); this.h.settingsChanged(st); });
      l.append(i);
      return l;
    };
    const dens = el('label', '', 'Traffic density');
    const sel = el('select') as HTMLSelectElement;
    for (const [v, t] of [[0.5, 'Light'], [1, 'Normal'], [1.4, 'Busy']] as const) {
      const o = el('option', '', t) as HTMLOptionElement;
      o.value = String(v);
      if (Math.abs(st.trafficDensity - v) < 0.01) o.selected = true;
      sel.append(o);
    }
    sel.addEventListener('change', () => { st.trafficDensity = Number(sel.value); this.save.persist(); this.h.settingsChanged(st); });
    dens.append(sel);
    const tod = el('label', '', 'Time of day');
    const tsel = el('select') as HTMLSelectElement;
    for (const id of TIME_ORDER) {
      const o = el('option', '', TIMES[id].label) as HTMLOptionElement;
      o.value = id;
      if (st.timeOfDay === id) o.selected = true;
      tsel.append(o);
    }
    tsel.addEventListener('change', () => { st.timeOfDay = tsel.value as TimeId; this.save.persist(); this.h.settingsChanged(st); });
    tod.append(tsel);
    // Difficulty meter: five clickable segments.
    const diffBox = el('div', 'diff-setting');
    const segs = el('div', 'diff-segs');
    const cur = difficulty(st.difficulty);
    for (const lv of DIFFICULTIES) {
      const b = this.button(lv.label, () => { st.difficulty = lv.level; this.save.persist(); this.h.settingsChanged(st); this.settings(back); }, `seg${lv.level <= cur.level ? ' on' : ''}`);
      if (lv.level <= cur.level) b.style.background = cur.color;
      b.title = lv.blurb;
      segs.append(b);
    }
    diffBox.append(segs, el('p', '', `<b style="color:${cur.color}">${cur.label}</b> · ${cur.blurb} Payouts ×${cur.payout}. Medal times never change.`));
    c.append(
      el('h3', '', 'Difficulty'), diffBox,
      el('h3', '', 'Volume'), slider('Master', 'master'), slider('Music', 'music'), slider('Engine', 'engine'), slider('Effects', 'effects'),
      el('h3', '', 'Comfort'), check('Reduced camera shake', 'reducedShake'), check('Reduced flashing (sirens, roadblocks)', 'reducedFlashing'),
      el('h3', '', 'Display & play'), tod, check('Low-effects preset (no bloom, fewer lights)', 'lowEffects'), check('Quiet Drive (no pursuits)', 'quietDrive'),
      check('Wide chase camera by default', 'wideCamera'), check('Show FPS', 'showFps'), dens,
    );
    const row = el('div', 'row');
    row.append(this.button('Back', () => (back === 'title' ? this.title() : this.h.resume()), 'btn primary'));
    c.append(row);
    s.append(c);
    this.mount('settings', s);
  }

  controls(back: 'title' | 'pause') {
    const s = el('div', 'screen dim');
    const c = el('div', 'card');
    c.append(el('div', 'kicker', 'Controls'), el('h2', '', 'Keyboard'));
    const help = el('div', 'help');
    for (const [k, v] of CONTROLS) help.append(el('div', '', `<kbd>${k}</kbd> ${v}`));
    c.append(help);
    c.append(el('p', '', 'Drift: hold Space while turning. Sparks go blue, orange, then purple; let go for a mini-turbo. Crests launch you into the air, and long clean landings give a boost and nitro. Nitro also refills while you drift. T cycles the time of day. Damage and flat tires stay until you repair at the garage; at zero health the car is totaled and R tows it home. Recovering (R) during a timed event invalidates the attempt; during a pursuit it keeps the heat.'));
    const row = el('div', 'row');
    row.append(this.button('Back', () => (back === 'title' ? this.title() : this.h.resume()), 'btn primary'));
    c.append(row);
    s.append(c);
    this.mount('controls', s);
  }

  briefing(id: EventId, hasGhost: boolean, ownedCar: string) {
    this.briefId = id;
    const def = EVENTS[id];
    const kind = def.kind;
    const best = this.save.data.bests[id];
    const medal = this.save.data.medals[id];
    const s = el('div', 'screen dim');
    const c = el('div', 'card');
    c.append(el('div', 'kicker', 'Event'), el('h2', '', def.name), el('p', '', def.blurb));
    const fmt = (v: number) => (def.lowerIsBetter ? fmtTime(v) : v.toLocaleString());
    if (kind !== 'encore' && kind !== 'warmup') {
      c.append(el('p', '', `Medals — <span class="medal gold">GOLD</span> ${fmt(def.medals.gold)} · <span class="medal silver">SILVER</span> ${fmt(def.medals.silver)} · <span class="medal bronze">BRONZE</span> ${fmt(def.medals.bronze)}`));
    }
    c.append(el('p', '', `Best: <b style="color:#f2ede4">${best ? (def.lowerIsBetter ? fmtTime(best.score) : best.score.toLocaleString()) : '—'}</b> ${medal ? `<span class="medal ${medal}">${medal.toUpperCase()}</span>` : ''} · Driving: ${ownedCar}`));
    const dl = difficulty(this.save.data.settings.difficulty);
    const chase = kind === 'escape' || kind === 'survive' || kind === 'getaway';
    const effect = kind === 'circuit' ? `rival pace ×${dl.rivalPace}` : kind === 'lastset' ? `time limit ×${dl.timeLimit}, cargo damage ×${dl.damage}` : kind === 'air' ? `time limit ×${dl.timeLimit}` : kind === 'encore' || chase ? `police pace ×${dl.copPace}, sight ×${dl.copSight}` : `payout ×${dl.payout}`;
    c.append(el('p', '', `Difficulty ${difficultyMeterHtml(dl.level)} · ${effect} · payout ×${dl.payout} (change in Settings)`));
    if (kind === 'circuit') {
      c.append(el('p', '', `Mode: <b style="color:#ffb347">${this.briefMode === 'rival' ? 'Race the club rival' : hasGhost ? 'Solo vs your ghost' : 'Solo (no ghost saved yet)'}</b> — <kbd>Tab</kbd> to switch`));
    }
    if (kind === 'encore') c.append(el('p', '', 'This opts into a pursuit even with Quiet Drive on. Getting caught loses the prize.'));
    if (chase) c.append(el('p', '', `Starts at ${'★'.repeat(def.stars ?? 2)} and runs even with Quiet Drive on. ${kind === 'escape' ? 'The clock stops when the search gives up.' : kind === 'survive' ? 'The heat never drops; getting busted or totaled ends it.' : 'The heat never drops; stop in the box at the end.'}`));
    const row = el('div', 'row');
    row.append(
      this.button('Start (Enter)', () => this.h.startEvent(id, this.briefMode), 'btn primary'),
      ...(kind === 'circuit' ? [this.button('Switch mode (Tab)', () => this.toggleMode(hasGhost, ownedCar), 'btn')] : []),
      this.button('Cancel (Esc)', () => this.h.cancelBriefing(), 'btn'),
    );
    c.append(row);
    s.append(c);
    this.mount('briefing', s);
  }

  toggleMode(hasGhost: boolean, car: string) {
    this.briefMode = this.briefMode === 'rival' ? 'ghost' : 'rival';
    if (this.briefId) this.briefing(this.briefId, hasGhost, car);
  }

  get briefingMode() {
    return this.briefMode;
  }

  get briefingId() {
    return this.briefId;
  }

  results(id: EventId, r: EventResult, award: { paid: number; medalBonus: number; duplicate: boolean }, previous: string, newBest: boolean, extra?: HTMLElement) {
    const def = EVENTS[id];
    const s = el('div', 'screen dim');
    const c = el('div', 'card');
    c.append(el('div', 'kicker', def.name), el('h2', '', r.headline), el('p', '', r.detail));
    c.append(el('div', 'result-big', `${r.scoreText}${newBest ? ' <span class="medal gold" style="font-size:20px;vertical-align:middle">NEW BEST</span>' : ''}`));
    const grid = el('div', 'result-grid');
    for (const [k, v] of r.lines) grid.append(el('span', '', k), el('span', '', v));
    grid.append(el('span', '', 'Medal'), el('span', '', r.medal ? `<span class="medal ${r.medal}">${r.medal.toUpperCase()}</span>` : '<span class="medal none">NONE</span>'));
    grid.append(el('span', '', 'Payout'), el('span', '', `${award.paid.toLocaleString()} cr${award.medalBonus ? ` (incl. ${award.medalBonus} first-medal bonus)` : ''}${award.duplicate ? ' · already awarded' : ''}`));
    grid.append(el('span', '', 'Previous best'), el('span', '', previous));
    grid.append(el('span', '', 'Wallet'), el('span', '', `${this.save.data.credits.toLocaleString()} cr · ${this.save.medalCount()} medals`));
    c.append(grid);
    if (extra) c.append(extra);
    const row = el('div', 'row');
    row.append(this.button('Retry (Enter)', () => this.h.retry(), 'btn primary'), this.button('Carry on (Esc)', () => this.h.continueAfterResults(), 'btn'));
    c.append(row);
    s.append(c);
    this.mount('results', s);
  }

  /** Friends online, race lobby, and the shared leaderboard. */
  online(o: Online, opts: { myCar: string; inEvent: boolean; boardEv: EventId; setBoardEv: (ev: EventId) => void; close: () => void }) {
    const s = el('div', 'screen dim');
    const c = el('div', 'card online');
    c.append(el('div', 'kicker', 'Online'), el('h2', '', 'Friends & leaderboard'));
    if (!o.active) {
      const why = o.state === 'connecting' ? 'Connecting…' : 'Online play works when the game is opened from its claude.ai link while signed in. Share the link with friends (Share → invite them; Contributor access lets them save leaderboard times). Single player works the same either way.';
      c.append(el('p', '', why));
    } else {
      // Friends here now.
      c.append(el('h3', '', `Driving now · ${o.peerCount() + 1}`));
      const list = el('div', 'friends');
      list.append(el('div', 'friend me', `<b>You</b> <span>${opts.myCar}</span>`));
      for (const r of o.remotes.values()) {
        const elsewhere = r.map !== MAP.id ? ` · on ${MAPS[r.map as MapId]?.name ?? 'another map'}` : '';
        const doing = (r.race ? `racing ${EVENTS[r.race.ev].short} (${r.race.code})` : r.ev ? ALL_EVENTS[r.ev as EventId]?.short ?? 'event' : r.stars ? `${'★'.repeat(r.stars)} pursuit` : 'free roam') + elsewhere;
        const row = el('div', 'friend');
        const name = el('b');
        name.textContent = o.nameOf(r.by);
        name.style.color = r.color;
        row.append(name, el('span', '', `${CARS[r.car].name} · ${doing}`));
        list.append(row);
      }
      if (!o.remotes.size) list.append(el('p', '', 'Nobody else is here yet. Share this artifact with friends; when they open it you will see their cars.'));
      c.append(list);

      // Race lobby.
      c.append(el('h3', '', 'Race'));
      const race = o.race;
      if (!race) {
        const row = el('div', 'row');
        for (const ev of raceEvents()) row.append(this.button(`Host ${EVENTS[ev].name}`, () => this.h.hostRace(ev), 'btn small'));
        c.append(row);
        const open = o.openRaces();
        if (open.length) {
          const jr = el('div', 'row');
          for (const r of open) {
            const b = this.button(`Join ${r.code} · ${EVENTS[r.ev].name} · ${r.count} in${r.running ? ' (running)' : ''}`, () => this.h.joinRace(r.code), 'btn small');
            b.title = `Hosted by ${r.host}`;
            jr.append(b);
          }
          c.append(jr);
        } else c.append(el('p', '', 'No open races. Host one and friends can join it here.'));
      } else {
        c.append(el('p', '', `<b style="color:#f2ede4">${EVENTS[race.ev].name}</b> · code <b style="color:#ffb347">${race.code}</b> · ${race.host ? 'you are hosting' : 'waiting for the host to start'}`));
        const grid = el('div', 'result-grid');
        o.standings().forEach((r, i) => {
          const status = r.st === 'done' ? (r.fin === null ? 'did not finish' : EVENTS[race.ev].lowerIsBetter ? fmtTime(r.fin) : r.fin.toLocaleString()) : r.st === 'go' ? 'racing' : 'ready';
          const name = el('span');
          name.textContent = `${i + 1}. ${r.name}`;
          grid.append(name, el('span', '', status));
        });
        c.append(grid);
        const row = el('div', 'row');
        if (race.host) row.append(this.button(race.seq ? 'Start again' : 'Start race', () => this.h.startRace(), 'btn primary'));
        row.append(this.button('Leave race', () => this.h.leaveRace(), 'btn'));
        c.append(row);
      }

      // Leaderboard.
      c.append(el('h3', '', 'Leaderboard'));
      const tabs = el('div', 'row');
      for (const ev of EVENT_ORDER.filter((e) => EVENTS[e].kind !== 'encore')) {
        tabs.append(this.button(EVENTS[ev].short, () => opts.setBoardEv(ev), `btn small${opts.boardEv === ev ? ' primary' : ''}`));
      }
      c.append(tabs);
      const def = EVENTS[opts.boardEv];
      const rows = o.board(opts.boardEv);
      if (!o.db) c.append(el('p', '', 'The leaderboard needs the shared database, which this view does not have.'));
      else if (!o.boardsReady) c.append(el('p', '', 'Loading…'));
      else if (!rows.length) c.append(el('p', '', 'No times yet. Finish the event to post one.'));
      else {
        const grid = el('div', 'result-grid board');
        rows.forEach((r, i) => {
          const name = el('span');
          name.textContent = `${i + 1}. ${r.name}`;
          const val = el('span', '', `${def.lowerIsBetter ? fmtTime(r.score) : r.score.toLocaleString()} · ${CARS[r.car].name} · ${difficulty(r.diff ?? 3).label}`);
          if (def.kind === 'circuit' && r.ghost && !opts.inEvent) {
            const b = this.button('Race ghost', () => this.h.raceGhost(r.uid), 'btn small');
            b.style.marginLeft = '10px';
            val.append(b);
          }
          grid.append(name, val);
        });
        c.append(grid);
      }
      if (o.canWrite === false) c.append(el('p', '', 'Your access level lets you race but not post times. Ask the owner for Contributor access to save to the board.'));
    }
    const row = el('div', 'row');
    row.append(this.button('Back (Esc)', () => opts.close(), 'btn primary'));
    c.append(row);
    s.append(c);
    this.mount('online', s);
  }

  /** Capture / escape summaries reuse the results card. */
  notice(kicker: string, title: string, body: string, buttons: [string, () => void][]) {
    const s = el('div', 'screen dim');
    const c = el('div', 'card');
    c.append(el('div', 'kicker', kicker), el('h2', '', title), el('p', '', body));
    const row = el('div', 'row');
    buttons.forEach(([label, fn], i) => row.append(this.button(label, fn, i === 0 ? 'btn primary' : 'btn')));
    c.append(row);
    s.append(c);
    this.mount('notice', s);
  }

  garage(figures: Record<string, CarFigures>, testing: boolean) {
    const save = this.save;
    const sel = this.garageSel;
    const spec = CARS[sel];
    const owned = save.data.owned.includes(sel);
    const s = el('div', 'screen garage');
    const left = el('div', 'left');
    left.append(el('div', 'klass', GARAGE.name), el('h2', '', 'Garage'));
    left.append(el('div', 'wallet', `Credits <b>${save.data.credits.toLocaleString()}</b> · Medals <b>${save.medalCount()}</b>`));
    const list = el('div', 'car-list');
    for (const id of PLAYER_CARS) {
      const c = CARS[id];
      const isOwned = save.data.owned.includes(id);
      const u = c.unlock;
      const tag = isOwned ? (save.data.selected === id ? 'DRIVING' : 'OWNED') : u ? `${u.medals} medals or ${u.credits.toLocaleString()} cr` : '';
      const b = this.button(`<span>${c.name}</span><span class="tag ${isOwned ? 'owned' : ''}">${tag}</span>`, () => {
        this.garageSel = id;
        this.h.previewCar(id);
        this.garage(figures, testing);
      });
      if (id === sel) b.classList.add('sel');
      list.append(b);
    }
    left.append(list);
    left.append(el('p', '', `All ${PLAYER_CARS.length} cars are yours from the start, and any car can carry any ability.`));
    const bottomRow = el('div', 'row');
    bottomRow.append(this.button('Drive (Enter)', () => this.h.leaveGarage(), 'btn primary'));
    left.append(bottomRow);

    const right = el('div', 'right');
    right.append(el('div', 'klass', spec.klass), el('h2', '', spec.name), el('p', '', spec.feel));
    const f = figures[sel];
    const cmpId = save.data.selected;
    const cf = figures[cmpId];
    const stat = (label: string, v: number, cmp: number, max: number, text: string, invert = false) => {
      const row = el('div', 'stat');
      const norm = (x: number) => Math.max(0.05, Math.min(1, invert ? 1 - x / max : x / max));
      const bar = el('div', 'bar');
      bar.innerHTML = `<i style="width:${Math.round(norm(v) * 100)}%"></i>`;
      if (cmpId !== sel) {
        const cbar = el('div', 'bar');
        cbar.innerHTML = `<i class="cmp" style="width:${Math.round(norm(cmp) * 100)}%"></i>`;
        const wrap = el('div');
        wrap.append(bar, cbar);
        row.append(el('span', '', label), wrap, el('span', 'v', text));
      } else row.append(el('span', '', label), bar, el('span', 'v', text));
      return row;
    };
    right.append(el('h3', '', `Measured${cmpId !== sel ? ` · grey = ${CARS[cmpId].name}` : ''}`));
    right.append(
      stat('0–60 mph', f.zeroTo60, cf.zeroTo60, 9, `${f.zeroTo60.toFixed(2)} s`, true),
      stat('Top speed', f.topSpeedMph, cf.topSpeedMph, 280, `${Math.round(f.topSpeedMph)} mph`),
      stat('60–0 brake', f.brake60Ft, cf.brake60Ft, 190, `${Math.round(f.brake60Ft)} ft`, true),
      stat('Grip', f.gripG, cf.gripG, 1.25, `${f.gripG.toFixed(2)} g`),
    );
    right.append(el('p', '', `${spec.drive} · ${Math.round(spec.power / 745.7)} hp · ${spec.mass.toLocaleString()} kg · wheelbase ${spec.wheelbase.toFixed(2)} m`));
    // Ability: the car's signature by default; any of them can be fitted.
    const equipped = this.h.abilityFor(sel);
    const info = ABILITIES[equipped as Exclude<AbilityId, 'none'>];
    const ab = el('div', 'ability-box');
    ab.style.borderLeftColor = info.color;
    ab.append(el('b', '', `${info.name}${equipped === spec.ability ? ' <span class="sig">signature</span>' : ''}`), el('p', '', info.line));
    right.append(el('h3', '', 'Ability <span class="sub">· E to use · click to fit another</span>'), ab);
    const grid = el('div', 'ability-grid');
    for (const id of ABILITY_IDS) {
      const a = ABILITIES[id as Exclude<AbilityId, 'none'>];
      const b = this.button(`<i style="background:${a.color}"></i>${a.name}${id === spec.ability ? ' ★' : ''}`, () => {
        this.h.setAbility(sel, id);
        this.garage(figures, testing);
      }, `chip${id === equipped ? ' sel' : ''}`);
      b.title = `${a.tag} · ${a.line}`;
      grid.append(b);
    }
    right.append(grid);
    // Weapon: a second slot, fired with F.
    const wEq = this.h.weaponFor(sel);
    const wInfo = WEAPONS[wEq];
    const wb = el('div', 'ability-box');
    wb.style.borderLeftColor = wInfo.color;
    wb.append(el('b', '', `${wInfo.name}${wEq === DEFAULT_WEAPON[sel] ? ' <span class="sig">standard</span>' : ''}`), el('p', '', wInfo.line));
    right.append(el('h3', '', 'Weapon <span class="sub">· F to fire · click to fit another</span>'), wb);
    const wgrid = el('div', 'ability-grid');
    for (const id of WEAPON_IDS) {
      const w = WEAPONS[id];
      const b = this.button(`<i style="background:${w.color}"></i>${w.name}${id === DEFAULT_WEAPON[sel] ? ' ★' : ''}`, () => {
        this.h.setWeapon(sel, id);
        this.garage(figures, testing);
      }, `chip${id === wEq ? ' sel' : ''}`);
      b.title = w.line;
      wgrid.append(b);
    }
    right.append(wgrid);
    right.append(el('h3', '', 'Paint'));
    const sw = el('div', 'swatches');
    const cur = save.data.paint[sel] ?? spec.paints[0];
    for (const p of spec.paints) {
      const b = this.button('', () => {
        this.h.paint(sel, p);
        this.garage(figures, testing);
      });
      b.style.background = p;
      if (p === cur) b.classList.add('sel');
      sw.append(b);
    }
    right.append(sw);
    const actions = el('div', 'row');
    if (owned) {
      const b = this.button(save.data.selected === sel ? 'Selected' : 'Select', () => { this.h.selectCar(sel); this.garage(figures, testing); }, 'btn primary');
      (b as HTMLButtonElement).disabled = save.data.selected === sel;
      actions.append(b);
    } else {
      const can = save.canUnlock(sel);
      const u = spec.unlock!;
      const b = this.button(can.by === 'medals' ? `Unlock (${u.medals} medals)` : `Unlock (${u.credits.toLocaleString()} cr)`, () => { this.h.unlockCar(sel); this.garage(figures, testing); }, 'btn primary');
      (b as HTMLButtonElement).disabled = !can.ok;
      actions.append(b);
    }
    actions.append(this.button('Test drive', () => this.h.testDrive(sel), 'btn'));
    // Condition and repairs for owned cars.
    if (owned) {
      const cond = this.h.carCondition(sel);
      const pct = Math.round(cond.health * 100);
      const damaged = cond.health < 1 || cond.flats > 0;
      right.append(el('h3', '', 'Condition'));
      right.append(el('p', '', damaged
        ? `<b style="color:${cond.health < 0.35 ? '#ff4b4b' : '#ffb347'}">${pct}%</b>${cond.flats ? ` · ${cond.flats} flat tire${cond.flats > 1 ? 's' : ''}` : ''} · repairs ${cond.cost.toLocaleString()} cr`
        : '<b style="color:#79d98a">100%</b> · ready to go'));
      if (damaged) {
        const b = this.button(`Repair (${cond.cost.toLocaleString()} cr)`, () => { this.h.repairCar(sel); this.garage(figures, testing); }, 'btn primary');
        if (save.data.credits < cond.cost) b.title = 'You will pay what you can; the shop never leaves you stuck.';
        actions.prepend(b);
      }
    }
    right.append(actions);
    s.append(left, right, el('div', 'hint', 'Drag or ←/→ to rotate · Esc to leave'));
    this.mount('garage', s);
  }
}

