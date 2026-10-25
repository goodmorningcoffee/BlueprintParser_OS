/**
 * classifier-engine — recipes over the evidence BP already has (plan: gitignore/projects/
 * classifier_builder/PLAN.md). Client-safe: nothing here reads disk; the CSI box tagger lives in
 * ./csi-box-tagger.ts (server / CLI only) and is injected through `ClassifierPageInput.tagger`.
 */
export { runClassifierEngine, isPageClassifierProposals, storedClassifierProposals, proposalId, type EngineRun } from "./engine";
export { buildPageEvidence, buildCandidateEvidence, groupRows, columnWords, shapesInside, type ClassifierPageInput, type BoxTagger, type CsiCodeLike } from "./evidence";
export { findShapeColumn, bestShapeColumn, buildTagMap, rowBands, rowBand, tagTextOf, columnTextShares, wordsInside, wordsRight, COLUMN_SHAPE_LABELS, type ColumnShape, type ColumnWord, type ShapeColumn, type ShapeColumnOptions, type ShapeSource } from "./shape-column";
export { BUILT_IN_RECIPES, BUILT_IN_RECIPES_HASH, HEURISTIC_RECIPES, effectiveRecipes, applyOverlay, validateRecipe, validateSignal, validateClass, validateSpec, hashRecipes, isClassifierOverlay, signalKey, classRemovalKey } from "./recipes";
export { buildRecipePatch, describePatch, resetSignal, resetClass, resetRecipe, validateOverlay, bumpOverlayVersions, mergeOverlay, headSignals, blankClass, blankRecipe, DETECT, type DiffLine, type HeadId, type OverlayValidation } from "./overlay-edit";
export { checkSpec, checkScope, checkCandidates, SPEC_TYPES, CANDIDATE_TYPES } from "./spec-check";
export { SIGNAL_TYPES, SIGNAL_SCOPES, SCOPE_HELP, DISCIPLINES, STRUCTURE_FEATURES, SHAPE_LABELS, ZONES, PAGE_KINDS, YOLO_WHERE, YOLO_MEASURES, CSI_MEASURES, CANDIDATE_SOURCE_TYPES, signalTypeSchema, staticCatalog, type SignalCatalog, type CatalogModel, type SignalTypeSchema, type ParamSchema, type ParamKind } from "./catalog";
export { buildProjectProposalSummary, storedProposalVerdicts, type ProposalPage } from "./summary";
export { deriveName, cleanTitle, CONFIDENT_NAME } from "./derive-name";
export { evaluateSignal } from "./signals";
export { yoloSpatialHolds } from "./spatial";
export { evaluateHead, pickClass, sigmoid } from "./heads";
export { SCHEDULE_KINDS, SCHEDULE_GROUP_NAMES, scheduleKind, NOT_A_SCHEDULE, OTHER_SCHEDULE, type ScheduleKind, type ScheduleGroup } from "./vocabulary";
export * from "./types";
