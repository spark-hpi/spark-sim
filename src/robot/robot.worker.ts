// Robot worker in the browser: one MicroPython per robot, isolated from all others.
import { loadMicroPython } from "../../vendor/micropython/micropython.mjs";
import { runRobot, type RobotJob } from "./runtime.ts";

const post = (m: unknown) => (self as unknown as Worker).postMessage(m);

self.onmessage = async (e: MessageEvent<RobotJob>) => {
  const job = e.data;
  try {
    await runRobot(job, loadMicroPython, post);
  } catch (err) {
    post({ type: "fatal", slot: job.slot, message: String((err as Error)?.message ?? err) });
  }
};
