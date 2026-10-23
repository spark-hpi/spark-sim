# MicroPython webassembly port, "spark" variant for the SPARK robot simulator.
# Built by spark-sim/scripts/build-micropython.sh; see ../../BUILD.md.

# Asyncify is needed to spill wasm locals for the conservative GC
# (synchronous unwind/rewind driven by $MPGC in library.js).
JSFLAGS += -s ASYNCIFY
# JS strings/arrays passed into MicroPython are malloc'ed outside the GC heap.
JSFLAGS += -s ALLOW_MEMORY_GROWTH
# Optimise at link time (wasm-opt also cleans up the Asyncify instrumentation).
# Upstream links without -O, which leaves Asyncify code unoptimised.
SPARK_LINK_OPT ?= -O2
JSFLAGS += $(SPARK_LINK_OPT)

EXPORTED_FUNCTIONS_EXTRA += ,\
	_mp_js_gc_scan_region,\
	_mp_js_vm_hook_set_interval,\
	_mp_js_vm_hook_take

EXPORTED_RUNTIME_METHODS_EXTRA += ,\
	HEAPU32

# Frozen modules: the port's default manifest (asyncio on the JS event loop).
FROZEN_MANIFEST ?= variants/manifest.py
