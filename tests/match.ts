// Headless match: real MicroPython programs against each other, no browser.
//   npx tsx tests/match.ts a.py b.py [--arena dohyo] [--seconds 20] [--press A@0.2] [--seed 1] [--jitter 1]
// --press X@t presses button X on all robots at sim time t (seconds) for 100 ms.
// SPARK_TRACE=1 prints positions, motors and the sensor values the program last read, every second; SPARK_DEBUG=<ms> the lockstep channel state.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import loadMujoco from "mujoco";
import { arenaById, jitteredStarts, type Pose } from "../src/shared/arenas.ts";
import { C, makeBell, makeChannelBuffers, openChannel, type FromRobot } from "../src/shared/protocol.ts";
import type { MatchState } from "../src/world/rules.ts";
import { World } from "../src/world/world.ts";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

export function pythonLib(): Record<string, string> {
  const base = join(root, "src/robot/python");
  const out: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const f of readdirSync(dir)) {
      const p = join(dir, f);
      if (statSync(p).isDirectory()) walk(p);
      else if (f.endsWith(".py")) out[relative(base, p)] = readFileSync(p, "utf8");
    }
  };
  walk(base);
  return out;
}

export interface MatchResult {
  /** sim seconds when the run stopped */
  t: number;
  /** robot i left the arena */
  out: boolean[];
  /** program output and world events, one line each */
  log: string[];
  /** Python error per robot, if any */
  errors: (string | undefined)[];
  wallMs: number;
  /** judged by the arena's rules (winner, scores, laps, reason) */
  match: MatchState;
}

export interface MatchOptions {
  programs: string[];
  names?: string[];
  arena?: string;
  seconds?: number;
  seed?: number;
  /** explicit start poses; default = the arena's start slots */
  poses?: Pose[];
  /** random start spread (deterministic per seed); 0 = exact start slots */
  jitter?: number;
  presses?: { button: "A" | "B" | "C"; t: number }[];
  echo?: boolean;
  /** stop as soon as a robot is out (default false: in koth, shuttle and race one robot out decides nothing yet) */
  stopWhenOut?: boolean;
  /** stop when the rules have decided the match (default true) */
  stopWhenDecided?: boolean;
}

export async function runMatch(opts: MatchOptions): Promise<MatchResult> {
  const mj = await loadMujoco();
  const arena = arenaById(opts.arena ?? "dohyo");
  const seed = opts.seed ?? 1;
  const threshold = World.calibrateProx(mj, arena);
  const poses =
    opts.poses ?? (opts.jitter ? jitteredStarts(arena, opts.programs.length, seed, opts.jitter) : opts.programs.map((_, i) => arena.starts[i]));
  const names = opts.programs.map((_, i) => opts.names?.[i] ?? `Robot ${i + 1}`);
  // presses are executed by the world at exact sim times (deterministic)
  const world = new World(mj, arena, poses, { seed, proxThreshold: threshold, names, presses: opts.presses });
  const bellSab = makeBell();
  const bell = new Int32Array(bellSab);
  const wasmUrl = join(root, "vendor/micropython/micropython.wasm");
  const lib = pythonLib();
  const log: string[] = [];
  const errors: (string | undefined)[] = [];
  const done = opts.programs.map(() => false);
  const workers: Worker[] = [];
  const chans = opts.programs.map((code, slot) => {
    const buffers = makeChannelBuffers();
    const chan = openChannel(buffers);
    world.attach(slot, chan);
    const w = new Worker(join(here, "robot-node-worker.mjs"), {
      workerData: {
        slot,
        code,
        buffers,
        bell: bellSab,
        wasmUrl,
        lib,
        seed: (seed * 31 + slot * 7) >>> 0,
        // the robots read scheduled presses from their own clock (deterministic, like the browser)
        presses: (opts.presses ?? []).map((p) => ({ idx: { A: C.BtnA, B: C.BtnB, C: C.BtnC }[p.button], at: p.t * 1e6 })),
      },
    });
    w.on("message", (m: FromRobot) => {
      if (m.type === "stdout") {
        for (const line of m.text.replace(/\n$/, "").split("\n")) {
          const s = `[${m.t.toFixed(3)}s R${slot + 1}] ${line}`;
          log.push(s);
          if (opts.echo) console.log(s);
        }
      } else if (m.type === "done") {
        done[slot] = true;
        errors[slot] = m.error;
      }
    });
    w.on("error", (e) => {
      done[slot] = true;
      world.detach(slot); // otherwise the world waits for this robot forever
      errors[slot] = String(e);
      if (process.env.SPARK_DEBUG) console.error(`worker R${slot + 1} error:`, e);
    });
    workers.push(w);
    return chan;
  });

  const limit = (opts.seconds ?? 20) * 1e6;
  const t0 = performance.now();
  const maxWall = Number(process.env.SPARK_MAX_WALL_MS ?? 180_000);
  let lastDebug = 0;
  let lastTrace = -1;
  // advance the world in chunks and let Node handle worker messages in between
  while (world.tUs < limit) {
    if (performance.now() - t0 > maxWall) {
      log.push(`aborted: wall-clock limit ${maxWall} ms`);
      break;
    }
    if (process.env.SPARK_DEBUG && performance.now() - lastDebug > Number(process.env.SPARK_DEBUG)) {
      lastDebug = performance.now();
      const st = chans
        .map((c, i) => `${Atomics.load(c.ctl, C.State)}@${(c.f64[0] / 1e6).toFixed(3)}s op${Atomics.load(c.ctl, C.Op)} bound ${(world.robots[i].bound / 1e6).toFixed(3)} active ${world.robots[i].active}`)
        .join(" | ");
      console.error(`[debug] wall ${(lastDebug - t0).toFixed(0)} ms, sim ${(world.tUs / 1e6).toFixed(3)} s, states ${st}, done ${done}`);
    }
    if (process.env.SPARK_TRACE && Math.floor(world.tUs / 1_000_000) > lastTrace) {
      lastTrace = Math.floor(world.tUs / 1_000_000);
      const pos = world.robots
        .map((r) => {
          const b = r.body * 3;
          const yaw = (2 * Math.atan2(world.d.xquat[r.body * 4 + 3], world.d.xquat[r.body * 4]) * 180) / Math.PI;
          return `R${r.slot + 1} (${(world.d.xpos[b] * 100).toFixed(0)}, ${(world.d.xpos[b + 1] * 100).toFixed(0)}) cm ${yaw.toFixed(0)}° cmd ${r.cmd} last read: prox ${r.last.prox.join("")} line ${r.last.line.join(",")} z ${(world.d.xpos[b + 2] * 1000).toFixed(1)}mm`;
        })
        .join(" | ");
      console.log(`t=${(world.tUs / 1e6).toFixed(1)} ${pos}`);
    }
    const next = Math.min(limit, world.tUs + 20_000);
    const state = world.pump(bell, next, 50);
    if (state === "idle") world.advanceTo(next);
    world.watchdog();
    for (const e of world.events.splice(0)) {
      const s = `[${e.t.toFixed(3)}s world] ${e.text}`;
      log.push(s);
      if (opts.echo) console.log(s);
    }
    if (opts.stopWhenOut && world.robots.some((r) => r.out)) break;
    if (opts.stopWhenDecided !== false && world.rules.state.ended) break;
    if (done.every(Boolean) && world.robots.every((r) => !r.active)) {
      world.advanceTo(Math.min(limit, world.tUs + 200_000));
    }
    await new Promise((r) => setImmediate(r));
  }
  const wallMs = performance.now() - t0;
  await new Promise((r) => setTimeout(r, 20));
  for (const w of workers) await w.terminate();
  const res: MatchResult = {
    t: world.tUs / 1e6,
    out: world.robots.map((r) => r.out),
    log,
    errors,
    wallMs,
    match: structuredClone(world.rules.state),
  };
  world.dispose();
  return res;
}

// --- command line
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  const programs: string[] = [];
  const names: string[] = [];
  const presses: { button: "A" | "B" | "C"; t: number }[] = [];
  let arena = "dohyo";
  let seconds = 20;
  let seed = 1;
  let jitter = 0;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--arena") arena = args[++i];
    else if (a === "--seconds") seconds = Number(args[++i]);
    else if (a === "--seed") seed = Number(args[++i]);
    else if (a === "--jitter") jitter = Number(args[++i]);
    else if (a === "--press") {
      const [b, t] = args[++i].split("@");
      presses.push({ button: b as "A" | "B" | "C", t: Number(t) });
    } else {
      programs.push(readFileSync(a, "utf8"));
      names.push(basename(a, ".py"));
    }
  }
  const r = await runMatch({ programs, names, arena, seconds, seed, jitter, presses, echo: true, stopWhenOut: false });
  const m = r.match;
  console.log(`\nsim ${r.t.toFixed(2)} s in ${r.wallMs.toFixed(0)} ms (${((r.t * 1000) / r.wallMs).toFixed(1)}x real time)`);
  console.log(`result: ${m.ended ? (m.winner === null ? "draw" : `${names[m.winner]} wins`) : "undecided"} ${m.reason ? `(${m.reason})` : ""}`);
  console.log(`scores: ${m.scores.map((s, i) => `${names[i]}=${Number.isInteger(s) ? s : s.toFixed(2)}`).join("  ")}`);
  console.log(`out: ${r.out.map((o, i) => `${names[i]}=${o}`).join("  ")}`);
  r.errors.forEach((e, i) => e && console.log(`error ${names[i]}: ${e}`));
}
