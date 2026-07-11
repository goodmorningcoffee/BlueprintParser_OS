"use client";

import { useTextractLoader } from "@/hooks/useTextractLoader";

/** Keep Textract request lifetime/reactivity out of the heavyweight PDF viewer render tree. */
export default function TextractLoaderController() {
  useTextractLoader();
  return null;
}
