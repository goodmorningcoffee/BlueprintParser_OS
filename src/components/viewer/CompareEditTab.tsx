"use client";

import { useNavigation, useProject } from "@/stores/viewerStore";

interface CompareEditTabProps {
  allParsedTables: any[];
  loadExistingParsed: (parsed: any) => void;
  toggleTableCompareModal: () => void;
}

export default function CompareEditTab({
  allParsedTables,
  loadExistingParsed,
  toggleTableCompareModal,
}: CompareEditTabProps) {
  const { pageNumber, setPage } = useNavigation();
  const { pageNames } = useProject();

  return (
    <div className="space-y-1">
      <div className="text-[11px] text-[var(--muted)] px-1 pb-1">
        Select a table to compare with the original and edit cells.
      </div>

      {allParsedTables.length === 0 ? (
        <div className="text-[10px] text-[var(--muted)] text-center py-8 px-2">
          No parsed tables yet. Use Auto Parse or Manual tabs first.
        </div>
      ) : (
        <>
          {(() => {
            const currentPageTables = allParsedTables.filter((t) => t.pageNum === pageNumber);
            const otherTables = allParsedTables.filter((t) => t.pageNum !== pageNumber);

            return (
              <>
                {currentPageTables.length > 0 && (
                  <div className="text-[9px] text-pink-300 uppercase tracking-wide px-1 pt-1">
                    This Page ({pageNames[pageNumber] || `p.${pageNumber}`})
                  </div>
                )}
                {currentPageTables.map((t, i) => (
                  <button
                    key={`cur-${i}`}
                    onClick={() => {
                      loadExistingParsed(t.region);
                      toggleTableCompareModal();
                    }}
                    className="w-full text-left px-2 py-2 rounded border border-pink-400/30 bg-pink-500/5 hover:bg-pink-500/10 space-y-0.5"
                  >
                    <div className="flex items-center justify-between">
                      <span className="text-[11px] font-medium text-[var(--fg)] truncate">{t.name}</span>
                      <span className="text-[9px] text-pink-300">Compare</span>
                    </div>
                    <div className="text-[10px] text-[var(--muted)]">
                      {t.colCount} cols, {t.rowCount} rows
                    </div>
                  </button>
                ))}

                {otherTables.length > 0 && (
                  <div className="text-[9px] text-[var(--muted)] uppercase tracking-wide px-1 pt-2">
                    Other Pages
                  </div>
                )}
                {otherTables.map((t, i) => (
                  <button
                    key={`other-${i}`}
                    onClick={() => {
                      setPage(t.pageNum);
                      loadExistingParsed(t.region);
                      toggleTableCompareModal();
                    }}
                    className="w-full text-left px-2 py-1.5 rounded border border-[var(--border)] hover:bg-[var(--surface-hover)] space-y-0.5"
                  >
                    <div className="flex items-center justify-between">
                      <span className="text-[11px] font-medium text-[var(--fg)] truncate">{t.name}</span>
                      <span className="text-[9px] text-[var(--muted)]">{pageNames[t.pageNum] || `p.${t.pageNum}`}</span>
                    </div>
                    <div className="text-[10px] text-[var(--muted)]">
                      {t.colCount} cols, {t.rowCount} rows
                    </div>
                  </button>
                ))}
              </>
            );
          })()}
        </>
      )}
    </div>
  );
}
