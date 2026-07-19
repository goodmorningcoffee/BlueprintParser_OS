// @vitest-environment node
import { describe, expect, inject, it, vi } from "vitest";

vi.mock("@/lib/auth", async () => {
  const { sessionState } = await import("@/test/harness");
  return { auth: async () => sessionState.current };
});

import { POST } from "@/app/api/annotations/split/route";
import {
  SPLIT_HOLED_TARGET_MESSAGE,
  SPLIT_UNSUPPORTED_AREA_DATA_MESSAGE,
  type SplitAnnotationRequest,
} from "@/lib/annotation-split-contract";
import { db } from "@/lib/db";
import {
  annotationGroupMembers,
  annotationGroups,
  annotations,
  takeoffItems,
  users,
} from "@/lib/db/schema";
import { polygonArea, splitPolygonByLine } from "@/lib/polygon-split";
import {
  asUser,
  createCompany,
  createUser,
  createWorld,
  makeReq,
  publishDemoFixture,
  readJson,
  signedOut,
  type FixtureUser,
} from "@/test/harness";
import type { AnnotationData } from "@/types";
import { and, eq } from "drizzle-orm";

const dbUp = inject("dbUp") as boolean;
const SOURCE_VERTICES = [
  { x: 0.1, y: 0.1 },
  { x: 0.9, y: 0.1 },
  { x: 0.9, y: 0.9 },
  { x: 0.1, y: 0.9 },
];

type SeedOptions = Readonly<{
  annotation?: Partial<typeof annotations.$inferInsert>;
  data?: Record<string, unknown>;
  item?: Partial<typeof takeoffItems.$inferInsert>;
  withGroup?: boolean;
}>;

async function seedFixture(options: SeedOptions = {}) {
  const { company, user, project } = await createWorld();
  const [item] = await db
    .insert(takeoffItems)
    .values({
      projectId: project.id,
      name: "Current item name",
      shape: "polygon",
      color: "#22aa44",
      size: 12,
      ...options.item,
    })
    .returning();
  const data = {
    type: "area-polygon",
    takeoffItemId: item.id,
    color: "#old-source-color",
    vertices: SOURCE_VERTICES,
    areaSqUnits: 64,
    unit: "SF",
    csiCodes: ["03 30 00"],
    keywords: ["slab"],
    ...options.data,
  };
  const [source] = await db
    .insert(annotations)
    .values({
      projectId: project.id,
      pageNumber: 2,
      name: "Preserved source name",
      minX: 0.1,
      minY: 0.1,
      maxX: 0.9,
      maxY: 0.9,
      note: "preserved note",
      source: "takeoff",
      threshold: 0.73,
      creatorId: user.id,
      data: data as AnnotationData,
      ...options.annotation,
    })
    .returning();

  let group: typeof annotationGroups.$inferSelect | undefined;
  if (options.withGroup) {
    [group] = await db
      .insert(annotationGroups)
      .values({
        projectId: project.id,
        name: "Preserved group",
        createdBy: user.id,
      })
      .returning();
    await db.insert(annotationGroupMembers).values({
      annotationId: source.id,
      groupId: group.id,
    });
  }
  return { company, user, project, item, source, group };
}

function requestFor(
  source: typeof annotations.$inferSelect,
  over: Partial<SplitAnnotationRequest> = {},
): SplitAnnotationRequest {
  return {
    sourceAnnotationId: source.id,
    expectedSource: {
      pageNumber: source.pageNumber,
      bbox: [source.minX, source.minY, source.maxX, source.maxY],
      data: source.data as Record<string, unknown>,
    },
    lineA: { x: 0.5, y: 0 },
    lineB: { x: 0.5, y: 1 },
    measurements: {
      leftAreaSqUnits: 32,
      rightAreaSqUnits: 32,
      unit: "SF",
    },
    ...over,
  };
}

async function post(body: unknown) {
  return readJson(await POST(makeReq("/api/annotations/split", { body })));
}

async function projectRows(projectId: number) {
  return db
    .select()
    .from(annotations)
    .where(eq(annotations.projectId, projectId));
}

function expectBboxClose(actual: number[], expected: number[]) {
  expect(actual).toHaveLength(4);
  for (let index = 0; index < 4; index += 1) {
    expect(actual[index]).toBeCloseTo(expected[index], 6);
  }
}

function bboxFor(vertices: Array<{ x: number; y: number }>) {
  return [
    Math.min(...vertices.map(({ x }) => x)),
    Math.min(...vertices.map(({ y }) => y)),
    Math.max(...vertices.map(({ x }) => x)),
    Math.max(...vertices.map(({ y }) => y)),
  ];
}

describe.skipIf(!dbUp)("POST /api/annotations/split", () => {
  it("atomically returns authoritative halves, derives item metadata, and preserves left-only metadata/group membership", async () => {
    const fixture = await seedFixture({
      withGroup: true,
      annotation: { updatedAt: new Date("2020-01-01T00:00:00.000Z") },
    });
    const actingMember = await createUser(fixture.company.id);
    asUser(actingMember);
    const before = fixture.source;
    const request = requestFor(before, {
      measurements: {
        leftAreaSqUnits: 3.2,
        rightAreaSqUnits: 3.2,
        unit: "SM",
      },
    });

    const globalUpdate = vi.spyOn(db, "update");
    const globalInsert = vi.spyOn(db, "insert");
    let response: Awaited<ReturnType<typeof post>>;
    try {
      response = await post(request);
      expect(globalUpdate).not.toHaveBeenCalled();
      expect(globalInsert).not.toHaveBeenCalled();
    } finally {
      globalUpdate.mockRestore();
      globalInsert.mockRestore();
    }

    expect(response.status).toBe(200);
    expect(response.body.left.id).toBe(before.id);
    expect(response.body.right.id).toBeGreaterThan(0);
    expect(response.body.right.id).not.toBe(before.id);

    const expected = splitPolygonByLine(
      SOURCE_VERTICES,
      request.lineA,
      request.lineB,
    )!;
    expect(response.body.left.data.vertices).toEqual(expected.left);
    expect(response.body.right.data.vertices).toEqual(expected.right);
    expectBboxClose(response.body.left.bbox, bboxFor(expected.left));
    expectBboxClose(response.body.right.bbox, bboxFor(expected.right));

    for (const half of [response.body.left, response.body.right]) {
      expect(half.source).toBe("takeoff");
      expect(half.pageNumber).toBe(before.pageNumber);
      expect(half.data).toMatchObject({
        type: "area-polygon",
        takeoffItemId: fixture.item.id,
        color: fixture.item.color,
        areaSqUnits: 3.2,
        unit: "SM",
        csiCodes: ["03 30 00"],
        keywords: ["slab"],
      });
      expect(half.data).not.toHaveProperty("holes");
    }

    const rows = (await projectRows(fixture.project.id)).sort(
      (a, b) => a.id - b.id,
    );
    expect(rows).toHaveLength(2);
    const [left, right] = rows;
    expect(left).toMatchObject({
      id: before.id,
      projectId: before.projectId,
      pageNumber: before.pageNumber,
      name: before.name,
      note: before.note,
      source: before.source,
      creatorId: before.creatorId,
      threshold: before.threshold,
    });
    expect(left.createdAt).toEqual(before.createdAt);
    expect(left.updatedAt!.getTime()).toBeGreaterThan(
      before.updatedAt!.getTime(),
    );
    expect(right).toMatchObject({
      projectId: fixture.project.id,
      pageNumber: before.pageNumber,
      name: fixture.item.name,
      note: null,
      source: "takeoff",
      creatorId: actingMember.id,
      threshold: null,
    });

    const memberships = await db
      .select()
      .from(annotationGroupMembers)
      .where(eq(annotationGroupMembers.groupId, fixture.group!.id));
    expect(memberships.map(({ annotationId }) => annotationId)).toEqual([
      before.id,
    ]);
  });

  it("admits empty holes and current-calibration measurement states without conserving stale source area/unit", async () => {
    const precisionVertices = [
      { x: 0.123456789, y: 0.234567891 },
      { x: 0.876543211, y: 0.234567891 },
      { x: 0.876543211, y: 0.765432109 },
      { x: 0.123456789, y: 0.765432109 },
    ];
    const precisionLine = {
      lineA: { x: 1 / 3, y: 0 },
      lineB: { x: 1 / 3, y: 1 },
    } as const;
    const precisionSplit = splitPolygonByLine(
      precisionVertices,
      precisionLine.lineA,
      precisionLine.lineB,
    )!;
    const cases: Array<{
      source: Record<string, unknown>;
      annotation?: Partial<typeof annotations.$inferInsert>;
      measurements: SplitAnnotationRequest["measurements"];
      request?: Partial<SplitAnnotationRequest>;
      assertFloat4Rounding?: boolean;
    }> = [
      {
        source: { areaSqUnits: 0, unit: "SF", holes: [] },
        measurements: {
          leftAreaSqUnits: 32,
          rightAreaSqUnits: 32,
          unit: "SM" as const,
        },
      },
      {
        source: { areaSqUnits: 999, unit: "SF" },
        measurements: {
          leftAreaSqUnits: 3.2,
          rightAreaSqUnits: 3.2,
          unit: "SC" as const,
        },
      },
      {
        source: { areaSqUnits: 999, unit: "SM" },
        measurements: {
          leftAreaSqUnits: 0,
          rightAreaSqUnits: 0,
          unit: "SF" as const,
        },
      },
      {
        source: { vertices: precisionVertices },
        annotation: {
          minX: 0.123456789,
          minY: 0.234567891,
          maxX: 0.876543211,
          maxY: 0.765432109,
        },
        measurements: {
          leftAreaSqUnits: polygonArea(precisionSplit.left) * 100,
          rightAreaSqUnits: polygonArea(precisionSplit.right) * 100,
          unit: "SI" as const,
        },
        request: precisionLine,
        assertFloat4Rounding: true,
      },
    ];

    for (const testCase of cases) {
      const fixture = await seedFixture({
        data: testCase.source,
        annotation: testCase.annotation,
      });
      asUser(fixture.user);
      const response = await post(
        requestFor(fixture.source, {
          ...testCase.request,
          measurements: testCase.measurements,
        }),
      );
      expect(response.status).toBe(200);
      expect(response.body.left.data.areaSqUnits).toBe(
        testCase.measurements.leftAreaSqUnits,
      );
      expect(response.body.right.data.areaSqUnits).toBe(
        testCase.measurements.rightAreaSqUnits,
      );
      expect(response.body.left.data.unit).toBe(testCase.measurements.unit);
      if (testCase.assertFloat4Rounding) {
        const leftVertices = response.body.left.data.vertices as Array<{
          x: number;
          y: number;
        }>;
        const rightVertices = response.body.right.data.vertices as Array<{
          x: number;
          y: number;
        }>;
        const leftDerived = bboxFor(leftVertices);
        const rightDerived = bboxFor(rightVertices);
        expect(leftDerived[0]).toBeCloseTo(1 / 3, 15);
        expect(rightDerived[2]).toBeCloseTo(1 / 3, 15);
        expect(Math.fround(leftDerived[0])).not.toBe(leftDerived[0]);
        expect(Math.fround(rightDerived[2])).not.toBe(rightDerived[2]);
        expect(response.body.left.bbox[0]).not.toBe(leftDerived[0]);
        expect(response.body.right.bbox[2]).not.toBe(rightDerived[2]);
        expect(response.body.left.bbox[0]).toBeCloseTo(
          Math.fround(leftDerived[0]),
          7,
        );
        expect(response.body.right.bbox[2]).toBeCloseTo(
          Math.fround(rightDerived[2]),
          7,
        );
        expectBboxClose(response.body.left.bbox, leftDerived);
        expectBboxClose(response.body.right.bbox, rightDerived);
      }
      expect(await projectRows(fixture.project.id)).toHaveLength(2);
    }
  });

  it("has the strict request boundary and malformed-JSON envelope", async () => {
    const fixture = await seedFixture();
    signedOut();
    const valid = requestFor(fixture.source);
    const invalidBodies = [
      { ...valid, projectId: fixture.project.publicId },
      { ...valid, left: { vertices: [] } },
      { ...valid, sourceAnnotationId: 0 },
      { ...valid, lineB: valid.lineA },
      {
        ...valid,
        expectedSource: { ...valid.expectedSource, name: "caller-owned" },
      },
      { ...valid, measurements: { ...valid.measurements, extra: true } },
    ];
    for (const body of invalidBodies) {
      const response = await post(body);
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe("VALIDATION");
    }

    const malformed = await readJson(
      await POST(
        new Request("http://test.local/api/annotations/split", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{not-json",
        }),
      ),
    );
    expect(malformed).toEqual({
      status: 400,
      body: { error: { code: "BAD_REQUEST", message: "Invalid JSON body" } },
    });
    expect(await projectRows(fixture.project.id)).toEqual([fixture.source]);
  });

  it("enforces missing-before-auth, private auth, tenancy masking, and demo denial for every role", async () => {
    const missingRequest = requestFor({
      ...({} as typeof annotations.$inferSelect),
      id: Number.MAX_SAFE_INTEGER,
      pageNumber: 1,
      minX: 0.1,
      minY: 0.1,
      maxX: 0.9,
      maxY: 0.9,
      data: {
        type: "area-polygon",
        takeoffItemId: 1,
        color: "#000",
        vertices: SOURCE_VERTICES,
        areaSqUnits: 1,
        unit: "SF",
      },
    });
    signedOut();
    const missing = await post(missingRequest);
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe("NOT_FOUND");

    const privateFixture = await seedFixture();
    signedOut();
    expect((await post(requestFor(privateFixture.source))).status).toBe(401);
    asUser(await createUser((await createCompany()).id));
    expect((await post(requestFor(privateFixture.source))).status).toBe(404);
    expect(await projectRows(privateFixture.project.id)).toEqual([
      privateFixture.source,
    ]);

    const demoFixture = await seedFixture();
    const admin = await createUser(demoFixture.company.id, { role: "admin" });
    const root = await createUser((await createCompany()).id, {
      role: "admin",
      isRootAdmin: true,
    });
    await publishDemoFixture(demoFixture.project.id);
    const actors: Array<FixtureUser | null> = [
      null,
      demoFixture.user,
      admin,
      root,
    ];
    for (const actor of actors) {
      actor ? asUser(actor) : signedOut();
      const response = await post(requestFor(demoFixture.source));
      expect(response.status).toBe(403);
      expect(response.body.error).toEqual({
        code: "FORBIDDEN",
        message: "Demo projects are read-only",
      });
    }
    expect(await projectRows(demoFixture.project.id)).toEqual([
      demoFixture.source,
    ]);
  });

  it("treats page, bbox, and every complete-data snapshot drift as a 409 with exact no-write state", async () => {
    const fixture = await seedFixture();
    asUser(fixture.user);
    const base = requestFor(fixture.source);
    const staleRequests: SplitAnnotationRequest[] = [];

    staleRequests.push({
      ...base,
      expectedSource: {
        ...base.expectedSource,
        pageNumber: base.expectedSource.pageNumber + 1,
      },
    });
    staleRequests.push({
      ...base,
      expectedSource: {
        ...base.expectedSource,
        pageNumber: Number.MAX_SAFE_INTEGER,
      },
    });
    staleRequests.push({
      ...base,
      expectedSource: {
        ...base.expectedSource,
        bbox: [
          base.expectedSource.bbox[0] + 0.001,
          base.expectedSource.bbox[1],
          base.expectedSource.bbox[2],
          base.expectedSource.bbox[3],
        ],
      },
    });

    const dataMutations: Array<(data: Record<string, unknown>) => void> = [
      (data) => {
        data.type = "different";
      },
      (data) => {
        data.takeoffItemId = (data.takeoffItemId as number) + 1;
      },
      (data) => {
        data.color = "#different";
      },
      (data) => {
        data.vertices = [
          { x: 0.11, y: 0.1 },
          ...(data.vertices as Array<{ x: number; y: number }>).slice(1),
        ];
      },
      (data) => {
        data.holes = [];
      },
      (data) => {
        data.areaSqUnits = (data.areaSqUnits as number) + 1;
      },
      (data) => {
        data.unit = "SM";
      },
      (data) => {
        data.csiCodes = [...(data.csiCodes as string[]), "09 29 00"];
      },
      (data) => {
        data.keywords = [...(data.keywords as string[]), "changed"];
      },
    ];
    for (const mutate of dataMutations) {
      const data = structuredClone(base.expectedSource.data);
      mutate(data);
      staleRequests.push({
        ...base,
        expectedSource: { ...base.expectedSource, data },
      });
    }

    for (const request of staleRequests) {
      const response = await post(request);
      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe("CONFLICT");
      expect(await projectRows(fixture.project.id)).toEqual([fixture.source]);
    }
  });

  it("fails closed on invalid authoritative source/item/geometry/extension states", async () => {
    const hole = {
      vertices: [
        { x: 0.3, y: 0.3 },
        { x: 0.4, y: 0.3 },
        { x: 0.35, y: 0.4 },
      ],
    };
    const cases: Array<{
      options: SeedOptions;
      message?: string;
      request?: Partial<SplitAnnotationRequest>;
    }> = [
      { options: { annotation: { source: "user" } } },
      { options: { data: { type: "linear-polyline" } } },
      { options: { item: { shape: "linear" } } },
      {
        options: { data: { unsupportedWholeGeometryState: true } },
        message: SPLIT_UNSUPPORTED_AREA_DATA_MESSAGE,
      },
      {
        options: { data: { holes: [hole] } },
        message: SPLIT_HOLED_TARGET_MESSAGE,
      },
      {
        options: {
          data: {
            vertices: [
              { x: 0.1, y: 0.1 },
              { x: 0.9, y: 0.9 },
            ],
          },
        },
      },
      {
        options: {
          data: {
            vertices: [
              { x: 0.1, y: 0.1 },
              { x: 0.5, y: 0.5 },
              { x: 0.9, y: 0.9 },
            ],
          },
        },
      },
      {
        options: {
          data: {
            vertices: [
              { x: -0.1, y: 0.1 },
              { x: 0.9, y: 0.1 },
              { x: 0.9, y: 0.9 },
            ],
          },
        },
      },
      {
        // This self-crossing source intentionally yields two positive halves whose areas conserve
        // exactly. Boundary validation must reject it independently of conservation/measurements.
        options: {
          data: {
            vertices: [
              { x: 0.3066556852027976, y: 0.9 },
              { x: 0.22391711388435326, y: 0.47168368487976076 },
              { x: 0.39971649561927536, y: 0.1 },
              { x: 0.9, y: 0.49628349770886593 },
              { x: 0.5190634779919281, y: 0.10233426583402266 },
              { x: 0.1, y: 0.43248437932968864 },
            ],
          },
        },
        request: {
          measurements: {
            leftAreaSqUnits: 19.032284217890397,
            rightAreaSqUnits: 35.231930701663486,
            unit: "SF",
          },
        },
      },
      { options: { annotation: { maxX: 0.8 } } },
      { options: { data: { takeoffItemId: Number.MAX_SAFE_INTEGER } } },
      { options: { data: { color: 7 } } },
      { options: { data: { areaSqUnits: -1 } } },
      { options: { data: { unit: "XX" } } },
      { options: { data: { holes: {} } } },
      { options: { data: { csiCodes: [1] } } },
      { options: { data: { keywords: [1] } } },
    ];

    for (const testCase of cases) {
      const fixture = await seedFixture(testCase.options);
      asUser(fixture.user);
      const response = await post(requestFor(fixture.source, testCase.request));
      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe("CONFLICT");
      if (testCase.message)
        expect(response.body.error.message).toBe(testCase.message);
      expect(await projectRows(fixture.project.id)).toEqual([fixture.source]);
    }
  });

  it("rejects an existing polygon item owned by another project", async () => {
    const foreign = await createWorld();
    const [foreignItem] = await db
      .insert(takeoffItems)
      .values({
        projectId: foreign.project.id,
        name: "Foreign polygon item",
        shape: "polygon",
        color: "#ef4444",
        size: 12,
      })
      .returning();
    const fixture = await seedFixture({
      data: { takeoffItemId: foreignItem.id },
    });
    asUser(fixture.user);

    const response = await post(requestFor(fixture.source));

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe("CONFLICT");
    expect(await projectRows(fixture.project.id)).toEqual([fixture.source]);
  });

  it("rejects no-split lines, excessive source vertices, and inconsistent finite measurements without mutation", async () => {
    const noSplit = await seedFixture();
    asUser(noSplit.user);
    const outsideLine = await post(
      requestFor(noSplit.source, {
        lineA: { x: 0, y: 0 },
        lineB: { x: 1, y: 0 },
      }),
    );
    expect(outsideLine.status).toBe(409);
    expect(await projectRows(noSplit.project.id)).toEqual([noSplit.source]);

    const manyVertices = Array.from({ length: 10_001 }, (_, index) => {
      const angle = (index / 10_001) * Math.PI * 2;
      return { x: 0.5 + Math.cos(angle) * 0.4, y: 0.5 + Math.sin(angle) * 0.4 };
    });
    const excessive = await seedFixture({ data: { vertices: manyVertices } });
    asUser(excessive.user);
    const excessiveResponse = await post(requestFor(excessive.source));
    expect(excessiveResponse.status).toBe(409);
    expect(await projectRows(excessive.project.id)).toEqual([excessive.source]);

    const measurements = await seedFixture();
    asUser(measurements.user);
    for (const pair of [
      { leftAreaSqUnits: 0, rightAreaSqUnits: 32, unit: "SF" as const },
      { leftAreaSqUnits: 31, rightAreaSqUnits: 32, unit: "SF" as const },
    ]) {
      const response = await post(
        requestFor(measurements.source, { measurements: pair }),
      );
      expect(response.status).toBe(409);
      expect(await projectRows(measurements.project.id)).toEqual([
        measurements.source,
      ]);
    }
  });

  it("returns 400 for malformed measurement numbers/units without mutation", async () => {
    const fixture = await seedFixture();
    asUser(fixture.user);
    const base = requestFor(fixture.source);
    for (const measurements of [
      { leftAreaSqUnits: -1, rightAreaSqUnits: 32, unit: "SF" },
      { leftAreaSqUnits: 32, rightAreaSqUnits: 32, unit: "square-feet" },
      { leftAreaSqUnits: null, rightAreaSqUnits: 32, unit: "SF" },
    ]) {
      const response = await post({ ...base, measurements });
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe("VALIDATION");
    }
    const raw = JSON.stringify(base).replace(
      '"leftAreaSqUnits":32',
      '"leftAreaSqUnits":1e400',
    );
    const nonFinite = await readJson(
      await POST(
        new Request("http://test.local/api/annotations/split", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: raw,
        }),
      ),
    );
    expect(nonFinite.status).toBe(400);
    expect(nonFinite.body.error.code).toBe("VALIDATION");
    expect(await projectRows(fixture.project.id)).toEqual([fixture.source]);
  });

  it("serializes identical concurrent requests into one success and one stale conflict", async () => {
    const fixture = await seedFixture();
    asUser(fixture.user);
    const request = requestFor(fixture.source);
    const responses = await Promise.all([post(request), post(request)]);
    expect(responses.map(({ status }) => status).sort()).toEqual([200, 409]);
    const rows = await projectRows(fixture.project.id);
    expect(rows).toHaveLength(2);
    expect(rows.filter(({ id }) => id === fixture.source.id)).toHaveLength(1);
  });

  it("rolls back the left update when right insertion hits a real creator FK fault", async () => {
    const fixture = await seedFixture();
    const actingMember = await createUser(fixture.company.id);
    asUser(actingMember);
    expect(actingMember.companyId).toBe(fixture.company.id);
    expect(actingMember.isRootAdmin).toBe(false);
    await db.delete(users).where(eq(users.id, actingMember.id));

    const before = (await projectRows(fixture.project.id))[0];
    const mutations: string[] = [];
    const mutableDb = db as unknown as {
      transaction: (
        callback: (
          tx: Record<string, (...args: unknown[]) => unknown>,
        ) => Promise<unknown>,
        config?: unknown,
      ) => Promise<unknown>;
    };
    const realTransaction = mutableDb.transaction.bind(mutableDb);
    const transactionSpy = vi
      .spyOn(mutableDb, "transaction")
      .mockImplementation(async (callback, config) =>
        realTransaction(async (tx) => {
          const realUpdate = tx.update.bind(tx);
          const realInsert = tx.insert.bind(tx);
          tx.update = ((table: unknown) => {
            if (table === annotations) mutations.push("update");
            return realUpdate(table);
          }) as typeof tx.update;
          tx.insert = ((table: unknown) => {
            if (table === annotations) mutations.push("insert");
            return realInsert(table);
          }) as typeof tx.insert;
          return callback(tx);
        }, config),
      );
    let response: Awaited<ReturnType<typeof post>>;
    try {
      response = await post(requestFor(before));
    } finally {
      transactionSpy.mockRestore();
    }
    expect(response.status).toBe(500);
    expect(response.body.error).toEqual({
      code: "INTERNAL",
      message: "Internal server error",
    });
    expect(mutations).toEqual(["update", "insert"]);
    expect(await projectRows(fixture.project.id)).toEqual([before]);
  });
});
