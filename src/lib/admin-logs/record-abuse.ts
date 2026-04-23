import { db } from "@/lib/db";
import { abuseEvents } from "@/lib/db/schema";
import { logger } from "@/lib/logger";

/**
 * Event type discriminator for abuse_events rows. Kept narrow so the Logs
 * tab UI can render distinct colors/icons per type without worrying about
 * unknown string values sneaking in from downstream code.
 */
export type AbuseEventType =
  | "RATE_LIMIT_BREACH"     // First-tier cooldown trip
  | "IP_BANNED_AUTO"        // Second-tier auto-ban from repeat burst
  | "FAILED_LOGIN"          // NextAuth authorize() returned false
  | "SCAN_404_BURST"        // >5 404s from same IP in <60s
  | "DEPRECATED_ROUTE"      // Hit to a route removed for security (e.g. /api/demo/labeling/credentials)
  | "MANUAL_BAN"            // Root_Admin clicked "Ban this IP"
  | "MANUAL_UNBAN";         // Root_Admin cleared a ban

/**
 * Fire-and-forget abuse event insert. Mirrors `audit()` pattern at
 * src/lib/audit.ts — never blocks the caller, swallows errors to a logger
 * call so a DB hiccup never breaks the user's request flow.
 *
 * Safe to call from middleware (Node runtime) on any code path including
 * inside early-return 429/403 handlers.
 */
export function recordAbuseEvent(opts: {
  eventType: AbuseEventType;
  ip: string;
  country?: string;
  path?: string;
  userAgent?: string;
  details?: Record<string, unknown>;
}) {
  db.insert(abuseEvents)
    .values({
      eventType: opts.eventType,
      ip: opts.ip,
      country: opts.country ?? null,
      path: opts.path ?? null,
      userAgent: opts.userAgent ?? null,
      details: opts.details ?? null,
    })
    .catch((err) => {
      logger.error("[abuse-events] insert failed", err);
    });
}
