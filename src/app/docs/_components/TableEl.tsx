import type { ReactNode } from "react";

interface TableElProps {
  headers: (string | ReactNode)[];
  rows: (string | ReactNode)[][];
  caption?: string;
  dense?: boolean;
}

export function TableEl({ headers, rows, caption, dense }: TableElProps) {
  const cellPad = dense ? "px-2 py-1" : "px-3 py-2";
  return (
    <div className="my-4">
      {caption && (
        <div className="text-xs text-[var(--muted)] mb-1 font-mono">{caption}</div>
      )}
      <div className="overflow-x-auto">
        <table className="w-full text-sm border border-[var(--border)] rounded-lg overflow-hidden">
          <thead>
            <tr className="bg-[var(--surface)]">
              {headers.map((h, i) => (
                <th
                  key={i}
                  className={`${cellPad} text-left font-semibold text-[var(--fg)] border-b border-[var(--border)] text-[12px] uppercase tracking-wider`}
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr
                key={i}
                className={i % 2 === 1 ? "bg-[var(--surface)]/40" : ""}
              >
                {row.map((cell, j) => (
                  <td
                    key={j}
                    className={`${cellPad} border-b border-[var(--border)] text-[var(--fg)]/85`}
                  >
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
