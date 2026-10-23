// Arenas: one definition drives physics (MJCF), sensors (IR reflectance of the printed surface), the picture
// (texture) and the rules. World coordinates: x right, y up in the top view, z up, metres.

export interface Pose {
  x: number;
  y: number;
  yaw: number;
}

export type Mode = "sumo" | "race" | "koth" | "shuttle" | "free";

export interface Arena {
  id: string;
  name: string;
  mode: Mode;
  /** Short description for the UI */
  blurb: string;
  /** Height of the playing surface */
  surfaceZ: number;
  /** Extent of the texture */
  extent: { x0: number; y0: number; x1: number; y1: number };
  /** IR reflectance at 940 nm of the printed surface (0 absorbs everything, 0.9 = white melamine) */
  reflect(x: number, y: number): number;
  /** Visible colour of the surface (sRGB 0..255) */
  color(x: number, y: number): [number, number, number];
  /** MJCF collision geometry of the arena (the floor plane is added separately) */
  mjcf(): string;
  shape: { kind: "disc"; radius: number; height: number } | { kind: "slab"; w: number; h: number; height: number };
  starts: Pose[];
  maxRobots: number;
  /** true when a robot at this position counts as out (left the arena / touched the floor outside) */
  isOut(x: number, y: number, z: number): boolean;
  /** Match length in seconds (0 = unlimited) */
  timeLimit: number;
  /** Rule geometry */
  zone?: { x: number; y: number; r: number };
  bases?: { x0: number; y0: number; x1: number; y1: number }[];
  finish?: { x: number; y0: number; y1: number };
  /** race: areas a robot must visit (any order) between two finish crossings for the lap to count */
  checkpoints?: { x0: number; y0: number; x1: number; y1: number }[];
  laps?: number;
}

// Palette + helpers, also used by overlay arenas (registered via registerArena).
export const WHITE: [number, number, number] = [236, 238, 242];
export const BLACK: [number, number, number] = [20, 20, 26];
const BROWN: [number, number, number] = [96, 58, 32];
export const GREY: [number, number, number] = [124, 130, 150];
const FINISH: [number, number, number] = [214, 226, 250];

export const R_WHITE = 0.9;
export const R_BLACK = 0.04;
export const R_GREY = 0.35; // raw line value ~300: clearly between white (~110) and black (1024)

export function slabMjcf(w: number, h: number, t: number) {
  return `<geom name="arena" type="box" size="${w / 2} ${h / 2} ${t / 2}" pos="0 0 ${t / 2}" friction="0.1 0.005 0.0001" contype="1" conaffinity="1" group="0"/>`;
}

/** Sumo ring per the Unified Sumo Robot Rules, mini class: Ø 77 cm, 2.5 cm high, black, 2.5 cm white border. */
function dohyo(inverse: boolean): Arena {
  const R = 0.385;
  const H = 0.025;
  const border = 0.025;
  // Shikiri lines: 1 cm wide, 10 cm long, outer edges 10 cm apart (rules art. 3), brown = IR absorbing
  const shikiri = (x: number, y: number) => Math.abs(y) <= 0.05 && Math.abs(Math.abs(x) - 0.045) <= 0.005;
  const inner = inverse ? WHITE : BLACK;
  const edge = inverse ? BLACK : WHITE;
  return {
    id: inverse ? "dohyo-inverse" : "dohyo",
    name: inverse ? "Dohyo inverse (white, black edge)" : "Dohyo 77 cm (mini sumo)",
    mode: "sumo",
    blurb: inverse
      ? "Club test table colours: white ring, black edge. Raw line value > 600 = edge."
      : "Official mini-sumo ring: black, 2.5 cm white border. Raw line value < 500 = edge. First robot out loses.",
    surfaceZ: H,
    extent: { x0: -R, y0: -R, x1: R, y1: R },
    reflect(x, y) {
      const r = Math.hypot(x, y);
      if (r > R) return 0.5;
      if (r > R - border) return inverse ? R_BLACK : R_WHITE;
      if (shikiri(x, y)) return 0.06;
      return inverse ? R_WHITE : R_BLACK;
    },
    color(x, y) {
      const r = Math.hypot(x, y);
      if (r > R - border) return edge;
      if (shikiri(x, y)) return BROWN;
      return inner;
    },
    mjcf: () =>
      `<geom name="arena" type="cylinder" size="${R} ${H / 2}" pos="0 0 ${H / 2}" friction="0.1 0.005 0.0001" contype="1" conaffinity="1" group="0"/>`,
    shape: { kind: "disc", radius: R, height: H },
    starts: [
      { x: -0.115, y: 0, yaw: 0 },
      { x: 0.115, y: 0, yaw: Math.PI },
      { x: 0, y: -0.2, yaw: Math.PI / 2 },
      { x: 0, y: 0.2, yaw: -Math.PI / 2 },
    ],
    maxRobots: 4,
    // Rules art. 14: a robot loses when its body touches the space outside the ring (incl. the ring's side)
    isOut: (x, y, z) => z < H - 0.006 || Math.hypot(x, y) > R + 0.02,
    timeLimit: 180,
  };
}

/** Line track: white board with a 19 mm black tape loop, preview of the Spormula E race. */
function lineTrack(): Arena {
  const W = 1.6;
  const Hh = 1.1;
  const T = 0.004;
  const tape = 0.019 / 2;
  const rx = 0.45;
  const ry = 0.3;
  // Distance to the centre line of the tape: stadium with an S-bend in the top straight
  const sAmp = 0.08;
  const sLen = 0.2;
  function distToPath(x: number, y: number): number {
    let d = Infinity;
    if (x > rx) d = Math.min(d, Math.abs(Math.hypot(x - rx, y) - ry));
    if (x < -rx) d = Math.min(d, Math.abs(Math.hypot(x + rx, y) - ry));
    if (Math.abs(x) <= rx) {
      d = Math.min(d, Math.abs(y + ry));
      // top straight with an S-bend: sample the curve (exact enough at tape width)
      for (let k = -8; k <= 8; k++) {
        const cx = x + k * 0.003;
        if (Math.abs(cx) > rx) continue;
        const cy = ry + (Math.abs(cx) < sLen ? sAmp * Math.sin((cx / sLen) * Math.PI) : 0);
        d = Math.min(d, Math.hypot(x - cx, y - cy));
      }
    }
    return d;
  }
  const onFinish = (x: number, y: number) => Math.abs(x) < 0.006 && y < -ry - 0.03 && y > -ry - 0.09;
  return {
    id: "line",
    name: "Line track (race)",
    mode: "race",
    blurb: "White board, 19 mm black tape loop with an S-bend. Laps are counted at the start/finish line (light marker).",
    surfaceZ: T,
    extent: { x0: -W / 2, y0: -Hh / 2, x1: W / 2, y1: Hh / 2 },
    reflect(x, y) {
      if (Math.abs(x) > W / 2 || Math.abs(y) > Hh / 2) return 0.5;
      return distToPath(x, y) <= tape ? R_BLACK : R_WHITE;
    },
    color(x, y) {
      if (distToPath(x, y) <= tape) return BLACK;
      if (onFinish(x, y)) return FINISH; // visual only, same IR reflectance as white
      return WHITE;
    },
    mjcf: () => slabMjcf(W, Hh, T),
    shape: { kind: "slab", w: W, h: Hh, height: T },
    starts: [
      { x: -0.06, y: -ry, yaw: 0 },
      { x: -0.26, y: -ry, yaw: 0 },
      { x: -0.46, y: -ry + 0.02, yaw: -0.2 },
      { x: 0.2, y: -ry, yaw: 0 },
    ],
    maxRobots: 4,
    // the board is only 4 mm thick, so the height test alone never fires: out = reference point past the edge
    isOut: (x, y, z) => z < T - 0.006 || Math.abs(x) > W / 2 || Math.abs(y) > Hh / 2,
    timeLimit: 120,
    finish: { x: 0, y0: -ry - 0.08, y1: -ry + 0.08 },
    // right curve, the S-bend on the top straight, left curve: circling near the finish line counts nothing
    checkpoints: [
      { x0: rx, y0: -Hh / 2, x1: W / 2, y1: Hh / 2 },
      { x0: -sLen, y0: 0.05, x1: sLen, y1: Hh / 2 },
      { x0: -W / 2, y0: -Hh / 2, x1: -rx, y1: Hh / 2 },
    ],
    laps: 3,
  };
}

/** Free practice: big white board with a black edge band, no rules. */
function free(): Arena {
  const W = 1.5;
  const Hh = 1.0;
  const T = 0.02;
  const band = 0.03;
  const inBand = (x: number, y: number) => Math.abs(x) > W / 2 - band || Math.abs(y) > Hh / 2 - band;
  return {
    id: "free",
    name: "Free practice",
    mode: "free",
    blurb: "White 150 × 100 cm table with a black edge band. No rules, no time limit — for trying things out.",
    surfaceZ: T,
    extent: { x0: -W / 2, y0: -Hh / 2, x1: W / 2, y1: Hh / 2 },
    reflect: (x, y) => (Math.abs(x) > W / 2 || Math.abs(y) > Hh / 2 ? 0.5 : inBand(x, y) ? R_BLACK : R_WHITE),
    color: (x, y) => (inBand(x, y) ? BLACK : WHITE),
    mjcf: () => slabMjcf(W, Hh, T),
    shape: { kind: "slab", w: W, h: Hh, height: T },
    starts: [
      { x: -0.3, y: 0, yaw: 0 },
      { x: 0.3, y: 0, yaw: Math.PI },
      { x: 0, y: -0.25, yaw: Math.PI / 2 },
      { x: 0, y: 0.25, yaw: -Math.PI / 2 },
    ],
    maxRobots: 4,
    isOut: (x, y, z) => z < T - 0.006 || Math.abs(x) > W / 2 + 0.02 || Math.abs(y) > Hh / 2 + 0.02,
    timeLimit: 0,
  };
}

// Arena registry. The core registers the generic practice arenas below. The private competition overlay
// (if present) adds more via registerArena() — that is how the Challenge-1 arenas stay out of the public build.
export const ARENAS: Record<string, () => Arena> = {};

export function registerArena(id: string, make: () => Arena): void {
  ARENAS[id] = make;
}

registerArena("dohyo", () => dohyo(false));
registerArena("dohyo-inverse", () => dohyo(true));
registerArena("line", lineTrack);
registerArena("free", free);

/** Older ids (stored in browsers / scripts) */
const ALIASES: Record<string, string> = { "dohyo-invers": "dohyo-inverse", linie: "line" };

export function arenaById(id: string): Arena {
  const key = Object.hasOwn(ALIASES, id) ? ALIASES[id] : id;
  return (Object.hasOwn(ARENAS, key) ? ARENAS[key] : ARENAS.dohyo)();
}

/** Start poses with a deterministic random jitter (for fair test benches). */
export function jitteredStarts(arena: Arena, count: number, seed: number, amount = 1): Pose[] {
  let s = seed >>> 0 || 1;
  const rnd = () => {
    s = (Math.imul(s ^ (s >>> 15), 0x2c1b3c6d) + 0x6d2b79f5) >>> 0;
    return (s >>> 8) / 16777216 - 0.5;
  };
  // Only move backwards (never over a start line), a little sideways, and turn a little
  return arena.starts.slice(0, count).map((p) => {
    const back = Math.abs(rnd()) * 0.08 * amount;
    const side = rnd() * 0.06 * amount;
    const c = Math.cos(p.yaw);
    const s2 = Math.sin(p.yaw);
    return { x: p.x - c * back - s2 * side, y: p.y - s2 * back + c * side, yaw: p.yaw + rnd() * 0.6 * amount };
  });
}
