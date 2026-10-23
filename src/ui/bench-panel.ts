// Test bench pane: pick A and B (a robot slot's current code or any house bot), run N headless matches,
// see win rate with a 95 % interval and watch any single match again.
import { BOTS, CATEGORY_LABEL } from "../bots/index.ts";
import { arenaById } from "../shared/arenas.ts";
import { BenchRunner, benchMaxTime, summarize, type BenchConfig, type BenchMatch } from "./bench.ts";
import type { WorldTweaks } from "../shared/protocol.ts";
import type { RobotConfig } from "./session.ts";

export interface BenchHost {
  /** current robot slots (name + effective code) */
  slots(): RobotConfig[];
  arena(): string;
  tweaks(): WorldTweaks;
  /** load one match into the main view and run it */
  watch(cfg: BenchConfig, index: number): void;
  log(text: string): void;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, cls?: string) {
  const e = document.createElement(tag);
  if (text !== undefined) e.textContent = text;
  if (cls) e.className = cls;
  return e;
}

export class BenchPanel {
  private runner: BenchRunner | null = null;
  private selA: HTMLSelectElement;
  private selB: HTMLSelectElement;
  private count: HTMLInputElement;
  private spread: HTMLButtonElement;
  private runBtn: HTMLButtonElement;
  private progress: HTMLElement;
  private results: HTMLElement;
  private rrCat: HTMLSelectElement;
  private rrPer: HTMLInputElement;
  private rrMine: HTMLButtonElement;
  private rrBtn: HTMLButtonElement;
  /** the arena mode the round-robin category was picked for */
  private rrMode = "";
  /** the run in progress (a cancelled run that is still winding down must not touch the panel) */
  private token = 0;
  private progressNote = { kind: "", done: 0, total: 0 };

  constructor(
    root: HTMLElement,
    private host: BenchHost,
  ) {
    const form = el("div", undefined, "bench-form");
    this.selA = el("select");
    this.selB = el("select");
    this.count = Object.assign(el("input"), { type: "number", min: "2", max: "500", value: "20" });
    this.spread = el("button", "Spread starts", "btn toggle");
    this.spread.setAttribute("aria-pressed", "true");
    this.spread.title = "Random but reproducible start positions and angles for every match (A and B swap sides every second match either way)";
    this.spread.onclick = () => this.spread.setAttribute("aria-pressed", String(this.spread.getAttribute("aria-pressed") !== "true"));
    this.runBtn = el("button", "▶ Run bench", "btn primary");
    this.runBtn.onclick = () => (this.runner ? this.cancel() : void this.run());
    this.runBtn.title = "Run the matches (again: cancel)";
    form.append(el("span", "A", "label"), this.selA, el("span", "vs", "label"), this.selB, el("span", "Matches", "label"), this.count, this.spread, this.runBtn);
    const rr = el("div", undefined, "bench-form");
    rr.style.marginTop = "8px";
    this.rrCat = el("select");
    this.rrPer = Object.assign(el("input"), { type: "number", min: "2", max: "40", value: "4" });
    this.rrMine = el("button", "+ my robots", "btn toggle");
    this.rrMine.setAttribute("aria-pressed", "false");
    this.rrMine.title = "Include your robot slots in the tournament";
    this.rrMine.onclick = () => this.rrMine.setAttribute("aria-pressed", String(this.rrMine.getAttribute("aria-pressed") !== "true"));
    this.rrBtn = el("button", "▶ Round robin", "btn");
    this.rrBtn.title = "Every program against every other on the current arena";
    this.rrBtn.onclick = () => (this.runner ? this.cancel() : void this.roundRobin());
    rr.append(el("span", "Round robin", "label"), this.rrCat, this.rrMine, el("span", "Per pair", "label"), this.rrPer, this.rrBtn);
    this.progress = el("div", undefined, "bench-progress");
    this.progress.append(el("i"));
    this.results = el("div");
    const help = el(
      "p",
      "Runs headless matches as fast as the machine allows (several in parallel) and judges them with the arena's rules. Every match is deterministic: WATCH replays it exactly.",
      "muted",
    );
    root.append(form, rr, this.progress, this.results, help);
    this.refreshOptions();
  }

  /** Rebuild the A/B lists (slots change, arena changes) */
  refreshOptions() {
    const keepA = this.selA.value;
    const keepB = this.selB.value;
    const fill = (sel: HTMLSelectElement, withNone: boolean) => {
      sel.replaceChildren();
      if (withNone) sel.add(new Option("— none (solo run) —", "none"));
      const g = el("optgroup");
      g.label = "Your robots (current code)";
      this.host.slots().forEach((s, i) => g.append(new Option(`${i + 1}: ${s.name}`, `slot:${i}`)));
      sel.append(g);
      const cats = [...new Set(BOTS.map((b) => b.category))];
      for (const c of cats) {
        const og = el("optgroup");
        og.label = CATEGORY_LABEL[c] ?? c;
        for (const b of BOTS.filter((x) => x.category === c)) og.append(new Option(b.name, `bot:${b.id}`));
        sel.append(og);
      }
    };
    fill(this.selA, false);
    fill(this.selB, true);
    const keepCat = this.rrCat.value;
    this.rrCat.replaceChildren();
    for (const c of [...new Set(BOTS.map((b) => b.category))].filter((c) => c !== "examples"))
      this.rrCat.add(new Option(`${CATEGORY_LABEL[c] ?? c} (${BOTS.filter((b) => b.category === c).length})`, c));
    // the category follows the arena; a category picked by hand stays while the arena stays
    const mode = arenaById(this.host.arena()).mode;
    const fits = mode === "race" ? "line" : mode;
    const keep = keepCat && this.rrMode === mode && [...this.rrCat.options].some((o) => o.value === keepCat);
    this.rrCat.value = keep ? keepCat : [...this.rrCat.options].some((o) => o.value === fits) ? fits : (this.rrCat.options[0]?.value ?? "");
    this.rrMode = mode;
    if (keepA && [...this.selA.options].some((o) => o.value === keepA)) this.selA.value = keepA;
    else this.selA.value = "slot:0";
    if (keepB && [...this.selB.options].some((o) => o.value === keepB)) this.selB.value = keepB;
    else this.selB.value = this.host.slots().length > 1 ? "slot:1" : "none";
  }

  private resolve(v: string): RobotConfig | null {
    if (v === "none") return null;
    if (v.startsWith("slot:")) return this.host.slots()[Number(v.slice(5))] ?? null;
    const b = BOTS.find((x) => `bot:${x.id}` === v);
    return b ? { name: b.name, code: b.code } : null;
  }

  private async run() {
    const a = this.resolve(this.selA.value);
    const b = this.resolve(this.selB.value);
    if (!a) return;
    const arena = arenaById(this.host.arena());
    const cfg: BenchConfig = {
      arena: arena.id,
      a: { ...a, name: `A · ${a.name}` },
      b: b ? { ...b, name: `B · ${b.name}` } : null,
      count: Math.max(2, Math.min(500, Number(this.count.value) || 20)),
      jitter: this.spread.getAttribute("aria-pressed") === "true" ? 1 : 0,
      maxTime: benchMaxTime(arena),
      baseSeed: (Math.random() * 1e9) >>> 0,
      tweaks: this.host.tweaks(),
    };
    this.runner = new BenchRunner();
    const my = ++this.token;
    this.progressNote = { kind: "bench", done: 0, total: cfg.count };
    this.busy(this.runBtn);
    this.setProgress(0);
    const matches: BenchMatch[] = [];
    this.host.log(`bench: ${cfg.a.name} vs ${cfg.b?.name ?? "(solo)"} on ${arena.name}, ${cfg.count} matches, seed ${cfg.baseSeed}`);
    const t0 = performance.now();
    await this.runner.run(cfg, (m, done) => {
      if (my !== this.token) return;
      matches.push(m);
      this.progressNote.done = done;
      this.setProgress(done / cfg.count);
      this.render(cfg, matches);
    });
    if (my !== this.token) return; // cancelled
    this.host.log(`bench done: ${matches.length} matches in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
    this.idle();
    this.render(cfg, matches);
  }

  /** one run at a time: the button that started it cancels, the other one waits */
  private busy(active: HTMLButtonElement) {
    active.textContent = "■ Cancel";
    active.classList.add("running");
    const other = active === this.runBtn ? this.rrBtn : this.runBtn;
    other.disabled = true;
  }

  private idle() {
    this.runner = null;
    this.runBtn.textContent = "▶ Run bench";
    this.rrBtn.textContent = "▶ Round robin";
    for (const b of [this.runBtn, this.rrBtn]) {
      b.classList.remove("running");
      b.disabled = false;
    }
  }

  private cancel() {
    if (!this.runner) return;
    this.runner.cancel();
    this.token++;
    const n = this.progressNote;
    this.host.log(`${n.kind} cancelled after ${n.done} of ${n.total} matches`);
    const head = this.results.querySelector(".bench-summary");
    if (n.kind === "round robin" && head?.firstChild) head.firstChild.textContent = `Round robin · ${n.done}/${n.total} matches · cancelled`;
    this.idle();
  }

  private async roundRobin() {
    const bots = BOTS.filter((b) => b.category === this.rrCat.value);
    const entrants: RobotConfig[] = bots.map((b) => ({ name: b.name, code: b.code }));
    if (this.rrMine.getAttribute("aria-pressed") === "true") this.host.slots().forEach((s) => entrants.unshift({ ...s }));
    if (entrants.length < 2) return;
    const per = Math.max(2, Math.min(40, Number(this.rrPer.value) || 4));
    const arena = arenaById(this.host.arena());
    const total = ((entrants.length * (entrants.length - 1)) / 2) * per;
    this.host.log(`round robin: ${entrants.length} programs on ${arena.name}, ${per} matches per pair (${total} matches)`);
    this.runner = new BenchRunner();
    const my = ++this.token;
    this.progressNote = { kind: "round robin", done: 0, total };
    this.busy(this.rrBtn);
    this.setProgress(0);
    const t0 = performance.now();
    let lastRender = 0;
    const res = await this.runner.roundRobin(entrants, per, arena.id, this.host.tweaks(), (done, all, points, games) => {
      if (my !== this.token) return;
      this.progressNote.done = done;
      this.setProgress(done / all);
      if (performance.now() - lastRender > 400 || done === all) {
        lastRender = performance.now();
        this.renderMatrix(entrants, points, games, done, all);
      }
    });
    if (my !== this.token) return; // cancelled
    this.host.log(`round robin done in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
    this.renderMatrix(entrants, res.points, res.games, total, total);
    this.idle();
  }

  private renderMatrix(entrants: RobotConfig[], points: number[][], games: number[][], done: number, all: number) {
    const n = entrants.length;
    const totalPts = points.map((row) => row.reduce((a, b) => a + b, 0));
    const totalGames = games.map((row) => row.reduce((a, b) => a + b, 0));
    const order = [...Array(n).keys()].sort((a, b) => totalPts[b] / Math.max(1, totalGames[b]) - totalPts[a] / Math.max(1, totalGames[a]));
    const box = el("div");
    const head = el("div", undefined, "bench-summary");
    head.textContent = `Round robin · ${done}/${all} matches`;
    head.append(el("br"), el("span", "cell = win rate of the row against the column (draw = ½) · sorted by overall rate", "muted"));
    const table = el("table", undefined, "bench-table matrix");
    const hr = el("tr");
    hr.append(el("th", "#"), el("th", "program"), el("th", "overall"));
    order.forEach((_, k) => hr.append(el("th", String(k + 1))));
    table.append(hr);
    order.forEach((i, k) => {
      const tr = el("tr");
      const rate = totalPts[i] / Math.max(1, totalGames[i]);
      tr.append(el("td", String(k + 1)), el("td", entrants[i].name), el("td", totalGames[i] ? `${Math.round(rate * 100)} %` : "–"));
      order.forEach((j) => {
        const td = el("td");
        if (i === j) td.textContent = "·";
        else if (games[i][j]) {
          const r = points[i][j] / games[i][j];
          td.textContent = `${Math.round(r * 100)}`;
          td.style.background = `color-mix(in oklab, var(--link) ${Math.round(r * 70)}%, transparent)`;
          td.title = `${entrants[i].name} vs ${entrants[j].name}: ${points[i][j]} / ${games[i][j]}`;
        } else td.textContent = "";
        tr.append(td);
      });
      table.append(tr);
    });
    box.append(head, table);
    this.results.replaceChildren(box);
  }

  private setProgress(f: number) {
    (this.progress.firstElementChild as HTMLElement).style.width = `${Math.round(f * 100)}%`;
  }

  private render(cfg: BenchConfig, ms: BenchMatch[]) {
    const s = summarize([...ms].sort((x, y) => x.index - y.index));
    const box = el("div");
    const mode = arenaById(cfg.arena).mode;
    if (cfg.b) {
      const head = el("div", undefined, "bench-summary");
      head.textContent = `${cfg.a.name}: ${(s.rate * 100).toFixed(0)} %`;
      const sub = el("div", `95 % interval ${(s.lo * 100).toFixed(0)}–${(s.hi * 100).toFixed(0)} % · A won ${s.winsA} · B won ${s.winsB} · draws ${s.draws} · ⌀ ${s.avgT.toFixed(1)} s`, "muted");
      head.append(el("br"), sub);
      const bar = el("div", undefined, "bench-rate");
      const a = el("div", undefined, "a");
      a.style.width = `${s.rate * 100}%`;
      a.style.background = "var(--fg)";
      const ci = el("div", undefined, "ci");
      ci.style.left = `${s.lo * 100}%`;
      ci.style.width = `${(s.hi - s.lo) * 100}%`;
      bar.append(a, ci, el("div", undefined, "half"));
      box.append(head, bar);
      if (s.n >= 6 && (s.lo > 0.5 || s.hi < 0.5)) box.append(el("p", s.lo > 0.5 ? "A is significantly stronger." : "B is significantly stronger.", "muted"));
      else if (s.n >= 6) box.append(el("p", "No significant difference yet — run more matches.", "muted"));
    } else {
      const head = el("div", undefined, "bench-summary");
      const best = Math.min(...ms.flatMap((m) => m.match.laps[0] ?? []), Infinity);
      head.textContent = `${cfg.a.name}: ⌀ score ${s.avgScoreA.toFixed(2)}${mode === "race" && isFinite(best) ? ` · best lap ${best.toFixed(2)} s` : ""}`;
      box.append(head);
    }
    const table = el("table", undefined, "bench-table");
    const hr = el("tr");
    for (const h of ["#", "seed", "sides", "winner", "time", "score A:B", "reason", ""]) hr.append(el("th", h));
    table.append(hr);
    for (const m of [...ms].sort((x, y) => x.index - y.index)) {
      const tr = el("tr");
      const watch = el("button", "watch", "link-btn");
      watch.onclick = () => this.host.watch(cfg, m.index);
      const sc = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(1));
      for (const c of [String(m.index + 1), String(m.seed), m.swapped ? "B | A" : "A | B", m.winner, `${m.t.toFixed(1)} s`, `${sc(m.scoreA)} : ${sc(m.scoreB)}`, m.reason])
        tr.append(el("td", c));
      const td = el("td");
      td.append(watch);
      tr.append(td);
      table.append(tr);
    }
    box.append(table);
    this.results.replaceChildren(box);
  }
}
