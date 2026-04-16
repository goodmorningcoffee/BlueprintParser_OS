/**
 * primitives/scope.ts — Page-scope filter builder.
 *
 * Consumer-agnostic. Builds a ScopeFilter that answers "is this page in
 * scope?" — applied at query time by find-occurrences and any future mapper.
 *
 * Scope signals supported today:
 *   - pages:                 explicit page-number intersection
 *   - drawingNumberPrefixes: e.g., ["E-", "M-"] — matches pages.drawingNumber
 *   - trades:                scaffolded, not yet honored (requires the
 *                            sheet-trade classifier — Phase 1 F2 of
 *                            tableSteaksFeatureRoadmap.md)
 *
 * When no options are given, returns an allow-all filter.
 */

import type { PageMeta, ScopeFilter, ScopeOptions } from "../types";

/**
 * Build a scope filter from a set of options + the project's page metadata.
 * `pageMeta` should cover every page the caller plans to scan; pages absent
 * from `pageMeta` will be denied by a prefix-based filter.
 */
export function buildScope(
  opts: ScopeOptions,
  pageMeta: PageMeta[],
): ScopeFilter {
  const explicitPages = opts.pages ? new Set(opts.pages) : null;
  const prefixes = opts.drawingNumberPrefixes?.map((p) => p.toUpperCase()) ?? null;
  const allowedByPrefix = prefixes
    ? new Set(
        pageMeta
          .filter((p) =>
            p.drawingNumber
              ? prefixes.some((pre) => p.drawingNumber!.toUpperCase().startsWith(pre))
              : false,
          )
          .map((p) => p.pageNumber),
      )
    : null;

  // Trades: allow-all for now. Log once so the signal is visible during
  // development without spamming production.
  if (opts.trades && opts.trades.length > 0) {
    // eslint-disable-next-line no-console
    console.info(
      `[tag-mapping/scope] trades filter requested (${opts.trades.join(",")}) but ` +
      `sheet-trade classifier is not built yet — allow-all`,
    );
  }

  const allowsPage = (pageNumber: number): boolean => {
    if (explicitPages && !explicitPages.has(pageNumber)) return false;
    if (allowedByPrefix && !allowedByPrefix.has(pageNumber)) return false;
    return true;
  };

  const describe = (): string => {
    const parts: string[] = [];
    if (explicitPages) parts.push(`pages=[${[...explicitPages].sort((a, b) => a - b).join(",")}]`);
    if (prefixes) parts.push(`prefixes=[${prefixes.join(",")}]`);
    if (opts.trades?.length) parts.push(`trades=[${opts.trades.join(",")}] (not yet honored)`);
    return parts.length > 0 ? parts.join(" & ") : "all pages";
  };

  return {
    allowsPage,
    filterPageNumbers: (all: number[]) => all.filter(allowsPage),
    describe,
  };
}

/** Allow-all scope — the neutral default when no scope is supplied. */
export function allPagesScope(): ScopeFilter {
  return {
    allowsPage: () => true,
    filterPageNumbers: (all: number[]) => all,
    describe: () => "all pages",
  };
}
