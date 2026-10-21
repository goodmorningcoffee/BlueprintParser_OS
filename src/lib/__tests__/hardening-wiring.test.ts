// @vitest-environment node
// [hardening sep30] WIRING pins. The behaviour of each control has its own spec; these pin that
// the control is actually CONNECTED in production code, which a behaviour test on the helper
// cannot see. Source-level on purpose, like the topology freezes elsewhere in this repo.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { findRateRule } from "@/middleware";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");
const withoutComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("hardening wiring", () => {
  it.each([
    ["table-parse", "tableParse"],
    ["table-structure", "tableStructure"],
    ["shape-parse", "shapeParse"],
    ["bucket-fill", "bucketFillRoute"],
    ["symbol-search", "symbolSearch"],
  ])("/api/%s runs its service behind the anonymous heavy-work gate", (route, service) => {
    const source = withoutComments(read(`src/app/api/${route}/route.ts`));
    expect(source).toContain(`handler: ({ body }) => withAnonymousHeavySlot(() => ${service}(body)),`);
  });

  it("the gate is taken in exactly one place, and never by the pipeline worker's imports", () => {
    expect(withoutComments(read("src/server/api/heavy-work.ts"))).toContain("withHeavyProcessSlot(task)");
    for (const lib of [
      "src/lib/template-match.ts",
      "src/lib/tatr-structure.ts",
      "src/lib/img2table-extract.ts",
      "src/lib/bucket-fill.ts",
      "src/lib/processing.ts",
      "src/lib/pdf-rasterize.ts",
      "src/lib/keynotes.ts",
    ]) {
      expect(read(lib)).not.toContain("heavy-process-gate");
    }
  });

  it("symbol-search holds its own anonymous slot around the LOCAL template match (the stream outlives the route's)", () => {
    const source = withoutComments(read("src/server/services/symbol-search.ts"));
    expect(source).toContain("const localHeavy = session");
    expect(source).toContain("await localHeavy(() => templateMatch(");
  });

  it("next.config.ts turns the image optimizer off", () => {
    expect(withoutComments(read("next.config.ts"))).toContain("images: { unoptimized: true }");
  });

  it("demo chat refuses for free, then consumes quota, then reaches the provider", () => {
    const source = withoutComments(read("src/app/api/demo/chat/route.ts"));
    const order = [
      "message.length > MAX_MESSAGE_CHARS",
      "if (!demoProject)",
      'assertDemoFeatureEnabled(demoProject.companyId, "chat")',
      // owner ruling 2026-10-21: the call now carries the verified root flag (root skips the pool)
      "await checkDemoChatQuota(",
      "await resolveLLMConfig(",
    ].map((needle) => source.indexOf(needle));
    expect(order.every((index) => index !== -1)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it("csi/detect and credential sign-in have their own per-address rate rules", () => {
    expect(findRateRule("/api/csi/detect", "POST")).toMatchObject({ limit: 20, windowMs: 60_000, keyType: "ip" });
    expect(findRateRule("/api/auth/callback/credentials", "POST")).toMatchObject({
      limit: 10,
      windowMs: 60_000,
      keyType: "ip",
    });
    expect(findRateRule("/api/auth/callback/credentials/x", "POST")).toBeUndefined();
  });
});
