import { NextResponse } from "next/server";
import { requireRootAdmin } from "@/lib/api-utils";
import {
  CloudWatchClient,
  GetMetricDataCommand,
  DescribeAlarmsCommand,
} from "@aws-sdk/client-cloudwatch";
import { BudgetsClient, DescribeBudgetsCommand } from "@aws-sdk/client-budgets";
import { logger } from "@/lib/logger";

/**
 * GET /api/admin/logs/monitor
 *
 * Pulls infra health signals from CloudWatch + AWS Budgets. All free-tier
 * friendly: GetMetricData has a 1M free call/month allowance and
 * DescribeAlarms + DescribeBudgets are free.
 *
 * The Monitor subtab is refresh-only by user preference (no polling).
 * Recommendations are derived from current metric values to surface
 * "should I bump resources?" prompts.
 */

const REGION = process.env.AWS_REGION || "us-east-1";
const ACCOUNT = process.env.AWS_ACCOUNT;

let cwClient: CloudWatchClient | null = null;
let budgetsClient: BudgetsClient | null = null;
const cw = () => (cwClient ??= new CloudWatchClient({ region: REGION }));
const budgets = () => (budgetsClient ??= new BudgetsClient({ region: REGION }));

interface DataPoint { t: string; v: number }

export async function GET() {
  const { error } = await requireRootAdmin();
  if (error) return error;

  const now = new Date();
  const hourAgo = new Date(now.getTime() - 60 * 60 * 1000);
  const cluster = "blueprintparser-cluster";
  const appService = "blueprintparser-app";
  const lambdaFn = "blueprintparser-cv-pipeline";

  try {
    // Parallel fetch across all four CloudWatch queries + budget + alarms.
    const [metricResp, alarmsResp, budgetResp] = await Promise.all([
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
        AlarmNamePrefix: "blueprintparser-",
      })),
      ACCOUNT
        ? budgets().send(new DescribeBudgetsCommand({ AccountId: ACCOUNT }))
        : Promise.resolve({ Budgets: [] as Array<{ BudgetName?: string; BudgetLimit?: { Amount?: string }; CalculatedSpend?: { ActualSpend?: { Amount?: string }; ForecastedSpend?: { Amount?: string } } }> }),
    ]);

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

    return NextResponse.json({
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
    });
  } catch (err) {
    logger.error("[admin/logs/monitor] fetch failed", err);
    return NextResponse.json({ error: "Monitor fetch failed" }, { status: 500 });
  }
}
