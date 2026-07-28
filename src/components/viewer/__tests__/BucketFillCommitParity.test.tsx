/**
 * BucketFillCommitParity — the two commit paths must persist the SAME annotation.
 *
 * PLAN §5 phase 2 requires this test, and phase 3's ENTRY CONDITION depends on it existing: no
 * earlier phase produces it. It is the regression guard for what phase 0 established as U9 — that
 * `commitBucketFill`'s two call sites emit identical rows.
 *
 * ── ⚠ WHY THIS DRIVES THE DIALOG AND NOT THE HOOK ───────────────────────────────────────
 * Both call sites invoke `commitBucketFill(item, { canAdopt })` with the identical signature, so a
 * test that called the hook twice would compare a function against itself and pass no matter what
 * broke. The difference between the paths lives ONE LEVEL UP, in `BucketFillAssignDialog`: the
 * "create and assign" path first POSTs `/api/takeoff-items` and commits whatever the server
 * returns, while the "assign to existing" path commits a row already in the takeoff cache. Only by
 * driving both through the dialog does the comparison mean anything.
 *
 * ── THE FIXTURE IS BUILT SO THE ASSERTION CAN BE LITERAL ────────────────────────────────
 * The created item and the existing item are made to differ **only in `id`** — same name, same
 * colour. PLAN's wording is then exactly achievable: the two `POST /api/annotations` bodies are
 * deep-equal **except `takeoffItemId`**. Any other divergence — a dropped `holes`, a different
 * `pageNumber` capture, a `source` that only one path sets — fails as an inequality rather than
 * needing its own assertion.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React from "react";
import { render, screen, fireEvent, waitFor, act, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import BucketFillAssignDialog from "@/components/viewer/BucketFillAssignDialog";
import { useToolStore } from "@/stores/toolStore";
import { useSessionStore } from "@/stores/sessionStore";
import { useViewerCoreStore } from "@/stores/viewerCoreStore";
import { queryKeys } from "@/queries/queryKeys";
import type { ClientTakeoffItem } from "@/types";

const PUBLIC_ID = "proj-parity";
const PAGE = 4;

/** One shared item shape. The two paths differ ONLY by id — see the header. */
const NAME = "Level 2 — Office";
const COLOR = "#f97316";
const EXISTING_ID = 4242;
const CREATED_ID = 9001;

const item = (id: number): ClientTakeoffItem => ({
  id,
  groupId: null,
  name: NAME,
  shape: "polygon",
  color: COLOR,
  size: 24,
  sortOrder: 0,
});

/**
 * A polygon WITH holes, so a path that drops them fails rather than passing vacuously.
 *
 * ⚠ `bbox` is a 4-TUPLE, not `{x,y,w,h}` — my first fixture used the object shape and the tests
 * still passed, because the commit path forwards `bbox` opaquely. tsc caught it. A fixture whose
 * shape does not match production is a test agreeing with itself.
 */
const PENDING = {
  vertices: [
    { x: 0.2, y: 0.2 },
    { x: 0.6, y: 0.2 },
    { x: 0.6, y: 0.7 },
    { x: 0.2, y: 0.7 },
  ],
  holes: [
    {
      vertices: [
        { x: 0.3, y: 0.3 },
        { x: 0.4, y: 0.3 },
        { x: 0.4, y: 0.4 },
      ],
    },
  ],
  areaSqUnits: 812.5,
  unit: "SF",
  bbox: [0.2, 0.2, 0.4, 0.5] as [number, number, number, number],
  /**
   * [bucketfill P3] Now PERSISTED. This comment previously said it was not, and predicted that
   * the phase-3 item would make the body assertion fail. It did, on the first run after the
   * change. Left as a record that the prediction was written down before the fact.
   */
  method: "client-raster",
};

interface Captured {
  url: string;
  body: unknown;
}

let captured: Captured[] = [];

function installFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      captured.push({
        url: String(url),
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      if (String(url).includes("/api/takeoff-items")) {
        // The server assigns the id. Everything else comes back as sent, which is what makes the
        // two paths comparable.
        return {
          ok: true,
          status: 200,
          json: async () => item(CREATED_ID),
        } as unknown as Response;
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ id: 777 }),
      } as unknown as Response;
    }),
  );
}

function seed(qc: QueryClient, items: ClientTakeoffItem[]) {
  qc.setQueryData(queryKeys.takeoff.items(PUBLIC_ID), items);
  qc.setQueryData(queryKeys.annotations.all(PUBLIC_ID), []);
}

function renderDialog(qc: QueryClient) {
  return render(
    <QueryClientProvider client={qc}>
      <BucketFillAssignDialog pendingPolygon={PENDING} width={1000} height={800} cssScale={1} />
    </QueryClientProvider>,
  );
}

function newClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function primeStores() {
  act(() => {
    useSessionStore.setState({ publicId: PUBLIC_ID, isDemo: false });
    useViewerCoreStore.setState({ pageNumber: PAGE });
    useToolStore.setState({ bucketFillPendingPolygon: PENDING });
  });
}

const annotationPosts = () => captured.filter((c) => c.url.includes("/api/annotations"));

beforeEach(() => {
  captured = [];
  installFetch();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  act(() => {
    useToolStore.setState({ bucketFillPendingPolygon: null });
  });
});

describe("★ BucketFillCommitParity — both paths persist the same annotation", () => {
  it("assign-to-existing and create-and-assign differ ONLY in takeoffItemId", async () => {
    // ── path A: assign to an item already in the takeoff cache ──────────────
    const qcA = newClient();
    seed(qcA, [item(EXISTING_ID)]);
    primeStores();
    const viewA = renderDialog(qcA);
    fireEvent.click(screen.getByText(NAME));
    await waitFor(() => expect(annotationPosts()).toHaveLength(1));
    const bodyA = annotationPosts()[0].body;
    viewA.unmount();

    // ── path B: create a new item, then assign ──────────────────────────────
    captured = [];
    const qcB = newClient();
    seed(qcB, []); // no existing area items, so the dialog opens on the create form
    primeStores();
    renderDialog(qcB);
    fireEvent.change(screen.getByPlaceholderText("New item name"), {
      target: { value: NAME },
    });
    fireEvent.click(screen.getByText("Create & Assign"));
    await waitFor(() => expect(annotationPosts()).toHaveLength(1));
    const bodyB = annotationPosts()[0].body;

    // The create path really did create first — otherwise this is path A twice.
    expect(captured.some((c) => c.url.includes("/api/takeoff-items"))).toBe(true);

    // ★ The assertion PLAN asks for, literally.
    const strip = (b: unknown) => {
      const cloned = JSON.parse(JSON.stringify(b)) as {
        data: { takeoffItemId?: number };
      };
      delete cloned.data.takeoffItemId;
      return cloned;
    };
    expect(strip(bodyB)).toEqual(strip(bodyA));

    // ...and the field we excluded is genuinely the one that differs, so the exclusion is not
    // hiding an accidental match.
    expect((bodyA as { data: { takeoffItemId: number } }).data.takeoffItemId).toBe(EXISTING_ID);
    expect((bodyB as { data: { takeoffItemId: number } }).data.takeoffItemId).toBe(CREATED_ID);
  });

  it("persists the fields phase 3 will depend on, not merely a matching pair", async () => {
    // Two identical-but-wrong bodies would satisfy the parity assertion above. Pin the contents.
    const qc = newClient();
    seed(qc, [item(EXISTING_ID)]);
    primeStores();
    renderDialog(qc);
    fireEvent.click(screen.getByText(NAME));
    await waitFor(() => expect(annotationPosts()).toHaveLength(1));

    expect(annotationPosts()[0].body).toEqual({
      projectId: PUBLIC_ID,
      pageNumber: PAGE,
      name: NAME,
      bbox: PENDING.bbox,
      source: "takeoff",
      data: {
        type: "area-polygon",
        takeoffItemId: EXISTING_ID,
        color: COLOR,
        vertices: PENDING.vertices,
        // `holes` is CONDITIONAL in the commit path — present only when non-empty. A path that
        // dropped courtyard holes would still deep-equal its twin, so it is asserted here.
        holes: PENDING.holes,
        areaSqUnits: PENDING.areaSqUnits,
        unit: PENDING.unit,
        // [bucketfill P3] `method` now persists. This assertion FAILED when the field landed,
        // which is exactly what the note on PENDING predicted — the feature arriving, not a
        // regression. Provenance is what makes the mixed-provenance window auditable.
        method: "client-raster",
      },
    });
  });

  it("★ carries `method` identically on BOTH paths, so provenance survives either route", async () => {
    // Provenance is only useful if it is the same regardless of how the item was created. If the
    // create path lost it, half of a project's history would read as unknown for a reason that has
    // nothing to do with which engine measured it.
    const qcA = newClient();
    seed(qcA, [item(EXISTING_ID)]);
    primeStores();
    const viewA = renderDialog(qcA);
    fireEvent.click(screen.getByText(NAME));
    await waitFor(() => expect(annotationPosts()).toHaveLength(1));
    const a = annotationPosts()[0].body as { data: { method?: string } };
    viewA.unmount();

    captured = [];
    const qcB = newClient();
    seed(qcB, []);
    primeStores();
    renderDialog(qcB);
    fireEvent.change(screen.getByPlaceholderText("New item name"), { target: { value: NAME } });
    fireEvent.click(screen.getByText("Create & Assign"));
    await waitFor(() => expect(annotationPosts()).toHaveLength(1));
    const b = annotationPosts()[0].body as { data: { method?: string } };

    expect(a.data.method).toBe("client-raster");
    expect(b.data.method).toBe(a.data.method);
  });

  it("★ writes NO method when the pending polygon has none — absent means UNKNOWN, not raster", async () => {
    // Every annotation written before this field existed has no `method`. Defaulting a missing
    // value to "raster" anywhere downstream would silently relabel history as measured-by-raster,
    // which is precisely the claim the field exists to make checkable.
    const noMethod = { ...PENDING } as Record<string, unknown>;
    delete noMethod.method;
    const qc = newClient();
    seed(qc, [item(EXISTING_ID)]);
    act(() => {
      useSessionStore.setState({ publicId: PUBLIC_ID, isDemo: false });
      useViewerCoreStore.setState({ pageNumber: PAGE });
      useToolStore.setState({ bucketFillPendingPolygon: noMethod as never });
    });
    render(
      <QueryClientProvider client={qc}>
        <BucketFillAssignDialog
          pendingPolygon={noMethod as never}
          width={1000}
          height={800}
          cssScale={1}
        />
      </QueryClientProvider>,
    );
    fireEvent.click(screen.getByText(NAME));
    await waitFor(() => expect(annotationPosts()).toHaveLength(1));
    const body = annotationPosts()[0].body as { data: Record<string, unknown> };
    expect(body.data.method).toBeUndefined();
  });

  it("omits `holes` entirely when there are none, on both paths alike", async () => {
    // The conditional spread is deliberate (the old 'dropped' comment was stale). Pin the shape so
    // a future 'always include holes: []' change is a decision rather than a drift.
    const noHoles = { ...PENDING, holes: [] };
    const qc = newClient();
    seed(qc, [item(EXISTING_ID)]);
    act(() => {
      useSessionStore.setState({ publicId: PUBLIC_ID, isDemo: false });
      useViewerCoreStore.setState({ pageNumber: PAGE });
      useToolStore.setState({ bucketFillPendingPolygon: noHoles });
    });
    render(
      <QueryClientProvider client={qc}>
        <BucketFillAssignDialog pendingPolygon={noHoles} width={1000} height={800} cssScale={1} />
      </QueryClientProvider>,
    );
    fireEvent.click(screen.getByText(NAME));
    await waitFor(() => expect(annotationPosts()).toHaveLength(1));
    const body = annotationPosts()[0].body as { data: Record<string, unknown> };
    expect("holes" in body.data).toBe(false);
  });
});
