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
    let rejectFirst!: (error: Error) => void;
    const firstResponse = new Promise<QtoWorkflow | null>((_resolve, reject) => {
      rejectFirst = reject;
    });
    const write = vi.fn().mockReturnValueOnce(firstResponse).mockResolvedValueOnce(null);
    const base = workflow(9002);

    const first = enqueueQtoWorkflowWrite({
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
});
