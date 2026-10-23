// GC torture runner for MicroPython's own test suite (used by
// scripts/build-micropython.sh --upstream-tests).
//
// Same command line as `node micropython.mjs [-X heapsize=N] script.py`, but
// `gc.threshold(0)` makes every single heap allocation run a full garbage
// collection.  Any object that is still in use but not found by the GC root
// scan (C stack, spilled wasm locals, pystack, root pointers) gets freed and
// reused immediately, so such bugs show up as wrong output or crashes.
//
// The script is copied next to the micropython.mjs under test.

import * as fs from "fs";
import * as path from "path";
import * as url from "url";
import { loadMicroPython as realLoadMicroPython } from "./micropython.mjs";

export async function loadMicroPython(options) {
    const mp = await realLoadMicroPython(options);
    mp.runPython("import gc\ngc.threshold(0)\ndel gc");
    return mp;
}

const self = path.resolve(url.fileURLToPath(import.meta.url));
if (process.argv[1] && path.resolve(process.argv[1]) === self) {
    let heapsize = 128 * 1024;
    let contents = "";
    for (let i = 2; i < process.argv.length; i++) {
        if (process.argv[i] === "-X" && i + 1 < process.argv.length) {
            const value = process.argv[++i].split("heapsize=")[1] || "";
            const suffix = value.slice(-1).toLowerCase();
            heapsize = parseInt(value) * (suffix === "k" ? 1024 : suffix === "m" ? 1024 * 1024 : 1);
        } else {
            contents += fs.readFileSync(process.argv[i], "utf8");
        }
    }
    const mp = await loadMicroPython({
        heapsize,
        stdout: (data) => process.stdout.write(data),
        linebuffer: false,
    });
    // Same asyncio shim as the CLI in micropython.mjs (for the asyncio tests).
    if (contents.endsWith("asyncio.run(main())\n")) {
        const asyncio = mp.pyimport("asyncio");
        asyncio.run = async (task) => {
            await asyncio.create_task(task);
        };
    }
    try {
        mp.runPython(contents);
    } catch (error) {
        if (error.name !== "PythonError") {
            throw error;
        }
        if (error.type !== "SystemExit") {
            console.error(error.message);
        }
    }
}
