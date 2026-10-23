// Lockstep protocol between the world worker and the robot workers over SharedArrayBuffer.
//
// Every robot has a control block (Int32) and a number block (Float64). A robot runs freely until its program
// needs something from the world (sensor, motor, sleep) or has used up its CPU quantum. Then it writes its clock
// and the request, rings the bell and blocks. The world serves requests strictly in time order: it advances the
// physics to that moment, answers, and wakes the robot. So every program sees the world exactly at its own
// simulated time, no matter how fast the computer is.

import type { Pose } from "./arenas.ts";
import type { MatchState } from "../world/rules.ts";

export const ST = { Idle: 0, Request: 1, Response: 2, Done: 3 } as const;

/** Indices in the Int32 control block */
export const C = { State: 0, Op: 1, BtnA: 4, BtnB: 5, BtnC: 6 } as const;
export const CTL_LEN = 16;
export const F64_LEN = 64;

/** f64[0] = clock in µs (request: start time, response: time after the operation); arguments/results from f64[1] */
export const OP = {
  Sync: 1, // only align clocks (CPU time used)
  Sleep: 2, // a = duration µs
  Motors: 3, // a = left, b = right (-6000..6000)
  Line: 4, // a = emitters on (1/0) -> 5 raw values
  Prox: 5, // a = carrier Hz -> 6 counts (ll, lr, fl, fr, rl, rr)
  Imu: 6, // -> acc xyz (g), gyro xyz (dps), mag xyz (gauss)
  Enc: 7, // -> left, right (counts since start)
  Battery: 8, // -> mV
} as const;

export interface RobotChannel {
  ctl: Int32Array;
  f64: Float64Array;
}

export interface ChannelBuffers {
  ctlSab: SharedArrayBuffer;
  f64Sab: SharedArrayBuffer;
}

export function makeChannelBuffers(): ChannelBuffers {
  return {
    ctlSab: new SharedArrayBuffer(CTL_LEN * 4),
    f64Sab: new SharedArrayBuffer(F64_LEN * 8),
  };
}

export function openChannel(b: ChannelBuffers): RobotChannel {
  return { ctl: new Int32Array(b.ctlSab), f64: new Float64Array(b.f64Sab) };
}

/** Shared doorbell: robots increment the counter and wake the world. */
export function makeBell(): SharedArrayBuffer {
  return new SharedArrayBuffer(4);
}

// --- Messages between UI, world and robots (postMessage)

export interface RobotSetup {
  slot: number;
  name: string;
  pose: Pose;
  /** Python source of main.py; empty = robot without a program */
  code: string;
}

export interface RobotSnapshot {
  pos: [number, number, number];
  quat: [number, number, number, number];
  /** sprocket angles left/right (rad), for the track animation */
  sprocket: [number, number];
  motors: [number, number];
  /** last values the program read (what the robot "saw") */
  line: number[];
  prox: number[];
  imu: number[];
  enc: [number, number];
  mv: number;
  /** forward speed m/s, heading and tilt in degrees */
  speed: number;
  yaw: number;
  tilt: number;
  out: boolean;
}

export interface WorldSnapshot {
  /** sim time in s */
  t: number;
  /** measured sim time / wall time */
  realtime: number;
  robots: RobotSnapshot[];
  match: MatchState;
}

/** Conditions of the world, for robustness tests (all 1 = nominal) */
export interface WorldTweaks {
  /** battery state of charge 0..1 (fresh NiMH = 1) */
  battery: number;
  /** grip multiplier of tracks on the surface (dusty < 1 < freshly cleaned) */
  grip: number;
  /** sensor noise multiplier (0 = ideal sensors) */
  noise: number;
}

export const NOMINAL: WorldTweaks = { battery: 1, grip: 1, noise: 1 };

export interface LoadMessage {
  type: "load";
  /** load id: the world tags its messages with it, so the UI can drop late ones from an earlier load */
  id: number;
  arena: string;
  robots: { setup: RobotSetup; buffers: ChannelBuffers }[];
  /** physics noise, motor spread etc. */
  seed: number;
  /** the start signal at this sim time (s): button A on every robot for 100 ms; null = never */
  autoPressA: number | null;
  /** no snapshots, run as fast as possible, post one "result" at the end */
  headless?: boolean;
  /** headless: stop after this many sim seconds even without a decision */
  maxTime?: number;
  tweaks?: WorldTweaks;
}

export type ToWorld =
  | { type: "init"; bell: SharedArrayBuffer }
  | LoadMessage
  | { type: "speed"; speed: number } // 0 = pause, Infinity = as fast as possible
  | { type: "place"; slot: number; x: number; y: number; yaw: number }
  | { type: "robotDone"; slot: number }
  | { type: "start" } // the start signal now: button A on every robot, 5 s countdown
  | { type: "halt" }; // all programs off, motors off, the match stops

export interface WorldEvent {
  kind: "out" | "lap" | "point" | "end" | "warn" | "info" | "hang";
  slot?: number;
  text: string;
  t: number;
}

export type FromWorld =
  | { type: "ready" }
  | { type: "loaded"; id: number }
  | { type: "snapshot"; snap: WorldSnapshot; id: number }
  | { type: "event"; event: WorldEvent; id: number }
  | { type: "result"; match: MatchState; t: number; id: number }
  | { type: "error"; message: string };

export type FromRobot =
  | { type: "stdout"; slot: number; text: string; t: number }
  | { type: "display"; slot: number; hex: string; inverted: boolean; t: number }
  | { type: "leds"; slot: number; rgb: number[]; t: number }
  | { type: "yellow"; slot: number; on: boolean; t: number }
  /** notes as [frequency Hz, duration ms (-1 = continuous), volume 0..128] */
  | { type: "buzzer"; slot: number; notes: [number, number, number][]; t: number }
  | { type: "done"; slot: number; t: number; error?: string }
  | { type: "fatal"; slot: number; message: string };
