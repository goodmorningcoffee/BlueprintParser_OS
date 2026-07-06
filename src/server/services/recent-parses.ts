// [refactor jul6 S044] admin/recent-parses SOLO — GET the in-memory ring buffer of recent
// table-parse requests + DELETE clear it, folded from the legacy route (git show
// <baseline>:src/app/api/admin/recent-parses/route.ts). Char:
// __tests__/admin-recent-parses.route.test.ts (RP-*). requireAdmin (the shell provides
// auth:"admin"). Backed by the @/lib/parse-history in-memory ring buffer (per-ECS-task, NOT
// the db). Neither handler reads a body or uses session beyond the auth gate. Sanctioned diff
// A only (flat auth errors → envelope); no body → no E; no catch-500 literal → no B.

import { getHistory, clearHistory, getMaxEntries } from "@/lib/parse-history";

export async function getRecentParses(): Promise<unknown> {
  const entries = getHistory();
  return {
    entries,
    count: entries.length,
    maxEntries: getMaxEntries(),
  };
}

export async function clearRecentParses(): Promise<unknown> {
  clearHistory();
  return { ok: true };
}
