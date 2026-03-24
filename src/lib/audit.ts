import { db } from "@/lib/db";
import { auditLog } from "@/lib/db/schema";

/**
 * Log an auditable event. Fire-and-forget — never blocks the request.
 */
export function audit(
  action: string,
  opts: {
    userId?: number;
    companyId?: number;
    details?: Record<string, unknown>;
    ip?: string;
  } = {}
) {
  db.insert(auditLog)
    .values({
      action,
      userId: opts.userId || null,
      companyId: opts.companyId || null,
      details: opts.details || null,
      ip: opts.ip || null,
    })
    .catch((err) => console.error("Audit log failed:", err));
}
