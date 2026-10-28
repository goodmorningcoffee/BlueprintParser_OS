// [TP-3 WP-3.L] Cross-store commands for the Tables & Notes workspace (PLAN §3.2). The workspace store is a
// leaf; everything that reaches another store happens here, through existing public commands only:
//   • the classic panels open and close through `viewerCommands.toggleTableParsePanel` /
//     `toggleSpecsNotesParsePanel` (CALLED, never edited — viewerCommands.ts has zero headroom), so the
//     workspace and a classic panel are never open together;
//   • paging reuses the exported `navigateViewerPage`;
//   • focus reuses `proposalFocusStore.focusProposal` with the item's real proposal id, or its synthetic id
//     (`tr:<…>` text region, `draw:<…>` drawn box, a region id) — the focus layer only compares ids.
// This module never writes parseFlowStore, uiStore or toolStore state directly (PLAN §1.6 rule 3).

import { proposalInboxKind } from "@/lib/parse-engine/inbox-derive";
import type { BboxMinMax, StructureKind } from "@/lib/parse-engine/types";
import { useProposalFocusStore } from "@/stores/proposalFocusStore";
import { useSessionStore } from "@/stores/sessionStore";
import {
  useTablesWorkspaceStore,
  type WorkspaceGroup,
  type WorkspaceItemRef,
  type WorkspaceStep,
} from "@/stores/tablesWorkspaceStore";
import { useUiStore } from "@/stores/uiStore";
import { useViewerCoreStore } from "@/stores/viewerCoreStore";
import { navigateViewerPage, toggleSpecsNotesParsePanel, toggleTableParsePanel } from "@/stores/viewerCommands";

const ws = () => useTablesWorkspaceStore.getState();

export function groupOfKind(kind: StructureKind): WorkspaceGroup {
  return kind === "notes" || kind === "spec" ? "notes" : "tables";
}

/** Synthetic item key for a box the user drew with "+ Region" (2-decimal quantised, page-scoped). */
export function drawItemKey(pageNumber: number, bbox: BboxMinMax): string {
  return `draw:${pageNumber}:${bbox.map((v) => v.toFixed(2)).join(",")}`;
}

/**
 * Inbox kind of a classifier proposal, or null when its target is not a structure (page units, plans, cuts).
 * WP-3.F's `proposalInboxKind` itself (`src/lib/parse-engine/inbox-derive.ts`), so the items read and "Parse this
 * table" give one proposal ONE kind (WP-3.L verify MED-4; the mirror was replaced at TP-3 integrate g2b).
 */
export const proposalWorkspaceKind = proposalInboxKind;

/**
 * Closing the workspace takes its canvas marks with it: the hover outline and the green focus box (with its dim),
 * when they point at a workspace item. Marks another surface set are left alone (WP-3.L verify LOW-2, LOW-3).
 */
function releaseCanvas(): void {
  const { queue, selectedKey } = ws();
  const ids = new Set<string>(queue.map((q) => q.proposalId ?? q.id));
  if (selectedKey) ids.add(selectedKey);
  const focus = useProposalFocusStore.getState();
  if (focus.hover && ids.has(focus.hover.proposalId)) focus.setHover(null);
  if (focus.focus && ids.has(focus.focus.proposalId)) focus.clearFocus();
}

function closeAndRelease(): void {
  releaseCanvas();
  ws().closeWorkspace();
}

function classicOpen(group: WorkspaceGroup): boolean {
  const ui = useUiStore.getState();
  return group === "tables" ? ui.showTableParsePanel : ui.showSpecsNotesPanel;
}

function toggleClassic(group: WorkspaceGroup): void {
  if (group === "tables") toggleTableParsePanel();
  else toggleSpecsNotesParsePanel();
}

/** Close both classic panels through their own toggles (their cleanup runs exactly as on a toolbar close). */
export function closeClassicPanels(): void {
  if (useUiStore.getState().showTableParsePanel) toggleTableParsePanel();
  if (useUiStore.getState().showSpecsNotesPanel) toggleSpecsNotesParsePanel();
}

function openWorkspaceFor(group: WorkspaceGroup): void {
  closeClassicPanels();
  ws().openWorkspace(group);
}

/**
 * The Schedules/Tables ("tables") and Specs/Notes ("notes") toolbar buttons. Workspace off (flag legacy, demo,
 * flags not loaded): the classic toggle, exactly as before. Workspace on: the workspace of this group open →
 * close it; else close the classic panels (through their own toggles) and open the workspace with the group's
 * kind chips preset. A classic panel reached through "Classic tools ▸" closes with its own × button.
 */
export function openFromToolbar(group: WorkspaceGroup): void {
  const state = ws();
  if (!state.enabled) {
    toggleClassic(group);
    return;
  }
  if (state.open && state.group === group) {
    closeAndRelease();
    return;
  }
  openWorkspaceFor(group);
}

/** Open or close the workspace (opening keeps the current group unless one is given). */
export function toggleWorkspace(group?: WorkspaceGroup): void {
  const state = ws();
  if (state.open && (!group || group === state.group)) closeAndRelease();
  else if (state.enabled) openWorkspaceFor(group ?? state.group);
}

/** Close the workspace (drafts stay; they are restored when the item is reopened). */
export function closeWorkspace(): void {
  closeAndRelease();
}

/** "Classic tools ▸": close the workspace and open this group's classic panel. */
export function openClassicTools(group?: WorkspaceGroup): void {
  const target = group ?? ws().group;
  closeAndRelease();
  if (!classicOpen(target)) toggleClassic(target);
}

/** Go to the item's page and focus it on the canvas (green box, dim, fit) without opening its detail. */
export function focusItem(item: WorkspaceItemRef): void {
  const publicId = useSessionStore.getState().publicId;
  if (item.page !== useViewerCoreStore.getState().pageNumber) navigateViewerPage(item.page);
  useProposalFocusStore.getState().focusProposal({
    publicId,
    proposalId: item.proposalId ?? item.id,
    pageNumber: item.page,
    bbox: [...item.b] as BboxMinMax,
  });
  ws().select(item.id);
}

/**
 * Open one item in the workspace (from the inbox, or from the classic "Parse this table"). Returns false when the
 * workspace is off, so a caller can take its classic path instead.
 */
export function openItem(item: WorkspaceItemRef, step: WorkspaceStep = "structure"): boolean {
  const state = ws();
  if (!state.enabled) return false;
  const group = groupOfKind(item.kind);
  if (!state.open || state.group !== group) openWorkspaceFor(group);
  else closeClassicPanels();
  if (!state.queue.some((q) => q.id === item.id)) ws().setQueue([item, ...ws().queue]);
  focusItem(item);
  ws().select(item.id, step);
  return true;
}

function step(delta: 1 | -1): void {
  const { queue, selectedKey } = ws();
  if (queue.length === 0) return;
  const at = selectedKey === null ? -1 : queue.findIndex((q) => q.id === selectedKey);
  const nextIndex = at < 0 ? (delta > 0 ? 0 : queue.length - 1) : Math.min(queue.length - 1, Math.max(0, at + delta));
  if (nextIndex === at) return;
  focusItem(queue[nextIndex]);
}

/** J / "Accept & next": the next item in the inbox's visible order (no wrap). */
export function next(): void {
  step(1);
}

/** K: the previous item in the inbox's visible order (no wrap). */
export function prev(): void {
  step(-1);
}

/** "+ Region": open the workspace if needed and arm the box draw (the canvas capture lands in WP-3.O). */
export function startDraw(): void {
  const state = ws();
  if (!state.enabled) return;
  if (!state.open) openWorkspaceFor(state.group);
  ws().setCorrection("draw-region");
}

/** Deep link to a saved region (or any item key) at a step, e.g. from a parsed-table catalog. */
export function deepLink(regionId: string, at: WorkspaceStep = "structure"): boolean {
  const state = ws();
  if (!state.enabled) return false;
  const known = state.queue.find((q) => q.id === regionId || q.regionId === regionId);
  if (known) return openItem(known, at);
  if (!state.open) openWorkspaceFor(state.group);
  ws().select(regionId, at);
  return true;
}
