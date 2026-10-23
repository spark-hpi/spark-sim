// Telemetry: strip charts of what the selected robot commanded and saw, drawn from the recorded snapshots.
import type { RobotSnapshot, WorldSnapshot } from "../shared/protocol.ts";
import type { Stamped } from "./recorder.ts";

interface Series {
  label: string;
  color: string;
  get(r: RobotSnapshot): number;
}

interface Strip {
  title: string;
  min: number;
  max: number;
  unit: string;
  series: Series[];
}

const css = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

function strips(): Strip[] {
  const fg = css("--fg");
  const link = css("--link");
  const amber = "#f59e0b";
  const green = "#10b981";
  const violet = "#a78bfa";
  const gray = css("--muted");
  return [
    {
      title: "Motors",
      min: -6000,
      max: 6000,
      unit: "",
      series: [
        { label: "L", color: link, get: (r) => r.motors[0] },
        { label: "R", color: amber, get: (r) => r.motors[1] },
      ],
    },
    {
      title: "Line sensors (raw)",
      min: 0,
      max: 1024,
      unit: "",
      series: [0, 1, 2, 3, 4].map((i) => ({
        label: `DN${i + 1}`,
        color: [link, green, fg, violet, amber][i],
        get: (r: RobotSnapshot) => r.line[i] ?? 0,
      })),
    },
    {
      title: "Proximity (max of both LED groups)",
      min: 0,
      max: 6,
      unit: "",
      series: [
        { label: "left", color: green, get: (r) => Math.max(r.prox[0] ?? 0, r.prox[1] ?? 0) },
        { label: "front", color: fg, get: (r) => Math.max(r.prox[2] ?? 0, r.prox[3] ?? 0) },
        { label: "right", color: amber, get: (r) => Math.max(r.prox[4] ?? 0, r.prox[5] ?? 0) },
      ],
    },
    {
      title: "Speed",
      min: -0.8,
      max: 0.8,
      unit: "m/s",
      series: [{ label: "v", color: link, get: (r) => r.speed }],
    },
    {
      title: "Heading",
      min: -180,
      max: 180,
      unit: "°",
      series: [
        { label: "yaw", color: fg, get: (r) => r.yaw },
        { label: "tilt", color: amber, get: (r) => r.tilt },
      ],
    },
    {
      title: "Battery",
      min: 4400,
      max: 5400,
      unit: "mV",
      series: [{ label: "V", color: gray, get: (r) => r.mv }],
    },
  ];
}

export class Telemetry {
  private canvas: HTMLCanvasElement;
  private lastDraw = 0;
  window = 10; // seconds shown

  constructor(private host: HTMLElement) {
    this.canvas = document.createElement("canvas");
    this.canvas.className = "telemetry-canvas";
    host.append(this.canvas);
  }

  /**
   * frames: recorded snapshots (time-ordered); cursor: replay time or null when live.
   * Live redraws are limited to 8 per second and drawn at 1 canvas pixel per CSS pixel (crisp pixel look,
   * cheap on weak GPUs); `force` draws immediately (tab switch, scrubbing).
   */
  draw(
    frames: WorldSnapshot[],
    slot: number,
    cursor: number | null,
    force = false,
    printsFor?: (t0: number, t1: number) => Stamped<Record<string, number>>[],
  ) {
    const now = performance.now();
    if (!force && now - this.lastDraw < 125) return;
    this.lastDraw = now;
    const w = this.host.clientWidth;
    const h = this.host.clientHeight;
    if (!w || !h) return;
    const dpr = 1;
    if (this.canvas.width !== Math.round(w * dpr) || this.canvas.height !== Math.round(h * dpr)) {
      this.canvas.width = Math.round(w * dpr);
      this.canvas.height = Math.round(h * dpr);
      this.canvas.style.width = w + "px";
      this.canvas.style.height = h + "px";
    }
    const g = this.canvas.getContext("2d")!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    const fg = css("--fg");
    const rule = css("--rule-soft");
    const muted = css("--muted");
    // text follows the UI text size (Settings)
    const ui = parseFloat(css("--ui")) || 12;
    g.font = `${ui}px 'Departure Mono', monospace`;
    g.textBaseline = "top";

    const list = strips();
    const tEnd = cursor ?? (frames.length ? frames[frames.length - 1].t : 0);
    const tStart = tEnd - this.window;
    // plotter: numbers the program printed (Thonny style), auto-scaled, shown first when present
    const prints = printsFor?.(tStart, tEnd) ?? [];
    if (prints.length) {
      const labels = [...new Set(prints.flatMap((p) => Object.keys(p.v)))].slice(0, 5);
      let lo = Infinity;
      let hi = -Infinity;
      for (const p of prints) for (const l of labels) if (l in p.v) (lo = Math.min(lo, p.v[l])), (hi = Math.max(hi, p.v[l]));
      if (hi - lo < 1e-9) (hi += 1), (lo -= 1);
      const pad = (hi - lo) * 0.08;
      const colors = ["#ff7b72", "#a78bfa", "#10b981", "#f59e0b", "#3a88fe"];
      list.unshift({
        title: "Your print() values",
        min: lo - pad,
        max: hi + pad,
        unit: "",
        series: labels.map((l, i) => {
          const lastP = [...prints].reverse().find((p) => l in p.v);
          return { label: l, color: colors[i], get: () => (lastP ? lastP.v[l] : NaN), key: l };
        }),
      } as Strip);
    }
    const left = 8;
    const right = w - 8;
    const legendW = Math.round(ui * 17);
    const plotL = left + legendW;
    const stripH = Math.max(Math.round(ui * 2.6), Math.floor((h - 8) / list.length));
    const sx = (t: number) => plotL + ((t - tStart) / this.window) * (right - plotL);

    // frames inside the window (binary search for speed with long recordings)
    let lo = 0;
    let hi = frames.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (frames[mid].t < tStart) lo = mid + 1;
      else hi = mid;
    }
    const visible: WorldSnapshot[] = [];
    for (let i = Math.max(0, lo - 1); i < frames.length && frames[i].t <= tEnd + 0.05; i++) visible.push(frames[i]);

    list.forEach((s, k) => {
      const y0 = 4 + k * stripH;
      const y1 = y0 + stripH - 6;
      const sy = (v: number) => y1 - ((Math.min(s.max, Math.max(s.min, v)) - s.min) / (s.max - s.min)) * (y1 - y0);
      // frame + zero line
      g.strokeStyle = rule;
      g.lineWidth = 1;
      g.strokeRect(Math.round(plotL) + 0.5, Math.round(y0) + 0.5, Math.round(right - plotL), Math.round(y1 - y0));
      if (s.min < 0 && s.max > 0) {
        g.beginPath();
        g.setLineDash([2, 3]);
        g.moveTo(plotL, Math.round(sy(0)) + 0.5);
        g.lineTo(right, Math.round(sy(0)) + 0.5);
        g.stroke();
        g.setLineDash([]);
      }
      // legend: title, then the current values in the series' colours (no labels when there are many)
      g.fillStyle = fg;
      g.fillText(s.title.toUpperCase(), left, y0);
      const last = visible.length ? visible[visible.length - 1].robots[slot] : undefined;
      const compact = s.series.length > 3;
      let lx = left;
      s.series.forEach((ser) => {
        const v = last ? ser.get(last) : NaN;
        const num = isFinite(v) ? (Math.abs(v) >= 100 || Number.isInteger(v) ? v.toFixed(0) : v.toFixed(2)) : "–";
        const txt = compact ? num : `${ser.label} ${num}`;
        const w = g.measureText(txt).width;
        if (lx + w + 9 > plotL - 6) return; // no room: skip rather than overlap
        g.fillStyle = ser.color;
        g.fillRect(lx, y0 + ui * 1.45, 5, 5);
        g.fillStyle = muted;
        g.fillText(txt, lx + 8, y0 + ui * 1.27);
        lx += w + (compact ? 12 : 16);
      });
      // printed values: own sample times
      if (s.title === "Your print() values") {
        for (const ser of s.series as (Series & { key: string })[]) {
          g.strokeStyle = ser.color;
          g.lineWidth = 1.5;
          g.beginPath();
          let started = false;
          let prevY = 0;
          for (const p of prints) {
            if (!(ser.key in p.v)) continue;
            const x = Math.max(plotL, sx(p.t));
            const y = sy(p.v[ser.key]);
            if (!started) {
              g.moveTo(x, y);
              started = true;
            } else {
              g.lineTo(x, prevY);
              g.lineTo(x, y);
            }
            prevY = y;
          }
          g.stroke();
        }
        return;
      }
      // series as stepped lines (values change at discrete reads)
      for (const ser of s.series) {
        g.strokeStyle = ser.color;
        g.lineWidth = 1.5;
        g.beginPath();
        let started = false;
        let prevY = 0;
        for (const f of visible) {
          const r = f.robots[slot];
          if (!r) continue;
          const x = Math.max(plotL, sx(f.t));
          const y = sy(ser.get(r));
          if (!started) {
            g.moveTo(x, y);
            started = true;
          } else {
            g.lineTo(x, prevY);
            g.lineTo(x, y);
          }
          prevY = y;
        }
        g.stroke();
      }
    });
    // time axis labels
    g.fillStyle = muted;
    g.fillText(`${tStart.toFixed(1)} s`, plotL + 2, h - ui - 3);
    const endLabel = `${tEnd.toFixed(1)} s`;
    g.fillText(endLabel, right - g.measureText(endLabel).width - 2, h - ui - 3);
    if (cursor !== null) {
      g.strokeStyle = css("--link");
      g.lineWidth = 1;
      g.beginPath();
      g.moveTo(right - 0.5, 0);
      g.lineTo(right - 0.5, h);
      g.stroke();
    }
  }
}
