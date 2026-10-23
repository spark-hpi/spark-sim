# ★ SPARK Sim — self-host

Run a SPARK Sim build on your own machine. This is handy as an offline copy, or if you host the
simulator yourself. It serves the build with the cross-origin isolation headers the simulator needs.

## Run it

You need **Node.js 18+** ([nodejs.org](https://nodejs.org)).

```bash
node serve-practice.mjs
```

Then open **http://localhost:8099** in a browser.

Custom port / directory:
```bash
node serve-practice.mjs 9000 ./dist-practice
```

## Why a server (and not just opening index.html)?

The simulator runs real MicroPython in Web Workers and talks to the physics via
`SharedArrayBuffer`. Browsers only allow that under cross-origin isolation, which
needs two HTTP headers (`Cross-Origin-Opener-Policy` / `Cross-Origin-Embedder-Policy`).
This tiny server sends them; a `file://` page cannot, so double-clicking
`index.html` will not work.

## What's included

This is the **practice build**: your code, the physics, the practice arenas
(sumo, line, free) and the in-app docs. The competition's house bots and the
Challenge-1 arenas are intentionally not part of it.
