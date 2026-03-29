import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { projects, pages } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { getS3Url } from "@/lib/s3";
import { rasterizePage } from "@/lib/pdf-rasterize";
import { detectTableLines } from "@/lib/table-lines";
import { mergeGrids, type MethodResult } from "@/lib/grid-merger";
import type {
  TextractPageData,
  TextractWord,
  TextractTable,
  BboxLTWH,
} from "@/types";
import { detectCsiFromGrid } from "@/lib/csi-detect";

// ─── Method 1: OCR Word Positions ─────────────────────────

const ROW_Y_TOL = 0.006;
const MIN_COL_GAP = 0.015;
const HEADER_KW = new Set([
  "NO", "NO.", "NUMBER", "TAG", "MARK", "TYPE", "SIZE", "WIDTH", "HEIGHT",
  "MATERIAL", "FINISH", "HARDWARE", "REMARKS", "DESCRIPTION", "LOCATION",
  "QTY", "QUANTITY", "RATING", "FRAME", "GLAZING", "NOTES", "ROOM",
  "FLOOR", "CEILING", "WALL", "BASE", "MANUFACTURER", "MODEL", "COLOR",
]);
const RE_TAG = /^[A-Z]{0,3}-?\d{1,4}[A-Z]?$/i;

function methodOcrPositions(
  words: TextractWord[],
  regionBbox: [number, number, number, number],
): MethodResult {
  const [rMinX, rMinY, rMaxX, rMaxY] = regionBbox;

  // Get words inside region
  const regionWords = words.filter((w) => {
    const cx = w.bbox[0] + w.bbox[2] / 2;
    const cy = w.bbox[1] + w.bbox[3] / 2;
    return cx >= rMinX && cx <= rMaxX && cy >= rMinY && cy <= rMaxY;
  });

  if (regionWords.length < 6) {
    return { method: "ocr-positions", headers: [], rows: [], confidence: 0 };
  }

  // Cluster rows by Y
  const sorted = [...regionWords].sort((a, b) => (a.bbox[1] + a.bbox[3] / 2) - (b.bbox[1] + b.bbox[3] / 2));
  const rowClusters: { words: TextractWord[] }[] = [];
  let curCluster: TextractWord[] = [sorted[0]];
  let curY = sorted[0].bbox[1] + sorted[0].bbox[3] / 2;

  for (let i = 1; i < sorted.length; i++) {
    const wy = sorted[i].bbox[1] + sorted[i].bbox[3] / 2;
    if (Math.abs(wy - curY) <= ROW_Y_TOL) {
      curCluster.push(sorted[i]);
    } else {
      rowClusters.push({ words: curCluster.sort((a, b) => a.bbox[0] - b.bbox[0]) });
      curCluster = [sorted[i]];
      curY = wy;
    }
  }
  if (curCluster.length > 0) {
    rowClusters.push({ words: curCluster.sort((a, b) => a.bbox[0] - b.bbox[0]) });
  }

  if (rowClusters.length < 3) {
    return { method: "ocr-positions", headers: [], rows: [], confidence: 0 };
  }

  // Detect columns from X-clusters
  const allLefts = regionWords.map((w) => w.bbox[0]).sort((a, b) => a - b);
  const clusters: number[][] = [[allLefts[0]]];
  for (let i = 1; i < allLefts.length; i++) {
    if (allLefts[i] - allLefts[i - 1] > MIN_COL_GAP) clusters.push([allLefts[i]]);
    else clusters[clusters.length - 1].push(allLefts[i]);
  }

  const minHits = Math.max(2, Math.floor(rowClusters.length * 0.3));
  let stableClusters = clusters.filter((c) => c.length >= minHits);
  if (stableClusters.length < 2) stableClusters = clusters.length >= 2 ? clusters : [];
  if (stableClusters.length < 2) {
    return { method: "ocr-positions", headers: [], rows: [], confidence: 0.1 };
  }

  const colCenters = stableClusters.map((c) => c.reduce((s, x) => s + x, 0) / c.length).sort((a, b) => a - b);
  const maxRight = Math.max(...regionWords.map((w) => w.bbox[0] + w.bbox[2]));
  const colBounds = colCenters.map((center, i) => ({
    left: Math.max(0, i === 0 ? rMinX - 0.005 : (colCenters[i - 1] + center) / 2),
    right: Math.min(1, i === colCenters.length - 1 ? maxRight + 0.005 : (center + colCenters[i + 1]) / 2),
    center,
  }));

  // Extract cell grid
  const grid = rowClusters.map((row) => {
    const cells = new Array(colBounds.length).fill("");
    for (const w of row.words) {
      const wx = w.bbox[0] + w.bbox[2] / 2;
      let colIdx = colBounds.findIndex((c) => wx >= c.left && wx < c.right);
      if (colIdx === -1) {
        let minDist = Infinity;
        colBounds.forEach((c, ci) => { const d = Math.abs(wx - c.center); if (d < minDist) { minDist = d; colIdx = ci; } });
      }
      if (colIdx >= 0) cells[colIdx] = cells[colIdx] ? cells[colIdx] + " " + w.text : w.text;
    }
    return cells;
  });

  // Header detection: only use a row as header if it contains known keywords
  let headerIdx = -1;
  let bestScore = 0;
  for (let r = 0; r < Math.min(3, grid.length); r++) {
    const score = grid[r].filter((c: string) => HEADER_KW.has(c.toUpperCase().trim())).length;
    if (score > bestScore) { bestScore = score; headerIdx = r; }
  }
  if (bestScore === 0) headerIdx = -1; // no keyword match → don't consume any row as header

  const headers = headerIdx >= 0
    ? grid[headerIdx].map((c: string, i: number) => c.trim() || `Column ${i + 1}`)
    : colBounds.map((_, i) => `Column ${i + 1}`);
  const dataRows: Record<string, string>[] = [];
  for (let r = 0; r < grid.length; r++) {
    if (r === headerIdx) continue;
    const row: Record<string, string> = {};
    let hasContent = false;
    for (let c = 0; c < headers.length; c++) {
      const val = (grid[r][c] || "").trim();
      row[headers[c]] = val;
      if (val) hasContent = true;
    }
    if (hasContent) dataRows.push(row);
  }

  if (dataRows.length < 2) {
    return { method: "ocr-positions", headers: [], rows: [], confidence: 0.1 };
  }

  // Tag column
  let tagColumn: string | undefined;
  const tagHeaders = ["TAG", "MARK", "NO", "NO.", "NUMBER", "NUM", "ITEM"];
  for (const h of headers) {
    if (tagHeaders.some((kw) => h.toUpperCase().trim() === kw)) { tagColumn = h; break; }
  }
  if (!tagColumn) {
    let bestRatio = 0;
    for (const h of headers) {
      let tags = 0, nonEmpty = 0;
      for (const row of dataRows) {
        const v = (row[h] || "").trim();
        if (v) { nonEmpty++; if (RE_TAG.test(v)) tags++; }
      }
      const ratio = nonEmpty > 0 ? tags / nonEmpty : 0;
      if (ratio > bestRatio && ratio >= 0.5) { bestRatio = ratio; tagColumn = h; }
    }
  }

  // Confidence
  let confidence = 0.45;
  const headerMatches = headers.filter((h) => HEADER_KW.has(h.toUpperCase().trim())).length;
  confidence += Math.min(headerMatches * 0.05, 0.15);
  if (tagColumn) confidence += 0.1;
  const cellCounts = dataRows.map((r) => Object.values(r).filter((v) => v).length);
  const avgCells = cellCounts.reduce((s, c) => s + c, 0) / cellCounts.length;
  const consistency = cellCounts.filter((c) => Math.abs(c - avgCells) <= 1).length / cellCounts.length;
  confidence += consistency * 0.15;
  confidence = Math.min(confidence, 0.90);

  return { method: "ocr-positions", headers, rows: dataRows, confidence, tagColumn };
}

// ─── Method 2: Textract TABLES ────────────────────────────

function methodTextractTables(
  tables: TextractTable[] | undefined,
  regionBbox: [number, number, number, number],
): MethodResult {
  if (!tables || tables.length === 0) {
    return { method: "textract-tables", headers: [], rows: [], confidence: 0 };
  }

  const [rMinX, rMinY, rMaxX, rMaxY] = regionBbox;

  // Find the Textract table that overlaps most with the user's region
  let bestTable: TextractTable | null = null;
  let bestOverlap = 0;

  for (const table of tables) {
    const [tL, tT, tW, tH] = table.bbox;
    const tMinX = tL, tMinY = tT, tMaxX = tL + tW, tMaxY = tT + tH;

    // Intersection area
    const intMinX = Math.max(rMinX, tMinX);
    const intMinY = Math.max(rMinY, tMinY);
    const intMaxX = Math.min(rMaxX, tMaxX);
    const intMaxY = Math.min(rMaxY, tMaxY);

    if (intMinX < intMaxX && intMinY < intMaxY) {
      const intArea = (intMaxX - intMinX) * (intMaxY - intMinY);
      const regionArea = (rMaxX - rMinX) * (rMaxY - rMinY);
      const overlap = regionArea > 0 ? intArea / regionArea : 0;
      if (overlap > bestOverlap) {
        bestOverlap = overlap;
        bestTable = table;
      }
    }
  }

  if (!bestTable || bestOverlap < 0.3) {
    return { method: "textract-tables", headers: [], rows: [], confidence: 0 };
  }

  // Convert Textract cells to grid
  const { cells, rowCount, colCount } = bestTable;
  if (rowCount < 2 || colCount < 1) {
    return { method: "textract-tables", headers: [], rows: [], confidence: 0 };
  }

  // Build grid from cells (1-based indices)
  const grid: string[][] = Array.from({ length: rowCount }, () => new Array(colCount).fill(""));
  for (const cell of cells) {
    if (cell.row >= 1 && cell.row <= rowCount && cell.col >= 1 && cell.col <= colCount) {
      grid[cell.row - 1][cell.col - 1] = cell.text.trim();
    }
  }

  // Don't assume first row is headers — use generic column names, keep all rows as data
  const headers = Array.from({ length: colCount }, (_, i) => `Column ${i + 1}`);
  const dataRows: Record<string, string>[] = [];
  for (let r = 0; r < grid.length; r++) {
    const row: Record<string, string> = {};
    let hasContent = false;
    for (let c = 0; c < headers.length; c++) {
      row[headers[c]] = grid[r][c] || "";
      if (grid[r][c]) hasContent = true;
    }
    if (hasContent) dataRows.push(row);
  }

  // Confidence based on cell fill rate + Textract cell confidence
  const totalCells = dataRows.length * headers.length;
  const filledCells = dataRows.reduce((s, r) => s + Object.values(r).filter((v) => v).length, 0);
  const fillRate = totalCells > 0 ? filledCells / totalCells : 0;
  const avgCellConf = cells.reduce((s, c) => s + c.confidence, 0) / cells.length / 100;
  const confidence = Math.min(0.5 + fillRate * 0.2 + avgCellConf * 0.2 + bestOverlap * 0.1, 0.95);

  return { method: "textract-tables", headers, rows: dataRows, confidence };
}

// ─── Method 3: OpenCV Line Detection ──────────────────────

async function methodOpenCvLines(
  pdfBuffer: Buffer,
  pageNumber: number,
  regionBbox: [number, number, number, number],
  allWords: TextractWord[],
): Promise<MethodResult> {
  try {
    // Rasterize page at 300 DPI
    const pngBuffer = await rasterizePage(pdfBuffer, pageNumber, 300);

    // Get image dimensions from PNG header
    const imgWidth = pngBuffer.readUInt32BE(16);
    const imgHeight = pngBuffer.readUInt32BE(20);

    // Crop to region using sharp or canvas
    // For now, write full page and let Python handle the crop in normalized coords
    // Actually, let's crop first using the PNG buffer
    const [rMinX, rMinY, rMaxX, rMaxY] = regionBbox;

    // Use Ghostscript or sharp to crop — for simplicity, pass full image
    // and interpret line positions relative to the region
    const lineGrid = await detectTableLines(pngBuffer);

    if (lineGrid.confidence < 0.3 || lineGrid.rowCount < 1 || lineGrid.colCount < 1) {
      return { method: "opencv-lines", headers: [], rows: [], confidence: 0 };
    }

    // Convert line positions to absolute page coordinates
    // Lines are in 0-1 space of the full page image
    // We need to map them to region-relative coordinates for cell extraction
    const rowYs = lineGrid.rows.map((r) => r.y);
    const colXs = lineGrid.cols.map((c) => c.x);

    // Filter lines that fall within the region
    const regionRowYs = rowYs.filter((y) => y >= rMinY && y <= rMaxY);
    const regionColXs = colXs.filter((x) => x >= rMinX && x <= rMaxX);

    if (regionRowYs.length < 2 || regionColXs.length < 2) {
      return { method: "opencv-lines", headers: [], rows: [], confidence: lineGrid.confidence * 0.3 };
    }

    // Build cells from line intersections
    const numRows = regionRowYs.length - 1;
    const numCols = regionColXs.length - 1;
    const headers: string[] = [];
    const dataRows: Record<string, string>[] = [];

    for (let ri = 0; ri < numRows; ri++) {
      const cellTop = regionRowYs[ri];
      const cellBottom = regionRowYs[ri + 1];

      const rowData: Record<string, string> = {};
      for (let ci = 0; ci < numCols; ci++) {
        const cellLeft = regionColXs[ci];
        const cellRight = regionColXs[ci + 1];

        // Get OCR words inside this cell
        const cellWords = allWords.filter((w) => {
          const cx = w.bbox[0] + w.bbox[2] / 2;
          const cy = w.bbox[1] + w.bbox[3] / 2;
          return cx >= cellLeft && cx <= cellRight && cy >= cellTop && cy <= cellBottom;
        });

        const text = cellWords
          .sort((a, b) => a.bbox[0] - b.bbox[0])
          .map((w) => w.text)
          .join(" ");

        if (ri === 0 && headers.length < numCols) {
          headers.push(`Column ${ci + 1}`);
        }
        rowData[headers[ci] || `Column ${ci + 1}`] = text;
      }

      {
        const hasContent = Object.values(rowData).some((v) => v);
        if (hasContent) dataRows.push(rowData);
      }
    }

    return {
      method: "opencv-lines",
      headers,
      rows: dataRows,
      confidence: lineGrid.confidence,
    };
  } catch (err) {
    console.error("[table-parse] OpenCV method failed:", err);
    return { method: "opencv-lines", headers: [], rows: [], confidence: 0 };
  }
}

// ─── API Route ────────────────────────────────────────────

/**
 * POST /api/table-parse
 *
 * Runs multiple parsing methods on a user-selected table region,
 * merges results, and returns the best grid.
 */
export async function POST(req: Request) {
  const body = await req.json();
  const { projectId, pageNumber, regionBbox } = body as {
    projectId: number;
    pageNumber: number;
    regionBbox: [number, number, number, number];
  };

  if (!projectId || !pageNumber || !regionBbox || regionBbox.length !== 4) {
    return NextResponse.json({ error: "Missing projectId, pageNumber, or regionBbox" }, { status: 400 });
  }

  // Auth: allow demo projects without session, require auth for non-demo
  const [project] = await db
    .select({ id: projects.id, dataUrl: projects.dataUrl, isDemo: projects.isDemo })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);

  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  if (!project.isDemo) {
    const session = await auth();
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  try {
    const [pageRow] = await db
      .select({ textractData: pages.textractData })
      .from(pages)
      .where(and(eq(pages.projectId, project.id), eq(pages.pageNumber, pageNumber)))
      .limit(1);

    if (!pageRow?.textractData) {
      return NextResponse.json({ error: "Page has no OCR data" }, { status: 404 });
    }

    const textractData = pageRow.textractData as TextractPageData;

    // Run methods in parallel
    // Method 3 (OpenCV) needs the PDF for rasterization
    let pdfBuffer: Buffer | null = null;
    try {
      const pdfUrl = getS3Url(project.dataUrl!, "original.pdf");
      const pdfResp = await fetch(pdfUrl);
      if (pdfResp.ok) pdfBuffer = Buffer.from(await pdfResp.arrayBuffer());
    } catch { /* PDF fetch failed — skip OpenCV method */ }

    const methodPromises: Promise<MethodResult>[] = [
      // Method 1: OCR positions (sync, wrap in promise)
      Promise.resolve(methodOcrPositions(textractData.words, regionBbox)),

      // Method 2: Textract TABLES (sync, wrap in promise)
      Promise.resolve(methodTextractTables(textractData.tables, regionBbox)),

      // Method 3: OpenCV lines (async, needs PDF)
      pdfBuffer
        ? methodOpenCvLines(pdfBuffer, pageNumber, regionBbox, textractData.words)
        : Promise.resolve({ method: "opencv-lines", headers: [], rows: [], confidence: 0 } as MethodResult),
    ];

    const results = await Promise.all(methodPromises);

    console.log(
      `[table-parse] Page ${pageNumber}: ` +
      results.map((r) => `${r.method}=${r.confidence.toFixed(2)} (${r.rows.length}r×${r.headers.length}c)`).join(", ")
    );

    // Merge results
    const merged = mergeGrids(results);

    // Auto-detect CSI codes from parsed content (server-side, has fs access)
    try {
      const csiCodes = detectCsiFromGrid(merged.headers || [], merged.rows || []);
      (merged as any).csiTags = csiCodes.map((c) => ({ code: c.code, description: c.description }));
    } catch { /* CSI detection is best-effort */ }

    return NextResponse.json(merged);
  } catch (err) {
    console.error("[table-parse] Failed:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Table parsing failed" },
      { status: 500 }
    );
  }
}
