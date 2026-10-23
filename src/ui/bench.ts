// Test bench: runs many headless matches in parallel (A vs B, jittered starts, alternating sides) and reports
// win rates with confidence intervals. Every match is deterministic, so any single one can be replayed.
// The same job pool runs round-robin tournaments (every program against every other).
import { arenaById, jitteredStarts, type Pose } from "../shared/arenas.ts";
import type { WorldTweaks } from "../shared/protocol.ts";
import type { MatchState } from "../world/rules.ts";
import { MatchHost, type RobotConfig } from "./session.ts";

export interface BenchConfig {
  arena: string;
  a: RobotConfig;
  b: RobotConfig | null; // null = A alone (race / free runs)
  count: number;
  jitter: number; // 0 = fixed starts, 1 = normal spread
  maxTime: number;
  baseSeed: number;
  tweaks?: WorldTweaks;
}

export interface BenchMatch {
  index: number;
  seed: number;
  swapped: boolean;
  poses: Pose[];
  winner: "A" | "B" | "draw";
  t: number;
  reason: string;
  scoreA: number;
  scoreB: number;
  match: MatchState;
}

export interface BenchSummary {
  n: number;
  winsA: number;
  winsB: number;
  draws: number;
  /** A's share with draws counted as half, and its 95 % Wilson interval */
  rate: number;
  lo: number;
  hi: number;
  avgT: number;
  avgScoreA: number;
  avgScoreB: number;
}

/** Wilson score interval for a proportion (z = 1.96) */
export function wilson(p: number, n: number): [number, number] {
  if (!n) return [0, 1];
  const z = 1.96;
  const den = 1 + (z * z) / n;
  const c = (p + (z * z) / (2 * n)) / den;
  const h = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / den;
  return [Math.max(0, c - h), Math.min(1, c + h)];
}

export function summarize(ms: BenchMatch[]): BenchSummary {
  const n = ms.length;
  const winsA = ms.filter((m) => m.winner === "A").length;
  const winsB = ms.filter((m) => m.winner === "B").length;
  const draws = n - winsA - winsB;
  const rate = n ? (winsA + draws / 2) / n : 0;
  const [lo, hi] = wilson(rate, n);
  const avg = (f: (m: BenchMatch) => number) => (n ? ms.reduce((s, m) => s + f(m), 0) / n : 0);
  return { n, winsA, winsB, draws, rate, lo, hi, avgT: avg((m) => m.t), avgScoreA: avg((m) => m.scoreA), avgScoreB: avg((m) => m.scoreB) };
}

/** Headless time limit (world time): the rules' limit counts from go = start signal (0.2 s) + 5 s */
export function benchMaxTime(arena: ReturnType<typeof arenaById>): number {
  return arena.timeLimit ? arena.timeLimit + (arena.mode === "race" ? 1 : 6) : 60;
}

/** The setup of match i, shared by the bench and "watch this match". */
export function benchMatchSetup(cfg: BenchConfig, index: number) {
  const arena = arenaById(cfg.arena);
  const seed = (cfg.baseSeed + index * 7919) >>> 0;
  const swapped = cfg.b !== null && index % 2 === 1;
  const robots = cfg.b ? (swapped ? [cfg.b, cfg.a] : [cfg.a, cfg.b]) : [cfg.a];
  const poses = jitteredStarts(arena, robots.length, seed, arena.mode === "race" ? cfg.jitter * 0.25 : cfg.jitter);
  return { seed, swapped, robots, poses };
}

/** One headless match */
export interface Job {
  arena: string;
  robots: RobotConfig[];
  seed: number;
  poses: Pose[];
  maxTime: number;
  tweaks?: WorldTweaks;
}

export class BenchRunner {
  private hosts: MatchHost[] = [];
  private cancelled = false;
  /** resolves on cancel: a world that is still starting up is not waited for */
  private stopped!: Promise<void>;
  private stop = () => {};
  /** resolvers of matches in flight, released on cancel so nothing waits forever */
  private inFlight = new Set<(v: { match: MatchState; t: number } | null) => void>();

  constructor(private parallel = Math.max(1, Math.min(4, Math.floor((navigator.hardwareConcurrency || 4) / 3)))) {}

  /** Runs all jobs with a pool of parallel worlds; onDone is called in completion order. */
  async runJobs<J extends Job>(jobs: J[], onDone: (job: J, match: MatchState, t: number, done: number) => void): Promise<void> {
    this.cancelled = false;
    this.stopped = new Promise((r) => (this.stop = r));
    let next = 0;
    let done = 0;
    const worker = async () => {
      let pending: ((v: { match: MatchState; t: number } | null) => void) | null = null;
      const host = new MatchHost({
        result: (match, t) => pending?.({ match, t }),
        robot: (m) => {
          // a crashed program counts as a stopped robot; the match continues without it
          if (m.type === "fatal") console.warn(`bench robot ${m.slot}: ${m.message}`);
        },
      });
      this.hosts.push(host);
      await Promise.race([host.whenReady(), this.stopped]);
      while (!this.cancelled && next < jobs.length) {
        const job = jobs[next++];
        const outcome = await new Promise<{ match: MatchState; t: number } | null>((resolve) => {
          pending = resolve;
          this.inFlight.add(resolve);
          void host.load({ ...job, autoPressA: 0.2, run: true, headless: true });
        });
        if (pending) this.inFlight.delete(pending);
        pending = null;
        if (this.cancelled || !outcome) break;
        onDone(job, outcome.match, outcome.t, ++done);
      }
      host.dispose();
    };
    await Promise.all(Array.from({ length: Math.min(this.parallel, jobs.length) }, worker));
    this.hosts = [];
  }

  async run(cfg: BenchConfig, onMatch: (m: BenchMatch, done: number) => void): Promise<BenchMatch[]> {
    const results: BenchMatch[] = [];
    const jobs = Array.from({ length: cfg.count }, (_, index) => {
      const { seed, swapped, robots, poses } = benchMatchSetup(cfg, index);
      return { arena: cfg.arena, robots, seed, poses, maxTime: cfg.maxTime, tweaks: cfg.tweaks, index, swapped };
    });
    await this.runJobs(jobs, (job, match, _t, done) => {
      const sA = job.swapped ? 1 : 0;
      const sB = job.swapped ? 0 : 1;
      const w = match.winner;
      const winner: BenchMatch["winner"] = w === null ? "draw" : w === sA ? "A" : w === sB ? "B" : "draw";
      const m: BenchMatch = {
        index: job.index,
        seed: job.seed,
        swapped: job.swapped,
        poses: job.poses,
        winner: cfg.b ? winner : match.ended && w === 0 ? "A" : "draw",
        // the match clock when it was decided (from "go"), not the sim time the headless run stopped at
        t: match.t,
        reason: match.reason || "time limit",
        scoreA: match.scores[sA] ?? 0,
        scoreB: cfg.b ? (match.scores[sB] ?? 0) : 0,
        match,
      };
      results.push(m);
      onMatch(m, done);
    });
    return results.sort((x, y) => x.index - y.index);
  }

  /**
   * Round robin: every entrant against every other, `perPair` matches per pair with alternating sides.
   * Returns points[i][j] = points of i against j (win 1, draw 0.5) and games[i][j].
   */
  async roundRobin(
    entrants: RobotConfig[],
    perPair: number,
    arenaId: string,
    tweaks: WorldTweaks | undefined,
    onProgress: (done: number, total: number, points: number[][], games: number[][]) => void,
  ) {
    const arena = arenaById(arenaId);
    const n = entrants.length;
    const points = Array.from({ length: n }, () => new Array(n).fill(0));
    const games = Array.from({ length: n }, () => new Array(n).fill(0));
    const base = (Math.random() * 1e9) >>> 0;
    const jobs: (Job & { i: number; j: number })[] = [];
    for (let i = 0; i < n; i++)
      for (let j = i + 1; j < n; j++)
        for (let k = 0; k < perPair; k++) {
          const swap = k % 2 === 1;
          const seed = (base + (i * 131 + j * 17 + k) * 7919) >>> 0;
          const robots = swap ? [entrants[j], entrants[i]] : [entrants[i], entrants[j]];
          jobs.push({ arena: arenaId, robots, seed, poses: jitteredStarts(arena, 2, seed, arena.mode === "race" ? 0.25 : 1), maxTime: benchMaxTime(arena), tweaks, i: swap ? j : i, j: swap ? i : j });
        }
    await this.runJobs(jobs, (job, match, _t, done) => {
      const w = match.winner;
      if (w === 0) points[job.i][job.j] += 1;
      else if (w === 1) points[job.j][job.i] += 1;
      else {
        points[job.i][job.j] += 0.5;
        points[job.j][job.i] += 0.5;
      }
      games[job.i][job.j]++;
      games[job.j][job.i]++;
      onProgress(done, jobs.length, points, games);
    });
    return { points, games };
  }

  cancel() {
    this.cancelled = true;
    this.stop();
    for (const h of this.hosts) h.dispose();
    this.hosts = [];
    for (const r of this.inFlight) r(null);
    this.inFlight.clear();
  }
}
