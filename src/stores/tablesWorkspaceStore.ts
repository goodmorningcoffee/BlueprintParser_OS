import { create } from "zustand";
import type { BboxMinMax, CorrectionOp, ParseRequest, ParseResult, StructureKind } from "@/lib/parse-engine/types";

// [TP-3 WP-3.L] The Tables & Notes workspace's viewer state (PLAN §3.2). LEAF store: it imports only
// zustand and types, never fetches, never navigates and never touches another store — cross-store work
// (closing the classic panels, focusing the canvas, paging) lives in `workspaceCommands.ts`.
//   open/group      the panel is open, opened from the Schedules/Tables ("tables") or Specs/Notes ("notes") button
//   enabled         `tools.workspace === "engine"` for this viewer (written by TablesWorkspaceHost from GET
//                   …/parse-engine/flags; false while loading, on error and for demo projects → classic toggles)
//   scope/filter/kinds   the inbox header (This sheet | All sheets · To review | Parsed | Rejected | Stale · kind chips)
//   queue           the inbox's visible order (written by the panel), so next/prev work outside React
//   drafts          itemKey → draft bound to its item's PAGE (K29). `ops` (not `result`) mirror to localStorage
//                   per project in try/catch — a per-viewer convenience restored on reopen (C3-m6).

export type WorkspaceGroup = "tables" | "notes";
export type WorkspaceScope = "sheet" | "all";
export type WorkspaceFilter = "todo" | "parsed" | "rejected" | "stale";
export type WorkspaceStep = "structure" | "tags" | "refs" | "accept";
export type WorkspaceCorrection = "draw-region" | "draw-continuation" | null; // [WP-3.M] continuation box (C3-M3)

export const GROUP_KINDS: Readonly<Record<WorkspaceGroup, readonly StructureKind[]>> = {
  tables: ["schedule", "keynote", "legend"],
  notes: ["notes", "spec"],
};

/** What the commands need to focus or open an inbox item (a subset of the items response row). */
export interface WorkspaceItemRef {
  /** Item key: a proposal id, a synthetic `tr:<…>` text-region id, a `draw:<…>` box id or a region id. */
  id: string;
  page: number;
  b: BboxMinMax;
  kind: StructureKind;
  proposalId?: string;
  regionId?: string;
  classId?: string | null;
}

export interface WorkspaceDraft {
  page: number;
  bbox: BboxMinMax;
  parts?: BboxMinMax[];
  kind: StructureKind;
  classId?: string;
  result: ParseResult | null;
  ops: CorrectionOp[];
  regionId?: string;
  revision?: number;
  /** [WP-3.M] `viewHash` of the saved region's view the draft was loaded on (PLAN §1.1 row 7). */
  viewHash?: string;
  /** Request stamp: a parse result is applied only when it carries this stamp (stale results are dropped). */
  startedAt: number;
  /** [WP-3.M] The request that produced `result` (the commit's recipe), and `links.continues` (K11, C2-M10). */
  request?: ParseRequest;
  continues?: string;
}

type MirroredDraft = Omit<WorkspaceDraft, "result" | "startedAt">;

export const DRAFT_STORAGE_PREFIX = "bp2.tablesWorkspace.drafts.v1:";

interface TablesWorkspaceState {
  enabled: boolean;
  open: boolean;
  group: WorkspaceGroup;
  scope: WorkspaceScope;
  filter: WorkspaceFilter;
  kinds: StructureKind[];
  selectedKey: string | null;
  step: WorkspaceStep;
  queue: WorkspaceItemRef[];
  draftsProject: string;
  drafts: Record<string, WorkspaceDraft>;
  correction: WorkspaceCorrection;
  hover: string | null;
  setEnabled: (enabled: boolean) => void;
  openWorkspace: (group: WorkspaceGroup) => void;
  closeWorkspace: () => void;
  setScope: (scope: WorkspaceScope) => void;
  setFilter: (filter: WorkspaceFilter) => void;
  toggleKind: (kind: StructureKind) => void;
  select: (key: string | null, step?: WorkspaceStep) => void;
  setStep: (step: WorkspaceStep) => void;
  setQueue: (queue: WorkspaceItemRef[]) => void;
  setHover: (hover: string | null) => void;
  setCorrection: (correction: WorkspaceCorrection) => void;
  /** Load this project's mirrored drafts (replaces the in-memory set; results are re-fetched later). */
  hydrateDrafts: (publicId: string) => void;
  putDraft: (key: string, draft: WorkspaceDraft) => void;
  setDraftOps: (key: string, ops: CorrectionOp[]) => void;
  discardDraft: (key: string) => void;
}

function readMirror(publicId: string): Record<string, WorkspaceDraft> {
  if (!publicId) return {};
  try {
    const raw = globalThis.localStorage?.getItem(DRAFT_STORAGE_PREFIX + publicId);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, WorkspaceDraft> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, MirroredDraft>)) {
      if (!value || typeof value !== "object" || !Array.isArray(value.ops) || !Array.isArray(value.bbox)) continue;
      if (typeof value.page !== "number" || typeof value.kind !== "string") continue;
      out[key] = { ...value, result: null, startedAt: 0 };
    }
    return out;
  } catch {
    return {};
  }
}

function writeMirror(publicId: string, drafts: Record<string, WorkspaceDraft>): void {
  if (!publicId) return;
  try {
    const mirrored: Record<string, MirroredDraft> = {};
    for (const [key, { result: _result, startedAt: _startedAt, ...rest }] of Object.entries(drafts)) {
      // [WP-3.M] continuation boxes and "Continues from" are the user's work too (WP-3.M verify LOW-8).
      if (rest.ops.length > 0 || (rest.parts?.length ?? 0) > 0 || !!rest.continues) mirrored[key] = rest;
    }
    const storage = globalThis.localStorage;
    if (!storage) return;
    if (Object.keys(mirrored).length === 0) storage.removeItem(DRAFT_STORAGE_PREFIX + publicId);
    else storage.setItem(DRAFT_STORAGE_PREFIX + publicId, JSON.stringify(mirrored));
  } catch {
    /* storage blocked or full: drafts stay in memory only */
  }
}

const defaults = {
  enabled: false,
  open: false,
  group: "tables" as WorkspaceGroup,
  scope: "sheet" as WorkspaceScope,
  filter: "todo" as WorkspaceFilter,
  kinds: [...GROUP_KINDS.tables],
  selectedKey: null,
  step: "structure" as WorkspaceStep,
  queue: [] as WorkspaceItemRef[],
  draftsProject: "",
  drafts: {} as Record<string, WorkspaceDraft>,
  correction: null as WorkspaceCorrection,
  hover: null,
};

export const useTablesWorkspaceStore = create<TablesWorkspaceState>((set, get) => ({
  ...defaults,
  setEnabled: (enabled) => set(enabled ? { enabled } : { enabled, open: false }),
  openWorkspace: (group) => set({ open: true, group, kinds: [...GROUP_KINDS[group]], filter: "todo", correction: null }),
  closeWorkspace: () => set({ open: false, selectedKey: null, hover: null, correction: null }),
  setScope: (scope) => set({ scope }),
  setFilter: (filter) => set({ filter }),
  toggleKind: (kind) =>
    set((s) => ({ kinds: s.kinds.includes(kind) ? s.kinds.filter((k) => k !== kind) : [...s.kinds, kind] })),
  select: (selectedKey, step) => set(step ? { selectedKey, step } : { selectedKey }),
  setStep: (step) => set({ step }),
  setQueue: (queue) => set({ queue }),
  setHover: (hover) => set({ hover }),
  setCorrection: (correction) => set({ correction }),
  hydrateDrafts: (publicId) => set({ draftsProject: publicId, drafts: readMirror(publicId) }),
  putDraft: (key, draft) => {
    const drafts = { ...get().drafts, [key]: draft };
    set({ drafts });
    writeMirror(get().draftsProject, drafts);
  },
  setDraftOps: (key, ops) => {
    const current = get().drafts[key];
    if (!current) return;
    const drafts = { ...get().drafts, [key]: { ...current, ops } };
    set({ drafts });
    writeMirror(get().draftsProject, drafts);
  },
  discardDraft: (key) => {
    if (!(key in get().drafts)) return;
    const { [key]: _gone, ...drafts } = get().drafts;
    set({ drafts });
    writeMirror(get().draftsProject, drafts);
  },
}));

/** Test/reset helper: back to the initial state (does not touch localStorage). */
export function resetTablesWorkspaceStore(): void {
  useTablesWorkspaceStore.setState({ ...defaults, kinds: [...GROUP_KINDS.tables], queue: [], drafts: {} });
}
