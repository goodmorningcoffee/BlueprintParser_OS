import { QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { queryKeys } from "@/queries/queryKeys";
import {
  enrichMarkupEditFromResponse,
  isCurrentMarkupEdit,
  publishMarkupEdit,
  rollbackMarkupEdit,
  type MarkupEditPublication,
} from "@/queries/useAnnotations";
import type { ClientAnnotation } from "@/types";

const PUBLIC_ID = "markup-cache-project";
const PAGE = 1;
const KEY = queryKeys.annotations.all(PUBLIC_ID);

function annotation(
  id = 11,
  overrides: Partial<ClientAnnotation> = {},
): ClientAnnotation {
  return {
    id,
    pageNumber: PAGE,
    name: `annotation-${id}`,
    bbox: [0.1, 0.2, 0.3, 0.4],
    note: "origin note",
    source: "user",
    data: { csiCodes: ["08", "08 11 16", "09 91 00"], sentinel: "preserve" },
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

describe("annotation markup edit cache CAS", () => {
  it("publishes one page-scoped row with editable-head CSI and exact canonical witnesses", () => {
    const collision = annotation(11, { pageNumber: 2, name: "same ID, other page" });
    const neighbor = annotation(10, { name: "neighbor" });
    const source = annotation();
    queryClient.setQueryData(KEY, [collision, neighbor, source]);
    const before = queryClient.getQueryData<ClientAnnotation[]>(KEY)!;

    const publication = publishMarkupEdit(queryClient, PUBLIC_ID, PAGE, source.id, {
      name: "renamed",
      note: "revised note",
      csiCode: "09 91 00",
    });
    const after = queryClient.getQueryData<ClientAnnotation[]>(KEY)!;

    expect(publication?.origin).toBe(before[2]);
    expect(publication?.published).toBe(after[2]);
    expect(publication?.dataForRequest).toEqual({
      csiCodes: ["09 91 00", "08 11 16"],
      sentinel: "preserve",
    });
    expect(after[0]).toBe(before[0]);
    expect(after[1]).toBe(before[1]);
    expect(after[2]).toMatchObject({
      id: source.id,
      pageNumber: PAGE,
      name: "renamed",
      note: "revised note",
      bbox: source.bbox,
      source: source.source,
      data: publication?.dataForRequest,
    });
    expect(isCurrentMarkupEdit(queryClient, publication!)).toBe(true);
  });

  it("restores the full origin value while preserving interleaved rows and references", () => {
    const source = annotation();
    const collision = annotation(source.id, { pageNumber: 2, name: "same ID, other page" });
    const neighbor = annotation(12, { name: "neighbor" });
    queryClient.setQueryData(KEY, [collision, source, neighbor]);
    const publication = publishMarkupEdit(queryClient, PUBLIC_ID, PAGE, source.id, {
      name: "optimistic",
      note: null,
      csiCode: "09 91 00",
    })!;
    const interleaved = annotation(13, { name: "interleaved" });
    queryClient.setQueryData<ClientAnnotation[]>(KEY, (old = []) => [...old, interleaved]);
    const beforeRollback = queryClient.getQueryData<ClientAnnotation[]>(KEY)!;

    expect(rollbackMarkupEdit(queryClient, publication)).toBe(true);
    const rolled = queryClient.getQueryData<ClientAnnotation[]>(KEY)!;

    expect(rolled[0]).toBe(beforeRollback[0]);
    expect(rolled[1]).toEqual(source);
    expect(rolled[1]).not.toBe(publication.published);
    expect(rolled[2]).toBe(beforeRollback[2]);
    expect(rolled[3]).toBe(beforeRollback[3]);
  });

  it("merges only returned strings in order without mutating the optimistic witness", () => {
    const collision = annotation(11, { pageNumber: 2, name: "same ID, other page" });
    const neighbor = annotation(12, { name: "neighbor" });
    queryClient.setQueryData(KEY, [collision, annotation(), neighbor]);
    const publication = publishMarkupEdit(queryClient, PUBLIC_ID, PAGE, 11, {
      name: "optimistic",
      note: "detect codes",
      csiCode: "09 91 00",
    })!;
    const optimisticData = publication.published.data;

    const adopted = enrichMarkupEditFromResponse(queryClient, publication, {
      autoCsiCodes: ["08 11 16", 42, "10 10 10", null, "10 10 10"],
    });
    const after = queryClient.getQueryData<ClientAnnotation[]>(KEY)!;

    expect(adopted).toBe(after[1]);
    expect(after[0]).toBe(collision);
    expect(after[1].data).toEqual({
      csiCodes: ["09 91 00", "08 11 16", "10 10 10"],
      sentinel: "preserve",
    });
    expect(after[2]).toBe(neighbor);
    expect(publication.published.data).toBe(optimisticData);
    expect(publication.published.data?.csiCodes).toEqual(["09 91 00", "08 11 16"]);
  });

  it("gives a reentrant identical successor distinct terminal ownership", () => {
    queryClient.setQueryData(KEY, [annotation()]);
    const input = { name: "same edit", note: "same note", csiCode: "09 91 00" } as const;
    let successor: MarkupEditPublication | null = null;
    let installed = false;
    const targetQuery = queryClient.getQueryCache().find({ queryKey: KEY, exact: true });
    const unsubscribe = queryClient.getQueryCache().subscribe((event) => {
      if (installed || event.type !== "updated" || event.query !== targetQuery) return;
      if (queryClient.getQueryData<ClientAnnotation[]>(KEY)?.[0]?.name !== input.name) return;
      installed = true;
      successor = publishMarkupEdit(queryClient, PUBLIC_ID, PAGE, 11, input);
    });

    const earlier = publishMarkupEdit(queryClient, PUBLIC_ID, PAGE, 11, input)!;
    unsubscribe();
    expect(installed).toBe(true);
    expect(successor).not.toBeNull();
    expect(earlier.published).toBe(successor!.published);
    expect(isCurrentMarkupEdit(queryClient, earlier)).toBe(false);
    expect(isCurrentMarkupEdit(queryClient, successor!)).toBe(true);

    // B's no-delta success settles its operation without changing the shared canonical row.
    expect(enrichMarkupEditFromResponse(queryClient, successor!, {
      autoCsiCodes: [],
    })).toBe(successor!.published);
    expect(isCurrentMarkupEdit(queryClient, successor!)).toBe(false);
    expect(rollbackMarkupEdit(queryClient, earlier)).toBe(false);
    expect(queryClient.getQueryData<ClientAnnotation[]>(KEY)?.[0]).toBe(successor!.published);
  });

  it("keeps a sequential identical successor authoritative after its no-delta success", () => {
    queryClient.setQueryData(KEY, [annotation()]);
    const input = { name: "same edit", note: "same note", csiCode: "09 91 00" } as const;
    const earlier = publishMarkupEdit(queryClient, PUBLIC_ID, PAGE, 11, input)!;
    const successor = publishMarkupEdit(queryClient, PUBLIC_ID, PAGE, 11, input)!;

    expect(earlier.published).toBe(successor.published);
    expect(isCurrentMarkupEdit(queryClient, earlier)).toBe(false);
    expect(isCurrentMarkupEdit(queryClient, successor)).toBe(true);
    expect(enrichMarkupEditFromResponse(queryClient, successor, {
      autoCsiCodes: [],
    })).toBe(successor.published);
    expect(rollbackMarkupEdit(queryClient, earlier)).toBe(false);
    expect(queryClient.getQueryData<ClientAnnotation[]>(KEY)?.[0]).toBe(successor.published);
  });

  it("suppresses an old failure terminal after a rollback-notification successor", () => {
    const source = annotation();
    queryClient.setQueryData(KEY, [source]);
    const earlier = publishMarkupEdit(queryClient, PUBLIC_ID, PAGE, source.id, {
      name: "rejected edit",
      note: null,
      csiCode: "09 91 00",
    })!;
    let successor: MarkupEditPublication | null = null;
    let installed = false;
    const targetQuery = queryClient.getQueryCache().find({ queryKey: KEY, exact: true });
    const unsubscribe = queryClient.getQueryCache().subscribe((event) => {
      if (installed || event.type !== "updated" || event.query !== targetQuery) return;
      const row = queryClient.getQueryData<ClientAnnotation[]>(KEY)?.[0];
      if (row?.name !== source.name) return;
      installed = true;
      successor = publishMarkupEdit(queryClient, PUBLIC_ID, PAGE, source.id, {
        name: source.name,
        note: source.note,
        csiCode: "08",
      });
      enrichMarkupEditFromResponse(queryClient, successor!, { autoCsiCodes: [] });
    });

    expect(rollbackMarkupEdit(queryClient, earlier)).toBe(false);
    unsubscribe();
    expect(installed).toBe(true);
    expect((successor as MarkupEditPublication | null)?.published).toBe(
      queryClient.getQueryData<ClientAnnotation[]>(KEY)?.[0],
    );
    expect(queryClient.getQueryData<ClientAnnotation[]>(KEY)?.[0]).toEqual(source);
  });

  it("adds returned CSI to null data and makes duplicate-only success a zero-update terminal", () => {
    const nullData = annotation(20, { data: null });
    queryClient.setQueryData(KEY, [nullData]);
    const first = publishMarkupEdit(queryClient, PUBLIC_ID, PAGE, nullData.id, {
      name: "null-data edit",
      note: null,
      csiCode: "",
    })!;
    expect(enrichMarkupEditFromResponse(queryClient, first, {
      autoCsiCodes: ["03 30 00"],
    })?.data?.csiCodes).toEqual(["03 30 00"]);

    const current = queryClient.getQueryData<ClientAnnotation[]>(KEY)![0];
    const second = publishMarkupEdit(queryClient, PUBLIC_ID, PAGE, current.id, {
      name: "second edit",
      note: null,
      csiCode: "03 30 00",
    })!;
    const beforeCount = queryClient.getQueryState(KEY)!.dataUpdateCount;
    let updatedEvents = 0;
    const targetQuery = queryClient.getQueryCache().find({ queryKey: KEY, exact: true });
    const unsubscribe = queryClient.getQueryCache().subscribe((event) => {
      if (event.type === "updated" && event.query === targetQuery) updatedEvents += 1;
    });

    expect(enrichMarkupEditFromResponse(queryClient, second, {
      autoCsiCodes: ["03 30 00", "03 30 00"],
    })).toBe(second.published);
    unsubscribe();
    expect(queryClient.getQueryState(KEY)!.dataUpdateCount).toBe(beforeCount);
    expect(updatedEvents).toBe(0);
  });

  it("lets a genuinely newer row defeat ownership, rollback, and enrichment with zero updates", () => {
    queryClient.setQueryData(KEY, [annotation()]);
    const publication = publishMarkupEdit(queryClient, PUBLIC_ID, PAGE, 11, {
      name: "optimistic",
      note: null,
      csiCode: "09 91 00",
    })!;
    queryClient.setQueryData<ClientAnnotation[]>(KEY, (old = []) => old.map((row) =>
      row.id === 11 ? { ...row, note: "newer publication sentinel" } : row,
    ));
    const newer = queryClient.getQueryData<ClientAnnotation[]>(KEY)![0];
    const beforeCount = queryClient.getQueryState(KEY)!.dataUpdateCount;
    let updatedEvents = 0;
    const targetQuery = queryClient.getQueryCache().find({ queryKey: KEY, exact: true });
    const unsubscribe = queryClient.getQueryCache().subscribe((event) => {
      if (event.type === "updated" && event.query === targetQuery) updatedEvents += 1;
    });

    expect(isCurrentMarkupEdit(queryClient, publication)).toBe(false);
    expect(rollbackMarkupEdit(queryClient, publication)).toBe(false);
    expect(enrichMarkupEditFromResponse(queryClient, publication, {
      autoCsiCodes: ["10 10 10"],
    })).toBeNull();
    unsubscribe();

    expect(queryClient.getQueryData<ClientAnnotation[]>(KEY)![0]).toBe(newer);
    expect(queryClient.getQueryState(KEY)!.dataUpdateCount).toBe(beforeCount);
    expect(updatedEvents).toBe(0);
  });

  it("keeps missing caches and missing/wrong-page rows inert without creating query state", () => {
    const source = annotation();
    const fake: MarkupEditPublication = {
      publicId: "absent",
      pageNumber: PAGE,
      annotationId: source.id,
      ownerToken: Symbol("absent markup edit"),
      origin: source,
      published: { ...source, name: "published" },
    };
    let updatedEvents = 0;
    const unsubscribeAbsent = queryClient.getQueryCache().subscribe((event) => {
      if (event.type === "updated") updatedEvents += 1;
    });
    expect(publishMarkupEdit(queryClient, "absent", PAGE, source.id, {
      name: "missing",
      note: null,
      csiCode: "08",
    })).toBeNull();
    expect(isCurrentMarkupEdit(queryClient, fake)).toBe(false);
    expect(rollbackMarkupEdit(queryClient, fake)).toBe(false);
    expect(enrichMarkupEditFromResponse(queryClient, fake, {
      autoCsiCodes: ["10 10 10"],
    })).toBeNull();
    unsubscribeAbsent();
    expect(queryClient.getQueryState(queryKeys.annotations.all("absent"))).toBeUndefined();
    expect(updatedEvents).toBe(0);

    queryClient.setQueryData(KEY, [annotation(12), annotation(11, { pageNumber: 2 })]);
    const before = queryClient.getQueryData<ClientAnnotation[]>(KEY)!;
    const beforeCount = queryClient.getQueryState(KEY)!.dataUpdateCount;
    expect(publishMarkupEdit(queryClient, PUBLIC_ID, PAGE, 11, {
      name: "wrong page",
      note: null,
      csiCode: "08",
    })).toBeNull();
    expect(queryClient.getQueryData(KEY)).toBe(before);
    expect(queryClient.getQueryState(KEY)!.dataUpdateCount).toBe(beforeCount);
  });
});
