// Editor helpers: zumo_2040_robot autocompletion and hover docs, error markers from tracebacks, shortcuts.
import { autocompletion, type Completion, type CompletionContext, type CompletionResult } from "@codemirror/autocomplete";
import { setDiagnostics, type Diagnostic } from "@codemirror/lint";
import { EditorSelection } from "@codemirror/state";
import { hoverTooltip, keymap, type EditorView } from "@codemirror/view";
import { Prec, type Extension } from "@codemirror/state";
import { ROBOT_API, TIME_API, type ApiClass, type ApiMember } from "./api.ts";

const MODULES: Record<string, Completion[]> = {
  robot: ROBOT_API.map((c) => ({ label: c.name, type: "class", detail: c.ctor, info: c.doc, apply: c.name + "()" })),
  time: TIME_API.map((m) => ({ label: m.name, type: "function", detail: m.sig, info: m.doc })),
};

/** Member completions per class, plus the nested IMU sensors. */
const MEMBERS: Record<string, Completion[]> = Object.fromEntries(
  ROBOT_API.map((c) => [
    c.name,
    // IMU sub-sensor members ("gyro.read") are offered after `imu.gyro.` instead
    c.members.filter((m) => !m.name.includes(".")).map((m) => ({
      label: m.name,
      type: m.kind === "constant" ? "constant" : m.kind === "property" ? "property" : "method",
      detail: m.sig,
      info: m.doc,
    })),
  ]),
);
MEMBERS.ButtonB ??= MEMBERS.ButtonA;
MEMBERS.ButtonC ??= MEMBERS.ButtonA;
const IMU_MEMBERS = ROBOT_API.find((c) => c.name === "IMU")?.members ?? [];
const IMU_SENSORS: Record<string, Completion[]> = Object.fromEntries(
  ["acc", "gyro", "mag"].map((sensor) => [
    sensor,
    IMU_MEMBERS.filter((m) => m.name.startsWith(sensor + ".")).map((m) => ({
      label: m.name.slice(sensor.length + 1),
      type: m.kind === "property" ? "property" : "method",
      detail: m.sig.slice(sensor.length + 1),
      info: m.doc,
    })),
  ]),
);

/** Infer `name = robot.Class()` assignments from the document. */
function variableClasses(doc: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of doc.matchAll(/^\s*([A-Za-z_]\w*)\s*=\s*robot\.(\w+)\s*\(/gm)) out[m[1]] = m[2];
  return out;
}

function complete(ctx: CompletionContext): CompletionResult | null {
  const word = ctx.matchBefore(/[A-Za-z_][\w.]*$/);
  if (!word) return null;
  const parts = word.text.split(".");
  if (parts.length < 2) return null;
  const prefix = parts.slice(0, -1);
  const from = word.to - parts[parts.length - 1].length;
  let options: Completion[] | undefined;
  if (prefix.length === 1 && MODULES[prefix[0]]) options = MODULES[prefix[0]];
  else {
    const vars = variableClasses(ctx.state.doc.toString());
    const cls = vars[prefix[0]];
    if (prefix.length === 1 && cls) options = MEMBERS[cls];
    else if (prefix.length === 2 && cls === "IMU") options = IMU_SENSORS[prefix[1]];
  }
  return options ? { from, options, validFor: /^\w*$/ } : null;
}

export function robotCompletion(): Extension {
  return autocompletion({ override: [complete], icons: false });
}

export function runKeys(run: () => void, stop: () => void): Extension {
  return Prec.highest(
    keymap.of([
      { key: "Mod-Enter", run: () => (run(), true) },
      { key: "Mod-.", run: () => (stop(), true) },
    ]),
  );
}

/**
 * Turns MicroPython traceback output into editor diagnostics. Feed it every console line of one robot; it collects
 * a traceback and, at the final "XyzError: message" line, marks the deepest main.py line.
 */
export class TracebackCollector {
  private lines: number[] = [];
  private active = false;

  constructor(private view: () => EditorView | null) {}

  feed(line: string) {
    if (line.startsWith("Traceback")) {
      this.active = true;
      this.lines = [];
      return;
    }
    const m = line.match(/File "main\.py", line (\d+)/);
    if (m) {
      this.active = true;
      this.lines.push(Number(m[1]));
      return;
    }
    if (this.active && /^\w+(Error|Exception|Interrupt|Exit)\b/.test(line)) {
      this.active = false;
      const ln = this.lines[this.lines.length - 1];
      if (ln) this.mark(ln, line);
    }
  }

  mark(lineNo: number, message: string) {
    const v = this.view();
    if (!v) return;
    const doc = v.state.doc;
    if (lineNo < 1 || lineNo > doc.lines) return;
    const line = doc.line(lineNo);
    const d: Diagnostic = { from: line.from, to: Math.max(line.from, line.to), severity: "error", message };
    v.dispatch(setDiagnostics(v.state, [d]));
  }

  clear() {
    const v = this.view();
    if (v) v.dispatch(setDiagnostics(v.state, []));
    this.lines = [];
    this.active = false;
  }
}

// ---------------------------------------------------------------- hover documentation
type Extra = Partial<{ returns: string; timing: string }>;
const CLASS_BY_NAME: Record<string, ApiClass> = Object.fromEntries(ROBOT_API.map((c) => [c.name, c]));
CLASS_BY_NAME.ButtonB ??= CLASS_BY_NAME.ButtonA;
CLASS_BY_NAME.ButtonC ??= CLASS_BY_NAME.ButtonA;
const SENSOR_DOC: Record<string, string> = {
  acc: "Accelerometer of the IMU (g). read(), last_reading_g [x, y, z], data_ready(), set_output_data_rate(hz), set_full_scale(g).",
  gyro: "Gyro of the IMU (°/s). read(), last_reading_dps [x, y, z] (z > 0 = turning left), data_ready(), set_output_data_rate(hz).",
  mag: "Magnetometer of the IMU (gauss). read(), last_reading_gauss [x, y, z], data_ready().",
};

interface HoverDoc {
  title: string;
  doc: string;
  facts: string[];
  cls?: string;
  member?: string;
}

function resolve(parts: string[], doc: string): HoverDoc | null {
  const clsDoc = (c: ApiClass): HoverDoc => ({ title: c.ctor, doc: c.doc, facts: [], cls: c.name });
  const memberDoc = (c: ApiClass, m: ApiMember & Extra): HoverDoc => ({
    title: `${c.name}.${m.sig}`,
    doc: m.doc,
    facts: [m.returns ? `returns ${m.returns}` : "", m.timing ? `takes ${m.timing}` : ""].filter(Boolean),
    cls: c.name,
    member: m.name,
  });
  const word = parts[parts.length - 1];
  if (parts[0] === "robot") {
    const c = CLASS_BY_NAME[parts[1]];
    if (!c) return null;
    if (parts.length === 2) return clsDoc(c);
    const m = c.members.find((x) => x.name === parts[2]);
    return m ? memberDoc(c, m) : null;
  }
  if (parts[0] === "time" && parts.length === 2) {
    const m = TIME_API.find((x) => x.name === word);
    return m ? { title: `time.${m.sig}`, doc: m.doc, facts: [], cls: "time", member: m.name } : null;
  }
  const cls = variableClasses(doc)[parts[0]];
  const c = cls ? CLASS_BY_NAME[cls] : undefined;
  if (!c) return null;
  if (parts.length === 1) return { ...clsDoc(c), title: `${parts[0]} = ${c.ctor}` };
  if (cls === "IMU" && SENSOR_DOC[parts[1]]) {
    if (parts.length === 2) return { title: `${parts[0]}.${parts[1]}`, doc: SENSOR_DOC[parts[1]], facts: [], cls: "IMU", member: parts[1] };
    const m = c.members.find((x) => x.name === `${parts[1]}.${parts[2]}`);
    return m ? { ...memberDoc(c, m), title: `${parts[0]}.${m.sig}` } : null;
  }
  const m = c.members.find((x) => x.name === parts[1]);
  return m ? memberDoc(c, m) : null;
}

/** Hover over robot API calls (and variables made with robot.Xyz()) to see their documentation. */
export function apiHover(openDocs: (cls: string, member?: string) => void): Extension {
  return hoverTooltip(
    (view, pos) => {
      const line = view.state.doc.lineAt(pos);
      const text = line.text;
      const off = pos - line.from;
      if (!/\w/.test(text[off] ?? "") && !/\w/.test(text[off - 1] ?? "")) return null;
      let a = off;
      let b = off;
      while (a > 0 && /[\w.]/.test(text[a - 1])) a--;
      while (b < text.length && /\w/.test(text[b])) b++;
      const parts = text.slice(a, b).split(".").filter(Boolean);
      if (!parts.length) return null;
      const info = resolve(parts, view.state.doc.toString());
      if (!info) return null;
      const wordStart = text.lastIndexOf(parts[parts.length - 1], b);
      return {
        pos: line.from + Math.max(a, wordStart),
        end: line.from + b,
        above: true,
        create() {
          const dom = document.createElement("div");
          dom.className = "api-tip";
          const sig = document.createElement("div");
          sig.className = "sig";
          sig.textContent = info.title;
          dom.append(sig);
          if (info.doc) {
            const d = document.createElement("div");
            d.textContent = info.doc.replace(/[`*]/g, "");
            dom.append(d);
          }
          if (info.facts.length) {
            const f = document.createElement("div");
            f.className = "facts";
            f.textContent = info.facts.join(" · ");
            dom.append(f);
          }
          if (info.cls) {
            const more = document.createElement("div");
            more.className = "more";
            const link = document.createElement("button");
            link.className = "link-btn";
            link.textContent = "Open in the docs →";
            link.onclick = () => openDocs(info.cls!, info.member);
            more.append(link);
            dom.append(more);
          }
          return { dom };
        },
      };
    },
    { hoverTime: 350 },
  );
}

/** Ctrl/⌘ + = / − / 0 change the editor font size while the editor has the focus. */
export function fontKeys(change: (delta: number | "reset") => void): Extension {
  const run = (d: number | "reset") => () => (change(d), true);
  return Prec.high(
    keymap.of([
      { key: "Mod-=", run: run(1) },
      { key: "Mod-+", run: run(1) },
      { key: "Mod--", run: run(-1) },
      { key: "Mod-0", run: run("reset") },
    ]),
  );
}

/** Select a line, scroll it into view and focus the editor. */
export function jumpToLine(view: EditorView, lineNo: number) {
  const doc = view.state.doc;
  if (lineNo < 1 || lineNo > doc.lines) return;
  const line = doc.line(lineNo);
  view.dispatch({ selection: EditorSelection.single(line.from, line.to), scrollIntoView: true });
  view.focus();
}
