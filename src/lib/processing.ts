import { db } from "@/lib/db";
import { projects, pages } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { getS3Url, uploadToS3 } from "@/lib/s3";
import { rasterizePage, getPdfPageCount } from "@/lib/pdf-rasterize";
import { analyzePageImageWithFallback, extractRawText } from "@/lib/textract";
import { extractDrawingNumber } from "@/lib/title-block";
import { detectCsiCodes } from "@/lib/csi-detect";
import { detectTextAnnotations } from "@/lib/text-annotations";
import { extractKeynotes } from "@/lib/keynotes";

const PAGE_CONCURRENCY = 20;

/** Run async tasks with a concurrency limit. */
async function mapConcurrent<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;

  async function worker() {
    while (next < items.length) {
      const idx = next++;
      results[idx] = await fn(items[idx]);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}

/**
 * Process a PDF project: rasterize pages, run Textract, store results.
 * Called directly by the projects route (fire-and-forget) or via the dev API route.
 *
 * @param projectId - Internal database ID of the project
 */
export async function processProject(projectId: number): Promise<{
  pagesProcessed: number;
  pageErrors: number;
  processingTime: number;
}> {
  const startTime = Date.now();
  let pagesProcessed = 0;
  let pageErrors = 0;

  // Get project
  const [project] = await db
    .select()
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);

  if (!project) {
    throw new Error(`Project ${projectId} not found`);
  }

  // Set status to processing
  await db
    .update(projects)
    .set({ status: "processing" })
    .where(eq(projects.id, project.id));

  try {
    // Download PDF from S3
    const pdfUrl = getS3Url(project.dataUrl, "original.pdf");
    const pdfResponse = await fetch(pdfUrl);
    if (!pdfResponse.ok) {
      throw new Error(`Failed to download PDF: ${pdfResponse.status}`);
    }
    const pdfBuffer = Buffer.from(await pdfResponse.arrayBuffer());

    // Get page count
    const numPages = await getPdfPageCount(pdfBuffer);
    await db
      .update(projects)
      .set({ numPages })
      .where(eq(projects.id, project.id));

    // Generate thumbnail from page 1 before parallel processing
    try {
      const thumbBuffer = await rasterizePage(pdfBuffer, 1, 72);
      await uploadToS3(
        `${project.dataUrl}/thumbnail.png`,
        thumbBuffer,
        "image/png"
      );
    } catch (err) {
      console.warn("Thumbnail generation failed:", err);
    }

    // Process pages in parallel with concurrency limit
    const pageNums = Array.from({ length: numPages }, (_, i) => i + 1);

    await mapConcurrent(pageNums, PAGE_CONCURRENCY, async (pageNum) => {
      try {
        // Check if page already has textract data (skip if re-processing)
        const [existingPage] = await db
          .select({ id: pages.id, textractData: pages.textractData })
          .from(pages)
          .where(
            and(
              eq(pages.projectId, project.id),
              eq(pages.pageNumber, pageNum)
            )
          )
          .limit(1);

        if (existingPage?.textractData) {
          pagesProcessed++;
          return;
        }

        // Rasterize page once at 300 DPI — used for both Textract and keynotes
        const pngBuffer = await rasterizePage(pdfBuffer, pageNum, 300);

        // Run Textract OCR
        const textractData = await analyzePageImageWithFallback(pngBuffer);
        const rawText = extractRawText(textractData);

        // Extract drawing number from title block
        const drawingNumber = extractDrawingNumber(textractData);

        // Detect CSI codes from OCR text
        const csiCodes = detectCsiCodes(rawText);

        // Detect text annotations (phone, address, equipment tags, abbreviations, etc.)
        const textAnnotationResult = detectTextAnnotations(textractData, csiCodes);
        if (textAnnotationResult.annotations.length > 0) {
          console.log(`[processing] Page ${pageNum}: found ${textAnnotationResult.annotations.length} text annotations`);
        }

        // Extract keynotes (OpenCV + Tesseract) — reuse same 300 DPI buffer
        let keynotes = null;
        try {
          keynotes = await extractKeynotes(pngBuffer);
          if (keynotes.length > 0) {
            console.log(`[processing] Page ${pageNum}: found ${keynotes.length} keynotes`);
          }
        } catch (err) {
          console.error(`[processing] Keynote extraction FAILED for page ${pageNum}:`, err);
        }

        // Build page data
        const pageData: Record<string, unknown> = {
          textractData,
          rawText,
          drawingNumber,
          csiCodes: csiCodes.length > 0 ? csiCodes : null,
          textAnnotations: textAnnotationResult.annotations.length > 0 ? textAnnotationResult : null,
          keynotes: keynotes && keynotes.length > 0 ? keynotes : null,
        };

        // Upsert page row
        if (existingPage) {
          await db
            .update(pages)
            .set(pageData)
            .where(eq(pages.id, existingPage.id));

          await db.execute(
            sql`UPDATE pages SET search_vector = to_tsvector('english', ${rawText}) WHERE id = ${existingPage.id}`
          );
        } else {
          const pageName = drawingNumber || `Page ${pageNum}`;
          const [newPage] = await db
            .insert(pages)
            .values({
              pageNumber: pageNum,
              name: pageName,
              projectId: project.id,
              ...pageData,
            })
            .returning();

          await db.execute(
            sql`UPDATE pages SET search_vector = to_tsvector('english', ${rawText}) WHERE id = ${newPage.id}`
          );
        }

        pagesProcessed++;
      } catch (err) {
        console.error(`Error processing page ${pageNum}:`, err);
        pageErrors++;

        // Insert page row with error if it doesn't exist
        const [errPage] = await db
          .select({ id: pages.id })
          .from(pages)
          .where(
            and(
              eq(pages.projectId, project.id),
              eq(pages.pageNumber, pageNum)
            )
          )
          .limit(1);

        if (!errPage) {
          await db.insert(pages).values({
            pageNumber: pageNum,
            name: `Page ${pageNum}`,
            projectId: project.id,
            error: err instanceof Error ? err.message : "Processing failed",
          });
        }
      }
    });

    // Update project status
    const processingTime = Math.round((Date.now() - startTime) / 1000);
    await db
      .update(projects)
      .set({
        status: numPages > 0 && pageErrors === numPages ? "error" : "completed",
        processingTime,
        processingError:
          pageErrors > 0 ? `${pageErrors} of ${numPages} pages failed` : null,
        updatedAt: new Date(),
      })
      .where(eq(projects.id, project.id));

    return { pagesProcessed, pageErrors, processingTime };
  } catch (err) {
    console.error("Processing pipeline error:", err);

    await db
      .update(projects)
      .set({
        status: "error",
        processingError:
          err instanceof Error ? err.message : "Processing failed",
        processingTime: Math.round((Date.now() - startTime) / 1000),
        updatedAt: new Date(),
      })
      .where(eq(projects.id, project.id));

    throw err;
  }
}
