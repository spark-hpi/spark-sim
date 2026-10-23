// Guided tour: highlights one part of the screen at a time with a short explanation.

export interface TourStep {
  /** CSS selector of the element to highlight; none = a centred card */
  target?: string;
  title: string;
  text: string;
  /** called before the step is shown (e.g. open a panel) */
  before?: () => void;
}

export function runTour(steps: TourStep[], done: () => void) {
  let i = 0;
  const hole = document.createElement("div");
  hole.className = "tour-hole";
  const card = document.createElement("div");
  card.className = "tour-card";
  card.setAttribute("role", "dialog");
  card.setAttribute("aria-live", "polite");
  document.body.append(hole, card);

  const finish = () => {
    hole.remove();
    card.remove();
    window.removeEventListener("keydown", onKey, true);
    window.removeEventListener("resize", place);
    done();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      finish();
    } else if (e.key === "ArrowRight" || e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      go(i + 1);
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      e.stopPropagation();
      go(i - 1);
    }
  };

  function place() {
    const step = steps[i];
    const el = step.target ? document.querySelector<HTMLElement>(step.target) : null;
    const r = el && el.offsetParent !== null ? el.getBoundingClientRect() : null;
    const pad = 6;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    if (r && r.width > 0) {
      Object.assign(hole.style, { display: "", left: `${r.left - pad}px`, top: `${r.top - pad}px`, width: `${r.width + 2 * pad}px`, height: `${r.height + 2 * pad}px` });
      const cw = card.offsetWidth;
      const ch = card.offsetHeight;
      // beside the target if there is room, else below or above it
      let left = r.right + 18;
      let top = Math.min(Math.max(12, r.top), vh - ch - 12);
      if (left + cw > vw - 12) left = r.left - cw - 18;
      if (left < 12) {
        left = Math.min(Math.max(12, r.left), vw - cw - 12);
        top = r.bottom + 18 + ch < vh ? r.bottom + 18 : Math.max(12, r.top - ch - 18);
      }
      Object.assign(card.style, { left: `${left}px`, top: `${top}px` });
    } else {
      Object.assign(hole.style, { display: "", left: `${vw / 2}px`, top: `${vh / 2}px`, width: "0px", height: "0px" });
      Object.assign(card.style, { left: `${(vw - card.offsetWidth) / 2}px`, top: `${(vh - card.offsetHeight) / 2}px` });
    }
  }

  function go(n: number) {
    if (n < 0) return;
    if (n >= steps.length) return finish();
    i = n;
    const step = steps[i];
    step.before?.();
    card.replaceChildren();
    const h = document.createElement("h4");
    h.textContent = step.title;
    const p = document.createElement("p");
    p.textContent = step.text;
    const foot = document.createElement("div");
    foot.className = "tour-foot";
    const count = document.createElement("span");
    count.className = "count";
    count.textContent = `${i + 1} / ${steps.length}`;
    const skip = Object.assign(document.createElement("button"), { className: "link-btn", textContent: i === steps.length - 1 ? "" : "Skip" });
    skip.onclick = finish;
    const back = Object.assign(document.createElement("button"), { className: "btn", textContent: "Back" });
    back.disabled = i === 0;
    back.onclick = () => go(i - 1);
    const next = Object.assign(document.createElement("button"), { className: "btn primary", textContent: i === steps.length - 1 ? "Let's go" : "Next" });
    next.onclick = () => go(i + 1);
    foot.append(count, skip, back, next);
    card.append(h, p, foot);
    requestAnimationFrame(() => {
      place();
      next.focus();
    });
  }

  window.addEventListener("keydown", onKey, true);
  window.addEventListener("resize", place);
  go(0);
}
