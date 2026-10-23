// User settings (per browser): theme, text sizes, editor font, console and sound. The popover UI lives here too.

export type ThemeChoice = "system" | "light" | "dark";
export type UiSize = "s" | "m" | "l";

export interface Settings {
  theme: ThemeChoice;
  uiSize: UiSize;
  editorFont: "code" | "pixel";
  editorSize: number;
  wrap: boolean;
  timestamps: boolean;
  volume: number; // 0..1
}

export const DEFAULT_SETTINGS: Settings = {
  theme: "system",
  uiSize: "m",
  editorFont: "code",
  editorSize: 14,
  wrap: false,
  timestamps: true,
  volume: 0.7,
};

/** UI text size in px per step (Departure Mono is drawn on an 11 px grid; 11 is the sharpest) */
export const UI_PX: Record<UiSize, number> = { s: 11, m: 12, l: 14 };
export const EDITOR_MIN = 10;
export const EDITOR_MAX = 26;

export function loadSettings(raw: unknown): Settings {
  const s = (raw && typeof raw === "object" ? raw : {}) as Partial<Settings>;
  const d = DEFAULT_SETTINGS;
  return {
    theme: s.theme === "light" || s.theme === "dark" ? s.theme : "system",
    uiSize: s.uiSize === "s" || s.uiSize === "l" ? s.uiSize : d.uiSize,
    editorFont: s.editorFont === "pixel" ? "pixel" : "code",
    editorSize: typeof s.editorSize === "number" && isFinite(s.editorSize) ? Math.max(EDITOR_MIN, Math.min(EDITOR_MAX, Math.round(s.editorSize))) : d.editorSize,
    wrap: s.wrap === true,
    timestamps: s.timestamps !== false,
    volume: typeof s.volume === "number" && isFinite(s.volume) ? Math.max(0, Math.min(1, s.volume)) : d.volume,
  };
}

/** CSS variables for text sizes and the editor font */
export function applySettingsCss(s: Settings) {
  const r = document.documentElement.style;
  r.setProperty("--ui", `${UI_PX[s.uiSize]}px`);
  r.setProperty("--ed-size", `${s.editorSize}px`);
  r.setProperty("--ed-font", s.editorFont === "pixel" ? "var(--mono)" : "var(--code)");
  // the console follows the editor font, one step smaller
  r.setProperty("--con-size", `${Math.max(EDITOR_MIN, s.editorSize - 1)}px`);
  document.documentElement.classList.toggle("no-timestamps", !s.timestamps);
}

type Option<T> = { label: string; value: T; title?: string };

/** Build the settings popover. change() is called with the new settings after every edit. */
export function renderSettings(host: HTMLElement, s: Settings, change: (next: Settings) => void, extra: HTMLElement[] = []) {
  host.replaceChildren();
  const head = document.createElement("div");
  head.className = "pop-title";
  head.textContent = "Settings";
  host.append(head);

  const row = (label: string, control: HTMLElement, hint?: string) => {
    const r = document.createElement("div");
    r.className = "row";
    const l = document.createElement("span");
    l.className = "label";
    l.textContent = label;
    r.append(l, control);
    if (hint) {
      const h = document.createElement("p");
      h.textContent = hint;
      r.append(h);
    }
    host.append(r);
  };
  const seg = <T>(opts: Option<T>[], cur: T, pick: (v: T) => void) => {
    const g = document.createElement("div");
    g.className = "seg";
    for (const o of opts) {
      const b = document.createElement("button");
      b.textContent = o.label;
      if (o.title) b.title = o.title;
      b.setAttribute("aria-pressed", String(o.value === cur));
      b.onclick = () => pick(o.value);
      g.append(b);
    }
    return g;
  };
  const set = (patch: Partial<Settings>) => change({ ...s, ...patch });

  row("Theme", seg<ThemeChoice>([{ label: "System", value: "system" }, { label: "Light", value: "light" }, { label: "Dark", value: "dark" }], s.theme, (v) => set({ theme: v })));
  row(
    "Text size",
    seg<UiSize>(
      [
        { label: "S", value: "s", title: "Small (11 px, sharpest pixel font)" },
        { label: "M", value: "m", title: "Medium (12 px)" },
        { label: "L", value: "l", title: "Large (14 px)" },
      ],
      s.uiSize,
      (v) => set({ uiSize: v }),
    ),
    "Buttons, labels, inspector and panels",
  );
  row(
    "Editor font",
    seg<"code" | "pixel">(
      [
        { label: "Code", value: "code", title: "JetBrains Mono — easy to read for long sessions" },
        { label: "Pixel", value: "pixel", title: "Departure Mono — the SPARK look" },
      ],
      s.editorFont,
      (v) => set({ editorFont: v }),
    ),
  );
  const size = document.createElement("div");
  size.className = "stepper";
  const minus = Object.assign(document.createElement("button"), { className: "btn icon", textContent: "A−", title: "Smaller (Ctrl/⌘ + − in the editor)" });
  const val = Object.assign(document.createElement("span"), { className: "val", textContent: `${s.editorSize} px` });
  const plus = Object.assign(document.createElement("button"), { className: "btn icon", textContent: "A+", title: "Larger (Ctrl/⌘ + = in the editor)" });
  minus.onclick = () => set({ editorSize: Math.max(EDITOR_MIN, s.editorSize - 1) });
  plus.onclick = () => set({ editorSize: Math.min(EDITOR_MAX, s.editorSize + 1) });
  size.append(minus, val, plus);
  row("Editor & console size", size, "The console uses the editor font, one step smaller");
  row("Line wrapping", seg<boolean>([{ label: "Off", value: false }, { label: "On", value: true }], s.wrap, (v) => set({ wrap: v })));
  row("Console timestamps", seg<boolean>([{ label: "Off", value: false }, { label: "On", value: true }], s.timestamps, (v) => set({ timestamps: v })), "Robot time in seconds before every line");
  const vol = document.createElement("input");
  vol.type = "range";
  vol.min = "0";
  vol.max = "100";
  vol.step = "5";
  vol.value = String(Math.round(s.volume * 100));
  vol.setAttribute("aria-label", "Volume");
  const volVal = Object.assign(document.createElement("span"), { className: "val", textContent: `${vol.value} %` });
  vol.oninput = () => (volVal.textContent = `${vol.value} %`);
  vol.onchange = () => set({ volume: Number(vol.value) / 100 });
  const volBox = document.createElement("div");
  volBox.className = "stepper";
  volBox.append(vol, volVal);
  row("Volume", volBox, "Buzzers and referee sounds (the Sound button mutes)");
  for (const e of extra) host.append(e);
  const reset = Object.assign(document.createElement("button"), { className: "link-btn", textContent: "Reset settings" });
  reset.onclick = () => change({ ...DEFAULT_SETTINGS });
  const foot = document.createElement("div");
  foot.className = "pop-foot";
  foot.append(reset);
  host.append(foot);
}
