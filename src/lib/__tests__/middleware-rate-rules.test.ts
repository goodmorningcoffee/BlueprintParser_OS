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

  // [refactor jun16 P0-review G9-1] the same exact/prefix bug-class as projects,
  // found at /api/annotations: batch-delete POST used to burn the create budget.
  it("annotation CREATE is exact 200/hr and no longer swallows its subtree", () => {
    const create = findRateRule("/api/annotations", "POST");
    expect(create!.limit).toBe(200);
    expect(create!.exact).toBe(true);
  });

  it("annotation batch-delete has its own 100/hr rule, not the create bucket", () => {
    const rule = findRateRule("/api/annotations/batch-delete", "POST");
    expect(rule).toBeTruthy();
    expect(rule!.limit).toBe(100);
    expect(rule!.pattern).toBe("/api/annotations/batch-delete");
  });

  it("an unrelated /api/annotations subpath POST falls through to the backstop", () => {
    expect(findRateRule("/api/annotations/123/whatever", "POST")).toBeUndefined();
  });
});

// [bugfix jul9 P2-entry] the general-bucket session-GET exemption — the reload-brick class:
// SessionProvider's GET /api/auth/session 429'd under the shared bucket, and the session-
// gated project bootstrap has no retry → eternal "Loading project...". Pin the exemption
// EXACTLY: session GET only; session POST and every other path stay in the general bucket.
import { isGeneralBucketExempt } from "@/middleware";

describe("isGeneralBucketExempt — session-GET reload-brick exemption", () => {
  it("GET /api/auth/session is exempt from the general 120/min bucket", () => {
    expect(isGeneralBucketExempt("/api/auth/session", "GET")).toBe(true);
  });

  it("the exemption is EXACTLY session GET — nothing else escapes the bucket", () => {
    expect(isGeneralBucketExempt("/api/auth/session", "POST")).toBe(false); // sign-in/out stay covered
    expect(isGeneralBucketExempt("/api/auth/csrf", "GET")).toBe(false);
    expect(isGeneralBucketExempt("/api/auth/session/extra", "GET")).toBe(false); // exact, not prefix
    expect(isGeneralBucketExempt("/api/projects", "GET")).toBe(false);
  });

  it("per-endpoint RATE_RULES are unaffected — no auth rule matches session GET anyway", () => {
    expect(findRateRule("/api/auth/session", "GET")).toBeUndefined();
  });
});
