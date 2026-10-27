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

/** A page the "Unnumbered" chip groups: no drawing number, or one with no non-digit prefix (the chips' `/^[^\d]+/`). */
const unnumbered = (drawingNumber: string | null | undefined): boolean => !/^[^\d]+/.test(drawingNumber ?? "");

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
  // [K37] The "Unnumbered" chip sends prefix "": it selects pages whose drawing number has no letter prefix
  // (none, empty, or starting with a digit: the chips' own grouping), never every numbered page.
  const allowedByPrefix = prefixes
    ? new Set(
        pageMeta
          .filter((p) => prefixes.some((pre) => (pre === "" ? unnumbered(p.drawingNumber) : (p.drawingNumber ?? "").toUpperCase().startsWith(pre))))
          .map((p) => p.pageNumber),
      )
    : null;

  // Trades: allow-all for now. Log once so the signal is visible during
  // development without spamming production.
  // (No eslint-disable needed: `no-console` is not enabled by this repo's config, so a
  // directive here is itself reported as unused. Do not re-add one unless the rule lands.)
  if (opts.trades && opts.trades.length > 0) {
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
