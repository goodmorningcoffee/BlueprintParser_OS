/**
 * classifier-engine — recipes over the evidence BP already has (plan: gitignore/projects/
 * classifier_builder/PLAN.md). Client-safe: nothing here reads disk; the CSI box tagger lives in
 * ./csi-box-tagger.ts (server / CLI only) and is injected through `ClassifierPageInput.tagger`.
 */
export { runClassifierEngine, isPageClassifierProposals, storedClassifierProposals, proposalId, type EngineRun } from "./engine";
export { buildPageEvidence, buildCandidateEvidence, groupRows, type ClassifierPageInput, type BoxTagger, type CsiCodeLike } from "./evidence";
export { BUILT_IN_RECIPES, BUILT_IN_RECIPES_HASH, HEURISTIC_RECIPES, effectiveRecipes, applyOverlay, validateRecipe, hashRecipes, isClassifierOverlay } from "./recipes";
export { buildProjectProposalSummary, storedProposalVerdicts, type ProposalPage } from "./summary";
export { deriveName, cleanTitle, CONFIDENT_NAME } from "./derive-name";
export { evaluateSignal } from "./signals";
export { yoloSpatialHolds } from "./spatial";
export { evaluateHead, pickClass, sigmoid } from "./heads";
export { SCHEDULE_KINDS, SCHEDULE_GROUP_NAMES, scheduleKind, NOT_A_SCHEDULE, OTHER_SCHEDULE, type ScheduleKind, type ScheduleGroup } from "./vocabulary";
export * from "./types";
