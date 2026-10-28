// @vitest-environment node
// [table pipeline WP-3.D] R8 fusion weights: defaults, the shipped src/data/parse-engine/profile.json override, a
// malformed file never half-applied, and the production path reads the file the image ships (verify MED-2).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_COL_WEIGHTS, DEFAULT_PROFILE, PROFILE_PATH, loadParseEngineProfile, parseEngineProfile, parseEngineProfileError, parseProfile, resetParseEngineProfileCache } from "../profile";
import { DEFAULT_ROW_WEIGHTS } from "../types-rows";

describe("parse-engine profile (R8)", () => {
  it("the defaults are the plan's R8 values", () => {
    expect(DEFAULT_PROFILE.rows).toBe(DEFAULT_ROW_WEIGHTS);
    expect(DEFAULT_COL_WEIGHTS).toEqual({ "textract-cells": 1, rulings: 1, "x-starts": 0.7, "primitive-grid": 0.6 });
  });

  it("a missing file keeps the defaults; a valid file overrides only what it names", () => {
    expect(loadParseEngineProfile("/nowhere", () => { throw new Error("ENOENT"); })).toEqual({ profile: DEFAULT_PROFILE });
    const read = (p: string): string => {
      expect(p.endsWith(PROFILE_PATH)).toBe(true);
      return JSON.stringify({ v: 1, id: "fit-odd-QX", rows: { "ocr-lines": 0.55 } });
    };
    const { profile, error } = loadParseEngineProfile("/repo", read);
    expect(error).toBeUndefined();
    expect(profile.id).toBe("fit-odd-QX");
    expect(profile.rows["ocr-lines"]).toBe(0.55);
    expect(profile.rows["textract-cells"]).toBe(1);
    expect(profile.cols).toEqual(DEFAULT_COL_WEIGHTS);
  });

  it("a malformed file is ignored as a whole and says why", () => {
    for (const bad of ["{", JSON.stringify({ v: 2 }), JSON.stringify({ v: 1, rows: { "not-a-method": 1 } }), JSON.stringify({ v: 1, cols: { "x-starts": -1 } }), JSON.stringify({ v: 1, rows: { layout: "0.4" } })]) {
      const r = loadParseEngineProfile("/repo", () => bad);
      expect(r.profile).toBe(DEFAULT_PROFILE);
      expect(r.error).toBeTruthy();
    }
    expect(parseProfile([])).toEqual({ error: "profile is not an object" });
  });

  it("production reads the shipped file: under src/data (copied into the image, not dockerignored), statically imported, R8 values", () => {
    expect(PROFILE_PATH.startsWith("src/data/")).toBe(true);
    const ignored = readFileSync(join(process.cwd(), ".dockerignore"), "utf8").split("\n").map((l) => l.trim().replace(/^\/+|\/+$/g, "")).filter((l) => l && !l.startsWith("#"));
    for (const prefix of ["src", "src/data", "src/data/parse-engine", PROFILE_PATH]) expect(ignored, prefix).not.toContain(prefix);
    expect(readFileSync(join(process.cwd(), "Dockerfile"), "utf8")).toMatch(/COPY --from=builder \/app\/src\/data \.\/src\/data/);
    const src = readFileSync(join(process.cwd(), "src/lib/parse-engine/profile.ts"), "utf8");
    expect(src).toContain('from "@/data/parse-engine/profile.json"');
    resetParseEngineProfileCache();
    const onDisk = loadParseEngineProfile(process.cwd());
    expect(onDisk.error).toBeUndefined();
    expect(parseEngineProfile()).toEqual(onDisk.profile);
    expect(parseEngineProfileError()).toBeUndefined();
    resetParseEngineProfileCache();
  });
});
