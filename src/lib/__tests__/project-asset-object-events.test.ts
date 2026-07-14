// @vitest-environment node
import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  inject,
  it,
  vi,
} from "vitest";

const sqs = vi.hoisted(() => {
  class ReceiveMessageCommand {
    readonly kind = "receive";
    constructor(readonly input: Record<string, unknown>) {}
  }

  class DeleteMessageCommand {
    readonly kind = "delete";
    constructor(readonly input: Record<string, unknown>) {}
  }

  const send = vi.fn();
  return {
    send,
    ReceiveMessageCommand,
    DeleteMessageCommand,
    SQSClient: class {
      send = send;
    },
  };
});

vi.mock("@aws-sdk/client-sqs", () => ({
  DeleteMessageCommand: sqs.DeleteMessageCommand,
  ReceiveMessageCommand: sqs.ReceiveMessageCommand,
  SQSClient: sqs.SQSClient,
}));

import { db } from "@/lib/db";
import { projectAssetDeletions } from "@/lib/db/schema";
import {
  drainProjectAssetObjectEvents,
  retiredProjectPathFromObjectEvent,
} from "@/lib/project-asset-object-events";
import { projectUploadStagingKey } from "@/lib/project-upload-authority";

const dbUp = inject("dbUp") as boolean;
const QUEUE_URL = "https://sqs.us-east-1.amazonaws.com/000000000000/assets";
const originalQueueUrl = process.env.PROJECT_ASSET_EVENT_QUEUE_URL;
const seededDeletionIds = new Set<string>();

interface SeedOverrides {
  storageRoot?: string;
  status?: "pending" | "watching" | "completed";
  phase?: "purge" | "invalidate" | "verify" | "watch" | "complete";
  completedAt?: Date | null;
  leaseToken?: string | null;
  leaseExpiresAt?: Date | null;
  objectEventGeneration?: number;
  lastReconciledEventGeneration?: number;
}

function newStorageRoot(): string {
  return `event-test-${randomUUID().slice(0, 8)}/${randomUUID()
    .replaceAll("-", "")
    .slice(0, 20)}`;
}

function objectCreatedEventForKey(key: string) {
  return {
    detail: {
      object: {
        key: encodeURIComponent(key).replaceAll("%20", "+"),
      },
    },
  };
}

function objectCreatedEvent(storageRoot: string, filename = "plan set.pdf") {
  return objectCreatedEventForKey(
    projectUploadStagingKey(storageRoot, filename, 0),
  );
}

function finalObjectCreatedEvent(
  storageRoot: string,
  objectKey = "pages/page_0001.png",
) {
  return objectCreatedEventForKey(`${storageRoot}/${objectKey}`);
}

function sqsMessage(
  storageRoot: string,
  receiptHandle: string,
  filename?: string,
  namespace: "staging" | "final" = "staging",
) {
  return {
    MessageId: `message-${receiptHandle}`,
    ReceiptHandle: receiptHandle,
    Body: JSON.stringify(
      namespace === "staging"
        ? objectCreatedEvent(storageRoot, filename)
        : finalObjectCreatedEvent(storageRoot, filename),
    ),
  };
}

async function seedDeletion(overrides: SeedOverrides = {}) {
  const [row] = await db
    .insert(projectAssetDeletions)
    .values({
      projectPublicId: randomUUID(),
      companyId: 92_001,
      storageRoot: overrides.storageRoot ?? newStorageRoot(),
      lifecycleEpoch: 5,
      status: overrides.status ?? "pending",
      phase: overrides.phase ?? "purge",
      completedAt: overrides.completedAt ?? null,
      leaseToken: overrides.leaseToken ?? null,
      leaseExpiresAt: overrides.leaseExpiresAt ?? null,
      objectEventGeneration: overrides.objectEventGeneration ?? 0,
      lastReconciledEventGeneration:
        overrides.lastReconciledEventGeneration ?? 0,
      nextAttemptAt: new Date("2099-01-01T00:00:00.000Z"),
    })
    .returning();
  seededDeletionIds.add(row.id);
  return row;
}

async function readDeletion(id: string) {
  const [row] = await db
    .select()
    .from(projectAssetDeletions)
    .where(eq(projectAssetDeletions.id, id));
  expect(row).toBeDefined();
  return row;
}

function mockSqsBatch(
  messages: Array<{
    MessageId: string;
    ReceiptHandle?: string;
    Body: string;
  }>,
  beforeDelete?: (
    command: InstanceType<typeof sqs.DeleteMessageCommand>,
  ) => Promise<void>,
): void {
  mockSqsBatches([messages], beforeDelete);
}

function mockSqsBatches(
  batches: Array<
    Array<{
      MessageId: string;
      ReceiptHandle?: string;
      Body: string;
    }>
  >,
  beforeDelete?: (
    command: InstanceType<typeof sqs.DeleteMessageCommand>,
  ) => Promise<void>,
): void {
  let batchIndex = 0;
  sqs.send.mockImplementation(async (command: { kind?: string }) => {
    if (command instanceof sqs.ReceiveMessageCommand) {
      return { Messages: batches[batchIndex++] ?? [] };
    }
    if (command instanceof sqs.DeleteMessageCommand) {
      await beforeDelete?.(command);
      return {};
    }
    throw new Error(`Unexpected SQS command: ${command.kind ?? "unknown"}`);
  });
}

beforeEach(() => {
  process.env.PROJECT_ASSET_EVENT_QUEUE_URL = QUEUE_URL;
  sqs.send.mockReset();
  seededDeletionIds.clear();
});

afterEach(async () => {
  vi.restoreAllMocks();
  if (originalQueueUrl === undefined) {
    delete process.env.PROJECT_ASSET_EVENT_QUEUE_URL;
  } else {
    process.env.PROJECT_ASSET_EVENT_QUEUE_URL = originalQueueUrl;
  }
  if (!dbUp) return;
  for (const id of seededDeletionIds) {
    await db
      .delete(projectAssetDeletions)
      .where(eq(projectAssetDeletions.id, id));
  }
});

describe("retiredProjectPathFromObjectEvent", () => {
  it("parses the canonical encoded staging key and S3 plus-encoded spaces", () => {
    const storageRoot = "tenant-blue/0123456789abcdef0123";

    expect(
      retiredProjectPathFromObjectEvent(objectCreatedEvent(storageRoot)),
    ).toBe(storageRoot);
  });

  it("parses a canonical final-project object below the project root", () => {
    const storageRoot = "tenant-blue/0123456789abcdef0123";

    expect(
      retiredProjectPathFromObjectEvent(
        finalObjectCreatedEvent(storageRoot, "pages/plan set.png"),
      ),
    ).toBe(storageRoot);
  });

  it.each([
    ["missing detail", {}],
    ["missing key", { detail: { object: {} } }],
    ["malformed URI encoding", { detail: { object: { key: "%E0%A4%A" } } }],
    [
      "incomplete final-project key",
      {
        detail: {
          object: { key: "tenant-blue/0123456789abcdef0123" },
        },
      },
    ],
    [
      "incomplete staging key",
      {
        detail: {
          object: { key: "_bp-staging/tenant-blue/0123456789abcdef0123" },
        },
      },
    ],
    [
      "unsafe staging company namespace",
      {
        detail: {
          object: {
            key: "_bp-staging/Tenant/0123456789abcdef0123/000_plan.pdf",
          },
        },
      },
    ],
    [
      "reserved staging company namespace",
      {
        detail: {
          object: {
            key: "_bp-staging/models/0123456789abcdef0123/000_plan.pdf",
          },
        },
      },
    ],
    [
      "reserved final company namespace",
      {
        detail: {
          object: {
            key: "models/0123456789abcdef0123/model.tar.gz",
          },
        },
      },
    ],
    [
      "noncanonical staging project identity",
      {
        detail: {
          object: {
            key: "_bp-staging/tenant-blue/0123456789abcdef012Z/000_plan.pdf",
          },
        },
      },
    ],
    [
      "noncanonical final project identity",
      {
        detail: {
          object: {
            key: "tenant-blue/0123456789abcdef012Z/original.pdf",
          },
        },
      },
    ],
    [
      "empty object-key segment",
      {
        detail: {
          object: {
            key: "tenant-blue/0123456789abcdef0123/pages//page_0001.png",
          },
        },
      },
    ],
    [
      "dot object-key segment",
      {
        detail: {
          object: {
            key: "tenant-blue/0123456789abcdef0123/../other.png",
          },
        },
      },
    ],
  ])("ignores %s", (_label, event) => {
    expect(retiredProjectPathFromObjectEvent(event)).toBeNull();
  });
});

describe.skipIf(!dbUp)("project asset object-event drain", () => {
  it("durably reopens a terminal tombstone before acknowledging its message", async () => {
    const completedAt = new Date("2026-07-01T00:00:00.000Z");
    const deletion = await seedDeletion({
      status: "completed",
      phase: "complete",
      completedAt,
      objectEventGeneration: 8,
      lastReconciledEventGeneration: 8,
    });
    let rowAtDelete: Awaited<ReturnType<typeof readDeletion>> | undefined;
    mockSqsBatch(
      [sqsMessage(deletion.storageRoot, "receipt-terminal")],
      async () => {
        rowAtDelete = await readDeletion(deletion.id);
      },
    );

    await expect(drainProjectAssetObjectEvents(1)).resolves.toEqual({
      received: 1,
      awakened: 1,
      failed: 0,
    });

    expect(rowAtDelete).toMatchObject({
      status: "watching",
      phase: "watch",
      completedAt,
      objectEventGeneration: 9,
      lastReconciledEventGeneration: 8,
      leaseToken: null,
      leaseExpiresAt: null,
    });
    expect(rowAtDelete!.nextAttemptAt.getTime()).toBeLessThanOrEqual(
      Date.now(),
    );
    const deletes = sqs.send.mock.calls
      .map(([command]) => command)
      .filter(
        (command) => command instanceof sqs.DeleteMessageCommand,
      ) as Array<InstanceType<typeof sqs.DeleteMessageCommand>>;
    expect(deletes).toHaveLength(1);
    expect(deletes[0]?.input).toEqual({
      QueueUrl: QUEUE_URL,
      ReceiptHandle: "receipt-terminal",
    });
  });

  it("increments the event generation during an active lease without stealing it", async () => {
    const leaseToken = randomUUID();
    const leaseExpiresAt = new Date("2099-01-01T00:00:00.000Z");
    const deletion = await seedDeletion({
      leaseToken,
      leaseExpiresAt,
      objectEventGeneration: 3,
      lastReconciledEventGeneration: 2,
    });
    mockSqsBatch([
      sqsMessage(deletion.storageRoot, "receipt-leased", undefined, "final"),
    ]);

    await expect(drainProjectAssetObjectEvents(1)).resolves.toEqual({
      received: 1,
      awakened: 1,
      failed: 0,
    });

    expect(await readDeletion(deletion.id)).toMatchObject({
      status: "pending",
      phase: "purge",
      objectEventGeneration: 4,
      lastReconciledEventGeneration: 2,
      leaseToken,
      leaseExpiresAt,
    });
  });

  it("leaves a message unacknowledged when the durable DB wake fails", async () => {
    const storageRoot = newStorageRoot();
    mockSqsBatch([sqsMessage(storageRoot, "receipt-db-failure")]);
    vi.spyOn(db, "transaction").mockRejectedValueOnce(
      new Error("simulated durable wake failure"),
    );

    await expect(drainProjectAssetObjectEvents(1)).resolves.toEqual({
      received: 1,
      awakened: 0,
      failed: 1,
    });

    expect(
      sqs.send.mock.calls.some(
        ([command]) => command instanceof sqs.DeleteMessageCommand,
      ),
    ).toBe(false);
  });

  it("does not wake durable state when a delivery has no receipt handle", async () => {
    const deletion = await seedDeletion({ objectEventGeneration: 6 });
    mockSqsBatch([
      {
        MessageId: "message-no-receipt",
        Body: JSON.stringify(finalObjectCreatedEvent(deletion.storageRoot)),
      },
    ]);

    await expect(drainProjectAssetObjectEvents(1)).resolves.toEqual({
      received: 1,
      awakened: 0,
      failed: 1,
    });

    expect(await readDeletion(deletion.id)).toMatchObject({
      objectEventGeneration: 6,
    });
    expect(
      sqs.send.mock.calls.some(
        ([command]) => command instanceof sqs.DeleteMessageCommand,
      ),
    ).toBe(false);
  });

  it("acknowledges a canonical event with no tombstone without counting it as awakened", async () => {
    const storageRoot = newStorageRoot();
    mockSqsBatch([sqsMessage(storageRoot, "receipt-no-tombstone")]);

    await expect(drainProjectAssetObjectEvents(1)).resolves.toEqual({
      received: 1,
      awakened: 0,
      failed: 0,
    });

    expect(
      sqs.send.mock.calls.filter(
        ([command]) => command instanceof sqs.DeleteMessageCommand,
      ),
    ).toHaveLength(1);
  });

  it("rechecks an absent tombstone in a later batch of the same drain", async () => {
    const storageRoot = newStorageRoot();
    let deletion: Awaited<ReturnType<typeof seedDeletion>> | undefined;
    mockSqsBatches(
      [
        [sqsMessage(storageRoot, "receipt-before-delete")],
        [sqsMessage(storageRoot, "receipt-after-delete", undefined, "final")],
      ],
      async (command) => {
        if (
          command.input.ReceiptHandle === "receipt-before-delete" &&
          !deletion
        ) {
          deletion = await seedDeletion({
            storageRoot,
            status: "completed",
            phase: "complete",
            completedAt: new Date("2026-07-01T00:00:00.000Z"),
            objectEventGeneration: 4,
            lastReconciledEventGeneration: 4,
          });
        }
      },
    );

    await expect(drainProjectAssetObjectEvents(2)).resolves.toEqual({
      received: 2,
      awakened: 1,
      failed: 0,
    });

    expect(await readDeletion(deletion!.id)).toMatchObject({
      status: "watching",
      phase: "watch",
      objectEventGeneration: 5,
      lastReconciledEventGeneration: 4,
    });
  });

  it("coalesces concurrent staging and final events for one project within one batch", async () => {
    const completedAt = new Date("2026-07-01T00:00:00.000Z");
    const deletion = await seedDeletion({
      status: "completed",
      phase: "complete",
      completedAt,
      objectEventGeneration: 11,
      lastReconciledEventGeneration: 11,
    });
    mockSqsBatch([
      sqsMessage(deletion.storageRoot, "receipt-duplicate-1"),
      sqsMessage(
        deletion.storageRoot,
        "receipt-duplicate-2",
        "thumbnails/page_0001.png",
        "final",
      ),
    ]);

    await expect(drainProjectAssetObjectEvents(1)).resolves.toEqual({
      received: 2,
      awakened: 1,
      failed: 0,
    });

    expect(await readDeletion(deletion.id)).toMatchObject({
      status: "watching",
      phase: "watch",
      completedAt,
      objectEventGeneration: 12,
      lastReconciledEventGeneration: 11,
    });
    expect(
      sqs.send.mock.calls.filter(
        ([command]) => command instanceof sqs.DeleteMessageCommand,
      ),
    ).toHaveLength(2);
  });

  it("advances the generation again for the same project in a later batch", async () => {
    const completedAt = new Date("2026-07-01T00:00:00.000Z");
    const deletion = await seedDeletion({
      status: "completed",
      phase: "complete",
      completedAt,
      objectEventGeneration: 11,
      lastReconciledEventGeneration: 11,
    });
    mockSqsBatches([
      [sqsMessage(deletion.storageRoot, "receipt-later-1")],
      [
        sqsMessage(
          deletion.storageRoot,
          "receipt-later-2",
          "thumbnails/page_0001.png",
          "final",
        ),
      ],
    ]);

    await expect(drainProjectAssetObjectEvents(2)).resolves.toEqual({
      received: 2,
      awakened: 2,
      failed: 0,
    });

    expect(await readDeletion(deletion.id)).toMatchObject({
      status: "watching",
      phase: "watch",
      completedAt,
      objectEventGeneration: 13,
      lastReconciledEventGeneration: 11,
    });
    expect(
      sqs.send.mock.calls.filter(
        ([command]) => command instanceof sqs.DeleteMessageCommand,
      ),
    ).toHaveLength(2);
  });
});
