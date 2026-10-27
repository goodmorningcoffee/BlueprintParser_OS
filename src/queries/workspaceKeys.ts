// [TP-3 WP-3.L] Query keys for the Tables & Notes workspace (PLAN §3.2). A sibling of `queryKeys.ts`, so that
// file is not edited by parallel work packages. Same conventions: everything nests under ["project", publicId]
// (project teardown and the per-project invalidation boundary cover it), `as const` tuples, page LAST.

export const workspaceKeys = {
  all: (publicId: string) => ["project", publicId, "parseEngine"] as const,
  flags: (publicId: string) => ["project", publicId, "parseEngine", "flags"] as const,
  /** Every items read of the project (both scopes, every page): the commit / verdict invalidation target. */
  items: (publicId: string) => ["project", publicId, "parseEngine", "items"] as const,
  itemsAll: (publicId: string) => ["project", publicId, "parseEngine", "items", "all"] as const,
  itemsSheet: (publicId: string, pageNumber: number) =>
    ["project", publicId, "parseEngine", "items", "sheet", pageNumber] as const,
};
