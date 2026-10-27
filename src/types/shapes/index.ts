// [refactor jul23 P4.1 U0] Shape-registry barrel.
//
// Re-exports every registry schema, classifier, and z.infer type. This is the
// public surface of the shape registry (@/types/shapes). U0 is PURE-ADDITIVE
// (RD-B): the hand-written types in types/index.ts stay AUTHORITATIVE and are NOT
// touched; the shapes here are proven compatible with them by the compile-time
// Expect<Extends<z.infer<...>, HandWrittenType>> guards in the unit net. The
// DERIVE type-inversion (types/index.ts re-exporting these z.infer types) is
// deferred to its own later commit (RD-B).
//
// The z.infer type aliases are declared co-located with each schema and surface
// here via `export *`.
export * from "./primitives";
export * from "./csi";
export * from "./annotation-data";
export * from "./region-data";
// [refactor jul23 P4.1 U11] pipelineConfig subtree registry (Stage D).
export * from "./pipeline-config";
// [TP-2 WP-2.E] compact LAYOUT blocks, header flags and merged-cell spans on the stored Textract page.
export * from "./textract";
