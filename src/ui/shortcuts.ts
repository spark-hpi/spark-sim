// Keyboard shortcuts: one list for the help dialog and the docs.

export const SHORTCUTS: { group: string; keys: [string, string][] }[] = [
  {
    group: "Match",
    keys: [
      ["Space", "run / stop (outside the editor; after a click into the docs or the test bench it scrolls them)"],
      ["Ctrl/⌘ + Enter", "run (also in the editor)"],
      ["Ctrl/⌘ + .", "stop"],
      ["S", "start signal: button A on every robot, 5 s countdown (starts a match if none runs)"],
      ["R", "reset: the robots back to their start positions (also those moved by hand)"],
      ["A · B · C", "hold the selected robot's button"],
      ["1 – 4", "select a robot"],
    ],
  },
  {
    group: "View and timeline",
    keys: [
      ["V", "sensor view on / off"],
      ["← · →", "step through the recording (hold to keep going)"],
      ["L", "back to live"],
      ["F", "3D view full size (again: back)"],
      ["Esc", "leave full size · close dialogs and menus"],
    ],
  },
  {
    group: "Workspace",
    keys: [
      ["D", "show / hide the bottom panel (console · telemetry · bench · docs)"],
      ["I", "show / hide the inspector"],
      ["F1", "open the docs"],
      ["/", "search the docs (when they are open)"],
      ["?", "help"],
    ],
  },
  {
    group: "Editor",
    keys: [
      ["Ctrl/⌘ + Space", "autocomplete (also after typing a dot)"],
      ["Ctrl/⌘ + F", "search and replace"],
      ["Ctrl/⌘ + /", "comment / uncomment lines"],
      ["Ctrl/⌘ + = · −", "larger / smaller font"],
      ["Ctrl/⌘ + Z · Shift + Z", "undo / redo"],
      ["Tab · Shift + Tab", "indent / outdent the selection"],
    ],
  },
];

export function renderShortcuts(): HTMLElement {
  const box = document.createElement("div");
  box.className = "keys";
  for (const g of SHORTCUTS) {
    const h = document.createElement("h5");
    h.textContent = g.group;
    box.append(h);
    for (const [k, v] of g.keys) {
      const key = document.createElement("span");
      key.append(...k.split(/( \+ | · | – )/).map((part) => (/^( \+ | · | – )$/.test(part) ? document.createTextNode(part) : Object.assign(document.createElement("kbd"), { textContent: part }))));
      const what = document.createElement("span");
      what.textContent = v;
      box.append(key, what);
    }
  }
  return box;
}
