// Brand hooks. The public core ships a neutral mark; the private overlay (overlay/brand/) replaces it
// with the SPARK logo star and the Epoch wordmark font via setBrand(). The "SPARK" wordmark text in the
// HTML is a plain name (not a protected asset) and stays; only the font and the star shape are branded.

export const VERSION = "0.2";

export interface Brand {
  /** small square mark as an inline SVG string, coloured with currentColor */
  pixelMark(n?: number, cell?: number): string;
  /** draw the splash mark into a canvas, animated by t seconds */
  drawSplash(canvas: HTMLCanvasElement, t: number, size?: number): void;
}

const BAYER4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map((v) => (v + 0.5) / 16);
const NEUTRAL_PALETTE: [number, number, number][] = [
  [12, 14, 20],
  [40, 52, 80],
  [92, 112, 150],
  [152, 172, 205],
  [236, 238, 245],
];

/** Neutral mark: a plain dithered diamond on an n × n grid. */
function neutralPixelMark(n = 16, cell = 2): string {
  const size = n * cell;
  const c = (n - 1) / 2;
  const r = n * 0.46;
  let rects = "";
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++)
      if (Math.abs(x - c) + Math.abs(y - c) <= r) rects += `<rect x="${x * cell}" y="${y * cell}" width="${cell}" height="${cell}"/>`;
  return `<svg class="pixel-star" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges" fill="currentColor" aria-hidden="true">${rects}</svg>`;
}

/** Neutral splash: a dithered disc (no brand identity). */
function neutralSplash(canvas: HTMLCanvasElement, t: number, size = 200): void {
  if (canvas.width !== size) {
    canvas.width = size;
    canvas.height = size;
  }
  const ctx = canvas.getContext("2d")!;
  const img = ctx.createImageData(size, size);
  const breathe = 1 + 0.04 * Math.sin(t * 1.6);
  const n = NEUTRAL_PALETTE.length - 1;
  for (let j = 0; j < size; j++) {
    const y = -((j + 0.5) / size) * 2 + 1;
    for (let i = 0; i < size; i++) {
      const x = ((i + 0.5) / size) * 2 - 1;
      const r = Math.hypot(x, y);
      const d = r - 0.6 * breathe;
      const I = d < 0 ? 0.6 + 0.5 * Math.exp(d * 40) : 1.0 * Math.exp(-d * 8);
      const b = BAYER4[(j & 3) * 4 + (i & 3)] - 0.5;
      const idx = Math.max(0, Math.min(n, Math.floor(Math.min(1, I) * n + b + 0.5)));
      const c = NEUTRAL_PALETTE[idx];
      const k = (j * size + i) * 4;
      img.data[k] = c[0];
      img.data[k + 1] = c[1];
      img.data[k + 2] = c[2];
      img.data[k + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
}

export const brand: Brand = { pixelMark: neutralPixelMark, drawSplash: neutralSplash };

/** The competition/branding overlay calls this to install the SPARK mark. */
export function setBrand(overrides: Partial<Brand>): void {
  Object.assign(brand, overrides);
}
