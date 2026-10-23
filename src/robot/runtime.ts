// Runs a robot program in real MicroPython and keeps it in lockstep with the world.
// Environment-neutral: runs the same in the browser (robot.worker.ts) and in Node (tests/match.ts).

import { C, F64_LEN, OP, ST, openChannel, type ChannelBuffers, type FromRobot } from "../shared/protocol.ts";
import { COST_US, HEAP_BYTES } from "../shared/zumo-spec.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type MicroPython = any;

export interface RobotJob {
  slot: number;
  code: string;
  buffers: ChannelBuffers;
  bell: SharedArrayBuffer;
  wasmUrl: string;
  /** path under /lib -> Python source (runtime modules and zumo_2040_robot) */
  lib: Record<string, string>;
  /** seed for Python's `random` (reproducible runs) */
  seed: number;
  /** scheduled button presses (start signal, test presses): channel index C.BtnX and sim time in µs; each
   *  lasts 100 ms. The robot reads them from its own clock, so runs are reproducible. */
  presses?: { idx: number; at: number }[];
}

const PRESS_US = 100_000;
const TICKS_PERIOD = 0x40000000;

export async function runRobot(
  job: RobotJob,
  loadMicroPython: (opts: object) => Promise<MicroPython>,
  post: (msg: FromRobot) => void,
): Promise<void> {
  const { slot } = job;
  const { ctl, f64 } = openChannel(job.buffers);
  const bell = new Int32Array(job.bell);
  let clock = 0;
  let lastSync = 0;
  // CPU time: the VM counts executed bytecodes (vendor/micropython hook); partial counts are settled before the
  // program looks at the clock or talks to the world
  let mp: MicroPython | null = null;
  // Library internals that the original runs as viper code or in the PIO are "untimed": their duration is
  // already modelled by the world (e.g. a line read = 1.06 ms), so their bytecodes are not charged again.
  let untimed = 0;
  const settle = () => {
    const n = mp ? mp.takeBytecodeCount() : 0;
    if (n && untimed === 0) clock += n * COST_US.pythonBytecode;
  };
  // at every contact with the clock: keep in step with the world (also in loops that only read the clock)
  const settleSync = () => {
    settle();
    if (clock - lastSync >= COST_US.quantum) rpc(OP.Sync);
  };
  const presses = job.presses ?? [];
  // timer interrupt: Python tells when the next timer is due; the VM hook then schedules its handler
  let irqAt = Infinity;
  let irqRaised = false;
  const irqDue = () => {
    if (irqRaised || clock < irqAt) return false;
    irqRaised = true;
    return true;
  };
  let lastFlush = 0;

  // stdout arrives byte by byte; decode incrementally and send it at every world sync
  const decoder = new TextDecoder();
  let pending = "";
  const flushStdout = () => {
    if (!pending) return;
    post({ type: "stdout", slot, text: pending, t: clock / 1e6 });
    pending = "";
    lastFlush = performance.now();
  };
  const onByte = (bytes: Uint8Array) => {
    const text = decoder.decode(bytes, { stream: true });
    pending += text;
    // a finished line goes out right away (a program may block in a long C call after printing), at most
    // every 20 ms so that print-heavy loops do not flood the UI
    if (pending.length > 8000 || (text.includes("\n") && performance.now() - lastFlush > 20)) flushStdout();
  };

  function rpc(op: number, ...args: number[]): Float64Array {
    settle();
    flushStdout();
    f64[0] = clock;
    const n = Math.min(args.length, F64_LEN - 1);
    for (let i = 0; i < n; i++) f64[1 + i] = Number(args[i]) || 0;
    for (let i = n; i < 3; i++) f64[1 + i] = 0;
    Atomics.store(ctl, C.Op, op);
    Atomics.store(ctl, C.State, ST.Request);
    Atomics.add(bell, 0, 1);
    Atomics.notify(bell, 0);
    while (Atomics.load(ctl, C.State) === ST.Request) Atomics.wait(ctl, C.State, ST.Request);
    clock = f64[0];
    lastSync = clock;
    Atomics.store(ctl, C.State, ST.Idle);
    return f64;
  }

  function charge(us: number) {
    clock += us;
    if (clock - lastSync >= COST_US.quantum) rpc(OP.Sync);
  }

  const t = () => clock / 1e6;
  const intArg = (v: unknown) => {
    if (typeof v !== "number" || !Number.isInteger(v)) throw new TypeError(`can't convert ${typeof v === "number" ? "float" : typeof v} to int`);
    return v;
  };
  const hal = {
    now: () => {
      settleSync();
      return clock;
    },
    charge: (us: number) => {
      settle();
      charge(Math.max(0, Number(us) || 0));
    },
    untimed: (on: number) => {
      settle();
      untimed = on ? untimed + 1 : Math.max(0, untimed - 1);
      if (!untimed && clock - lastSync >= COST_US.quantum) rpc(OP.Sync);
    },
    /** interrupt handlers run as robot code even when they fire inside untimed library code */
    untimed_save: () => {
      settle();
      const d = untimed;
      untimed = 0;
      return d;
    },
    untimed_restore: (d: number) => {
      settle();
      untimed = Math.max(0, d | 0);
    },
    irq_at: (us: number) => {
      irqAt = Number(us);
      irqRaised = false;
    },
    // time.ticks_diff / ticks_add: C functions on the robot, native here (only the call costs bytecode time)
    ticks_diff: (...a: unknown[]) => {
      if (a.length !== 2) throw new TypeError(`function takes 2 positional arguments but ${a.length} were given`);
      const d = (intArg(a[0]) - intArg(a[1]) + TICKS_PERIOD / 2) % TICKS_PERIOD;
      return (d < 0 ? d + TICKS_PERIOD : d) - TICKS_PERIOD / 2;
    },
    ticks_add: (...a: unknown[]) => {
      if (a.length !== 2) throw new TypeError(`function takes 2 positional arguments but ${a.length} were given`);
      const t = intArg(a[0]);
      const d = intArg(a[1]);
      if (d < -TICKS_PERIOD / 2 || d >= TICKS_PERIOD / 2) throw new RangeError("OverflowError: ticks interval overflow");
      const r = (t + d) % TICKS_PERIOD;
      return r < 0 ? r + TICKS_PERIOD : r;
    },
    rpc,
    button: (i: number) => {
      settle();
      const idx = C.BtnA + i;
      for (const p of presses) if (p.idx === idx && clock >= p.at && clock < p.at + PRESS_US) return 1;
      return Atomics.load(ctl, idx); // live presses (inspector, keys, the UI start signal)
    },
    show: (hex: string, inverted: number, flipped: number) =>
      post({ type: "display", slot, hex: flipped === 1 ? rotate180(hex) : hex, inverted: inverted === 1, t: t() }),
    leds: (hex: string) => {
      const rgb: number[] = [];
      for (let led = 0; led < 6; led++) {
        const o = (4 + led * 4) * 2;
        const bright = (parseInt(hex.slice(o, o + 2), 16) & 0x1f) / 31;
        const b = parseInt(hex.slice(o + 2, o + 4), 16);
        const g = parseInt(hex.slice(o + 4, o + 6), 16);
        const r = parseInt(hex.slice(o + 6, o + 8), 16);
        rgb.push(Math.round(r * bright), Math.round(g * bright), Math.round(b * bright));
      }
      post({ type: "leds", slot, rgb, t: t() });
    },
    yellow: (on: number) => post({ type: "yellow", slot, on: on === 1, t: t() }),
    buzz: (s: string) => {
      const notes = s ? s.split(",").map((n) => n.split(":").map(Number) as [number, number, number]) : [];
      post({ type: "buzzer", slot, notes, t: t() });
    },
  };

  mp = await loadMicroPython({
    url: job.wasmUrl,
    heapsize: HEAP_BYTES, // hard limit: MemoryError like on the RP2040
    linebuffer: false,
    stdout: onByte,
    stderr: onByte,
    // runs inside the VM every 64 bytecodes; may block in Atomics.wait (lockstep), must not call into Python
    bytecodeHook: {
      interval: 64,
      callback: (n: number) => {
        if (untimed === 0) charge(n * COST_US.pythonBytecode);
        // output must not wait for the next world contact (a program may hang right after printing)
        if (pending && performance.now() - lastFlush > 100) flushStdout();
        return irqDue();
      },
    },
  });

  for (const [path, src] of Object.entries(job.lib)) {
    let dir = "/lib";
    for (const p of ["", ...path.split("/").slice(0, -1)]) {
      if (p) dir += "/" + p;
      try {
        mp.FS.mkdir(dir);
      } catch {
        /* exists */
      }
    }
    mp.FS.writeFile(`/lib/${path}`, src);
  }
  mp.registerJsModule("_spark", hal);
  mp.runPython("import sys\nsys.path.insert(0, '/lib')");
  const rt = mp.pyimport("_spark_rt");

  let error: string | undefined;
  try {
    const res = rt.run(job.code, job.seed >>> 0);
    if (typeof res === "string") error = res;
  } catch (e) {
    error = String((e as Error)?.message ?? e);
  }
  pending += decoder.decode();
  flushStdout();
  Atomics.store(ctl, C.State, ST.Done);
  Atomics.add(bell, 0, 1);
  Atomics.notify(bell, 0);
  post({ type: "done", slot, t: t(), error });
}

/** SH1106 buffer (8 pages × 128 columns, bit 0 = top row) rotated by 180°, as Display.flip() does */
function rotate180(hex: string): string {
  if (!hex) return hex;
  const out = new Array<string>(1024);
  for (let page = 0; page < 8; page++) {
    for (let x = 0; x < 128; x++) {
      let b = parseInt(hex.slice((page * 128 + x) * 2, (page * 128 + x) * 2 + 2), 16);
      let r = 0;
      for (let i = 0; i < 8; i++) r |= ((b >> i) & 1) << (7 - i);
      b = r;
      out[(7 - page) * 128 + (127 - x)] = b.toString(16).padStart(2, "0");
    }
  }
  return out.join("");
}
