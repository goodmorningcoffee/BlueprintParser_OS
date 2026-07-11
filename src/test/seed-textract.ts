// [refactor jul11 P2.2⑧ C1] seedTextract — THE shared test seed helper for the TEXTRACT domain.
//
// This file is the one sanctioned backing-store flip point for Textract DOM characterization:
//
//   PRE-migration (NOW): page payloads live in viewerStore → setTextractData(page, payload)
//   POST-migration (C3): page payloads live under queryKeys.textract.page(publicId, page)
//
// Call after setting the store's publicId. QueryClient is threaded from birth so C3 changes this
// function body and zero freeze-test call sites. Production code must not import this test helper.

import type { QueryClient } from "@tanstack/react-query";
import { useViewerStore } from "@/stores/viewerStore";
import type { TextractPageData } from "@/types";

export function seedTextract(
  _queryClient: QueryClient,
  pages: Record<number, TextractPageData>,
  _publicId = useViewerStore.getState().publicId,
): void {
  for (const [pageNumber, data] of Object.entries(pages)) {
    useViewerStore.getState().setTextractData(Number(pageNumber), data);
  }
}
