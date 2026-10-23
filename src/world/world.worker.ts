// World worker: owns the physics, serves the robots in lockstep and sends ~60 frames per second to the UI.
// Headless mode (test bench): no frames, as fast as possible, one "result" message when the match is decided.
import "virtual:spark-overlay-world"; // registers the competition arenas/scoring in the worker, if present
import loadMujoco from "mujoco";
import mujocoWasm from "../../node_modules/mujoco/mujoco.wasm?url";
import { arenaById } from "../shared/arenas.ts";
import { openChannel, type FromWorld, type LoadMessage, type ToWorld } from "../shared/protocol.ts";
import { World, type Mujoco } from "./world.ts";

let mj: Mujoco;
let world: World | null = null;
let bell: Int32Array;
let speed = 1;
let simAnchor = 0;
let wallAnchor = 0;
let lastSnap = 0;
let simSinceSnap = 0;
let realtime = 1;
let running = false;
let headless = false;
let maxTimeUs = Infinity;
let generation = 0;
const thresholds = new Map<string, number>();

const post = (m: FromWorld) => (self as unknown as Worker).postMessage(m);

function anchor() {
  simAnchor = world ? world.tUs : 0;
  wallAnchor = performance.now();
}

let loadId = 0;
// the generation travels with every tick message: a tick queued by an earlier world cannot revive its loop
const channel = new MessageChannel();
channel.port1.onmessage = (e: MessageEvent<number>) => tick(e.data);
const soon = (gen: number) => channel.port2.postMessage(gen);

function flushEvents() {
  if (!world) return;
  world.watchdog(); // a program stuck in one long statement must not freeze the others
  for (const event of world.events.splice(0)) post({ type: "event", event, id: loadId });
}

function tick(gen: number) {
  if (!world || !running || gen !== generation) return; // a newer load replaced this world
  const now = performance.now();
  let state = "paced";

  if (headless) {
    // in chunks, so the result comes right after the decision even when no program runs any more
    const limit = Math.min(maxTimeUs, world.tUs + 100_000);
    state = world.pump(bell, limit, 25);
    if (state === "idle") world.advanceTo(limit);
    flushEvents();
    if (world.rules.state.ended || world.tUs >= maxTimeUs) {
      running = false;
      post({ type: "result", match: structuredClone(world.rules.state), t: world.tUs / 1e6, id: loadId });
      return;
    }
    soon(gen);
    return;
  }

  if (speed === Infinity) {
    // as fast as possible: a time budget per tick, no pacing
    const before = world.tUs;
    state = world.pump(bell, Infinity, 14);
    if (state === "idle") world.advanceTo(world.tUs + 50_000);
    simSinceSnap += world.tUs - before;
    state = "budget";
  } else if (speed > 0) {
    let target = simAnchor + (now - wallAnchor) * speed * 1000;
    // when the computer cannot keep up, rather run slower than rush to catch up
    if (target - world.tUs > 150_000) {
      anchor();
      target = world.tUs + 16_000 * Math.min(speed, 4);
    }
    const before = world.tUs;
    state = world.pump(bell, target, 14);
    if (state === "idle") world.advanceTo(world.tUs + 50_000); // without programs
    simSinceSnap += world.tUs - before;
  }
  flushEvents();
  const after = performance.now();
  if (after - lastSnap > 16) {
    const wall = after - lastSnap;
    realtime = speed === 0 ? 0 : 0.8 * realtime + 0.2 * (simSinceSnap / 1000 / Math.max(wall, 1));
    simSinceSnap = 0;
    lastSnap = after;
    post({ type: "snapshot", snap: world.snapshot(realtime), id: loadId });
  }
  if (state === "paced") setTimeout(() => tick(gen), 4);
  else soon(gen);
}

function load(m: LoadMessage) {
  running = false;
  generation++;
  loadId = m.id;
  world?.dispose();
  world = null;
  const arena = arenaById(m.arena);
  if (!thresholds.has(arena.id)) thresholds.set(arena.id, World.calibrateProx(mj, arena));
  world = new World(
    mj,
    arena,
    m.robots.map((r) => r.setup.pose),
    {
      seed: m.seed,
      proxThreshold: thresholds.get(arena.id),
      names: m.robots.map((r) => r.setup.name),
      autoPressA: m.autoPressA,
      tweaks: m.tweaks,
    },
  );
  for (const r of m.robots) if (r.setup.code.trim()) world.attach(r.setup.slot, openChannel(r.buffers));
  world.judging = m.robots.some((r) => r.setup.code.trim()); // preview: the match clock does not run
  headless = !!m.headless;
  maxTimeUs = m.maxTime ? m.maxTime * 1e6 : Infinity;
  if (!headless && world.arena.timeLimit === 0) maxTimeUs = Infinity;
  anchor();
  lastSnap = performance.now();
  simSinceSnap = 0;
  running = true;
  post({ type: "loaded", id: loadId });
  if (!headless) post({ type: "snapshot", snap: world.snapshot(0), id: loadId });
  tick(generation);
}

self.onmessage = async (e: MessageEvent<ToWorld>) => {
  const m = e.data;
  try {
    switch (m.type) {
      case "init":
        mj = await loadMujoco({ locateFile: () => mujocoWasm });
        bell = new Int32Array(m.bell);
        post({ type: "ready" });
        break;
      case "load":
        load(m);
        break;
      case "speed":
        speed = m.speed;
        anchor();
        break;
      case "place":
        if (world) {
          world.place(m.slot, { x: m.x, y: m.y, yaw: m.yaw });
          post({ type: "snapshot", snap: world.snapshot(0), id: loadId });
        }
        break;
      case "robotDone":
        world?.detach(m.slot);
        break;
      case "start":
        world?.startSignal();
        break;
      case "halt":
        // Stop: programs off, motors off, and the match is over (no more scoring or time limit)
        world?.robots.forEach((r) => {
          world!.detach(r.slot);
          r.cmd = [0, 0];
        });
        if (world) world.judging = false;
        break;
    }
  } catch (err) {
    post({ type: "error", message: String((err as Error)?.stack ?? err) });
  }
};
