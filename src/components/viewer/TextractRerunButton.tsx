"use client";

/**
 * [2026-10-25] The "Re-run Textract" control of TextPanel's TextractTab, split out so TextPanel
 * stays under its line ceiling. Re-running Textract is root-only (owner-billed): with a signed-in
 * NON-root session the button is replaced by a note. The session is read from next-auth's
 * SessionContext directly (not useSession, which throws outside a provider), so without a
 * provider — tests, previews — the button renders exactly as before.
 */

import { useContext } from "react";
import { SessionContext } from "next-auth/react";

export function TextractRerunButton({
  onClick,
  loading,
  publicId,
  isDemo,
}: {
  onClick: () => void;
  loading: boolean;
  publicId: string | null | undefined;
  isDemo: boolean;
}) {
  const sessionCtx = useContext(SessionContext);
  const hideForNonRoot =
    sessionCtx?.status === "authenticated" &&
    (sessionCtx.data?.user as { isRootAdmin?: boolean } | null | undefined)?.isRootAdmin !== true;
  if (hideForNonRoot) {
    return (
      <p className="text-[10px] text-[var(--muted)] leading-snug">
        Re-running Textract is a root-admin action (it is billed to the owner).
      </p>
    );
  }
  return (
    <button
      onClick={onClick}
      disabled={loading || !publicId || isDemo}
      className={`w-full px-3 py-2 rounded border text-sm font-medium transition-colors ${
        loading
          ? "border-[var(--border)] text-[var(--muted)] cursor-wait"
          : !publicId || isDemo
          ? "border-[var(--border)] text-[var(--muted)]/50 cursor-not-allowed"
          : "border-[var(--accent)]/60 text-[var(--accent)] bg-[var(--accent)]/10 hover:bg-[var(--accent)]/20"
      }`}
    >
      {loading ? "Re-running Textract…" : "Re-run Textract"}
    </button>
  );
}
