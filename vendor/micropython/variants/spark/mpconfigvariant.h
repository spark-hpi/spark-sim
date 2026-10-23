// MicroPython webassembly port, "spark" variant for the SPARK robot simulator.
//
// Based on the upstream "standard" variant (fixed-size GC heap, no
// MICROPY_GC_SPLIT_HEAP_AUTO), so that:
// - garbage collection runs inside long-running synchronous code (see the
//   synchronous Asyncify GC in ports/webassembly/main.c, added by
//   patches/0001-spark-sync-gc-and-bytecode-hook.patch), and
// - the heapsize passed to loadMicroPython() is a hard limit (MemoryError like
//   on the RP2040).

// Same feature level as the standard variant and the rp2 port (RP2040):
// framebuf, random, bytes.hex, compile(), ... are all included.
#define MICROPY_CONFIG_ROM_LEVEL (MICROPY_CONFIG_ROM_LEVEL_EXTRA_FEATURES)

// Use the synchronous Asyncify-based gc_collect() from the patch instead of
// upstream's emscripten_scan_registers() (which completes asynchronously via
// setTimeout and therefore breaks synchronous runPython()/function calls).
#define MICROPY_GC_SYNC_ASYNCIFY (1)

// sys.settrace(), used by the simulator to count executed lines.
#define MICROPY_PY_SYS_SETTRACE (1)

// The standard variant polls stdin (in Node) every few VM hooks to detect
// Ctrl-C; a simulator worker must never block on stdin, so keep it off.
#define MICROPY_VARIANT_ENABLE_JS_HOOK (0)

// Bytecode counter: decrement a budget once per executed bytecode and notify
// JS when it runs out (see mp_js_vm_hook_expired() in main.c and
// setBytecodeHook()/takeBytecodeCount() in api.js).
#define MICROPY_VM_HOOK_BYTECODE_COUNTER (1)
extern uint32_t mp_js_vm_hook_budget;
void mp_js_vm_hook_expired(void);
#define MICROPY_VM_HOOK_BYTECODE \
    if (--mp_js_vm_hook_budget == 0) { \
        mp_js_vm_hook_expired(); \
    }
