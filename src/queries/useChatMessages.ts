"use client";

import type { ChatMsg } from "@/types";

// [refactor jul9 P2.2①] Loader-side hydration transform, extracted VERBATIM from the old inline
// map at project/[id]/page.tsx:147-153 (zero behavior change — this commit is a pure extraction).
// Coerces the DB `model` null/"" -> undefined; `role` is a bare `as` cast with NO validation
// (frozen quirk — a stray role passes through and renders as an "AI" bubble). This is the canonical
// "DB rows -> domain type" unit the TEMPLATE reuses for ③summaries ④takeoff ⑨yoloTags.
export function mapChatRows(
  rows: Array<{ id: number; role: string; content: string; model: string | null }>,
): ChatMsg[] {
  return rows.map((c) => ({
    id: c.id,
    role: c.role as "user" | "assistant",
    content: c.content,
    model: c.model || undefined,
  }));
}
