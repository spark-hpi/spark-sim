# SPARK Sim

An open-source **Zumo 2040 simulator**: write the same `main.py` you copy onto the real robot and run
it in **real MicroPython** (a custom WebAssembly build with the RP2040's heap limit) against **MuJoCo 3D
physics** of the Zumo — tracks, blade, battery sag, realistic sensor timing — in the browser.

Made by the SPARK robotics community. MIT-licensed — self-host it, fork it, use it in your own event.

> **Accuracy — this is a simulation, not the real robot.** The physics (the MuJoCo model and the motor,
> battery and sensor constants) are tuned to *approximate* a real Zumo 2040, but a real robot behaves
> differently: surface, wear, build tolerances, battery state and sensor noise all vary, and some effects
> are modelled only roughly. Use the simulator to develop and sanity-check your code, then **always validate
> on real hardware**. Results here are approximate and come with no guarantee of accuracy — don't rely on
> them for anything safety- or outcome-critical.

## Quick start

```bash
npm install          # .npmrc sets legacy-peer-deps, ignore-scripts and exact versions
npm run dev          # http://localhost:5173
npm test             # world checks (physics, sensors, rules)
npm run typecheck
```

Headless match without a browser (deterministic per seed):

```bash
npx tsx tests/match.ts src/examples/sumo_starter.py --arena dohyo --press A@0.2 --seed 7
```

## Self-hosting

```bash
npm run build        # -> dist/
```

Serve `dist/` with a static server that sends the **cross-origin isolation** headers
`Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp` — the
simulator runs real MicroPython in Web Workers and needs `SharedArrayBuffer`, so a plain `file://` page
or a server without these headers will not work.

A tiny zero-dependency server that sets them is included:

```bash
node deploy/serve-practice.mjs        # serves ./dist-practice on http://localhost:8099
# or point it at your build:  node deploy/serve-practice.mjs 8099 ./dist
```

## What it can do

- **Same code as the robot.** Real MicroPython with the `zumo_2040_robot` API (Pololu's semantics); every
  bytecode costs RP2040 time and every sensor read its real duration, so loop rates match the robot.
- **Arenas with rules:** a mini-sumo dohyo, a line-following track and a free practice table.
- **Example programs** to start from (sumo, line follower, hello).
- **Test bench:** many headless matches in parallel → win rate with a confidence interval; watch any match again.
- **Debugging:** a timeline to scrub every frame, telemetry strip charts, a plotter for your `print`s, a 3D
  sensor view, errors marked in the editor, autocompletion and in-app docs for the robot API.
- **Download `main.py`** for the real robot; your code is saved in the browser.

## Layout

| Folder | Content |
|---|---|
| `src/shared/` | protocol world ↔ robots, Zumo numbers, the arena registry (`arenas.ts`) |
| `src/world/` | MuJoCo model, motor/battery model, sensors, lockstep, the rules dispatch (`rules.ts`) |
| `src/robot/` | MicroPython runtime and the simulated `zumo_2040_robot` hardware modules |
| `src/ui/` | 3D view and pixel filter, test bench, telemetry, editor helpers, docs, the brand hooks (`brand.ts`) |
| `src/bots/` | the bot registry; the example programs live in `src/examples/` |
| `vendor/micropython/` | the custom MicroPython WebAssembly build |
| `tests/` | world checks, headless match runner |

## How it fits together

```
Browser tab
├── UI (main.ts)        editor, 3D view, dock (console · telemetry · test bench · docs)
├── World worker        MuJoCo + motors/battery + sensors + rules, in time order
└── Robot worker × N    one MicroPython each, blocks on every request to the world
        └─ SharedArrayBuffer (lockstep) ─┘
```

## Extending it

Arenas, scoring, bots, docs and branding are **registries**. A deployment can add its own content without
touching the core — e.g. `registerArena(id, factory)` (`src/shared/arenas.ts`),
`registerRuleHandler(mode, fn)` (`src/world/rules.ts`) and `setBrand(...)` (`src/ui/brand.ts`). This is how
an event can keep its competition arenas, opponent bots and theme in a private layer while the core stays open.

## Licence

MIT — see [LICENSE](LICENSE). Third-party components and fonts are listed in [NOTICE](NOTICE). The code
in `src/robot/python/zumo_2040_robot/robot.py` is adapted from
[pololu/zumo-2040-robot](https://github.com/pololu/zumo-2040-robot) (MIT, © Pololu Corporation), and
`vendor/micropython` is built from MicroPython (MIT).
