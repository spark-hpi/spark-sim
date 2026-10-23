// Headless checks of the world (physics, sensors, rules) without robot programs: npm test
// Reference values come from the old 2D sim (02_triathlon/tracking/sim) and Pololu datasheets.
import "../overlay/register-world.ts"; // tests run against the full build (competition arenas + scoring)
import loadMujoco from "mujoco";
import { arenaById } from "../src/shared/arenas.ts";
import { World } from "../src/world/world.ts";

const mj = await loadMujoco();
let failures = 0;
function check(name: string, ok: boolean, detail: string) {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}: ${detail}`);
  if (!ok) failures++;
}

const dohyo = arenaById("dohyo");
const t0 = performance.now();
const threshold = World.calibrateProx(mj, dohyo);
console.log(`prox threshold calibrated in ${(performance.now() - t0).toFixed(0)} ms: ${threshold.toExponential(3)}`);

// 1. Full speed straight ahead on a big table
{
  const w = new World(mj, arenaById("free"), [{ x: -0.6, y: 0, yaw: 0 }], { proxThreshold: threshold });
  const r = w.robots[0];
  r.cmd = [6000, 6000];
  const ts = performance.now();
  w.advanceTo(1_500_000);
  const ms = performance.now() - ts;
  const v = Math.hypot(w.d.qvel[r.freeDof], w.d.qvel[r.freeDof + 1]);
  check("top speed", v > 0.55 && v < 0.7, `${v.toFixed(3)} m/s (old sim 0.63, Pololu ~0.65 at 6 V)`);
  check("speed of the sim", ms < 400, `1.5 s sim in ${ms.toFixed(0)} ms (${(1500 / ms).toFixed(0)}x real time, 1 robot)`);
  const [el, er] = w.readEncoders(r);
  check("encoders", el > 2000 && Math.abs(el - er) < 0.05 * el, `left ${el}, right ${er}`);
  const mv = w.readBattery(r);
  check("battery under load", mv > 4600 && mv < 5200, `${mv} mV`);
  const snap = w.snapshot(1).robots[0];
  check("snapshot speed/heading", Math.abs(snap.speed - v) < 0.02 && Math.abs(snap.yaw) < 5, `speed ${snap.speed.toFixed(3)} m/s, yaw ${snap.yaw.toFixed(1)}°`);
  w.dispose();
}

// 2. Line sensors and IMU at rest
{
  const w = new World(mj, dohyo, [{ x: -0.1, y: 0, yaw: 0 }, { x: 0.33, y: 0, yaw: 0 }], { proxThreshold: threshold });
  w.advanceTo(200_000);
  const inner = w.readLine(w.robots[0], true);
  check("line on black", inner.every((v) => v > 900), inner.join(" "));
  const border = w.readLine(w.robots[1], true); // sensor bar at x ≈ 0.377: white border
  check("line on white border", border.filter((v) => v < 300).length >= 3, border.join(" "));
  const imu = w.readImu(w.robots[0]);
  check("imu at rest", Math.abs(imu[2] - 1) < 0.08 && Math.abs(imu[0]) < 0.08, `acc ${imu.slice(0, 3).map((v) => v.toFixed(2)).join(" ")} g`);
  w.dispose();
}

// 3. Grey zones (KotH hill, shuttle bases) are distinguishable from white and black
{
  const w = new World(mj, arenaById("koth"), [{ x: -0.047, y: 0, yaw: 0 }, { x: -0.3, y: 0, yaw: 0 }], { proxThreshold: threshold });
  w.advanceTo(100_000);
  const grey = w.readLine(w.robots[0], true);
  const white = w.readLine(w.robots[1], true);
  const ok = grey.every((v) => v > 200 && v < 500) && white.every((v) => v < 180);
  check("grey vs white", ok, `grey ${grey.join(" ")} | white ${white.join(" ")}`);
  w.dispose();
}

// 4. Prox: opponent head-on at 5..45 cm (old sim: 6/6/5/5/4/3/1/0 at 5..40 cm)
{
  const row: string[] = [];
  for (const cm of [5, 10, 15, 20, 25, 30, 35, 40, 45]) {
    const x0 = -0.2;
    const target = x0 + 0.052 + cm / 100 + 0.0589;
    const w = new World(mj, dohyo, [{ x: x0, y: 0, yaw: 0 }, { x: target, y: 0, yaw: Math.PI }], { proxThreshold: threshold });
    const p = w.readProx(w.robots[0], false);
    row.push(`${cm}:${Math.max(p[2], p[3])}`);
    w.dispose();
  }
  const counts = row.map((s) => Number(s.split(":")[1]));
  check(
    "prox head-on",
    counts[0] === 6 && counts[6] >= 1 && counts[8] === 0 && counts.every((c, i) => i === 0 || c <= counts[i - 1]),
    row.join(" "),
  );
}

// 5. Prox to the side: opponent stands left of us (track facing us)
{
  const w = new World(mj, dohyo, [{ x: -0.1, y: -0.1, yaw: 0 }, { x: -0.1, y: 0.07, yaw: 0 }], { proxThreshold: threshold });
  const p = w.readProx(w.robots[0], false);
  check("prox left side", p[0] + p[1] > p[4] + p[5] && p[0] + p[1] > 0, `ll ${p[0]} lr ${p[1]} fl ${p[2]} fr ${p[3]} rl ${p[4]} rr ${p[5]}`);
  w.dispose();
}

// 6. Driving off the dohyo is detected and judged
{
  const w = new World(mj, dohyo, [{ x: 0.2, y: 0, yaw: 0 }, { x: -0.2, y: 0, yaw: Math.PI }], { proxThreshold: threshold, names: ["Runner", "Stayer"] });
  w.robots[0].cmd = [6000, 6000];
  w.advanceTo(1_500_000);
  const m = w.rules.state;
  check("off the ring", w.robots[0].out && m.ended && m.winner === 1, `${w.events.map((e) => e.text).join("; ")}`);
  w.dispose();
}

// 7. Pushing duel: both full power head-on
{
  const w = new World(mj, dohyo, [{ x: -0.1, y: 0, yaw: 0 }, { x: 0.1, y: 0.01, yaw: Math.PI }], { proxThreshold: threshold, seed: 3 });
  w.robots[0].cmd = [6000, 6000];
  w.robots[1].cmd = [6000, 6000];
  const ts = performance.now();
  w.advanceTo(3_000_000);
  const ms = performance.now() - ts;
  check("pushing duel", w.rules.state.ended, `${w.rules.state.reason || "undecided"}, ${(3000 / ms).toFixed(0)}x real time`);
  w.dispose();
}

// 8. Race: a lap counts only after visiting every checkpoint between two crossings of the start/finish line
{
  const track = arenaById("line");
  const w = new World(mj, track, [{ x: -0.1, y: -0.3, yaw: 0 }], { proxThreshold: threshold });
  const r = w.robots[0];
  r.cmd = [4000, 4000];
  w.advanceTo(600_000); // crosses x = 0 once: start
  w.place(0, { x: -0.1, y: -0.3, yaw: 0 }); // straight back to the line: no lap
  w.advanceTo(1_200_000);
  const shortcut = w.rules.state.laps[0].length;
  // teleport through the curves and the S-bend as if the loop was driven, then cross again
  for (const [x, y, ms] of [[0.7, 0, 1300], [0, 0.35, 1400], [-0.7, 0, 1500]]) {
    w.place(0, { x, y, yaw: Math.PI / 2 });
    w.advanceTo(ms * 1000);
  }
  w.place(0, { x: -0.1, y: -0.3, yaw: 0 });
  w.advanceTo(2_100_000);
  const m = w.rules.state;
  check("race lap", shortcut === 0 && m.laps[0].length === 1, `shortcut ${shortcut} laps, then laps ${JSON.stringify(m.laps[0].map((v) => +v.toFixed(2)))}, ${m.detail[0]}`);
  w.dispose();
}

// 9. King of the hill: standing in the zone scores time — from go (start signal + 5 s) on, and not after Stop
{
  const w = new World(mj, arenaById("koth"), [{ x: 0, y: 0, yaw: 0 }, { x: 0.4, y: 0.4, yaw: 0 }], { proxThreshold: threshold, autoPressA: 0 });
  w.advanceTo(4_000_000);
  const early = w.rules.state.scores[0];
  const phase = w.rules.state.phase;
  w.advanceTo(7_000_000);
  const sc = w.rules.state.scores;
  check("koth zone time", early === 0 && phase === "countdown" && Math.abs(sc[0] - 2) < 0.05 && sc[1] === 0, `before go ${early.toFixed(2)} s (${phase}), 2 s after go ${sc[0].toFixed(2)} s, outside ${sc[1].toFixed(2)} s`);
  const zoneAtStop = sc[0];
  w.judging = false; // Stop
  w.advanceTo(9_000_000);
  const after = w.rules.state;
  check("stop freezes the match", after.scores[0] === zoneAtStop && after.t < 2.1 && !after.ended, `zone ${zoneAtStop.toFixed(2)} → ${after.scores[0].toFixed(2)} s, clock ${after.t.toFixed(2)} s, 2 s after Stop`);
  w.dispose();
}

console.log(failures ? `\n${failures} check(s) failed` : "\nall checks ok");
process.exit(failures ? 1 : 0);
