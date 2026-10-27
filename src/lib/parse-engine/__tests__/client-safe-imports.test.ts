// @vitest-environment node
// [table pipeline WP-2.0b, E-8 / C1-D16] Client-safe import purity of the parse engine.
//
// The client-safe subset below is bundled into the viewer, so each of its modules may import only
// other members of the subset (which includes `types`). No `@/` alias, no package, no server
// module, no dynamic import or require. `headers.ts` in particular never reaches
// `classifier-engine/derive-name`; the printed-title band is computed server-side.
//
// The list grows as modules land (WP-2.E, 2.D1, 3.B, 3.C, 3.D, 3.H, …). A listed module that does
// not exist yet is skipped; the two that WP-2.0b lands (`lines`, `geometry`) must exist.
// Imports are read with the TypeScript pre-processor, so comments and strings never count.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, normalize, relative } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const ENGINE_DIR = join(process.cwd(), "src/lib/parse-engine");

const CLIENT_SAFE = [
  "types",
  "lines",
  "geometry",
  "cells",
  "headers",
  "ops",
  "legacy-view",
  "snapshot",
  "read",
  "tag-key",
  "paragraphs/keys",
  "paragraphs/address",
] as const;

const MUST_EXIST = ["types", "lines", "geometry", "ops"] as const; // + types, ops: WP-2.E (2.0b VERIFY LOW-4)

function sourceFile(mod: string): string | null {
  for (const ext of [".ts", ".tsx"]) {
    const p = join(ENGINE_DIR, `${mod}${ext}`);
    if (existsSync(p)) return p;
  }
  return null;
}

function importsOf(file: string): string[] {
  const info = ts.preProcessFile(readFileSync(file, "utf8"), true, true);
  return info.importedFiles.map((f) => f.fileName);
}

/** The client-safe module an import resolves to, or null when it leaves the subset. */
function resolveInSubset(fromFile: string, spec: string): string | null {
  if (!spec.startsWith("./") && !spec.startsWith("../")) return null;
  const target = normalize(join(dirname(fromFile), spec)).replace(/\.(ts|tsx|js)$/, "");
  const rel = relative(ENGINE_DIR, target).split("\\").join("/");
  if (rel.startsWith("..")) return null;
  return (CLIENT_SAFE as readonly string[]).includes(rel) ? rel : null;
}

describe("parse-engine client-safe import purity (E-8)", () => {
  it("the modules this release lands exist", () => {
    for (const mod of MUST_EXIST) expect(sourceFile(mod), mod).not.toBeNull();
  });

  for (const mod of CLIENT_SAFE) {
    it(`${mod} imports only the client-safe subset`, () => {
      const file = sourceFile(mod);
      if (!file) return; // lands in a later work package
      const outside = importsOf(file).filter((spec) => resolveInSubset(file, spec) === null);
      expect(outside).toEqual([]);
    });
  }

  it("headers never imports classifier-engine/derive-name", () => {
    const file = sourceFile("headers");
    if (!file) return;
    expect(importsOf(file).filter((spec) => spec.includes("derive-name"))).toEqual([]);
  });

  it("the checker rejects what it must reject", () => {
    const from = join(ENGINE_DIR, "lines.ts");
    expect(resolveInSubset(from, "./geometry")).toBe("geometry");
    expect(resolveInSubset(from, "./types")).toBe("types");
    expect(resolveInSubset(from, "./engine")).toBeNull();
    expect(resolveInSubset(from, "../classifier-engine/derive-name")).toBeNull();
    expect(resolveInSubset(from, "@/types")).toBeNull();
    expect(resolveInSubset(from, "zod")).toBeNull();
    const probe = ts.preProcessFile(
      '// import x from "./engine";\nimport { a } from "./geometry";\nconst m = import("../db");\nexport * from "./ops";',
      true,
      true,
    ).importedFiles.map((f) => f.fileName);
    expect(probe).toEqual(["./geometry", "../db", "./ops"]);
  });
});
