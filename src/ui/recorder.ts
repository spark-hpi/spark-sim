// Records everything the viewer shows (world frames, displays, LEDs, prints) so any moment can be inspected again.
import type { WorldSnapshot } from "../shared/protocol.ts";

export interface Stamped<T> {
  t: number;
  v: T;
}

const MAX_FRAMES = 60 * 60 * 15; // 15 min at 60 fps

export class Recorder {
  frames: WorldSnapshot[] = [];
  private displays = new Map<number, Stamped<{ hex: string; inverted: boolean }>[]>();
  private leds = new Map<number, Stamped<number[]>[]>();
  private yellow = new Map<number, Stamped<boolean>[]>();
  private prints = new Map<number, Stamped<Record<string, number>>[]>();

  clear() {
    this.frames = [];
    this.displays.clear();
    this.leds.clear();
    this.yellow.clear();
    this.prints.clear();
  }

  get start(): number {
    return this.frames.length ? this.frames[0].t : 0;
  }

  get end(): number {
    return this.frames.length ? this.frames[this.frames.length - 1].t : 0;
  }

  addFrame(s: WorldSnapshot) {
    const last = this.frames[this.frames.length - 1];
    if (last && s.t < last.t) this.clear(); // new world (reset): start over
    if (last && s.t === last.t) this.frames[this.frames.length - 1] = s;
    else this.frames.push(s);
    if (this.frames.length > MAX_FRAMES) this.frames.splice(0, this.frames.length - MAX_FRAMES);
  }

  addDisplay(slot: number, t: number, hex: string, inverted: boolean) {
    push(this.displays, slot, { t, v: { hex, inverted } });
  }

  addLeds(slot: number, t: number, rgb: number[]) {
    push(this.leds, slot, { t, v: rgb });
  }

  addYellow(slot: number, t: number, on: boolean) {
    push(this.yellow, slot, { t, v: on });
  }

  /** numbers printed by a program (plotter), see parsePrint() */
  addPrint(slot: number, t: number, values: Record<string, number>) {
    push(this.prints, slot, { t, v: values });
  }

  printsBetween(slot: number, t0: number, t1: number): Stamped<Record<string, number>>[] {
    const list = this.prints.get(slot) ?? [];
    const i = Math.max(0, lastAtOrBefore(list, t0));
    const out: Stamped<Record<string, number>>[] = [];
    for (let k = i; k < list.length && list[k].t <= t1; k++) out.push(list[k]);
    return out;
  }

  frameAt(t: number): WorldSnapshot | null {
    const i = lastAtOrBefore(this.frames, t);
    return i >= 0 ? this.frames[i] : (this.frames[0] ?? null);
  }

  displayAt(slot: number, t: number) {
    const list = this.displays.get(slot) ?? [];
    const i = lastAtOrBefore(list, t);
    return i >= 0 ? list[i].v : null;
  }

  ledsAt(slot: number, t: number) {
    const list = this.leds.get(slot) ?? [];
    const i = lastAtOrBefore(list, t);
    return i >= 0 ? list[i].v : null;
  }

  yellowAt(slot: number, t: number): boolean {
    const list = this.yellow.get(slot) ?? [];
    const i = lastAtOrBefore(list, t);
    return i >= 0 ? list[i].v : false;
  }
}

function push<T>(m: Map<number, Stamped<T>[]>, slot: number, e: Stamped<T>) {
  let list = m.get(slot);
  if (!list) m.set(slot, (list = []));
  if (list.length && e.t < list[list.length - 1].t) list.length = 0; // new run
  list.push(e);
  if (list.length > 20000) list.splice(0, list.length - 20000);
}

function lastAtOrBefore<T extends { t: number }>(list: T[], t: number): number {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid].t <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo - 1;
}

/**
 * Numbers in a printed line, like Thonny's plotter: the text before each number is its label.
 * "error: 12 correction: -3.5" -> { error: 12, correction: -3.5 }; "12 34" -> { "#1": 12, "#2": 34 }.
 * Returns null for lines without numbers (or tracebacks), so normal output is not plotted.
 */
export function parsePrint(line: string): Record<string, number> | null {
  if (/^(Traceback|\s+File|\w+(Error|Exception))/.test(line)) return null;
  const re = /(-?\d+(?:\.\d+)?(?:[eE]-?\d+)?)/g;
  const out: Record<string, number> = {};
  let last = 0;
  let n = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line)) !== null) {
    // digits inside a word (e.g. "DN1") belong to the label of the next number
    if (m.index > 0 && /[A-Za-z_]/.test(line[m.index - 1])) continue;
    const label = line.slice(last, m.index).replace(/[:=,;()[\]]/g, " ").trim().split(/\s+/).slice(-2).join(" ");
    out[label || `#${n + 1}`] = Number(m[1]);
    last = m.index + m[0].length;
    if (++n > 8) return null;
  }
  return n ? out : null;
}
