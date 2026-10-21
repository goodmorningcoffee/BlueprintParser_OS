// [refactor jul5 S025] /api/ai/chat route contract, folded from the legacy fat route
// (git show ba7cfee^:src/app/api/ai/chat/route.ts). The SECOND streaming fold (S024
// symbol-search precedent). The chat ENGINES are BYTE-UNTOUCHED by this fold and stay
// where they were: @/lib/services/chat/global + scoped (context assembly, tool-use SSE),
// @/lib/llm/stream (Path-A SSE). This service owns ONLY what the route file owned:
// the validation cascade, the global/scoped dispatch, access, demo gate, quotas, and
// the DELETE. Frozen quirks (char file: __tests__/ai-chat.route.test.ts, 34 cases):
//
//   FC-1  cascade order: message-400 → [global branch] → projectId-400 → access
//         (miss-404 BEFORE auth / non-demo-anon-401 / cross-tenant-404) → demo gate 403
//         → quota 429 → dispatch. Validate-before-auth: shell auth is "none".
//   FC-2  `!message` is a FALSY check — "", 0, null all → "message required".
//   FC-3  isDemo = project.isDemo, independent of caller scope. Same-company members/root therefore
//         use demo quota and read-only/no-persist chat policy too. This deliberate P2 security repair
//         supersedes the legacy scope-derived carve-out and now matches the canonical demo boundary.
//   FC-4  scope:"global" while signed out falls THROUGH the global branch (session?.user
//         guard) into the scoped path → "projectId required" 400.
//   FC-6  quota sources: global = session.user.companyId; scoped non-demo =
//         access.session!.user.companyId (the AUTHED user's company, NOT the project's —
//         matters for root cross-company); scoped demo = checkDemoChatQuota() (global
//         counter). quota.message || "Rate limit exceeded" on all three. Owner ruling
//         2026-10-21: a root admin is exempt from all three (the demo pool is neither checked
//         nor consumed for him) and per-user/company overrides apply (see lib/quota-overrides).
//   FC-7  delegated Responses ride the shell's instanceof-Response passthrough and stay
//         FLAT {error:string}: demo-gate 403 (demo-features.ts owns that shape — labeling
//         FQ-8 precedent), 503 "No LLM configured…" (global.ts Response.json + scoped.ts
//         apiError), 400 "Provider does not support tool use". They flip only when their
//         OWNING modules migrate. Do NOT envelope them here.
//   FC-8/FC-9  ALL in-stream SSE bytes (Path A error-then-[DONE]; Path B extra {action}
//         line, error-with-NO-[DONE] asymmetry, assistant userId:null) live in the
//         engines — invisible to shell + service, zero-diff by construction.
//   FC-10 DELETE: searchParams not body; NO allowDemo (demo anon → 401); parseInt with
//         NO radix — pageNumber "abc" → NaN → pg int-cast throw → shell generic INTERNAL
//         500 (sanctioned diff B; a NaN guard would be an UNSANCTIONED 500→4xx flip);
//         any scope other than "page"/"project" (incl. default "all") deletes ALL of the
//         project's chat rows.
//   FC-11 persistence matrix lives in the engines (global never saves the user message).
//
// Sanctioned diffs vs legacy (everything else byte-faithful):
//   A  route-level flat {error:string} → ApiError envelope; messages byte-verbatim
//      ("message required" / "projectId required" / "Unauthorized" / "Not found" /
//      quota messages + "Rate limit exceeded" fallback).
//   B  legacy raw rejections (non-uuid projectId pg-cast; DELETE NaN pg-cast; any
//      unexpected throw) → shell generic INTERNAL 500. Legacy had NO catch-all here, so
//      nothing leaked before; B is Next-default-500 → structured leak-free 500.
//   E  body parse: malformed → 400 BAD_REQUEST; empty/null/primitive/array → 400
//      VALIDATION (legacy: raw 500s, or destructure-to-undefined → "message required").
//   E2 the shell parses DELETE bodies → non-empty malformed DELETE body 400s (legacy
//      ignored it; unreachable from the fire-and-forget consumer; S020 precedent).
//   DECLINED: zPublicId pre-validation on projectId (would flip the pg-cast 500 → 400).

import { auth } from "@/lib/auth";
import { chatMessages } from "@/lib/db/schema";
import { eq, and, isNull } from "drizzle-orm";
import type { AuthSession } from "@/lib/api-utils";
import { assertDemoFeatureEnabled } from "@/lib/demo-features";
import { checkChatQuota, checkDemoChatQuota } from "@/lib/quotas";
import { handleGlobalChat } from "@/lib/services/chat/global";
import { handleScopedChat } from "@/lib/services/chat/scoped";
import { ApiError } from "@/server/api/envelope";
import {
  assertProjectWritable,
  resolveProjectOrThrow,
  resolveWritableProjectOrThrow,
} from "@/server/api/access";
import { withProjectWrite } from "@/server/api/project-write-capability";

/**
 * POST /api/ai/chat — global (cross-project RAG) or page/project-scoped chat.
 * Returns the engine's SSE Response (rides the shell passthrough) or the demo-gate
 * NextResponse verbatim; throws ApiError for the route-level cascade (diff A).
 */
export async function chatPost(rawBody: Record<string, unknown>): Promise<Response> {
  const session = (await auth()) as unknown as AuthSession | null;
  // Field types deliberately un-narrowed: legacy destructured `await req.json()` (any) and
  // passed values through as-is; odd types must keep flowing identically (e.g. numeric
  // scope ≠ "page" → project scope; numeric projectId → pg cast throw → diff B).
  const { projectId, pageNumber, message, scope } = rawBody as {
    projectId?: string;
    pageNumber?: number;
    message?: string;
    scope?: string;
  };

  if (!message) {
    throw new ApiError("VALIDATION", "message required"); // FC-2 falsy check
  }

  // ─── Global RAG scope — search across all user's projects ─── (FC-4: anon falls through)
  if (scope === "global" && session?.user) {
    const quota = await checkChatQuota(session.user.companyId, session.user.isRootAdmin, session.user.dbId);
    if (!quota.allowed) {
      throw new ApiError("RATE_LIMITED", quota.message || "Rate limit exceeded");
    }
    return handleGlobalChat({ user: session.user }, message);
  }

  // ─── Page/Project scope ─────────────────────────────────────
  if (!projectId) {
    throw new ApiError("VALIDATION", "projectId required");
  }

  const access = await resolveProjectOrThrow({ publicId: projectId }, { allowDemo: true });
  const { project } = access;
  // Demo immutability is a property of the canonical project, never of the caller's scope.
  // Same-company members/admins and root therefore share the public demo policy.
  const isDemo = project.isDemo;
  const noPersist = isDemo;
  const writeCapability = noPersist ? undefined : assertProjectWritable(project);

  if (isDemo) {
    const gate = await assertDemoFeatureEnabled(project.companyId, "chat");
    if (gate) return gate; // FC-7: flat 403 passthrough, does NOT flip here
  }

  // Quota check (FC-6)
  if (isDemo) {
    const quota = await checkDemoChatQuota(session?.user?.isRootAdmin === true);
    if (!quota.allowed) {
      throw new ApiError("RATE_LIMITED", quota.message || "Rate limit exceeded");
    }
  } else {
    const authed = access.session!.user;
    const quota = await checkChatQuota(authed.companyId, authed.isRootAdmin, authed.dbId);
    if (!quota.allowed) {
      throw new ApiError("RATE_LIMITED", quota.message || "Rate limit exceeded");
    }
  }

  return handleScopedChat({
    project,
    message,
    scope: scope as string,
    pageNumber,
    session: access.session,
    isDemo,
    writeCapability,
  });
}

/**
 * DELETE /api/ai/chat — clear chat messages for a project (FC-10).
 * Returns the legacy success body; the shell wraps it as NextResponse.json → identical bytes.
 */
export async function chatDelete(req: Request): Promise<{ success: true }> {
  const url = new URL(req.url);
  const projectId = url.searchParams.get("projectId");
  const scope = url.searchParams.get("scope") || "all";
  const pageNum = url.searchParams.get("pageNumber");

  if (!projectId) {
    throw new ApiError("VALIDATION", "projectId required");
  }

  const { project, writeCapability } = await resolveWritableProjectOrThrow({ publicId: projectId });

  const conditions = [eq(chatMessages.projectId, project.id)];

  if (scope === "page" && pageNum) {
    conditions.push(eq(chatMessages.pageNumber, parseInt(pageNum))); // NO radix — frozen (FC-10)
  } else if (scope === "project") {
    conditions.push(isNull(chatMessages.pageNumber));
  }

  await withProjectWrite(writeCapability, project.id, async (tx) => {
    await tx.delete(chatMessages).where(and(...conditions));
  });

  return { success: true };
}
