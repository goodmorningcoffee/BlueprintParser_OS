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
  const user = session.user as any;
  if (user.role !== "admin" && !user.isRootAdmin) {
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
  if (!(session.user as any).isRootAdmin) {
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
