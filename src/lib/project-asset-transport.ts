/**
 * pdf.js always starts URL loading with an un-ranged capability probe. When
 * streaming is disabled it cancels that request as soon as the response
 * headers prove range support. A same-origin application proxy can otherwise
 * buffer megabytes from S3 before the downstream cancellation reaches it.
 *
 * The viewer marks only that pdf.js transport. The gateway then obtains one
 * byte from S3 to learn the authoritative object length and advertises the
 * normal full-response headers; all subsequent pdf.js reads remain ordinary
 * client-requested byte ranges. Direct downloads without this header retain
 * the normal full-object GET contract.
 */
export const PDF_RANGE_PROBE_HEADER = "x-blueprintparser-pdf-range-probe";
export const PDF_RANGE_PROBE_VALUE = "1";
export const PDF_RANGE_PROBE_UPSTREAM_RANGE = "bytes=0-0";
