// [refactor jul7 S053] admin/logs/monitor SOLO — infra health from CloudWatch + AWS Budgets,
// folded from the legacy route (git show 1460f36:src/app/api/admin/logs/monitor/route.ts).
// Char: __tests__/admin-monitor.route.test.ts (MON-*). requireRootAdmin (the shell provides
// auth:"root"). Sanctioned diffs A (flat auth → envelope) + B (the fixed catch-500 literal
// "Monitor fetch failed" RETIRED — the service lets the CloudWatch/Budgets error propagate →
// the shell renders a generic INTERNAL 500, real cause logged server-side). NO E (GET, no
// body). The 4-metric CloudWatch query + DescribeAlarms + Budgets + the full shaping +
// threshold recommendations are ported verbatim.

import {
  CloudWatchClient,
  GetMetricDataCommand,
  DescribeAlarmsCommand,
} from "@aws-sdk/client-cloudwatch";
import { BudgetsClient, DescribeBudgetsCommand } from "@aws-sdk/client-budgets";
import { cachedQuery } from "@/lib/admin-logs/query-cache";

const REGION = process.env.AWS_REGION || "us-east-1";
const ACCOUNT = process.env.AWS_ACCOUNT;

let cwClient: CloudWatchClient | null = null;
let budgetsClient: BudgetsClient | null = null;
const cw = () => (cwClient ??= new CloudWatchClient({ region: REGION }));
const budgets = () => (budgetsClient ??= new BudgetsClient({ region: REGION }));

interface DataPoint { t: string; v: number }

export async function getMonitor(): Promise<unknown> {
  const now = new Date();
  const hourAgo = new Date(now.getTime() - 60 * 60 * 1000);
  // [OWNER-CUTOVER jul23 P5.3 U5] LEGACY `blueprintparser-*` names. The live ECS cluster/service
  // are `beaver-cluster`/`beaver-app` (deploy.sh, ecs.tf), so the Monitor tab's ECS CPU/mem
  // series currently query a NONEXISTENT service and come back empty. Do NOT flip in isolation:
  // the canonical name is an OWNER ratification (P5.3), and cw-logs.ts's LOG_GROUP, env.ts's
  // CLOUDWATCH_LOG_GROUP note, and the AlarmNamePrefix below must all move in the SAME cutover.
  // Pinned by scripts/__tests__/naming-residue-pin.node-test.mjs.
  const cluster = "blueprintparser-cluster";
  const appService = "blueprintparser-app";
  // The Lambda's function_name in lambda.tf is `beaver-cv-pipeline` (only its log-group resource
  // ever carried the blueprintparser- name). CloudWatch keys Lambda metrics on FunctionName.
  const lambdaFn = "beaver-cv-pipeline";

  // [B] no try/catch — a CloudWatch/Budgets error propagates to the shell's generic INTERNAL
  // 500 (legacy returned a fixed "Monitor fetch failed" literal; retired). Parallel fetch
  // across all four CloudWatch queries + budget + alarms, memoized for 60s.
  const [metricResp, alarmsResp, budgetResp] = await cachedQuery(
    "monitor",
    60_000,
    () => Promise.all([
    cw().send(new GetMetricDataCommand({
      StartTime: hourAgo,
      EndTime: now,
      MetricDataQueries: [
        {
          Id: "ecsCpu",
          MetricStat: {
            Metric: { Namespace: "AWS/ECS", MetricName: "CPUUtilization",
              Dimensions: [
                { Name: "ClusterName", Value: cluster },
                { Name: "ServiceName", Value: appService },
              ] },
            Period: 60, Stat: "Average",
          },
        },
        {
          Id: "ecsMem",
          MetricStat: {
            Metric: { Namespace: "AWS/ECS", MetricName: "MemoryUtilization",
              Dimensions: [
                { Name: "ClusterName", Value: cluster },
                { Name: "ServiceName", Value: appService },
              ] },
            Period: 60, Stat: "Average",
          },
        },
        {
          Id: "lambdaInv",
          MetricStat: {
            Metric: { Namespace: "AWS/Lambda", MetricName: "Invocations",
              Dimensions: [{ Name: "FunctionName", Value: lambdaFn }] },
            Period: 60, Stat: "Sum",
          },
        },
        {
          Id: "lambdaThrottle",
          MetricStat: {
            Metric: { Namespace: "AWS/Lambda", MetricName: "Throttles",
              Dimensions: [{ Name: "FunctionName", Value: lambdaFn }] },
            Period: 60, Stat: "Sum",
          },
        },
      ],
    })),
    cw().send(new DescribeAlarmsCommand({
      // [OWNER-CUTOVER jul23 P5.3 U5] Legacy prefix — moves with the cluster/appService rename above.
      AlarmNamePrefix: "blueprintparser-",
    })),
    ACCOUNT
      ? budgets().send(new DescribeBudgetsCommand({ AccountId: ACCOUNT }))
      : Promise.resolve({ Budgets: [] as Array<{ BudgetName?: string; BudgetLimit?: { Amount?: string }; CalculatedSpend?: { ActualSpend?: { Amount?: string }; ForecastedSpend?: { Amount?: string } } }> }),
    ]),
  );

  const seriesOf = (id: string): DataPoint[] => {
    const res = metricResp.MetricDataResults?.find((r) => r.Id === id);
    if (!res?.Timestamps || !res?.Values) return [];
    return res.Timestamps.map((t, i) => ({
      t: t instanceof Date ? t.toISOString() : new Date(t as unknown as string).toISOString(),
      v: res.Values![i] ?? 0,
    }));
  };

  const ecsCpu = seriesOf("ecsCpu");
  const ecsMem = seriesOf("ecsMem");
  const lambdaInv = seriesOf("lambdaInv");
  const lambdaThrottle = seriesOf("lambdaThrottle");

  const avg = (s: DataPoint[]) => (s.length ? s.reduce((a, p) => a + p.v, 0) / s.length : 0);
  const sum = (s: DataPoint[]) => s.reduce((a, p) => a + p.v, 0);

  const alarms = (alarmsResp.MetricAlarms ?? []).map((a) => ({
    name: a.AlarmName ?? "",
    state: (a.StateValue ?? "INSUFFICIENT_DATA") as "OK" | "ALARM" | "INSUFFICIENT_DATA",
    reason: a.StateReason ?? "",
  }));

  const firstBudget = budgetResp.Budgets?.[0];
  const budget = firstBudget
    ? {
        name: firstBudget.BudgetName ?? "monthly",
        limitUsd: Number(firstBudget.BudgetLimit?.Amount ?? 0),
        spentUsd: Number(firstBudget.CalculatedSpend?.ActualSpend?.Amount ?? 0),
        forecastUsd: Number(firstBudget.CalculatedSpend?.ForecastedSpend?.Amount ?? 0),
      }
    : null;
  const percentUsed = budget && budget.limitUsd > 0 ? (budget.spentUsd / budget.limitUsd) * 100 : 0;

  // Recommendations — simple thresholds, surface actionable copy only.
  const recommendations: string[] = [];
  const cpuAvg = avg(ecsCpu);
  if (cpuAvg > 65) recommendations.push(`ECS CPU avg ${cpuAvg.toFixed(0)}% over last hour — consider bumping ecs_desired_count or ecs_max_count.`);
  const throttleSum = sum(lambdaThrottle);
  if (throttleSum > 0) recommendations.push(`Lambda throttled ${throttleSum} times in last hour — bump reserved_concurrent_executions above 200 or batch pages.`);
  if (budget && percentUsed > 80) recommendations.push(`Budget ${percentUsed.toFixed(0)}% spent — review demo feature kill-switches in admin.`);
  const memAvg = avg(ecsMem);
  if (memAvg > 75) recommendations.push(`ECS memory avg ${memAvg.toFixed(0)}% — consider bumping task memory from 4 GB to 8 GB in ecs.tf.`);

  return {
    ecs: {
      cpuNow: ecsCpu.at(-1)?.v ?? 0,
      cpuLast60m: ecsCpu,
      memNow: ecsMem.at(-1)?.v ?? 0,
      memLast60m: ecsMem,
    },
    lambda: {
      invocationsLast60m: sum(lambdaInv),
      invocationsSeries: lambdaInv,
      throttlesLast60m: throttleSum,
    },
    alarms,
    budget: budget ? { ...budget, percentUsed } : null,
    recommendations,
    fetchedAt: new Date().toISOString(),
  };
}
