/**
 * Parse-engine capability versions (PLAN §1.3 E-6; WP-2.E).
 *
 * A behaviour change to a capability's modules must bump its number here. The bump is enforced by one
 * LEDGER file per capability, `eval/parse-engine/capabilities/<capability>.json`, which records the
 * sha-256 of that capability's module set at each version (`src/lib/__tests__/parse-engine-capabilities-
 * ledger.test.ts`). A ledger moves with a counted change; it is never a freeze. Stored regions whose
 * stamp carries an older number are "stale" for that capability and are offered a replay (TP-5).
 */

import { PARSE_ENGINE_VERSION, type Capability } from "./types";

export { PARSE_ENGINE_VERSION };

export const CAPABILITY_VERSIONS: Readonly<Record<Capability, number>> = Object.freeze({
  evidence: 1,
  rows: 1,
  cols: 1,
  cells: 1,
  headers: 1,
  tagColumn: 1,
  title: 1,
  kind: 1,
  csi: 1,
  paragraphs: 1,
  refs: 1,
  tagMap: 1,
});

export const CAPABILITIES = Object.keys(CAPABILITY_VERSIONS) as Capability[];

/** The capabilities whose stamped number is behind the current one (a capability absent from the stamp did not run, so it is not stale). */
export function staleCapabilities(stamped: Partial<Record<Capability, number>> | null | undefined): Capability[] {
  return CAPABILITIES.filter((c) => {
    const v = stamped?.[c];
    return typeof v === "number" && v < CAPABILITY_VERSIONS[c];
  });
}
