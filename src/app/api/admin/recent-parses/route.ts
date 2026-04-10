/**
 * /api/admin/recent-parses
 *
 * Phase I.2.c: Read the in-memory ring buffer of recent table-parse requests
 * for the admin debug UI. Returns the last N parses with FULL methodResults
 * including subprocess stderr, intermediate state, and timing.
 *
 * GET    → list all entries in the ring buffer (newest first)
 * DELETE → clear the ring buffer
 *
 * Multi-replica ECS gotcha: each task has its own buffer. The admin page may
 * see different "recent parses" depending on which task served the request.
 * Acceptable for MVP.
 */
import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/api-utils";
import { getHistory, clearHistory, getMaxEntries } from "@/lib/parse-history";

export async function GET() {
  const { error } = await requireAdmin();
  if (error) return error;

  const entries = getHistory();
  return NextResponse.json({
    entries,
    count: entries.length,
    maxEntries: getMaxEntries(),
  });
}

export async function DELETE() {
  const { error } = await requireAdmin();
  if (error) return error;

  clearHistory();
  return NextResponse.json({ ok: true });
}
