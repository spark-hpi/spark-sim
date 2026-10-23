// Library of house bots and examples. Every .py file under src/bots/<category>/ is picked up automatically;
// its header comment (# Name:, # Strategy:, # Strengths / weaknesses:, # Tests:, # Arena:, # Difficulty:)
// becomes the description in the UI. In the practice build the house bots are swapped for an empty
// module at build time (see virtual:spark-house-bots in vite.config.ts), so their source is not shipped.
import { houseBots } from "virtual:spark-house-bots";

export interface BotInfo {
  id: string;
  name: string;
  category: string;
  strategy: string;
  strengths: string;
  tests: string;
  arena: string;
  difficulty: number;
  code: string;
}

const examples = import.meta.glob("../examples/*.py", { query: "?raw", import: "default", eager: true }) as Record<string, string>;

const FIELDS: Record<string, keyof BotInfo> = {
  name: "name",
  strategy: "strategy",
  "strengths / weaknesses": "strengths",
  strengths: "strengths",
  tests: "tests",
  arena: "arena",
  difficulty: "difficulty",
};

function parse(id: string, category: string, code: string): BotInfo {
  const info: Record<string, string> = {};
  let current: string | null = null;
  for (const raw of code.split("\n")) {
    if (!raw.startsWith("#")) break;
    const line = raw.replace(/^#\s?/, "");
    const m = line.match(/^([A-Za-z /]+):\s*(.*)$/);
    const key = m ? FIELDS[m[1].trim().toLowerCase()] : undefined;
    if (m && key) {
      current = key;
      info[key] = m[2].trim();
    } else if (current && line.trim()) {
      info[current] += " " + line.trim();
    } else if (!line.trim()) {
      current = null;
    }
  }
  const file = id.split("/").pop()!.replace(/\.py$/, "");
  const firstComment = code.split("\n")[0].replace(/^#\s?/, "");
  return {
    id,
    name: info.name || file.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
    category,
    strategy: info.strategy || (category === "examples" ? firstComment : ""),
    strengths: info.strengths || "",
    tests: info.tests || "",
    arena: (info.arena || "").split(/[ ,(]/)[0],
    difficulty: Number(info.difficulty) || 0,
    code,
  };
}

export const BOTS: BotInfo[] = [
  ...Object.entries(examples).map(([p, code]) => parse(`examples/${p.split("/").pop()}`, "examples", code)),
  ...Object.entries(houseBots).map(([p, code]) => {
    // keys look like "/overlay/bots/<category>/<file>.py"
    const parts = p.split("/");
    const category = parts[parts.length - 2];
    return parse(`${category}/${parts[parts.length - 1]}`, category, code);
  }),
].sort((a, b) => a.category.localeCompare(b.category) || a.difficulty - b.difficulty || a.name.localeCompare(b.name));

export const BOT_BY_ID: Record<string, BotInfo> = Object.fromEntries(BOTS.map((b) => [b.id, b]));

export const CATEGORY_LABEL: Record<string, string> = {
  examples: "Examples (start here)",
  sumo: "Sumo house bots",
  line: "Line / race bots",
  koth: "King of the Hill bots",
  shuttle: "Shuttle bots",
};

/** Suggested opponent per arena mode (the easiest registered bot of the matching category), used when
 *  switching arenas. Which bots exist is decided by whatever is registered, not hard-coded here. */
export function defaultBotFor(mode: string): string | null {
  return BOTS.find((b) => b.category === mode)?.id ?? null;
}
