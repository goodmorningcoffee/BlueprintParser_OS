// Duplicate PROJECTS — pure grouping, match levels and keeper choice (Admin › Data tools,
// owner 2026-10-22: "delete duplicate uploaded projects: first check if any project is named
// exactly the same, next look at … the CHEAPEST thing to compare whether two uploaded PDFs are
// actually the same").
//
// Signals, cheapest first (all but the last come from Postgres alone):
//   same-name     names equal byte for byte;
//   similar-name  equal after case + whitespace normalization;
//   same-size     the stored upload manifest (stagingManifest: every uploaded file's byte size,
//                 in order) is equal — a CANDIDATE signal only, never a verdict on its own;
//   same-text     page count + a hash over each page's stored text, in page order;
//   identical-file  the original PDF's S3 ETag (+ size) is equal, or — when ETags cannot be
//                 compared (multipart with different part counts) — a streamed SHA-256 is.
// A group is a connected set of projects (one company) linked by any signal. Each member's
// level is measured against the group's KEEPER, so changing the keeper re-labels the group.

export type ProjectMatchLevel = "identical-file" | "same-text" | "same-name" | "similar-name" | "same-size";

/** Strongest first. */
export const MATCH_LEVELS: readonly ProjectMatchLevel[] = ["identical-file", "same-text", "same-name", "similar-name", "same-size"];

export const MATCH_LABEL: Record<ProjectMatchLevel, string> = {
  "identical-file": "byte-identical PDF",
  "same-text": "same text content",
  "same-name": "same name",
  "similar-name": "same name (ignoring case/spaces)",
  "same-size": "same upload sizes (unconfirmed)",
};

export interface ProjectFingerprint {
  publicId: string;
  companyId: number;
  name: string;
  /** ISO; null sorts as newest (never the default keeper on a tie). */
  createdAt: string | null;
  /** Stored page rows, distinct page numbers. */
  pageCount: number;
  /** md5 over the pages' normalized text in page order; null when there is too little text. */
  textHash: string | null;
  /** Uploaded file sizes in upload order ("123,456"); null when there is no manifest. */
  uploadSizes: string | null;
  /** User-made annotations (user / takeoff / takeoff-scale) + takeoff items. */
  userWork: number;
  /** Comparable identity of the original PDF (set by the S3 tier); null = not checked / absent. */
  fileKey: string | null;
}

export function normalizeProjectName(name: string): string {
  return name.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}

/** The strongest signal linking `a` to `b`, or null when none does. */
export function matchLevel(a: ProjectFingerprint, b: ProjectFingerprint): ProjectMatchLevel | null {
  if (a.companyId !== b.companyId) return null;
  if (a.fileKey && a.fileKey === b.fileKey) return "identical-file";
  if (a.textHash && a.textHash === b.textHash && a.pageCount === b.pageCount) return "same-text";
  if (a.name === b.name) return "same-name";
  if (normalizeProjectName(a.name) === normalizeProjectName(b.name)) return "similar-name";
  if (a.uploadSizes && a.uploadSizes === b.uploadSizes) return "same-size";
  return null;
}

/** Most user work wins; tie → oldest; tie → publicId (stable). */
export function defaultKeeper<T extends ProjectFingerprint>(members: readonly T[]): T {
  const time = (m: ProjectFingerprint) => (m.createdAt ? Date.parse(m.createdAt) : Number.POSITIVE_INFINITY);
  return [...members].sort(
    (x, y) => y.userWork - x.userWork || time(x) - time(y) || (x.publicId < y.publicId ? -1 : x.publicId > y.publicId ? 1 : 0),
  )[0];
}

/** Connected groups (≥ 2 members, one company each) over every signal; members in input order. */
export function groupProjects<T extends ProjectFingerprint>(rows: readonly T[]): T[][] {
  const parent = rows.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const union = (i: number, j: number) => { parent[find(i)] = find(j); };
  const keyed = new Map<string, number>();
  const link = (key: string | null, i: number) => {
    if (!key) return;
    const seen = keyed.get(key);
    if (seen === undefined) keyed.set(key, i);
    else union(i, seen);
  };
  rows.forEach((r, i) => {
    const c = `${r.companyId}`;
    link(`${c}|n|${normalizeProjectName(r.name)}`, i); // covers exact names too
    link(r.textHash ? `${c}|t|${r.pageCount}|${r.textHash}` : null, i);
    link(r.uploadSizes ? `${c}|s|${r.uploadSizes}` : null, i);
    link(r.fileKey ? `${c}|f|${r.fileKey}` : null, i);
  });
  const groups = new Map<number, T[]>();
  rows.forEach((r, i) => {
    const root = find(i);
    groups.set(root, [...(groups.get(root) ?? []), r]);
  });
  return [...groups.values()].filter((g) => g.length > 1);
}

// ── the byte tier ─────────────────────────────────────────────────────────────────────────

export interface FileHead {
  publicId: string;
  /** ContentLength; null when the object is missing. */
  size: number | null;
  eTag: string | null;
}

/** Parts in a multipart ETag ("…-12" → 12); 1 for a plain (single PUT) ETag. */
export function etagParts(eTag: string): number {
  const m = /-(\d+)"?$/.exec(eTag);
  return m ? Number(m[1]) : 1;
}

/**
 * Decide file identity from HeadObject results within one group. Members of equal size whose
 * ETags are comparable (all single-part, or all multipart with the same part count) are keyed
 * by size + ETag. An equal-size bucket mixing part layouts cannot be decided from ETags: its
 * members are returned in `needHash` (stream SHA-256, then call `hashKey`). Different sizes are
 * never identical, so a lone size gets no key and nothing is downloaded for it.
 */
export function fileKeys(heads: readonly FileHead[]): { keys: Map<string, string>; needHash: string[] } {
  const keys = new Map<string, string>();
  const needHash: string[] = [];
  const bySize = new Map<number, FileHead[]>();
  for (const h of heads) {
    if (h.size === null || !h.eTag) continue;
    bySize.set(h.size, [...(bySize.get(h.size) ?? []), h]);
  }
  for (const [size, bucket] of bySize) {
    if (bucket.length < 2) continue;
    const layouts = new Set(bucket.map((h) => etagParts(h.eTag!)));
    if (layouts.size === 1) {
      for (const h of bucket) keys.set(h.publicId, `etag:${size}:${h.eTag!.replace(/"/g, "")}`);
    } else {
      needHash.push(...bucket.map((h) => h.publicId));
    }
  }
  return { keys, needHash };
}

export function hashKey(size: number, sha256: string): string {
  return `sha256:${size}:${sha256}`;
}
