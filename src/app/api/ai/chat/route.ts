import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { resolveProjectAccess } from "@/lib/api-utils";
import { db } from "@/lib/db";
import { chatMessages } from "@/lib/db/schema";
import { eq, and, isNull } from "drizzle-orm";
import { checkChatQuota, checkDemoChatQuota } from "@/lib/quotas";
import { handleGlobalChat } from "@/lib/services/chat/global";
import { handleScopedChat } from "@/lib/services/chat/scoped";

export async function POST(req: Request) {
  const session = await auth();
  const { projectId, pageNumber, message, scope } = await req.json();

  if (!message) {
    return NextResponse.json({ error: "message required" }, { status: 400 });
  }

  // ─── Global RAG scope — search across all user's projects ───
  if (scope === "global" && session?.user) {
    const quota = await checkChatQuota(session.user.companyId);
    if (!quota.allowed) {
      return NextResponse.json({ error: quota.message }, { status: 429 });
    }
    return handleGlobalChat({ user: session.user }, message);
  }

  // ─── Page/Project scope ─────────────────────────────────────
  if (!projectId) {
    return NextResponse.json({ error: "projectId required" }, { status: 400 });
  }

  const access = await resolveProjectAccess({ publicId: projectId }, { allowDemo: true });
  if (access.error) return access.error;
  const { project } = access;
  const isDemo = access.scope === "demo";

  // Quota check
  if (isDemo) {
    const quota = await checkDemoChatQuota();
    if (!quota.allowed) {
      return NextResponse.json({ error: quota.message }, { status: 429 });
    }
  } else {
    const quota = await checkChatQuota(access.session!.user.companyId);
    if (!quota.allowed) {
      return NextResponse.json({ error: quota.message }, { status: 429 });
    }
  }

  return handleScopedChat({
    project,
    message,
    scope,
    pageNumber,
    session: access.session,
    isDemo,
  });
}

/**
 * DELETE /api/ai/chat — Clear chat messages for a project
 */
export async function DELETE(req: Request) {
  const url = new URL(req.url);
  const projectId = url.searchParams.get("projectId");
  const scope = url.searchParams.get("scope") || "all";
  const pageNum = url.searchParams.get("pageNumber");

  if (!projectId) {
    return NextResponse.json({ error: "projectId required" }, { status: 400 });
  }

  const access = await resolveProjectAccess({ publicId: projectId });
  if (access.error) return access.error;
  const { project } = access;

  let conditions = [eq(chatMessages.projectId, project.id)];

  if (scope === "page" && pageNum) {
    conditions.push(eq(chatMessages.pageNumber, parseInt(pageNum)));
  } else if (scope === "project") {
    conditions.push(isNull(chatMessages.pageNumber));
  }

  await db.delete(chatMessages).where(and(...conditions));

  return NextResponse.json({ success: true });
}
