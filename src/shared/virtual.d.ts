// House bots, provided by the private competition overlay (overlay/bots/) or an empty module in the
// public build. See the overlay plugin in vite.config.ts.
declare module "virtual:spark-house-bots" {
  export const houseBots: Record<string, string>;
}

// Side-effect module that loads the private competition overlay (arenas, scoring, docs) if it is present.
// A no-op empty module in the public/practice build.
declare module "virtual:spark-overlay" {}
declare module "virtual:spark-overlay-world" {}
