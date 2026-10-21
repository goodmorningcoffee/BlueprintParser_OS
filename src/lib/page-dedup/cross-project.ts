// Cross-project exact-copy report (PLAN §2.1, critic #3). Report only in v1: nothing is
// marked. With "several files make several projects" a re-uploaded set lands as project B,
// a page-for-page copy of A; this says so.

import { DEDUP_THRESHOLDS } from "./detect";
import { normalizedLines, tokensOf } from "./normalize";
import { textHash64 } from "./similarity";

/** ≥ this share of B's comparable pages found in A → "page-for-page copy". */
export const CROSS_PROJECT_COPY_SHARE = 0.95;
/** A page text shared by more projects than this is a stock sheet, not a copy signal. */
export const CROSS_PROJECT_MAX_OWNERS = 50;

/** The exact-text key of one page, or null when it is too blank to compare. */
export function pageTextKey(rawText: string | null): string | null {
  const lines = normalizedLines(rawText);
  if (tokensOf(lines).length < DEDUP_THRESHOLDS.minContentTokens) return null;
  return textHash64(lines.join(" "));
}

export interface CrossProjectInput {
  project: string;
  /** Exact-text keys of the project's comparable pages (pageTextKey, nulls dropped). */
  keys: readonly string[];
}

export interface CrossProjectPair {
  /** The earlier project in input order (usually the older upload). */
  a: string;
  b: string;
  /** Distinct page texts of B also present in A. */
  shared: number;
  /** Distinct comparable page texts in B. */
  bPages: number;
  aPages: number;
  copy: boolean;
}

/** Every project pair sharing ≥ 1 exact page text, B = the later project in input order. */
export function crossProjectReport(projects: readonly CrossProjectInput[]): CrossProjectPair[] {
  const owners = new Map<string, number[]>();
  const distinct = projects.map((p) => new Set(p.keys));
  distinct.forEach((keys, index) => {
    for (const k of keys) {
      const list = owners.get(k);
      if (list) list.push(index);
      else owners.set(k, [index]);
    }
  });
  const shared = new Map<string, number>();
  for (const list of owners.values()) {
    if (list.length < 2 || list.length > CROSS_PROJECT_MAX_OWNERS) continue;
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const k = `${list[i]}:${list[j]}`;
        shared.set(k, (shared.get(k) ?? 0) + 1);
      }
    }
  }
  const out: CrossProjectPair[] = [];
  for (const [k, n] of shared) {
    const [ai, bi] = k.split(":").map(Number);
    const bPages = distinct[bi].size;
    out.push({
      a: projects[ai].project,
      b: projects[bi].project,
      shared: n,
      bPages,
      aPages: distinct[ai].size,
      copy: bPages > 0 && n / bPages >= CROSS_PROJECT_COPY_SHARE,
    });
  }
  return out.sort((x, y) => y.shared - x.shared || x.a.localeCompare(y.a) || x.b.localeCompare(y.b));
}
