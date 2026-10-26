// [refactor jul6 S044] admin/recent-parses SOLO — GET the recent table-parse requests + DELETE
// clear them, folded from the legacy route (git show
// <baseline>:src/app/api/admin/recent-parses/route.ts). Char:
// __tests__/admin-recent-parses.route.test.ts (RP-*). Root only (the shell provides auth:"root";
// TP-1 WP-1.C, K08: the history spans every company). Backed by @/lib/parse-history, which since [refactor jul23 P5.4-C] is the shared
// Postgres `op_log` table (migration 0039) and NOT a per-ECS-task ring buffer — every task now
// sees the same history. Neither handler reads a body or uses session beyond the auth gate.
// Sanctioned diff A only (flat auth errors → envelope); no body → no E; no catch-500 literal → no B.

import { getHistory, clearHistory, getMaxEntries } from "@/lib/parse-history";

export async function getRecentParses(): Promise<unknown> {
  // [refactor jul23 P5.4-C] getHistory/clearHistory are now async (op_log-backed).
  const entries = await getHistory();
  return {
    entries,
    count: entries.length,
    maxEntries: getMaxEntries(),
  };
}

export async function clearRecentParses(): Promise<unknown> {
  await clearHistory();
  return { ok: true };
}
