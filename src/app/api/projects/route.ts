// [refactor jun17 P1.3] Thin shell — behavior in services/projects.ts. BOTH handlers are auth-FIRST
// (legacy used requireAuth() BEFORE reading the body), so they are auth:"session" — UNLIKE the
// validate-before-auth create POSTs of families 1-3. POST uses zLooseBody so the service can run its own
// imperative field validation (company-prefix dataUrl guard, quota, staging manifest) with the exact legacy
// messages, all firing AFTER the shell's 401. GET returns a bare array of the caller-visible projects.
import { defineRoute } from "@/server/api/defineRoute";
import { zLooseBody } from "@/server/api/schemas";
import { createProject, listProjects } from "@/server/services/projects";

export const POST = defineRoute({
  auth: "session",
  body: zLooseBody,
  // session is non-null under auth:"session" (the shell throws UNAUTHORIZED before the handler runs).
  handler: ({ body, session }) => createProject(body, session!),
});

export const GET = defineRoute({
  auth: "session",
  handler: ({ session }) => listProjects(session!),
});
