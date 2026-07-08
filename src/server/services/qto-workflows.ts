// [refactor jun17 P1.3] QTO-workflows service — P1.3 core family 3/7.
//
// The two qto-workflows route files (qto-workflows[/route], [id]) are now thin `defineRoute`
// shells; ALL behavior lives here. Behavior is preserved EXACTLY against the NEW characterization
// tests added with this migration (qto-workflows.route.test.ts + qto-workflows-id.route.test.ts —
// no P0.3 char file existed for this family, so they ARE the freeze). Sanctioned diffs only:
//   (a) the error envelope flips {error:string} → {error:{code,message}} (the shell does this);
//   (b) a non-uuid projectId that legacy fed to a pg uuid column (→ unhandled 500) becomes a clean
//       400 via zPublicId — on GET via the shell's `query` schema, on POST via resolveByPublicId
//       below (same precedent as annotations/annotation-groups create paths);
//   (c) the legacy per-handler `catch{ apiError(...,500) }` blocks are DROPPED — any unexpected db
//       error propagates to the shell's outer catch, which logs server-side and returns the generic
//       leak-free INTERNAL 500. Happy paths are byte-identical.
//
// Recipe applied (S008 §B / annotations S009 / annotation-groups S010 precedent):
//   • GET collection: UNLIKE the rest of this family, legacy used requireAuth() + a MANUAL
//     companyId-scoped project lookup (NOT resolveProjectAccess). That lookup has NO root-admin
//     bypass and NO demo carve-out: a root admin on ANOTHER company's project gets 404; a demo
//     project not owned by the caller's company gets 404. To preserve this we DO NOT call
//     resolveProjectOrThrow here — the route is auth:"session" (the shell 401s signed-out callers)
//     and the service re-implements the exact `WHERE publicId=$1 AND companyId=session.companyId`
//     filter. (Swapping in resolveProjectOrThrow would silently GRANT root admins cross-company
//     reads — a behavior change we explicitly refuse. Frozen by the root-admin GET char case.)
//   • POST (create): validate-before-auth — projectId/materialType 400 fires BEFORE the 401/404.
//     Then resolveByPublicId (zPublicId → resolveProjectOrThrow with allowDemo:true) → explicit
//     isDemo write-gate → 403 for everyone except an owning-company admin / root.
//   • [id] GET/PUT/DELETE: indirect lookup — fetch the workflow by Number(id) (404 if missing),
//     then resolveProjectOrThrow({dbId: workflow.projectId}) with NO allowDemo. Demo projects need
//     a session here (same as legacy); an owning-company member can still reach their own demo
//     project, treated as a normal company project — so [id] has NO demo write-gate (unlike POST).
//
// Frozen quirks deliberately kept (do NOT "fix" them):
//   • [id] uses Number(id) with NO integer guard (UNLIKE annotation-groups, whose legacy used a
//     stricter parseInt+Number.isInteger guard). A non-numeric id → Number()→NaN → the db sees
//     `id = NaN`; the pg int-cast on NaN DETERMINISTICALLY THROWS → the shell's leak-free INTERNAL
//     500 (verified empirically — identical to annotations/[id] + takeoff-items/[id]; it is NEVER a
//     404 and NEVER a clean 400). We do NOT add a 400 guard — legacy had none.
//   • PUT has NO demo write-gate (unlike POST). An authenticated owning-company member/admin CAN
//     PUT/DELETE a demo project's workflow. Do NOT add a demo 403 to [id].
//   • POST: materialLabel defaults to materialType when falsy (`materialLabel || materialType`),
//     and step is hardcoded "select-schedule" at create.
//   • PUT field validation runs in SOURCE ORDER and SHORT-CIRCUITS on the first invalid field:
//     step → schedulePageNumber → {parsedSchedule,lineItems,userEdits} (1MB cap) →
//     {yoloClassFilter,materialLabel,itemType,tagShapeClass} (≤1024 char) → exportedAt (passed
//     through UNVALIDATED). An empty body {} touches only updatedAt. yoloModelFilter/tagPattern
//     (removed in migration 0024) are silently ignored; itemType is range-checked only as a generic
//     ≤1024 string, NOT against the QtoItemType enum — matches legacy.
//   • [id] existence (404) is checked BEFORE access (401) — a missing workflow returns 404 even to
//     a signed-out caller (frozen legacy ordering; a pre-existing id-probe quirk, not introduced here).
//
// Return shape: the RAW drizzle row (`$inferSelect`), no toClientWorkflow mapper. Legacy returned
// the raw row via NextResponse.json, so createdAt/updatedAt (which are absent from the QtoWorkflow
// client interface but present on $inferSelect) are ALREADY on the wire; a mapper modeled on
// QtoWorkflow would DROP them and change the body. Returning the raw row preserves all columns
// byte-for-byte. Date→ISO is handled identically by the shell's JSON.stringify.

import { db } from "@/lib/db";
import { projects, qtoWorkflows } from "@/lib/db/schema";
import { eq, and, desc } from "drizzle-orm";
import { ApiError, notFound } from "@/server/api/envelope";
import { resolveByPublicId, resolveProjectOrThrow } from "@/server/api/access";
import type { AuthSession } from "@/lib/api-utils";

// Frozen PUT validation constants (verbatim from legacy [id]/route.ts lines 52–54).
const VALID_STEPS = ["pick", "select-schedule", "confirm-tags", "map-tags", "review", "done"];
const MAX_JSONB_BYTES = 1_048_576; // 1 MB
const MAX_STRING_LEN = 1024;

// [refactor jul8 P1-review PR-C1] the local resolveByPublicId was hoisted to
// server/api/access.ts. ⚠️ The deleted local copy HARDCODED `{allowDemo:true}` inside its body;
// the shared helper is opts-parameterized, so the POST call site below now passes
// `{allowDemo:true}` explicitly — dropping it would flip demo-project resolution 403→404
// (POST needs the demo project to RESOLVE so the explicit isDemo write-gate can return the
// frozen 403). The zPublicId guard (non-uuid id → clean 400, not the legacy pg-uuid-cast 500,
// sanctioned diff b) still sits AFTER the caller's field validation, preserving the frozen
// validate-before-auth precedence.

/** Indirect-lookup prologue for the three [id] handlers (frozen order):
 *  Number(id) (NO guard — legacy quirk; non-numeric → NaN → pg int-cast THROWS → shell INTERNAL 500)
 *  → fetch the workflow (404 if missing) → resolve access on the PARENT project by dbId, NO
 *  allowDemo. Returns the workflow row. */
async function loadWorkflowAndAuthz(idParam: string) {
  const [workflow] = await db
    .select()
    .from(qtoWorkflows)
    .where(eq(qtoWorkflows.id, Number(idParam)))
    .limit(1);
  if (!workflow) throw notFound();

  await resolveProjectOrThrow({ dbId: workflow.projectId }); // NO allowDemo — demo needs a session here
  return workflow;
}

// ── GET /api/qto-workflows?projectId=<publicId> ──────────────────────────────────
//
/** List workflows for a project, newest first. Auth is the shell's auth:"session" (401 if signed
 *  out); access is the legacy MANUAL companyId-scoped lookup — NO root bypass, NO demo carve-out
 *  (a root admin on another company's project, or a demo project not owned by the caller's company,
 *  both get 404). Returns the raw rows ([] when none). */
export async function listQtoWorkflows(projectId: string, session: AuthSession) {
  // EXACT legacy lookup: publicId AND companyId. Replicates the no-root-bypass / wrong-company-404
  // behavior; do NOT swap this for resolveProjectOrThrow (which root-bypasses).
  const [project] = await db
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.publicId, projectId), eq(projects.companyId, session.user.companyId)))
    .limit(1);
  if (!project) throw notFound();

  return db
    .select()
    .from(qtoWorkflows)
    .where(eq(qtoWorkflows.projectId, project.id))
    .orderBy(desc(qtoWorkflows.createdAt));
}

// ── POST /api/qto-workflows ──────────────────────────────────────────────────────
//
/** Create a workflow. Order (frozen): field validation (projectId+materialType required) → AUTH
 *  via resolveByPublicId (allowDemo:true) → demo write-gate (403) → insert. step is hardcoded
 *  "select-schedule"; materialLabel defaults to materialType when falsy. Returns the raw row. */
export async function createQtoWorkflow(body: Record<string, unknown>) {
  const { projectId, materialType, materialLabel } = body as {
    projectId?: string;
    materialType?: string;
    materialLabel?: string;
  };

  // validate-before-auth — this 400 must fire BEFORE the 401/404 (frozen ordering). Falsy check
  // (empty string is also rejected); message verbatim from legacy.
  if (!projectId || !materialType) {
    throw new ApiError("VALIDATION", "projectId and materialType required");
  }

  // [refactor jul8 P1-review PR-C1] allowDemo:true was hardcoded inside the old local helper;
  // now passed explicitly to the shared access.ts helper. Behavior identical.
  const { project, scope } = await resolveByPublicId(projectId, { allowDemo: true });

  if (project.isDemo && scope !== "admin" && scope !== "root") {
    throw new ApiError("FORBIDDEN", "Demo projects are read-only");
  }

  const [workflow] = await db
    .insert(qtoWorkflows)
    .values({
      projectId: project.id,
      materialType,
      materialLabel: materialLabel || materialType, // frozen default
      step: "select-schedule", // frozen hardcode
    })
    .returning();

  return workflow;
}

// ── GET /api/qto-workflows/[id] ────────────────────────────────────────────────────
//
/** Fetch one workflow by id; access resolved on its parent project (no demo bypass). Raw row. */
export async function getQtoWorkflow(idParam: string) {
  return loadWorkflowAndAuthz(idParam);
}

// ── PUT /api/qto-workflows/[id] ────────────────────────────────────────────────────
//
/** Partial update. Order (frozen): load+authz → field validation (SHORT-CIRCUIT on first invalid,
 *  source order: step → schedulePageNumber → jsonb-trio 1MB → string-quad ≤1024 → exportedAt
 *  passthrough) → set updatedAt → update. Empty body touches only updatedAt. NO demo gate. Raw row. */
export async function updateQtoWorkflow(idParam: string, body: Record<string, unknown>) {
  await loadWorkflowAndAuthz(idParam); // 404 / 401 / cross-tenant-404 BEFORE any field validation

  const updates: Record<string, unknown> = {};

  if (body.step !== undefined) {
    if (typeof body.step !== "string" || !VALID_STEPS.includes(body.step)) {
      throw new ApiError("VALIDATION", "invalid step");
    }
    updates.step = body.step;
  }
  if (body.schedulePageNumber !== undefined) {
    if (
      body.schedulePageNumber !== null &&
      (!Number.isInteger(body.schedulePageNumber) || (body.schedulePageNumber as number) < 1)
    ) {
      throw new ApiError("VALIDATION", "invalid schedulePageNumber");
    }
    updates.schedulePageNumber = body.schedulePageNumber;
  }
  for (const key of ["parsedSchedule", "lineItems", "userEdits"] as const) {
    if (body[key] !== undefined) {
      if (body[key] !== null && JSON.stringify(body[key]).length > MAX_JSONB_BYTES) {
        throw new ApiError("VALIDATION", `${key} exceeds 1MB limit`);
      }
      updates[key] = body[key];
    }
  }
  // SHIP 2: dropped yoloModelFilter + tagPattern (migration 0024); added itemType + tagShapeClass.
  for (const key of ["yoloClassFilter", "materialLabel", "itemType", "tagShapeClass"] as const) {
    if (body[key] !== undefined) {
      if (body[key] !== null && (typeof body[key] !== "string" || (body[key] as string).length > MAX_STRING_LEN)) {
        throw new ApiError("VALIDATION", `invalid ${key}`);
      }
      updates[key] = body[key];
    }
  }
  if (body.exportedAt !== undefined) updates.exportedAt = body.exportedAt; // frozen: passed through unvalidated

  updates.updatedAt = new Date();

  const [updated] = await db
    .update(qtoWorkflows)
    .set(updates)
    .where(eq(qtoWorkflows.id, Number(idParam)))
    .returning();

  return updated;
}

// ── DELETE /api/qto-workflows/[id] ──────────────────────────────────────────────────
//
/** Delete a workflow by id; access on its parent project (no demo bypass). Returns {success:true}
 *  even if the row vanished between the authz fetch and the delete (TOCTOU no-op — frozen, no
 *  affected-rows check). */
export async function deleteQtoWorkflow(idParam: string) {
  await loadWorkflowAndAuthz(idParam);
  await db.delete(qtoWorkflows).where(eq(qtoWorkflows.id, Number(idParam)));
  return { success: true };
}
