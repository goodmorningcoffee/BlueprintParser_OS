// @vitest-environment node
// [refactor jun13 P0.5-G9] Freezes the rate-rule matcher semantics:
// exact-match rules stop swallowing their subtree (the named harm: bulk
// map-tagging burned the 10/hr project-CREATE budget), while prefix rules
// keep covering theirs. The cookie-name half of G9 (authjs.* v5 names in
// "user" rate keys) lives in the middleware body — not unit-testable without
// an edge-request mock; verified by inspection against lines that already
// handle v5 names for the authed?-proxy.
import { describe, expect, it } from "vitest";
import { findRateRule } from "@/middleware";

describe("findRateRule — G9 exact/prefix semantics", () => {
  it("project CREATE keeps its tight 10/hr rule (exact path)", () => {
    const rule = findRateRule("/api/projects", "POST");
    expect(rule).toBeTruthy();
    expect(rule!.limit).toBe(10);
    expect(rule!.exact).toBe(true);
  });

  it("map-tags-batch no longer inherits the project-create bucket", () => {
    expect(findRateRule("/api/projects/abc-123/map-tags-batch", "POST")).toBeUndefined();
    expect(findRateRule("/api/projects/abc-123/classify-regions", "POST")).toBeUndefined();
  });

  it("prefix rules still cover their subtree (demo GETs)", () => {
    const rule = findRateRule("/api/demo/projects", "GET");
    expect(rule).toBeTruthy();
    expect(rule!.pattern).toBe("/api/demo");
  });

  it("method must match — project GETs are unthrottled by the POST rule", () => {
    expect(findRateRule("/api/projects", "GET")).toBeUndefined();
  });
});
