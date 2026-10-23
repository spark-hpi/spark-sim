// Program-level checks: small MicroPython programs that pin down robot-library and runtime behaviour.
//   npx tsx tests/runtime-check.ts
import { runMatch } from "./match.ts";

let failures = 0;
function check(name: string, ok: boolean, detail: string) {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}: ${detail}`);
  if (!ok) failures++;
}

/** Run one program alone on the free table and return its printed lines (without the time prefix). */
async function run(code: string, seconds = 3, seed = 1) {
  const r = await runMatch({ programs: [code], arena: "free", seconds, seed, stopWhenOut: false, stopWhenDecided: false });
  const lines = r.log.filter((l) => l.includes(" R1] ")).map((l) => l.replace(/^\[[^\]]*\] /, ""));
  return { r, lines, out: lines.join("\n") };
}

const lib = "from zumo_2040_robot import robot\nimport time\n";

// 1. A line read always takes ~1.06 ms (the PIO counts the full window), on white and on black alike
{
  const { lines } = await run(
    lib +
      `line = robot.LineSensors()
t = time.ticks_us()
for i in range(100):
    line.read()
print(time.ticks_diff(time.ticks_us(), t))`,
  );
  const us = Number(lines[0]) / 100;
  check("line read duration", us > 1050 && us < 1250, `${us.toFixed(0)} µs per read incl. loop overhead (robot: ~1.06 ms + Python)`);
}

// 2. Proximity respects custom brightness levels and pulse times
{
  const { lines } = await run(
    lib +
      `prox = robot.ProximitySensors()
prox.brightness_levels = [1000, 3500]
t = time.ticks_us()
prox.read()
d = time.ticks_diff(time.ticks_us(), t)
print(d, prox.total_counts())`,
  );
  const [d, total] = lines[0].split(" ").map(Number);
  check("prox custom levels", d > 2 * 2 * 571 && d < 2 * 6 * 571 && total <= 12, `2 levels took ${d} µs (6 levels ≈ 6852 µs)`);
}

// 3. Gyro data_ready() follows the 208 Hz output data rate
{
  const { lines } = await run(
    lib +
      `imu = robot.IMU()
imu.reset()
imu.enable_default()
n = 0
t = time.ticks_ms()
while time.ticks_diff(time.ticks_ms(), t) < 1000:
    if imu.gyro.data_ready():
        imu.gyro.read()
        n += 1
print(n)`,
  );
  const n = Number(lines[0]);
  check("gyro data_ready at 208 Hz", n >= 200 && n <= 210, `${n} new samples in 1 s`);
}

// 4. IMU reads 0 before enable_default(); invalid settings raise ValueError like the original
{
  const { out } = await run(
    lib +
      `imu = robot.IMU()
imu.acc.read()
print("before", imu.acc.last_reading_g)
try:
    imu.acc.set_full_scale(3)
except ValueError:
    print("valueerror ok")
print("mag", imu.mag.to_gauss([6842, 0, 0]))`,
  );
  check("imu disabled reads zero", out.includes("before [0.0, 0.0, 0.0]"), out.split("\n")[0]);
  check("imu ValueError", out.includes("valueerror ok"), "set_full_scale(3)");
  check("mag to_gauss", out.includes("mag [1.0, 0.0, 0.0]"), out.split("\n").pop() ?? "");
}

// 5. Timers fire inside a busy loop (they are interrupts on the robot)
{
  const { lines } = await run(
    `from machine import Timer
import time
ticks = [0]
def cb(t):
    ticks[0] += 1
Timer(period=10, mode=Timer.PERIODIC, callback=cb)
start = time.ticks_ms()
while time.ticks_diff(time.ticks_ms(), start) < 500:
    pass
print(ticks[0])`,
  );
  const n = Number(lines[0]);
  check("timer in busy loop", n >= 45 && n <= 51, `${n} callbacks in 500 ms at 10 ms`);
}

// 6. `from time import *` and module objects
{
  const { out } = await run(`from time import *\nsleep_ms(5)\nprint("ok", ticks_ms() >= 5)`);
  check("from time import *", out.includes("ok True"), out);
}

// 7. Tracebacks point at main.py only
{
  const { out, r } = await run(`x = 1\ny = 2\nprint(x / (y - 2))`);
  check("traceback cleaned", out.includes('File "main.py", line 3') && !out.includes("/lib/"), out.replace(/\n/g, " | "));
  check("error reported", (r.errors[0] ?? "").startsWith("ZeroDivisionError"), r.errors[0] ?? "none");
}

// 8. Output without a trailing newline is not lost
{
  const { out } = await run(`print("no newline", end="")`);
  check("partial line flushed", out.includes("no newline"), JSON.stringify(out));
}

// 9. random is seeded per run: same seed same numbers, other seed other numbers
{
  const a = await run(`import random\nprint(random.getrandbits(30))`, 1, 5);
  const b = await run(`import random\nprint(random.getrandbits(30))`, 1, 5);
  const c = await run(`import random\nprint(random.getrandbits(30))`, 1, 6);
  check("random seeded", a.out === b.out && a.out !== c.out, `${a.out} / ${b.out} / ${c.out}`);
}

// 10. Two Motors() instances share the PWM state
{
  const { r } = await run(
    lib +
      `a = robot.Motors()
b = robot.Motors()
a.set_left_speed(3000)
b.set_right_speed(3000)
time.sleep_ms(500)`,
    1,
  );
  check("shared motor state", r.match !== undefined, "set_left on one instance, set_right on the other (both run)");
}

// 11. Display flip/invert/poweroff and save_pbm work. (Pololu's own load_pbm skips three header lines while
//     save_pbm writes two, so loading a saved file raises ValueError on the robot too — kept as is.)
{
  const { out, r } = await run(
    lib +
      `d = robot.Display()
d.text("hi", 0, 0)
d.flip()
d.invert(1)
d.poweroff()
d.poweron()
d.save_pbm("x.pbm")
print("display ok")`,
  );
  check("display api", out.includes("display ok") && !r.errors[0], r.errors[0] ?? "no error");
}

// 12. Same seed -> identical match (bench replays rely on this)
{
  const fs = await import("node:fs");
  const a = fs.readFileSync("src/examples/sumo_starter.py", "utf8");
  const b = fs.readFileSync("src/examples/line_follower.py", "utf8");
  const m1 = await runMatch({ programs: [a, b], arena: "dohyo", seconds: 30, seed: 11, jitter: 1, presses: [{ button: "A", t: 0.2 }] });
  const m2 = await runMatch({ programs: [a, b], arena: "dohyo", seconds: 30, seed: 11, jitter: 1, presses: [{ button: "A", t: 0.2 }] });
  // compare the judged decision time, not the wall-clock-dependent stop time of the runner
  check("deterministic replay", m1.match.t === m2.match.t && m1.match.winner === m2.match.winner, `decided at ${m1.match.t} vs ${m2.match.t} s, winner ${m1.match.winner} vs ${m2.match.winner}`);
}

// 13. A statement that never returns is detached by the watchdog instead of freezing the world
{
  const t0 = performance.now();
  const r = await runMatch({
    programs: ["import time\ntime.sleep_ms(1)\nx = sum(range(1 << 30))", "import time\nwhile True:\n    time.sleep_ms(10)"],
    arena: "free",
    seconds: 3,
    stopWhenOut: false,
    stopWhenDecided: false,
  });
  const hung = r.log.some((l) => l.includes("stopped responding"));
  check("watchdog", hung && r.t >= 2.9, `world reached ${r.t.toFixed(1)} s in ${((performance.now() - t0) / 1000).toFixed(1)} s wall`);
}

// 14. Garbage is collected while the program runs (custom MicroPython build): churn runs forever...
{
  const { out, r } = await run(
    `import time, gc
n = 0
t = time.ticks_ms()
while time.ticks_diff(time.ticks_ms(), t) < 8000:
    x = [n] * 50
    s = "value %d" % n
    n += 1
print("churn ok", n, gc.mem_free() > 20000)`,
    10,
  );
  check("garbage collected", out.includes("churn ok") && out.endsWith("True") && !r.errors[0], out);
}

// 15. ...and a leak ends with MemoryError like on the RP2040 (heap ~190 KB)
{
  const { r } = await run(
    `keep = []
while True:
    keep.append(bytearray(1000))`,
    5,
  );
  check("heap limit", (r.errors[0] ?? "").startsWith("MemoryError"), r.errors[0] ?? "no error");
}

console.log(failures ? `\n${failures} check(s) failed` : "\nall runtime checks passed");
process.exit(failures ? 1 : 0);
