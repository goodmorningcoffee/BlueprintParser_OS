/** The four independently owned parse-wizard operation lanes. */
export type ParseKind = "table" | "keynote" | "notes" | "spec";

export const PARSE_KINDS = ["table", "keynote", "notes", "spec"] as const satisfies
  readonly ParseKind[];

export type ParseOperationStatus = Readonly<{
  revision: number;
  busy: boolean;
}>;

export type ParseOperationRegistry = Readonly<Record<ParseKind, ParseOperationStatus>>;

export type ParseOperationToken<K extends ParseKind = ParseKind> = Readonly<{
  kind: K;
  revision: number;
}>;

export type BeginParseOperationPolicy = "reject" | "supersede";

export type BeginParseOperationResult<K extends ParseKind> =
  | { status: "started"; token: ParseOperationToken<K> }
  | { status: "busy" };

/** Allocate a fresh registry so tests/store replacement cannot share mutable container identity. */
export function createParseOperationRegistry(): ParseOperationRegistry {
  return {
    table: { revision: 0, busy: false },
    keynote: { revision: 0, busy: false },
    notes: { revision: 0, busy: false },
    spec: { revision: 0, busy: false },
  };
}

/**
 * Pure monotonic invalidation used by the leaf today and neutral commands in A2b+.
 * Duplicate kinds increment once, while every untouched status retains its exact reference.
 */
export function invalidateParseOperationKinds(
  registry: ParseOperationRegistry,
  kinds: Iterable<ParseKind>,
): ParseOperationRegistry {
  const uniqueKinds = new Set(kinds);
  if (uniqueKinds.size === 0) return registry;

  const next: Record<ParseKind, ParseOperationStatus> = { ...registry };
  for (const kind of uniqueKinds) {
    const current = registry[kind];
    next[kind] = { revision: current.revision + 1, busy: false };
  }
  return next;
}
