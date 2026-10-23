// Checks the custom MicroPython WebAssembly build in vendor/micropython
// (built by scripts/build-micropython.sh, documented in vendor/micropython/BUILD.md).
//
// Run with:  node tests/mp-build-check.mjs
//
// Every check loads a fresh MicroPython instance.  Note that micropython.mjs keeps
// some state on globalThis (globalThis.Module, the JS<->Python proxy tables), so
// only the most recently loaded instance may be used; the checks run one after
// another for that reason.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const VENDOR = join(ROOT, "vendor/micropython");
const NPM = join(ROOT, "node_modules/@micropython/micropython-webassembly-pyscript");
const SIM_PY = join(ROOT, "src/robot/python");
const HEAP = 190 * 1024; // what the simulator should pass (RP2040: ~192 KiB GC heap)

const { loadMicroPython } = await import(pathToFileURL(join(VENDOR, "micropython.mjs")).href);

// ----------------------------------------------------------------------------- helpers
const results = [];

async function check(id, title, fn) {
    const t0 = performance.now();
    let status = "PASS";
    let detail = "";
    try {
        detail = (await fn()) ?? "";
        if (typeof detail === "object" && detail.skip) {
            status = "SKIP";
            detail = detail.skip;
        }
    } catch (e) {
        status = "FAIL";
        detail = e?.stack ?? String(e);
    }
    const ms = (performance.now() - t0).toFixed(0);
    results.push({ id, title, status });
    console.log(`${status}  (${id}) ${title}  [${ms} ms]`);
    if (detail) console.log("      " + String(detail).split("\n").join("\n      "));
}

function assert(cond, msg) {
    if (!cond) throw new Error("assertion failed: " + msg);
}

async function load(options = {}) {
    const out = [];
    const mp = await loadMicroPython({
        heapsize: HEAP,
        stdout: (line) => out.push(line),
        stderr: (line) => out.push(line),
        ...options,
    });
    return { mp, out };
}

// Run Python and return the value of the Python variable `result` (via JSON).
function py(mp, code) {
    mp.runPython(code + "\nimport json as _json\n_result_json = _json.dumps(result)");
    return JSON.parse(mp.globals.get("_result_json"));
}

function pythonError(fn) {
    try {
        fn();
    } catch (e) {
        if (e.name === "PythonError") return e;
        throw e;
    }
    return null;
}

const bestOf = (n, f) => {
    let best = Infinity;
    for (let i = 0; i < n; i++) {
        const t = performance.now();
        f();
        best = Math.min(best, performance.now() - t);
    }
    return best;
};

// ----------------------------------------------------------------------------- build present
await check("0", "vendor build present", () => {
    const sizes = ["micropython.mjs", "micropython.wasm"].map((f) => {
        const p = join(VENDOR, f);
        assert(existsSync(p), `${relative(ROOT, p)} missing - run scripts/build-micropython.sh`);
        return `${f} ${(statSync(p).size / 1024).toFixed(0)} KiB`;
    });
    return sizes.join(", ");
});

// ----------------------------------------------------------------------------- (a) GC in a long call
await check("a", "GC runs inside one long call: 400k lists keep gc.mem_alloc() under the heap size", async () => {
    const { mp } = await load();
    const ret = mp.runPython(`
import gc
peak = 0
for i in range(400000):
    x = [i, i + 1]
    if i % 1000 == 0:
        peak = max(peak, gc.mem_alloc())
final = gc.mem_alloc()
total = gc.mem_alloc() + gc.mem_free()
`);
    assert(!(ret instanceof Promise), "runPython must stay synchronous");
    const peak = mp.globals.get("peak");
    const total = mp.globals.get("total");
    const stats = mp.gcStats();
    assert(total <= HEAP, `heap total ${total} > ${HEAP}`);
    assert(peak < HEAP, `peak mem_alloc ${peak} >= heap ${HEAP}`);
    assert(stats.collections > 10, `only ${stats.collections} collections`);
    assert(stats.skipped === 0, `${stats.skipped} collections skipped`);
    return `peak mem_alloc ${peak} B of ${total} B heap, ${stats.collections} collections, max spilled locals ${stats.maxSpillBytes} B`;
});

// ----------------------------------------------------------------------------- (b) hard heap limit
await check("b", "heap is a hard limit: 300 KB bytearray and growing live data raise MemoryError", async () => {
    const { mp } = await load();
    const e = pythonError(() => mp.runPython("b = bytearray(300 * 1024)"));
    assert(e && e.type === "MemoryError", `expected MemoryError, got ${e?.type ?? "no error"}`);
    // Live data that grows without bound must fail near the heap size, and the
    // interpreter must stay usable afterwards.
    const r = py(
        mp,
        `
import gc
keep = []
try:
    while True:
        keep.append(bytearray(1000))
except MemoryError:
    pass
n = len(keep)
keep = None
gc.collect()
result = [n, gc.mem_alloc()]
`,
    );
    assert(r[0] > 100 && r[0] < 190, `held ${r[0]} KB before MemoryError`);
    assert(r[1] < 30 * 1024, `memory not recovered: ${r[1]} B still allocated`);
    return `bytearray(300 KiB) -> MemoryError; live data limit ~${r[0]} KB; ${r[1]} B in use after gc.collect()`;
});

// ----------------------------------------------------------------------------- (c) settrace
await check("c", "sys.settrace line events inside exec()'d code", async () => {
    const { mp } = await load();
    const r = py(
        mp,
        `
import sys
lines = []
def tr(frame, event, arg):
    if event == "line":
        lines.append((frame.f_code.co_filename, frame.f_lineno))
    return tr
src = "a = 1\\nfor i in range(3):\\n    a += i\\nb = a\\n"
sys.settrace(tr)
exec(compile(src, "main.py", "exec"), {})
sys.settrace(None)
result = lines
`,
    );
    const got = r.map(([f, l]) => `${f}:${l}`).join(" ");
    const want = [1, 2, 3, 2, 3, 2, 3, 2, 3, 4].map((l) => `main.py:${l}`).join(" ");
    assert(got === want, `line events\n  got  ${got}\n  want ${want}`);
    return `${r.length} line events: ${r.map((x) => x[1]).join(",")}`;
});

// ----------------------------------------------------------------------------- (d) JS <-> Python
await check("d", "registerJsModule round trip incl. Float64Array on a SharedArrayBuffer; FS + pyimport", async () => {
    const { mp } = await load();
    const f64 = new Float64Array(new SharedArrayBuffer(8 * 8));
    f64.set([1.5, 2.25, -3, 1e6]);
    const seen = [];
    mp.registerJsModule("_hal", {
        num: (x) => x * 2,
        str: (s) => s.toUpperCase(),
        arr: () => f64,
        record: (...args) => seen.push(args),
    });
    mp.FS.mkdir("/lib");
    mp.FS.mkdir("/lib/pkg");
    mp.FS.writeFile("/lib/pkg/__init__.py", "");
    mp.FS.writeFile(
        "/lib/pkg/mod.py",
        "import _hal\n" +
            "def greet(name):\n    return 'hello ' + _hal.str(name)\n" +
            "def nothing(x):\n    return None\n" +
            "def total():\n    a = _hal.arr()\n    a[4] = a[0] + a[1]\n    return a[0] + a[1] + a[2] + a[3]\n",
    );
    mp.runPython("import sys\nsys.path.insert(0, '/lib')");
    mp.runPython("import _hal\n_hal.record(_hal.num(21), _hal.str('abc'), _hal.arr()[3], len('x' * _hal.num(2)))");
    assert(JSON.stringify(seen[0]) === JSON.stringify([42, "ABC", 1e6, 4]), `record got ${JSON.stringify(seen[0])}`);
    const mod = mp.pyimport("pkg.mod");
    const g = mod.greet("world");
    assert(g === "hello WORLD", `greet returned ${JSON.stringify(g)}`);
    const n = mod.nothing("x");
    assert(n === null || n === undefined, `nothing returned ${n}`);
    const t = mod.total();
    assert(t === 1.5 + 2.25 - 3 + 1e6, `total returned ${t}`);
    assert(f64[4] === 3.75, `write into Float64Array from Python: f64[4] = ${f64[4]}`);
    return `JS->Py values ${JSON.stringify(seen[0])}, greet() -> "${g}", nothing() -> ${n}, Python wrote f64[4] = ${f64[4]}`;
});

// ----------------------------------------------------------------------------- (e) framebuf
await check("e", "framebuf MONO_VLSB text renders pixels", async () => {
    const { mp } = await load();
    const r = py(
        mp,
        `
import framebuf
buf = bytearray(128 * 64 // 8)
fb = framebuf.FrameBuffer(buf, 128, 64, framebuf.MONO_VLSB)
fb.fill(0)
fb.text("Hi", 0, 0, 1)
fb.rect(0, 20, 10, 10, 1)
on = sum(bin(b).count("1") for b in buf)
result = [on, fb.pixel(0, 20), fb.pixel(127, 63), len(buf.hex())]
`,
    );
    assert(r[0] > 20, `only ${r[0]} pixels set`);
    assert(r[1] === 1 && r[2] === 0, `pixel() ${r[1]} ${r[2]}`);
    assert(r[3] === 2048, `hex length ${r[3]}`);
    return `${r[0]} pixels set`;
});

// ----------------------------------------------------------------------------- (f) sys.modules override + modules
await check("f", "sys.modules['time'] override, plus the modules the simulator needs", async () => {
    const { mp } = await load();
    const r = py(
        mp,
        `
import sys
class _FakeTime:
    def ticks_ms(self):
        return 12345
sys.modules["time"] = _FakeTime()
sys.modules["utime"] = sys.modules["time"]
g = {}
exec(compile("import time\\nfrom time import ticks_ms\\nv = (time.ticks_ms(), ticks_ms())", "main.py", "exec"), g)
from micropython import const
import array, struct, math, random, gc, framebuf, io
X = const(7)
random.seed(42)
r1 = [random.randint(0, 1000) for _ in range(3)]
random.seed(42)
r2 = [random.randint(0, 1000) for _ in range(3)]
buf = io.StringIO()
sys.print_exception(ValueError("boom"), buf)
result = {
    "time": list(g["v"]),
    "const": X,
    "hex": b"\\x01\\xab".hex(),
    "array": list(array.array("h", [1, -2])),
    "struct": list(struct.unpack("<hB", struct.pack("<hB", -5, 200))),
    "math": round(math.sqrt(2), 6),
    "random_repeatable": r1 == r2,
    "exc": buf.getvalue().strip().split("\\n")[-1],
    "platform": sys.platform,
}
`,
    );
    assert(JSON.stringify(r.time) === "[12345,12345]", `time override ${JSON.stringify(r.time)}`);
    assert(r.const === 7 && r.hex === "01ab", "const/bytes.hex");
    assert(JSON.stringify(r.array) === "[1,-2]" && JSON.stringify(r.struct) === "[-5,200]", "array/struct");
    assert(r.math === 1.414214 && r.random_repeatable, "math/random");
    assert(r.exc === "ValueError: boom", `print_exception ${r.exc}`);
    return JSON.stringify(r);
});

// ----------------------------------------------------------------------------- (g) speed vs npm
await check("g", "speed: traced loop of 300k iterations vs the npm settrace build", async () => {
    const npmWasm = join(NPM, "micropython-settrace.wasm");
    if (!existsSync(npmWasm)) return { skip: "npm package not installed" };
    const bench = `
import sys
_cnt = [0]
def _trace(frame, event, arg):
    if event == "line":
        n = _cnt[0] + 1
        if n >= 32:
            _cnt[0] = 0
        else:
            _cnt[0] = n
    return _trace
def loop(n):
    s = 0
    for i in range(n):
        s += i * 2
    return s
`;
    const run = "sys.settrace(_trace)\nloop(300000)\nsys.settrace(None)";
    const ours = (await load()).mp;
    ours.runPython(bench);
    const { loadMicroPython: loadNpm } = await import(pathToFileURL(join(NPM, "micropython.mjs")).href);
    const npm = await loadNpm({ url: npmWasm, heapsize: 512 * 1024, stdout: () => {} });
    npm.runPython(bench);
    // Interleave the runs and keep the best CPU time of each (robust against other
    // load on the machine). The proxy helpers of both builds find their instance
    // through globalThis.Module.
    const cpuMs = (f) => {
        const c = process.cpuUsage();
        f();
        const d = process.cpuUsage(c);
        return (d.user + d.system) / 1000;
    };
    let tOurs = Infinity;
    let tNpm = Infinity;
    for (let i = 0; i < 5; i++) {
        globalThis.Module = ours._module;
        tOurs = Math.min(tOurs, cpuMs(() => ours.runPython(run)));
        globalThis.Module = npm._module;
        tNpm = Math.min(tNpm, cpuMs(() => npm.runPython(run)));
    }
    const ratio = tOurs / tNpm;
    assert(ratio < 1.5, `custom build is ${ratio.toFixed(2)}x the npm time`);
    return `custom ${tOurs.toFixed(0)} ms, npm ${tNpm.toFixed(0)} ms CPU time (ratio ${ratio.toFixed(2)}, best of 5, interleaved)`;
});

// ----------------------------------------------------------------------------- (h) bytecode hook
await check("h", "bytecode counter hook (stretch goal): callback every N bytecodes, takeBytecodeCount()", async () => {
    const periods = [];
    const { mp } = await load({ bytecodeHook: { interval: 1000, callback: (n) => periods.push(n) } });
    mp.runPython("def loop(n):\n    s = 0\n    for i in range(n):\n        s += i\n    return s");
    mp.takeBytecodeCount();
    periods.length = 0;
    mp.runPython("loop(10000)");
    const rest = mp.takeBytecodeCount();
    const total = periods.reduce((a, b) => a + b, 0) + rest;
    assert(periods.length > 50 && periods.every((n) => n === 1000), `periods ${periods.slice(0, 5)}`);
    // Same code, same count: deterministic.
    periods.length = 0;
    mp.runPython("loop(10000)");
    const total2 = periods.reduce((a, b) => a + b, 0) + mp.takeBytecodeCount();
    assert(total === total2, `not deterministic: ${total} vs ${total2}`);
    // interrupt() from inside the hook stops a runaway loop with KeyboardInterrupt.
    let fired = 0;
    mp.setBytecodeHook(10000, () => {
        if (++fired === 3) mp.interrupt();
    });
    const e = pythonError(() => mp.runPython("while True:\n    pass"));
    assert(e && e.type === "KeyboardInterrupt", `expected KeyboardInterrupt, got ${e?.type}`);
    mp.setBytecodeHook(0, null);
    // Overhead compared with no hook.
    mp.runPython("loop(1000)");
    const tOff = bestOf(3, () => mp.runPython("loop(200000)"));
    mp.setBytecodeHook(1000, () => {});
    const tOn = bestOf(3, () => mp.runPython("loop(200000)"));
    mp.setBytecodeHook(0, null);
    return `${total} bytecodes for loop(10000) (${periods.length} callbacks); interrupt() works; loop(200000) ${tOff.toFixed(0)} ms without hook, ${tOn.toFixed(0)} ms with hook`;
});

// ----------------------------------------------------------------------------- (i) GC robustness
await check("i", "GC torture: gc.threshold(0) (collect on every allocation) keeps results correct", async () => {
    const { mp } = await load();
    const r = py(
        mp,
        `
import gc, re
gc.threshold(0)
def double(m):
    return str(int(m.group(0)) * 2)
a = re.sub(r"\\d+", double, "10 20 30 40 50")
d = {}
for i in range(300):
    d["k%d" % i] = [i] * (i % 7)
ok = all(d["k%d" % i] == [i] * (i % 7) for i in range(300))
s = "-".join(str(x) for x in sorted(set(range(50)), key=lambda v: -v))
gc.threshold(-1)
result = [a, ok, s[:14]]
`,
    );
    assert(r[0] === "20 40 60 80 100", `re.sub -> ${r[0]}`);
    assert(r[1] === true && r[2] === "49-48-47-46-45", `dict/sorted ${r[1]} ${r[2]}`);
    return `re.sub with a string pattern -> "${r[0]}" (needs the interior-pointer scan), ${mp.gcStats().collections} collections`;
});

// ----------------------------------------------------------------------------- (j) nested calls
await check("j", "nested Python -> JS -> Python calls stay correct (GC skipped while nested)", async () => {
    const { mp } = await load();
    let inner = null;
    mp.registerJsModule("_cb", { call: (n) => inner(n) });
    mp.runPython("def work(n):\n    return sum(len([i] * 3) for i in range(n))");
    inner = mp.globals.get("work");
    const r = py(
        mp,
        `
import _cb, gc
acc = 0
for k in range(200):
    acc += _cb.call(50)
    junk = [[k]] * 20
result = acc
`,
    );
    assert(r === 200 * 150, `acc ${r}`);
    const s = mp.gcStats();
    return `result ${r}; ${s.collections} collections at depth 1, ${s.skipped} skipped while nested`;
});

// ----------------------------------------------------------------------------- (k) simulator runtime
await check("k", "simulator runtime (src/robot/python) runs on the build with a fake HAL", async () => {
    if (!existsSync(join(SIM_PY, "_spark_rt.py"))) return { skip: "src/robot/python not found" };
    const files = {};
    (function walk(dir) {
        for (const name of readdirSync(dir)) {
            const p = join(dir, name);
            if (statSync(p).isDirectory()) walk(p);
            else if (name.endsWith(".py")) files[relative(SIM_PY, p)] = readFileSync(p, "utf8");
        }
    })(SIM_PY);

    async function runProgram(code) {
        const { mp, out } = await load({ linebuffer: true });
        let clock = 0;
        let lines = 0;
        const f64 = new Float64Array(new SharedArrayBuffer(64 * 8));
        const hal = {
            now: () => clock,
            cpu: (n) => {
                lines += n;
                clock += n * 6;
            },
            charge: (us) => (clock += us),
            untimed: () => {}, // library internals the world models (see src/robot/runtime.ts)
            untimed_save: () => 0,
            untimed_restore: () => {},
            irq_at: () => {},
            ticks_diff: (a, b) => ((a - b + 0x20000000) & 0x3fffffff) - 0x20000000,
            ticks_add: (a, d) => (a + d) & 0x3fffffff,
            rpc: (op, ...args) => {
                if (op === 2) clock += args[0]; // OP_SLEEP
                f64.fill(0);
                f64[0] = clock;
                if (op === 8) f64[1] = 4800; // OP_BAT
                return f64;
            },
            button: () => 0,
            show: () => {},
            leds: () => {},
            yellow: () => {},
            buzz: () => {},
        };
        for (const [path, src] of Object.entries(files)) {
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
        const err = rt.run(code, 1);
        return { err, out, clock, lines, gc: mp.gcStats() };
    }

    // Allocation churn for 5 s of simulated time: must finish, memory is reused.
    const churn = await runProgram(`
from zumo_2040_robot import robot
import time, gc
display = robot.Display()
motors = robot.Motors()
battery = robot.Battery()
start = time.ticks_ms()
loops = 0
while time.ticks_diff(time.ticks_ms(), start) < 5000:
    junk = [bytearray(64) for _ in range(30)]
    display.fill(0)
    display.text("mV %d" % battery.get_level_millivolts(), 0, 0)
    display.show()
    motors.set_speeds(1000, -1000)
    loops += 1
    time.sleep_ms(5)
print("loops", loops, "mem", gc.mem_alloc())
`);
    assert(churn.err === null || churn.err === undefined, `churn program failed: ${churn.err}\n${churn.out.join("\n")}`);
    assert(churn.gc.collections > 0, "no collections in churn program");
    // Unbounded live data: MemoryError like on the robot.
    const leak = await runProgram("keep = []\nwhile True:\n    keep.append(bytearray(512))\n");
    assert(typeof leak.err === "string" && leak.err.startsWith("MemoryError"), `leak program: ${leak.err}`);
    return `churn: "${churn.out.join(" ")}", ${churn.lines} traced lines, ${churn.gc.collections} collections; leak -> "${leak.err}"`;
});

// ----------------------------------------------------------------------------- summary
const failed = results.filter((r) => r.status === "FAIL");
const skipped = results.filter((r) => r.status === "SKIP");
console.log(
    `\n${failed.length ? "FAIL" : "PASS"}: ${results.length - failed.length - skipped.length} passed, ` +
        `${failed.length} failed, ${skipped.length} skipped` +
        (failed.length ? ` (${failed.map((r) => r.id).join(", ")})` : ""),
);
process.exit(failed.length ? 1 : 0);
