// Driving HUD: speed, street, minimap, nitro and ability indicators, heat, event info.
import { MAP } from '../map/maps';
import type { District } from '../map/District';
import { Minimap } from './Minimap';

export const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', html = '') => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html) e.innerHTML = html;
  return e;
};

export interface MiniMarker {
  x: number;
  z: number;
  color: string;
  kind: 'dot' | 'police' | 'event' | 'garage' | 'checkpoint' | 'ghost' | 'rival' | 'gate' | 'block';
  label?: string;
}

export interface AbilityView {
  name: string;
  key: string;
  fill: number; // 0..1 ring fill
  state: string;
  mode: 'ready' | 'active' | 'charging';
  bank?: number; // extra bar (Drift Bank / capacitor)
}

export interface HeatView {
  stars: number;
  state: 'pursuit' | 'search' | 'caught' | 'none';
  label: string;
  reason: string;
  meter: number;
  caught: number;
  score: number;
  mult: number;
}

export class Hud {
  readonly root = el('div', 'hud');
  private speed = el('div', 'speedo');
  private mph = el('span', 'mph', '0');
  private gear = el('div', 'gear');
  private boostFill = el('i');
  private boost = el('div', 'boost');
  private ability = el('div', 'ability');
  private abilityArc: SVGCircleElement;
  private abilityName = el('div', 'name');
  private abilityState = el('div', 'state');
  private abilityBank = el('div', 'bar');
  private weapon = el('div', 'ability weapon');
  private weaponArc!: SVGCircleElement;
  private weaponName = el('div', 'name');
  private weaponState = el('div', 'state');
  private streetEl = el('div', 'street');
  private card = el('div', 'street-card');
  private heat = el('div', 'heat hidden');
  private quiet = el('div', 'quiet-tag hidden', 'QUIET DRIVE');
  private eventPanel = el('div', 'event-panel hidden');
  private toastEl = el('div', 'toast hidden');
  private promptEl = el('div', 'prompt hidden');
  private warnEl = el('div', 'warning hidden');
  private drift = el('div', 'drift-meter hidden');
  private vignette = el('div', 'focus-vignette');
  private fpsEl = el('div', 'fps hidden');
  private raceBoard = el('div', 'race-board hidden');
  private cond = el('div', 'condition');
  private condFill = el('i');
  private condTires: HTMLElement[] = [];
  private hitFlash = el('div', 'hit-flash');
  private totaledEl = el('div', 'totaled hidden');
  private onlineTag = el('div', 'online-tag hidden');
  private toastTimer = 0;
  private cardTimer = 0;
  private lastStreet = '';
  private seenStreets = new Set<string>();
  readonly minimap: Minimap;
  route: number[] | null = null;

  constructor(d: District, attribution: { text: string; url: string; terrain?: string; plain?: string }) {
    this.minimap = new Minimap(d);
    const unit = el('span', 'unit', 'MPH');
    const top = el('div');
    top.append(this.mph, unit);
    this.speed.append(this.gear, top);
    this.boost.append(el('div', 'label', 'Nitro · Shift'), el('div', 'bar'));
    this.boost.querySelector('.bar')!.append(this.boostFill);
    const ring = el('div', 'ring');
    ring.innerHTML = `<svg viewBox="0 0 58 58"><circle cx="29" cy="29" r="25" fill="none" stroke="rgba(255,255,255,0.12)" stroke-width="5"/><circle class="arc" cx="29" cy="29" r="25" fill="none" stroke="#ffb347" stroke-width="5" stroke-dasharray="157" stroke-dashoffset="0"/></svg><div class="key">E</div>`;
    this.abilityArc = ring.querySelector('.arc') as SVGCircleElement;
    const txt = el('div', 'txt');
    this.abilityBank.append(el('i'));
    this.abilityBank.style.width = '120px';
    txt.append(this.abilityName, this.abilityState, this.abilityBank);
    this.ability.append(ring, txt);
    const wring = el('div', 'ring');
    wring.innerHTML = `<svg viewBox="0 0 58 58"><circle cx="29" cy="29" r="25" fill="none" stroke="rgba(255,255,255,0.12)" stroke-width="5"/><circle class="arc" cx="29" cy="29" r="25" fill="none" stroke="#ff6a3c" stroke-width="5" stroke-dasharray="157" stroke-dashoffset="0"/></svg><div class="key">F</div>`;
    this.weaponArc = wring.querySelector('.arc') as SVGCircleElement;
    const wtxt = el('div', 'txt');
    wtxt.append(this.weaponName, this.weaponState);
    this.weapon.append(wring, wtxt);
    // Car condition: health bar and the four tires in their real positions.
    const bar = el('div', 'bar');
    bar.append(this.condFill);
    const tires = el('div', 'tires');
    for (let i = 0; i < 4; i++) {
      const t = el('span', `tire t${i}`);
      this.condTires.push(t);
      tires.append(t);
    }
    this.cond.append(el('div', 'label', 'Condition'), bar, tires);
    const meters = el('div', 'meters');
    meters.append(this.weapon, this.ability, this.boost, this.cond);
    this.speed.append(meters);
    const mm = el('div', 'minimap-wrap');
    mm.append(this.minimap.canvas, this.streetEl);
    const credit = el('div', 'credit');
    if (attribution.plain) credit.textContent = attribution.plain;
    else credit.innerHTML = `Map data <a href="${attribution.url}" target="_blank" rel="noopener">${attribution.text}</a>${attribution.terrain ? ` · ${attribution.terrain}` : ''}`;
    this.root.append(this.hitFlash, this.totaledEl, this.vignette, this.speed, mm, this.card, this.heat, this.quiet, this.eventPanel, this.toastEl, this.promptEl, this.warnEl, this.drift, credit, this.fpsEl, this.raceBoard, this.onlineTag);
  }

  setSpeed(mph: number, gear: string) {
    this.mph.textContent = String(Math.round(mph));
    this.gear.textContent = gear;
  }

  setBoost(fill: number, active: boolean) {
    this.boostFill.style.width = `${Math.round(fill * 100)}%`;
    this.boost.classList.toggle('active', active);
  }

  setAbility(v: AbilityView) {
    this.abilityName.textContent = v.name;
    this.abilityState.textContent = v.state;
    this.abilityArc.style.strokeDashoffset = String(157 * (1 - v.fill));
    this.abilityArc.style.stroke = v.mode === 'active' ? '#ffd27a' : v.mode === 'ready' ? '#79d98a' : '#ffb347';
    this.ability.classList.toggle('ready', v.mode === 'ready');
    this.ability.classList.toggle('active', v.mode === 'active');
    if (v.bank !== undefined) {
      this.abilityBank.classList.remove('hidden');
      (this.abilityBank.firstChild as HTMLElement).style.width = `${Math.round(v.bank * 100)}%`;
    } else this.abilityBank.classList.add('hidden');
  }

  setWeapon(v: { name: string; state: string; fill: number; mode: 'ready' | 'active' | 'charging' | 'off' }) {
    this.weaponName.textContent = v.name;
    this.weaponState.textContent = v.state;
    this.weaponArc.style.strokeDashoffset = String(157 * (1 - v.fill));
    this.weaponArc.style.stroke = v.mode === 'active' ? '#ffd27a' : v.mode === 'ready' ? '#ff6a3c' : v.mode === 'off' ? '#555' : '#8a5a3a';
    this.weapon.classList.toggle('ready', v.mode === 'ready');
    this.weapon.classList.toggle('active', v.mode === 'active');
    this.weapon.classList.toggle('off', v.mode === 'off');
  }

  /** Mark a street as already introduced (no fade-in card). */
  knowStreet(name: string) {
    this.seenStreets.add(name);
    this.lastStreet = name;
  }

  setStreet(name: string, landmark = '', town = MAP.region) {
    if (name && name !== this.lastStreet) {
      this.lastStreet = name;
      if (!this.seenStreets.has(name)) {
        this.seenStreets.add(name);
        this.card.innerHTML = `<div class="big">${name}</div><div class="sub">${MAP.credits ? town : `${town}, Wisconsin`}</div>`;
        this.card.classList.add('show');
        this.cardTimer = 3.2;
      }
    }
    this.streetEl.innerHTML = `${name || '&nbsp;'}<small>${landmark}</small>`;
  }

  setFocus(on: boolean) {
    this.vignette.classList.toggle('on', on);
  }

  setQuiet(on: boolean) {
    this.quiet.classList.toggle('hidden', !on);
  }

  setHeat(v: HeatView | null) {
    if (!v || v.stars === 0 && v.state === 'none') {
      this.heat.classList.add('hidden');
      return;
    }
    this.heat.classList.remove('hidden');
    this.quiet.classList.add('hidden');
    const stars = `<b>${'★'.repeat(v.stars)}</b>${'★'.repeat(5 - v.stars)}`;
    const meterCls = v.state === 'caught' ? 'meter caught' : 'meter';
    const meterVal = v.state === 'caught' ? v.caught : v.meter;
    const showMeter = v.state === 'search' || v.state === 'caught';
    this.heat.innerHTML = `<div class="stars">${stars}</div>
      <div class="state ${v.state}">${v.label}</div>
      <div class="reason">${v.reason}</div>
      ${showMeter ? `<div class="${meterCls}"><i style="width:${Math.round(meterVal * 100)}%"></i></div>` : ''}
      <div class="score">Pursuit ${v.score.toLocaleString()} cr · ×${v.mult.toFixed(1)}</div>`;
  }

  setEvent(html: string | null) {
    if (!html) this.eventPanel.classList.add('hidden');
    else {
      this.eventPanel.classList.remove('hidden');
      if (this.eventPanel.innerHTML !== html) this.eventPanel.innerHTML = html;
    }
  }

  toast(big: string, small = '', seconds = 2.2) {
    this.toastEl.innerHTML = `<div class="big">${big}</div><div class="small">${small}</div>`;
    this.toastEl.classList.remove('hidden');
    this.toastTimer = seconds;
  }

  prompt(html: string | null) {
    if (!html) this.promptEl.classList.add('hidden');
    else {
      this.promptEl.classList.remove('hidden');
      if (this.promptEl.innerHTML !== html) this.promptEl.innerHTML = html;
    }
  }

  warn(text: string | null) {
    if (!text) this.warnEl.classList.add('hidden');
    else {
      this.warnEl.classList.remove('hidden');
      this.warnEl.textContent = text;
    }
  }

  /** Kart drift sparks (tier 0..3, progress to the next tier) and airtime readout. */
  setKart(v: { drifting: boolean; tier: number; next: number; air: number; pop: string | null }) {
    const show = v.drifting || v.air > 0.3 || !!v.pop;
    this.drift.classList.toggle('hidden', !show);
    if (!show) return;
    const tierName = ['', 'BLUE', 'ORANGE', 'PURPLE'][v.tier];
    let html = '';
    if (v.drifting) {
      const pips = [1, 2, 3].map((t) => `<i class="pip t${t} ${v.tier >= t ? 'on' : ''}"></i>`).join('');
      html += `<div class="sparks t${v.tier}"><div class="pips">${pips}</div><div class="bar"><i style="width:${Math.round(v.next * 100)}%"></i></div><div class="lbl">${v.tier ? `${tierName} MINI-TURBO · release` : 'DRIFT · keep holding'}</div></div>`;
    }
    if (v.air > 0.3) html += `<div class="air">AIR ${v.air.toFixed(1)}s</div>`;
    else if (v.pop) html += `<div class="air pop">${v.pop}</div>`;
    if (this.drift.innerHTML !== html) this.drift.innerHTML = html;
  }

  /** Health (0..1) and flat tires [FL, FR, RL, RR]. */
  setCondition(health: number, flats: readonly boolean[]) {
    const pct = Math.round(health * 100);
    this.condFill.style.width = `${pct}%`;
    this.cond.classList.toggle('low', health < 0.35);
    this.cond.classList.toggle('crit', health < 0.15);
    flats.forEach((f, i) => this.condTires[i].classList.toggle('flat', f));
  }

  /** Red edge flash when the car takes a hit (strength 0..1). */
  flashHit(strength: number) {
    this.hitFlash.style.transition = 'none';
    this.hitFlash.style.opacity = String(Math.min(0.85, 0.25 + strength));
    void this.hitFlash.offsetWidth;
    this.hitFlash.style.transition = 'opacity 0.6s ease-out';
    this.hitFlash.style.opacity = '0';
  }

  /** Totaled overlay (null hides it). */
  setTotaled(html: string | null) {
    this.totaledEl.classList.toggle('hidden', !html);
    if (html && this.totaledEl.innerHTML !== html) this.totaledEl.innerHTML = html;
  }

  /** Live online race standings (names are set as text, never HTML). */
  setRaceBoard(title: string | null, rows: { name: string; me: boolean; value: string }[] = []) {
    this.raceBoard.classList.toggle('hidden', !title);
    if (!title) return;
    const key = title + rows.map((r) => r.name + r.value).join('|');
    if (this.raceBoard.dataset.key === key) return;
    this.raceBoard.dataset.key = key;
    this.raceBoard.replaceChildren(el('div', 't', title));
    rows.forEach((r, i) => {
      const d = el('div', r.me ? 'me' : '');
      d.textContent = `${i + 1}. ${r.name} · ${r.value}`;
      this.raceBoard.append(d);
    });
  }

  setOnline(text: string | null) {
    this.onlineTag.classList.toggle('hidden', !text);
    if (text && this.onlineTag.textContent !== text) this.onlineTag.textContent = text;
  }

  setFps(text: string | null) {
    this.fpsEl.classList.toggle('hidden', !text);
    if (text) this.fpsEl.textContent = text;
  }

  update(dt: number) {
    if (this.toastTimer > 0) {
      this.toastTimer -= dt;
      if (this.toastTimer <= 0) this.toastEl.classList.add('hidden');
    }
    if (this.cardTimer > 0) {
      this.cardTimer -= dt;
      if (this.cardTimer <= 0) this.card.classList.remove('show');
    }
  }

  drawMinimap(x: number, z: number, h: number, markers: MiniMarker[], routePts: number[] | null, speed = 0) {
    this.minimap.draw(x, z, h, speed, markers, routePts);
  }
}
