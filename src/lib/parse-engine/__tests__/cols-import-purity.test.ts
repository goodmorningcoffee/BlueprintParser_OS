// @vitest-environment node
// [table pipeline WP-3.B, E-8 / C1-D16] cells.ts, headers.ts and types-cols.ts are client-safe: each imports
// only modules of the client-safe subset (`client-safe-imports.test.ts` CLIENT_SAFE, which already lists
// `cells` and `headers`; `types-cols` is checked here so that shared list needs no parallel edit), and
// headers.ts never reaches classifier-engine/derive-name (the title band is server-side, title.ts).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const ENGINE = join(process.cwd(), "src/lib/parse-engine");
const ALLOWED: Record<string, readonly string[]> = {
  cells: ["./geometry", "./lines", "./types"],
  headers: ["./cells", "./types"],
  "types-cols": ["./types", "./cells", "./headers"],
};
const importsOf = (mod: string): string[] =>
  ts.preProcessFile(readFileSync(join(ENGINE, `${mod}.ts`), "utf8"), true, true).importedFiles.map((f) => f.fileName);

describe("WP-3.B client-safe modules (E-8)", () => {
  for (const [mod, allowed] of Object.entries(ALLOWED)) {
    it(`${mod} imports only ${allowed.join(", ")}`, () => {
      expect(importsOf(mod).filter((s) => !allowed.includes(s))).toEqual([]);
    });
  }
  it("headers never imports derive-name or any classifier-engine module", () => {
    expect(importsOf("headers").filter((s) => /derive-name|classifier-engine/.test(s))).toEqual([]);
  });
});
