// Bootstrap for the Node robot worker: registers tsx so the worker can load TypeScript (Node 20).
import { register } from "tsx/esm/api";

register();
await import("./robot-node-worker.ts");
