import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { HELP_TOOLTIPS } from "@/data/help-tooltips";

// Help Mode shows nothing for a `<HelpTooltip id>` with no entry, and an entry with no wrapper is
// dead text that reads as documentation. Keep the catalogue and the components in lockstep.
//
// Ids must be string literals so this file can see them. The one sanctioned exception is TextPanel's
// tab bar (`id={\`text-tab-${t}\`}` over a fixed tab union), expanded by hand below — add to
// TEMPLATE_IDS if another wrapper needs a computed id, never widen the regex.

const COMPONENT_ROOT = path.resolve(process.cwd(), "src/components");
const TEMPLATE_IDS: Record<string, string[]> = {
  "src/components/viewer/TextPanel.tsx": ["ocr", "annotations", "markups", "graph", "textract"].map((t) => `text-tab-${t}`),
};

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "__tests__") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith(".tsx")) out.push(full);
  }
  return out;
}

type Scan = { used: Map<string, string[]>; nonLiteral: string[] };

function scanWrappers(): Scan {
  const used = new Map<string, string[]>();
  const nonLiteral: string[] = [];
  for (const file of walk(COMPONENT_ROOT)) {
    const source = readFileSync(file, "utf8");
    const rel = path.relative(process.cwd(), file).split(path.sep).join("/");
    const add = (id: string) => used.set(id, [...(used.get(id) ?? []), rel]);
    for (const tag of source.matchAll(/<HelpTooltip\b([^>]*)>/gu)) {
      const attrs = tag[1];
      const literal = /\bid="([^"]+)"/u.exec(attrs);
      if (literal) {
        add(literal[1]);
      } else if (TEMPLATE_IDS[rel]) {
        for (const id of TEMPLATE_IDS[rel]) add(id);
      } else {
        nonLiteral.push(`${rel}: <HelpTooltip${attrs}>`);
      }
    }
  }
  return { used, nonLiteral };
}

describe("help tooltips", () => {
  let scan: Scan;
  beforeAll(() => {
    scan = scanWrappers();
  });

  it("every HelpTooltip id is a string literal (or listed in TEMPLATE_IDS)", () => {
    expect(scan.nonLiteral).toEqual([]);
  });

  it("every HelpTooltip wrapper under src/components has an entry", () => {
    const missing = [...scan.used.keys()].filter((id) => !(id in HELP_TOOLTIPS));
    expect(missing.map((id) => `${id} (${scan.used.get(id)})`)).toEqual([]);
  });

  it("every entry is wrapped by at least one component", () => {
    const orphans = Object.keys(HELP_TOOLTIPS).filter((id) => !scan.used.has(id));
    expect(orphans).toEqual([]);
  });

  it("every entry has a non-empty title and body", () => {
    for (const [id, entry] of Object.entries(HELP_TOOLTIPS)) {
      expect(entry.title.trim(), id).not.toBe("");
      expect(entry.body.trim(), id).not.toBe("");
    }
  });
});
