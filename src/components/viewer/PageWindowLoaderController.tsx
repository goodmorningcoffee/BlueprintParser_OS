"use client";

import { useChunkLoader } from "@/hooks/useChunkLoader";

/**
 * Own the navigation page-window state machine without coupling its range subscription to the
 * heavyweight PDF viewer render tree. This controller must remain mounted for both the viewer's
 * success and PDF-error surfaces so request cleanup/recovery keeps the same lifetime as before.
 */
export default function PageWindowLoaderController() {
  useChunkLoader();
  return null;
}
