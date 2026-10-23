// Robot worker for Node (headless matches). Counterpart of src/robot/robot.worker.ts in the browser.
import { writeSync } from "node:fs";
import { parentPort, workerData } from "node:worker_threads";
import { loadMicroPython } from "../vendor/micropython/micropython.mjs";
import { runRobot, type RobotJob } from "../src/robot/runtime.ts";

// Write synchronously: if the worker dies (e.g. abort() in WebAssembly), asynchronous output would be lost
const job = workerData as RobotJob;
const say = (...a: unknown[]) => writeSync(2, `[R${job.slot + 1} worker] ${a.map(String).join(" ")}\n`);
console.error = say;
console.warn = say;
process.on("exit", (code) => say(`exit ${code}`));

try {
  await runRobot(job, loadMicroPython, (msg) => parentPort!.postMessage(msg));
} catch (e) {
  say("exception:", (e as Error)?.stack ?? e);
  throw e;
}
