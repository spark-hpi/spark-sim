// Hosts one world worker and its robot workers. Used interactively (Session) and headless (test bench).
import mpWasm from "../../vendor/micropython/micropython.wasm?url";
import RobotWorker from "../robot/robot.worker.ts?worker";
import type { RobotJob } from "../robot/runtime.ts";
import type { Pose } from "../shared/arenas.ts";
import { arenaById } from "../shared/arenas.ts";
import {
  C,
  makeBell,
  makeChannelBuffers,
  openChannel,
  type ChannelBuffers,
  type FromRobot,
  type FromWorld,
  type RobotChannel,
  type ToWorld,
  type WorldEvent,
  type WorldSnapshot,
  type WorldTweaks,
} from "../shared/protocol.ts";
import type { MatchState } from "../world/rules.ts";
import WorldWorker from "../world/world.worker.ts?worker";

const pyFiles = import.meta.glob("../robot/python/**/*.py", { query: "?raw", import: "default", eager: true }) as Record<
  string,
  string
>;
const LIB = Object.fromEntries(Object.entries(pyFiles).map(([k, v]) => [k.replace("../robot/python/", ""), v]));

export interface RobotConfig {
  name: string;
  code: string;
}

export interface MatchSetup {
  arena: string;
  robots: RobotConfig[];
  seed: number;
  poses?: Pose[];
  /** press button A at this sim time (s); null = never */
  autoPressA: number | null;
  run: boolean;
  headless?: boolean;
  maxTime?: number;
  tweaks?: WorldTweaks;
}

export interface HostEvents {
  snapshot?(s: WorldSnapshot): void;
  event?(e: WorldEvent): void;
  robot?(m: FromRobot): void;
  result?(match: MatchState, t: number): void;
  error?(message: string): void;
}

export class MatchHost {
  private world: Worker;
  private bellSab = makeBell();
  private robotWorkers: (Worker | null)[] = [];
  private chans: RobotChannel[] = [];
  private ready: Promise<void>;
  private loadId = 0;
  running = false;

  constructor(private on: HostEvents) {
    this.world = new WorldWorker();
    this.ready = new Promise((resolve) => {
      this.world.onmessage = (e: MessageEvent<FromWorld>) => {
        const m = e.data;
        // drop what an earlier load still sends (a late "hang" would otherwise stop the new robot worker)
        if ("id" in m && m.id !== this.loadId) return;
        if (m.type === "ready") resolve();
        else if (m.type === "snapshot") this.on.snapshot?.(m.snap);
        else if (m.type === "event") {
          if (m.event.kind === "hang" && m.event.slot !== undefined) {
            // the world detached it; stop the worker so it does not keep burning CPU
            this.robotWorkers[m.event.slot]?.terminate();
            this.robotWorkers[m.event.slot] = null;
          }
          this.on.event?.(m.event);
        }
        else if (m.type === "result") this.on.result?.(m.match, m.t);
        else if (m.type === "error") this.on.error?.(m.message);
      };
      this.world.onerror = (e) => this.on.error?.(`world worker: ${e.message}`);
    });
    this.send({ type: "init", bell: this.bellSab });
  }

  whenReady(): Promise<void> {
    return this.ready;
  }

  private send(m: ToWorld) {
    this.world.postMessage(m);
  }

  async load(s: MatchSetup) {
    const id = ++this.loadId;
    await this.ready;
    if (id !== this.loadId) return; // a newer load superseded this one
    this.killRobots();
    const arena = arenaById(s.arena);
    const buffers: ChannelBuffers[] = s.robots.map(() => makeChannelBuffers());
    this.chans = buffers.map(openChannel);
    const poses = s.poses ?? arena.starts;
    this.send({
      type: "load",
      id,
      arena: s.arena,
      seed: s.seed,
      autoPressA: s.run ? s.autoPressA : null,
      headless: s.headless,
      maxTime: s.maxTime,
      tweaks: s.tweaks,
      robots: s.robots.map((r, slot) => ({
        setup: { slot, name: r.name, pose: poses[slot % poses.length], code: s.run ? r.code : "" },
        buffers: buffers[slot],
      })),
    });
    this.running = s.run;
    if (!s.run) return;
    s.robots.forEach((r, slot) => {
      if (!r.code.trim()) {
        this.robotWorkers[slot] = null;
        return;
      }
      const w = new RobotWorker();
      w.onmessage = (e: MessageEvent<FromRobot>) => {
        if (this.robotWorkers[slot] !== w) return; // late message of a worker from an earlier run
        const m = e.data;
        if (m.type === "done" || m.type === "fatal") this.send({ type: "robotDone", slot });
        this.on.robot?.(m);
      };
      w.onerror = (e) => {
        e.preventDefault();
        if (this.robotWorkers[slot] !== w) return;
        this.send({ type: "robotDone", slot });
        this.on.robot?.({ type: "fatal", slot, message: e.message || "robot worker crashed" });
      };
      const job: RobotJob = {
        slot,
        code: r.code,
        buffers: buffers[slot],
        bell: this.bellSab,
        wasmUrl: mpWasm,
        lib: LIB,
        seed: (s.seed * 31 + slot * 7) >>> 0,
        // the scheduled start signal: the robot sees button A from its own clock (deterministic)
        presses: s.autoPressA !== null ? [{ idx: C.BtnA, at: s.autoPressA * 1e6 }] : [],
      };
      w.postMessage(job);
      this.robotWorkers[slot] = w;
    });
  }

  /** Stop all programs; the robots stay where they are with their motors off. */
  stop() {
    this.killRobots();
    this.send({ type: "halt" });
    this.running = false;
  }

  private killRobots() {
    for (const w of this.robotWorkers) w?.terminate();
    this.robotWorkers = [];
  }

  /** The start signal now: button A on every robot, then the 5 s countdown. */
  start() {
    this.send({ type: "start" });
  }

  setSpeed(speed: number) {
    this.send({ type: "speed", speed });
  }

  press(slot: number, button: "A" | "B" | "C", down: boolean) {
    const ch = this.chans[slot];
    if (ch) Atomics.store(ch.ctl, { A: C.BtnA, B: C.BtnB, C: C.BtnC }[button], down ? 1 : 0);
  }

  place(slot: number, x: number, y: number, yaw: number) {
    this.send({ type: "place", slot, x, y, yaw });
  }

  dispose() {
    this.killRobots();
    this.world.terminate();
  }
}
