// @vitest-environment node
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const source = readFileSync(
  new URL("../PDFViewer.tsx", import.meta.url),
  "utf8",
);

describe("PDFViewer bounded transport lifecycle", () => {
  it("disables whole-document streaming and uses gateway-sized bounded ranges", () => {
    expect(source).toMatch(/disableStream:\s*true/);
    expect(source).toMatch(/disableAutoFetch:\s*true/);
    expect(source).toMatch(/rangeChunkSize:\s*1024\s*\*\s*1024/);
    expect(source).toContain("[PDF_RANGE_PROBE_HEADER]: PDF_RANGE_PROBE_VALUE");
    expect(source).not.toMatch(/rangeChunkSize:\s*65536/);
  });

  it("retains and destroys the loading task when the URL changes or viewer unmounts", () => {
    expect(source).toMatch(
      /let loadingTask:[\s\S]*PDFDocumentLoadingTask[\s\S]*= null/,
    );
    expect(source).toContain("loadingTask = pdfjsLib.getDocument");
    expect(source).toContain(
      "if (loadingTask) void loadingTask.destroy().catch(() => undefined)",
    );
  });
});
