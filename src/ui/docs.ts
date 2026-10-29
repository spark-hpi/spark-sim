// The help / about dialog: what SPARK Sim is, the way into the tour and the docs, all keyboard shortcuts.
import { brand, VERSION } from "./brand.ts";
import { renderShortcuts } from "./shortcuts.ts";

function el<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, cls?: string) {
  const e = document.createElement(tag);
  if (text !== undefined) e.textContent = text;
  if (cls) e.className = cls;
  return e;
}

export function helpContent(actions: { tour: () => void; docs: () => void }): HTMLElement {
  const root = el("div");
  const lockup = el("div", undefined, "modal-lockup");
  const star = el("span", undefined, "brand-star");
  star.innerHTML = brand.pixelMark(16, 3);
  const word = el("span", "SPARK", "wordmark");
  const sub = el("span", undefined, "brand-sub");
  sub.append(el("b", "SIM"), el("small", `Zumo 2040 · v${VERSION}`));
  lockup.append(star, word, el("span", undefined, "brand-rule"), sub);
  root.append(lockup);
  root.append(
    el("h2", "Train your Zumo before you hold it."),
    el(
      "p",
      "Write the same code you will copy onto the robot. It runs in real MicroPython, against MuJoCo physics with tracks, blade, battery sag and realistic sensor timing. Pick house bots as opponents, run test benches with hundreds of matches, scrub through every moment and download your code when it is ready.",
    ),
  );
  const acts = el("div", undefined, "modal-actions");
  const docs = el("button", "Open the docs — start with “Your first program”", "btn primary");
  docs.onclick = actions.docs;
  const tour = el("button", "Take the guided tour", "btn");
  tour.onclick = actions.tour;
  acts.append(docs, tour);
  root.append(acts);
  root.append(el("h3", "Keyboard shortcuts"), renderShortcuts());
  root.append(
    el(
      "div",
      "MuJoCo (Google DeepMind) · MicroPython (Damien George et al.) · Pololu zumo-2040-robot library (MIT) · Departure Mono (Helena Zhang, OFL) · JetBrains Mono (OFL) · EB Garamond (OFL) · SPARK community, HPI",
      "credits",
    ),
  );
  return root;
}
