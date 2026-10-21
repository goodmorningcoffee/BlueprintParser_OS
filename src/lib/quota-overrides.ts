/**
 * Quota overrides: the ONE resolver for the daily limits in src/lib/quotas.ts.
 *
 * Owner ruling 2026-10-21: "i want ability to modify the limit for a user" and "i want root admin
 * exempt from everything basicly". Precedence, highest first:
 *
 *   1. root admin (verified server-side session flag)  → exempt; nothing is read or counted
 *   2. per-user override    overrides.users["<userId>"][field]
 *   3. per-company override overrides.companies["<companyId>"][field]
 *   4. the code default (the limits that shipped before overrides existed)
 *
 * An override value is an integer 0..QUOTA_OVERRIDE_MAX (that limit; 0 refuses everything) or
 * null (unlimited). A missing field falls through to the next level.
 *
 * Storage is the existing `app_settings` table under ONE key (QUOTA_OVERRIDES_KEY) — no schema
 * change. The document is written only by the root-only /api/admin/quota-overrides route, which
 * validates strictly. This module is pure (no DB): `parseQuotaOverrides` is the LENIENT reader
 * used on the request path. It never throws; a malformed document or entry is ignored field by
 * field, so a bad write can only ever fall back to the defaults, never break an upload.
 */

export const QUOTA_OVERRIDES_KEY = "quota_overrides";

export const QUOTA_FIELDS = ["uploadsPerDay", "yoloJobsPerDay", "chatMessagesPerDay"] as const;
export type QuotaField = (typeof QUOTA_FIELDS)[number];

export const QUOTA_OVERRIDE_MAX = 1_000_000;

/** The shipped defaults. quotas.ts reads its limits from here so the UI can show them. */
export const QUOTA_DEFAULTS = {
  uploadsPerDay: { member: 3, admin: 10 },
  yoloJobsPerDay: 10,
  chatMessagesPerDay: 200,
} as const;

/** number = that limit, null = unlimited. An absent field means "not overridden". */
export type QuotaOverrideEntry = Partial<Record<QuotaField, number | null>>;

export interface QuotaOverrides {
  users: Record<string, QuotaOverrideEntry>;
  companies: Record<string, QuotaOverrideEntry>;
}

export interface QuotaSubject {
  companyId: number;
  userId?: number | null;
  isRootAdmin?: boolean;
}

export type ResolvedQuotaLimit =
  | { source: "root" }
  | { source: "user" | "company"; limit: number | null }
  | { source: "default"; limit: number };

export function emptyQuotaOverrides(): QuotaOverrides {
  return { users: {}, companies: {} };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isValidQuotaOverrideValue(value: unknown): value is number | null {
  return (
    value === null ||
    (typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= QUOTA_OVERRIDE_MAX)
  );
}

/** Positive safe-integer id written as its canonical decimal string ("12", never "012" or "1e3"). */
export function isCanonicalIdKey(key: string): boolean {
  if (!/^[1-9][0-9]*$/.test(key)) return false;
  return Number.isSafeInteger(Number(key));
}

function parseEntry(raw: unknown): QuotaOverrideEntry | null {
  if (!isPlainObject(raw)) return null;
  const entry: QuotaOverrideEntry = {};
  for (const field of QUOTA_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(raw, field) && isValidQuotaOverrideValue(raw[field])) {
      entry[field] = raw[field] as number | null;
    }
  }
  return Object.keys(entry).length > 0 ? entry : null;
}

function parseSection(raw: unknown): Record<string, QuotaOverrideEntry> {
  const section: Record<string, QuotaOverrideEntry> = {};
  if (!isPlainObject(raw)) return section;
  for (const key of Object.keys(raw)) {
    if (!isCanonicalIdKey(key)) continue;
    const entry = parseEntry(raw[key]);
    if (entry) section[key] = entry;
  }
  return section;
}

/** Lenient: any shape in, a well-formed document out. Never throws. */
export function parseQuotaOverrides(raw: unknown): QuotaOverrides {
  try {
    if (!isPlainObject(raw)) return emptyQuotaOverrides();
    return { users: parseSection(raw.users), companies: parseSection(raw.companies) };
  } catch {
    return emptyQuotaOverrides();
  }
}

function lookup(section: Record<string, QuotaOverrideEntry>, id: number | null | undefined, field: QuotaField) {
  if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0) return undefined;
  const entry = Object.prototype.hasOwnProperty.call(section, String(id)) ? section[String(id)] : undefined;
  if (!entry || !Object.prototype.hasOwnProperty.call(entry, field)) return undefined;
  const value = entry[field];
  return isValidQuotaOverrideValue(value) ? value : undefined;
}

/** root > user > company > default. `limit: null` means unlimited. */
export function resolveQuotaLimit(
  field: QuotaField,
  defaultLimit: number,
  subject: QuotaSubject,
  overrides: QuotaOverrides,
): ResolvedQuotaLimit {
  if (subject.isRootAdmin === true) return { source: "root" };
  const userValue = lookup(overrides.users, subject.userId, field);
  if (userValue !== undefined) return { source: "user", limit: userValue };
  const companyValue = lookup(overrides.companies, subject.companyId, field);
  if (companyValue !== undefined) return { source: "company", limit: companyValue };
  return { source: "default", limit: defaultLimit };
}
