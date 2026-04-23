import {
  CloudWatchLogsClient,
  StartQueryCommand,
  GetQueryResultsCommand,
  DescribeLogStreamsCommand,
} from "@aws-sdk/client-cloudwatch-logs";
import { logger } from "@/lib/logger";

/**
 * CloudWatch Logs Insights client for the Admin Logs tab.
 *
 * All queries hit the `/ecs/blueprintparser-app` log group (created by
 * `infrastructure/terraform/ecs.tf:34`). Queries are async on AWS's side:
 * we StartQuery, poll GetQueryResults until status is "Complete", return
 * the row array. Polling interval is 500ms up to a 15s ceiling — Insights
 * typically returns within 2–5s for the data volumes we'll see.
 *
 * Costs (us-east-1 as of 2026): $0.005 per GB of log data scanned per query.
 * Our daily visitor log volume is 100–500 MB, so a 24h query is ~$0.0025.
 * A monthly Admin Logs tab usage pattern of 10 queries/day → ~$1.50/mo total.
 */

const LOG_GROUP = process.env.CLOUDWATCH_LOG_GROUP || "/ecs/blueprintparser-app";

let client: CloudWatchLogsClient | null = null;
function getClient(): CloudWatchLogsClient {
  if (!client) {
    client = new CloudWatchLogsClient({
      region: process.env.AWS_REGION || "us-east-1",
    });
  }
  return client;
}

export interface InsightsWindow {
  /** "1h" | "24h" | "7d" | "30d" — mapped to an absolute (startTs, endTs) pair. */
  range: "1h" | "24h" | "7d" | "30d";
}

function windowBounds(w: InsightsWindow): { startSec: number; endSec: number } {
  const now = Math.floor(Date.now() / 1000);
  const hourSec = 3600;
  const span = {
    "1h": hourSec,
    "24h": 24 * hourSec,
    "7d": 7 * 24 * hourSec,
    "30d": 30 * 24 * hourSec,
  }[w.range];
  return { startSec: now - span, endSec: now };
}

/**
 * Run an Insights query string against our ECS log group and return the
 * parsed rows. Each row is a `Record<fieldName, string>`. Throws if the
 * query errors out on AWS's side; returns [] if no results.
 */
export async function runInsightsQuery(
  queryString: string,
  window: InsightsWindow,
  options?: { limit?: number; pollIntervalMs?: number; maxWaitMs?: number },
): Promise<Record<string, string>[]> {
  const { startSec, endSec } = windowBounds(window);
  const pollIntervalMs = options?.pollIntervalMs ?? 500;
  const maxWaitMs = options?.maxWaitMs ?? 15_000;

  const cmd = new StartQueryCommand({
    logGroupName: LOG_GROUP,
    startTime: startSec,
    endTime: endSec,
    queryString,
    limit: options?.limit ?? 100,
  });
  const { queryId } = await getClient().send(cmd);
  if (!queryId) throw new Error("Insights query did not return a queryId");

  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, pollIntervalMs));
    const result = await getClient().send(new GetQueryResultsCommand({ queryId }));
    if (result.status === "Complete") {
      return (result.results ?? []).map((fields) => {
        const row: Record<string, string> = {};
        for (const f of fields) {
          if (f.field && f.value) row[f.field] = f.value;
        }
        return row;
      });
    }
    if (result.status === "Failed" || result.status === "Cancelled" || result.status === "Timeout") {
      logger.error("[cw-logs] Insights query failed", { status: result.status, queryId });
      throw new Error(`Insights query ${result.status}`);
    }
  }
  throw new Error(`Insights query exceeded ${maxWaitMs}ms wait`);
}

/**
 * Oldest log stream timestamp in milliseconds. Used by the retention banner
 * to warn the operator when logs are within N days of rolling off the 30-day
 * retention window.
 */
export async function oldestLogTimestampMs(): Promise<number | null> {
  try {
    const result = await getClient().send(new DescribeLogStreamsCommand({
      logGroupName: LOG_GROUP,
      orderBy: "LastEventTime",
      descending: false,
      limit: 1,
    }));
    const stream = result.logStreams?.[0];
    return stream?.firstEventTimestamp ?? null;
  } catch (err) {
    logger.warn("[cw-logs] DescribeLogStreams failed", err);
    return null;
  }
}
