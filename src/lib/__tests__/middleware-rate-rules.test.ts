// @vitest-environment node
// [refactor jun13 P0.5-G9] Freezes the rate-rule matcher semantics:
// exact-match rules stop swallowing their subtree (the named harm: bulk
// map-tagging burned the 10/hr project-CREATE budget), while prefix rules
// keep covering theirs. The cookie-name half of G9 (authjs.* v5 names in
// "user" rate keys) lives in the middleware body — not unit-testable without
// an edge-request mock; verified by inspection against lines that already
// handle v5 names for the authed?-proxy.
import { describe, expect, it } from "vitest";
import {
  findRateRule,
  isGeneralBucketExempt,
  isLabelAssetTransportRatePath,
  isViewerTransportRatePath,
  trustedClientIp,
} from "@/middleware";

describe("trustedClientIp — ALB append-mode trust boundary", () => {
  it("uses only the rightmost nonempty hop, never caller-controlled left hops", () => {
    expect(trustedClientIp("198.51.100.9, 192.0.2.44, 203.0.113.7")).toBe(
      "203.0.113.7",
    );
    expect(trustedClientIp("198.51.100.9, 203.0.113.7, ,  ")).toBe(
      "203.0.113.7",
    );
  });

  it("validates and canonicalizes the authoritative hop", () => {
    expect(trustedClientIp("198.51.100.9, 2001:0DB8:0:0:0:0:0:1")).toBe(
      "2001:db8::1",
    );
    expect(trustedClientIp("203.0.113.7, not-an-ip")).toBe("unknown");
    expect(trustedClientIp("203.0.113.7, 001.002.003.004")).toBe("unknown");
    expect(trustedClientIp(null)).toBe("unknown");
  });

  it("bounds parsing while preserving an ALB-appended address", () => {
    const attackerControlledPrefix = "x".repeat(20_000);
    expect(trustedClientIp(`${attackerControlledPrefix}, 203.0.113.17`)).toBe(
      "203.0.113.17",
    );
    expect(trustedClientIp(`203.0.113.17, ${"f".repeat(4_096)}`)).toBe(
      "unknown",
    );
  });
});

describe("findRateRule — G9 exact/prefix semantics", () => {
  it("project CREATE keeps its tight 10/hr rule (exact path)", () => {
    const rule = findRateRule("/api/projects", "POST");
    expect(rule).toBeTruthy();
    expect(rule!.limit).toBe(10);
    expect(rule!.exact).toBe(true);
  });

  it("map-tags-batch no longer inherits the project-create bucket", () => {
    expect(
      findRateRule("/api/projects/abc-123/map-tags-batch", "POST"),
    ).toBeUndefined();
    expect(
      findRateRule("/api/projects/abc-123/classify-regions", "POST"),
    ).toBeUndefined();
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

  it("annotation split has an isolated exact 200/user/hour rule", () => {
    const split = findRateRule("/api/annotations/split", "POST");
    expect(split).toMatchObject({
      pattern: "/api/annotations/split",
      method: "POST",
      limit: 200,
      windowMs: 60 * 60 * 1000,
      keyType: "user",
      exact: true,
    });

    expect(
      findRateRule("/api/annotations/split/extra", "POST"),
    ).toBeUndefined();
    expect(findRateRule("/api/annotations/split", "GET")).toBeUndefined();
    expect(findRateRule("/api/annotations", "POST")!.pattern).toBe(
      "/api/annotations",
    );
    expect(findRateRule("/api/annotations/batch-delete", "POST")!.pattern).toBe(
      "/api/annotations/batch-delete",
    );
  });

  it("an unrelated /api/annotations subpath POST falls through to the backstop", () => {
    expect(
      findRateRule("/api/annotations/123/whatever", "POST"),
    ).toBeUndefined();
  });
});

// [bugfix jul9 P2-entry] the general-bucket session-GET exemption — the reload-brick class:
// SessionProvider's GET /api/auth/session 429'd under the shared bucket, and the session-
// gated project bootstrap has no retry → eternal "Loading project...". Pin the exemption
// EXACTLY: session GET only; session POST and every other path stay in the general bucket
// unless a dedicated bounded rule (such as viewer transport) matches it.

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

describe("viewer transport aggregate rate rule", () => {
  const projectId = "550e8400-e29b-41d4-a716-446655440000";

  it("classifies only high-fanout project asset GET/HEAD transports", () => {
    expect(
      isViewerTransportRatePath(
        `/api/project-assets/${projectId}/original.pdf`,
        "GET",
      ),
    ).toBe(true);
    expect(
      isViewerTransportRatePath(
        `/api/project-assets/${projectId}/pages/page_0001.png`,
        "HEAD",
      ),
    ).toBe(true);

    expect(
      isViewerTransportRatePath(
        `/api/project-assets/${projectId}/original.pdf`,
        "POST",
      ),
    ).toBe(false);
    expect(
      isViewerTransportRatePath(`/api/project-assets/${projectId}`, "GET"),
    ).toBe(false);
    expect(
      isViewerTransportRatePath(
        "/api/project-assets/not-a-uuid/original.pdf",
        "GET",
      ),
    ).toBe(false);
  });

  it("classifies exact private/demo page-window GETs, not adjacent routes or methods", () => {
    expect(
      isViewerTransportRatePath(`/api/projects/${projectId}/pages`, "GET"),
    ).toBe(true);
    expect(
      isViewerTransportRatePath(`/api/demo/projects/${projectId}/pages`, "GET"),
    ).toBe(true);

    expect(
      isViewerTransportRatePath(`/api/projects/${projectId}/pages`, "HEAD"),
    ).toBe(false);
    expect(
      isViewerTransportRatePath(
        `/api/demo/projects/${projectId}/pages`,
        "POST",
      ),
    ).toBe(false);
    expect(
      isViewerTransportRatePath(`/api/projects/${projectId}/pages/1`, "GET"),
    ).toBe(false);
    expect(
      isViewerTransportRatePath(
        `/api/projects/${projectId}/thumbnail/1`,
        "GET",
      ),
    ).toBe(false);
    expect(
      isViewerTransportRatePath(`/api/demo/projects/${projectId}`, "GET"),
    ).toBe(false);
  });

  it("uses one bounded 600/min per-IP rule for every classified transport", () => {
    const assetRule = findRateRule(
      `/api/project-assets/${projectId}/pages/page_0001.png`,
      "GET",
    );
    const privateWindowRule = findRateRule(
      `/api/projects/${projectId}/pages`,
      "GET",
    );
    const demoWindowRule = findRateRule(
      `/api/demo/projects/${projectId}/pages`,
      "GET",
    );

    expect(assetRule).toBe(privateWindowRule);
    expect(privateWindowRule).toBe(demoWindowRule);
    expect(assetRule).toMatchObject({
      pattern: "viewer-transport",
      method: "GET|HEAD",
      limit: 600,
      windowMs: 60_000,
      keyType: "ip",
      exact: true,
    });
  });

  it("does not broaden the allowance to other demo/project reads or mutations", () => {
    const ordinaryDemo = findRateRule(`/api/demo/projects/${projectId}`, "GET");
    expect(ordinaryDemo).toMatchObject({ pattern: "/api/demo", limit: 60 });

    expect(findRateRule(`/api/projects/${projectId}`, "GET")).toBeUndefined();
    expect(
      findRateRule(`/api/project-assets/${projectId}/original.pdf`, "POST"),
    ).toBeUndefined();
    expect(
      findRateRule(`/api/projects/${projectId}/pages`, "POST"),
    ).toBeUndefined();
    expect(findRateRule("/api/projects", "POST")!.limit).toBe(10);
  });

  it("skips the shared bucket through its bounded rule, not a broad exemption", () => {
    const path = `/api/projects/${projectId}/pages`;
    expect(isGeneralBucketExempt(path, "GET")).toBe(false);
    expect(findRateRule(path, "GET")!.limit).toBe(600);
  });
});

describe("anonymous label-asset transport aggregate rate rule", () => {
  const grantId = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";
  const projectId = "550e8400-e29b-41d4-a716-446655440000";

  it("classifies exact bearer GET, HEAD, and CORS preflight transports", () => {
    for (const method of ["GET", "HEAD", "OPTIONS"]) {
      expect(
        isLabelAssetTransportRatePath(`/api/label-assets/${grantId}`, method),
      ).toBe(true);
    }
  });

  it("rejects malformed, missing, extra-segment, adjacent, and mutation cases", () => {
    expect(
      isLabelAssetTransportRatePath("/api/label-assets/not-a-uuid", "GET"),
    ).toBe(false);
    expect(isLabelAssetTransportRatePath("/api/label-assets", "GET")).toBe(
      false,
    );
    expect(
      isLabelAssetTransportRatePath(
        `/api/label-assets/${grantId}/extra`,
        "GET",
      ),
    ).toBe(false);
    expect(
      isLabelAssetTransportRatePath(`/api/labeling/${grantId}`, "GET"),
    ).toBe(false);
    expect(
      isLabelAssetTransportRatePath(`/api/label-assets/${grantId}`, "POST"),
    ).toBe(false);
    expect(
      isLabelAssetTransportRatePath(`/api/label-assets/${grantId}`, "DELETE"),
    ).toBe(false);
  });

  it("uses one independent bounded 600/min per-IP bearer bucket", () => {
    const getRule = findRateRule(`/api/label-assets/${grantId}`, "GET");
    const headRule = findRateRule(`/api/label-assets/${grantId}`, "HEAD");
    const optionsRule = findRateRule(`/api/label-assets/${grantId}`, "OPTIONS");
    const viewerRule = findRateRule(
      `/api/project-assets/${projectId}/original.pdf`,
      "GET",
    );

    expect(getRule).toBe(headRule);
    expect(headRule).toBe(optionsRule);
    expect(getRule).not.toBe(viewerRule);
    expect(getRule).toMatchObject({
      pattern: "label-asset-transport",
      method: "GET|HEAD|OPTIONS",
      limit: 600,
      windowMs: 60_000,
      keyType: "ip",
      exact: true,
    });
    expect(viewerRule!.pattern).toBe("viewer-transport");
  });

  it("skips the shared bucket only through the dedicated bounded rule", () => {
    const path = `/api/label-assets/${grantId}`;
    expect(isGeneralBucketExempt(path, "GET")).toBe(false);
    expect(findRateRule(path, "GET")!.limit).toBe(600);
    expect(findRateRule(`${path}/extra`, "GET")).toBeUndefined();
    expect(findRateRule(path, "POST")).toBeUndefined();
  });
});
