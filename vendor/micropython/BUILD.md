# MicroPython WebAssembly build for the SPARK simulator

`micropython.mjs` + `micropython.wasm` in this directory are a custom build of the
MicroPython webassembly port. They replace the npm package
`@micropython/micropython-webassembly-pyscript@1.29.0-6` (file
`micropython-settrace.wasm`) and keep its JavaScript API.

Why: the npm package is the *pyscript* variant, which enables
`MICROPY_GC_SPLIT_HEAP_AUTO`. There, `gc_collect()` only sets a flag and the real
collection runs when the outermost JS→Python call returns. A robot program is one
call that never returns (`while True:`), so nothing is ever freed and the heap
grows without limit (400k small lists in one call → `gc.mem_alloc()` ≈ 100 MB).

This build:

1. collects garbage **inside** long-running synchronous code;
2. has a **fixed heap**: `loadMicroPython({ heapsize })` is a hard limit, so
   programs get `MemoryError` like on the RP2040;
3. has `sys.settrace` (available to programs; the simulator itself no longer needs it);
4. adds a cheap **bytecode counter hook** that calls JS every N bytecodes
   (an alternative to settrace that costs almost nothing);
5. has a **timer interrupt**: when the hook returns a truthy value, the handler
   registered with `_spark_irq.set(handler)` is scheduled with
   `mp_sched_schedule` and runs at the VM's next pending check — also inside
   `while not done: pass`, exactly like rp2 soft timers;
6. is reproducible: `scripts/build-micropython.sh` pins every version, and builds
   in two independent checkouts gave bit-identical files (same sha256).

## Files

| Path | What |
| --- | --- |
| `micropython.mjs`, `micropython.wasm` | build output (generated, do not edit) |
| `micropython.d.mts` | TypeScript declarations for `micropython.mjs` |
| `variants/spark/` | the MicroPython variant (`mpconfigvariant.h`, `mpconfigvariant.mk`) |
| `patches/0001-spark-sync-gc-and-bytecode-hook.patch` | changes to MicroPython v1.29.0 (port + `py/vm.c`) |
| `tools/gc-torture-cli.mjs` | runs MicroPython's test suite with a collection on every allocation |
| `tools/expected-upstream-failures.txt` | known failures of the upstream suite (with reasons) |
| `../../scripts/build-micropython.sh` | builds everything and installs the output here |
| `../../tests/mp-build-check.mjs` | checks of this build (`node tests/mp-build-check.mjs`) |

## Versions

| | |
| --- | --- |
| MicroPython | **v1.29.0**, commit `0fd6c573ea815774668bbb16b8e197c8822368b2` (same release as the npm package 1.29.0-6) |
| micropython-lib | submodule as pinned by v1.29.0 (`ee4bb8ff139e24c42b739935fbd8ec7c4d061e02`); only needed by the build tooling |
| Emscripten | **emsdk 6.0.8** (emcc 6.0.8, `aeb67926e7de656da38bc807d83050af93578758`). MicroPython's CI (`tools/ci.sh`) installs emsdk `latest`; 6.0.8 was the latest release when v1.29.0 and the npm package were published (2026-08-24). |
| Built and tested on | macOS 26.1 (arm64), Node v20.20.0, Python 3.14 |

## Sizes

| File | This build | gzip -9 | npm `micropython-settrace.wasm` / `micropython.mjs` | gzip -9 |
| --- | --- | --- | --- | --- |
| `micropython.wasm` | 638,478 B | 210,022 B | 492,490 B | 209,062 B |
| `micropython.mjs` | 118,489 B | 29,992 B | 110,120 B | 30,880 B |

sha256 (deterministic; a rebuild from scratch must give the same):

```
8afcaa43fb51ea029d222eee6d5263f8894de9d2e45e397874921fc9475ba949  micropython.wasm
c5064336ec4274574b4d6f9734316323f8dde3bed347947e0ba76110cbc3d01e  micropython.mjs
```

The wasm is larger before compression because of the Asyncify instrumentation
(see below); compressed it is the same size as the npm build.

## Build configuration

Variant `variants/spark` (based on upstream `variants/standard`, built with
`make VARIANT_DIR=.../variants/spark`):

- `MICROPY_CONFIG_ROM_LEVEL_EXTRA_FEATURES`: the level of the standard variant
  **and of the rp2 port (RP2040)**. Contains everything the simulator needs:
  `framebuf` (MONO_VLSB, text), `array`, `micropython.const`, `bytes.hex()`,
  `compile()`/`exec`, `sys.modules`, `random` (incl. `seed`, `randint`, ...),
  `math`, `struct`, `gc`, `io.StringIO`, `sys.print_exception`.
- No `MICROPY_GC_SPLIT_HEAP(_AUTO)`: one fixed heap of `heapsize` bytes.
- `MICROPY_GC_SYNC_ASYNCIFY=1`: synchronous garbage collection (patch, below).
- `MICROPY_PY_SYS_SETTRACE=1`.
- `MICROPY_VARIANT_ENABLE_JS_HOOK=0`: the standard variant polls stdin for Ctrl-C
  (in Node it calls `fs.readSync` on stdin), which must not happen in a worker.
- `MICROPY_VM_HOOK_BYTECODE_COUNTER=1`: bytecode counter hook (patch, below).
- Frozen modules: the port's default manifest (`asyncio`, driven by the JS event loop).
- Compile: upstream flags (`-std=c99 -Wall -Werror -Os -DNDEBUG`).
- Link: upstream flags plus `-s ASYNCIFY -s ALLOW_MEMORY_GROWTH -O2`
  (upstream links without `-O`, which leaves the Asyncify code unoptimised;
  `-O3` and `-O2`/`-O3` compilation measured within noise of this setting).
- Extra exports: `_mp_js_gc_scan_region`, `_mp_js_vm_hook_set_interval`,
  `_mp_js_vm_hook_take`, runtime method `HEAPU32`.

## How the synchronous GC works (patch)

MicroPython's GC is conservative: it scans the C stack for anything that looks
like a pointer into the heap. In WebAssembly, many values live in *wasm locals*,
which are invisible to a memory scan. Upstream's standard variant uses
`emscripten_scan_registers()`, which spills the locals with an Asyncify unwind
but finishes **asynchronously via `setTimeout`**: any `runPython()` that triggers
a collection aborts ("The call to mp_js_do_exec is running asynchronously").
That is why the pyscript variant defers collection instead, with the problem
described above.

The patch (`ports/webassembly/main.c`, `library.js`, `api.js`) does the same
unwind, but synchronously:

1. `gc_collect()` marks the roots, scans the C shadow stack and calls the JS
   import `mp_js_gc_spill_and_scan()`, which starts an Asyncify unwind into a
   buffer (`gcspillsize`, default 1 MiB; the deepest recursion the C-stack limit
   allows needs ~28 KB).
2. Every active wasm frame saves its locals into the buffer and returns, up to
   the JS→C entry point. All entry points (`Module._mp_*`, `Module._proxy_*`, which
   `ccall` uses) are wrapped by `$MPGC.wrap` in `api.js`.
3. The wrapper sees the unwind, calls `mp_js_gc_scan_region()` on the spilled
   locals, then starts a rewind and calls the entry point again. The rewind
   restores all frames and ends in `mp_js_gc_spill_and_scan()`, so `gc_collect()`
   continues with the sweep, inside the same synchronous call.

Stack-like memory (spilled locals, shadow stack) is scanned with **interior
pointer** support: a word pointing anywhere into an allocated block chain keeps
it alive. Plain MicroPython only accepts pointers to the first block. Running
MicroPython's test suite with a collection on every allocation showed why this
matters: `re.sub()` with a string pattern keeps only `&self->re` of a temporary
regex object in a local, so the object was freed during the replacement
callback and the result was wrong.

**Nested calls.** Unwinding through a JS frame is only possible for emscripten's
stateless `invoke_*` trampolines. If Python calls a JS function that calls back
into Python, the outer frames cannot be spilled, and `gc_collect()` skips the
collection rather than risk freeing live objects (`gcStats().skipped`). To make
this rare, Python→JS calls (`jsproxy_call`) first run a collection once a
quarter of the heap has been allocated since the last one, so the nested code
starts with free memory. The simulator does not nest (its `_spark` functions
never call Python).

## Bytecode counter hook (stretch goal)

`py/vm.c` gets a `MICROPY_VM_HOOK_BYTECODE` macro, run once per executed
bytecode. The variant decrements a budget there and, when it reaches zero, calls
the JS callback with the number of bytecodes in the period. Cost: one global
decrement per bytecode. In a 200k-iteration loop: 62 ms without hook, 62 ms
with hook (interval 1000), versus ~5× slower with a `sys.settrace` line
counter. The count is deterministic: the same code always gives the same
number.

```js
const mp = await loadMicroPython({
  heapsize: 190 * 1024,
  bytecodeHook: { interval: 256, callback: (n) => charge(n * US_PER_BYTECODE) },
});
mp.takeBytecodeCount();          // bytecodes since the last callback; restarts the period
mp.setBytecodeHook(1000, cb);    // change interval/callback; (0, null) disables
mp.interrupt();                  // KeyboardInterrupt in Python at the next branch
```

The callback runs synchronously inside the VM. It may do anything in JS
(including `Atomics.wait`), but must not throw (exceptions are caught and logged)
and must not call back into Python.

**Timer interrupt.** If the callback returns a truthy value, the VM schedules
the Python handler registered with `_spark_irq.set(handler)` (a builtin module of
this build) via `mp_sched_schedule`. MicroPython runs scheduled callbacks at its
pending checks (backward jumps, returns), so the handler also runs inside loops
whose body is a single statement, where `sys.settrace` sees no line events. The
simulator uses it for `machine.Timer`: Python tells the clock when the next timer
is due (`irq_at`), the hook raises the interrupt once that robot time is reached.

## JavaScript API

Same as the npm package's `micropython.mjs` (upstream v1.29.0 `api.js`):
`loadMicroPython({ url, heapsize, pystack, linebuffer, stdin, stdout, stderr })`
returning `{ _module, PyProxy, FS, globals, registerJsModule, pyimport,
runPython, runPythonAsync, replInit, replProcessChar,
replProcessCharWithAsyncify }`.

Additions: options `bytecodeHook` and `gcspillsize`; methods `setBytecodeHook`,
`takeBytecodeCount`, `interrupt`, `gcStats`. Types: `micropython.d.mts`.

Differences from the npm package:

- No `romfs` option (the npm build comes from PyScript's fork; the simulator
  does not use it).
- Feature level EXTRA (rp2 port) instead of FULL (pyscript), so it lacks:
  `weakref`, t-strings, `function.__code__`, `deflate` compression, and the
  frozen micropython-lib packages of the pyscript variant (`logging`,
  `functools`, `collections.defaultdict`, `datetime`, `unittest`, ...), which
  are not on the robot either. Error messages use the rp2 level ("NORMAL"), e.g.
  `TypeError: function takes 2 positional arguments but 1 were given` instead of
  `f() takes ...`, and `int('x')` does not repeat the value.
- Like the npm build: `float` is double precision (the RP2040 uses single
  precision), the Python stack is the `pystack` buffer, recursion is limited by
  the 32 KiB C-stack check (~200 Python levels), and only one instance per JS
  realm is usable at a time (the proxy code uses `globalThis.Module`).

## Integration into the simulator

- Browser worker (`src/robot/robot.worker.ts`):
  `import { loadMicroPython } from "../../vendor/micropython/micropython.mjs";`
- Node worker (`tests/robot-node-worker.ts`):
  `import { loadMicroPython } from "../vendor/micropython/micropython.mjs";`
- wasm URL (`src/ui/session.ts`):
  `import mpWasm from "../../vendor/micropython/micropython.wasm?url";`
  and in `tests/match.ts`: `join(root, "vendor/micropython/micropython.wasm")`.
  It is passed as `url` exactly as before.
- `src/robot/runtime.ts`: no API change needed; set `heapsize` to the robot's
  value. Note that the simulator compiles `_spark_rt` and `zumo_2040_robot` from
  source into the heap (~48 KB after `gc.collect()`), while on the robot they are
  frozen in flash. To give programs the robot's free memory, pass
  `heapsize = <robot gc.mem_free() at program start> + ~48 KB`, or check
  `gc.mem_free()` before `exec` and adjust.
- `src/types/micropython.d.ts` is no longer needed for the vendored module
  (types come from `micropython.d.mts`); the npm package can stay installed for
  the speed comparison in `tests/mp-build-check.mjs`.
- Optional: replace the settrace line counter with the bytecode hook (pass
  `bytecodeHook`, call `takeBytecodeCount()` in `now()`/`rpc()` before using the
  clock, and drop `sys.settrace` in `_spark_rt.run`). That makes Python-heavy
  code ~5× faster to simulate; the cost per bytecode needs calibrating against
  the robot.

## Validation

`node tests/mp-build-check.mjs` (all pass):

| | Check | Result (this machine) |
| --- | --- | --- |
| a | 400k lists in one `runPython` | peak `gc.mem_alloc()` 189,824 B of 190,080 B, 67 collections |
| b | hard limit | `bytearray(300 KiB)` → MemoryError; growing live data fails at ~183 KB; memory recovered after `gc.collect()` |
| c | settrace in `exec`'d code | line events 1,2,3,2,3,2,3,2,3,4 (identical to the npm build) |
| d | `registerJsModule` round trip | numbers, strings, `Float64Array` on a `SharedArrayBuffer` (read and write from Python), FS + `pyimport` + call with `str` → `str`/`None` |
| e | framebuf | `text()` sets pixels in a MONO_VLSB buffer |
| f | `sys.modules['time']` override and required modules | ok |
| g | traced 300k-iteration loop vs npm settrace build | comparable: 0.7–1.25× the npm CPU time depending on machine load (e.g. 382 ms vs 530 ms, best of 5); the check fails above 1.5× |
| h | bytecode hook | exact, deterministic counts; `interrupt()` stops `while True: pass` |
| i | `gc.threshold(0)` torture | `re.sub` etc. correct |
| j | nested Python→JS→Python | correct, no skipped collections in practice |
| k | real `src/robot/python` runtime with a fake HAL | churn program runs 5 s of simulated time; a leaking program ends with `MemoryError` |

MicroPython's own test suite (`scripts/build-micropython.sh --upstream-tests`),
using a test build with the pyscript variant's frozen modules (for `unittest`):

- normal run (128 KiB fixed heap): 835 tests, 826 pass;
- GC torture run (collection on **every** allocation, 792 tests, ~810,000
  collections): 784 pass.

All remaining failures are listed with reasons in
`tools/expected-upstream-failures.txt` (test harness runs scripts as `<stdin>`,
pyscript-only features, a test that needs more than 128 KiB, deep-recursion
timeouts under torture). None is a GC error.

## Rebuilding

```sh
scripts/build-micropython.sh                    # ~1.5 min from scratch (emsdk needs ~1.8 GB on disk)
scripts/build-micropython.sh --upstream-tests   # plus MicroPython's test suite (~10 min)
node tests/mp-build-check.mjs
```

Toolchain and sources go to `$SPARK_MP_WORKDIR` (default
`~/.cache/spark-micropython-build`), never into the repository. Needs git, make,
python3, node ≥ 18 and a host C compiler (for `mpy-cross`).

To change MicroPython itself: edit the checkout in
`$SPARK_MP_WORKDIR/micropython`, rebuild, then save the changes with
`git -C $SPARK_MP_WORKDIR/micropython diff > vendor/micropython/patches/0001-spark-sync-gc-and-bytecode-hook.patch`
(the script resets the checkout and re-applies the patches on every run).
To move to a newer MicroPython: update `MP_TAG`/`MP_COMMIT` (and `EMSDK_VERSION`)
in the script, re-apply/fix the patch, and run both test commands.
