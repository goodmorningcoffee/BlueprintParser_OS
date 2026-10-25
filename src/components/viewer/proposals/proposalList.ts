// [classifier-builder 2026-10-24] Pure view model for the "Proposed tables" list: scope (this page / all
// pages), verdict filter, then grouping by discipline group (SCHEDULE_GROUP_NAMES order) and kind.

import type { ProposalSummaryItem } from "@/lib/classifier-engine/types";
import {
  OTHER_SCHEDULE,
  SCHEDULE_GROUP_NAMES,
  scheduleKind,
  type ScheduleGroup,
} from "@/lib/classifier-engine/vocabulary";

export type ProposalScope = "page" | "all";
export type ProposalFilter = "unreviewed" | "accepted" | "rejected";

export interface ProposalKindGroup {
  key: string;
  label: string;
  items: ProposalSummaryItem[];
}

export interface ProposalGroup {
  key: string;
  label: string;
  count: number;
  kinds: ProposalKindGroup[];
}

const GROUP_ORDER = Object.keys(SCHEDULE_GROUP_NAMES) as ScheduleGroup[];

/** accept and rename are both "accepted" (the box is a table; rename only corrects its kind). */
export function matchesFilter(item: ProposalSummaryItem, filter: ProposalFilter): boolean {
  if (filter === "unreviewed") return item.verdict === undefined;
  if (filter === "rejected") return item.verdict === "reject";
  return item.verdict === "accept" || item.verdict === "rename";
}

function groupKeyOf(item: ProposalSummaryItem): string {
  return item.group ?? (item.classId ? scheduleKind(item.classId)?.group : undefined) ?? "other";
}

function groupLabel(key: string): string {
  return SCHEDULE_GROUP_NAMES[key as ScheduleGroup] ?? key;
}

function kindKeyOf(item: ProposalSummaryItem): string {
  return item.classId ?? OTHER_SCHEDULE;
}

function kindLabel(key: string, sample: ProposalSummaryItem): string {
  return scheduleKind(key)?.name ?? (sample.classId ? sample.className : "Other schedule");
}

function groupRank(key: string): number {
  const i = GROUP_ORDER.indexOf(key as ScheduleGroup);
  return i === -1 ? GROUP_ORDER.length : i;
}

/** `filter` absent = every verdict state (the View All section lists everything). */
export function buildProposalGroups(
  items: readonly ProposalSummaryItem[],
  opts: { scope: ProposalScope; pageNumber: number; filter?: ProposalFilter; keepId?: string | null },
): ProposalGroup[] {
  const groups = new Map<string, Map<string, ProposalSummaryItem[]>>();
  for (const item of items) {
    if (opts.scope === "page" && item.pageNumber !== opts.pageNumber) continue;
    // The focused row stays listed after its verdict moves it out of the filter, so Undo stays reachable.
    if (opts.filter && !matchesFilter(item, opts.filter) && item.id !== opts.keepId) continue;
    const g = groupKeyOf(item);
    const kinds = groups.get(g) ?? new Map<string, ProposalSummaryItem[]>();
    groups.set(g, kinds);
    const k = kindKeyOf(item);
    kinds.set(k, [...(kinds.get(k) ?? []), item]);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => groupRank(a) - groupRank(b) || a.localeCompare(b))
    .map(([key, kinds]) => {
      const kindGroups = [...kinds.entries()]
        .map(([kindKey, list]) => ({
          key: kindKey,
          label: kindLabel(kindKey, list[0]),
          items: [...list].sort((x, y) => x.pageNumber - y.pageNumber || y.p - x.p),
        }))
        .sort((x, y) => x.label.localeCompare(y.label));
      return {
        key,
        label: groupLabel(key),
        count: kindGroups.reduce((n, kg) => n + kg.items.length, 0),
        kinds: kindGroups,
      };
    });
}

export function filterCounts(
  items: readonly ProposalSummaryItem[],
  scope: ProposalScope,
  pageNumber: number,
): Record<ProposalFilter, number> {
  const counts: Record<ProposalFilter, number> = { unreviewed: 0, accepted: 0, rejected: 0 };
  for (const item of items) {
    if (scope === "page" && item.pageNumber !== pageNumber) continue;
    for (const f of ["unreviewed", "accepted", "rejected"] as const) if (matchesFilter(item, f)) counts[f]++;
  }
  return counts;
}

export const pct = (x: number): string => `${Math.round(Math.max(0, Math.min(1, x)) * 100)}%`;
