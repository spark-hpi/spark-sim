// Sound: the robots' buzzers (square wave, like the piezo) and short referee cues for match events
// (sine/triangle, so they are easy to tell apart from the robots).
export type Cue = "out" | "end" | "lap" | "point" | "signal" | "go";

const BUZZER_MAX = 0.15; // gain at full buzzer volume (V15)
const CUE_GAIN = 0.12;

export class Buzzers {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private level = 0.7;
  private voices = new Map<number, { osc: OscillatorNode; gain: GainNode }>();
  muted = false;

  constructor() {
    // browsers only allow audio after a user gesture (Safari: only when resumed inside the gesture itself)
    const unlock = () => this.unlock();
    for (const type of ["pointerdown", "keydown", "touchend"]) window.addEventListener(type, unlock, { capture: true });
  }

  /** Create or resume the audio context; call from a user gesture. */
  unlock() {
    if (!this.ctx) {
      try {
        this.ctx = new AudioContext();
        this.master = this.ctx.createGain();
        this.master.gain.value = this.level;
        this.master.connect(this.ctx.destination);
      } catch {
        return;
      }
    }
    if (this.ctx.state === "suspended") void this.ctx.resume();
  }

  private audio(): AudioContext | null {
    this.unlock();
    return this.ctx && this.ctx.state !== "closed" ? this.ctx : null;
  }

  /** master volume 0..1 (Settings) */
  set volume(v: number) {
    this.level = Math.max(0, Math.min(1, v));
    if (this.master && this.ctx) this.master.gain.setTargetAtTime(this.level, this.ctx.currentTime, 0.02);
  }

  /** notes: [frequency, duration ms (-1 = continuous), volume 0..128], empty = off. speed = sim speed */
  play(slot: number, notes: [number, number, number][], speed: number) {
    this.stop(slot);
    if (this.muted || !notes.length || speed <= 0 || !isFinite(speed)) return;
    const ctx = this.audio();
    if (!ctx) return;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "square";
    osc.connect(gain).connect(this.master ?? ctx.destination);
    let t = ctx.currentTime + 0.01;
    gain.gain.setValueAtTime(0, t);
    for (const [f, ms, vol] of notes) {
      // the library's volume steps are PWM duty values (V15 = 128, V12 = 32, V8 = 10): perceived loudness
      // grows much slower, so map through a square root
      const v = f > 0 ? BUZZER_MAX * Math.sqrt(Math.min(1, Math.max(0, vol / 128))) : 0;
      if (f > 0) osc.frequency.setValueAtTime(f, t);
      gain.gain.setValueAtTime(v, t);
      if (ms < 0) break;
      t += ms / 1000 / speed;
    }
    if (notes[notes.length - 1][1] >= 0) gain.gain.setValueAtTime(0, t);
    osc.start();
    if (notes[notes.length - 1][1] >= 0) osc.stop(t + 0.02);
    this.voices.set(slot, { osc, gain });
  }

  /** A short referee sound for a match event. */
  cue(kind: Cue) {
    if (this.muted) return;
    const ctx = this.audio();
    if (!ctx) return;
    const t0 = ctx.currentTime + 0.01;
    const tone = (type: OscillatorType, f0: number, f1: number, start: number, dur: number) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(f0, t0 + start);
      osc.frequency.exponentialRampToValueAtTime(f1, t0 + start + dur);
      gain.gain.setValueAtTime(0, t0 + start);
      gain.gain.linearRampToValueAtTime(CUE_GAIN, t0 + start + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + start + dur);
      osc.connect(gain).connect(this.master ?? ctx.destination);
      osc.start(t0 + start);
      osc.stop(t0 + start + dur + 0.02);
    };
    switch (kind) {
      case "out": // falling whistle
        tone("triangle", 900, 220, 0, 0.35);
        break;
      case "end": // two rising notes, after the "out" whistle that usually comes at the same moment
        tone("triangle", 784, 784, 0.4, 0.16);
        tone("triangle", 1175, 1175, 0.57, 0.32);
        break;
      case "lap":
      case "point":
        tone("sine", 1320, 1320, 0, 0.09);
        break;
      case "signal": // the referee's start: one low note
        tone("triangle", 523, 523, 0, 0.25);
        break;
      case "go": // high and short
        tone("triangle", 1047, 1047, 0, 0.18);
        break;
    }
  }

  stop(slot: number) {
    const v = this.voices.get(slot);
    if (!v) return;
    try {
      v.osc.stop();
    } catch {
      /* already stopped */
    }
    this.voices.delete(slot);
  }

  stopAll() {
    for (const slot of [...this.voices.keys()]) this.stop(slot);
  }
}
