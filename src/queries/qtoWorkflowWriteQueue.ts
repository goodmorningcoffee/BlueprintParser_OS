// [refactor jul11 P2.4 adjacent lifecycle safety]
//
// Auto-QTO advances optimistically: ConfigureStep can publish `map-tags`, MappingStep can finish,
// and ReviewStep can publish `review` before the first PUT settles. Sending those partial writes in
// parallel lets the database finish in the wrong state when PUT1 settles after PUT2. This small
// domain coordinator gives every [project, workflow] one transport FIFO across component and
// lifecycle-owner remounts. Optimistic intent remains isolated by lifecycle owner + generation, so
// an obsolete generation can delay its heir's transport but can never merge fields into it.
//
// Every queued write carries the cumulative PATCH for that overlapping series—not a full-row
// replacement. Thus a later write can recover fields from a failed predecessor without clobbering
// unrelated authoritative fields that this client never edited. A rejected task never poisons the
// stored tail. React/cache reconciliation remains caller-owned because this module deliberately has
// no React, Zustand, TanStack Query, or transport dependency.

import type { QtoWorkflow } from "@/types";

export type QtoWorkflowPersistedUpdate = Pick<
  QtoWorkflow,
  | "step"
  | "schedulePageNumber"
  | "parsedSchedule"
  | "lineItems"
  | "userEdits"
  | "yoloClassFilter"
  | "materialLabel"
  | "itemType"
  | "tagShapeClass"
  | "exportedAt"
>;

type QueueSlot = {
  revision: number;
  desiredPatch: Partial<QtoWorkflowPersistedUpdate>;
  superseded: boolean;
};

type LifecycleOwnerState = {
  /** Monotonic project-lifecycle fence shared by every workflow owned by this QueryClient. */
  generation: number;
  slots: Map<string, QueueSlot>;
};

const stateByLifecycleOwner = new WeakMap<object, LifecycleOwnerState>();
// Transport authority cannot be lifecycle-scoped: a slow PUT from an unmounted generation must
// settle before its successor may dispatch, otherwise the older request can commit last on the
// server. Stored tails always fulfill so one failed request cannot poison the lane.
const transportTails = new Map<string, Promise<void>>();

const PERSISTED_KEYS = [
  "step",
  "schedulePageNumber",
  "parsedSchedule",
  "lineItems",
  "userEdits",
  "yoloClassFilter",
  "materialLabel",
  "itemType",
  "tagShapeClass",
  "exportedAt",
] as const satisfies readonly (keyof QtoWorkflowPersistedUpdate)[];

function persistedPatch(updates: Partial<QtoWorkflow>): Partial<QtoWorkflowPersistedUpdate> {
  const patch: Partial<QtoWorkflowPersistedUpdate> = {};
  for (const key of PERSISTED_KEYS) {
    // Match JSON/API semantics: absent and undefined fields do not participate; null is explicit.
    if (updates[key] !== undefined) {
      (patch as Record<string, unknown>)[key] = updates[key];
    }
  }
  return patch;
}

export function enqueueQtoWorkflowWrite(args: {
  lifecycleOwner: object;
  lifecycleGeneration: number;
  publicId: string;
  workflow: QtoWorkflow;
  updates: Partial<QtoWorkflow>;
  write: (body: Partial<QtoWorkflowPersistedUpdate>) => Promise<QtoWorkflow | null>;
}): {
  optimistic: QtoWorkflow;
  completion: Promise<QtoWorkflow | null>;
  isCurrent: () => boolean;
} {
  let ownerState = stateByLifecycleOwner.get(args.lifecycleOwner);
  if (!ownerState) {
    ownerState = { generation: args.lifecycleGeneration, slots: new Map() };
    stateByLifecycleOwner.set(args.lifecycleOwner, ownerState);
  } else if (args.lifecycleGeneration > ownerState.generation) {
    // One project lifecycle owns the whole QueryClient, not merely the workflow being edited.
    // Retire every old-generation intent while leaving its already-enqueued transport position in
    // place. A task that has not dispatched yet will observe `superseded` and skip its write.
    for (const oldSlot of ownerState.slots.values()) oldSlot.superseded = true;
    ownerState.slots.clear();
    ownerState.generation = args.lifecycleGeneration;
  }
  const key = JSON.stringify([args.publicId, args.workflow.id]);
  const generationIsCurrent = args.lifecycleGeneration === ownerState.generation;
  let slot = generationIsCurrent ? ownerState.slots.get(key) : undefined;

  if (!slot) {
    slot = {
      revision: 0,
      desiredPatch: {},
      superseded: !generationIsCurrent,
    };
    if (generationIsCurrent) ownerState.slots.set(key, slot);
  }

  // Preserve the caller's latest authoritative row, overlay only explicit queued intent, then the
  // new update. Retaining a full optimistic row here would regress unrelated server fields after
  // an authoritative refresh even though the wire PATCH correctly omitted them.
  const optimistic = {
    ...args.workflow,
    ...(slot?.desiredPatch ?? {}),
    ...args.updates,
  } as QtoWorkflow;

  const nextPatch = {
    ...(slot?.desiredPatch ?? {}),
    ...persistedPatch(args.updates),
  };

  if (!slot) {
    // The generation branch above always creates a slot; retain this assertion for exhaustiveness.
    throw new Error("QTO workflow write queue failed to allocate an intent slot");
  }
  slot.revision += 1;
  slot.desiredPatch = nextPatch;
  const revision = slot.revision;
  const body = { ...nextPatch };

  const priorTransport = transportTails.get(key) ?? Promise.resolve();
  const completion = priorTransport.then(() => {
    if (slot!.superseded || ownerState!.generation !== args.lifecycleGeneration) return null;
    return args.write(body);
  });
  const swallowedTail = completion.then(
    () => undefined,
    () => undefined,
  );
  transportTails.set(key, swallowedTail);

  void swallowedTail.then(() => {
    if (transportTails.get(key) === swallowedTail) transportTails.delete(key);
  });

  // A current success durably applied the whole cumulative patch, so only unsaved future intent
  // should remain. A current failure deliberately retains its patch; the next user action can retry
  // all unsaved fields. Superseded settlement never mutates a successor generation's intent.
  void completion.then(
    () => {
      if (
        ownerState!.generation === args.lifecycleGeneration
        && ownerState!.slots.get(key) === slot
        && slot!.revision === revision
        && !slot!.superseded
      ) {
        ownerState!.slots.delete(key);
      }
    },
    () => undefined,
  );

  return {
    optimistic,
    completion,
    isCurrent: () =>
      ownerState!.generation === args.lifecycleGeneration &&
      !slot!.superseded &&
      slot!.revision === revision,
  };
}
