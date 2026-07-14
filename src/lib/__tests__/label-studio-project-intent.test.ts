// @vitest-environment node
import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, inject, it, vi } from "vitest";

const lsMocks = vi.hoisted(() => ({
  deleteProject: vi.fn(),
  findProjectsByExactDescription: vi.fn(),
}));
vi.mock("@/lib/label-studio", () => lsMocks);

import { db } from "@/lib/db";
import {
  labelStudioAssetGrants,
  labelStudioProjectIntents,
} from "@/lib/db/schema";
import { reconcileLabelStudioProjectIntent } from "@/lib/label-studio-project-intent";
import { createWorld } from "@/test/harness";
import { eq } from "drizzle-orm";

const dbUp = inject("dbUp") as boolean;
const PROVIDER = {
  baseUrl: "https://labels.test",
  instanceId: "intent-reconciliation-provider",
} as const;

type SeedOptions =
  | { providerProjectId: number; state: "cleanup_pending" }
  | { providerProjectId: null; state: "create_uncertain" };

async function seedIntent(options: SeedOptions) {
  const { company, project } = await createWorld();
  const intentId = randomUUID();
  const grantId = randomUUID();
  const marker = `bp-labeling-intent:${intentId}`;
  await db.insert(labelStudioProjectIntents).values({
    id: intentId,
    projectId: project.id,
    companyId: company.id,
    lifecycleEpoch: project.lifecycleEpoch,
    marker,
    providerProjectId: options.providerProjectId,
    providerBaseUrl: PROVIDER.baseUrl,
    providerInstanceId: PROVIDER.instanceId,
    state: options.state,
    nextAttemptAt: new Date(0),
  });
  await db.insert(labelStudioAssetGrants).values({
    id: grantId,
    projectId: project.id,
    companyId: company.id,
    lifecycleEpoch: project.lifecycleEpoch,
    provisioningIntentId: intentId,
    tokenHash: randomUUID().replaceAll("-", "").repeat(2),
    snapshotVersionId: `snapshot-${grantId}`,
    state: "provisioning",
  });
  return {
    intentId,
    grantId,
    marker,
    providerProjectId: options.providerProjectId,
  };
}

const intentById = (id: string) =>
  db
    .select()
    .from(labelStudioProjectIntents)
    .where(eq(labelStudioProjectIntents.id, id));

const grantById = (id: string) =>
  db
    .select()
    .from(labelStudioAssetGrants)
    .where(eq(labelStudioAssetGrants.id, id));

async function makeDue(id: string): Promise<void> {
  await db
    .update(labelStudioProjectIntents)
    .set({ nextAttemptAt: new Date(0) })
    .where(eq(labelStudioProjectIntents.id, id));
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe.skipIf(!dbUp)(
  "Label Studio project intent grant reconciliation",
  () => {
    it("commits a revoked grant before known-provider DELETE and removes both witnesses only afterward", async () => {
      const seeded = await seedIntent({
        providerProjectId: 73001,
        state: "cleanup_pending",
      });
      let providerWitness:
        | {
            grantState: string | undefined;
            revokedAt: Date | null | undefined;
            attemptCount: number | undefined;
            leased: boolean;
          }
        | undefined;
      lsMocks.deleteProject.mockImplementationOnce(async () => {
        const [intent] = await intentById(seeded.intentId);
        const [grant] = await grantById(seeded.grantId);
        providerWitness = {
          grantState: grant?.state,
          revokedAt: grant?.revokedAt,
          attemptCount: intent?.attemptCount,
          leased:
            intent?.leaseToken !== null && intent?.leaseExpiresAt !== null,
        };
      });

      await expect(
        reconcileLabelStudioProjectIntent(seeded.intentId),
      ).resolves.toBe("cleaned");

      expect(providerWitness).toEqual({
        grantState: "revoked",
        revokedAt: expect.any(Date),
        attemptCount: 1,
        leased: true,
      });
      expect(lsMocks.deleteProject).toHaveBeenCalledExactlyOnceWith(
        PROVIDER,
        73001,
      );
      expect(await grantById(seeded.grantId)).toHaveLength(0);
      expect(await intentById(seeded.intentId)).toHaveLength(0);
    });

    it("retains revoked grant + retry owner on provider failure, then an idempotent 404 retry deletes both", async () => {
      const seeded = await seedIntent({
        providerProjectId: 73002,
        state: "cleanup_pending",
      });
      const providerError = new Error("provider timeout");
      lsMocks.deleteProject.mockImplementationOnce(async () => {
        const [grant] = await grantById(seeded.grantId);
        expect(grant).toEqual(
          expect.objectContaining({
            state: "revoked",
            revokedAt: expect.any(Date),
          }),
        );
        throw providerError;
      });

      await expect(
        reconcileLabelStudioProjectIntent(seeded.intentId),
      ).rejects.toBe(providerError);

      expect(await grantById(seeded.grantId)).toEqual([
        expect.objectContaining({
          state: "revoked",
          revokedAt: expect.any(Date),
        }),
      ]);
      expect(await intentById(seeded.intentId)).toEqual([
        expect.objectContaining({
          state: "cleanup_pending",
          attemptCount: 1,
          consecutiveFailures: 1,
          leaseToken: null,
          leaseExpiresAt: null,
          lastError: "provider timeout",
        }),
      ]);

      await makeDue(seeded.intentId);
      // deleteProject's production contract normalizes a provider 404 to success. A resolved mock
      // pins the reconciler side of that idempotent boundary after the ambiguous first DELETE.
      lsMocks.deleteProject.mockResolvedValueOnce(undefined);
      await expect(
        reconcileLabelStudioProjectIntent(seeded.intentId),
      ).resolves.toBe("cleaned");
      expect(lsMocks.deleteProject).toHaveBeenCalledTimes(2);
      expect(await grantById(seeded.grantId)).toHaveLength(0);
      expect(await intentById(seeded.intentId)).toHaveLength(0);
    });

    it("revokes before marker search, quarantines contradictory matches, and durably owns one match before delete", async () => {
      const seeded = await seedIntent({
        providerProjectId: null,
        state: "create_uncertain",
      });
      lsMocks.findProjectsByExactDescription.mockImplementationOnce(
        async () => {
          const [grant] = await grantById(seeded.grantId);
          expect(grant).toEqual(
            expect.objectContaining({
              state: "revoked",
              revokedAt: expect.any(Date),
            }),
          );
          return [];
        },
      );

      await expect(
        reconcileLabelStudioProjectIntent(seeded.intentId),
      ).resolves.toBe("pending");
      expect(
        lsMocks.findProjectsByExactDescription,
      ).toHaveBeenCalledExactlyOnceWith(PROVIDER, seeded.marker);
      expect(lsMocks.deleteProject).not.toHaveBeenCalled();
      expect(await grantById(seeded.grantId)).toEqual([
        expect.objectContaining({
          state: "revoked",
          revokedAt: expect.any(Date),
        }),
      ]);
      expect(await intentById(seeded.intentId)).toEqual([
        expect.objectContaining({
          state: "create_uncertain",
          attemptCount: 1,
          consecutiveFailures: 0,
          leaseToken: null,
          leaseExpiresAt: null,
          lastError: null,
        }),
      ]);

      await makeDue(seeded.intentId);
      lsMocks.findProjectsByExactDescription.mockResolvedValueOnce([
        { id: 73003 },
        { id: 73004 },
      ]);
      await expect(
        reconcileLabelStudioProjectIntent(seeded.intentId),
      ).rejects.toThrow(
        "Label Studio marker resolved to multiple provider projects",
      );
      expect(lsMocks.deleteProject).not.toHaveBeenCalled();
      expect(await intentById(seeded.intentId)).toEqual([
        expect.objectContaining({
          providerProjectId: null,
          state: "create_uncertain",
          consecutiveFailures: 1,
          leaseToken: null,
          leaseExpiresAt: null,
        }),
      ]);

      await makeDue(seeded.intentId);
      lsMocks.findProjectsByExactDescription.mockResolvedValueOnce([
        { id: 73003 },
      ]);
      let durableIdentitySeen = false;
      lsMocks.deleteProject.mockImplementationOnce(async () => {
        expect(await intentById(seeded.intentId)).toEqual([
          expect.objectContaining({
            providerProjectId: 73003,
            state: "cleanup_pending",
            leaseToken: expect.any(String),
            leaseExpiresAt: expect.any(Date),
          }),
        ]);
        durableIdentitySeen = true;
      });
      await expect(
        reconcileLabelStudioProjectIntent(seeded.intentId),
      ).resolves.toBe("cleaned");
      expect(durableIdentitySeen).toBe(true);
      expect(lsMocks.deleteProject).toHaveBeenCalledExactlyOnceWith(
        PROVIDER,
        73003,
      );
      expect(await grantById(seeded.grantId)).toHaveLength(0);
      expect(await intentById(seeded.intentId)).toHaveLength(0);
    });
  },
);
