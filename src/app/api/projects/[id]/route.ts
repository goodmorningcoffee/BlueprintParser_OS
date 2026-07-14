// [refactor jun17 P1.3] Thin shell — behavior in services/projects.ts. All three handlers are
// auth:"session" + a MANUAL full-row lookup in the service (loadProjectWithRootBypass): the lightweight
// resolveProjectAccess row omits projectIntelligence/address/jobId these handlers read, AND projects/[id]
// allows root cross-company bypass (the mirror of qto-GET, which used a manual lookup to DENY it). The
// shell's auth:"session" 401s signed-out callers before the lookup (401-before-404); a non-uuid id → clean
// 400 via zPublicId inside the service (was a pg-uuid-cast 500). PUT body is zLooseBody (the service does
// its own merge); DELETE takes no body and goes through the P0-G4 transactional deleteProjectFully.
import { defineRoute } from "@/server/api/defineRoute";
import { zLooseBody } from "@/server/api/schemas";
import { deleteProject, getProject, updateProject } from "@/server/services/projects";

export const GET = defineRoute({
  auth: "session",
  handler: ({ params, session }) => getProject(params.id, session!),
});

export const PUT = defineRoute({
  // Demo visibility is enabled solely so the service can apply the canonical all-role
  // read-only denial before any mutation. Private projects still require a scoped session.
  auth: { project: { param: "id", allowDemo: true } },
  body: zLooseBody,
  handler: ({ params, body, session, project }) => updateProject(params.id, body, session, project!),
});

export const DELETE = defineRoute({
  auth: { project: { param: "id", allowDemo: true } },
  handler: ({ params, session, project }) => deleteProject(params.id, session, project!),
});
