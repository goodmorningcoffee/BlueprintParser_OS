import { QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { queryKeys } from "@/queries/queryKeys";
import {
  publishAnnotationDrag,
  rollbackAnnotationDrag,
} from "@/queries/useAnnotations";
import type { ClientAnnotation } from "@/types";

const PUBLIC_ID = "drag-cache-project";
const PAGE = 1;
const KEY = queryKeys.annotations.all(PUBLIC_ID);

function annotation(overrides: Partial<ClientAnnotation> = {}): ClientAnnotation {
  return {
    id: 11,
    pageNumber: PAGE,
    name: "target",
    bbox: [0.1, 0.2, 0.3, 0.4],
    note: null,
    source: "user",
    data: { sentinel: "preserve" },
    ...overrides,
  };
}

let queryClient: QueryClient;

beforeEach(() => {
  queryClient = new QueryClient();
});

afterEach(() => {
  queryClient.clear();
});

describe("annotation drag cache CAS", () => {
  it("publishes the exact bbox row, preserves order/non-owned fields, and rolls only its row back", () => {
    const neighbor = annotation({ id: 10, name: "neighbor" });
    const source = annotation();
    const destination = annotation({ id: 12, pageNumber: 2, name: "destination" });
    queryClient.setQueryData(KEY, [neighbor, source, destination]);
    const before = queryClient.getQueryData<ClientAnnotation[]>(KEY)!;

    const update = {
      kind: "bbox",
      payload: { bbox: [0.4, 0.5, 0.6, 0.7] as ClientAnnotation["bbox"] },
    } as const;
    const published = publishAnnotationDrag(queryClient, PUBLIC_ID, PAGE, source.id, update);
    const after = queryClient.getQueryData<ClientAnnotation[]>(KEY)!;

    expect(published).toBe(after[1]);
    expect(after.map((row) => row.id)).toEqual(before.map((row) => row.id));
    expect(after[0]).toBe(before[0]);
    expect(after[2]).toBe(before[2]);
    expect(after[1]).toMatchObject({ bbox: update.payload.bbox, data: source.data });

    expect(rollbackAnnotationDrag(
      queryClient,
      PUBLIC_ID,
      PAGE,
      source.id,
      published,
      source,
      "bbox",
    )).toBe(true);
    const rolled = queryClient.getQueryData<ClientAnnotation[]>(KEY)!;
    expect(rolled[1]).toMatchObject({ bbox: source.bbox, data: source.data });
    expect(rolled[0]).toBe(before[0]);
    expect(rolled[2]).toBe(before[2]);
  });

  it("publishes and rolls back vertex bbox plus full data as one paired update", () => {
    const source = annotation({
      data: { type: "area-polygon", vertices: [{ x: 0.1, y: 0.2 }], areaSqUnits: 1 },
    });
    queryClient.setQueryData(KEY, [source]);
    const nextData = {
      type: "area-polygon",
      vertices: [{ x: 0.8, y: 0.9 }],
      areaSqUnits: 9,
    };
    const published = publishAnnotationDrag(queryClient, PUBLIC_ID, PAGE, source.id, {
      kind: "vertex",
      payload: { bbox: [0.8, 0.9, 0.8, 0.9], data: nextData },
    });

    expect(published).toMatchObject({ bbox: [0.8, 0.9, 0.8, 0.9], data: nextData });
    expect(rollbackAnnotationDrag(
      queryClient,
      PUBLIC_ID,
      PAGE,
      source.id,
      published,
      source,
      "vertex",
    )).toBe(true);
    expect(queryClient.getQueryData<ClientAnnotation[]>(KEY)![0]).toMatchObject({
      bbox: source.bbox,
      data: source.data,
    });
  });

  it("scopes an ID collision to the captured source page", () => {
    const destinationCollision = annotation({
      pageNumber: 2,
      name: "same id on destination",
      bbox: [0.7, 0.7, 0.9, 0.9],
    });
    const source = annotation();
    queryClient.setQueryData(KEY, [destinationCollision, source]);
    const before = queryClient.getQueryData<ClientAnnotation[]>(KEY)!;

    const published = publishAnnotationDrag(queryClient, PUBLIC_ID, PAGE, source.id, {
      kind: "bbox",
      payload: { bbox: [0.4, 0.5, 0.6, 0.7] },
    });
    const after = queryClient.getQueryData<ClientAnnotation[]>(KEY)!;

    expect(after[0]).toBe(before[0]);
    expect(published).toBe(after[1]);
    expect(after[1].bbox).toEqual([0.4, 0.5, 0.6, 0.7]);
  });

  it("lets a newer same-geometry row defeat rollback by exact identity without emitting a CAS update", () => {
    const source = annotation();
    queryClient.setQueryData(KEY, [source]);
    const published = publishAnnotationDrag(queryClient, PUBLIC_ID, PAGE, source.id, {
      kind: "bbox",
      payload: { bbox: [0.4, 0.5, 0.6, 0.7] },
    })!;
    queryClient.setQueryData<ClientAnnotation[]>(KEY, (old = []) => old.map((row) =>
      row.id === source.id ? { ...row, note: "newer, same geometry" } : row,
    ));
    const newer = queryClient.getQueryData<ClientAnnotation[]>(KEY)![0];
    const beforeCount = queryClient.getQueryState(KEY)!.dataUpdateCount;
    let updatedEvents = 0;
    const targetQuery = queryClient.getQueryCache().find({ queryKey: KEY, exact: true });
    const unsubscribe = queryClient.getQueryCache().subscribe((event) => {
      if (event.type === "updated" && event.query === targetQuery) updatedEvents += 1;
    });

    expect(rollbackAnnotationDrag(
      queryClient,
      PUBLIC_ID,
      PAGE,
      source.id,
      published,
      source,
      "bbox",
    )).toBe(false);
    unsubscribe();

    expect(queryClient.getQueryData<ClientAnnotation[]>(KEY)![0]).toBe(newer);
    expect(queryClient.getQueryState(KEY)!.dataUpdateCount).toBe(beforeCount);
    expect(updatedEvents).toBe(0);
  });

  it("keeps missing caches and missing rows exact, with zero query update events", () => {
    const update = {
      kind: "bbox",
      payload: { bbox: [0.4, 0.5, 0.6, 0.7] as ClientAnnotation["bbox"] },
    } as const;
    const missingOrigin = annotation({ id: 999 });
    const missingWitness = { ...missingOrigin };
    let updatedEvents = 0;
    const unsubscribeAbsent = queryClient.getQueryCache().subscribe((event) => {
      if (event.type === "updated") updatedEvents += 1;
    });
    expect(publishAnnotationDrag(queryClient, PUBLIC_ID, PAGE, 999, update)).toBeNull();
    expect(rollbackAnnotationDrag(
      queryClient,
      PUBLIC_ID,
      PAGE,
      missingOrigin.id,
      missingWitness,
      missingOrigin,
      "bbox",
    )).toBe(false);
    unsubscribeAbsent();
    expect(queryClient.getQueryState(KEY)).toBeUndefined();
    expect(updatedEvents).toBe(0);

    const existing = [annotation({ id: 12 })];
    queryClient.setQueryData(KEY, existing);
    const cached = queryClient.getQueryData<ClientAnnotation[]>(KEY)!;
    const beforeCount = queryClient.getQueryState(KEY)!.dataUpdateCount;
    updatedEvents = 0;
    const targetQuery = queryClient.getQueryCache().find({ queryKey: KEY, exact: true });
    const unsubscribeMissing = queryClient.getQueryCache().subscribe((event) => {
      if (event.type === "updated" && event.query === targetQuery) updatedEvents += 1;
    });
    expect(publishAnnotationDrag(queryClient, PUBLIC_ID, PAGE, 999, update)).toBeNull();
    expect(rollbackAnnotationDrag(
      queryClient,
      PUBLIC_ID,
      PAGE,
      missingOrigin.id,
      missingWitness,
      missingOrigin,
      "bbox",
    )).toBe(false);
    unsubscribeMissing();

    expect(queryClient.getQueryData(KEY)).toBe(cached);
    expect(queryClient.getQueryState(KEY)!.dataUpdateCount).toBe(beforeCount);
    expect(updatedEvents).toBe(0);
  });
});
