// [refactor jul11 P2.4 adjacent lifecycle safety]
//
// Auto-QTO advances optimistically: ConfigureStep can publish `map-tags`, MappingStep can finish,
// and ReviewStep can publish `review` before the first PUT settles. Sending those partial writes in
// parallel lets the database finish in the wrong state when PUT1 settles after PUT2. This small
// domain coordinator gives every [project, workflow] one FIFO across component unmount/remounts.
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
  // Stored tails always fulfill so one failed request cannot block the next task.
  tail: Promise<void>;
};

const slots = new Map<string, QueueSlot>();

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
  publicId: string;
  workflow: QtoWorkflow;
  updates: Partial<QtoWorkflow>;
  write: (body: Partial<QtoWorkflowPersistedUpdate>) => Promise<QtoWorkflow | null>;
}): {
  optimistic: QtoWorkflow;
  completion: Promise<QtoWorkflow | null>;
  isCurrent: () => boolean;
} {
  const key = JSON.stringify([args.publicId, args.workflow.id]);
  let slot = slots.get(key);

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
    slot = {
      revision: 0,
      desiredPatch: nextPatch,
      tail: Promise.resolve(),
    };
    slots.set(key, slot);
  }
  slot.revision += 1;
  slot.desiredPatch = nextPatch;
  const revision = slot.revision;
  const body = { ...nextPatch };

  const completion = slot.tail.then(() => args.write(body));
  const swallowedTail = completion.then(
    () => undefined,
    () => undefined,
  );
  slot.tail = swallowedTail;

  // A current success durably applied the whole cumulative patch, so the slot may retire. A current
  // failure deliberately retains its fulfilled tail + patch; the next user action can retry all
  // unsaved fields. Stale settlement never retires a slot owned by newer queued work.
  void completion.then(
    () => {
      if (
        slots.get(key) === slot
        && slot!.revision === revision
        && slot!.tail === swallowedTail
      ) {
        slots.delete(key);
      }
    },
    () => undefined,
  );

  return {
    optimistic,
    completion,
    isCurrent: () => slot!.revision === revision,
  };
}
