// @vitest-environment node
// [table pipeline WP-2.E, PLAN §1.3 E-6] Capability version LEDGERS — one file per capability.
//
// `eval/parse-engine/capabilities/<capability>.json` records the module set that implements one
// capability and the sha-256 of that set at every version:
//
//   { "capability": "evidence", "version": 1,
//     "modules": ["src/…/a.ts", …],                       // repo-relative, sorted, unique, must exist
//     "history": [{ "version": 1, "sha256": "<64 hex>" }] }  // versions 1, 2, … ; the last is current
//
// The hash is over the modules' code with comments and formatting removed (TypeScript printer), so a
// comment or whitespace edit never forces a bump; a behaviour edit does. When this test fails with
// "module set changed": bump `CAPABILITY_VERSIONS.<capability>` in src/lib/parse-engine/version.ts and
// APPEND `{ version: <new>, sha256: <printed> }` to the ledger's history (and its "version"). That is a
// counted change, never a rebaseline of an old entry (a LEDGER, not a freeze). A work package that
// lands a capability's FIRST modules lists them and sets the version-1 sha (no bump: nothing was
// stamped with that capability before).
//
// `rows.json` is created by WP-2.C in the same parallel group (PLAN §5 TP-2); until it exists the rows
// capability is not checked here, and once it exists it is checked like every other ledger.

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { CAPABILITY_VERSIONS } from "@/lib/parse-engine/version";
import type { Capability } from "@/lib/parse-engine/types";

const ROOT = process.cwd();
const LEDGER_DIR = join(ROOT, "eval/parse-engine/capabilities");
/** Ledgers another work package of the same group creates (checked only once present). */
const CREATED_ELSEWHERE: ReadonlySet<Capability> = new Set<Capability>(["rows"]);

interface Ledger {
  capability: string;
  version: number;
  modules: string[];
  history: { version: number; sha256: string }[];
}

const printer = ts.createPrinter({ removeComments: true, newLine: ts.NewLineKind.LineFeed });

/** Code without comments or formatting (TS/TSX via the printer; other files: CRLF → LF, trailing space trimmed). */
function normalisedCode(path: string, text: string): string {
  if (/\.(ts|tsx|mts|cts|js|mjs)$/.test(path)) {
    const kind = path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
    return printer.printFile(ts.createSourceFile(path, text, ts.ScriptTarget.Latest, false, kind));
  }
  return text.replace(/\r\n/g, "\n").replace(/[ \t]+$/gm, "");
}

/** sha-256 of a module set: each module's path and normalised-code hash, in path order. */
function moduleSetSha(modules: readonly string[], read: (p: string) => string = (p) => readFileSync(join(ROOT, p), "utf8")): string {
  const lines = [...modules].sort().map((m) => `${m}\0${createHash("sha256").update(normalisedCode(m, read(m))).digest("hex")}`);
  return createHash("sha256").update(lines.join("\n")).digest("hex");
}

function readLedger(cap: string): Ledger {
  return JSON.parse(readFileSync(join(LEDGER_DIR, `${cap}.json`), "utf8")) as Ledger;
}

const capabilities = Object.keys(CAPABILITY_VERSIONS) as Capability[];

describe("parse-engine capability ledgers (E-6)", () => {
  it("one ledger file per capability, and none for an unknown capability", () => {
    const files = existsSync(LEDGER_DIR) ? readdirSync(LEDGER_DIR).filter((f) => f.endsWith(".json")) : [];
    const known = new Set<string>(capabilities);
    expect(files.filter((f) => !known.has(f.replace(/\.json$/, "")))).toEqual([]);
    const missing = capabilities.filter((c) => !CREATED_ELSEWHERE.has(c) && !files.includes(`${c}.json`));
    expect(missing).toEqual([]);
  });

  for (const cap of capabilities) {
    it(`${cap}: the ledger matches its module set and CAPABILITY_VERSIONS`, () => {
      if (!existsSync(join(LEDGER_DIR, `${cap}.json`))) {
        expect(CREATED_ELSEWHERE.has(cap)).toBe(true);
        return;
      }
      const l = readLedger(cap);
      expect(Object.keys(l).sort()).toEqual(["capability", "history", "modules", "version"]);
      expect(l.capability).toBe(cap);
      // modules: sorted, unique, repo-relative, existing
      expect(l.modules).toEqual([...new Set(l.modules)].sort());
      for (const m of l.modules) {
        expect(m.startsWith("src/") || m.startsWith("scripts/"), m).toBe(true);
        expect(existsSync(join(ROOT, m)), `${cap}: module ${m} does not exist`).toBe(true);
      }
      // history: versions 1..n, each a 64-hex sha, consecutive entries differ (a bump needs a change)
      expect(l.history.length).toBeGreaterThan(0);
      l.history.forEach((h, i) => {
        expect(h.version).toBe(i + 1);
        expect(h.sha256).toMatch(/^[0-9a-f]{64}$/);
        if (i > 0) expect(h.sha256, `${cap} v${h.version} repeats v${i}'s sha`).not.toBe(l.history[i - 1].sha256);
      });
      const last = l.history[l.history.length - 1];
      expect(l.version).toBe(last.version);
      expect(CAPABILITY_VERSIONS[cap], `${cap}: CAPABILITY_VERSIONS and the ledger disagree`).toBe(l.version);
      const actual = moduleSetSha(l.modules);
      expect(
        actual,
        `${cap}: module set changed. Bump CAPABILITY_VERSIONS.${cap} to ${l.version + 1} and append ` +
          `{ "version": ${l.version + 1}, "sha256": "${actual}" } to eval/parse-engine/capabilities/${cap}.json`,
      ).toBe(last.sha256);
    });
  }

  it("the hash ignores comments and formatting but not code", () => {
    const files: Record<string, string> = {
      "src/a.ts": "export const x = 1; // one\n",
      "src/b.ts": "/** doc */\nexport function f(a: number) {\n  return a + 1;\n}\n",
    };
    const base = moduleSetSha(Object.keys(files), (p) => files[p]);
    const commented: Record<string, string> = { ...files, "src/a.ts": "// header\nexport const x   =   1;\n" };
    expect(moduleSetSha(Object.keys(commented), (p) => commented[p])).toBe(base);
    const changed: Record<string, string> = { ...files, "src/a.ts": "export const x = 2;\n" };
    expect(moduleSetSha(Object.keys(changed), (p) => changed[p])).not.toBe(base);
    const renamed: Record<string, string> = { "src/c.ts": files["src/a.ts"], "src/b.ts": files["src/b.ts"] };
    expect(moduleSetSha(Object.keys(renamed), (p) => renamed[p])).not.toBe(base);
  });
});
