// @vitest-environment node
// [refactor jul3 P1.5] CHARACTERIZATION for POST /api/projects/[id]/map-tags-batch, written as
// THE FREEZE before the P1.5 migration onto services/map-tags.ts (mapTagsBatch). The matching
// ENGINE (@/lib/tag-mapping findOccurrences/scanClassForTexts/buildScope/inferTagPattern) is NOT
// under test — it is imported unchanged by both legacy and service; this file freezes the ROUTE
// contract: the validation cascade, mode dispatch, response shapes, and access matrix. Frozen:
//   • VALIDATE-BEFORE-AUTH: legacy runs `await req.json()` + the whole field cascade BEFORE
//     resolveProjectAccess — an invalid body 400s even SIGNED-OUT on an unknown project (the
//     shell must stay auth:"none"; the service validates first, resolves access after).
//   • the validation cascade in SOURCE ORDER with byte-exact messages: "tags array required" →
//     "Max 500 tags per batch" → "tags must be strings" → "yoloClass required for scanClass" →
//     "selectedPages must be positive integers" → "Max 2000 pages per batch" →
//     "drawingNumberPrefixes must be strings" → `invalid itemType: ${itemType}` (INTERPOLATED) →
//     "tagShapeClass required for itemType='yolo-object-with-tag-shape'".
//   • an INVALID strictnessMode does NOT 400 — it silently defaults to "balanced" (echoed back).
//   • scanClass mode returns a DIFFERENT shape: {texts} (no results/dropCounts/strictnessMode).
//   • map mode returns {results, dropCounts, strictnessMode}; dropCounts is the FIXED 5-key
//     zero-initialized object {outside_scope, pattern_mismatch, inside_title_block, inside_table,
//     outside_drawings}; results keys are the TRIMMED tags; empty-after-trim tags are SKIPPED.
//   • yolo-only special case: ONE dispatch shared across all tags (every tag key gets the same
//     result array).
//   • access = resolveProjectAccess({publicId}, {allowDemo:true}): demo = public (signed-out
//     200 with a valid body); unknown → 404 BEFORE auth; non-demo signed-out → 401; cross-tenant
//     → 404; root bypass → 200.
//   • malformed JSON: legacy unguarded req.json() → raw throw (flips to the shell's BAD_REQUEST
//     400 at fold, sanctioned diff E). non-uuid id + VALID body: pg uuid-cast throw (flips to
//     diff C 400; the field-400s still WIN over it — validation first).
// Assertions tagged [P1.5 fold] flip in the fold commit (sanctioned diff A).
import { randomUUID } from "node:crypto";
import { describe, expect, inject, it, vi } from "vitest";

vi.mock("@/lib/auth", async () => {
  const { sessionState } = await import("@/test/harness");
  return { auth: async () => sessionState.current };
});

import { POST } from "@/app/api/projects/[id]/map-tags-batch/route";
import {
  asUser,
  createCompany,
  createUser,
  createWorld,
  makeReq,
  params,
  readJson,
  signedOut,
} from "@/test/harness";

const dbUp = inject("dbUp") as boolean;

const mtb = (id: string, body: unknown) =>
  POST(makeReq(`/api/projects/${id}/map-tags-batch`, { method: "POST", body }), params({ id }));

const ZERO_DROPS = {
  outside_scope: 0,
  pattern_mismatch: 0,
  inside_title_block: 0,
  inside_table: 0,
  outside_drawings: 0,
};

describe.skipIf(!dbUp)("POST /api/projects/[id]/map-tags-batch", () => {
  it("map happy (no data): {results, dropCounts, strictnessMode} — trimmed keys, empty-tag skip, zero dropCounts", async () => {
    const { user, project } = await createWorld();
    asUser(user);
    const { status, body } = await readJson(
      await mtb(project.publicId, { tags: ["  T-1  ", "   ", "T-2"] }),
    );
    expect(status).toBe(200);
    expect(Object.keys(body).sort()).toEqual(["dropCounts", "results", "strictnessMode"]);
    expect(Object.keys(body.results).sort()).toEqual(["T-1", "T-2"]); // trimmed; blank skipped
    expect(body.results["T-1"]).toEqual([]);
    expect(body.dropCounts).toEqual(ZERO_DROPS); // the fixed 5-key zero object
    expect(body.strictnessMode).toBe("balanced"); // default
  });

  it("invalid strictnessMode silently defaults to 'balanced' (NO 400 — frozen quirk)", async () => {
    const { user, project } = await createWorld();
    asUser(user);
    const { status, body } = await readJson(
      await mtb(project.publicId, { tags: ["a"], strictnessMode: "bogus" }),
    );
    expect(status).toBe(200);
    expect(body.strictnessMode).toBe("balanced");
    const strict = await readJson(
      await mtb(project.publicId, { tags: ["a"], strictnessMode: "strict" }),
    );
    expect(strict.body.strictnessMode).toBe("strict"); // valid value echoes back
  });

  it("yolo-only: ONE shared dispatch — every tag key gets the SAME result array", async () => {
    const { user, project } = await createWorld();
    asUser(user);
    const { status, body } = await readJson(
      await mtb(project.publicId, { tags: ["a", "b"], itemType: "yolo-only", yoloClass: "door" }),
    );
    expect(status).toBe(200);
    expect(Object.keys(body.results).sort()).toEqual(["a", "b"]);
    expect(body.results.a).toEqual(body.results.b); // shared result (both [] here)
  });

  it("scanClass mode: {texts} shape; yoloClass required", async () => {
    const { user, project } = await createWorld();
    asUser(user);
    const ok = await readJson(
      await mtb(project.publicId, { action: "scanClass", yoloClass: "door" }),
    );
    expect(ok.status).toBe(200);
    expect(Object.keys(ok.body)).toEqual(["texts"]); // the DIFFERENT scan shape
    expect(ok.body.texts).toEqual([]);

    const missing = await readJson(await mtb(project.publicId, { action: "scanClass" }));
    expect(missing.status).toBe(400);
    expect(missing.body.error).toBe("yoloClass required for scanClass"); // [P1.5 fold] → {code:"VALIDATION",...}
  });

  it("validation cascade, byte-exact messages + source order, fires BEFORE auth (signed-out, unknown project)", async () => {
    signedOut();
    const unknown = randomUUID();
    const cases: Array<[unknown, string]> = [
      [{}, "tags array required"],
      [{ tags: [] }, "tags array required"],
      [{ tags: Array.from({ length: 501 }, (_, i) => `t${i}`) }, "Max 500 tags per batch"],
      [{ tags: ["a", 5] }, "tags must be strings"],
      [{ tags: ["a"], selectedPages: [0] }, "selectedPages must be positive integers"],
      [{ tags: ["a"], selectedPages: ["x"] }, "selectedPages must be positive integers"],
      [
        { tags: ["a"], selectedPages: Array.from({ length: 2001 }, (_, i) => i + 1) },
        "Max 2000 pages per batch",
      ],
      [{ tags: ["a"], drawingNumberPrefixes: [1] }, "drawingNumberPrefixes must be strings"],
      [{ tags: ["a"], itemType: "bogus" }, "invalid itemType: bogus"], // INTERPOLATED msg
      [
        { tags: ["a"], itemType: "yolo-object-with-tag-shape" },
        "tagShapeClass required for itemType='yolo-object-with-tag-shape'",
      ],
    ];
    for (const [body, msg] of cases) {
      const res = await readJson(await mtb(unknown, body));
      expect(res.status).toBe(400); // 400 wins over the would-be 404/401 — validate-before-auth
      expect(res.body.error).toBe(msg); // [P1.5 fold] → {code:"VALIDATION",message:msg}
    }
    // precedence inside the cascade: tags-required beats the itemType check
    const both = await readJson(await mtb(unknown, { itemType: "bogus" }));
    expect(both.body.error).toBe("tags array required"); // [P1.5 fold] → {code:"VALIDATION",...}
  });

  it("access matrix (valid body): demo signed-out 200; non-demo signed-out 401; cross-tenant 404; root 200; unknown 404-before-auth", async () => {
    const BODY = { tags: ["a"] };

    const demo = await createWorld({ isDemo: true });
    signedOut();
    expect((await readJson(await mtb(demo.project.publicId, BODY))).status).toBe(200); // public demo read

    const world = await createWorld();
    signedOut();
    const noAuth = await readJson(await mtb(world.project.publicId, BODY));
    expect(noAuth.status).toBe(401);
    expect(noAuth.body.error).toBe("Unauthorized"); // [P1.5 fold] → {code:"UNAUTHORIZED",message:"Unauthorized"}

    asUser(await createUser((await createCompany()).id));
    const cross = await readJson(await mtb(world.project.publicId, BODY));
    expect(cross.status).toBe(404);
    expect(cross.body.error).toBe("Not found"); // [P1.5 fold] → {code:"NOT_FOUND",message:"Not found"}

    asUser(await createUser((await createCompany()).id, { isRootAdmin: true }));
    expect((await readJson(await mtb(world.project.publicId, BODY))).status).toBe(200); // root bypass

    signedOut();
    const unknown = await readJson(await mtb(randomUUID(), BODY));
    expect(unknown.status).toBe(404); // 404 BEFORE auth (engine order)
    expect(unknown.body.error).toBe("Not found"); // [P1.5 fold] → {code:"NOT_FOUND",message:"Not found"}
  });

  // [P1.5 fold] WHOLE assertion flips: legacy's unguarded `await req.json()` throws on malformed
  // JSON (raw framework 500). Fold = the shell's BAD_REQUEST 400 (sanctioned diff E).
  it("malformed JSON body → legacy raw throw (frozen defensive form)", async () => {
    const { user, project } = await createWorld();
    asUser(user);
    await expect(
      POST(
        new Request(`http://test.local/api/projects/${project.publicId}/map-tags-batch`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{not json",
        }),
        params({ id: project.publicId }),
      ),
    ).rejects.toThrow();
  });

  // [P1.5 fold] WHOLE assertion flips: a VALID body + non-uuid id reaches the pg uuid cast inside
  // resolveProjectAccess → REJECTS (raw 500, S003 class). Fold = clean 400 via zPublicId
  // (sanctioned diff C), still AFTER the field cascade (validation-first is pinned above).
  it("non-uuid id + valid body → legacy pg uuid-cast throw (frozen defensive form)", async () => {
    signedOut();
    await expect(mtb("not-a-uuid", { tags: ["a"] })).rejects.toThrow();
  });
});
