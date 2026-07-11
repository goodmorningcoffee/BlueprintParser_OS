// [refactor jul11 P2.2⑧ C1] seedTextract — THE shared test seed helper for the TEXTRACT domain.
//
// This file is the one sanctioned backing-store flip point for Textract DOM characterization.
// The §2.2⑧ C3 migration flipped exactly this body and zero callers:
//
//   PRE-migration:       page payloads lived in viewerStore → setTextractData(page, payload)
//   POST-migration NOW:  page payloads live under queryKeys.textract.page(publicId, page)
//
// Call after setting the store's publicId. QueryClient is threaded from birth so C3 changes this
// function body and zero freeze-test call sites. Production code must not import this test helper.

import type { QueryClient } from "@tanstack/react-query";
import { queryKeys } from "@/queries/queryKeys";
import { useViewerStore } from "@/stores/viewerStore";
import type { TextractPageData } from "@/types";

export function seedTextract(
  queryClient: QueryClient,
  pages: Record<number, TextractPageData>,
  publicId = useViewerStore.getState().publicId,
): void {
  for (const [pageNumber, data] of Object.entries(pages)) {
    queryClient.setQueryData(
      queryKeys.textract.page(publicId, Number(pageNumber)),
      data,
    );
  }
}
