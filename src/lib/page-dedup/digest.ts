// Server-side report digest: the apply re-scans and refuses (409) when the report it would
// act on differs from the one the admin reviewed. Node crypto — never import from the client.

import { createHash } from "node:crypto";
import type { DuplicateReport } from "./types";

export function reportDigest(report: DuplicateReport): string {
  const lines = report.pairs
    .map((p) => `${p.page}|${p.canonical}|${p.tier}|${p.blockId ?? "-"}|${p.content.toFixed(3)}|${p.full.toFixed(3)}`)
    .sort();
  if (report.bulkHold) lines.push(`hold|${report.bulkHold}`);
  return createHash("sha256").update(lines.join("\n")).digest("hex");
}
