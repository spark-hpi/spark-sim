// Docs viewer: sidebar with groups and pages, full-text search over pages and the robot API, pages rendered from
// the structured content in docs-content.ts (paragraphs with light inline markup, code with "insert into editor",
// notes, tables, API reference blocks from api.ts).
import { pythonLanguage } from "@codemirror/lang-python";
import { classHighlighter, highlightCode } from "@lezer/highlight";
import { ROBOT_API, TIME_API, type ApiClass, type ApiMember } from "./api.ts";
import { renderShortcuts } from "./shortcuts.ts";

export type DocBlock =
  | { p: string }
  | { h: string; id?: string }
  | { list: string[]; ordered?: boolean }
  | { code: string; title?: string; insert?: boolean }
  | { note: string; kind?: "tip" | "warn" | "info" }
  | { table: { head: string[]; rows: string[][] } }
  | { api: string }
  | { shortcuts: true };

export interface DocPage {
  id: string;
  group: string;
  title: string;
  summary: string;
  blocks: DocBlock[];
}

export interface DocsHost {
  /** insert code at the cursor of the robot that is open in the editor; returns a message for the user */
  insert(code: string): string;
  /** replace the program of the robot that is open in the editor (undo brings it back) */
  replace(code: string): string;
  remember(page: string): void;
}

type Extra = Partial<{ example: string; returns: string; timing: string; params: [string, string][] }>;

const h = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

// ---------------------------------------------------------------- inline markup: `code`, **bold**, *em*, [text](href)
const INLINE = /`([^`]+)`|\*\*([^*]+)\*\*|\*([^*\s][^*]*)\*|\[([^\]]+)\]\(([^)\s]+)\)/g;

export function inline(text: string, open: (href: string) => void): DocumentFragment {
  const frag = document.createDocumentFragment();
  let last = 0;
  for (const m of text.matchAll(INLINE)) {
    if (m.index! > last) frag.append(text.slice(last, m.index));
    if (m[1] !== undefined) frag.append(h("code", undefined, m[1]));
    else if (m[2] !== undefined) frag.append(h("strong", undefined, m[2]));
    else if (m[3] !== undefined) frag.append(h("em", undefined, m[3]));
    else {
      const a = h("a", undefined, m[4]);
      const href = m[5];
      a.href = href.startsWith("doc:") ? `#${href}` : href;
      if (href.startsWith("doc:")) {
        a.onclick = (e) => {
          e.preventDefault();
          open(href);
        };
      } else {
        a.target = "_blank";
        a.rel = "noopener";
      }
      frag.append(a);
    }
    last = m.index! + m[0].length;
  }
  if (last < text.length) frag.append(text.slice(last));
  return frag;
}

const plain = (text: string) => text.replace(INLINE, (_, c, b, e, t) => c ?? b ?? e ?? t ?? "");

export function highlightPython(code: string): HTMLElement {
  const out = h("code");
  const tree = pythonLanguage.parser.parse(code);
  highlightCode(
    code,
    tree,
    classHighlighter,
    (text, classes) => out.append(classes ? Object.assign(h("span", classes), { textContent: text }) : document.createTextNode(text)),
    () => out.append("\n"),
  );
  return out;
}

// ---------------------------------------------------------------- the viewer
interface Hit {
  page: DocPage;
  anchor?: string;
  title: string;
  text: string;
  score: number;
}

export class DocsView {
  private nav = h("nav", "docs-nav");
  private results = h("div", "docs-results");
  private main = h("div", "docs-main");
  private select = h("select", "docs-select");
  private input = h("input");
  private current: DocPage | null = null;
  private index: { page: DocPage; anchor?: string; title: string; body: string; summary: string }[] = [];
  private apiPage = new Map<string, string>();

  constructor(
    root: HTMLElement,
    private pages: DocPage[],
    private host: DocsHost,
  ) {
    root.replaceChildren();
    const wrap = h("div", "docs-wrap");
    const side = h("div", "docs-side");
    const search = h("div", "docs-search");
    this.input.type = "search";
    this.input.placeholder = "Search the docs  ( / )";
    this.input.setAttribute("aria-label", "Search the docs");
    this.input.spellcheck = false;
    search.append(this.input);
    this.select.setAttribute("aria-label", "Docs page");
    side.append(search, this.select, this.nav, this.results);
    this.results.hidden = true;
    wrap.append(side, this.main);
    root.append(wrap);

    this.buildNav();
    this.buildIndex();
    this.input.addEventListener("input", () => this.search(this.input.value));
    this.input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        const first = this.results.querySelector<HTMLAnchorElement>("a");
        first?.click();
      } else if (e.key === "Escape") {
        this.input.value = "";
        this.search("");
      }
    });
    this.select.onchange = () => this.open(this.select.value);
    if (!pages.length) this.main.append(h("p", "docs-empty", "The docs are not available."));
  }

  get pageIds() {
    return this.pages.map((p) => p.id);
  }

  focusSearch() {
    this.input.focus();
    this.input.select();
  }

  /** href: "doc:page", "doc:page#anchor", "page" or "page#anchor" */
  open(href: string) {
    const [id, anchor] = href.replace(/^doc:/, "").split("#");
    const page = this.pages.find((p) => p.id === id) ?? this.pages[0];
    if (!page) return;
    if (this.current !== page) this.render(page);
    this.host.remember(page.id);
    requestAnimationFrame(() => {
      const target = anchor ? this.main.querySelector(`#${CSS.escape(this.anchorId(page.id, anchor))}`) : null;
      if (target) {
        target.scrollIntoView({ block: "start" });
        target.classList.add("flash");
        setTimeout(() => target.classList.remove("flash"), 1200);
      } else this.main.scrollTop = 0;
    });
  }

  /** open the reference of an API class (and member) */
  openApi(cls: string, member?: string) {
    // ButtonB and ButtonC are documented together with ButtonA
    const c = cls === "ButtonB" || cls === "ButtonC" ? "ButtonA" : cls;
    const page = this.apiPage.get(c);
    if (page) this.open(member ? `${page}#api-${c}-${member}` : page);
  }

  hasApiPage(cls: string) {
    return this.apiPage.has(cls === "ButtonB" || cls === "ButtonC" ? "ButtonA" : cls);
  }

  private anchorId(page: string, anchor: string) {
    return anchor.startsWith("api-") ? anchor : `doc-${page}-${anchor}`;
  }

  // ---------------------------------------------------------------- navigation and search
  private buildNav() {
    this.nav.replaceChildren();
    this.select.replaceChildren();
    let group = "";
    let og: HTMLOptGroupElement | null = null;
    for (const p of this.pages) {
      if (p.group !== group) {
        group = p.group;
        this.nav.append(h("h4", undefined, group));
        og = h("optgroup");
        og.label = group;
        this.select.append(og);
      }
      const a = h("a", undefined, p.title);
      a.href = `#doc:${p.id}`;
      a.dataset.page = p.id;
      a.title = p.summary;
      a.onclick = (e) => {
        e.preventDefault();
        this.open(p.id);
      };
      this.nav.append(a);
      og!.append(new Option(p.title, p.id));
      for (const b of p.blocks) if ("api" in b) this.apiPage.set(b.api, p.id);
    }
  }

  private buildIndex() {
    for (const page of this.pages) {
      const body: string[] = [];
      for (const b of page.blocks) {
        if ("p" in b) body.push(plain(b.p));
        else if ("h" in b) {
          this.index.push({ page, anchor: b.id, title: `${page.title} › ${b.h}`, body: "", summary: page.summary });
          body.push(b.h);
        } else if ("list" in b) body.push(...b.list.map(plain));
        else if ("code" in b) body.push(b.code);
        else if ("note" in b) body.push(plain(b.note));
        else if ("table" in b) body.push(...b.table.rows.flat().map(plain));
      }
      this.index.push({ page, title: page.title, body: body.join(" "), summary: page.summary });
    }
    for (const c of [...ROBOT_API, { name: "time", ctor: "import time", doc: "", members: TIME_API } as ApiClass]) {
      const page = this.pages.find((p) => p.id === this.apiPage.get(c.name));
      if (!page) continue;
      for (const m of c.members) {
        this.index.push({ page, anchor: `api-${c.name}-${m.name}`, title: `${c.name === "time" ? "time" : c.name}.${m.name}`, body: `${m.sig} ${m.doc}`, summary: m.doc || m.sig });
      }
    }
  }

  private search(q: string) {
    const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
    const searching = terms.length > 0;
    this.nav.hidden = searching;
    this.results.hidden = !searching;
    if (!searching) return;
    const hits: Hit[] = [];
    for (const e of this.index) {
      const title = e.title.toLowerCase();
      const all = `${title} ${e.summary.toLowerCase()} ${e.body.toLowerCase()}`;
      if (!terms.every((t) => all.includes(t))) continue;
      let score = 0;
      for (const t of terms) {
        if (title.includes(t)) score += title.startsWith(t) ? 6 : 4;
        if (e.summary.toLowerCase().includes(t)) score += 2;
        score += Math.min(3, e.body.toLowerCase().split(t).length - 1) * 0.5;
      }
      const at = e.body.toLowerCase().indexOf(terms[0]);
      const text = at >= 0 ? `…${e.body.slice(Math.max(0, at - 40), at + 90)}…` : e.summary;
      hits.push({ page: e.page, anchor: e.anchor, title: e.title, text, score });
    }
    hits.sort((a, b) => b.score - a.score);
    this.results.replaceChildren();
    if (!hits.length) this.results.append(h("div", "docs-empty", "Nothing found. Try fewer or other words."));
    for (const hit of hits.slice(0, 40)) {
      const a = h("a");
      a.href = "#";
      a.append(h("b", undefined, hit.title), h("small", undefined, hit.text.replace(/\s+/g, " ")));
      a.onclick = (ev) => {
        ev.preventDefault();
        this.open(hit.anchor ? `${hit.page.id}#${hit.anchor}` : hit.page.id);
      };
      this.results.append(a);
    }
  }

  // ---------------------------------------------------------------- rendering a page
  private render(page: DocPage) {
    this.current = page;
    this.nav.querySelectorAll("a").forEach((a) => a.classList.toggle("on", a.dataset.page === page.id));
    this.nav.querySelector(".on")?.scrollIntoView({ block: "nearest" });
    this.select.value = page.id;
    const art = h("article", "docs-page");
    const go = (href: string) => this.open(href);
    art.append(h("div", "crumb", page.group), h("h1", undefined, page.title), h("p", "summary", page.summary));
    for (const b of page.blocks) art.append(this.block(page, b, go));
    // previous / next
    const i = this.pages.indexOf(page);
    const pager = h("div", "docs-pager");
    const link = (p: DocPage | undefined, label: string) => {
      if (!p) return h("span");
      const a = h("a", undefined, label.replace("%", p.title));
      a.href = `#doc:${p.id}`;
      a.onclick = (e) => {
        e.preventDefault();
        this.open(p.id);
      };
      return a;
    };
    pager.append(link(this.pages[i - 1], "← %"), link(this.pages[i + 1], "% →"));
    art.append(pager);
    this.main.replaceChildren(art);
  }

  private block(page: DocPage, b: DocBlock, go: (href: string) => void): Node {
    if ("p" in b) {
      const p = h("p");
      p.append(inline(b.p, go));
      return p;
    }
    if ("h" in b) {
      const e = h("h3", undefined, b.h);
      if (b.id) e.id = this.anchorId(page.id, b.id);
      return e;
    }
    if ("list" in b) {
      const l = h(b.ordered ? "ol" : "ul");
      for (const item of b.list) {
        const li = h("li");
        li.append(inline(item, go));
        l.append(li);
      }
      return l;
    }
    if ("code" in b) return this.codeBlock(b.code, b.title, b.insert);
    if ("note" in b) {
      const n = h("div", `docs-note ${b.kind ?? "info"}`);
      const p = h("div");
      p.append(inline(b.note, go));
      n.append(p);
      return n;
    }
    if ("table" in b) {
      const t = h("table");
      const tr = h("tr");
      for (const c of b.table.head) tr.append(h("th", undefined, c));
      t.append(h("thead"), h("tbody"));
      t.tHead!.append(tr);
      for (const row of b.table.rows) {
        const r = h("tr");
        for (const c of row) {
          const td = h("td");
          td.append(inline(c, go));
          r.append(td);
        }
        t.tBodies[0].append(r);
      }
      const wrap = h("div");
      wrap.style.overflowX = "auto";
      wrap.append(t);
      return wrap;
    }
    if ("api" in b) return this.apiBlock(b.api, go);
    if ("shortcuts" in b) return renderShortcuts();
    return document.createTextNode("");
  }

  private codeBlock(code: string, title?: string, insert?: boolean): HTMLElement {
    const box = h("div", "docs-code");
    const head = h("div", "docs-code-head");
    head.append(h("span", undefined, title ?? "MicroPython"));
    const copy = h("button", undefined, "Copy");
    copy.title = "Copy to the clipboard";
    copy.onclick = async () => {
      try {
        await navigator.clipboard.writeText(code);
        copy.textContent = "Copied";
      } catch {
        copy.textContent = "Select it";
      }
      setTimeout(() => (copy.textContent = "Copy"), 1500);
    };
    head.append(copy);
    if (insert) {
      // a complete program replaces the code (Ctrl/⌘+Z brings the old one back); a fragment goes to the cursor
      const full = /^(from|import)\s+zumo_2040_robot/m.test(code);
      const label = full ? "Use as my program" : "Insert at cursor";
      const ins = h("button", undefined, label);
      ins.title = full
        ? "Replace the program of the robot open in the editor with this one (Ctrl/⌘+Z in the editor brings yours back)"
        : "Insert at the cursor of the robot open in the editor";
      ins.onclick = () => {
        const text = code.replace(/\n$/, "") + "\n";
        ins.textContent = full ? this.host.replace(text) : this.host.insert(text);
        setTimeout(() => (ins.textContent = label), 2400);
      };
      head.append(ins);
    }
    const pre = h("pre");
    pre.append(highlightPython(code.replace(/\n$/, "")));
    box.append(head, pre);
    return box;
  }

  private apiBlock(name: string, go: (href: string) => void): HTMLElement {
    const box = h("div", "api-class");
    const cls: (ApiClass & Extra) | undefined =
      name === "time" ? { name: "time", ctor: "import time", doc: "", members: TIME_API } : (ROBOT_API.find((c) => c.name === name) as (ApiClass & Extra) | undefined);
    if (!cls) {
      box.append(h("p", "docs-empty", `No reference for ${name}.`));
      return box;
    }
    box.append(h("div", "ctor", cls.ctor));
    if (cls.doc) {
      const p = h("p");
      p.append(inline(cls.doc, go));
      box.append(p);
    }
    if (cls.example) box.append(this.codeBlock(cls.example, `${cls.name} example`, true));
    for (const m of cls.members as (ApiMember & Extra)[]) {
      const row = h("div", "api-member");
      row.id = `api-${cls.name}-${m.name}`;
      const sig = h("div", "sig", `${cls.name === "time" ? "time." : ""}${m.sig}`);
      row.append(sig);
      if (m.doc) {
        const p = h("div");
        p.append(inline(m.doc, go));
        row.append(p);
      }
      if (m.params?.length) {
        const dl = h("dl");
        for (const [k, v] of m.params) {
          const dd = h("dd");
          dd.append(inline(v, go));
          dl.append(h("dt", undefined, k), dd);
        }
        row.append(dl);
      }
      const facts = h("div", "facts");
      if (m.returns) facts.append(h("span", undefined, `returns ${m.returns}`));
      if (m.timing) facts.append(h("span", undefined, `takes ${m.timing}`));
      if (m.kind && m.kind !== "method") facts.append(h("span", undefined, m.kind));
      if (facts.childElementCount) row.append(facts);
      if (m.example) row.append(this.codeBlock(m.example, `${m.name} example`, true));
      box.append(row);
    }
    return box;
  }
}
