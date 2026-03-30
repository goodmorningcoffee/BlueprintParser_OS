import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/api-utils";
import { db } from "@/lib/db";
import { companies } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { uploadToS3, deleteFromS3, getS3Url } from "@/lib/s3";

const CSI_S3_PREFIX = "csi-databases";

/**
 * POST /api/admin/csi/upload
 * Upload a custom CSI code database (CSV, TSV, or JSON).
 * Parses the file, validates format, stores in S3, updates company config.
 */
export async function POST(req: Request) {
  const { session, error } = await requireAdmin();
  if (error) return error;

  const formData = await req.formData();
  const file = formData.get("file") as File | null;
  if (!file) {
    return NextResponse.json({ error: "No file uploaded" }, { status: 400 });
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
      return NextResponse.json({ error: "Unsupported format. Use CSV, TSV, or JSON." }, { status: 400 });
    }
  } catch (err) {
    return NextResponse.json({
      error: `Parse error: ${err instanceof Error ? err.message : "Invalid file format"}`,
    }, { status: 400 });
  }

  if (entries.length === 0) {
    return NextResponse.json({ error: "No CSI codes found in file" }, { status: 400 });
  }

  // Convert to TSV format for storage (same format as built-in)
  const tsvContent = "1995 CSI #\tCSI Description\t2004 CSI #\tCSI Description\tTrade\tDivision #\n"
    + entries.map(e => {
      const codeNoSpace = e.code.replace(/\s+/g, "");
      const phrase = e.description.toLowerCase();
      return `${codeNoSpace}\t${phrase}\t${codeNoSpace}\t${phrase}\t${e.trade}\t${e.division}`;
    }).join("\n");

  // Upload to S3
  const companyId = session.user.companyId;
  const s3Key = `${CSI_S3_PREFIX}/company-${companyId}/custom-csi.tsv`;

  await uploadToS3(s3Key, Buffer.from(tsvContent, "utf-8"), "text/tab-separated-values");

  // Update company config to point to custom file
  const [company] = await db
    .select({ pipelineConfig: companies.pipelineConfig })
    .from(companies)
    .where(eq(companies.id, companyId))
    .limit(1);

  const existing = (company?.pipelineConfig || {}) as Record<string, unknown>;
  const csiConfig = (existing.csi || {}) as Record<string, unknown>;
  const updated = {
    ...existing,
    csi: {
      ...csiConfig,
      customDatabaseS3Key: s3Key,
      customDatabaseName: file.name,
      customDatabaseCodes: entries.length,
    },
  };

  await db
    .update(companies)
    .set({ pipelineConfig: updated })
    .where(eq(companies.id, companyId));

  return NextResponse.json({
    success: true,
    codesLoaded: entries.length,
    s3Key,
  });
}

/**
 * DELETE /api/admin/csi/upload
 * Revert to built-in CSI database.
 */
export async function DELETE() {
  const { session, error } = await requireAdmin();
  if (error) return error;

  const companyId = session.user.companyId;

  // Remove custom config
  const [company] = await db
    .select({ pipelineConfig: companies.pipelineConfig })
    .from(companies)
    .where(eq(companies.id, companyId))
    .limit(1);

  const existing = (company?.pipelineConfig || {}) as Record<string, unknown>;
  const csiConfig = (existing.csi || {}) as Record<string, unknown>;
  const { customDatabaseS3Key, customDatabaseName, customDatabaseCodes, ...restCsi } = csiConfig;

  const updated = { ...existing, csi: restCsi };

  await db
    .update(companies)
    .set({ pipelineConfig: updated })
    .where(eq(companies.id, companyId));

  // Try to delete from S3 (non-blocking)
  try {
    const s3Key = `${CSI_S3_PREFIX}/company-${companyId}/custom-csi.tsv`;
    await deleteFromS3(s3Key);
  } catch { /* ignore — file may not exist */ }

  return NextResponse.json({ success: true });
}

// ═══════════════════════════════════════════════════════════════
// Parsers
// ═══════════════════════════════════════════════════════════════

const DIVISION_TRADES: Record<string, string> = {
  "00": "Procurement", "01": "General Requirements", "02": "Existing Conditions",
  "03": "Concrete", "04": "Masonry", "05": "Metals",
  "06": "Wood/Plastics/Composites", "07": "Thermal & Moisture Protection",
  "08": "Openings", "09": "Finishes", "10": "Specialties",
  "11": "Equipment", "12": "Furnishings", "13": "Special Construction",
  "14": "Conveying Equipment", "21": "Fire Suppression", "22": "Plumbing",
  "23": "HVAC", "25": "Integrated Automation", "26": "Electrical",
  "27": "Communications", "28": "Electronic Safety & Security",
  "31": "Earthwork", "32": "Exterior Improvements", "33": "Utilities",
};

function inferTradeFromCode(code: string): { trade: string; division: string } {
  const div = code.replace(/\s+/g, "").substring(0, 2);
  return {
    trade: DIVISION_TRADES[div] || `Division ${div}`,
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
