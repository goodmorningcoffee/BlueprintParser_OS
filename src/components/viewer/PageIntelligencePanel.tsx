"use client";

import { useMemo, useState } from "react";
import { useNavigation, usePageData, usePanels } from "@/stores/viewerStore";

export default function PageIntelligencePanel() {
  const { pageNumber } = useNavigation();
  const { pageIntelligence } = usePageData();
  const { togglePageIntelPanel } = usePanels();

  const [expandedSections, setExpandedSections] = useState<Record<string, boolean>>({
    classification: true,
    crossRefs: true,
    noteBlocks: false,
    regions: true,
    heuristics: true,
    tables: true,
    parsedRegions: true,
  });
  const [copied, setCopied] = useState(false);

  const intel = pageIntelligence[pageNumber] as any;

  function toggleSection(key: string) {
    setExpandedSections((p) => ({ ...p, [key]: !p[key] }));
  }

  // Build plain-text summary for copy
  const plainText = useMemo(() => {
    if (!intel) return "No page intelligence data available.";
    const lines: string[] = [];
    lines.push(`Page Intelligence — Page ${pageNumber}`);
    lines.push("─".repeat(40));

    if (intel.classification) {
      const c = intel.classification;
      lines.push(`\nClassification:`);
      lines.push(`  Discipline: ${c.discipline} (${c.disciplinePrefix})`);
      if (c.subType) lines.push(`  Drawing Type: ${c.subType}`);
      if (c.series) lines.push(`  Series: ${c.series}`);
      lines.push(`  Confidence: ${Math.round((c.confidence || 0) * 100)}%`);
    }

    if (intel.crossRefs?.length > 0) {
      lines.push(`\nCross-References (${intel.crossRefs.length}):`);
      for (const r of intel.crossRefs) {
        lines.push(`  ${r.refType}: ${r.sourceText} → ${r.targetDrawing}`);
      }
    }

    if (intel.noteBlocks?.length > 0) {
      lines.push(`\nNote Blocks (${intel.noteBlocks.length}):`);
      for (const b of intel.noteBlocks) {
        lines.push(`  ${b.title} — ${b.noteCount} notes`);
        for (const n of (b.notes || []).slice(0, 5)) {
          lines.push(`    ${n}`);
        }
        if (b.notes?.length > 5) lines.push(`    ... (${b.notes.length - 5} more)`);
      }
    }

    if (intel.classifiedTables?.length > 0) {
      lines.push(`\nClassified Tables (${intel.classifiedTables.length}):`);
      for (const t of intel.classifiedTables) {
        const csi = t.csiTags?.length ? ` [${t.csiTags.map((c: any) => `CSI ${c.code}`).join(", ")}]` : "";
        lines.push(`  ${t.category}: "${t.headerText || "untitled"}" (${Math.round(t.confidence * 100)}%)${csi}`);
        if (t.evidence?.length) lines.push(`    Evidence: ${t.evidence.join(", ")}`);
      }
    }

    if (intel.heuristicInferences?.length > 0) {
      lines.push(`\nHeuristic Inferences (${intel.heuristicInferences.length}):`);
      for (const h of intel.heuristicInferences) {
        const csi = h.csiTags?.length ? ` [${h.csiTags.map((c: any) => `CSI ${c.code}`).join(", ")}]` : "";
        lines.push(`  ${h.label} (${Math.round(h.confidence * 100)}%)${csi}`);
        if (h.evidence?.length) lines.push(`    Evidence: ${h.evidence.join(", ")}`);
      }
    }

    if (intel.textRegions?.length > 0) {
      const nonParagraph = intel.textRegions.filter((r: any) => r.type !== "paragraph");
      if (nonParagraph.length > 0) {
        lines.push(`\nText Regions (${nonParagraph.length}):`);
        for (const r of nonParagraph) {
          const csi = r.csiTags?.length ? ` [${r.csiTags.map((c: any) => `CSI ${c.code}`).join(", ")}]` : "";
          lines.push(`  ${r.type}: ${r.wordCount} words${r.headerText ? `, "${r.headerText}"` : ""}${r.columnCount ? `, ${r.columnCount} cols` : ""}${csi}`);
        }
      }
    }

    if (intel.parsedRegions?.length > 0) {
      lines.push(`\nParsed Regions (${intel.parsedRegions.length}):`);
      for (const pr of intel.parsedRegions) {
        const csi = pr.csiTags?.length ? ` [${pr.csiTags.map((c: any) => `CSI ${c.code}`).join(", ")}]` : "";
        lines.push(`  ${pr.category} (${Math.round(pr.confidence * 100)}%)${csi}`);
        if (pr.type === "schedule" && pr.data) {
          const d = pr.data as any;
          lines.push(`    ${d.columnCount} columns, ${d.rowCount} rows`);
          if (d.tagColumn) lines.push(`    Tag column: ${d.tagColumn}`);
          lines.push(`    Headers: ${d.headers?.join(" | ")}`);
          for (const row of (d.rows || []).slice(0, 3)) {
            const vals = d.headers.map((h: string) => row[h] || "").join(" | ");
            lines.push(`    ${vals}`);
          }
          if (d.rowCount > 3) lines.push(`    ... (${d.rowCount - 3} more rows)`);
        }
      }
    }

    return lines.join("\n");
  }, [intel, pageNumber]);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(plainText);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* clipboard not available */ }
  }

  return (
    <div className="w-72 flex flex-col h-full border border-[var(--border)] bg-[var(--surface)] shadow-lg">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-[var(--border)]">
        <h3 className="text-sm font-semibold text-[var(--fg)]">Page Intelligence</h3>
        <div className="flex items-center gap-1">
          <button
            onClick={handleCopy}
            className="text-[10px] px-1.5 py-0.5 rounded text-[var(--muted)] hover:text-[var(--fg)] hover:bg-[var(--surface)]"
            title="Copy to clipboard"
          >
            {copied ? "Copied!" : "Copy"}
          </button>
          <button onClick={togglePageIntelPanel} className="text-[var(--muted)] hover:text-[var(--fg)] text-lg leading-none">
            &times;
          </button>
        </div>
      </div>

      {/* Page indicator */}
      <div className="px-3 py-1.5 border-b border-[var(--border)] text-[10px] text-[var(--muted)]">
        Page {pageNumber}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto px-2 py-2 space-y-1">
        {!intel ? (
          <p className="text-xs text-[var(--muted)] text-center py-8">
            No intelligence data for this page.
            <br />
            <span className="text-[10px]">Process the project to generate page intelligence.</span>
          </p>
        ) : (
          <>
            {/* Classification */}
            {intel.classification && (
              <Section title="Classification" sectionKey="classification" expanded={expandedSections} onToggle={toggleSection}>
                <div className="space-y-0.5 text-[11px]">
                  <div>
                    <span className="text-[var(--muted)]">Discipline: </span>
                    <span className="text-[var(--fg)] font-medium">{intel.classification.discipline}</span>
                    <span className="text-[var(--muted)]"> ({intel.classification.disciplinePrefix})</span>
                  </div>
                  {intel.classification.subType && (
                    <div>
                      <span className="text-[var(--muted)]">Type: </span>
                      <span className="text-[var(--fg)]">{intel.classification.subType}</span>
                    </div>
                  )}
                  {intel.classification.series && (
                    <div>
                      <span className="text-[var(--muted)]">Series: </span>
                      <span className="text-[var(--fg)]">{intel.classification.series}</span>
                    </div>
                  )}
                  <div>
                    <span className="text-[var(--muted)]">Confidence: </span>
                    <span className="text-[var(--fg)]">{Math.round((intel.classification.confidence || 0) * 100)}%</span>
                  </div>
                </div>
              </Section>
            )}

            {/* Cross-References */}
            {intel.crossRefs?.length > 0 && (
              <Section title={`Cross-References (${intel.crossRefs.length})`} sectionKey="crossRefs" expanded={expandedSections} onToggle={toggleSection}>
                <div className="space-y-1">
                  {intel.crossRefs.map((r: any, i: number) => (
                    <div key={i} className="text-[11px]">
                      <span className="text-[var(--muted)]">{r.refType}: </span>
                      <span className="text-[var(--fg)]">{r.sourceText}</span>
                      <span className="text-[var(--accent)]"> → {r.targetDrawing}</span>
                    </div>
                  ))}
                </div>
              </Section>
            )}

            {/* Note Blocks */}
            {intel.noteBlocks?.length > 0 && (
              <Section title={`Note Blocks (${intel.noteBlocks.length})`} sectionKey="noteBlocks" expanded={expandedSections} onToggle={toggleSection}>
                <div className="space-y-2">
                  {intel.noteBlocks.map((b: any, i: number) => (
                    <div key={i}>
                      <div className="text-[11px] font-medium text-[var(--fg)]">{b.title} — {b.noteCount} notes</div>
                      <div className="ml-2 space-y-0.5">
                        {(b.notes || []).slice(0, 5).map((n: string, j: number) => (
                          <div key={j} className="text-[10px] text-[var(--muted)] truncate" title={n}>{n}</div>
                        ))}
                        {b.notes?.length > 5 && (
                          <div className="text-[10px] text-[var(--muted)] italic">+{b.notes.length - 5} more</div>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </Section>
            )}

            {/* Classified Tables */}
            {intel.classifiedTables?.length > 0 && (
              <Section title={`Classified Tables (${intel.classifiedTables.length})`} sectionKey="tables" expanded={expandedSections} onToggle={toggleSection}>
                <div className="space-y-1.5">
                  {intel.classifiedTables.map((t: any, i: number) => (
                    <div key={i} className="text-[11px]">
                      <div className="flex items-center gap-1">
                        <span className="font-medium text-[var(--fg)]">{t.category}</span>
                        <span className="text-[var(--muted)]">({Math.round(t.confidence * 100)}%)</span>
                      </div>
                      {t.headerText && <div className="text-[10px] text-[var(--muted)]">"{t.headerText}"</div>}
                      {t.csiTags?.length > 0 && (
                        <div className="flex flex-wrap gap-1 mt-0.5">
                          {t.csiTags.map((c: any, j: number) => (
                            <span key={j} className="text-[9px] px-1 py-0.5 rounded bg-blue-500/10 text-blue-300 font-mono">
                              CSI {c.code}
                            </span>
                          ))}
                        </div>
                      )}
                      {t.evidence?.length > 0 && (
                        <div className="text-[9px] text-[var(--muted)] mt-0.5">
                          Evidence: {t.evidence.join(", ")}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </Section>
            )}

            {/* Parsed Regions (System 4 — extracted schedule/keynote data) */}
            {intel.parsedRegions?.length > 0 && (
              <Section title={`Parsed Data (${intel.parsedRegions.length})`} sectionKey="parsedRegions" expanded={expandedSections} onToggle={toggleSection}>
                <div className="space-y-2">
                  {intel.parsedRegions.map((pr: any, i: number) => (
                    <div key={i}>
                      <div className="flex items-center gap-1 text-[11px]">
                        <span className="font-medium text-green-400">{pr.category}</span>
                        <span className="text-[var(--muted)]">({Math.round(pr.confidence * 100)}%)</span>
                      </div>
                      {pr.csiTags?.length > 0 && (
                        <div className="flex flex-wrap gap-1 mt-0.5">
                          {pr.csiTags.map((c: any, j: number) => (
                            <span key={j} className="text-[9px] px-1 py-0.5 rounded bg-blue-500/10 text-blue-300 font-mono">
                              CSI {c.code}
                            </span>
                          ))}
                        </div>
                      )}

                      {/* Schedule data table preview */}
                      {pr.type === "schedule" && pr.data && (
                        <div className="mt-1">
                          <div className="text-[10px] text-[var(--muted)]">
                            {pr.data.columnCount} cols, {pr.data.rowCount} rows
                            {pr.data.tagColumn && (
                              <span className="ml-1 text-green-400">tag: {pr.data.tagColumn}</span>
                            )}
                          </div>
                          {/* Mini table preview */}
                          <div className="mt-1 overflow-x-auto">
                            <table className="text-[9px] border-collapse w-full">
                              <thead>
                                <tr>
                                  {(pr.data.headers || []).map((h: string, hi: number) => (
                                    <th
                                      key={hi}
                                      className="border border-[var(--border)] px-1 py-0.5 text-left font-semibold text-[var(--fg)] bg-[var(--surface)]"
                                    >
                                      {h}
                                    </th>
                                  ))}
                                </tr>
                              </thead>
                              <tbody>
                                {(pr.data.rows || []).slice(0, 5).map((row: any, ri: number) => (
                                  <tr key={ri}>
                                    {(pr.data.headers || []).map((h: string, ci: number) => (
                                      <td
                                        key={ci}
                                        className="border border-[var(--border)] px-1 py-0.5 text-[var(--muted)] max-w-[80px] truncate"
                                        title={row[h] || ""}
                                      >
                                        {row[h] || ""}
                                      </td>
                                    ))}
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                            {pr.data.rowCount > 5 && (
                              <div className="text-[9px] text-[var(--muted)] mt-0.5 italic">
                                +{pr.data.rowCount - 5} more rows
                              </div>
                            )}
                          </div>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </Section>
            )}

            {/* Heuristic Inferences */}
            {intel.heuristicInferences?.length > 0 && (
              <Section title={`Heuristic Inferences (${intel.heuristicInferences.length})`} sectionKey="heuristics" expanded={expandedSections} onToggle={toggleSection}>
                <div className="space-y-1.5">
                  {intel.heuristicInferences.map((h: any, i: number) => (
                    <div key={i} className="text-[11px]">
                      <div className="flex items-center gap-1">
                        <span className="font-medium text-[var(--fg)]">{h.label}</span>
                        <span className="text-[var(--muted)]">({Math.round(h.confidence * 100)}%)</span>
                      </div>
                      {h.csiTags?.length > 0 && (
                        <div className="flex flex-wrap gap-1 mt-0.5">
                          {h.csiTags.map((c: any, j: number) => (
                            <span key={j} className="text-[9px] px-1 py-0.5 rounded bg-blue-500/10 text-blue-300 font-mono">
                              CSI {c.code}
                            </span>
                          ))}
                        </div>
                      )}
                      {h.evidence?.length > 0 && (
                        <div className="text-[9px] text-[var(--muted)] mt-0.5">
                          {h.evidence.join(", ")}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </Section>
            )}

            {/* Text Regions (non-paragraph only) */}
            {intel.textRegions?.filter((r: any) => r.type !== "paragraph").length > 0 && (
              <Section
                title={`Text Regions (${intel.textRegions.filter((r: any) => r.type !== "paragraph").length})`}
                sectionKey="regions"
                expanded={expandedSections}
                onToggle={toggleSection}
              >
                <div className="space-y-1">
                  {intel.textRegions
                    .filter((r: any) => r.type !== "paragraph")
                    .map((r: any, i: number) => (
                      <div key={i} className="text-[11px]">
                        <span className="text-[var(--accent)] font-mono">{r.type}</span>
                        <span className="text-[var(--muted)]">
                          {" "}— {r.wordCount} words
                          {r.headerText ? `, "${r.headerText}"` : ""}
                          {r.columnCount ? `, ${r.columnCount} cols` : ""}
                        </span>
                        {r.csiTags?.length > 0 && (
                          <div className="flex flex-wrap gap-1 mt-0.5">
                            {r.csiTags.map((c: any, j: number) => (
                              <span key={j} className="text-[9px] px-1 py-0.5 rounded bg-blue-500/10 text-blue-300 font-mono">
                                CSI {c.code}
                              </span>
                            ))}
                          </div>
                        )}
                      </div>
                    ))}
                </div>
              </Section>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/** Collapsible section wrapper */
function Section({
  title,
  sectionKey,
  expanded,
  onToggle,
  children,
}: {
  title: string;
  sectionKey: string;
  expanded: Record<string, boolean>;
  onToggle: (key: string) => void;
  children: React.ReactNode;
}) {
  const isExpanded = expanded[sectionKey] ?? false;
  return (
    <div className="border border-[var(--border)] rounded">
      <button
        onClick={() => onToggle(sectionKey)}
        className="w-full flex items-center gap-2 px-2 py-1.5 text-left hover:bg-[var(--surface-hover)]"
      >
        <span className="text-[10px] text-[var(--muted)] w-3">{isExpanded ? "▼" : "▶"}</span>
        <span className="text-[11px] font-medium text-[var(--fg)]">{title}</span>
      </button>
      {isExpanded && <div className="px-2 pb-2">{children}</div>}
    </div>
  );
}
