// Type declarations for micropython.mjs, the custom MicroPython WebAssembly build
// for the SPARK simulator (see BUILD.md). The upstream API of
// @micropython/micropython-webassembly-pyscript plus the SPARK additions.

export interface BytecodeHook {
  /** Call `callback` every `interval` executed bytecodes (1 ... 2^30-1). */
  interval: number;
  /**
   * Runs synchronously inside the VM with the number of bytecodes executed in the
   * elapsed period. Must not throw and must not call back into Python; call
   * `interrupt()` to stop the program.
   */
  callback: (bytecodes: number) => void;
}

export interface LoadMicroPythonOptions {
  /** URL (browser) or file path (Node) of micropython.wasm. Default: next to micropython.mjs. */
  url?: string;
  /** Size of the GC heap in bytes; a hard limit (MemoryError beyond it). Default 1 MiB. */
  heapsize?: number;
  /** Size of the Python stack in words (4 bytes each). Default 2048. */
  pystack?: number;
  /** true (default): stdout/stderr get whole lines as strings; false: single bytes. */
  linebuffer?: boolean;
  stdin?: () => number | null;
  stdout?: ((line: string) => void) | ((bytes: Uint8Array) => void);
  stderr?: ((line: string) => void) | ((bytes: Uint8Array) => void);
  /** SPARK: bytecode counter hook, see setBytecodeHook(). */
  bytecodeHook?: BytecodeHook;
  /** SPARK: bytes reserved for spilled wasm locals during a collection. Default 1 MiB. */
  gcspillsize?: number;
}

export interface GcStats {
  /** Collections run so far. */
  collections: number;
  /** Collections skipped because Python was re-entered from JS (nested call). */
  skipped: number;
  /** Largest amount of spilled wasm locals seen in a collection. */
  maxSpillBytes: number;
  spillBufferBytes: number;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type PyProxy = any;

export interface MicroPython {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  _module: any;
  PyProxy: PyProxy;
  /** Emscripten in-memory file system (MicroPython's "/" and "/lib"). */
  FS: {
    mkdir(path: string): void;
    writeFile(path: string, data: string | Uint8Array): void;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    readFile(path: string, opts?: { encoding?: "utf8" | "binary" }): any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    [name: string]: any;
  };
  globals: {
    __dict__: PyProxy;
    get(key: string): PyProxy;
    set(key: string, value: unknown): void;
    delete(key: string): void;
  };
  /** Make a JS object importable from Python as module `name`. */
  registerJsModule(name: string, module: object): void;
  /** Import a Python module and return it as a proxy (functions are callable from JS). */
  pyimport(name: string): PyProxy;
  /** Run Python source (file input); throws a PythonError (name "PythonError", .type) on exceptions. */
  runPython(code: string): PyProxy;
  runPythonAsync(code: string): Promise<PyProxy>;
  replInit(): void;
  replProcessChar(chr: number): number;
  replProcessCharWithAsyncify(chr: number): Promise<number>;
  /** SPARK: set (interval > 0, callback) or clear (callback null) the bytecode hook. */
  setBytecodeHook(interval: number, callback: ((bytecodes: number) => void) | null): void;
  /** SPARK: bytecodes executed since the last hook callback or call of this function. */
  takeBytecodeCount(): number;
  /** SPARK: raise KeyboardInterrupt in the running Python code at the next branch. */
  interrupt(): void;
  /** SPARK: garbage collector statistics. */
  gcStats(): GcStats;
}

export function loadMicroPython(options?: LoadMicroPythonOptions): Promise<MicroPython>;
