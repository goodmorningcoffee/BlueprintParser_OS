"use client";

// [TP-3 WP-3.L] Why the inbox is empty (C3-m9): nothing detected here yet, everything here reviewed, or the read
// failed. Always offers "+ Region" (draw the box yourself); a root admin also gets "Run detection" (the admin
// Reprocess tab, where detection is re-run for a project). The session is read from next-auth's SessionContext
// directly (as TextractRerunButton does), so without a provider — tests, previews — no admin link renders.

import { useContext } from "react";
import { SessionContext } from "next-auth/react";
import { startDraw } from "@/stores/workspaceCommands";
import { wsButton } from "./WorkspaceHeader";

export type EmptyReason = "none" | "reviewed" | "filtered" | "error";

const MESSAGES: Readonly<Record<EmptyReason, string>> = {
  none: "No tables or notes were detected here yet. Detection may not have run on this sheet, or it found nothing.",
  reviewed: "Everything here has been reviewed.",
  filtered: "Nothing matches this filter and these kinds.",
  error: "The inbox could not be loaded.",
};

export default function EmptyState({ reason, scope }: { reason: EmptyReason; scope: "sheet" | "all" }) {
  const sessionCtx = useContext(SessionContext);
  const isRoot =
    sessionCtx?.status === "authenticated" &&
    (sessionCtx.data?.user as { isRootAdmin?: boolean } | null | undefined)?.isRootAdmin === true;
  return (
    <div role="status" className="flex flex-col gap-2 px-2 py-3 text-[11px] text-[var(--muted)]">
      <p>
        {MESSAGES[reason]}
        {reason === "none" && scope === "sheet" ? " Try All sheets, or draw a box." : ""}
      </p>
      <div className="flex flex-wrap gap-1">
        <button type="button" onClick={startDraw} className={wsButton(false)}>
          + Region
        </button>
        {isRoot && (reason === "none" || reason === "error") ? (
          <a href="/admin?tab=reprocess" className={wsButton(false)}>
            Run detection
          </a>
        ) : null}
      </div>
    </div>
  );
}
