// Input checks shared by the parser services (table-parse, table-structure, shape-parse,
// bucket-fill, symbol-search). All five are reachable without a session on a demo project, and
// each passed these values on unchecked: a page number straight into an S3 key and a Ghostscript
// `-dFirstPage`, and coordinates into a Python script that multiplies them by the image width.
import { ApiError } from "@/server/api/envelope";

/** No plan set is within two orders of magnitude of this; the bound only has to exist. */
const MAX_PAGE_NUMBER = 100_000;

export function assertPageNumber(value: unknown, field = "pageNumber"): asserts value is number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > MAX_PAGE_NUMBER
  ) {
    throw new ApiError("VALIDATION", `Invalid ${field}`);
  }
}

/**
 * A finite number near the normalized page range. The bound is deliberately loose: a barrier
 * dragged past the page edge is legitimate. The point is that it is a NUMBER, and finite.
 */
export function isPageCoordinate(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= -1 && value <= 2;
}
