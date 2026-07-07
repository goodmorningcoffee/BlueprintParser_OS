// @vitest-environment node
// [refactor jul7 S053] CHARACTERIZATION for admin/logs/monitor SOLO (GET — infra health from
// CloudWatch + Budgets), written as THE FREEZE before the fold onto services/admin-monitor.ts.
// Solo. requireRootAdmin (root-only). Frozen quirk inventory:
//   • cachedQuery("monitor",60s, Promise.all([cw GetMetricData(4 metrics), cw DescribeAlarms,
//     ACCOUNT?budgets DescribeBudgets:{Budgets:[]}])) → shape {ecs{cpuNow,cpuLast60m,memNow,
//     memLast60m}, lambda{invocationsLast60m,invocationsSeries,throttlesLast60m}, alarms[]
//     {name,state,reason}, budget|null (+percentUsed), recommendations[] (threshold copy),
//     fetchedAt ISO}. seriesOf maps Timestamps→{t:ISO,v}. avg/sum derivations.
//   • recommendations: cpuAvg>65, throttleSum>0, budget%>80, memAvg>75.
//   • catch → {error:"Monitor fetch failed"} @500 (FIXED literal, no err leak) → generic B.
// GET no body → ZERO E. Sanctioned diffs A (auth) + B (fixed catch-500). AWS SDKs +
// query-cache mocked; Date (now/fetchedAt) non-deterministic → assert shape not exact.
// Assertions tagged [S053 fold] flip in the fold commit.
import { describe, expect, inject, it, beforeEach, vi } from "vitest";

vi.mock("@/lib/auth", async () => {
  const { sessionState } = await import("@/test/harness");
  return { auth: async () => sessionState.current };
});

const h = vi.hoisted(() => ({ cwSend: vi.fn(), budgetSend: vi.fn() }));
vi.mock("@aws-sdk/client-cloudwatch", () => ({
  CloudWatchClient: class { send = h.cwSend; },
  GetMetricDataCommand: class { _t = "metric"; constructor(public input: unknown) {} },
  DescribeAlarmsCommand: class { _t = "alarms"; constructor(public input: unknown) {} },
}));
vi.mock("@aws-sdk/client-budgets", () => ({
  BudgetsClient: class { send = h.budgetSend; },
  DescribeBudgetsCommand: class { constructor(public input: unknown) {} },
}));
vi.mock("@/lib/admin-logs/query-cache", () => ({
  cachedQuery: (_k: string, _ttl: number, fn: () => unknown) => fn(),
}));

import { GET as monGET } from "@/app/api/admin/logs/monitor/route";
import { asUser, createCompany, createUser, makeReq, readJson, signedOut } from "@/test/harness";

const dbUp = inject("dbUp") as boolean;

async function makeWorld() {
  const company = await createCompany();
  const root = await createUser(company.id, { isRootAdmin: true });
  const admin = await createUser(company.id, { role: "admin" });
  return { root, admin };
}

const req = () => makeReq("/api/admin/logs/monitor", { method: "GET" });
const UNAUTH = { error: "Unauthorized" }; // [S053 fold: A → {error:{code:"UNAUTHORIZED",message:"Unauthorized"}}]
const ROOT_ONLY = { error: "Root admin only" }; // [S053 fold: A → {error:{code:"FORBIDDEN",message:"Root admin only"}}]

const ts = [new Date("2026-07-01T00:00:00Z"), new Date("2026-07-01T00:01:00Z")];
const METRIC_RESP = {
  MetricDataResults: [
    { Id: "ecsCpu", Timestamps: ts, Values: [60, 70] }, // avg 65 (>65 is false; use 70,80 to trigger)
    { Id: "ecsMem", Timestamps: ts, Values: [40, 50] },
    { Id: "lambdaInv", Timestamps: ts, Values: [10, 5] },
    { Id: "lambdaThrottle", Timestamps: ts, Values: [0, 3] }, // sum 3 → throttle rec
  ],
};
const ALARMS_RESP = { MetricAlarms: [{ AlarmName: "blueprintparser-cpu", StateValue: "ALARM", StateReason: "high" }] };

beforeEach(() => {
  vi.clearAllMocks();
  signedOut();
  h.cwSend.mockImplementation((cmd: { _t?: string }) => Promise.resolve(cmd?._t === "alarms" ? ALARMS_RESP : METRIC_RESP));
  h.budgetSend.mockResolvedValue({ Budgets: [] });
});

describe.skipIf(!dbUp)("admin/logs/monitor (MON)", () => {
  it("MON-1 auth: signed-out→401, company-admin→403 (root-only), root→200", async () => {
    const { root, admin } = await makeWorld();
    let r = await readJson(await monGET(req()));
    expect(r.status).toBe(401);
    expect(r.body).toEqual(UNAUTH); // [S053 fold: A]
    asUser(admin); // company-admin still 403 — root-only route
    r = await readJson(await monGET(req()));
    expect(r.status).toBe(403);
    expect(r.body).toEqual(ROOT_ONLY); // [S053 fold: A]
    asUser(root);
    expect((await readJson(await monGET(req()))).status).toBe(200);
  });

  it("MON-2 shape: ecs/lambda series + alarms + budget-null + fetchedAt", async () => {
    const { root } = await makeWorld();
    asUser(root);
    const r = await readJson(await monGET(req()));
    expect(r.status).toBe(200);
    expect(r.body.ecs).toMatchObject({ cpuNow: 70, memNow: 50 }); // .at(-1).v
    expect(r.body.ecs.cpuLast60m).toEqual([
      { t: "2026-07-01T00:00:00.000Z", v: 60 },
      { t: "2026-07-01T00:01:00.000Z", v: 70 },
    ]);
    expect(r.body.lambda).toMatchObject({ invocationsLast60m: 15, throttlesLast60m: 3 }); // sum
    expect(r.body.alarms).toEqual([{ name: "blueprintparser-cpu", state: "ALARM", reason: "high" }]);
    expect(r.body.budget).toBeNull(); // no AWS_ACCOUNT env → {Budgets:[]} → null
    expect(typeof r.body.fetchedAt).toBe("string"); // ISO, non-deterministic
  });

  it("MON-3 recommendations: high CPU (>65) + throttles (>0) → threshold copy", async () => {
    const { root } = await makeWorld();
    asUser(root);
    // cpu avg 75 (>65), throttle sum 3 (>0)
    h.cwSend.mockImplementation((cmd: { _t?: string }) => Promise.resolve(cmd?._t === "alarms" ? ALARMS_RESP : {
      MetricDataResults: [
        { Id: "ecsCpu", Timestamps: ts, Values: [70, 80] }, // avg 75
        { Id: "ecsMem", Timestamps: ts, Values: [40, 50] },
        { Id: "lambdaInv", Timestamps: ts, Values: [10, 5] },
        { Id: "lambdaThrottle", Timestamps: ts, Values: [0, 3] },
      ],
    }));
    const r = await readJson(await monGET(req()));
    expect(r.body.recommendations.some((s: string) => s.includes("ECS CPU avg 75%"))).toBe(true);
    expect(r.body.recommendations.some((s: string) => s.includes("Lambda throttled 3 times"))).toBe(true);
  });

  it("MON-4 catch: an AWS error → 500 'Monitor fetch failed' (fixed literal, no leak)", async () => {
    // [S053 fold: B — fixed catch-500 literal → generic INTERNAL 500]
    const { root } = await makeWorld();
    asUser(root);
    h.cwSend.mockRejectedValue(new Error("AccessDenied cloudwatch:GetMetricData"));
    const r = await readJson(await monGET(req()));
    expect(r.status).toBe(500);
    expect(r.body).toEqual({ error: "Monitor fetch failed" }); // [S053 fold: B — → generic INTERNAL]
  });
});
