// [refactor jul8 S059] admin/csi/upload SOLO — the app's ONLY multipart route (POST upload a
// custom CSI code DB [CSV/TSV/JSON] + DELETE revert to built-in), folded from the legacy route
// (git show a5dee0f:src/app/api/admin/csi/upload/route.ts). Char:
// __tests__/admin-csi-upload.route.test.ts (CU-*). requireAdmin → shell auth:"admin"; the POST
// shell uses the DR006-built `rawBody:true` skip-parse mode (07f0be3) so THIS service reads the
// stream via req.formData(). Sanctioned diffs:
//   • A — the flat 400s → envelope, messages BYTE-verbatim + status preserved: "No file
//     uploaded" · "Unsupported format. Use CSV, TSV, or JSON." · the `Parse error: <msg>`
//     INTERPOLATION (deliberate @400 domain feedback from the parsers' intentional Errors —
//     NOT a DR002 B-leak; NOT retired; CU-4 asserts the json case by PREFIX) · "No CSI codes
//     found in file". All as ApiError("BAD_REQUEST", …)@400.
//   • NO E on POST (multipart — rawBody:true skips the shell JSON parse entirely). DELETE
//     gains the uniform shell property: a malformed JSON body → 400 "Invalid JSON body"
//     (legacy DELETE() was 0-arg and ignored the body; yolo-purge precedent — degenerate
//     input, pinned CU-11).
//   • NO B — legacy has no catch-500; the shell's generic INTERNAL 500 on uncaught S3/DB
//     throws is NEW uniform wrapping, not a retirement.
// PRESERVED verbatim: the ext branch on file.name.toLowerCase(); the exact tsvContent header
// literal + row template (codeNoSpace=\s+ stripped, phrase=description.toLowerCase()); the
// s3Key = csi-databases/company-<id>/custom-csi.tsv (companyId strictly session-scoped, no
// cross-tenant param); the jsonb SPREAD-MERGE on POST and the destructure-STRIP of exactly the
// 3 customDatabase* keys on DELETE (sibling pipelineConfig.*/csi.* keys survive — CU-6/9); the
// DELETE non-blocking S3 delete SILENT-swallow catch (CU-10); DIVISION_TRADES/inferTradeFromCode/
// parseJsonCsi/parseCsvTsvCsi moved here whole (route-local, behavior-carrying). Dropped: the
// dead legacy `getS3Url` import only.
// [refactor jul9 P2-A C1] C2 update: DIVISION_TRADES since replaced by the canonical
// @/lib/csi-divisions map (see comment at inferTradeFromCode; ledger D-9).

// [refactor jul23 P4.1 U11] both the upload pointer-triple RMW and the revert
// triple-STRIP RMW now route through the companies-row FOR-UPDATE wrapper, so the
// direct db/companies/eq handles here are gone; S3 + cache work stays OUTSIDE it (I-1).
import { updatePipelineConfig, type PipelineConfig } from "./company-config";
import { uploadToS3, deleteFromS3 } from "@/lib/s3";
import { ApiError } from "@/server/api/envelope";
import type { AuthSession } from "@/lib/api-utils";
// [refactor jul9 P2-A C1] C2: canonical division map replaces the local
// DIVISION_TRADES table (SPEC_FINAL §1.6, [C1 approval 2026-07-09]).
import { DIVISION_NAMES } from "@/lib/csi-divisions";
// [refactor jul9 P2-A C1] C3 (SPEC_FINAL §1.6(C3)): the custom-DB S3 key
// namespace is now the ONE shared helper (I-7 — the resolver's tenant guard
// consumes the SAME prefix, so a literal here could silently drift). On
// upload/revert we invalidate the resolver's per-company cache so a foreign
// ECS task re-reads on its next detect (generation-guarded, query-cache.ts §1.8).
// [refactor jul9 P2-A C1] C4 (SPEC_FINAL §1.6(C4), I-9, ledger D-14): the I-9
// size/row caps — the SAME constants the resolver guard (csi-company-db.ts step 7)
// enforces at read time. Upload gate = write-time bound; resolver guard = read-time
// bound covering pre-existing oversized S3 objects. Both are needed (invariant I-9).
import { csiDbKeyPrefix, CSI_DB_MAX_BYTES, CSI_DB_MAX_ENTRIES } from "@/lib/csi-database";
import { invalidateCache } from "@/lib/admin-logs/query-cache";
import { csiDbCacheKey } from "@/lib/csi-company-db";

/**
 * POST /api/admin/csi/upload
 * Upload a custom CSI code database (CSV, TSV, or JSON).
 * Parses the file, validates format, stores in S3, updates company config.
 * Reads the RAW request (multipart) — the shell must not consume the stream (rawBody:true).
 */
export async function uploadCsiDatabase(req: Request, session: AuthSession): Promise<unknown> {
  const formData = await req.formData();
  const file = formData.get("file") as File | null;
  if (!file) {
    throw new ApiError("BAD_REQUEST", "No file uploaded");
  }

  // [refactor jul9 P2-A C1] C4 (SPEC_FINAL §1.6(C4), I-9, ledger D-14): reject an
  // oversized upload at the write gate BEFORE reading the stream. Post-C6 the custom
  // DB is hot-path resident (per-page synchronous full-DB iteration in the engine),
  // so an unbounded upload converts one admin action into per-task resident memory +
  // per-page CPU across every tenant on the ECS task — a cross-tenant availability
  // lever. New 400 (was: unbounded accept).
  if (file.size > CSI_DB_MAX_BYTES) {
    throw new ApiError("BAD_REQUEST", `File too large (max ${CSI_DB_MAX_BYTES / (1024 * 1024)} MB)`);
  }

  const content = await file.text();
  const fileName = file.name.toLowerCase();

  // Parse file into code entries
  let entries: { code: string; description: string; trade: string; division: string }[] = [];

  try {
    if (fileName.endsWith(".json")) {
      entries = parseJsonCsi(content);
    } else if (fileName.endsWith(".csv")) {
      entries = parseCsvTsvCsi(content, ",");
    } else if (fileName.endsWith(".tsv") || fileName.endsWith(".txt")) {
      entries = parseCsvTsvCsi(content, "\t");
    } else {
      throw new ApiError("BAD_REQUEST", "Unsupported format. Use CSV, TSV, or JSON.");
    }
  } catch (err) {
    if (err instanceof ApiError) throw err; // the unsupported-format 400 above, not a parse throw
    // Deliberate err.message interpolation @400 — domain feedback from the parsers'
    // intentional Errors (CU-4). NOT a class-B leak; do not retire.
    throw new ApiError("BAD_REQUEST", `Parse error: ${err instanceof Error ? err.message : "Invalid file format"}`);
  }

  if (entries.length === 0) {
    throw new ApiError("BAD_REQUEST", "No CSI codes found in file");
  }

  // [refactor jul9 P2-A C1] C4 (SPEC_FINAL §1.6(C4), I-9, ledger D-14): reject a
  // row-count blowup at the write gate, next to the emptiness check. Mirrors the
  // resolver guard's `parsed.entries.length > CSI_DB_MAX_ENTRIES` branch — a small-
  // byte file can still parse to a huge entry count. New 400 (was: unbounded accept).
  if (entries.length > CSI_DB_MAX_ENTRIES) {
    throw new ApiError("BAD_REQUEST", `Too many CSI codes (max ${CSI_DB_MAX_ENTRIES} rows)`);
  }

  // Convert to TSV format for storage (same format as built-in)
  const tsvContent = "1995 CSI #\tCSI Description\t2004 CSI #\tCSI Description\tTrade\tDivision #\n"
    + entries.map(e => {
      const codeNoSpace = e.code.replace(/\s+/g, "");
      const phrase = e.description.toLowerCase();
      return `${codeNoSpace}\t${phrase}\t${codeNoSpace}\t${phrase}\t${e.trade}\t${e.division}`;
    }).join("\n");

  // [refactor jul9 P2-A C1 · DETECTOR note jul9] KNOWN QUIRK (C4 review, CONFIRMED low): the
  // write gate above bounds the RAW upload (file.size), but THIS regenerated 6-column TSV is
  // what the resolver re-checks (csi-company-db.ts:182, buf.byteLength). Each row duplicates
  // code+description, so a near-cap raw upload can inflate past CSI_DB_MAX_BYTES here and be
  // SILENTLY rejected at read → builtin fallback (I-4, warn-only). Fails SAFE, and the row cap
  // (entries.length, symmetric at both gates) is the real I-9 availability backstop — the byte
  // cap is only early-reject UX. Tightening to gate Buffer.byteLength(tsvContent) here would make
  // write-accept ⇒ read-accept; DEFERRED to owner (frozen file.size semantics §1.6(C4); N-6 caps).

  // Upload to S3
  const companyId = session.user.companyId;
  // [refactor jul9 P2-A C1] C3: shared prefix helper (I-7) — was the local
  // `${CSI_S3_PREFIX}/company-${companyId}/` literal.
  const s3Key = `${csiDbKeyPrefix(companyId)}custom-csi.tsv`;

  await uploadToS3(s3Key, Buffer.from(tsvContent, "utf-8"), "text/tab-separated-values");

  // [refactor jul23 P4.1 U11] Update company config to point to custom file — migrated
  // onto the companies-row FOR-UPDATE wrapper. I-1: `uploadToS3` (ABOVE) and
  // `invalidateCache` (BELOW) stay OUTSIDE the tx — no async S3/cache work runs while the
  // row lock is held (the regions.ts:155-158 precedent). Merge semantics BYTE-IDENTICAL:
  // `{...current, csi: {...existingCsi, customDatabaseS3Key/Name/Codes}}`, no updatedAt.
  await updatePipelineConfig(companyId, (current) => {
    const csiConfig = (current.csi || {}) as Record<string, unknown>;
    return {
      ...current,
      csi: {
        ...csiConfig,
        customDatabaseS3Key: s3Key,
        customDatabaseName: file.name,
        customDatabaseCodes: entries.length,
      },
    } as PipelineConfig;
  });

  // [refactor jul9 P2-A C1] C3: drop the resolver's cached custom-DB snapshot so
  // the re-upload-to-same-key case (deterministic s3Key) is visible immediately
  // in THIS process; a foreign task's warm cache is TTL-bounded (SPEC_FINAL §1.7).
  invalidateCache(csiDbCacheKey(companyId));

  return {
    success: true,
    codesLoaded: entries.length,
    s3Key,
  };
}

/**
 * DELETE /api/admin/csi/upload
 * Revert to built-in CSI database.
 */
export async function revertCsiDatabase(session: AuthSession): Promise<unknown> {
  const companyId = session.user.companyId;

  // [refactor jul23 P4.1 U11] Remove custom config — migrated onto the companies-row
  // FOR-UPDATE wrapper. I-1: `invalidateCache` and the best-effort S3 delete (BELOW) stay
  // OUTSIDE/AFTER the tx (SPEC_FINAL §1.6(C3) ordering preserved). Strip semantics
  // BYTE-IDENTICAL: destructure-drop EXACTLY the 3 `customDatabase*` keys; sibling `csi.*`
  // + top-level siblings survive; no updatedAt.
  await updatePipelineConfig(companyId, (current) => {
    const csiConfig = (current.csi || {}) as Record<string, unknown>;
    const { customDatabaseS3Key, customDatabaseName, customDatabaseCodes, ...restCsi } = csiConfig;
    return { ...current, csi: restCsi } as PipelineConfig;
  });

  // [refactor jul9 P2-A C1] C3: invalidate the resolver cache AFTER the config
  // write (the pointer is gone → next resolve short-circuits to builtin) and
  // BEFORE the best-effort S3 delete below (SPEC_FINAL §1.6(C3)).
  invalidateCache(csiDbCacheKey(companyId));

  // Try to delete from S3 (non-blocking)
  try {
    // [refactor jul9 P2-A C1] C3: shared prefix helper (I-7).
    const s3Key = `${csiDbKeyPrefix(companyId)}custom-csi.tsv`;
    await deleteFromS3(s3Key);
  } catch { /* ignore — file may not exist */ }

  return { success: true };
}

// ═══════════════════════════════════════════════════════════════
// Parsers
// ═══════════════════════════════════════════════════════════════

// [refactor jul9 P2-A C1] C2: local DIVISION_TRADES table (25 divisions — the
// same set as the canonical map) deleted; trade strings now come from
// @/lib/csi-divisions (SPEC_FINAL §1.6(C2), [C1 approval 2026-07-09]).
// Acceptance/validation delta: ZERO — the parsers below gate only on
// code+description, never on division/trade. Only Div 07/28 trade strings
// change for FUTURE uploads' stored TSVs (ledger D-9): "Thermal & Moisture
// Protection" → "Thermal & Moisture", "Electronic Safety & Security" →
// "Electronic Safety" (majority-rule wording). Past uploads immutable in S3.

// [refactor jul9 P2-A C1] exported (was module-private) so the C0 freeze-first baseline
// tests can pin its trade-string output directly (SPEC_FINAL §6.2-2 / C2-F4).
export function inferTradeFromCode(code: string): { trade: string; division: string } {
  const div = code.replace(/\s+/g, "").substring(0, 2);
  return {
    trade: DIVISION_NAMES[div] || `Division ${div}`,
    division: `${div} 00 00`,
  };
}

function parseJsonCsi(content: string) {
  const data = JSON.parse(content);
  const arr = Array.isArray(data) ? data : Object.values(data);

  return arr.map((item: any) => {
    const code = item.code || item.number || item.csi || "";
    const description = item.label || item.description || item.title || item.name || "";
    if (!code || !description) return null;

    const { trade, division } = item.trade
      ? { trade: item.trade, division: item.division || inferTradeFromCode(code).division }
      : inferTradeFromCode(code);

    return { code: String(code).trim(), description: String(description).trim(), trade, division };
  }).filter(Boolean) as { code: string; description: string; trade: string; division: string }[];
}

function parseCsvTsvCsi(content: string, delimiter: string) {
  const lines = content.split("\n").filter(l => l.trim());
  if (lines.length < 2) throw new Error("File must have a header row and at least one data row");

  // Detect columns from header
  const header = lines[0].toLowerCase().split(delimiter).map(h => h.trim());
  const codeCol = header.findIndex(h => h.includes("code") || h.includes("number") || h.includes("csi"));
  const descCol = header.findIndex(h => h.includes("description") || h.includes("title") || h.includes("label") || h.includes("name"));
  const tradeCol = header.findIndex(h => h.includes("trade"));
  const divCol = header.findIndex(h => h.includes("division"));

  if (codeCol === -1) throw new Error("No 'code' or 'number' column found in header");
  if (descCol === -1) throw new Error("No 'description' or 'title' column found in header");

  return lines.slice(1).map(line => {
    const cols = line.split(delimiter).map(c => c.trim());
    const code = cols[codeCol] || "";
    const description = cols[descCol] || "";
    if (!code || !description) return null;

    const tradeInfo = tradeCol >= 0 && cols[tradeCol]
      ? { trade: cols[tradeCol], division: divCol >= 0 ? cols[divCol] : inferTradeFromCode(code).division }
      : inferTradeFromCode(code);

    return { code, description, ...tradeInfo };
  }).filter(Boolean) as { code: string; description: string; trade: string; division: string }[];
}
