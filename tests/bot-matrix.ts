// Round-robin test bench for a folder of bots: every bot against every other bot, several seeds, both slot orders.
// Matches run in parallel child processes (each match is a full world + one MicroPython worker per robot).
//
//   npx tsx tests/bot-matrix.ts                                  # all .py in src/examples on the dohyo
//   npx tsx tests/bot-matrix.ts --dir <folder> --arena dohyo --seconds 90
//   npx tsx tests/bot-matrix.ts --dir <folder> --arena free --ffa 4 --seconds 90
//   options: --seeds 1,2,3  --seconds 60  --jobs 4  --only a,b  --jitter 1  --json out.json
//
// Every robot gets button A at 0.2 s (the start signal, like the simulator's "Auto start"). --jitter (default 1) spreads the start poses
// a little, deterministically per seed, so the seeds really differ; --jitter 0 uses the exact start slots.
//
// 1v1 mode prints a markdown matrix: cell = score of the ROW bot against the COLUMN bot over all its matches
// (win = 1, draw = 0.5), plus totals. --ffa N runs every group of N bots together (each group once per seed,
// with the slots rotated) and prints wins and mean score per bot.
import { fork, type ChildProcess } from "node:child_process";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { cpus } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runMatch } from "./match.ts";

interface Job {
  id: number;
  bots: string[]; // file paths, slot order
  seed: number;
  seconds: number;
  arena: string;
  jitter: number;
}

interface JobResult {
  id: number;
  winner: number | null;
  scores: number[];
  out: boolean[];
  t: number;
  reason: string;
  errors: (string | null)[];
  falseStarts: number[];
  wallMs: number;
}

const name = (file: string) => basename(file, ".py");

// ------------------------------------------------------------------ child: runs matches on request
if (process.argv.includes("--child")) {
  process.on("message", async (job: Job) => {
    const r = await runMatch({
      programs: job.bots.map((f) => readFileSync(f, "utf8")),
      names: job.bots.map(name),
      arena: job.arena,
      seconds: job.seconds,
      seed: job.seed,
      jitter: job.jitter,
      presses: [{ button: "A", t: 0.2 }], // like the simulator's "Auto start": start signal for every robot
      stopWhenOut: false, // let the rules decide (a robot that is out only loses once the rules say so)
    });
    const falseStarts = job.bots.map((_, i) => i).filter((i) => r.log.some((l) => l.includes(`${name(job.bots[i])}: false start`)));
    const res: JobResult = {
      id: job.id,
      winner: r.match.winner,
      scores: r.match.scores,
      out: r.out,
      t: r.t,
      reason: r.match.reason,
      errors: r.errors.map((e) => e ?? null),
      falseStarts,
      wallMs: r.wallMs,
    };
    process.send!(res);
  });
} else {
  await main();
}

// ------------------------------------------------------------------ parent
async function main() {
  const args = process.argv.slice(2);
  const opt = (k: string, d: string) => {
    const i = args.indexOf(`--${k}`);
    return i >= 0 ? args[i + 1] : d;
  };
  const root = join(fileURLToPath(import.meta.url), "../..");
  const dir = join(root, opt("dir", "src/examples"));
  const arena = opt("arena", "dohyo");
  const seconds = Number(opt("seconds", "60"));
  const seeds = opt("seeds", "1,2,3").split(",").map(Number);
  const jobsN = Number(opt("jobs", String(Math.max(1, Math.floor(cpus().length / 3)))));
  const jitter = Number(opt("jitter", "1"));
  const ffa = Number(opt("ffa", "0"));
  const only = opt("only", "");
  const jsonOut = opt("json", "");

  let files = readdirSync(dir)
    .filter((f) => f.endsWith(".py"))
    .sort()
    .map((f) => join(dir, f));
  if (only) {
    const keep = only.split(",");
    files = files.filter((f) => keep.includes(name(f)));
  }
  const names = files.map(name);

  // Build the job list
  const jobs: Job[] = [];
  if (ffa > 1) {
    for (const group of combinations(files.length, Math.min(ffa, files.length))) {
      for (const [k, seed] of seeds.entries()) {
        const rot = group.map((_, i) => group[(i + k) % group.length]); // rotate slots per seed
        jobs.push({ id: jobs.length, bots: rot.map((i) => files[i]), seed, seconds, arena, jitter });
      }
    }
  } else {
    for (let i = 0; i < files.length; i++)
      for (let j = i + 1; j < files.length; j++)
        for (const seed of seeds) {
          jobs.push({ id: jobs.length, bots: [files[i], files[j]], seed, seconds, arena, jitter });
          jobs.push({ id: jobs.length, bots: [files[j], files[i]], seed, seconds, arena, jitter });
        }
  }
  console.error(`${jobs.length} matches (${names.length} bots, arena ${arena}, ${seconds} s, seeds ${seeds.join(",")}, jitter ${jitter}) on ${jobsN} processes`);

  const t0 = performance.now();
  const results = await runPool(jobs, jobsN);
  console.error(`done in ${((performance.now() - t0) / 1000).toFixed(0)} s`);

  // Problems worth knowing about
  for (const r of results) {
    const job = jobs[r.id];
    r.errors.forEach((e, i) => e && console.log(`> Python error in ${name(job.bots[i])} (seed ${job.seed}, slot ${i + 1}): ${e}`));
    r.falseStarts.forEach((i) => console.log(`> False start: ${name(job.bots[i])} (seed ${job.seed}, slot ${i + 1})`));
  }

  if (ffa > 1) printFfa(names, files, jobs, results);
  else printMatrix(names, files, jobs, results);
  if (jsonOut) writeFileSync(jsonOut, JSON.stringify({ arena, seconds, seeds, names, jobs, results }, null, 1));
}

function runPool(jobs: Job[], n: number): Promise<JobResult[]> {
  const queue = [...jobs];
  const results: JobResult[] = [];
  const self = fileURLToPath(import.meta.url);
  return new Promise((resolve) => {
    let running = 0;
    const startChild = () => {
      // fresh process every few matches keeps memory flat (each match loads its own MuJoCo + MicroPython)
      const child: ChildProcess = fork(self, ["--child"], { stdio: ["ignore", "ignore", "inherit", "ipc"] });
      let done = 0;
      let current: Job | undefined;
      let retired = false;
      const retire = () => {
        retired = true;
        child.kill();
        running--;
        if (queue.length) {
          running++;
          startChild();
        } else if (running === 0) resolve(results.sort((a, b) => a.id - b.id));
      };
      const next = () => {
        current = undefined;
        if (!queue.length || done >= 20) return retire();
        current = queue.shift()!;
        child.send(current);
      };
      const record = (r: JobResult) => {
        results.push(r);
        done++;
        if (results.length % 10 === 0 || results.length === jobs.length) console.error(`  ${results.length}/${jobs.length}`);
      };
      child.on("message", (r: JobResult) => {
        record(r);
        next();
      });
      child.on("exit", (code) => {
        if (retired || !current) return;
        // the child died during a match: count it as a draw with an error, carry on with a new child
        const job = current;
        record({ id: job.id, winner: null, scores: job.bots.map(() => 0), out: job.bots.map(() => false), t: 0, reason: "crash", errors: job.bots.map(() => `match process exited (${code})`), falseStarts: [], wallMs: 0 });
        retire();
      });
      next();
    };
    for (let i = 0; i < Math.min(n, jobs.length); i++) {
      running++;
      startChild();
    }
  });
}

function combinations(n: number, k: number): number[][] {
  const out: number[][] = [];
  const rec = (start: number, acc: number[]) => {
    if (acc.length === k) return void out.push([...acc]);
    for (let i = start; i < n; i++) rec(i + 1, [...acc, i]);
  };
  rec(0, []);
  return out;
}

function printMatrix(names: string[], files: string[], jobs: Job[], results: JobResult[]) {
  const n = names.length;
  const score = Array.from({ length: n }, () => new Array(n).fill(0));
  const games = Array.from({ length: n }, () => new Array(n).fill(0));
  const wdl = names.map(() => [0, 0, 0]);
  const time = names.map(() => [0, 0]); // sum of decisive-match lengths for wins, count
  for (const r of results) {
    const [a, b] = jobs[r.id].bots.map((f) => files.indexOf(f));
    games[a][b]++;
    games[b][a]++;
    if (r.winner === null) {
      score[a][b] += 0.5;
      score[b][a] += 0.5;
      wdl[a][1]++;
      wdl[b][1]++;
    } else {
      const w = r.winner === 0 ? a : b;
      const l = r.winner === 0 ? b : a;
      score[w][l] += 1;
      wdl[w][0]++;
      wdl[l][2]++;
      time[w][0] += r.t - 5;
      time[w][1]++;
    }
  }
  const order = names.map((_, i) => i).sort((i, j) => score[j].reduce((s, v) => s + v, 0) - score[i].reduce((s, v) => s + v, 0));
  const pct = (v: number, g: number) => (g ? `${Math.round((100 * v) / g)}` : "–");
  console.log(`\nScore of the row bot against the column bot in % (win = 1, draw = ½), ${results.length / ((n * (n - 1)) / 2)} matches per pairing.\n`);
  console.log(`| bot | ${order.map((i) => names[i]).join(" | ")} | **total** | W-D-L | avg win time |`);
  console.log(`|---|${order.map(() => "---:").join("|")}|---:|---|---:|`);
  for (const i of order) {
    const tot = score[i].reduce((s, v) => s + v, 0);
    const g = games[i].reduce((s, v) => s + v, 0);
    const cells = order.map((j) => (i === j ? "·" : pct(score[i][j], games[i][j])));
    const avg = time[i][1] ? `${(time[i][0] / time[i][1]).toFixed(1)} s` : "–";
    console.log(`| **${names[i]}** | ${cells.join(" | ")} | **${pct(tot, g)}** | ${wdl[i].join("-")} | ${avg} |`);
  }
}

function printFfa(names: string[], files: string[], jobs: Job[], results: JobResult[]) {
  const n = names.length;
  const stats = names.map(() => ({ heats: 0, wins: 0, score: 0, out: 0 }));
  for (const r of results) {
    const idx = jobs[r.id].bots.map((f) => files.indexOf(f));
    idx.forEach((b, slot) => {
      stats[b].heats++;
      stats[b].score += r.scores[slot];
      if (r.out[slot]) stats[b].out++;
      if (r.winner === slot) stats[b].wins++;
    });
  }
  const order = names.map((_, i) => i).sort((i, j) => stats[j].score / stats[j].heats - stats[i].score / stats[i].heats);
  console.log(`\nFree-for-all heats of ${jobs[0].bots.length} (${results.length} heats, ${n} bots).\n`);
  console.log(`| bot | heats | wins | win % | mean score | fell off |`);
  console.log(`|---|---:|---:|---:|---:|---:|`);
  for (const i of order) {
    const s = stats[i];
    console.log(`| **${names[i]}** | ${s.heats} | ${s.wins} | ${Math.round((100 * s.wins) / s.heats)} | ${(s.score / s.heats).toFixed(1)} | ${s.out} |`);
  }
}
