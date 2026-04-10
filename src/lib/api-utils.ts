/**
 * api-utils.ts
 *
 * Shared API route utilities — auth checks, validation, error responses.
 * Extracts the 4-line auth pattern repeated in 56 routes into reusable functions.
 *
 * Usage:
 *   const { session, error } = await requireAuth();
 *   if (error) return error;
 *   // session is typed and guaranteed non-null
 */

import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { projects } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import type { BboxMinMax } from "@/types";

// ═══════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════

export interface AuthSession {
  user: {
    companyId: number;
    dbId: number;
    username: string;
    role: string;
    canRunModels: boolean;
    isRootAdmin: boolean;
    email?: string | null;
    name?: string | null;
  };
}

// ═══════════════════════════════════════════════════════════════════
// Auth utilities
// ═══════════════════════════════════════════════════════════════════

/**
 * Require authenticated session. Returns typed session or error response.
 */
export async function requireAuth(): Promise<
  { session: AuthSession; error: null } | { session: null; error: NextResponse }
> {
  const session = await auth();
  if (!session?.user) {
    return { session: null, error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  }
  return { session: session as unknown as AuthSession, error: null };
}

/**
 * Require admin role. Returns typed session or error response.
 */
export async function requireAdmin(): Promise<
  { session: AuthSession; error: null } | { session: null; error: NextResponse }
> {
  const session = await auth();
  if (!session?.user) {
    return { session: null, error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  }
  if (session.user.role !== "admin" && !session.user.isRootAdmin) {
    return { session: null, error: NextResponse.json({ error: "Admin only" }, { status: 403 }) };
  }
  return { session: session as unknown as AuthSession, error: null };
}

/**
 * Require root admin role. Returns typed session or error response.
 */
export async function requireRootAdmin(): Promise<
  { session: AuthSession; error: null } | { session: null; error: NextResponse }
> {
  const session = await auth();
  if (!session?.user) {
    return { session: null, error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  }
  if (!session.user.isRootAdmin) {
    return { session: null, error: NextResponse.json({ error: "Root admin only" }, { status: 403 }) };
  }
  return { session: session as unknown as AuthSession, error: null };
}

/**
 * Check if a project belongs to the user's company. Returns 404 for wrong company.
 * Skips check for demo projects and root admins.
 */
export function requireCompanyAccess(
  session: AuthSession | null,
  project: { companyId: number; isDemo: boolean },
): NextResponse | null {
  if (project.isDemo) return null; // Demo projects are public
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (session.user.isRootAdmin) return null; // Root admin can access any project
  if (session.user.companyId !== project.companyId) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  return null;
}

// ═══════════════════════════════════════════════════════════════════
// Centralized project access resolution
// ═══════════════════════════════════════════════════════════════════

export type ProjectAccessScope = "member" | "admin" | "root" | "demo";

/** Lightweight project row — excludes heavy JSONB fields (projectIntelligence, projectSummary) */
export type ProjectAccessRow = {
  id: number;
  publicId: string;
  companyId: number;
  isDemo: boolean;
  dataUrl: string | null;
  name: string;
  numPages: number | null;
  status: string;
};

type ProjectLookup = { publicId: string } | { dbId: number };

interface ProjectAccessSuccess {
  project: ProjectAccessRow;
  session: AuthSession;
  scope: ProjectAccessScope;
  error: null;
}

interface ProjectAccessDemoSuccess {
  project: ProjectAccessRow;
  session: AuthSession | null;
  scope: "demo";
  error: null;
}

interface ProjectAccessFailure {
  project: null;
  session: null;
  scope: null;
  error: NextResponse;
}

/**
 * Resolve project access in one call: authenticate, look up project, check tenancy.
 *
 * Replaces the 4-8 line auth + project lookup + companyId check pattern
 * that was duplicated across 16+ routes with inconsistent root-admin handling.
 *
 * @param lookup - Find project by `{ publicId }` (URL param) or `{ dbId }` (numeric DB id from body)
 * @param options.allowDemo - If true, demo projects are accessible without authentication
 */
export async function resolveProjectAccess(
  lookup: ProjectLookup,
  options?: { allowDemo?: boolean }
): Promise<ProjectAccessSuccess | ProjectAccessDemoSuccess | ProjectAccessFailure> {
  const session = await auth();

  // Look up project
  const where = "publicId" in lookup
    ? eq(projects.publicId, lookup.publicId)
    : eq(projects.id, lookup.dbId);

  // Select only lightweight fields — excludes projectIntelligence (50-200KB JSONB),
  // projectSummary, and other heavy columns. Routes that need those fields (e.g. chat)
  // should fetch them separately using project.id after access is verified.
  const [project] = await db.select({
    id: projects.id,
    publicId: projects.publicId,
    companyId: projects.companyId,
    isDemo: projects.isDemo,
    dataUrl: projects.dataUrl,
    name: projects.name,
    numPages: projects.numPages,
    status: projects.status,
  }).from(projects).where(where).limit(1);

  if (!project) {
    return { project: null, session: null, scope: null, error: apiError("Not found", 404) };
  }

  // Demo projects: accessible without auth when allowDemo is set
  if (project.isDemo && options?.allowDemo) {
    return {
      project,
      session: session?.user ? (session as unknown as AuthSession) : null,
      scope: "demo" as const,
      error: null,
    };
  }

  // Non-demo: require authentication
  if (!session?.user) {
    return { project: null, session: null, scope: null, error: apiError("Unauthorized", 401) };
  }

  const typedSession = session as unknown as AuthSession;

  // Root admin: access any project
  if (typedSession.user.isRootAdmin) {
    return { project, session: typedSession, scope: "root", error: null };
  }

  // Company member/admin: must match company
  if (typedSession.user.companyId !== project.companyId) {
    return { project: null, session: null, scope: null, error: apiError("Not found", 404) };
  }

  const scope: ProjectAccessScope = typedSession.user.role === "admin" ? "admin" : "member";
  return { project, session: typedSession, scope, error: null };
}

/**
 * Check project access when you already have the project row (Pattern C: indirect lookup).
 * Use when the route first fetches a child entity (annotation, takeoff item, etc.)
 * and then needs to verify the user can access the parent project.
 *
 * @param project - Must include at least { isDemo, companyId }
 * @param options.allowDemo - If true, demo projects are accessible without authentication
 */
export async function checkProjectAccess(
  project: { isDemo: boolean; companyId: number },
  options?: { allowDemo?: boolean }
): Promise<
  | { session: AuthSession; scope: ProjectAccessScope; error: null }
  | { session: AuthSession | null; scope: "demo"; error: null }
  | { session: null; scope: null; error: NextResponse }
> {
  const session = await auth();

  if (project.isDemo && options?.allowDemo) {
    return {
      session: session?.user ? (session as unknown as AuthSession) : null,
      scope: "demo" as const,
      error: null,
    };
  }

  if (!session?.user) {
    return { session: null, scope: null, error: apiError("Unauthorized", 401) };
  }

  const typedSession = session as unknown as AuthSession;

  if (typedSession.user.isRootAdmin) {
    return { session: typedSession, scope: "root", error: null };
  }

  if (typedSession.user.companyId !== project.companyId) {
    return { session: null, scope: null, error: apiError("Not found", 404) };
  }

  const scope: ProjectAccessScope = typedSession.user.role === "admin" ? "admin" : "member";
  return { session: typedSession, scope, error: null };
}

// ═══════════════════════════════════════════════════════════════════
// Validation utilities
// ═══════════════════════════════════════════════════════════════════

/**
 * Validate and parse a MinMax bbox from request body.
 * Returns typed bbox or error response.
 */
export function parseBboxMinMax(
  bbox: unknown,
): { bbox: BboxMinMax; error: null } | { bbox: null; error: NextResponse } {
  if (!Array.isArray(bbox) || bbox.length !== 4) {
    return { bbox: null, error: NextResponse.json({ error: "bbox must be a 4-element array" }, { status: 400 }) };
  }

  const [a, b, c, d] = bbox;
  if (![a, b, c, d].every((v) => typeof v === "number" && isFinite(v) && v >= 0 && v <= 1)) {
    return { bbox: null, error: NextResponse.json({ error: "bbox values must be finite numbers in [0, 1]" }, { status: 400 }) };
  }

  if (a >= c || b >= d) {
    return { bbox: null, error: NextResponse.json({ error: "bbox: minX must be < maxX and minY must be < maxY" }, { status: 400 }) };
  }

  return { bbox: [a, b, c, d] as BboxMinMax, error: null };
}

// ═══════════════════════════════════════════════════════════════════
// Error utilities
// ═══════════════════════════════════════════════════════════════════

/**
 * Create a standardized error response.
 */
export function apiError(message: string, status: number = 500): NextResponse {
  return NextResponse.json({ error: message }, { status });
}
