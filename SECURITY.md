# Security

## Reporting a vulnerability

Please report security issues privately via GitHub's **Report a vulnerability** (Security → Advisories)
on this repository, rather than opening a public issue. We'll respond as soon as we can.

## Running untrusted robot programs

The simulator runs each robot's `main.py` as **real MicroPython**, inside a dedicated Web Worker that
talks to the physics only over a `SharedArrayBuffer` — it has no DOM and no access to the page. Robot
programs are also sandboxed within MicroPython: the browser bridge modules (`js`, `jsffi`, `pyscript`)
are disabled and the simulator's internal interface is removed before a program runs.

As defence in depth, the page sets `Content-Security-Policy: connect-src 'self'` (see `index.html`), so a
robot program cannot reach the network even if it escaped the MicroPython sandbox. If you **host the
simulator for others and let them run each other's programs**, keep that header (and the cross-origin
isolation headers `COOP`/`COEP`) in place, and serve the robot workers from an origin with no sensitive
cookies or credentials.

Known hardening follow-up: the MicroPython WebAssembly build can be compiled with the JavaScript FFI left
out entirely (`MICROPY_PY_JSFFI=0`) so the bridge modules do not exist at all, rather than being disabled
at runtime. Contributions welcome.
