"use client";

// [classifier builder track 3] The diff of a draft against its built-in, one line per change
// (lib/classifier-engine/overlay-edit.ts describePatch).

import type { DiffLine } from "@/lib/classifier-engine";

const KIND: Record<DiffLine["kind"], string> = { changed: "text-amber-300", added: "text-emerald-300", removed: "text-red-300" };

export default function DiffView({ lines }: { lines: DiffLine[] }) {
  if (!lines.length) return <p className="text-[10px] text-[var(--muted)] italic">Identical to the built-in.</p>;
  return (
    <table className="text-[11px] w-full">
      <thead><tr className="text-left text-[var(--muted)]"><th className="pr-3 font-normal">where</th><th className="pr-3 font-normal">change</th><th className="pr-3 font-normal">built-in</th><th className="font-normal">this company</th></tr></thead>
      <tbody>
        {lines.map((l, i) => (
          <tr key={i} className="border-t border-[var(--border)] align-top">
            <td className="pr-3 py-0.5">{l.path}</td>
            <td className={`pr-3 py-0.5 ${KIND[l.kind]}`}>{l.kind}</td>
            <td className="pr-3 py-0.5 font-mono break-all max-w-[18rem] text-[var(--muted)]">{l.from ?? ""}</td>
            <td className="py-0.5 font-mono break-all max-w-[18rem]">{l.to ?? ""}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
