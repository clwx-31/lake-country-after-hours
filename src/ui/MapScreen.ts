// Full district map: event starts, garage, player, police, real landmarks (from
// OSM) styled apart from invented venues, and a route to the selected destination.
import { GARAGE } from '../map/places';
import type { District } from '../map/District';
import { el } from './Hud';
import { MapPainter } from './MapPainter';

export interface MapPoint {
  id: string;
  name: string;
  x: number;
  z: number;
  kind: 'event' | 'garage' | 'venue' | 'landmark';
  fictional: boolean;
  detail?: string;
  canStart?: boolean;
}

export class MapScreen {
  readonly root = el('div', 'screen mapscreen');
  private canvas = el('canvas') as HTMLCanvasElement;
  private side = el('div', 'map-side');
  private g: CanvasRenderingContext2D;
  private painter: MapPainter;
  selected: MapPoint | null = null;
  route: number[] | null = null;
  points: MapPoint[] = [];
  player = { x: 0, z: 0, h: 0 };
  police: { x: number; z: number }[] = [];
  onSelect: ((p: MapPoint | null, x: number, z: number) => void) | null = null;
  onStart: ((p: MapPoint) => void) | null = null;
  onClose: (() => void) | null = null;
  private view = { cx: 0, cz: 0, scale: 0.4 };

  constructor(private d: District, attribution: { text: string; url: string }) {
    this.painter = MapPainter.for(d);
    this.g = this.canvas.getContext('2d')!;
    this.root.append(this.canvas, this.side);
    const credit = el('div', 'credit');
    credit.innerHTML = `Map data <a href="${attribution.url}" target="_blank" rel="noopener">${attribution.text}</a>, ODbL`;
    this.root.append(credit);
    this.canvas.addEventListener('click', (e) => {
      const r = this.canvas.getBoundingClientRect();
      const { x, z } = this.toWorld(e.clientX - r.left, e.clientY - r.top);
      let best: MapPoint | null = null, bd = 40 / this.view.scale;
      for (const p of this.points) {
        const dd = Math.hypot(p.x - x, p.z - z);
        if (dd < bd) { bd = dd; best = p; }
      }
      this.selected = best;
      this.onSelect?.(best, x, z);
      this.draw();
    });
  }

  private fit() {
    const b = this.d.bounds;
    const w = this.canvas.clientWidth - 360, h = this.canvas.clientHeight;
    this.view.scale = Math.min(w / (b.maxX - b.minX + 60), h / (b.maxZ - b.minZ + 60));
    this.view.cx = (b.minX + b.maxX) / 2;
    this.view.cz = (b.minZ + b.maxZ) / 2;
  }

  private toScreen(x: number, z: number): [number, number] {
    const w = this.canvas.clientWidth - 360, h = this.canvas.clientHeight;
    return [w / 2 + (x - this.view.cx) * this.view.scale, h / 2 + (z - this.view.cz) * this.view.scale];
  }

  private toWorld(px: number, py: number) {
    const w = this.canvas.clientWidth - 360, h = this.canvas.clientHeight;
    return { x: (px - w / 2) / this.view.scale + this.view.cx, z: (py - h / 2) / this.view.scale + this.view.cz };
  }

  open() {
    this.draw();
  }

  draw() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const W = this.canvas.clientWidth || window.innerWidth, H = this.canvas.clientHeight || window.innerHeight;
    if (this.canvas.width !== Math.round(W * dpr)) {
      this.canvas.width = Math.round(W * dpr);
      this.canvas.height = Math.round(H * dpr);
    }
    this.fit();
    const g = this.g;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = '#07090d';
    g.fillRect(0, 0, W, H);
    const [ox, oy] = this.toScreen(this.view.cx, this.view.cz);
    this.painter.draw(g, this.view.cx, this.view.cz, ox, oy, this.view.scale, 0);
    // District edge.
    const b = this.d.bounds;
    const [x0, y0] = this.toScreen(b.minX, b.minZ), [x1, y1] = this.toScreen(b.maxX, b.maxZ);
    g.strokeStyle = 'rgba(255,160,40,0.6)';
    g.setLineDash([6, 6]);
    g.strokeRect(x0, y0, x1 - x0, y1 - y0);
    g.setLineDash([]);
    if (this.route && this.route.length >= 4) {
      g.beginPath();
      for (let i = 0; i < this.route.length; i += 2) {
        const [px, py] = this.toScreen(this.route[i], this.route[i + 1]);
        if (i === 0) g.moveTo(px, py); else g.lineTo(px, py);
      }
      g.strokeStyle = '#ffb347';
      g.lineWidth = 4;
      g.lineJoin = 'round';
      g.stroke();
    }
    g.font = '600 13px "Barlow Condensed", sans-serif';
    // Simple label placement: try right, left, above, below to avoid overlaps.
    const boxes: [number, number, number, number][] = [];
    const label = (text: string, px: number, py: number, font: string, color: string) => {
      g.font = font;
      const w = g.measureText(text).width + 4, h = 15;
      const opts: [number, number][] = [[px + 12, py + 5], [px - 12 - w, py + 5], [px - w / 2, py - 12], [px - w / 2, py + 22]];
      let pick = opts[0];
      for (const o of opts) {
        const box: [number, number, number, number] = [o[0], o[1] - 12, w, h];
        if (!boxes.some((b) => box[0] < b[0] + b[2] && box[0] + box[2] > b[0] && box[1] < b[1] + b[3] && box[1] + box[3] > b[1])) { pick = o; break; }
      }
      boxes.push([pick[0], pick[1] - 12, w, h]);
      g.fillStyle = 'rgba(7,9,13,0.7)';
      g.fillRect(pick[0] - 2, pick[1] - 12, w, h);
      g.fillStyle = color;
      g.fillText(text, pick[0], pick[1]);
    };
    const ordered = [...this.points].sort((a, b) => (a.kind === 'landmark' ? 1 : 0) - (b.kind === 'landmark' ? 1 : 0));
    const labels: (() => void)[] = [];
    for (const p of ordered) {
      const [px, py] = this.toScreen(p.x, p.z);
      const sel = this.selected?.id === p.id;
      if (p.kind === 'landmark') {
        g.fillStyle = '#e8e4da';
        g.beginPath();
        g.moveTo(px, py - 6); g.lineTo(px + 6, py); g.lineTo(px, py + 6); g.lineTo(px - 6, py);
        g.fill();
        labels.push(() => label(p.name, px, py, 'italic 600 13px Georgia, serif', '#d8d3c8'));
        continue;
      }
      g.fillStyle = p.kind === 'garage' ? '#79d98a' : p.kind === 'venue' ? '#5aa8ff' : '#ffb347';
      g.strokeStyle = sel ? '#fff' : '#000';
      g.lineWidth = sel ? 3 : 2;
      // Fictional places get a star.
      g.beginPath();
      for (let i = 0; i < 10; i++) {
        const r = i % 2 ? 5 : 11;
        const a = (i / 10) * Math.PI * 2 - Math.PI / 2;
        if (i === 0) g.moveTo(px + Math.cos(a) * r, py + Math.sin(a) * r);
        else g.lineTo(px + Math.cos(a) * r, py + Math.sin(a) * r);
      }
      g.closePath();
      g.fill();
      g.stroke();
      labels.unshift(() => label(p.name, px, py, '600 14px "Barlow Condensed", sans-serif', '#ffffff'));
    }
    for (const l of labels) l();
    for (const c of this.police) {
      const [px, py] = this.toScreen(c.x, c.z);
      g.fillStyle = '#ff4b4b';
      g.beginPath();
      g.arc(px, py, 5, 0, Math.PI * 2);
      g.fill();
    }
    const [px, py] = this.toScreen(this.player.x, this.player.z);
    g.save();
    g.translate(px, py);
    g.rotate(-this.player.h + Math.PI);
    g.beginPath();
    g.moveTo(0, -12); g.lineTo(8, 8); g.lineTo(0, 3); g.lineTo(-8, 8); g.closePath();
    g.fillStyle = '#ffb347';
    g.strokeStyle = '#000';
    g.lineWidth = 2;
    g.stroke();
    g.fill();
    g.restore();
    this.drawSide();
  }

  private drawSide() {
    const s = this.side;
    s.innerHTML = '';
    s.append(el('h2', '', 'District map'));
    s.append(el('div', 'legend', `
      <div><i style="background:#ffb347"></i>★ Event start (fictional venue or meet point)</div>
      <div><i style="background:#79d98a"></i>★ ${GARAGE.name} (fictional garage)</div>
      <div><i style="background:#5aa8ff"></i>★ Fictional venue</div>
      <div><i style="background:#e8e4da"></i>◆ <em style="font-family:Georgia">Real landmark</em> (OpenStreetMap)</div>
      <div><i style="background:#ff4b4b"></i>Police unit (during a pursuit)</div>
      <div>Streets, river, and building footprints are real OpenStreetMap data. Dashed amber line: playable edge.</div>`));
    const sel = el('div', 'sel');
    if (this.selected) {
      const p = this.selected;
      sel.append(el('b', '', p.name), el('p', '', `${p.fictional ? 'Fictional' : 'Real landmark'}${p.detail ? ' · ' + p.detail : ''}`));
      const row = el('div', 'row');
      if (p.canStart) {
        const b = el('button', 'btn primary small', 'Start event (Enter)') as HTMLButtonElement;
        b.addEventListener('click', () => this.onStart?.(p));
        row.append(b);
      }
      sel.append(row);
      if (this.route) sel.append(el('p', '', 'Route set — follow the amber line on the minimap.'));
    } else sel.append(el('p', '', 'Click a marker to route to it, or anywhere on a street to set a waypoint.'));
    s.append(sel);
    const close = el('button', 'btn small', 'Close (M / Esc)') as HTMLButtonElement;
    close.addEventListener('click', () => this.onClose?.());
    s.append(close);
  }
}
