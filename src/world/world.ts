// The world: MuJoCo physics, motor/battery model, sensors of all robots, rules and the lockstep scheduler.
// Runs unchanged in the browser (web worker) and in Node (tests, benches); knows neither the DOM nor workers.

import type { Arena, Pose } from "../shared/arenas.ts";
import { C, NOMINAL, OP, ST, type RobotChannel, type RobotSnapshot, type WorldEvent, type WorldSnapshot, type WorldTweaks } from "../shared/protocol.ts";
import { COST_US, ZUMO } from "../shared/zumo-spec.ts";
import { buildMjcf, DRIVEN } from "./mjcf.ts";
import { Rules } from "./rules.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Mujoco = any;

export const DT_US = 1000;
const TAU = Math.PI * 2;
const DEG = Math.PI / 180;
/** roller (outer radius) -> sprocket (pitch radius) */
const K_TRACK = ZUMO.outerRadius / ZUMO.pitchRadius;
const RULES_EVERY = 5; // physics steps between rule evaluations
const SETTLE_STEPS = 150; // physics steps before t = 0 to let the robots come to rest
/** proximity: ray directions of one receiver's fan, relative to its axis (degrees) */
const PROX_KS: number[] = [];
for (let k = -ZUMO.proxFov; k <= ZUMO.proxFov + 1e-9; k += ZUMO.proxRayStep) PROX_KS.push(k);
/** sample points of a line sensor's light spot: centre and two rings, Gaussian weights [dx, dy, w] */
const SPOT: [number, number, number][] = (() => {
  const sg = ZUMO.lineSpotSigma;
  const pts: [number, number, number][] = [[0, 0, 1]];
  for (const [r, w] of [[sg, Math.exp(-0.5)], [2 * sg, Math.exp(-2)]])
    for (let k = 0; k < 6; k++) pts.push([r * Math.cos((k * TAU) / 6 + r * 1e3), r * Math.sin((k * TAU) / 6 + r * 1e3), w]);
  const sum = pts.reduce((a, p) => a + p[2], 0);
  return pts.map(([x, y, w]) => [x, y, w / sum]);
})();

// --- Motor constants at the gearbox output, from the 6 V datasheet values
const M = ZUMO.motor;
const W0 = (M.noLoadRpm / 60) * TAU;
const R_MOTOR = 6 / M.stallA;
const KE = (6 - M.noLoadA * R_MOTOR) / W0;
const KT = M.stallNm / M.stallA;
const TAU_FRICTION = KT * M.noLoadA;

export function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class Rand {
  private next: () => number;
  constructor(seed: number) {
    this.next = mulberry32(seed);
  }
  uniform() {
    return this.next();
  }
  gauss(sigma = 1) {
    const u = Math.max(this.next(), 1e-12);
    return sigma * Math.sqrt(-2 * Math.log(u)) * Math.cos(TAU * this.next());
  }
}

const GEOM = { world: 0, hull: 1, blade: 2, roller: 3, arena: 4, floor: 5 } as const;

/** A request that takes time in the world: sampled at `sampleAt`, answered at `doneAt` (µs). */
interface Deferred {
  sampleAt: number;
  doneAt: number;
  levels?: number[];
  values?: number[];
}

interface RobotState {
  slot: number;
  name: string;
  body: number;
  freeQpos: number;
  freeDof: number;
  qpos: [number, number];
  dof: [number, number];
  act: [number, number];
  accAdr: number;
  gyroAdr: number;
  cmd: [number, number];
  kMotor: [number, number];
  lineGain: number[];
  gyroBias: number[];
  magOffset: number[];
  soc: number;
  vbat: number;
  rand: Rand;
  last: { line: number[]; prox: number[]; imu: number[]; mv: number };
  out: boolean;
  // lockstep
  chan?: RobotChannel;
  active: boolean;
  /** lower bound of the clock while the program is computing */
  bound: number;
  deferred?: Deferred;
  /** dof addresses of the 8 rollers (zeroed when the robot is placed) */
  rollerDofs: number[];
  /** wall clock (ms) of the last sign of life from the program, for the watchdog */
  lastAlive: number;
  /** the program has made its first request (MicroPython has finished loading) */
  started: boolean;
  /** chassis height above the surface at rest (measured after settling) */
  restZ: number;
}

export interface WorldOptions {
  seed?: number;
  proxThreshold?: number;
  names?: string[];
  /** press button A on all attached robots at this sim time (s) for 100 ms */
  autoPressA?: number | null;
  /** scheduled button presses (100 ms each) on all attached robots, in sim time — deterministic */
  presses?: { button: "A" | "B" | "C"; t: number }[];
  /** battery, grip and sensor noise for robustness tests */
  tweaks?: WorldTweaks;
}

export class World {
  readonly m: Mujoco;
  readonly d: Mujoco;
  readonly robots: RobotState[] = [];
  readonly rules: Rules;
  tUs = 0;
  proxThreshold: number;
  events: WorldEvent[] = [];
  /** false = preview (no programs loaded): physics and sensors run, but there is no match to judge */
  judging = true;

  private geomKind: Int8Array;
  private geomRobot: Int16Array;
  private arenaGeom: number;
  private idBuf: Mujoco;
  private normBuf: Mujoco;
  private fanGeom: Mujoco;
  private fanDist: Mujoco;
  private fanNorm: Mujoco;
  private steps = 0;
  private lastJudgeUs = 0;
  /** scheduled presses (robots read them from their own clock, see RobotJob.presses); the first A is the start signal */
  private presses: { idx: number; at: number }[];
  /** live presses from the UI start signal: written to the robots' channels until `until` */
  private livePresses: { idx: number; until: number }[] = [];
  readonly tweaks: WorldTweaks;
  private static fileCounter = 0;

  constructor(
    readonly mj: Mujoco,
    readonly arena: Arena,
    poses: Pose[],
    opt: WorldOptions = {},
  ) {
    this.tweaks = { ...NOMINAL, ...opt.tweaks };
    const seed = opt.seed ?? 1;
    // unit-to-unit blade edge (height and tilt): decides who gets under whom in a head-on hit. Own random
    // stream, so the other per-robot spreads below stay the same for a given seed.
    const blade = (i: number) => {
      const rnd = new Rand(seed * 7919 + i * 104729 + 17);
      const gap = Math.min(0.0008, Math.max(0.00015, ZUMO.bladeGap + rnd.gauss(ZUMO.bladeGapSpread)));
      const maxTilt = 2 * (gap - 0.00025); // the lower end stays 0.25 mm above the ground (also when pitching)
      return { bladeGap: gap, bladeTilt: Math.max(-maxTilt, Math.min(maxTilt, rnd.gauss(ZUMO.bladeTiltSpread))) };
    };
    const xml = buildMjcf(arena, poses, poses.map((_, i) => ({ grip: this.tweaks.grip, ...blade(i) })));
    try {
      mj.FS.mkdir("/spark");
    } catch {
      /* exists */
    }
    const path = `/spark/world${World.fileCounter++}.xml`;
    mj.FS.writeFile(path, xml);
    this.m = mj.MjModel.mj_loadXML(path);
    mj.FS.unlink(path);
    this.d = new mj.MjData(this.m);
    this.idBuf = new mj.IntBuffer(1);
    this.normBuf = new mj.DoubleBuffer(3);
    this.fanGeom = new mj.IntBuffer(PROX_KS.length);
    this.fanDist = new mj.DoubleBuffer(PROX_KS.length);
    this.fanNorm = new mj.DoubleBuffer(PROX_KS.length * 3);
    const idx = { A: C.BtnA, B: C.BtnB, C: C.BtnC };
    this.presses = (opt.presses ?? []).map((p) => ({ idx: idx[p.button], at: p.t * 1e6 }));
    if (opt.autoPressA !== undefined && opt.autoPressA !== null) this.presses.push({ idx: C.BtnA, at: opt.autoPressA * 1e6 });

    const id = (type: string, name: string) => {
      const i = mj.mj_name2id(this.m, mj.mjtObj[type].value, name);
      if (i < 0) throw new Error(`MJCF: ${name} missing`);
      return i;
    };
    const m = this.m;
    this.arenaGeom = id("mjOBJ_GEOM", "arena");
    const floorGeom = id("mjOBJ_GEOM", "floor");
    this.geomKind = new Int8Array(m.ngeom);
    this.geomRobot = new Int16Array(m.ngeom).fill(-1);

    poses.forEach((_, i) => {
      const p = `r${i}_`;
      const body = id("mjOBJ_BODY", p + "chassis");
      const free = id("mjOBJ_JOINT", p + "free");
      const jl = id("mjOBJ_JOINT", `${p}l${DRIVEN}`);
      const jr = id("mjOBJ_JOINT", `${p}r${DRIVEN}`);
      const rand = new Rand(seed * 7919 + i * 104729);
      this.robots.push({
        slot: i,
        name: opt.names?.[i] ?? `Robot ${i + 1}`,
        body,
        freeQpos: m.jnt_qposadr[free],
        freeDof: m.jnt_dofadr[free],
        qpos: [m.jnt_qposadr[jl], m.jnt_qposadr[jr]],
        dof: [m.jnt_dofadr[jl], m.jnt_dofadr[jr]],
        act: [id("mjOBJ_ACTUATOR", p + "ml"), id("mjOBJ_ACTUATOR", p + "mr")],
        accAdr: m.sensor_adr[id("mjOBJ_SENSOR", p + "acc")],
        gyroAdr: m.sensor_adr[id("mjOBJ_SENSOR", p + "gyro")],
        cmd: [0, 0],
        kMotor: [1 + rand.gauss(M.spread), 1 + rand.gauss(M.spread)],
        lineGain: [0, 1, 2, 3, 4].map(() => 1 + rand.gauss(ZUMO.lineGainSpread)),
        gyroBias: [rand.gauss(ZUMO.imuNoise.gyroBias), rand.gauss(ZUMO.imuNoise.gyroBias), rand.gauss(ZUMO.imuNoise.gyroBias)],
        magOffset: [rand.gauss(0.05), rand.gauss(0.05), rand.gauss(0.05)],
        soc: Math.max(0, Math.min(1, this.tweaks.battery)),
        vbat: ZUMO.battery.vEmpty + (ZUMO.battery.vFull - ZUMO.battery.vEmpty) * Math.max(0, Math.min(1, this.tweaks.battery)),
        rand,
        last: { line: [0, 0, 0, 0, 0], prox: [0, 0, 0, 0, 0, 0], imu: [0, 0, 0, 0, 0, 0, 0, 0, 0], mv: 0 },
        out: false,
        active: false,
        bound: 0,
        rollerDofs: ["l", "r"].flatMap((side) => [0, 1, 2, 3].map((k) => m.jnt_dofadr[id("mjOBJ_JOINT", `${p}${side}${k}`)])),
        lastAlive: 0,
        started: false,
        restZ: 0.0005,
      });
    });

    const robotOfBody = (b: number) => {
      // rollers are child bodies of the chassis: walk up to the chassis
      while (b > 0) {
        const i = this.robots.findIndex((r) => r.body === b);
        if (i >= 0) return i;
        b = m.body_parentid[b];
      }
      return -1;
    };
    for (let g = 0; g < m.ngeom; g++) {
      const robot = robotOfBody(m.geom_bodyid[g]);
      this.geomRobot[g] = robot;
      if (g === this.arenaGeom) this.geomKind[g] = GEOM.arena;
      else if (g === floorGeom) this.geomKind[g] = GEOM.floor;
      else if (m.geom_group[g] === 2) this.geomKind[g] = GEOM.roller;
      else if (robot >= 0)
        this.geomKind[g] = g === id("mjOBJ_GEOM", `r${robot}_blade`) || g === id("mjOBJ_GEOM", `r${robot}_bladetip`) ? GEOM.blade : GEOM.hull;
      else this.geomKind[g] = GEOM.world;
    }
    // motor braking and gearbox friction at the driven rollers (see step())
    {
      const damping = this.m.dof_damping;
      const friction = this.m.dof_frictionloss;
      const frictionRef = this.m.dof_solref; // [timeconst, dampratio] of the friction constraint
      for (const r of this.robots)
        for (let s = 0; s < 2; s++) {
          damping[r.dof[s]] = ((KT * KE) / R_MOTOR) * r.kMotor[s] * K_TRACK * K_TRACK;
          friction[r.dof[s]] = TAU_FRICTION * K_TRACK;
          frictionRef[r.dof[s] * 2] = 2 * DT_US / 1e6; // stiffest stable setting: holds without creeping
        }
    }
    // let the robots settle on their tracks before t = 0 (they are built slightly above the surface), so the
    // accelerometer starts at 1 g instead of a drop and a bounce
    for (let k = 0; k < SETTLE_STEPS; k++) mj.mj_step(m, this.d);
    this.d.qvel.fill(0);
    mj.mj_forward(m, this.d);
    for (const r of this.robots) r.restZ = this.d.qpos[r.freeQpos + 2] - arena.surfaceZ;
    this.proxThreshold = opt.proxThreshold ?? 1;
    this.rules = new Rules(arena, this.robots.length);
  }

  dispose() {
    this.idBuf.delete();
    this.normBuf.delete();
    this.fanGeom.delete();
    this.fanDist.delete();
    this.fanNorm.delete();
    this.d.delete();
    this.m.delete();
  }

  // ------------------------------------------------------------------ physics

  step() {
    const d = this.d;
    const qvel = d.qvel;
    const ctrl = d.ctrl;
    const dt = DT_US / 1e6;
    const B = ZUMO.battery;
    for (const r of this.robots) {
      let iBatt = B.logicA;
      for (let s = 0; s < 2; s++) {
        const duty = r.cmd[s] / ZUMO.maxSpeed;
        const ws = qvel[r.dof[s]] * K_TRACK; // sprocket rad/s
        const u = duty * r.vbat; // DRV8838 with the off phase braking (slow decay) -> average model
        const i = (u - KE * ws) / R_MOTOR;
        // only the driving part is a control torque; the back-EMF braking (joint damping) and the gearbox
        // friction (frictionloss) are in the model, where the solver handles them implicitly: a robot at rest
        // is held like a real 75:1 gearmotor instead of creeping
        ctrl[r.act[s]] = ((KT * u) / R_MOTOR) * r.kMotor[s] * K_TRACK;
        iBatt += Math.max(0, duty * i);
      }
      const voc = B.vEmpty + (B.vFull - B.vEmpty) * r.soc;
      r.vbat = voc - iBatt * B.rInternal;
      r.soc = Math.max(0, r.soc - (iBatt * dt) / 3600 / B.capacityAh);
    }
    this.mj.mj_step(this.m, d);
    this.tUs += DT_US;
    const xpos = d.xpos;
    let newlyOut = false;
    for (const r of this.robots) {
      if (!r.out && this.arena.isOut(xpos[r.body * 3], xpos[r.body * 3 + 1], xpos[r.body * 3 + 2])) {
        r.out = true;
        newlyOut = true;
      }
    }
    this.pressButtons();
    // judge every few steps, and immediately when someone left the arena (exact, deterministic decision time)
    if (++this.steps % RULES_EVERY === 0 || newlyOut) this.judge();
  }

  advanceTo(tUs: number) {
    while (this.tUs + DT_US <= tUs) this.step();
  }

  private judge() {
    const dt = (this.tUs - this.lastJudgeUs) / 1e6;
    this.lastJudgeUs = this.tUs;
    if (!this.judging) return;
    const xpos = this.d.xpos;
    const views = this.robots.map((r) => ({
      x: xpos[r.body * 3],
      y: xpos[r.body * 3 + 1],
      z: xpos[r.body * 3 + 2],
      out: r.out,
      moving: r.cmd[0] !== 0 || r.cmd[1] !== 0,
      name: r.name,
    }));
    const t = this.tUs / 1e6;
    for (const e of this.rules.step(t, dt, views)) this.events.push({ ...e, t });
  }

  private pressButtons() {
    // scheduled presses: robots see them from their own clock; here only the start signal is judged
    if (this.rules.state.signal === null)
      for (const p of this.presses)
        if (p.idx === C.BtnA && this.tUs >= p.at) for (const e of this.rules.signal(p.at / 1e6)) this.events.push({ ...e, t: p.at / 1e6 });
    // a live start signal from the UI: button A down on every robot for 100 ms of sim time
    if (this.livePresses.length) {
      for (const p of this.livePresses) {
        const down = this.tUs < p.until ? 1 : 0;
        for (const r of this.robots) if (r.chan) Atomics.store(r.chan.ctl, p.idx, down);
      }
      this.livePresses = this.livePresses.filter((p) => this.tUs < p.until);
    }
  }

  /** The start signal now (UI): presses A on every robot like the referee's start, starts the 5 s countdown. */
  startSignal() {
    if (this.rules.state.signal !== null) return;
    const t = this.tUs / 1e6;
    for (const e of this.rules.signal(t)) this.events.push({ ...e, t });
    this.livePresses.push({ idx: C.BtnA, until: this.tUs + 100_000 });
  }

  place(slot: number, pose: Pose) {
    const r = this.robots[slot];
    if (!r) return;
    const q = this.d.qpos;
    const v = this.d.qvel;
    q[r.freeQpos] = pose.x;
    q[r.freeQpos + 1] = pose.y;
    q[r.freeQpos + 2] = this.arena.surfaceZ + r.restZ;
    q[r.freeQpos + 3] = Math.cos(pose.yaw / 2);
    q[r.freeQpos + 4] = 0;
    q[r.freeQpos + 5] = 0;
    q[r.freeQpos + 6] = Math.sin(pose.yaw / 2);
    for (let k = 0; k < 6; k++) v[r.freeDof + k] = 0;
    for (const dof of r.rollerDofs) v[dof] = 0;
    r.out = false;
    this.rules.revive(slot); // moved back into the arena by hand: in play again
    this.mj.mj_forward(this.m, this.d);
  }

  // ------------------------------------------------------------------ geometry helpers

  private toWorld(r: RobotState, lx: number, ly: number, lz: number, out: number[] = [0, 0, 0]) {
    const p = this.d.xpos;
    const R = this.d.xmat;
    const b = r.body;
    out[0] = p[b * 3] + R[b * 9] * lx + R[b * 9 + 1] * ly + R[b * 9 + 2] * lz;
    out[1] = p[b * 3 + 1] + R[b * 9 + 3] * lx + R[b * 9 + 4] * ly + R[b * 9 + 5] * lz;
    out[2] = p[b * 3 + 2] + R[b * 9 + 6] * lx + R[b * 9 + 7] * ly + R[b * 9 + 8] * lz;
    return out;
  }

  private dirWorld(r: RobotState, lx: number, ly: number, lz: number, out: number[] = [0, 0, 0]) {
    const R = this.d.xmat;
    const b = r.body;
    out[0] = R[b * 9] * lx + R[b * 9 + 1] * ly + R[b * 9 + 2] * lz;
    out[1] = R[b * 9 + 3] * lx + R[b * 9 + 4] * ly + R[b * 9 + 5] * lz;
    out[2] = R[b * 9 + 6] * lx + R[b * 9 + 7] * ly + R[b * 9 + 8] * lz;
    return out;
  }

  /** World vector into robot coordinates (rotation only) */
  private toLocalDir(body: number, v: ArrayLike<number>) {
    const R = this.d.xmat;
    const b = body * 9;
    return [
      R[b] * v[0] + R[b + 3] * v[1] + R[b + 6] * v[2],
      R[b + 1] * v[0] + R[b + 4] * v[1] + R[b + 7] * v[2],
      R[b + 2] * v[0] + R[b + 5] * v[1] + R[b + 8] * v[2],
    ];
  }

  private ray(p: number[], v: number[], groups: number[], exclude: number): { d: number; geom: number } {
    const dist = this.mj.mj_ray(this.m, this.d, p, v, groups, 1, exclude, this.idBuf, this.normBuf);
    return { d: dist, geom: this.idBuf.GetView()[0] };
  }

  // ------------------------------------------------------------------ sensors

  /** 5 raw values like LineSensors.read(): small = bright, TIMEOUT = black / nothing below */
  readLine(r: RobotState, emitters: boolean): number[] {
    const out: number[] = [];
    const down = this.dirWorld(r, 0, 0, -1);
    const T = ZUMO.lineTimeout;
    ZUMO.lineSensors.forEach(([sx, sy], i) => {
      if (!emitters) {
        out.push(T); // no ambient IR modelled: without emitters nothing discharges early
        return;
      }
      const p = this.toWorld(r, sx, sy, ZUMO.lineSensorZ + 0.002);
      const hit = this.ray(p, down, [1, 0, 0, 0, 0, 0], -1);
      let light = 0;
      if (hit.d >= 0) {
        const h = hit.d - 0.002;
        const hx = p[0] + down[0] * hit.d;
        const hy = p[1] + down[1] * hit.d;
        let refl = 0.5;
        if (hit.geom === this.arenaGeom) {
          refl = 0;
          for (const [dx, dy, w] of SPOT) refl += w * this.arena.reflect(hx + dx, hy + dy);
        }
        const heightGain = Math.min(1, Math.max(0, 1 - (h - 0.003) / 0.007)); // EST: full up to 3 mm, nothing from 10 mm
        light = refl * heightGain * r.lineGain[i];
      }
      const v = (ZUMO.lineWhite * 0.9) / Math.max(light, 1e-3);
      out.push(Math.round(Math.min(T, Math.max(0, v * (1 + r.rand.gauss(0.03 * this.tweaks.noise))))));
    });
    r.last.line = out;
    return out;
  }

  /** Received IR signal per receiver and LED group: [[lL, lR], [fL, fR], [rL, rR]] */
  proxSignals(r: RobotState): number[][] {
    const Z = ZUMO;
    const leds = (["left", "right"] as const).map((g) =>
      Z.proxLeds[g].map((l) => ({
        p: this.toWorld(r, l.pos[0], l.pos[1], Z.proxLedZ),
        a: this.dirWorld(r, Math.cos(l.dir * DEG), Math.sin(l.dir * DEG), 0),
        half: l.half,
      })),
    );
    const groups = [1, 1, 0, 0, 0, 0];
    const v = [0, 0, 0];
    const n = PROX_KS.length;
    const dirs = new Array<number>(n * 3);
    return Z.proxSensors.map((s) => {
      const o = this.toWorld(r, s.pos[0], s.pos[1], Z.proxSensorZ);
      const sig = [0, 0];
      for (let j = 0; j < n; j++) {
        const a = (s.dir + PROX_KS[j]) * DEG;
        this.dirWorld(r, Math.cos(a), Math.sin(a), 0, v);
        dirs[j * 3] = v[0];
        dirs[j * 3 + 1] = v[1];
        dirs[j * 3 + 2] = v[2];
      }
      // the whole fan in one call: crossing the JS/WASM boundary once per ray cost 14x more
      this.mj.mj_multiRay(this.m, this.d, o, dirs, groups, 1, r.body, this.fanGeom, this.fanDist, this.fanNorm, n, Z.proxMaxDist);
      const geoms = Array.from(this.fanGeom.GetView() as Int32Array);
      const dists = Array.from(this.fanDist.GetView() as Float64Array);
      const norms = Array.from(this.fanNorm.GetView() as Float64Array);
      for (let j = 0; j < n; j++) {
        const d = dists[j];
        if (d < 0 || d > Z.proxMaxDist) continue;
        const h = [o[0] + dirs[j * 3] * d, o[1] + dirs[j * 3 + 1] * d, o[2] + dirs[j * 3 + 2] * d];
        const refl = this.reflectivity(geoms[j], h, norms.slice(j * 3, j * 3 + 3));
        if (refl <= 0) continue;
        const recv = Math.cos(PROX_KS[j] * DEG) * refl;
        for (let g = 0; g < 2; g++) {
          let e = 0;
          for (const led of leds[g]) {
            const dx = h[0] - led.p[0];
            const dy = h[1] - led.p[1];
            const dz = h[2] - led.p[2];
            const d2 = dx * dx + dy * dy + dz * dz + 1e-4;
            const cosA = (dx * led.a[0] + dy * led.a[1] + dz * led.a[2]) / Math.sqrt(d2);
            const ang = Math.acos(Math.max(-1, Math.min(1, cosA))) / DEG;
            e += Math.exp(-0.6931 * (ang / led.half) ** 2) / d2;
          }
          sig[g] += e * recv;
        }
      }
      return sig;
    });
  }

  private reflectivity(geom: number, hit: number[], normal: ArrayLike<number>): number {
    const R = ZUMO.reflect;
    switch (this.geomKind[geom]) {
      case GEOM.blade:
        return R.blade;
      case GEOM.hull: {
        const robot = this.robots[this.geomRobot[geom]];
        const nl = this.toLocalDir(robot.body, normal);
        return Math.abs(nl[1]) > 0.7 ? R.track : R.hull;
      }
      case GEOM.arena:
        return this.arena.reflect(hit[0], hit[1]);
      case GEOM.floor:
        return 0.5;
      case GEOM.world:
        return R.wall;
      default:
        return 0;
    }
  }

  /** 6 counts like ProximitySensors after read(): ll lr fl fr rl rr */
  readProx(r: RobotState, noise = true, levels: readonly number[] = ZUMO.proxLevels): number[] {
    const sig = this.proxSignals(r);
    const out: number[] = [];
    for (const s of sig) {
      for (const g of s) {
        const n = noise ? Math.exp(r.rand.gauss(ZUMO.proxNoise * this.tweaks.noise)) : 1;
        let c = 0;
        for (const level of levels) if (level * g * n >= this.proxThreshold) c++;
        out.push(c);
      }
    }
    r.last.prox = out;
    return out;
  }

  /** acc (g), gyro (dps), mag (gauss) in robot coordinates: x forward, y left, z up */
  readImu(r: RobotState): number[] {
    const sd = this.d.sensordata;
    const N = ZUMO.imuNoise;
    const k = this.tweaks.noise;
    const g = 9.80665;
    const acc = [0, 1, 2].map((i) => sd[r.accAdr + i] / g + r.rand.gauss(N.acc * k));
    const gyro = [0, 1, 2].map((i) => sd[r.gyroAdr + i] / DEG + r.gyroBias[i] * k + r.rand.gauss(N.gyro * k));
    const mag = this.toLocalDir(r.body, ZUMO.earthField).map((v, i) => v + r.magOffset[i] * k + r.rand.gauss(N.mag * k));
    const out = [...acc, ...gyro, ...mag];
    r.last.imu = out;
    return out;
  }

  readEncoders(r: RobotState): [number, number] {
    const q = this.d.qpos;
    const c = (s: 0 | 1) => Math.round(((q[r.qpos[s]] * K_TRACK) / TAU) * ZUMO.encoderCpr);
    return [c(0), c(1)];
  }

  readBattery(r: RobotState): number {
    const mv = Math.round(r.vbat * 1000 + r.rand.gauss(8));
    r.last.mv = mv;
    return mv;
  }

  /** Threshold such that a frontal Zumo at ZUMO.proxRange is just detected at the brightest level. */
  static calibrateProx(mj: Mujoco, arena: Arena): number {
    const x0 = -0.2;
    const target = x0 + ZUMO.proxSensors[1].pos[0] + ZUMO.proxRange + ZUMO.front;
    const w = new World(mj, arena, [
      { x: x0, y: 0, yaw: 0 },
      { x: target, y: 0, yaw: Math.PI },
    ]);
    const sig = w.proxSignals(w.robots[0]);
    w.dispose();
    const levels = ZUMO.proxLevels;
    return levels[levels.length - 1] * Math.max(sig[1][0], sig[1][1]) * 0.999;
  }

  // ------------------------------------------------------------------ lockstep

  attach(slot: number, chan: RobotChannel) {
    const r = this.robots[slot];
    if (!r) return;
    r.chan = chan;
    r.active = true;
    r.bound = this.tUs;
    r.lastAlive = performance.now();
  }

  detach(slot: number) {
    const r = this.robots[slot];
    if (!r) return;
    r.active = false;
    r.deferred = undefined;
  }

  /** Effective time of a pending request: deferred operations first sample, then answer later. */
  private requestTime(r: RobotState): number {
    const d = r.deferred;
    if (d) return d.values ? d.doneAt : d.sampleAt;
    return r.chan!.f64[0];
  }

  /**
   * Serves one request at its time (physics is already advanced there). Returns true when the robot was answered.
   * f64[0] holds the clock after the operation. Arguments are read BEFORE results are written.
   */
  private serve(r: RobotState): boolean {
    const f64 = r.chan!.f64;
    const op = Atomics.load(r.chan!.ctl, C.Op);
    const t = f64[0];
    const a = f64[1];
    const b = f64[2];
    switch (op) {
      case OP.Sync:
        break;
      case OP.Sleep:
        f64[0] = t + Math.max(0, a);
        break;
      case OP.Motors: {
        const clamp = (v: number) => Math.max(-ZUMO.maxSpeed, Math.min(ZUMO.maxSpeed, Math.round(v)));
        r.cmd = [clamp(a), clamp(b)];
        f64[0] = t + COST_US.motors;
        break;
      }
      case OP.Line: {
        // The PIO counts the full window regardless of the surface: constant duration
        const v = this.readLine(r, a !== 0);
        for (let i = 0; i < 5; i++) f64[1 + i] = v[i];
        f64[0] = t + COST_US.lineRead;
        break;
      }
      case OP.Prox: {
        // args: carrier Hz, pulse on µs, pulse off µs, number of levels, levels...
        // Each level is pulsed once per LED group. Sample in the middle, answer at the end.
        if (!r.deferred) {
          const on = f64[2] > 0 ? f64[2] : 250;
          const off = f64[3] > 0 ? f64[3] : 321;
          const n = Math.max(0, Math.min(8, Math.round(f64[4])));
          const levels: number[] = [];
          for (let i = 0; i < n; i++) levels.push(f64[5 + i]);
          const total = 2 * n * (on + off) + COST_US.proxOverhead;
          r.deferred = { sampleAt: t + total / 2, doneAt: t + total, levels };
          return false;
        }
        if (!r.deferred.values) {
          r.deferred.values = this.readProx(r, true, r.deferred.levels);
          return false;
        }
        const v = r.deferred.values;
        for (let i = 0; i < 6; i++) f64[1 + i] = v[i];
        f64[0] = r.deferred.doneAt;
        r.deferred = undefined;
        break;
      }
      case OP.Imu: {
        const mask = a > 0 ? a : 7;
        const v = this.readImu(r);
        for (let i = 0; i < 9; i++) f64[1 + i] = v[i];
        const parts = (mask & 1 ? 1 : 0) + (mask & 2 ? 1 : 0) + (mask & 4 ? 1 : 0);
        f64[0] = t + COST_US.imuPerSensor * parts;
        break;
      }
      case OP.Enc: {
        const [l, rr] = this.readEncoders(r);
        f64[1] = l;
        f64[2] = rr;
        f64[0] = t + COST_US.enc;
        break;
      }
      case OP.Battery:
        f64[1] = this.readBattery(r);
        f64[0] = t + COST_US.battery;
        break;
      default:
        f64[0] = t; // unknown request (only possible by tampering with the runtime): answer like a sync
        break;
    }
    return true;
  }

  /**
   * Serves requests in time order up to at most `limitUs` sim time or until the wall-clock budget is used.
   * Returns "paced" (stopped at the time limit), "budget" (time is up) or "idle" (no program, no limit).
   */
  pump(bell: Int32Array, limitUs: number, budgetMs: number): "paced" | "budget" | "idle" {
    const deadline = performance.now() + budgetMs;
    while (performance.now() < deadline) {
      const ring = Atomics.load(bell, 0);
      let next: RobotState | undefined;
      let nextT = Infinity;
      let running = Infinity;
      let runningSlot = Infinity; // lowest slot among programs computing at exactly `running`
      const wall = performance.now();
      for (const r of this.robots) {
        if (!r.active || !r.chan) continue;
        const st = Atomics.load(r.chan.ctl, C.State);
        if (st === ST.Request) {
          r.lastAlive = wall;
          r.started = true;
          const t = this.requestTime(r);
          if (t < nextT) {
            nextT = t;
            next = r;
          }
        } else if (st === ST.Done) {
          r.active = false;
          r.deferred = undefined;
        } else if (r.bound < running) {
          running = r.bound;
          runningSlot = r.slot;
        } else if (r.bound === running) {
          runningSlot = Math.min(runningSlot, r.slot);
        }
      }
      // strict order: equal times go by slot, so runs are reproducible regardless of thread timing
      if (next && (nextT < running || (nextT === running && next.slot < runningSlot))) {
        if (nextT > limitUs) {
          this.advanceTo(limitUs);
          return "paced";
        }
        this.advanceTo(nextT);
        if (this.serve(next)) {
          const ch = next.chan!;
          next.bound = ch.f64[0];
          Atomics.store(ch.ctl, C.State, ST.Response);
          Atomics.notify(ch.ctl, C.State);
        }
        continue;
      }
      if (running < Infinity) {
        // a program is computing: physics may run up to its clock, then wait for the bell
        this.advanceTo(Math.min(limitUs, running));
        Atomics.wait(bell, 0, ring, 2);
        continue;
      }
      if (limitUs === Infinity) return "idle";
      this.advanceTo(limitUs);
      return "paced";
    }
    return "budget";
  }

  /**
   * Programs that have not answered for `limitMs` of wall time (e.g. a single statement computing forever, or a
   * crashed worker) are detached so the others are not frozen. Returns the affected slots.
   */
  watchdog(limitMs = 5000): number[] {
    const now = performance.now();
    const hung: number[] = [];
    for (const r of this.robots) {
      if (!r.active || !r.chan) continue;
      const st = Atomics.load(r.chan.ctl, C.State);
      if (st === ST.Request) continue;
      // loading MicroPython the first time may take a while on slow machines
      if (now - r.lastAlive > (r.started ? limitMs : limitMs * 4)) {
        this.detach(r.slot);
        hung.push(r.slot);
        this.events.push({
          kind: "hang",
          slot: r.slot,
          text: `${r.name} stopped responding (no world access for ${Math.round(limitMs / 1000)} s of real time) — program detached`,
          t: this.tUs / 1e6,
        });
      }
    }
    return hung;
  }

  snapshot(realtime: number): WorldSnapshot {
    const d = this.d;
    const robots: RobotSnapshot[] = this.robots.map((r) => {
      const b = r.body;
      const q = d.qpos;
      const R = d.xmat;
      const fx = R[b * 9];
      const fy = R[b * 9 + 3];
      const speed = (d.qvel[r.freeDof] * fx + d.qvel[r.freeDof + 1] * fy) / Math.max(1e-6, Math.hypot(fx, fy));
      return {
        pos: [d.xpos[b * 3], d.xpos[b * 3 + 1], d.xpos[b * 3 + 2]],
        quat: [d.xquat[b * 4], d.xquat[b * 4 + 1], d.xquat[b * 4 + 2], d.xquat[b * 4 + 3]],
        sprocket: [q[r.qpos[0]] * K_TRACK, q[r.qpos[1]] * K_TRACK],
        motors: [r.cmd[0], r.cmd[1]],
        line: r.last.line,
        prox: r.last.prox,
        imu: r.last.imu,
        enc: this.readEncoders(r),
        mv: Math.round(r.vbat * 1000),
        speed,
        yaw: Math.atan2(fy, fx) / DEG,
        tilt: Math.acos(Math.max(-1, Math.min(1, R[b * 9 + 8]))) / DEG,
        out: r.out,
      };
    });
    return { t: this.tUs / 1e6, realtime, robots, match: structuredClone(this.rules.state) };
  }
}
