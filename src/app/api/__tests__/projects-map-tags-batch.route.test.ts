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
    expect(missing.body.error).toEqual({ code: "VALIDATION", message: "yoloClass required for scanClass" }); // [P1.5 fold] flipped
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
      expect(res.body.error).toEqual({ code: "VALIDATION", message: msg }); // [P1.5 fold] flipped
    }
    // precedence inside the cascade: tags-required beats the itemType check
    const both = await readJson(await mtb(unknown, { itemType: "bogus" }));
    expect(both.body.error).toEqual({ code: "VALIDATION", message: "tags array required" }); // [P1.5 fold] flipped
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
    expect(noAuth.body.error).toEqual({ code: "UNAUTHORIZED", message: "Unauthorized" }); // [P1.5 fold] flipped

    asUser(await createUser((await createCompany()).id));
    const cross = await readJson(await mtb(world.project.publicId, BODY));
    expect(cross.status).toBe(404);
    expect(cross.body.error).toEqual({ code: "NOT_FOUND", message: "Not found" }); // [P1.5 fold] flipped

    asUser(await createUser((await createCompany()).id, { isRootAdmin: true }));
    expect((await readJson(await mtb(world.project.publicId, BODY))).status).toBe(200); // root bypass

    signedOut();
    const unknown = await readJson(await mtb(randomUUID(), BODY));
    expect(unknown.status).toBe(404); // 404 BEFORE auth (engine order)
    expect(unknown.body.error).toEqual({ code: "NOT_FOUND", message: "Not found" }); // [P1.5 fold] flipped
  });

  // [P1.5 fold] WHOLE assertion flipped: legacy's unguarded `await req.json()` threw on malformed
  // JSON (frozen at 0b133e2 as .rejects.toThrow(); raw framework 500 in prod). Now the shell's
  // BAD_REQUEST 400 (sanctioned diff E).
  it("malformed JSON body → 400 BAD_REQUEST 'Invalid JSON body' (diff E; legacy threw)", async () => {
    const { user, project } = await createWorld();
    asUser(user);
    const { status, body } = await readJson(
      await POST(
        new Request(`http://test.local/api/projects/${project.publicId}/map-tags-batch`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{not json",
        }),
        params({ id: project.publicId }),
      ),
    );
    expect(status).toBe(400);
    expect(body.error).toEqual({ code: "BAD_REQUEST", message: "Invalid JSON body" });
  });

  // [DETECTOR closer COV-E] the REST of the diff-E body family — pins the subtle 500→400 vs
  // 400→400 status boundary: EMPTY body + JSON `null` were legacy raw-500s (req.json() throw /
  // destructure-of-null throw) → now the shell's VALIDATION 400; number/array bodies were legacy
  // destructure-to-undefined "tags array required" 400s → now the shell's VALIDATION 400 (status
  // preserved, message drifts — the S013 cosmetic class; sibling P1 char files all pin this).
  it("empty / null / non-object bodies → 400 VALIDATION (diff-E family; empty+null were legacy 500s)", async () => {
    const { user, project } = await createWorld();
    asUser(user);
    const raw = (payload: string) =>
      POST(
        new Request(`http://test.local/api/projects/${project.publicId}/map-tags-batch`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: payload,
        }),
        params({ id: project.publicId }),
      );
    for (const payload of ["", "null", "5", "[1]"]) {
      const { status, body } = await readJson(await raw(payload));
      expect(status).toBe(400);
      expect(body.error.code).toBe("VALIDATION"); // zLooseBody message, not pinned (zod wording)
    }
  });

  // [P1.5 fold] WHOLE assertion flipped: a VALID body + non-uuid id reached the pg uuid cast
  // inside resolveProjectAccess → REJECTED (frozen at 0b133e2). Now sanctioned diff C: clean 400
  // via zPublicId, still AFTER the field cascade (validation-first pinned above — a field 400
  // beats the non-uuid 400).
  it("non-uuid id + valid body → 400 'Invalid project id' (diff C); field-400 still wins", async () => {
    signedOut();
    const c = await readJson(await mtb("not-a-uuid", { tags: ["a"] }));
    expect(c.status).toBe(400);
    expect(c.body.error).toEqual({ code: "VALIDATION", message: "Invalid project id" });

    const fieldWins = await readJson(await mtb("not-a-uuid", {}));
    expect(fieldWins.body.error).toEqual({ code: "VALIDATION", message: "tags array required" });
  });
});
