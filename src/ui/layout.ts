// Workspace layout: four panels (code, 3D stage, bottom dock, inspector) arranged in columns from a small
// state object — resizable with dividers, the dock movable (under the 3D view, under the code or across the full
// width), panels hideable and maximizable. The state is stored per browser by the caller.

export type PanelId = "code" | "stage" | "dock" | "inspector";
export type DockPlace = "stage" | "code" | "bottom";
export type HideablePanel = "code" | "inspector" | "dock";

export interface LayoutState {
  codeSide: "left" | "right";
  dock: DockPlace;
  codeW: number;
  inspW: number;
  dockH: number;
  show: Record<HideablePanel, boolean>;
  max: PanelId | null;
}

export const DEFAULT_LAYOUT: LayoutState = {
  codeSide: "left",
  dock: "stage",
  codeW: 470,
  inspW: 300,
  dockH: 270,
  show: { code: true, inspector: true, dock: true },
  max: null,
};

export interface Preset {
  id: string;
  name: string;
  hint: string;
  make(w: number, h: number): LayoutState;
}

const base = (): LayoutState => ({ ...DEFAULT_LAYOUT, show: { ...DEFAULT_LAYOUT.show } });

export const PRESETS: Preset[] = [
  { id: "default", name: "Default", hint: "Code · 3D view with the console below · inspector", make: () => base() },
  {
    id: "code",
    name: "Code",
    hint: "Wide editor with the console under it, 3D view beside it",
    make: (w, h) => ({ ...base(), dock: "code", codeW: Math.round(w * 0.52), dockH: Math.round(h * 0.32), show: { code: true, inspector: false, dock: true } }),
  },
  {
    id: "watch",
    name: "Watch",
    hint: "Big 3D view and the inspector, code hidden",
    make: () => ({ ...base(), dockH: 190, show: { code: false, inspector: true, dock: true } }),
  },
  {
    id: "analyse",
    name: "Analyse",
    hint: "Console, telemetry and test bench across the full width",
    make: (_w, h) => ({ ...base(), dock: "bottom", dockH: Math.round(h * 0.46) }),
  },
];

/** Smallest sizes in CSS pixels */
const MIN = { code: 300, inspector: 230, stageW: 340, stageH: 200, dock: 120 };
const SPLIT = 7; // divider hit area
const STACK_BELOW = 760; // narrower windows stack the panels vertically

/** scrollable areas whose position survives a rebuild (moving a panel resets scrolling) */
const SCROLLERS = ".cm-scroller, .pane, .docs-main, .docs-nav, .docs-results, .insp-body, .tabs";

const div = (cls: string) => Object.assign(document.createElement("div"), { className: cls });

export class Layout {
  state: LayoutState;
  /** after every rebuild or resize (editor measure, telemetry redraw …) */
  onChange: () => void = () => {};
  private cols: { code?: HTMLElement; insp?: HTMLElement } = {};
  private dockAt: DockPlace | null = null;
  private parking = Object.assign(document.createElement("div"), { hidden: true });
  private mode = "";

  constructor(
    private root: HTMLElement,
    private panels: Record<PanelId, HTMLElement>,
    initial: Partial<LayoutState> | null,
    private save: (s: LayoutState) => void,
  ) {
    this.state = sanitize(initial);
    document.body.append(this.parking);
    for (const id of Object.keys(panels) as PanelId[]) this.addTools(id);
    new ResizeObserver(() => this.fit()).observe(root);
    // a rebuild is only needed when the window crosses a breakpoint; sizes follow via the ResizeObserver
    window.addEventListener("resize", () => this.modeKey() !== this.mode && this.build());
    this.build();
  }

  // ---------------------------------------------------------------- public actions
  toggle(panel: HideablePanel, on = !this.state.show[panel]) {
    this.state.show[panel] = on;
    if (on && this.state.max && this.state.max !== panel) this.state.max = null;
    if (!on && this.state.max === panel) this.state.max = null;
    this.commit();
  }

  maximize(panel: PanelId | null) {
    this.state.max = this.state.max === panel ? null : panel;
    if (panel && panel !== "stage") this.state.show[panel] = true;
    this.commit();
  }

  setDock(place: DockPlace) {
    this.state.dock = place;
    this.state.show.dock = true;
    if (place === "code") this.state.show.code = true;
    this.state.max = null;
    this.commit();
  }

  setSide(side: "left" | "right") {
    this.state.codeSide = side;
    this.commit();
  }

  applyPreset(id: string) {
    const p = PRESETS.find((x) => x.id === id) ?? PRESETS[0];
    this.state = p.make(this.root.clientWidth || window.innerWidth, this.root.clientHeight || window.innerHeight);
    this.commit();
  }

  /** Is the panel on screen right now? */
  visible(panel: PanelId): boolean {
    const s = this.state;
    if (s.max) return s.max === panel;
    if (panel === "stage") return true;
    return s.show[panel];
  }

  private commit() {
    this.save(this.state);
    this.build();
  }

  // ---------------------------------------------------------------- building
  private modeKey() {
    return `${window.innerWidth < STACK_BELOW}`;
  }

  build() {
    const s = this.state;
    const P = this.panels;
    this.mode = this.modeKey();
    const scrolls: [Element, number, number][] = [];
    for (const p of Object.values(P))
      p.querySelectorAll(SCROLLERS).forEach((e) => (e.scrollTop || e.scrollLeft) && scrolls.push([e, e.scrollTop, e.scrollLeft]));
    for (const p of Object.values(P)) {
      p.classList.remove("maxed");
      p.style.height = "";
      this.parking.append(p);
    }
    this.root.replaceChildren();
    this.cols = {};
    this.dockAt = null;
    const stacked = window.innerWidth < STACK_BELOW;
    this.root.classList.toggle("stacked", stacked);
    this.root.dataset.max = s.max ?? "";

    if (s.max) {
      P[s.max].classList.add("maxed");
      this.root.append(P[s.max]);
    } else if (stacked) {
      const order: PanelId[] = s.codeSide === "left" ? ["code", "stage", "dock", "inspector"] : ["stage", "dock", "code", "inspector"];
      for (const id of order) if (id === "stage" || s.show[id as HideablePanel]) this.root.append(P[id]);
    } else {
      const showCode = s.show.code;
      const showInsp = s.show.inspector;
      this.dockAt = s.show.dock ? (s.dock === "code" && !showCode ? "stage" : s.dock) : null;

      const col = (cls: string) => div(`ws-col ${cls}`);
      const center = col("ws-center");
      center.append(P.stage);
      if (this.dockAt === "stage") center.append(this.hSplit(), P.dock);
      let code: HTMLElement | undefined;
      if (showCode) {
        code = col("ws-code");
        code.append(P.code);
        if (this.dockAt === "code") code.append(this.hSplit(), P.dock);
        this.cols.code = code;
      }
      let insp: HTMLElement | undefined;
      if (showInsp) {
        insp = col("ws-insp");
        insp.append(P.inspector);
        this.cols.insp = insp;
      }
      const row = div("ws-row");
      const left = s.codeSide === "left";
      // a hidden panel leaves a slim tab at its edge that brings it back
      const codeEdge = showCode ? undefined : this.edge("code", left ? "left" : "right", "Code");
      const inspEdge = showInsp ? undefined : this.edge("inspector", left ? "right" : "left", "Inspector");
      const seq: (HTMLElement | undefined)[] = left
        ? [codeEdge, code, code && this.vSplit("code"), center, insp && this.vSplit("inspector"), insp, inspEdge]
        : [inspEdge, insp, insp && this.vSplit("inspector"), center, code && this.vSplit("code"), code, codeEdge];
      for (const e of seq) if (e) row.append(e);
      this.root.append(row);
      if (this.dockAt === "bottom") this.root.append(this.hSplit(), P.dock);
      if (!s.show.dock) this.root.append(this.edge("dock", "bottom", "Console · Telemetry · Test bench · Docs"));
    }
    this.updateTools();
    this.fit();
    for (const [e, top, left] of scrolls) {
      e.scrollTop = top;
      e.scrollLeft = left;
    }
  }

  /** Apply the stored sizes, clamped to the window */
  private fit() {
    if (this.state.max || this.root.classList.contains("stacked")) {
      this.onChange();
      return;
    }
    const s = this.state;
    const W = this.root.clientWidth;
    const H = this.root.clientHeight;
    const { code, insp } = this.cols;
    const splits = (code ? SPLIT : 0) + (insp ? SPLIT : 0);
    if (insp) {
      const max = Math.max(MIN.inspector, W - MIN.stageW - splits - (code ? MIN.code : 0));
      insp.style.width = `${clamp(s.inspW, MIN.inspector, max)}px`;
    }
    if (code) {
      const inspW = insp ? insp.offsetWidth : 0;
      const max = Math.max(MIN.code, W - MIN.stageW - splits - inspW);
      code.style.width = `${clamp(s.codeW, MIN.code, max)}px`;
    }
    if (this.dockAt) {
      const host = this.dockAt === "bottom" ? H : (this.dockAt === "code" ? code : this.panels.stage.parentElement)?.clientHeight ?? H;
      const max = Math.max(MIN.dock, host - (this.dockAt === "code" ? 260 : MIN.stageH) - SPLIT);
      this.panels.dock.style.height = `${clamp(s.dockH, MIN.dock, max)}px`;
    }
    this.onChange();
  }

  private edge(panel: HideablePanel, side: "left" | "right" | "bottom", label: string): HTMLElement {
    const b = document.createElement("button");
    b.className = `edge-tab ${side}`;
    b.textContent = side === "bottom" ? `▴ ${label}` : side === "left" ? `${label} ›` : `‹ ${label}`;
    b.title = `Show the ${NAMES[panel]}${panel === "dock" ? " (D)" : panel === "inspector" ? " (I)" : ""}`;
    b.onclick = () => this.toggle(panel, true);
    return b;
  }

  // ---------------------------------------------------------------- dividers
  private vSplit(which: "code" | "inspector"): HTMLElement {
    const el = this.splitter("v", which === "code" ? "Resize the code column" : "Resize the inspector");
    const key = which === "code" ? "codeW" : "inspW";
    // dragging towards the centre makes the column wider
    const sign = () => ((which === "code") === (this.state.codeSide === "left") ? 1 : -1);
    const shown = () => (which === "code" ? this.cols.code : this.cols.insp)?.offsetWidth ?? this.state[key];
    this.drag(el, "x", shown, (v) => (this.state[key] = v), sign, () => (this.state[key] = DEFAULT_LAYOUT[key]));
    return el;
  }

  private hSplit(): HTMLElement {
    const el = this.splitter("h", "Resize the bottom panel");
    this.drag(el, "y", () => this.panels.dock.offsetHeight, (v) => (this.state.dockH = v), () => -1, () => (this.state.dockH = DEFAULT_LAYOUT.dockH));
    return el;
  }

  private splitter(dir: "v" | "h", label: string): HTMLElement {
    const el = div(`splitter ${dir}`);
    el.tabIndex = 0;
    el.setAttribute("role", "separator");
    el.setAttribute("aria-orientation", dir === "v" ? "vertical" : "horizontal");
    el.setAttribute("aria-label", label);
    el.title = `${label} — drag · double-click resets · arrow keys`;
    return el;
  }

  /** shown = the size on screen now (the stored value can be larger than what fits the window) */
  private drag(el: HTMLElement, axis: "x" | "y", shown: () => number, set: (v: number) => void, sign: () => number, reset: () => void) {
    let start = 0;
    let from = 0;
    el.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      el.setPointerCapture(e.pointerId);
      start = axis === "x" ? e.clientX : e.clientY;
      from = shown();
      el.classList.add("dragging");
      document.body.classList.add(axis === "x" ? "resizing-x" : "resizing-y");
    });
    el.addEventListener("pointermove", (e) => {
      if (!el.hasPointerCapture(e.pointerId)) return;
      const d = (axis === "x" ? e.clientX : e.clientY) - start;
      set(Math.round(from + sign() * d));
      this.fit();
    });
    const end = (e: PointerEvent) => {
      if (!el.hasPointerCapture(e.pointerId)) return;
      el.releasePointerCapture(e.pointerId);
      el.classList.remove("dragging");
      document.body.classList.remove("resizing-x", "resizing-y");
      this.normalize();
      this.save(this.state);
    };
    el.addEventListener("pointerup", end);
    el.addEventListener("pointercancel", end);
    el.addEventListener("dblclick", () => {
      reset();
      this.fit();
      this.save(this.state);
    });
    el.addEventListener("keydown", (e) => {
      const step = e.shiftKey ? 64 : 16;
      const k = e.key;
      let d = 0;
      if (axis === "x" && (k === "ArrowLeft" || k === "ArrowRight")) d = k === "ArrowRight" ? step : -step;
      if (axis === "y" && (k === "ArrowUp" || k === "ArrowDown")) d = k === "ArrowDown" ? step : -step;
      if (!d) return;
      e.preventDefault();
      set(shown() + sign() * d);
      this.fit();
      this.normalize();
      this.save(this.state);
    });
  }

  /** after a drag: store what is actually shown, so a later window resize does not jump */
  private normalize() {
    const { code, insp } = this.cols;
    if (code) this.state.codeW = code.offsetWidth;
    if (insp) this.state.inspW = insp.offsetWidth;
    if (this.dockAt) this.state.dockH = this.panels.dock.offsetHeight;
  }

  // ---------------------------------------------------------------- panel header tools
  private addTools(id: PanelId) {
    const host = this.panels[id].querySelector<HTMLElement>("[data-tools]");
    if (!host) return;
    const max = document.createElement("button");
    max.className = "tool";
    max.dataset.act = "max";
    max.onclick = () => this.maximize(id);
    host.append(max);
    if (id !== "stage") {
      const hide = document.createElement("button");
      hide.className = "tool";
      hide.dataset.act = "hide";
      hide.textContent = "–";
      hide.title = `Hide the ${NAMES[id]} (Layout menu shows it again)`;
      hide.setAttribute("aria-label", hide.title);
      hide.onclick = () => this.toggle(id as HideablePanel, false);
      host.append(hide);
    }
  }

  private updateTools() {
    for (const id of Object.keys(this.panels) as PanelId[]) {
      const b = this.panels[id].querySelector<HTMLButtonElement>('[data-tools] [data-act="max"]');
      if (!b) continue;
      const on = this.state.max === id;
      b.textContent = on ? "⤡" : "⤢";
      b.title = on ? "Back to the layout (Esc)" : `Maximize the ${NAMES[id]}${id === "stage" ? " (F)" : ""}`;
      b.setAttribute("aria-label", b.title);
      b.setAttribute("aria-pressed", String(on));
    }
  }
}

const NAMES: Record<PanelId, string> = { code: "code", stage: "3D view", dock: "bottom panel", inspector: "inspector" };

function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v));
}

function sanitize(s: Partial<LayoutState> | null): LayoutState {
  const d = base();
  if (!s || typeof s !== "object") return d;
  const num = (v: unknown, fb: number) => (typeof v === "number" && isFinite(v) && v > 0 ? v : fb);
  return {
    codeSide: s.codeSide === "right" ? "right" : "left",
    dock: s.dock === "code" || s.dock === "bottom" ? s.dock : "stage",
    codeW: num(s.codeW, d.codeW),
    inspW: num(s.inspW, d.inspW),
    dockH: num(s.dockH, d.dockH),
    show: {
      code: s.show?.code !== false,
      inspector: s.show?.inspector !== false,
      dock: s.show?.dock !== false,
    },
    // a maximized panel is a moment, not a layout: a reload starts with all panels
    max: null,
  };
}
