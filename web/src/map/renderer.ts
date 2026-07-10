import { BAY, WORLD, ZONES, buildRoadGraph, type Vec } from '@tylo/shared';
import type { RouteLine, Heat } from '../lib/store';
import type { DriverTick, Trip } from '@tylo/shared';

const ROAD_STYLE = {
  street:    { w: 1.2, color: '#243343' },
  boulevard: { w: 2.1, color: '#2e4052' },
  avenue:    { w: 2.8, color: '#35495e' },
  causeway:  { w: 3.2, color: '#3d566f' },
} as const;

const HEAT_RAMP = [
  [15, 27, 42], [28, 92, 171], [57, 135, 229], [134, 182, 239],
] as const;

export interface Scene {
  ticks: Record<string, DriverTick>;
  routes: Record<string, RouteLine>;
  heat: Heat | null;
  showHeat: boolean;
  showRoutes: boolean;
  showSurge: boolean;
  surge: Record<string, number>;
  humanDriverId: string;
  activeTrip: Trip | null;
  riderPos: Vec | null;
  offeredDriverIds: string[];
}

interface Anim { x: number; y: number; heading: number }

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const lerpAngle = (a: number, b: number, t: number) => {
  let d = ((b - a + Math.PI) % (Math.PI * 2)) - Math.PI;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
};

/**
 * Canvas map. The road graph is rebuilt from @tylo/shared with the same seed
 * the server routes on, so the polylines drawn here are literally the edges
 * Dijkstra traversed. The static layer (water, zones, roads) is rendered once
 * to an offscreen buffer; only vehicles, routes and heat repaint per frame.
 */
export class MapRenderer {
  private ctx: CanvasRenderingContext2D;
  private base: HTMLCanvasElement;
  private heatBuf: HTMLCanvasElement;
  private graph = buildRoadGraph();
  private anim = new Map<string, Anim>();

  private w = 0;
  private h = 0;
  private scale = 1;
  private padX = 0;
  private padY = 0;
  private dpr = 1;
  private t = 0;

  constructor(private canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d')!;
    this.base = document.createElement('canvas');
    this.heatBuf = document.createElement('canvas');
    this.heatBuf.width = 30;
    this.heatBuf.height = 23;
  }

  resize(cssW: number, cssH: number) {
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.w = cssW;
    this.h = cssH;
    this.canvas.width = cssW * this.dpr;
    this.canvas.height = cssH * this.dpr;

    const s = Math.min(cssW / WORLD.w, cssH / WORLD.h);
    this.scale = s;
    this.padX = (cssW - WORLD.w * s) / 2;
    this.padY = (cssH - WORLD.h * s) / 2;

    this.base.width = this.canvas.width;
    this.base.height = this.canvas.height;
    this.drawBase();
  }

  /* ------------------------------------------------------- projection */

  sx = (x: number) => this.padX + x * this.scale;
  sy = (y: number) => this.padY + (WORLD.h - y) * this.scale;

  toWorld(cssX: number, cssY: number): Vec {
    return {
      x: (cssX - this.padX) / this.scale,
      y: WORLD.h - (cssY - this.padY) / this.scale,
    };
  }

  /* --------------------------------------------------- static base layer */

  private drawBase() {
    const c = this.base.getContext('2d')!;
    c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    c.clearRect(0, 0, this.w, this.h);

    c.fillStyle = '#0a1017';
    c.fillRect(0, 0, this.w, this.h);

    // Land
    c.fillStyle = '#0e151d';
    c.fillRect(this.sx(0), this.sy(WORLD.h), WORLD.w * this.scale, WORLD.h * this.scale);

    // Biscayne Bay
    const bx = this.sx(BAY.x0);
    const by = this.sy(BAY.y1);
    const bw = (BAY.x1 - BAY.x0) * this.scale;
    const bh = (BAY.y1 - BAY.y0) * this.scale;
    const grad = c.createLinearGradient(bx, by, bx + bw, by + bh);
    grad.addColorStop(0, '#0c1d31');
    grad.addColorStop(1, '#0a1728');
    c.fillStyle = grad;
    c.fillRect(bx, by, bw, bh);

    // Water: a few slack horizontal strokes so it reads as surface, not a hole.
    c.save();
    c.beginPath();
    c.rect(bx, by, bw, bh);
    c.clip();
    c.strokeStyle = 'rgba(57,135,229,0.06)';
    c.lineWidth = 1;
    for (let y = by + 14; y < by + bh; y += 22) {
      c.beginPath();
      c.moveTo(bx, y);
      for (let x = bx; x <= bx + bw; x += 12) c.lineTo(x, y + Math.sin(x / 26) * 1.6);
      c.stroke();
    }
    c.restore();
    c.strokeStyle = 'rgba(57,135,229,0.16)';
    c.lineWidth = 1;
    c.strokeRect(bx, by, bw, bh);

    // Neighbourhood plates
    for (const z of ZONES) {
      const x = this.sx(z.rect.x0);
      const y = this.sy(z.rect.y1);
      const w = (z.rect.x1 - z.rect.x0) * this.scale;
      const h = (z.rect.y1 - z.rect.y0) * this.scale;
      c.fillStyle = 'rgba(255,255,255,0.018)';
      c.fillRect(x, y, w, h);
      c.strokeStyle = 'rgba(255,255,255,0.05)';
      c.strokeRect(x, y, w, h);
    }

    // Roads: dark casing first, then the lit surface on top.
    for (const pass of [0, 1]) {
      for (const e of this.graph.edges) {
        const st = ROAD_STYLE[e.cls];
        const a = this.graph.nodes[e.a].pos;
        const b = this.graph.nodes[e.b].pos;
        c.beginPath();
        c.moveTo(this.sx(a.x), this.sy(a.y));
        c.lineTo(this.sx(b.x), this.sy(b.y));
        c.lineCap = 'round';
        if (pass === 0) { c.strokeStyle = '#0a121b'; c.lineWidth = st.w + 1.8; }
        else { c.strokeStyle = st.color; c.lineWidth = st.w; }
        c.stroke();
      }
    }

    // Zone labels
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.font = '600 9px system-ui, sans-serif';
    for (const z of ZONES) {
      const cx = this.sx((z.rect.x0 + z.rect.x1) / 2);
      const cy = this.sy((z.rect.y0 + z.rect.y1) / 2);
      c.fillStyle = 'rgba(152,170,187,0.30)';
      c.letterSpacing = '1.4px';
      c.fillText(z.short.toUpperCase(), cx, cy);
      c.letterSpacing = '0px';
    }
    c.fillStyle = 'rgba(57,135,229,0.22)';
    c.font = 'italic 10px system-ui, sans-serif';
    c.fillText('BISCAYNE BAY', bx + bw / 2, by + bh * 0.62);
  }

  /* ------------------------------------------------------------- frame */

  draw(scene: Scene, dt: number) {
    this.t += dt;
    const c = this.ctx;
    c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    c.clearRect(0, 0, this.w, this.h);
    c.drawImage(this.base, 0, 0, this.w, this.h);

    if (scene.showHeat && scene.heat) this.drawHeat(scene.heat);
    if (scene.showSurge) this.drawSurge(scene.surge);
    if (scene.showRoutes) this.drawRoutes(scene.routes);

    if (scene.activeTrip) this.drawTripPins(scene.activeTrip);
    else if (scene.riderPos) this.drawRiderPin(scene.riderPos, false);

    this.drawDrivers(scene);
  }

  private drawHeat(heat: Heat) {
    if (heat.max <= 0.01) return;
    const c = this.heatBuf.getContext('2d')!;
    const img = c.createImageData(heat.cols, heat.rows);

    for (let j = 0; j < heat.rows; j++) {
      for (let i = 0; i < heat.cols; i++) {
        const v = Math.min(1, heat.cells[j * heat.cols + i] / heat.max);
        // Canvas rows run north→south; the world's do not.
        const px = ((heat.rows - 1 - j) * heat.cols + i) * 4;
        const seg = Math.min(2, Math.floor(v * 3));
        const f = v * 3 - seg;
        const a = HEAT_RAMP[seg];
        const b = HEAT_RAMP[seg + 1];
        img.data[px] = lerp(a[0], b[0], f);
        img.data[px + 1] = lerp(a[1], b[1], f);
        img.data[px + 2] = lerp(a[2], b[2], f);
        img.data[px + 3] = Math.pow(v, 0.75) * 190;
      }
    }
    c.putImageData(img, 0, 0);

    const ctx = this.ctx;
    ctx.save();
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.globalCompositeOperation = 'screen';
    ctx.globalAlpha = 0.75;
    ctx.drawImage(this.heatBuf, this.sx(0), this.sy(WORLD.h), WORLD.w * this.scale, WORLD.h * this.scale);
    ctx.restore();
  }

  private drawSurge(surge: Record<string, number>) {
    const c = this.ctx;
    c.save();
    for (const z of ZONES) {
      const m = surge[z.key] ?? 1;
      if (m <= 1.01) continue;
      const x = this.sx(z.rect.x0);
      const y = this.sy(z.rect.y1);
      const w = (z.rect.x1 - z.rect.x0) * this.scale;
      const h = (z.rect.y1 - z.rect.y0) * this.scale;
      const pulse = 0.5 + 0.5 * Math.sin(this.t * 2);
      const a = Math.min(0.26, (m - 1) * 0.2) * (0.7 + 0.3 * pulse);
      c.fillStyle = `rgba(207,117,38,${a})`;
      c.fillRect(x, y, w, h);
      c.strokeStyle = `rgba(240,162,79,${0.28 + 0.2 * pulse})`;
      c.lineWidth = 1;
      c.strokeRect(x, y, w, h);

      c.fillStyle = '#f0a24f';
      c.font = '700 12px system-ui, sans-serif';
      c.textAlign = 'center';
      c.fillText(`${m.toFixed(1)}×`, x + w / 2, y + 16);
    }
    c.restore();
  }

  private drawRoutes(routes: Record<string, RouteLine>) {
    const c = this.ctx;
    for (const r of Object.values(routes)) {
      if (r.points.length < 2) continue;
      const trip = r.phase === 'trip';
      c.save();
      c.beginPath();
      c.moveTo(this.sx(r.points[0].x), this.sy(r.points[0].y));
      for (const p of r.points.slice(1)) c.lineTo(this.sx(p.x), this.sy(p.y));

      // Glow
      c.strokeStyle = trip ? 'rgba(57,135,229,0.16)' : 'rgba(207,117,38,0.16)';
      c.lineWidth = 7;
      c.lineCap = 'round';
      c.lineJoin = 'round';
      c.stroke();

      // Core — dashes flow toward the destination.
      c.strokeStyle = trip ? '#3987e5' : '#cf7526';
      c.lineWidth = 2;
      if (!trip) {
        c.setLineDash([7, 6]);
        c.lineDashOffset = -this.t * 26;
      }
      c.stroke();
      c.restore();
    }
  }

  private drawTripPins(trip: Trip) {
    const started = ['in_progress'].includes(trip.state);
    if (!started) this.drawRiderPin(trip.pickup, trip.state === 'searching');
    this.drawFlag(trip.dropoff);
  }

  private drawRiderPin(p: Vec, pinging: boolean) {
    const c = this.ctx;
    const x = this.sx(p.x);
    const y = this.sy(p.y);

    if (pinging) {
      const phase = (this.t * 0.55) % 1;
      c.strokeStyle = `rgba(57,135,229,${(1 - phase) * 0.7})`;
      c.lineWidth = 1.5;
      c.beginPath();
      c.arc(x, y, 6 + phase * 46, 0, Math.PI * 2);
      c.stroke();
    }
    c.fillStyle = '#3987e5';
    c.beginPath();
    c.arc(x, y, 5.5, 0, Math.PI * 2);
    c.fill();
    c.strokeStyle = '#0e151d';
    c.lineWidth = 2;
    c.stroke();
  }

  private drawFlag(p: Vec) {
    const c = this.ctx;
    const x = this.sx(p.x);
    const y = this.sy(p.y);
    c.fillStyle = '#e9eff5';
    c.strokeStyle = '#0e151d';
    c.lineWidth = 2;
    c.beginPath();
    c.rect(x - 4.5, y - 4.5, 9, 9);
    c.fill();
    c.stroke();
  }

  private drawDrivers(scene: Scene) {
    const c = this.ctx;
    const offered = new Set(scene.offeredDriverIds);

    for (const t of Object.values(scene.ticks)) {
      let a = this.anim.get(t.id);
      if (!a) { a = { x: t.x, y: t.y, heading: t.heading }; this.anim.set(t.id, a); }
      // Server pushes 10×/s; we glide between pushes so motion reads smooth.
      a.x = lerp(a.x, t.x, 0.16);
      a.y = lerp(a.y, t.y, 0.16);
      a.heading = lerpAngle(a.heading, t.heading, 0.16);

      if (t.state === 'offline') continue;

      const x = this.sx(a.x);
      const y = this.sy(a.y);
      const human = t.id === scene.humanDriverId;
      const busy = t.state === 'on_trip' || t.state === 'en_route';

      if (offered.has(t.id)) {
        const pulse = (this.t * 1.15) % 1;
        c.strokeStyle = `rgba(240,162,79,${(1 - pulse) * 0.85})`;
        c.lineWidth = 1.5;
        c.beginPath();
        c.arc(x, y, 8 + pulse * 20, 0, Math.PI * 2);
        c.stroke();
      }

      if (busy) {
        c.fillStyle = 'rgba(240,162,79,0.13)';
        c.beginPath();
        c.arc(x, y, 11, 0, Math.PI * 2);
        c.fill();
      }

      if (!t.connected) {
        c.strokeStyle = '#d03b3b';
        c.lineWidth = 1.5;
        c.setLineDash([2, 2]);
        c.beginPath();
        c.arc(x, y, 9, 0, Math.PI * 2);
        c.stroke();
        c.setLineDash([]);
      }

      // Chevron — shape carries identity, not colour alone.
      c.save();
      c.translate(x, y);
      c.rotate(-a.heading);
      c.beginPath();
      c.moveTo(8, 0);
      c.lineTo(-5.2, 5.2);
      c.lineTo(-2.5, 0);
      c.lineTo(-5.2, -5.2);
      c.closePath();
      c.fillStyle = busy ? '#f0a24f' : '#cf7526';
      c.fill();
      c.strokeStyle = human ? '#e9eff5' : '#0a1017';
      c.lineWidth = human ? 1.4 : 1;
      c.stroke();
      c.restore();

      if (human) {
        c.strokeStyle = 'rgba(233,239,245,0.5)';
        c.lineWidth = 1;
        c.beginPath();
        c.arc(x, y, 12, 0, Math.PI * 2);
        c.stroke();
      }
    }
  }
}
