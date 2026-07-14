import { describe, expect, it, vi } from "vitest";
import { enqueueQtoWorkflowWrite } from "../qtoWorkflowWriteQueue";
import type { QtoWorkflow } from "@/types";

function workflow(id = 9001): QtoWorkflow {
  return {
    id,
    projectId: 1,
    materialType: "doors",
    materialLabel: "Doors",
    step: "confirm-tags",
    schedulePageNumber: 4,
    yoloClassFilter: null,
    itemType: "yolo-with-inner-text",
    tagShapeClass: null,
    parsedSchedule: {
      headers: ["TAG", "SIZE"],
      rows: [{ TAG: "D-101", SIZE: "3070" }],
      tagColumn: "TAG",
      tableName: "DOOR SCHEDULE",
      scheduleCategory: "door-schedule",
      sourcePageNumber: 4,
    },
    lineItems: null,
    userEdits: { quantityOverrides: {}, selectedPages: [4] },
    exportedAt: null,
  };
}

describe("qtoWorkflowWriteQueue", () => {
  it("continues after PUT1 failure and gives PUT2 the cumulative desired snapshot", async () => {
    const lifecycleOwner = {};
    let rejectFirst!: (error: Error) => void;
    let resolveSecond!: (row: QtoWorkflow) => void;
    const firstResponse = new Promise<QtoWorkflow | null>((_resolve, reject) => {
      rejectFirst = reject;
    });
    const secondResponse = new Promise<QtoWorkflow | null>((resolve) => {
      resolveSecond = resolve;
    });
    const write = vi.fn()
      .mockReturnValueOnce(firstResponse)
      .mockReturnValueOnce(secondResponse);
    const base = workflow();

    const first = enqueueQtoWorkflowWrite({
      lifecycleOwner,
      lifecycleGeneration: 1,
      publicId: "project-queue-test",
      workflow: base,
      updates: {
        step: "map-tags",
        itemType: "yolo-only",
        yoloClassFilter: "door_single",
        parsedSchedule: base.parsedSchedule,
        userEdits: base.userEdits,
      },
      write,
    });
    const second = enqueueQtoWorkflowWrite({
      lifecycleOwner,
      lifecycleGeneration: 1,
      publicId: "project-queue-test",
      // Deliberately stale caller snapshot: cumulative queue state must preserve PUT1's config.
      workflow: base,
      updates: {
        step: "review",
        lineItems: [{
          tag: "door_single",
          specs: {},
          autoQuantity: 1,
          instances: [],
          pages: [4],
          flags: [],
          notes: "",
        }],
      },
      write,
    });

    await Promise.resolve();
    expect(write).toHaveBeenCalledTimes(1);
    expect(write.mock.calls[0][0]).toMatchObject({
      step: "map-tags",
      itemType: "yolo-only",
      yoloClassFilter: "door_single",
      userEdits: { quantityOverrides: {}, selectedPages: [4] },
    });
    expect(write.mock.calls[0][0]).not.toHaveProperty("materialLabel");
    expect(write.mock.calls[0][0]).not.toHaveProperty("schedulePageNumber");
    expect(first.isCurrent()).toBe(false);
    expect(second.isCurrent()).toBe(true);

    const firstSettled = expect(first.completion).rejects.toThrow("PUT1 failed");
    rejectFirst(new Error("PUT1 failed"));
    await firstSettled;
    await Promise.resolve();
    expect(write).toHaveBeenCalledTimes(2);
    expect(write.mock.calls[1][0]).toMatchObject({
      step: "review",
      itemType: "yolo-only",
      yoloClassFilter: "door_single",
      parsedSchedule: base.parsedSchedule,
      userEdits: { quantityOverrides: {}, selectedPages: [4] },
      lineItems: [{ tag: "door_single", autoQuantity: 1 }],
    });
    expect(write.mock.calls[1][0]).not.toHaveProperty("materialLabel");
    expect(write.mock.calls[1][0]).not.toHaveProperty("schedulePageNumber");

    const serverRow = { ...second.optimistic };
    resolveSecond(serverRow);
    await expect(second.completion).resolves.toEqual(serverRow);
    expect(write).toHaveBeenCalledTimes(2);
  });

  it("retains a current failed patch so a later user action can retry it", async () => {
    const lifecycleOwner = {};
    let rejectFirst!: (error: Error) => void;
    const firstResponse = new Promise<QtoWorkflow | null>((_resolve, reject) => {
      rejectFirst = reject;
    });
    const write = vi.fn().mockReturnValueOnce(firstResponse).mockResolvedValueOnce(null);
    const base = workflow(9002);

    const first = enqueueQtoWorkflowWrite({
      lifecycleOwner,
      lifecycleGeneration: 1,
      publicId: "project-retained-failure-test",
      workflow: base,
      updates: {
        step: "map-tags",
        itemType: "yolo-only",
        yoloClassFilter: "door_single",
        userEdits: base.userEdits,
      },
      write,
    });
    await Promise.resolve();
    expect(first.isCurrent()).toBe(true);
    const firstSettled = expect(first.completion).rejects.toThrow("offline");
    rejectFirst(new Error("offline"));
    await firstSettled;

    const refreshed = { ...base, materialLabel: "Server-renamed Doors" };
    const later = enqueueQtoWorkflowWrite({
      lifecycleOwner,
      lifecycleGeneration: 1,
      publicId: "project-retained-failure-test",
      workflow: refreshed,
      updates: { step: "review", lineItems: [] },
      write,
    });
    await later.completion;

    expect(later.optimistic.materialLabel).toBe("Server-renamed Doors");
    expect(write).toHaveBeenCalledTimes(2);
    expect(write.mock.calls[1][0]).toEqual({
      step: "review",
      yoloClassFilter: "door_single",
      itemType: "yolo-only",
      userEdits: base.userEdits,
      lineItems: [],
    });
    expect(write.mock.calls[1][0]).not.toHaveProperty("materialLabel");
  });

  it("isolates FIFO state by lifecycle generation and lifecycle owner", async () => {
    const ownerA = {};
    const ownerB = {};
    const base = workflow(9003);
    let resolveA!: (row: QtoWorkflow | null) => void;
    const stalledA = new Promise<QtoWorkflow | null>((resolve) => {
      resolveA = resolve;
    });
    let resolveNewGeneration!: (row: QtoWorkflow | null) => void;
    const stalledNewGeneration = new Promise<QtoWorkflow | null>((resolve) => {
      resolveNewGeneration = resolve;
    });
    const writeA = vi.fn().mockReturnValue(stalledA);
    const writeNewGeneration = vi.fn().mockReturnValue(stalledNewGeneration);
    const writeOtherOwner = vi.fn().mockResolvedValue(null);

    const oldGeneration = enqueueQtoWorkflowWrite({
      lifecycleOwner: ownerA,
      lifecycleGeneration: 10,
      publicId: "same-public-id",
      workflow: base,
      updates: {
        step: "map-tags",
        itemType: "yolo-only",
        yoloClassFilter: "door_single",
      },
      write: writeA,
    });
    await Promise.resolve();
    expect(writeA).toHaveBeenCalledTimes(1);

    const newGeneration = enqueueQtoWorkflowWrite({
      lifecycleOwner: ownerA,
      lifecycleGeneration: 11,
      publicId: "same-public-id",
      workflow: base,
      updates: { step: "review", lineItems: [] },
      write: writeNewGeneration,
    });
    const otherOwner = enqueueQtoWorkflowWrite({
      lifecycleOwner: ownerB,
      lifecycleGeneration: 10,
      publicId: "same-public-id",
      workflow: base,
      updates: { step: "done", exportedAt: "2026-07-14T00:00:00.000Z" },
      write: writeOtherOwner,
    });

    // Intent is isolated, but durable transport remains one [project,workflow] FIFO: neither B
    // may overtake the already-dispatched A write and let A commit stale state last.
    for (let turn = 0; turn < 4; turn += 1) await Promise.resolve();
    expect(writeNewGeneration).not.toHaveBeenCalled();
    expect(writeOtherOwner).not.toHaveBeenCalled();
    expect(oldGeneration.isCurrent()).toBe(false);

    resolveA(null);
    await expect(oldGeneration.completion).resolves.toBeNull();
    for (let turn = 0; turn < 4; turn += 1) await Promise.resolve();
    expect(writeNewGeneration).toHaveBeenCalledTimes(1);
    expect(writeOtherOwner).not.toHaveBeenCalled();

    resolveNewGeneration(null);
    await expect(newGeneration.completion).resolves.toBeNull();
    await expect(otherOwner.completion).resolves.toBeNull();
    // Successors dispatch in enqueue order but inherit none of A's generation-owned desired patch.
    expect(writeNewGeneration).toHaveBeenCalledTimes(1);
    expect(writeOtherOwner).toHaveBeenCalledTimes(1);
    expect(writeNewGeneration.mock.calls[0][0]).toEqual({ step: "review", lineItems: [] });
    expect(writeOtherOwner.mock.calls[0][0]).toEqual({
      step: "done",
      exportedAt: "2026-07-14T00:00:00.000Z",
    });
  });

  it("fences stale generations owner-wide even after the current workflow slot retires", async () => {
    const lifecycleOwner = {};
    const currentWrite = vi.fn().mockResolvedValue(null);
    const staleWrite = vi.fn().mockResolvedValue(null);

    const current = enqueueQtoWorkflowWrite({
      lifecycleOwner,
      lifecycleGeneration: 21,
      publicId: "current-project",
      workflow: workflow(9100),
      updates: { step: "review" },
      write: currentWrite,
    });
    await expect(current.completion).resolves.toBeNull();

    const staleOtherWorkflow = enqueueQtoWorkflowWrite({
      lifecycleOwner,
      lifecycleGeneration: 20,
      publicId: "obsolete-project",
      workflow: workflow(9200),
      updates: { step: "done" },
      write: staleWrite,
    });

    await expect(staleOtherWorkflow.completion).resolves.toBeNull();
    expect(staleOtherWorkflow.isCurrent()).toBe(false);
    expect(staleWrite).not.toHaveBeenCalled();
  });
});
