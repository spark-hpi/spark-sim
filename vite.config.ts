import { existsSync } from "node:fs";
import { defineConfig, type Plugin } from "vite";

// SharedArrayBuffer (lockstep between the world and the robots) needs cross-origin isolation.
const isolation = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
};

// The private competition overlay (house bots + Challenge-1 arenas/scoring/docs) lives in overlay/.
// It is included automatically when checked out, except when a practice/public build is requested.
// The public repo has no overlay/, so it always builds the fair version.
const hasOverlay = existsSync(new URL("./overlay/register.ts", import.meta.url));
const useOverlay = hasOverlay && process.env.SPARK_PRACTICE !== "1";

function overlayPlugin(): Plugin {
  const modules: Record<string, string> = {
    "virtual:spark-overlay": useOverlay ? 'import "/overlay/register.ts";' : "",
    "virtual:spark-overlay-world": useOverlay ? 'import "/overlay/register-world.ts";' : "",
    "virtual:spark-house-bots": useOverlay
      ? 'export const houseBots = import.meta.glob("/overlay/bots/*/*.py", { query: "?raw", import: "default", eager: true });'
      : "export const houseBots = {};",
  };
  return {
    name: "spark-overlay",
    resolveId(id) {
      if (id in modules) return "\0" + id;
    },
    load(id) {
      if (id.startsWith("\0virtual:spark-")) return modules[id.slice(1)];
    },
  };
}

export default defineConfig({
  plugins: [overlayPlugin()],
  server: { headers: isolation },
  preview: { headers: isolation },
  // the world runs in a Web Worker (its own build), so the overlay plugin must be registered there too
  worker: { format: "es", plugins: () => [overlayPlugin()] },
  optimizeDeps: { exclude: ["mujoco"] },
  build: { target: "es2022" },
});
