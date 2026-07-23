// @vitest-environment node
// [refactor jul23 P5.4-E] FREEZE — locks the TTL janitor's sweep SQL against a
// fake db (no real DB touched). The exact WHERE clauses ARE the contract: they
// mirror the in-memory sweeps they replace (runtime_counters window close;
// login_lockouts 2h-idle-only so the count survives an expired lockout; only
// EXPIRED AUTO manual_ip_bans; op_log newest-N retention). scripts/
// run-state-janitor.mjs mirrors these verbatim (raw-node can't import TS).
import { describe, expect, it, vi } from "vitest";
import {
  sweepRuntimeState,
  OP_LOG_RETENTION,
  type JanitorClient,
} from "@/lib/runtime-state-janitor";

function fakeClient(rowCounts: number[]): {
  client: JanitorClient;
  calls: Array<{ sql: string; params?: unknown[] }>;
} {
  const calls: Array<{ sql: string; params?: unknown[] }> = [];
  let i = 0;
  const client: JanitorClient = {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params });
      return { rowCount: rowCounts[i++] ?? 0 };
    }),
  };
  return { client, calls };
}

describe("runtime-state janitor sweep (freeze)", () => {
  it("issues exactly the four TTL sweeps, in order, with the frozen SQL", async () => {
    const { client, calls } = fakeClient([3, 1, 2, 7]);
    const result = await sweepRuntimeState(client);

    expect(calls.map((c) => c.sql)).toEqual([
      "DELETE FROM runtime_counters WHERE reset_at < now()",
      "DELETE FROM login_lockouts WHERE last_attempt < now() - interval '2 hours'",
      "DELETE FROM manual_ip_bans WHERE source = 'auto' AND banned_until IS NOT NULL AND banned_until < now()",
      "DELETE FROM op_log WHERE id NOT IN (SELECT id FROM op_log ORDER BY created_at DESC, id DESC LIMIT $1)",
    ]);
    expect(result).toEqual({
      runtimeCounters: 3,
      loginLockouts: 1,
      autoBans: 2,
      opLog: 7,
    });
  });

  it("sweeps runtime_counters strictly on window-close (reset_at < now())", async () => {
    const { client, calls } = fakeClient([0, 0, 0, 0]);
    await sweepRuntimeState(client);
    expect(calls[0].sql).toBe(
      "DELETE FROM runtime_counters WHERE reset_at < now()",
    );
  });

  it("retains the newest OP_LOG_RETENTION op_log rows", async () => {
    const { client, calls } = fakeClient([0, 0, 0, 0]);
    await sweepRuntimeState(client);
    const opLogCall = calls[3];
    expect(opLogCall.params).toEqual([OP_LOG_RETENTION]);
    expect(OP_LOG_RETENTION).toBe(500);
  });

  it("only sweeps EXPIRED AUTO bans, never manual or permanent rows", async () => {
    const { client, calls } = fakeClient([0, 0, 0, 0]);
    await sweepRuntimeState(client);
    expect(calls[2].sql).toContain("source = 'auto'");
    expect(calls[2].sql).toContain("banned_until IS NOT NULL");
    expect(calls[2].sql).toContain("banned_until < now()");
  });

  it("keeps login_lockout entries until 2h idle (count survives expired lockout)", async () => {
    const { client, calls } = fakeClient([0, 0, 0, 0]);
    await sweepRuntimeState(client);
    expect(calls[1].sql).toBe(
      "DELETE FROM login_lockouts WHERE last_attempt < now() - interval '2 hours'",
    );
    // Must NOT delete on locked_until expiry — that would reset escalation.
    expect(calls[1].sql).not.toContain("locked_until");
  });

  it("tolerates null rowCount by reporting zero", async () => {
    const calls: string[] = [];
    const client: JanitorClient = {
      query: async (sql: string) => {
        calls.push(sql);
        return { rowCount: null };
      },
    };
    const result = await sweepRuntimeState(client);
    expect(result).toEqual({
      runtimeCounters: 0,
      loginLockouts: 0,
      autoBans: 0,
      opLog: 0,
    });
  });
});
