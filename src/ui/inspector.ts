// Inspector (right column) and scoreboard: pure rendering from a snapshot, used live and when scrubbing.
import type { RobotSnapshot } from "../shared/protocol.ts";
import type { MatchState } from "../world/rules.ts";
import { drawOled } from "./viewer.ts";

const $ = (id: string) => document.getElementById(id)!;

const MODE_TITLE: Record<string, string> = {
  sumo: "Sumo",
  race: "Race",
  koth: "King of the hill",
  shuttle: "Shuttle",
  free: "Free practice",
};

function clock(t: number) {
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, "0")}`;
}

export function renderScoreboard(match: MatchState | undefined, names: string[], colors: string[]) {
  const el = $("scoreboard");
  if (!match || match.mode === "free") {
    el.replaceChildren();
    return;
  }
  const head = document.createElement("div");
  head.className = "sb-head";
  const title = document.createElement("b");
  title.textContent = MODE_TITLE[match.mode] ?? match.mode;
  const time = document.createElement("span");
  if (match.phase === "waiting") time.textContent = "waiting for start";
  else if (match.phase === "countdown") time.textContent = `start in ${Math.ceil(match.countdown - 1e-6)}`;
  else time.textContent = match.timeLimit ? `${clock(match.t)} / ${clock(match.timeLimit)}` : clock(match.t);
  head.classList.toggle("waiting", match.phase === "waiting" || match.phase === "countdown");
  head.append(title, time);
  const rows = names.map((name, i) => {
    const row = document.createElement("div");
    row.className = "sb-row" + (match.ended && match.winner === i ? " win" : "") + (match.out[i] ? " out" : "");
    const chip = document.createElement("span");
    chip.className = "chip";
    chip.style.background = colors[i];
    const n = document.createElement("span");
    n.className = "name";
    n.textContent = name;
    const score = document.createElement("span");
    score.className = "score";
    const v = match.scores[i] ?? 0;
    score.textContent = match.mode === "koth" ? `${v.toFixed(1)} s` : match.mode === "sumo" ? (match.ended && match.winner === i ? "WIN" : "") : String(v);
    row.append(chip, n, score);
    if (match.detail[i]) {
      const d = document.createElement("span");
      d.className = "detail";
      d.textContent = match.detail[i];
      row.append(d);
    }
    return row;
  });
  el.replaceChildren(head, ...rows);
  if (match.phase === "waiting") {
    const hint = document.createElement("div");
    hint.className = "sb-hint";
    hint.textContent = "⚑ Start (key S) gives the start signal";
    el.append(hint);
  }
  if (match.ended) {
    const res = document.createElement("div");
    res.className = "sb-result";
    res.textContent = match.winner === null ? `Draw — ${match.reason}` : `${names[match.winner] ?? "?"} wins`;
    el.append(res);
  }
}

export function renderLeds(rgb: number[] | null) {
  const el = $("leds");
  if (!el.childElementCount) for (let i = 0; i < 6; i++) el.append(Object.assign(document.createElement("div"), { className: "led" }));
  [...el.children].forEach((d, i) => {
    const r = rgb?.[i * 3] ?? 0;
    const g = rgb?.[i * 3 + 1] ?? 0;
    const b = rgb?.[i * 3 + 2] ?? 0;
    const lit = r + g + b > 0;
    const s = (d as HTMLElement).style;
    s.background = lit ? `rgb(${r},${g},${b})` : "";
    s.boxShadow = lit ? `0 0 8px rgb(${r},${g},${b})` : "";
    s.borderColor = lit ? `rgb(${r},${g},${b})` : "";
  });
}

export function renderOled(display: { hex: string; inverted: boolean } | null) {
  drawOled($("oled") as HTMLCanvasElement, display?.hex ?? "", display?.inverted ?? false);
}

export function renderInspector(r: RobotSnapshot | undefined) {
  if (!r) return;
  const line = $("line");
  if (!line.childElementCount) for (let i = 0; i < 5; i++) line.insertAdjacentHTML("beforeend", `<div class="bar" title="DN${i + 1}"><i></i><b></b></div>`);
  r.line.forEach((v, i) => {
    const bar = line.children[i] as HTMLElement;
    // bar height = reflected light: bright surface (small raw value) = full bar
    (bar.firstElementChild as HTMLElement).style.height = `${100 - (Math.min(v, 1024) / 1024) * 100}%`;
    (bar.lastElementChild as HTMLElement).textContent = String(v);
  });
  const prox = $("prox");
  if (!prox.childElementCount)
    for (const n of ["left", "front", "right"]) prox.insertAdjacentHTML("beforeend", `<div class="pcell"><div class="lbl">${n}</div><div class="val"></div></div>`);
  [0, 1, 2].forEach((k) => {
    const c = prox.children[k] as HTMLElement;
    const a = r.prox[k * 2] ?? 0;
    const b = r.prox[k * 2 + 1] ?? 0;
    (c.lastElementChild as HTMLElement).textContent = `${a} · ${b}`;
    c.classList.toggle("hit", a + b > 0);
  });
  const motors = $("motors");
  if (!motors.childElementCount)
    for (const n of ["L", "R"]) motors.insertAdjacentHTML("beforeend", `<div class="mrow"><span>${n}</span><div class="mbar"><i></i></div><span></span></div>`);
  r.motors.forEach((v, i) => {
    const row = motors.children[i] as HTMLElement;
    const bar = row.querySelector("i") as HTMLElement;
    const f = v / 6000;
    bar.style.left = f >= 0 ? "50%" : `${50 + f * 50}%`;
    bar.style.width = `${Math.abs(f) * 50}%`;
    (row.lastElementChild as HTMLElement).textContent = String(v);
  });
  const f = (v: number | undefined, d = 2) => (v === undefined ? "–" : (v >= 0 ? " " : "") + v.toFixed(d));
  kv($("motion"), [
    ["speed", `${f(r.speed)} m/s`],
    ["heading", `${f(r.yaw, 0)}°`],
    ["tilt", `${f(r.tilt, 1)}°`],
    ["encoders", `${r.enc[0]} / ${r.enc[1]}`],
    ["battery", `${(r.mv / 1000).toFixed(2)} V`],
    ["status", r.out ? "OUT" : "in play"],
  ]);
  const read = r.imu.some((v) => v !== 0);
  kv($("imu"), [
    ["acc g", read ? `${f(r.imu[0])} ${f(r.imu[1])} ${f(r.imu[2])}` : "not read"],
    ["gyro °/s", read ? `${f(r.imu[3], 0)} ${f(r.imu[4], 0)} ${f(r.imu[5], 0)}` : "not read"],
    ["mag G", read ? `${f(r.imu[6])} ${f(r.imu[7])} ${f(r.imu[8])}` : "not read"],
  ]);
}

function kv(el: HTMLElement, rows: [string, string][]) {
  if (el.childElementCount !== rows.length * 2) {
    el.replaceChildren(...rows.flatMap(() => [document.createElement("span"), document.createElement("span")]));
  }
  rows.forEach(([k, v], i) => {
    el.children[i * 2].textContent = k;
    el.children[i * 2 + 1].textContent = v;
  });
}
