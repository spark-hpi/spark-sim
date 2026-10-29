// SPARK Sim — wiring of the user interface.
import "virtual:spark-overlay"; // private competition overlay, if present; a no-op in the public build
import { python } from "@codemirror/lang-python";
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { basicSetup } from "codemirror";
import mpWasm from "../vendor/micropython/micropython.wasm?url";
import { BOT_BY_ID, BOTS, CATEGORY_LABEL, defaultBotFor } from "./bots/index.ts";
import { ARENAS, arenaById, type Pose } from "./shared/arenas.ts";
import { NOMINAL, type FromRobot, type WorldEvent, type WorldSnapshot, type WorldTweaks } from "./shared/protocol.ts";
import "./style.css";
import { Buzzers } from "./ui/audio.ts";
import { BenchPanel } from "./ui/bench-panel.ts";
import { benchMatchSetup } from "./ui/bench.ts";
import { brand, VERSION } from "./ui/brand.ts";
import { helpContent } from "./ui/docs.ts";
import { DOC_PAGES } from "./ui/docs-content.ts";
import { DocsView } from "./ui/docs-view.ts";
import { apiHover, fontKeys, jumpToLine, robotCompletion, runKeys, TracebackCollector } from "./ui/editor-extras.ts";
import { editorTheme } from "./ui/editor-theme.ts";
import { renderInspector, renderLeds, renderOled, renderScoreboard } from "./ui/inspector.ts";
import type { PixelMode } from "./ui/pixel.ts";
import { parsePrint, Recorder } from "./ui/recorder.ts";
import { MatchHost, type RobotConfig } from "./ui/session.ts";
import { Layout, PRESETS, type DockPlace, type HideablePanel, type LayoutState } from "./ui/layout.ts";
import { applySettingsCss, DEFAULT_SETTINGS, EDITOR_MAX, EDITOR_MIN, loadSettings, renderSettings, type Settings } from "./ui/settings.ts";
import { runTour } from "./ui/tour.ts";
import { Telemetry } from "./ui/telemetry.ts";
import { Viewer, type Theme } from "./ui/viewer.ts";

// Team colours from the spark-hpi.de palette (link blue, then the callout colours). Colour = slot position.
const COLORS = ["#3a88fe", "#f59e0b", "#10b981", "#a78bfa"];
const CUSTOM = "custom";
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

// ---------------------------------------------------------------- persistence (per browser)
const store = {
  get<T>(key: string, fallback: T): T {
    try {
      const v = localStorage.getItem("spark-sim:" + key);
      return v ? (JSON.parse(v) as T) : fallback;
    } catch {
      return fallback;
    }
  },
  set(key: string, value: unknown) {
    try {
      localStorage.setItem("spark-sim:" + key, JSON.stringify(value));
    } catch {
      /* private window etc. */
    }
  },
};

// ---------------------------------------------------------------- settings (theme, sizes, editor font, sound)
let settings: Settings = loadSettings(store.get("settings", null));
{
  // the theme used to be stored on its own (the page reads it before the first paint)
  const t = document.documentElement.dataset.theme;
  if (t === "light" || t === "dark") settings.theme = t;
}
applySettingsCss(settings);

/** A robot slot: its name and its program — your own code or a house bot from the library */
interface Slot {
  name: string;
  source: string; // "custom" or a bot id like "<category>/<bot>.py"
  code: string; // your own code (kept even while a house bot is selected)
}

const starter = BOT_BY_ID["examples/sumo_starter.py"]?.code ?? "";
const firstOpponent = BOTS.find((b) => b.category === "sumo"); // pre-fill robot 2 with an opponent, if any bots are registered
let arenaId = arenaById(String(store.get("arena", "dohyo"))).id;
/** stored values can be from older versions or edited by hand: keep only what makes sense */
function loadSlots(raw: unknown): Slot[] {
  const list = (Array.isArray(raw) ? raw : [])
    .filter((s): s is Partial<Slot> => !!s && typeof s === "object")
    .map((s, i) => {
      const code = typeof s.code === "string" ? s.code : "";
      const source = typeof s.source === "string" && (s.source === CUSTOM || BOT_BY_ID[s.source]) ? s.source : CUSTOM;
      const name = typeof s.name === "string" && s.name.trim() ? s.name.slice(0, 24) : `Robot ${i + 1}`;
      return { name, source, code };
    })
    .slice(0, arenaById(arenaId).maxRobots);
  return list.length ? list : [{ name: "My Zumo", source: CUSTOM, code: starter }];
}
let slots: Slot[] = loadSlots(
  store.get<unknown>("slots-v2", [
    { name: "My Zumo", source: CUSTOM, code: starter },
    { name: firstOpponent?.name ?? "Robot 2", source: firstOpponent?.id ?? CUSTOM, code: "" },
  ]),
);
let selected = 0;
let speed = 1;
/** give the start signal right after Run (off: the user gives it with ⚑ Start, like a referee) */
let autoStart = store.get<unknown>("autostart", false) === true;
function loadTweaks(raw: unknown): WorldTweaks {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const num = (v: unknown, fb: number, lo: number, hi: number) => (typeof v === "number" && isFinite(v) ? Math.max(lo, Math.min(hi, v)) : fb);
  return { ...NOMINAL, battery: num(r.battery, NOMINAL.battery, 0, 1), grip: num(r.grip, NOMINAL.grip, 0.5, 1.5), noise: num(r.noise, NOMINAL.noise, 0, 3) };
}
let tweaks: WorldTweaks = loadTweaks(store.get<unknown>("tweaks", {}));
const saveSlots = () => store.set("slots-v2", slots);
const codeOf = (s: Slot) => (s.source === CUSTOM ? s.code : (BOT_BY_ID[s.source]?.code ?? ""));

/** What is on stage: normally the slots, or the robots of a bench match being watched */
let scene: { names: string[]; colors: string[]; fromSlots: boolean; arena: string } = { names: [], colors: [], fromSlots: true, arena: "dohyo" };

// ---------------------------------------------------------------- building blocks
// the top bar wraps into a second row on smaller windows: the workspace gets the rest of the height
const topbar = document.querySelector<HTMLElement>(".topbar")!;
new ResizeObserver(() => document.documentElement.style.setProperty("--bar-h", `${topbar.offsetHeight}px`)).observe(topbar);
const viewer = new Viewer($("viewer"));
const recorder = new Recorder();
const telemetry = new Telemetry($("telemetry"));
const buzzers = new Buzzers();
const consoleEl = $("console");
const banner = $("banner");
let bannerTimer = 0;
let runId = 0;
let running = false;
let liveDone = new Set<number>();
/** per robot on stage: is its program running, finished, or did it stop with an error? (shown on the tabs) */
type RunState = "idle" | "run" | "done" | "err";
let runState: RunState[] = [];
function setRunState(slot: number, st: RunState) {
  runState[slot] = st;
  renderTabs();
}
let live = true;
let cursor = 0;
let lastLive: WorldSnapshot | null = null;

// ---------------------------------------------------------------- console
const conNew = $("con-new");
let conQuery = "";
/** the console follows new lines unless the user scrolled up (remembered while it is hidden) */
let conStick = true;
const atConsoleBottom = () => consoleEl.scrollTop + consoleEl.clientHeight >= consoleEl.scrollHeight - 6;
function log(text: string, cls = "", t?: number, slot?: number) {
  const atBottom = consoleEl.offsetParent !== null ? atConsoleBottom() : conStick;
  const line = document.createElement("div");
  line.className = "ln";
  if (cls === "err" || cls === "warn") line.classList.add("is-err");
  if (slot !== undefined) line.dataset.slot = String(slot);
  if (t !== undefined) {
    const ts = document.createElement("span");
    ts.className = "t";
    ts.textContent = `${t.toFixed(3).padStart(8)}  `;
    line.append(ts);
  }
  if (slot !== undefined) {
    const who = document.createElement("span");
    who.style.color = scene.colors[slot] ?? "";
    who.textContent = `${scene.names[slot] ?? "R" + (slot + 1)}: `;
    line.append(who);
  }
  const body = document.createElement("span");
  body.className = cls;
  body.textContent = text;
  line.append(body);
  // a traceback line of a robot program: click jumps to the line in the editor
  const m = slot !== undefined ? text.match(/File "main\.py", line (\d+)/) : null;
  if (m) {
    line.classList.add("jump");
    line.title = "Show this line in the editor";
    const lineNo = Number(m[1]);
    line.onclick = () => jumpToCode(slot!, lineNo);
  }
  if (conQuery && !line.textContent!.toLowerCase().includes(conQuery)) line.classList.add("nomatch");
  consoleEl.append(line);
  while (consoleEl.childElementCount > 3000) consoleEl.firstElementChild?.remove();
  if (atBottom) consoleEl.scrollTop = consoleEl.scrollHeight;
  else conNew.classList.remove("hidden");
}
consoleEl.addEventListener("scroll", () => {
  if (consoleEl.offsetParent === null) return;
  conStick = atConsoleBottom();
  if (conStick) conNew.classList.add("hidden");
});
// shown again (dock tab, layout): back at the newest line if it was following
new ResizeObserver(() => {
  if (consoleEl.offsetParent !== null && conStick) consoleEl.scrollTop = consoleEl.scrollHeight;
}).observe(consoleEl);
conNew.onclick = () => {
  consoleEl.scrollTop = consoleEl.scrollHeight;
  conStick = true;
  conNew.classList.add("hidden");
};
$<HTMLInputElement>("con-search").addEventListener("input", (e) => {
  conQuery = (e.target as HTMLInputElement).value.trim().toLowerCase();
  for (const ln of consoleEl.children) ln.classList.toggle("nomatch", !!conQuery && !ln.textContent!.toLowerCase().includes(conQuery));
});
$<HTMLSelectElement>("con-filter").onchange = (e) => (consoleEl.dataset.filter = (e.target as HTMLSelectElement).value);
$("con-copy").onclick = async () => {
  const lines = [...consoleEl.children].filter((ln) => (ln as HTMLElement).offsetParent !== null).map((ln) => ln.textContent);
  try {
    await navigator.clipboard.writeText(lines.join("\n"));
    showBanner(`${lines.length} console lines copied`, 1800);
  } catch {
    showBanner("Copying was blocked by the browser", 2200);
  }
};
/** robot filter of the console: one option per robot on stage */
function renderConsoleFilter() {
  const sel = $<HTMLSelectElement>("con-filter");
  const keep = sel.value;
  sel.replaceChildren(new Option("All lines", "all"), new Option("Errors & warnings", "err"));
  scene.names.forEach((n, i) => sel.add(new Option(`${i + 1}: ${n}`, String(i))));
  sel.value = [...sel.options].some((o) => o.value === keep) ? keep : "all";
  consoleEl.dataset.filter = sel.value;
}

function showBanner(text: string, ms = 3500) {
  banner.textContent = text;
  banner.classList.remove("hidden");
  clearTimeout(bannerTimer);
  bannerTimer = window.setTimeout(() => banner.classList.add("hidden"), ms);
}

// ---------------------------------------------------------------- the interactive match
const tracebacks = [0, 1, 2, 3].map(
  (slot) => new TracebackCollector(() => (scene.fromSlots && slot === editorSlot && slots[slot]?.source === CUSTOM ? view : null)),
);

const host = new MatchHost({
  snapshot(s) {
    if (recording) recorder.addFrame(s);
    lastLive = s;
    if (live) showFrame(s);
    updateTimeline();
  },
  event(e: WorldEvent) {
    const cls = e.kind === "warn" || e.kind === "hang" ? "warn" : "sys";
    if (e.kind === "hang" && e.slot !== undefined) {
      liveDone.add(e.slot);
      setRunState(e.slot, "err");
    }
    log(e.text, cls, e.t);
    if (e.kind === "out" || e.kind === "end" || e.kind === "lap" || e.kind === "point") buzzers.cue(e.kind);
    if (e.kind === "info" && e.text.startsWith("Start signal")) {
      buzzers.cue("signal");
      showBanner("Start signal — the robots may move in 5 s", 2500);
    }
    if (e.kind === "info" && e.text === "Go!") {
      buzzers.cue("go");
      showBanner("GO!", 1200);
    }
    if (e.kind === "out") showBanner(`${scene.names[e.slot ?? 0] ?? "Robot"} is out!`);
    if (e.kind === "end") {
      showBanner(e.text.replace(/^Match over: /, ""), 5000);
      // like a referee: stop the programs shortly after the decision
      const id = runId;
      setTimeout(() => {
        if (id === runId && running) stop("match decided");
      }, 1500);
    }
  },
  robot(m: FromRobot) {
    switch (m.type) {
      case "stdout":
        for (const line of m.text.replace(/\n$/, "").split("\n")) {
          tracebacks[m.slot]?.feed(line);
          const values = parsePrint(line);
          if (values) recorder.addPrint(m.slot, m.t, values);
          const isErr = /^(Traceback|  File|\w+(Error|Exception))/.test(line);
          log(line, isErr ? "err" : "", m.t, m.slot);
        }
        break;
      case "display":
        recorder.addDisplay(m.slot, m.t, m.hex, m.inverted);
        if (live) {
          viewer.setDisplay(m.slot, m.hex, m.inverted);
          if (m.slot === selected) renderOled(m);
        }
        break;
      case "leds":
        recorder.addLeds(m.slot, m.t, m.rgb);
        if (live) {
          viewer.setLeds(m.slot, m.rgb);
          if (m.slot === selected) renderLeds(m.rgb);
        }
        break;
      case "yellow":
        recorder.addYellow(m.slot, m.t, m.on);
        if (live) viewer.setYellow(m.slot, m.on);
        break;
      case "buzzer":
        if (live) buzzers.play(m.slot, m.notes, speed);
        break;
      case "done":
      case "fatal":
        if (m.type === "done") log(m.error ? `program stopped: ${m.error}` : "program finished", m.error ? "err" : "sys", m.t, m.slot);
        else log(`runtime failure: ${m.message}`, "err", undefined, m.slot);
        setRunState(m.slot, m.type === "fatal" || m.error ? "err" : "done");
        liveDone.add(m.slot);
        if (liveDone.size >= scene.names.length) setRunning(false);
        break;
    }
  },
  error(message) {
    log(message, "err");
  },
});

function setRunning(on: boolean) {
  running = on;
  if (!on) runState = runState.map((st) => (st === "run" ? "idle" : st));
  renderTabs();
  const b = $("run");
  b.textContent = on ? "↻ Restart" : "▶ Run";
  b.classList.toggle("running", on);
}

/** Put a scene on stage. run = start the programs. */
/** robots moved by hand (Shift+drag) keep their place for the next Run; Reset and an arena change forget it */
let placed: (Pose | null)[] = [];
/** frames are recorded only while programs run (the preview is not a match) */
let recording = false;

function load(
  run: boolean,
  opts: { seed?: number; poses?: Pose[]; robots?: RobotConfig[]; label?: string; startAt?: number | null; arena?: string; tweaks?: WorldTweaks } = {},
) {
  runId++;
  buzzers.stopAll();
  recorder.clear();
  for (const tb of tracebacks) tb.clear();
  live = true;
  playing = false;
  $("tl-play").textContent = "▶";
  recording = run;
  liveDone = new Set();
  const robots = opts.robots ?? slots.map((s) => ({ name: s.name, code: codeOf(s) }));
  scene = { names: robots.map((r) => r.name), colors: robots.map((_, i) => COLORS[i % COLORS.length]), fromSlots: !opts.robots, arena: opts.arena ?? arenaId };
  renderConsoleFilter();
  runState = robots.map((r) => (run && r.code.trim() ? "run" : "idle"));
  // an empty program never reports "done": count it as done right away
  if (run) robots.forEach((r, i) => !r.code.trim() && liveDone.add(i));
  const arena = arenaById(scene.arena);
  viewer.setArena(arena);
  viewer.setRobots(robots.map((r, i) => ({ name: r.name, color: scene.colors[i] })));
  if (scene.fromSlots) selected = editorSlot;
  selected = Math.max(0, Math.min(selected, robots.length - 1));
  viewer.select(selected);
  for (let i = 0; i < robots.length; i++) {
    viewer.setDisplay(i, "", false);
    viewer.setLeds(i, new Array(18).fill(0));
    viewer.setYellow(i, false);
  }
  renderOled(null);
  renderLeds(null);
  const seed = opts.seed ?? (Math.random() * 1e9) >>> 0;
  const startAt = opts.startAt !== undefined ? opts.startAt : autoStart ? 0.2 : null;
  let poses = opts.poses;
  const byHand = !poses && scene.fromSlots && placed.some(Boolean);
  if (byHand) poses = robots.map((_, i) => placed[i] ?? arena.starts[i % arena.starts.length]);
  void host.load({ arena: scene.arena, robots, seed, poses, autoPressA: startAt, run, tweaks: opts.tweaks ?? tweaks });
  host.setSpeed(speed);
  setRunning(run && liveDone.size < robots.length);
  updateInspectorHead();
  if (run) log(`▶ ${opts.label ?? "run"} · ${robots.map((r) => r.name).join(" vs ")} · ${arena.name} · seed ${seed}${byHand ? " · start positions moved by hand (↺ Reset puts them back)" : ""}`, "sys");
}

/** ↺ Reset: the robots back to the arena's start positions (forgets positions set by hand) */
function reset() {
  placed = [];
  load(false);
}

/** a slot's program changed (another bot, your own code): a running match ends, the stage shows the new robot */
function programChanged() {
  if (running) stop("program changed — ▶ Run starts the new match");
  load(false);
}

function stop(reason = "stopped") {
  // always halt the world: robots keep their last motor command after their program ended (like the real Zumo)
  host.stop();
  buzzers.stopAll();
  if (!running) return;
  setRunning(false);
  log(`■ ${reason}`, "sys", lastLive?.t);
}

/** The start signal (referee): button A on every robot, 5 s countdown. Starts a match first if none runs. */
function startSignal() {
  const mode = arenaById(running ? scene.arena : arenaId).mode;
  if (mode === "race" || mode === "free") {
    if (!running) load(true);
    return;
  }
  if (!running) {
    load(true, { startAt: 0.2 });
    return;
  }
  if (lastLive?.match.signal !== null && lastLive?.match.signal !== undefined) return;
  host.start();
}

function drawTelemetry(cursorT: number | null, force: boolean) {
  telemetry.draw(recorder.frames, selected, cursorT, force, (t0, t1) => recorder.printsBetween(selected, t0, t1));
}

// ---------------------------------------------------------------- frames: live and recorded
let frameCounter = 0;
function showFrame(s: WorldSnapshot, replay = false) {
  viewer.update(s);
  // before Run the world is only a preview: no match clock
  $("simtime").textContent = !recording && !replay ? "ready" : `${s.t.toFixed(2)} s`;
  $("rtf").textContent = replay ? "replay" : !recording ? "press ▶ Run" : s.realtime > 0 ? `${s.realtime.toFixed(1)}× real time` : "paused";
  renderScoreboard(s.match, scene.names, scene.colors);
  updateStartButton(s);
  if (replay || ++frameCounter % 2 === 0) renderInspector(s.robots[selected]);
  if (dockTab === "telemetry") drawTelemetry(live ? null : s.t, replay);
}

/** ⚑ Start pulses while a running match waits for its start signal; it is not needed in a race */
function updateStartButton(s: WorldSnapshot | null) {
  const b = $<HTMLButtonElement>("start");
  const mode = arenaById(running ? scene.arena : arenaId).mode;
  const none = mode === "race" || mode === "free";
  if (b.disabled !== none)
    b.title = none
      ? mode === "race"
        ? "No start signal in the race: ▶ Run starts the robots, each robot's laps are timed from its first crossing of the start line"
        : "No start signal in free practice: ▶ Run starts the robots"
      : "Start signal (S): button A on every robot like the referee's start; they may move 5 s later. Without a running match it starts one.";
  b.disabled = none;
  b.classList.toggle("attention", !b.disabled && running && !!s && s.match.phase === "waiting");
}

function showAt(t: number) {
  const f = recorder.frameAt(t);
  if (!f) return;
  showFrame(f, true);
  scene.names.forEach((_, slot) => {
    const d = recorder.displayAt(slot, t);
    viewer.setDisplay(slot, d?.hex ?? "", d?.inverted ?? false);
    viewer.setLeds(slot, recorder.ledsAt(slot, t) ?? new Array(18).fill(0));
    viewer.setYellow(slot, recorder.yellowAt(slot, t));
  });
  renderOled(recorder.displayAt(selected, t));
  renderLeds(recorder.ledsAt(selected, t));
}

// ---------------------------------------------------------------- timeline
const slider = $<HTMLInputElement>("tl-slider");
let playing = false;
function updateTimeline() {
  slider.min = String(recorder.start);
  slider.max = String(recorder.end);
  if (live) slider.value = String(recorder.end);
  $("tl-label").textContent = live ? `${recorder.end.toFixed(2)} s recorded` : `${cursor.toFixed(2)} s / ${recorder.end.toFixed(2)} s`;
  $("tl-live").setAttribute("aria-pressed", String(live));
}
function goLive() {
  live = true;
  playing = false;
  $("tl-play").textContent = "▶";
  if (lastLive) {
    showFrame(lastLive);
    scene.names.forEach((_, slot) => {
      const d = recorder.displayAt(slot, lastLive!.t);
      viewer.setDisplay(slot, d?.hex ?? "", d?.inverted ?? false);
      viewer.setLeds(slot, recorder.ledsAt(slot, lastLive!.t) ?? new Array(18).fill(0));
      viewer.setYellow(slot, recorder.yellowAt(slot, lastLive!.t));
    });
    renderOled(recorder.displayAt(selected, lastLive.t));
    renderLeds(recorder.ledsAt(selected, lastLive.t));
  }
  updateTimeline();
}
function scrubTo(t: number) {
  if (live) buzzers.stopAll(); // the replay has no sound
  live = false;
  cursor = Math.max(recorder.start, Math.min(recorder.end, t));
  slider.value = String(cursor);
  showAt(cursor);
  updateTimeline();
}
slider.addEventListener("input", () => scrubTo(Number(slider.value)));
$("tl-live").onclick = goLive;
$("tl-play").onclick = () => {
  if (playing) {
    playing = false;
    $("tl-play").textContent = "▶";
    return;
  }
  if (live) scrubTo(recorder.start);
  if (cursor >= recorder.end - 0.01) scrubTo(recorder.start);
  playing = true;
  $("tl-play").textContent = "❚❚";
  let last = performance.now();
  const step = () => {
    if (!playing || live) return;
    const now = performance.now();
    scrubTo(cursor + ((now - last) / 1000) * (speed > 0 && isFinite(speed) ? speed : 1));
    last = now;
    if (cursor >= recorder.end) {
      playing = false;
      $("tl-play").textContent = "▶";
      return;
    }
    requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
};

// ---------------------------------------------------------------- editor
const themeSlot = new Compartment();
const roSlot = new Compartment();
const wrapSlot = new Compartment();
const wrapExt = (): Extension => (settings.wrap ? EditorView.lineWrapping : []);
let saveTimer = 0;
function markSaved() {
  const el = $("save-state");
  el.textContent = "saving …";
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(flushSave, 400);
}
function flushSave() {
  if (!saveTimer) return;
  clearTimeout(saveTimer);
  saveTimer = 0;
  saveSlots();
  $("save-state").textContent = "✓ saved";
}
// the last keystrokes before closing or reloading the tab
window.addEventListener("pagehide", flushSave);
document.addEventListener("visibilitychange", () => document.visibilityState === "hidden" && flushSave());
const states: (EditorState | undefined)[] = [];
let editorSlot = 0;

function makeState(slot: number): EditorState {
  const s = slots[slot];
  const readOnly = s.source !== CUSTOM;
  return EditorState.create({
    doc: codeOf(s),
    extensions: [
      basicSetup,
      python(),
      EditorState.tabSize.of(4),
      themeSlot.of(editorTheme(currentTheme())),
      roSlot.of([EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)]),
      wrapSlot.of(wrapExt()),
      robotCompletion(),
      apiHover((cls, member) => openDocsApi(cls, member)),
      fontKeys((d) => stepEditorFont(d)),
      runKeys(() => load(true), () => stop()),
      EditorView.updateListener.of((u) => {
        if (!u.docChanged) return;
        const sl = slots[editorSlot];
        if (sl && sl.source === CUSTOM) {
          sl.code = u.state.doc.toString();
          markSaved();
        }
      }),
    ],
  });
}

let view: EditorView;

function showSlot(slot: number) {
  if (view && states[editorSlot]) states[editorSlot] = view.state;
  selected = slot;
  editorSlot = slot;
  states[slot] ??= makeState(slot);
  view.setState(states[slot]!);
  $("editor").classList.toggle("readonly", slots[slot].source !== CUSTOM);
  $("save-state").textContent = slots[slot].source === CUSTOM ? "✓ saved" : "read-only";
  viewer.select(slot);
  renderTabs();
  $<HTMLInputElement>("robot-name").value = slots[slot].name;
  renderSourceSelect();
  renderSourceInfo();
  updateInspectorHead();
  const t = live ? (lastLive?.t ?? 0) : cursor;
  renderOled(recorder.displayAt(slot, t));
  renderLeds(recorder.ledsAt(slot, t));
  const f = live ? lastLive : recorder.frameAt(cursor);
  if (f) renderInspector(f.robots[slot]);
  if (dockTab === "telemetry") drawTelemetry(live ? null : cursor, true);
}

/** console → editor: show the robot's program and select the line */
function jumpToCode(slot: number, lineNo: number) {
  if (!scene.fromSlots || slot >= slots.length) return;
  if (!layout.visible("code")) layout.toggle("code", true);
  if (editorSlot !== slot) showSlot(slot);
  jumpToLine(view, lineNo);
}

function selectRobot(slot: number) {
  if (slot < 0 || slot >= scene.names.length) return;
  if (scene.fromSlots && slot < slots.length) showSlot(slot);
  else {
    // a watched bench match: the inspector follows, the editor keeps your robot
    selected = slot;
    viewer.select(slot);
    updateInspectorHead();
    const t = live ? (lastLive?.t ?? 0) : cursor;
    const f = live ? lastLive : recorder.frameAt(cursor);
    if (f) renderInspector(f.robots[slot]);
    renderOled(recorder.displayAt(slot, t));
    renderLeds(recorder.ledsAt(slot, t));
  }
}

function updateInspectorHead() {
  $("insp-name").textContent = scene.names[selected] ?? slots[selected]?.name ?? "Robot";
  $("insp-dot").style.background = scene.colors[selected] ?? COLORS[selected % COLORS.length];
}

function renderTabs() {
  const tabs = $("tabs");
  tabs.replaceChildren();
  slots.forEach((s, i) => {
    const b = document.createElement("button");
    b.className = "tab" + (i === editorSlot ? " on" : "");
    const dot = document.createElement("span");
    dot.className = "chip";
    dot.style.background = COLORS[i % COLORS.length];
    b.append(dot, document.createTextNode(s.name));
    const st = scene.fromSlots ? runState[i] : undefined;
    const STATUS: Record<RunState, string> = { idle: "", run: "running", done: "program finished", err: "stopped with an error — see the console" };
    if (st && st !== "idle") {
      const mark = document.createElement("span");
      mark.className = `run-mark ${st}`;
      mark.setAttribute("aria-label", STATUS[st]);
      b.append(mark);
    }
    b.title = (s.source === CUSTOM ? "Your code" : `House bot: ${BOT_BY_ID[s.source]?.name}`) + (st && st !== "idle" ? ` · ${STATUS[st]}` : "");
    b.onclick = () => selectRobot(i);
    tabs.append(b);
  });
  if (slots.length < arenaById(arenaId).maxRobots) {
    const add = document.createElement("button");
    add.className = "tab";
    add.textContent = "+ Robot";
    add.title = "Add a robot";
    add.onclick = addRobot;
    tabs.append(add);
  }
}

function renderSourceSelect() {
  const sel = $<HTMLSelectElement>("source");
  sel.replaceChildren();
  sel.add(new Option("✎ My code", CUSTOM));
  const mode = arenaById(arenaId).mode;
  const cats = [...new Set(BOTS.map((b) => b.category))].sort((a, b) => (a === "examples" ? -1 : b === "examples" ? 1 : 0));
  for (const c of cats) {
    const g = document.createElement("optgroup");
    const fits = c === "examples" || c === mode || (mode === "race" && c === "line") || (mode === "free" && c !== "examples");
    g.label = (CATEGORY_LABEL[c] ?? c) + (fits ? "" : " (other arena)");
    for (const b of BOTS.filter((x) => x.category === c)) {
      const stars = b.difficulty ? " " + "★".repeat(b.difficulty) : "";
      g.append(new Option(`${b.name}${stars}`, b.id));
    }
    sel.append(g);
  }
  sel.value = slots[editorSlot].source;
}

function renderSourceInfo() {
  const box = $("source-info");
  const s = slots[editorSlot];
  box.replaceChildren();
  const inner = document.createElement("div");
  inner.className = "inner";
  const meta = document.createElement("div");
  meta.className = "meta";
  if (s.source === CUSTOM) {
    const p = document.createElement("span");
    p.textContent = "Your program — edit freely. ⇩ Download saves it for the real robot.";
    inner.append(p);
  } else {
    const b = BOT_BY_ID[s.source];
    if (!b) return;
    const t = document.createElement("b");
    t.textContent = b.category === "examples" ? "Example. " : "House bot. ";
    const text = document.createElement("div");
    text.className = "text";
    text.append(t, document.createTextNode(b.strategy || ""));
    if (b.strengths) {
      const st = document.createElement("div");
      st.textContent = b.strengths;
      st.style.marginTop = "4px";
      text.append(st);
    }
    inner.append(text);
    if (b.difficulty) meta.append(Object.assign(document.createElement("span"), { textContent: `difficulty ${"★".repeat(b.difficulty)}${"☆".repeat(Math.max(0, 5 - b.difficulty))}` }));
    if (b.arena) meta.append(Object.assign(document.createElement("span"), { textContent: `arena ${b.arena}` }));
    const more = document.createElement("button");
    more.className = "link-btn";
    more.textContent = box.classList.contains("open") ? "less" : "more";
    more.title = "Show the whole description";
    more.onclick = () => {
      box.classList.toggle("open");
      more.textContent = box.classList.contains("open") ? "less" : "more";
    };
    meta.append(more);
    const copy = document.createElement("button");
    copy.className = "link-btn push";
    copy.textContent = "Edit a copy →";
    copy.title = "Copy this program into your own code (replaces your current code in this slot)";
    copy.onclick = () => {
      if (s.code.trim() && s.code !== b.code && !confirm(`Replace your code in "${s.name}" with a copy of ${b.name}?`)) return;
      s.code = b.code;
      s.source = CUSTOM;
      states[editorSlot] = undefined;
      saveSlots();
      showSlot(editorSlot);
    };
    meta.append(copy);
    inner.append(meta);
  }
  box.append(inner);
}

$<HTMLSelectElement>("source").onchange = (e) => {
  const v = (e.target as HTMLSelectElement).value;
  const s = slots[editorSlot];
  const wasDefaultName = s.source !== CUSTOM ? s.name === BOT_BY_ID[s.source]?.name : /^Robot \d$/.test(s.name);
  s.source = v;
  if (v !== CUSTOM && wasDefaultName) s.name = BOT_BY_ID[v]?.name ?? s.name;
  states[editorSlot] = undefined;
  saveSlots();
  showSlot(editorSlot);
  bench.refreshOptions();
  programChanged();
};

$<HTMLInputElement>("robot-name").oninput = (ev) => {
  const s = slots[editorSlot];
  s.name = (ev.target as HTMLInputElement).value || `Robot ${editorSlot + 1}`;
  saveSlots();
  renderTabs();
  if (scene.fromSlots) {
    scene.names[editorSlot] = s.name;
    viewer.setName(editorSlot, s.name);
    renderConsoleFilter();
  }
  updateInspectorHead();
  bench.refreshOptions();
};

function addRobot() {
  const arena = arenaById(arenaId);
  if (slots.length >= arena.maxRobots) return;
  const pick = defaultBotFor(arena.mode) ?? (arena.mode === "race" ? "examples/line_follower.py" : "examples/hello.py");
  const bot = BOT_BY_ID[pick];
  slots.push({ name: bot?.name ?? `Robot ${slots.length + 1}`, source: bot ? pick : CUSTOM, code: "" });
  saveSlots();
  if (running) stop("robot added — ▶ Run starts the new match");
  load(false);
  showSlot(slots.length - 1);
  bench.refreshOptions();
}

$("remove-robot").onclick = () => {
  if (slots.length <= 1) {
    showBanner("The last robot cannot be removed", 2000);
    return;
  }
  const s = slots[editorSlot];
  // your own code would be gone for good
  if (s.code.trim() && s.code !== starter && !confirm(`Remove "${s.name}" and its code?\n\n⇩ Download saves a copy first.`)) return;
  flushSave();
  slots.splice(editorSlot, 1);
  states.splice(editorSlot, 1);
  placed.splice(editorSlot, 1);
  saveSlots();
  editorSlot = Math.min(editorSlot, slots.length - 1);
  if (running) stop("robot removed");
  load(false);
  states[editorSlot] = undefined;
  showSlot(editorSlot);
  bench.refreshOptions();
};

// the file name is picked in the menu: one file per challenge, as in the team repos
$<HTMLSelectElement>("download").onchange = (e) => {
  const pick = e.target as HTMLSelectElement;
  const name = pick.value;
  pick.value = "";
  if (!name) return;
  const s = slots[editorSlot];
  const blob = new Blob([codeOf(s)], { type: "text/x-python" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
};
$("upload").onclick = () => $<HTMLInputElement>("upload-file").click();

// share a program as a link: deflate + base64url in the URL hash, no server involved
async function packCode(code: string): Promise<string> {
  const stream = new Blob([code]).stream().pipeThrough(new CompressionStream("deflate-raw"));
  const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
async function unpackCode(packed: string): Promise<string> {
  const bin = atob(packed.replace(/-/g, "+").replace(/_/g, "/"));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return await new Response(stream).text();
}
$("share").onclick = async () => {
  const s = slots[editorSlot];
  const url = `${location.origin}${location.pathname}#program=${await packCode(codeOf(s))}&name=${encodeURIComponent(s.name)}`;
  try {
    await navigator.clipboard.writeText(url);
    showBanner("Link copied — it contains the whole program", 2500);
  } catch {
    prompt("Copy this link:", url);
  }
};
/** opened with a share link: no guided tour on top of it */
const openedWithLink = /#program=/.test(location.hash);
async function openSharedProgram() {
  const m = location.hash.match(/#program=([\w-]+)(?:&name=([^&]*))?/);
  if (!m) return;
  history.replaceState(null, "", location.pathname + location.search);
  try {
    const code = await unpackCode(m[1]);
    const name = decodeURIComponent(m[2] ?? "Shared program").slice(0, 24) || "Shared program";
    const target = slots.findIndex((s) => s.source === CUSTOM);
    const slot = target >= 0 ? target : 0;
    const cur = slots[slot].code;
    // only ask when real work would be replaced (not the untouched starter)
    if (cur.trim() && cur !== code && cur !== starter && !confirm(`Open the shared program "${name}" in robot ${slot + 1}? Its current code is replaced.`)) return;
    flushSave();
    slots[slot] = { name, source: CUSTOM, code };
    states[slot] = undefined;
    saveSlots();
    if (running) stop("shared program opened");
    load(false);
    showSlot(slot);
    log(`opened shared program "${name}" in robot ${slot + 1}`, "sys");
  } catch {
    log("could not read the shared program link", "err");
  }
}
// a link pasted into an open tab
window.addEventListener("hashchange", () => void openSharedProgram());
// ⇧ Open: the file replaces the editor content as one edit, so Ctrl/⌘+Z brings the previous code back
$<HTMLInputElement>("upload-file").onchange = async (e) => {
  const input = e.target as HTMLInputElement;
  const f = input.files?.[0];
  input.value = "";
  if (!f) return;
  if (f.size > 256 * 1024) {
    showBanner(`${f.name} is too big for a robot program (${Math.round(f.size / 1024)} KB)`, 3500);
    return;
  }
  const code = await f.text();
  const s = slots[editorSlot];
  if (s.source !== CUSTOM) {
    s.source = CUSTOM;
    states[editorSlot] = undefined;
    saveSlots();
    showSlot(editorSlot);
    programChanged();
  }
  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: code }, selection: { anchor: 0 }, scrollIntoView: true });
  flushSave();
  log(`opened ${f.name} into ${s.name}`, "sys");
  showBanner(`${f.name} opened in ${s.name} — Ctrl/⌘+Z in the editor brings the previous code back`, 4000);
};

// ---------------------------------------------------------------- theme (like spark-hpi.de: system, light, dark)
const media = matchMedia("(prefers-color-scheme: dark)");
function currentTheme(): Theme {
  return settings.theme === "system" ? (media.matches ? "dark" : "light") : settings.theme;
}
function applyTheme() {
  if (settings.theme === "system") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = settings.theme;
  try {
    // read by the page before the first paint
    if (settings.theme === "system") localStorage.removeItem("spark-sim:theme");
    else localStorage.setItem("spark-sim:theme", settings.theme);
  } catch {
    /* ignore */
  }
  const t = currentTheme();
  viewer.setTheme(t);
  view.dispatch({ effects: themeSlot.reconfigure(editorTheme(t)) });
  states.forEach((st, i) => {
    if (st && i !== editorSlot) states[i] = st.update({ effects: themeSlot.reconfigure(editorTheme(t)) }).state;
  });
  if (dockTab === "telemetry") drawTelemetry(live ? null : cursor, true);
}
media.addEventListener("change", () => settings.theme === "system" && applyTheme());

/** editor font size: A− / A+ in the code footer and Ctrl/⌘ + − / = / 0 */
function stepEditorFont(d: number | "reset") {
  const size = d === "reset" ? DEFAULT_SETTINGS.editorSize : Math.max(EDITOR_MIN, Math.min(EDITOR_MAX, settings.editorSize + d));
  if (size !== settings.editorSize) changeSettings({ ...settings, editorSize: size });
}
$("ed-smaller").onclick = () => stepEditorFont(-1);
$("ed-larger").onclick = () => stepEditorFont(1);

function changeSettings(next: Settings) {
  const prev = settings;
  settings = next;
  store.set("settings", settings);
  applySettingsCss(settings);
  if (prev.theme !== next.theme) applyTheme();
  if (prev.wrap !== next.wrap) {
    view.dispatch({ effects: wrapSlot.reconfigure(wrapExt()) });
    states.forEach((st, i) => {
      if (st && i !== editorSlot) states[i] = st.update({ effects: wrapSlot.reconfigure(wrapExt()) }).state;
    });
  }
  buzzers.volume = settings.volume;
  view.requestMeasure();
  if (!$("settings-pop").classList.contains("hidden")) renderSettingsPop();
  if (dockTab === "telemetry") drawTelemetry(live ? null : cursor, true);
}
function renderSettingsPop() {
  const tour = document.createElement("div");
  tour.className = "row";
  const tb = Object.assign(document.createElement("button"), { className: "btn", textContent: "Take the guided tour" });
  tb.onclick = () => {
    closePops();
    startTour();
  };
  tour.append(tb);
  renderSettings($("settings-pop"), settings, changeSettings, [tour]);
}

// ---------------------------------------------------------------- controls
const arenaSel = $<HTMLSelectElement>("arena");
for (const [id, make] of Object.entries(ARENAS)) arenaSel.add(new Option(make().name, id));
arenaSel.value = arenaId;
arenaSel.onchange = () => {
  arenaId = arenaSel.value;
  store.set("arena", arenaId);
  const arena = arenaById(arenaId);
  // house bots made for another arena are swapped for this arena's default opponent
  const fallback = defaultBotFor(arena.mode);
  slots.forEach((s, i) => {
    const b = BOT_BY_ID[s.source];
    if (b && b.category !== "examples" && b.category !== arena.mode && !(arena.mode === "race" && b.category === "line")) {
      const pick = arena.mode === "race" ? (BOTS.find((x) => x.category === "line")?.id ?? "examples/line_follower.py") : fallback;
      if (pick && BOT_BY_ID[pick]) {
        s.source = pick;
        s.name = BOT_BY_ID[pick].name;
        states[i] = undefined;
      }
    }
  });
  if (slots.length > arena.maxRobots) slots = slots.slice(0, arena.maxRobots);
  saveSlots();
  placed = [];
  if (running) stop("arena changed");
  log(`arena: ${arena.name} — ${arena.blurb}`, "sys");
  load(false);
  showSlot(Math.min(editorSlot, slots.length - 1));
  bench.refreshOptions();
};

$("run").onclick = () => load(true);
$("start").onclick = () => startSignal();
$("stop").onclick = () => stop();
$("reset").onclick = () => reset();
$("clear-console").onclick = () => consoleEl.replaceChildren();

function segmented(id: string, onPick: (b: HTMLButtonElement) => void) {
  const buttons = document.querySelectorAll<HTMLButtonElement>(`#${id} button`);
  buttons.forEach((b) => {
    b.onclick = () => {
      buttons.forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
      onPick(b);
    };
  });
}
segmented("speed", (b) => {
  speed = Number(b.dataset.speed);
  host.setSpeed(speed);
  if (speed === 0 || !isFinite(speed)) buzzers.stopAll();
});
segmented("pixel-mode", (b) => {
  viewer.setPixelMode(b.dataset.mode as PixelMode);
  store.set("pixel", b.dataset.mode);
});
{
  const m = store.get<unknown>("pixel", "pixel");
  document.querySelector<HTMLButtonElement>(`#pixel-mode [data-mode="${m === "spark" || m === "klar" ? m : "pixel"}"]`)?.click();
}

function toggle(id: string, initial: boolean, onChange: (on: boolean) => void) {
  const b = $(id);
  b.setAttribute("aria-pressed", String(initial));
  b.onclick = () => {
    const on = b.getAttribute("aria-pressed") !== "true";
    b.setAttribute("aria-pressed", String(on));
    onChange(on);
  };
}
toggle("overlay", true, (on) => viewer.setOverlay(on));
toggle("sound", true, (on) => {
  buzzers.muted = !on;
  if (!on) buzzers.stopAll();
});
toggle("autopress", autoStart, (on) => {
  autoStart = on;
  store.set("autostart", on);
});
// world settings: robustness tests with a weak battery, a dusty floor or noisy sensors
const WORLD_OPTIONS: { key: keyof WorldTweaks; label: string; choices: [string, number][] }[] = [
  { key: "battery", label: "Battery", choices: [["full", 1], ["60 %", 0.6], ["25 %", 0.25], ["empty", 0]] },
  { key: "grip", label: "Floor grip", choices: [["dusty", 0.7], ["normal", 1], ["sticky", 1.25]] },
  { key: "noise", label: "Sensor noise", choices: [["none", 0], ["normal", 1], ["high", 2.5]] },
];
function worldLabel() {
  const parts: string[] = [];
  if (tweaks.battery !== 1) parts.push(`bat ${Math.round(tweaks.battery * 100)} %`);
  if (tweaks.grip !== 1) parts.push(tweaks.grip < 1 ? "dusty" : "sticky");
  if (tweaks.noise !== 1) parts.push(tweaks.noise === 0 ? "no noise" : "noisy");
  const b = $("world-btn");
  b.textContent = parts.length ? `World: ${parts.join(" · ")}` : "World";
  b.classList.toggle("changed", parts.length > 0);
}
function renderWorldPop() {
  const pop = $("world-pop");
  pop.replaceChildren();
  for (const o of WORLD_OPTIONS) {
    const row = document.createElement("div");
    row.className = "row";
    const lab = document.createElement("span");
    lab.className = "label";
    lab.textContent = o.label;
    const seg = document.createElement("div");
    seg.className = "seg";
    for (const [name, v] of o.choices) {
      const b = document.createElement("button");
      b.textContent = name;
      b.setAttribute("aria-pressed", String(tweaks[o.key] === v));
      b.onclick = () => {
        tweaks = { ...tweaks, [o.key]: v };
        store.set("tweaks", tweaks);
        renderWorldPop();
        worldLabel();
        if (!running) load(false);
      };
      seg.append(b);
    }
    row.append(lab, seg);
    pop.append(row);
  }
  const p = document.createElement("p");
  p.textContent = "Applies from the next Run · the test bench uses it too";
  pop.append(p);
}
worldLabel();

// ---------------------------------------------------------------- popovers: world, layout, settings
const POPS: [button: string, pop: string, render: () => void][] = [
  ["world-btn", "world-pop", () => renderWorldPop()],
  ["layout-btn", "layout-pop", () => renderLayoutPop()],
  ["settings-btn", "settings-pop", () => renderSettingsPop()],
];
function closePops(): boolean {
  let closed = false;
  for (const [b, p] of POPS) {
    if (!$(p).classList.contains("hidden")) closed = true;
    $(p).classList.add("hidden");
    $(b).setAttribute("aria-expanded", "false");
  }
  return closed;
}
for (const [b, p, render] of POPS) {
  $(b).onclick = (e) => {
    e.stopPropagation();
    const open = $(p).classList.contains("hidden");
    closePops();
    if (!open) return;
    render();
    $(p).classList.remove("hidden");
    $(b).setAttribute("aria-expanded", "true");
  };
}
document.addEventListener("pointerdown", (e) => {
  if (!(e.target as HTMLElement).closest(".pop-anchor")) closePops();
});

$("view-side").onclick = () => viewer.view("side");
$("view-top").onclick = () => viewer.view("top");
$("view-follow").onclick = () => viewer.view("follow");

// buttons A/B/C: hold = pressed; the slot is remembered so a release always reaches the same robot
const heldSlot: Record<string, number> = {};
function press(btn: "A" | "B" | "C", down: boolean) {
  const slot = down ? selected : (heldSlot[btn] ?? selected);
  if (down) heldSlot[btn] = selected;
  else delete heldSlot[btn];
  host.press(slot, btn, down);
  document.querySelector(`.hw[data-btn="${btn}"]`)?.classList.toggle("down", down);
}
document.querySelectorAll<HTMLButtonElement>(".hw").forEach((b) => {
  const btn = b.dataset.btn as "A" | "B" | "C";
  b.addEventListener("pointerdown", (ev) => {
    ev.preventDefault();
    press(btn, true);
  });
  const up = () => btn in heldSlot && press(btn, false);
  b.addEventListener("pointerup", up);
  b.addEventListener("pointerleave", up);
});

// ---------------------------------------------------------------- dock
const DOCK_TABS = ["console", "telemetry", "bench", "docs"];
let dockTab = String(store.get<unknown>("dock", "console"));
if (!DOCK_TABS.includes(dockTab)) dockTab = "console";
function showDock(tab: string) {
  dockTab = tab;
  store.set("dock", tab);
  document.querySelectorAll<HTMLButtonElement>(".dock-tabs [data-tab]").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === tab)));
  document.querySelectorAll<HTMLElement>(".pane").forEach((p) => p.classList.toggle("hidden", p.dataset.pane !== tab));
  $("console-tools").classList.toggle("hidden", tab !== "console");
  if (tab !== "console") $("con-new").classList.add("hidden");
  if (tab === "telemetry") drawTelemetry(live ? null : cursor, true);
}
document.querySelectorAll<HTMLButtonElement>(".dock-tabs [data-tab]").forEach((b) => (b.onclick = () => showDock(b.dataset.tab!)));
new ResizeObserver(() => dockTab === "telemetry" && drawTelemetry(live ? null : cursor, true)).observe($("telemetry"));

const bench = new BenchPanel($("bench"), {
  slots: () => slots.map((s) => ({ name: s.name, code: codeOf(s) })),
  arena: () => arenaId,
  tweaks: () => tweaks,
  log: (text) => log(text, "sys"),
  watch(cfg, index) {
    const setup = benchMatchSetup(cfg, index);
    // exactly like on the bench (its arena, World settings and start signal at 0.2 s) — for this match only,
    // your arena and settings stay as they are
    load(true, {
      seed: setup.seed,
      poses: setup.poses,
      robots: setup.robots,
      label: `bench match ${index + 1}`,
      startAt: 0.2,
      arena: cfg.arena,
      tweaks: cfg.tweaks ?? NOMINAL,
    });
    showBanner(`Bench match ${index + 1}${cfg.arena !== arenaId ? ` on ${arenaById(cfg.arena).name}` : ""} — Reset returns to your robots`, 3500);
  },
});

// ---------------------------------------------------------------- workspace layout
const layout = new Layout(
  $("layout"),
  { code: $("panel-code"), stage: $("panel-stage"), dock: $("panel-dock"), inspector: $("panel-inspector") },
  store.get<Partial<LayoutState> | null>("layout-v1", null),
  (s) => store.set("layout-v1", s),
);
layout.onChange = () => {
  view?.requestMeasure();
  if (dockTab === "telemetry" && layout.visible("dock")) drawTelemetry(live ? null : cursor, true);
  if (!$("layout-pop").classList.contains("hidden")) renderLayoutPop();
};

const PRESET_ART: Record<string, string> = {
  default: '<rect x="0.5" y="0.5" width="17" height="35"/><rect class="f" x="19.5" y="0.5" width="28" height="23"/><rect class="t" x="19.5" y="25.5" width="28" height="10"/><rect x="49.5" y="0.5" width="10" height="35"/>',
  code: '<rect x="0.5" y="0.5" width="29" height="23"/><rect class="t" x="0.5" y="25.5" width="29" height="10"/><rect class="f" x="31.5" y="0.5" width="28" height="35"/>',
  watch: '<rect class="f" x="0.5" y="0.5" width="47" height="26"/><rect class="t" x="0.5" y="28.5" width="47" height="7"/><rect x="49.5" y="0.5" width="10" height="35"/>',
  analyse: '<rect x="0.5" y="0.5" width="17" height="20"/><rect class="f" x="19.5" y="0.5" width="28" height="20"/><rect x="49.5" y="0.5" width="10" height="20"/><rect class="t" x="0.5" y="22.5" width="59" height="13"/>',
};
function renderLayoutPop() {
  const pop = $("layout-pop");
  pop.replaceChildren();
  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text = "") => Object.assign(document.createElement(tag), { className: cls, textContent: text });
  pop.append(el("div", "pop-title", "Layout"));
  const presets = el("div", "presets");
  for (const p of PRESETS) {
    const b = el("button", "preset");
    b.innerHTML = `<svg viewBox="0 0 60 36" aria-hidden="true">${PRESET_ART[p.id] ?? ""}</svg>`;
    b.append(el("b", "", p.name), el("small", "", p.hint));
    b.onclick = () => layout.applyPreset(p.id);
    presets.append(b);
  }
  const row = (label: string, ...controls: HTMLElement[]) => {
    const r = el("div", "row");
    r.append(el("span", "label", label), ...controls);
    pop.append(r);
  };
  const seg = <T extends string>(opts: [T, string, string][], cur: T, pick: (v: T) => void) => {
    const g = el("div", "seg");
    for (const [v, label, title] of opts) {
      const b = el("button", "", label);
      b.title = title;
      b.setAttribute("aria-pressed", String(v === cur));
      b.onclick = () => pick(v);
      g.append(b);
    }
    return g;
  };
  row("Presets", presets);
  const s = layout.state;
  row(
    "Console & docs panel",
    seg<DockPlace>(
      [
        ["stage", "Under 3D", "Under the 3D view"],
        ["code", "Under code", "Under the editor, like an IDE terminal"],
        ["bottom", "Full width", "Across the whole window at the bottom"],
      ],
      s.dock,
      (v) => layout.setDock(v),
    ),
  );
  row(
    "Code column",
    seg<"left" | "right">(
      [
        ["left", "Left", "Code on the left, inspector on the right"],
        ["right", "Right", "Code on the right, inspector on the left"],
      ],
      s.codeSide,
      (v) => layout.setSide(v),
    ),
  );
  const toggles = el("div", "toggles");
  for (const [id, label, key] of [["code", "Code", ""], ["dock", "Bottom panel", "D"], ["inspector", "Inspector", "I"]] as [HideablePanel, string, string][]) {
    const b = el("button", "btn toggle", label);
    b.setAttribute("aria-pressed", String(s.show[id]));
    b.title = `Show or hide the ${label.toLowerCase()}${key ? ` (${key})` : ""}`;
    b.onclick = () => layout.toggle(id);
    toggles.append(b);
  }
  row("Panels", toggles);
  const p = el("p", "", "Drag the divider lines to resize (double-click resets). ⤢ in a panel header makes it full size, Esc goes back. Stored in this browser.");
  pop.append(p);
  const foot = el("div", "pop-foot");
  const reset = el("button", "link-btn", "Reset layout");
  reset.onclick = () => layout.applyPreset("default");
  foot.append(reset);
  pop.append(foot);
}

// ---------------------------------------------------------------- docs
/** the robot whose code a docs example goes into: the open one if it runs your code, else your first robot,
 *  else the open robot switches to your own code */
function customSlotForDocs(): number {
  if (!scene.fromSlots) {
    if (running) stop("back to your robots");
    load(false);
  }
  let i = slots[editorSlot]?.source === CUSTOM ? editorSlot : slots.findIndex((s) => s.source === CUSTOM);
  if (i < 0) {
    i = editorSlot;
    slots[i].source = CUSTOM;
    states[i] = undefined;
    saveSlots();
    programChanged();
  }
  if (!layout.visible("code")) layout.toggle("code", true);
  if (i !== editorSlot || !states[i]) showSlot(i);
  return i;
}
const docs = new DocsView($("docs"), DOC_PAGES, {
  insert(code) {
    const s = slots[customSlotForDocs()];
    const pos = view.state.selection.main.head;
    const line = view.state.doc.lineAt(pos);
    // insert on a line of its own
    const at = line.text.trim() ? line.to : line.from;
    const text = (line.text.trim() ? "\n" : "") + code;
    view.dispatch({ changes: { from: at, insert: text }, selection: { anchor: at + text.length }, scrollIntoView: true });
    view.focus();
    return `Inserted into ${s.name}`;
  },
  replace(code) {
    const s = slots[customSlotForDocs()];
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: code }, selection: { anchor: 0 }, scrollIntoView: true });
    view.focus();
    showBanner(`${s.name} has the new program — Ctrl/⌘+Z in the editor brings yours back`, 3500);
    return "Done — ▶ Run";
  },
  remember(page) {
    store.set("docs-page", page);
  },
});
function openDocs(href?: string) {
  if (layout.state.max && layout.state.max !== "dock") layout.maximize(null);
  if (!layout.visible("dock")) layout.toggle("dock", true);
  showDock("docs");
  // short panel: show the docs full size (Esc returns)
  if (!layout.state.max && $("panel-dock").offsetHeight < 300) layout.maximize("dock");
  if (href) docs.open(href);
}
function openDocsApi(cls: string, member?: string) {
  openDocs();
  docs.openApi(cls, member);
}
docs.open(String(store.get<unknown>("docs-page", docs.pageIds[0] ?? "")));
$("docs-btn").onclick = () => openDocs();

// ---------------------------------------------------------------- help and tour
function openHelp() {
  const body = helpContent({
    tour: () => {
      closeHelp();
      startTour();
    },
    docs: () => {
      closeHelp();
      openDocs(docs.pageIds[0]);
    },
  });
  $("modal-body").replaceChildren(body);
  $("modal").classList.remove("hidden");
  $("modal-close").focus();
}
function closeHelp() {
  $("modal").classList.add("hidden");
}
$("help").onclick = openHelp;
$("brand").onclick = openHelp;
$("modal-close").onclick = closeHelp;
$("modal").addEventListener("pointerdown", (e) => e.target === $("modal") && closeHelp());

function startTour() {
  closePops();
  if (layout.state.max) layout.maximize(null);
  const ensure = (panel: HideablePanel) => () => !layout.visible(panel) && layout.toggle(panel, true);
  runTour(
    [
      {
        title: "Welcome to SPARK Sim",
        text: "Here you train your Zumo 2040 before you hold it: write the same code you will copy onto the robot, run it against realistic physics and opponents, and see everything the robot senses. One minute for the tour — or Esc to skip.",
      },
      { target: "#panel-code .panel-head", before: ensure("code"), title: "Robots on the field", text: "Every tab is one robot (up to 4, depending on the arena). The colour is the robot's colour in the 3D view and in the console." },
      { target: ".source-row", before: ensure("code"), title: "Your code or an opponent", text: "Choose your own code, an example, or a house bot as opponent. House bots are read-only — “Edit a copy” turns one into your own code." },
      { target: "#editor", before: ensure("code"), title: "The editor", text: "Your program, saved in this browser. Type “motors.” for suggestions, hover over a robot call for its documentation. Errors from the robot are marked at their line." },
      { target: "#start", title: "Run and Start", text: "▶ Run (Space) starts the programs. Like at a real bout, the robots then wait for the start signal: ⚑ Start (key S) presses button A on every robot, and 5 s later they may move. ⚑ Start alone does both. “Auto start” in the 3D view gives the signal right after Run." },
      { target: "#arena", title: "Arenas", text: "Mini sumo dohyo, line track race, King of the Hill and the A↔B shuttle, each with its real rules, scoring and time limit." },
      { target: "#viewer", title: "The 3D view", text: "Drag to orbit, right-drag to pan, wheel to zoom. Shift+drag moves a robot (the wheel turns it). The scoreboard shows the rules' verdict." },
      { target: ".timeline", title: "Timeline", text: "Everything is recorded: scrub back to any moment, step with ← →, and press Live to follow the match again." },
      { target: "#panel-inspector", before: ensure("inspector"), title: "Inspector", text: "What the selected robot senses right now: its display, LEDs, line sensors, proximity counts, motors and IMU. Press A/B/C here or on the keyboard." },
      { target: "#panel-dock .dock-tabs", before: ensure("dock"), title: "Console, telemetry, test bench, docs", text: "print() output and errors (click an error to jump to the line), live charts, the test bench for hundreds of matches with win rates, and the full documentation." },
      { target: "#layout-btn", title: "Your workspace", text: "Drag the divider lines to resize. In Layout you move the console under the code or across the full width, hide panels or pick a preset. ⚙ sets text size, editor font and sound." },
      { target: "#docs-btn", title: "Start here", text: "The docs begin with “Your first program” — a step-by-step start. F1 opens them anytime, ? shows all shortcuts." },
    ],
    () => store.set("tour-done", true),
  );
}

// ---------------------------------------------------------------- keyboard
// A control focused by a mouse click (not by Tab) must not swallow the app's keys: after clicking ▶ Run, Space
// still means run/stop (not "click Run again"), and after picking an arena, F still means full size (not the
// select's type-ahead to "Free practice"). Controls reached with Tab keep their normal keys.
let pointerAt = -1e9;
let pointerTarget: Element | null = null;
const byPointer = new WeakSet<Element>();
document.addEventListener(
  "pointerdown",
  (e) => {
    pointerAt = performance.now();
    pointerTarget = e.target as Element;
  },
  true,
);
document.addEventListener("focusin", (e) => {
  const el = e.target as Element;
  if (performance.now() - pointerAt < 600) byPointer.add(el);
  else byPointer.delete(el);
});
// a select picked with the mouse gives the keys back right away
document.addEventListener("change", (e) => {
  const el = e.target as HTMLElement;
  if (el instanceof HTMLSelectElement && byPointer.has(el)) el.blur();
});
const TEXT_INPUTS = new Set(["text", "search", "number", "email", "url", "password", "tel"]);
/** the key belongs to the focused element: text fields, the editor, a select reached with Tab */
const isTyping = (t: EventTarget | null) => {
  if (!(t instanceof HTMLElement)) return false;
  if (t.isContentEditable || t.tagName === "TEXTAREA" || t.closest(".cm-editor")) return true;
  if (t instanceof HTMLInputElement) return TEXT_INPUTS.has(t.type);
  if (t instanceof HTMLSelectElement) return !byPointer.has(t);
  return false;
};
/** a button or link reached with Tab: Space activates it */
const ownsSpace = (t: EventTarget | null) => t instanceof HTMLElement && !byPointer.has(t) && t.matches("button, a[href], summary, [role=button], [role=tab]");
/** after a click into the docs or the test bench, Space scrolls there (like reading a page), it does not run */
function readingScroller(): HTMLElement | null {
  const start = pointerTarget instanceof HTMLElement && pointerTarget.isConnected ? pointerTarget : null;
  if (!start?.closest("#panel-dock") || !layout.visible("dock") || (dockTab !== "docs" && dockTab !== "bench")) return null;
  return dockTab === "docs" ? $("docs").querySelector<HTMLElement>(".docs-main") : $("bench");
}
const tourOpen = () => !!document.querySelector(".tour-card");
window.addEventListener("keydown", (ev) => {
  // handled already (the editor, a divider moved with the arrow keys, the docs search …) or the tour is open
  if (ev.defaultPrevented || tourOpen()) return;
  const mod = ev.metaKey || ev.ctrlKey;
  if (ev.key === "F1") {
    ev.preventDefault();
    closeHelp();
    openDocs();
    return;
  }
  if (mod && ev.key === "Enter") {
    ev.preventDefault();
    load(true);
    return;
  }
  if (mod && ev.key === ".") {
    ev.preventDefault();
    stop();
    return;
  }
  if (ev.key === "Escape") {
    if (closePops()) return;
    if (!$("modal").classList.contains("hidden")) return closeHelp();
    if (layout.state.max) layout.maximize(null);
    return;
  }
  const arrow = ev.key === "ArrowLeft" || ev.key === "ArrowRight";
  if (mod || ev.altKey || isTyping(ev.target) || (ev.repeat && !arrow)) return;
  if (!$("modal").classList.contains("hidden") && ev.key !== "?") return;
  const k = ev.key.toLowerCase();
  const target = ev.target as HTMLElement;
  if (ev.key === " ") {
    if (ownsSpace(target)) return;
    ev.preventDefault();
    if (byPointer.has(target)) target.blur();
    const reading = readingScroller();
    if (reading) {
      reading.scrollBy({ top: (ev.shiftKey ? -1 : 1) * reading.clientHeight * 0.85 });
      return;
    }
    if (running) stop();
    else load(true);
    return;
  }
  if (!arrow && !(k.length === 1 && "rvl?sfdi/1234abc".includes(k))) return;
  // a key for the app, not for the select or slider clicked last (no type-ahead to another arena)
  if (target instanceof HTMLSelectElement || (arrow && target instanceof HTMLInputElement)) {
    ev.preventDefault();
    if (byPointer.has(target)) target.blur();
  }
  if (k === "r") reset();
  else if (k === "v") $("overlay").click();
  else if (k === "l") goLive();
  else if (ev.key === "?") openHelp();
  else if (k === "s") startSignal();
  else if (k === "f") layout.maximize("stage");
  else if (k === "d") layout.toggle("dock");
  else if (k === "i") layout.toggle("inspector");
  else if (ev.key === "/" && dockTab === "docs" && layout.visible("dock")) {
    ev.preventDefault();
    docs.focusSearch();
  }
  else if (arrow) {
    ev.preventDefault();
    if (!recorder.frames.length) return;
    const base = live ? recorder.end : cursor;
    scrubTo(base + (ev.key === "ArrowLeft" ? -1 : 1) / 60);
  } else if (k >= "1" && k <= "4") selectRobot(Number(k) - 1);
  else if (k === "a" || k === "b" || k === "c") press(k.toUpperCase() as "A" | "B" | "C", true);
});
window.addEventListener("keyup", (ev) => {
  const k = ev.key.toUpperCase();
  if ((k === "A" || k === "B" || k === "C") && k in heldSlot) press(k, false);
});

viewer.onSelect = (slot) => selectRobot(slot);
viewer.onPlace = (slot, x, y, yaw) => {
  host.place(slot, x, y, yaw);
  // moved by hand before a match: the next Run starts there (↺ Reset forgets it)
  if (scene.fromSlots && !running) placed[slot] = { x, y, yaw };
};

// ---------------------------------------------------------------- brand and splash
$("brand-star").innerHTML = brand.pixelMark(16, 2);
const splash = $("splash");
const splashStar = $<HTMLCanvasElement>("splash-star");
const splashLog = $("splash-log");
const splashStart = performance.now();
let splashOn = true;
(function animateStar() {
  if (!splashOn) return;
  brand.drawSplash(splashStar, (performance.now() - splashStart) / 1000, 200);
  requestAnimationFrame(animateStar);
})();
const bootSteps: [string, Promise<unknown>][] = [
  [`SPARK SIM v${VERSION}`, Promise.resolve()],
  ["MuJoCo physics (WebAssembly)", host.whenReady()],
  ["MicroPython 1.29 · SPARK build", fetch(mpWasm).then((r) => r.arrayBuffer())],
  [`Zumo 2040 model · ${Object.keys(ARENAS).length} arenas`, Promise.resolve()],
  [`Robot programs · ${BOTS.length}`, Promise.resolve()],
];
const logLines: string[] = bootSteps.map(([name]) => `› ${name.toUpperCase().padEnd(38, ".")} …`);
const renderBoot = (done: boolean[]) => {
  splashLog.replaceChildren(
    ...logLines.map((l, i) => {
      const div = document.createElement("div");
      div.textContent = done[i] ? l.replace(/…$/, "OK") : l;
      if (done[i]) div.className = "ok";
      return div;
    }),
  );
  $("splash-progress").style.width = `${(done.filter(Boolean).length / done.length) * 100}%`;
};
const bootDone = bootSteps.map(() => false);
renderBoot(bootDone);
bootSteps.forEach(([, p], i) =>
  p
    .then(() => {
      bootDone[i] = true;
      renderBoot(bootDone);
    })
    .catch(() => undefined),
);
void Promise.allSettled(bootSteps.map(([, p]) => p)).then(() => {
  const wait = Math.max(0, 1100 - (performance.now() - splashStart));
  setTimeout(() => {
    splash.classList.add("gone");
    setTimeout(() => {
      splashOn = false;
      splash.remove();
      if (!store.get("tour-done", false) && !openedWithLink) startTour();
    }, 500);
  }, wait);
});

// ---------------------------------------------------------------- go
view = new EditorView({ parent: $("editor") });
viewer.setTheme(currentTheme());
showDock(dockTab);
buzzers.volume = settings.volume;
log(`SPARK Sim v${VERSION} — ▶ Run (Space) starts the match · F1 opens the docs (start with “Your first program”) · ? shows all shortcuts.`, "sys");
load(false);
showSlot(0);
applyTheme();
void openSharedProgram();
