// @vitest-environment node
import { randomUUID } from "node:crypto";

import { eq, sql } from "drizzle-orm";
import { Pool } from "pg";
import { describe, expect, inject, it } from "vitest";

import { db } from "@/lib/db";
import {
  labelingSessions,
  labelStudioAssetGrants,
  labelStudioProjectIntents,
} from "@/lib/db/schema";
import {
  activateLabelStudioAssetGrants,
  createLabelStudioGrantSecret,
} from "@/lib/label-studio-asset-grant";
import {
  assertProjectWritable,
  withProjectWrite,
} from "@/server/api/project-write-capability";
import { createWorld, publishDemoFixture } from "@/test/harness";

const dbUp = inject("dbUp") as boolean;
const PROVIDER_BASE_URL = "https://labels.test";
const PROVIDER_INSTANCE_ID = "fs-label-studio-authority-test";
let providerProjectSequence = 81_000;

async function seedProvisioningGrantFor(
  world: Awaited<ReturnType<typeof createWorld>>,
  providerProjectId = ++providerProjectSequence,
) {
  const intentId = randomUUID();
  const grant = createLabelStudioGrantSecret();
  await db.insert(labelStudioProjectIntents).values({
    id: intentId,
    projectId: world.project.id,
    companyId: world.company.id,
    lifecycleEpoch: world.project.lifecycleEpoch,
    marker: `bp-labeling-intent:${intentId}`,
    providerProjectId,
    providerBaseUrl: PROVIDER_BASE_URL,
    providerInstanceId: PROVIDER_INSTANCE_ID,
    state: "cleanup_pending",
  });
  await db.insert(labelStudioAssetGrants).values({
    id: grant.id,
    projectId: world.project.id,
    companyId: world.company.id,
    lifecycleEpoch: world.project.lifecycleEpoch,
    provisioningIntentId: intentId,
    tokenHash: grant.tokenHash,
    snapshotVersionId: "snapshot-version-1",
    state: "provisioning",
  });
  return { ...world, grant, intentId, providerProjectId };
}

async function seedProvisioningGrant(
  providerProjectId = ++providerProjectSequence,
) {
  return seedProvisioningGrantFor(await createWorld(), providerProjectId);
}

async function activateGrant(
  fixture: Awaited<ReturnType<typeof seedProvisioningGrant>>,
) {
  const capability = assertProjectWritable(fixture.project);
  return withProjectWrite(capability, fixture.project.id, async (tx) => {
    const [session] = await tx
      .insert(labelingSessions)
      .values({
        projectId: fixture.project.id,
        companyId: fixture.company.id,
        labelStudioProjectId: fixture.providerProjectId,
        providerBaseUrl: PROVIDER_BASE_URL,
        providerInstanceId: PROVIDER_INSTANCE_ID,
        status: "active",
        provisioningIntentId: fixture.intentId,
      })
      .returning();
    await activateLabelStudioAssetGrants(tx, fixture.intentId, session.id, [
      fixture.grant.id,
    ]);
    await tx
      .delete(labelStudioProjectIntents)
      .where(eq(labelStudioProjectIntents.id, fixture.intentId));
    return session;
  });
}

describe.skipIf(!dbUp)("Label Studio asset-grant database authority", () => {
  it("requires exact intent marker, project owner, lifecycle, and provider binding", async () => {
    const owner = await createWorld();
    const foreign = await createWorld();
    const wrongMarkerId = randomUUID();

    await expect(
      db.insert(labelStudioProjectIntents).values({
        id: wrongMarkerId,
        projectId: owner.project.id,
        companyId: owner.company.id,
        lifecycleEpoch: owner.project.lifecycleEpoch,
        marker: `bp-labeling-intent:${randomUUID()}`,
        providerBaseUrl: PROVIDER_BASE_URL,
        providerInstanceId: PROVIDER_INSTANCE_ID,
        state: "creating",
      }),
    ).rejects.toBeDefined();

    const foreignCompanyId = randomUUID();
    await expect(
      db.insert(labelStudioProjectIntents).values({
        id: foreignCompanyId,
        projectId: owner.project.id,
        companyId: foreign.company.id,
        lifecycleEpoch: owner.project.lifecycleEpoch,
        marker: `bp-labeling-intent:${foreignCompanyId}`,
        providerBaseUrl: PROVIDER_BASE_URL,
        providerInstanceId: PROVIDER_INSTANCE_ID,
        state: "creating",
      }),
    ).rejects.toBeDefined();

    const staleLifecycleId = randomUUID();
    await expect(
      db.insert(labelStudioProjectIntents).values({
        id: staleLifecycleId,
        projectId: owner.project.id,
        companyId: owner.company.id,
        lifecycleEpoch: owner.project.lifecycleEpoch + 1,
        marker: `bp-labeling-intent:${staleLifecycleId}`,
        providerBaseUrl: PROVIDER_BASE_URL,
        providerInstanceId: PROVIDER_INSTANCE_ID,
        state: "creating",
      }),
    ).rejects.toBeDefined();

    const emptyBindingId = randomUUID();
    await expect(
      db.insert(labelStudioProjectIntents).values({
        id: emptyBindingId,
        projectId: owner.project.id,
        companyId: owner.company.id,
        lifecycleEpoch: owner.project.lifecycleEpoch,
        marker: `bp-labeling-intent:${emptyBindingId}`,
        providerBaseUrl: " ",
        providerInstanceId: PROVIDER_INSTANCE_ID,
        state: "creating",
      }),
    ).rejects.toBeDefined();
  });

  it("allows only forward intent transitions and makes learned provider identity immutable", async () => {
    const world = await createWorld();
    const intentId = randomUUID();
    await db.insert(labelStudioProjectIntents).values({
      id: intentId,
      projectId: world.project.id,
      companyId: world.company.id,
      lifecycleEpoch: world.project.lifecycleEpoch,
      marker: `bp-labeling-intent:${intentId}`,
      providerBaseUrl: PROVIDER_BASE_URL,
      providerInstanceId: PROVIDER_INSTANCE_ID,
      state: "creating",
    });

    await db
      .update(labelStudioProjectIntents)
      .set({ state: "create_uncertain" })
      .where(eq(labelStudioProjectIntents.id, intentId));
    await expect(
      db
        .update(labelStudioProjectIntents)
        .set({ state: "creating" })
        .where(eq(labelStudioProjectIntents.id, intentId)),
    ).rejects.toBeDefined();
    await expect(
      db
        .update(labelStudioProjectIntents)
        .set({ state: "cleanup_pending" })
        .where(eq(labelStudioProjectIntents.id, intentId)),
    ).rejects.toBeDefined();

    await db
      .update(labelStudioProjectIntents)
      .set({ state: "cleanup_pending", providerProjectId: 82_001 })
      .where(eq(labelStudioProjectIntents.id, intentId));
    await db
      .update(labelStudioProjectIntents)
      .set({ providerProjectId: 82_001, lastError: "retry" })
      .where(eq(labelStudioProjectIntents.id, intentId));

    await expect(
      db
        .update(labelStudioProjectIntents)
        .set({ providerProjectId: 82_002 })
        .where(eq(labelStudioProjectIntents.id, intentId)),
    ).rejects.toBeDefined();
    await expect(
      db
        .update(labelStudioProjectIntents)
        .set({
          state: "create_uncertain",
          providerProjectId: null,
        })
        .where(eq(labelStudioProjectIntents.id, intentId)),
    ).rejects.toBeDefined();
    await expect(
      db
        .update(labelStudioProjectIntents)
        .set({ providerBaseUrl: "https://replacement-labels.test" })
        .where(eq(labelStudioProjectIntents.id, intentId)),
    ).rejects.toBeDefined();
    await expect(
      db
        .update(labelStudioProjectIntents)
        .set({ providerInstanceId: "fs-replacement" })
        .where(eq(labelStudioProjectIntents.id, intentId)),
    ).rejects.toBeDefined();
  });

  it("scopes provider-project uniqueness to the immutable provider binding", async () => {
    const existing = await seedProvisioningGrant();
    const duplicateOwner = await createWorld();
    const duplicateId = randomUUID();

    await expect(
      db.insert(labelStudioProjectIntents).values({
        id: duplicateId,
        projectId: duplicateOwner.project.id,
        companyId: duplicateOwner.company.id,
        lifecycleEpoch: duplicateOwner.project.lifecycleEpoch,
        marker: `bp-labeling-intent:${duplicateId}`,
        providerProjectId: existing.providerProjectId,
        providerBaseUrl: PROVIDER_BASE_URL,
        providerInstanceId: PROVIDER_INSTANCE_ID,
        state: "cleanup_pending",
      }),
    ).rejects.toBeDefined();

    const differentlyBoundId = randomUUID();
    await expect(
      db.insert(labelStudioProjectIntents).values({
        id: differentlyBoundId,
        projectId: duplicateOwner.project.id,
        companyId: duplicateOwner.company.id,
        lifecycleEpoch: duplicateOwner.project.lifecycleEpoch,
        marker: `bp-labeling-intent:${differentlyBoundId}`,
        providerProjectId: existing.providerProjectId,
        providerBaseUrl: PROVIDER_BASE_URL,
        providerInstanceId: `${PROVIDER_INSTANCE_ID}-replacement`,
        state: "cleanup_pending",
      }),
    ).resolves.toBeDefined();
  });

  it("rejects raw/malformed token material and empty snapshot versions", async () => {
    const fixture = await seedProvisioningGrant();
    const values = {
      projectId: fixture.project.id,
      companyId: fixture.company.id,
      lifecycleEpoch: fixture.project.lifecycleEpoch,
      provisioningIntentId: fixture.intentId,
      state: "provisioning",
    } as const;

    await expect(
      db.insert(labelStudioAssetGrants).values({
        ...values,
        tokenHash: "raw-bearer-token",
        snapshotVersionId: "v2",
      }),
    ).rejects.toBeDefined();
    await expect(
      db.insert(labelStudioAssetGrants).values({
        ...values,
        tokenHash: "b".repeat(64),
        snapshotVersionId: "   ",
      }),
    ).rejects.toBeDefined();
  });

  it("requires the project, company, lifecycle, and provisioning owner to match exactly", async () => {
    const owner = await seedProvisioningGrant();
    const foreign = await createWorld();

    await expect(
      db.insert(labelStudioAssetGrants).values({
        projectId: foreign.project.id,
        companyId: foreign.company.id,
        lifecycleEpoch: foreign.project.lifecycleEpoch,
        provisioningIntentId: owner.intentId,
        tokenHash: "c".repeat(64),
        snapshotVersionId: "foreign-owner-version",
        state: "provisioning",
      }),
    ).rejects.toBeDefined();

    await expect(
      db.insert(labelStudioAssetGrants).values({
        projectId: owner.project.id,
        companyId: owner.company.id,
        lifecycleEpoch: owner.project.lifecycleEpoch + 1,
        provisioningIntentId: owner.intentId,
        tokenHash: "d".repeat(64),
        snapshotVersionId: "stale-lifecycle-version",
        state: "provisioning",
      }),
    ).rejects.toBeDefined();
  });

  it("fences legacy sessions and requires the exact intent/provider witness", async () => {
    const fixture = await seedProvisioningGrant();
    const foreign = await createWorld();

    await expect(
      db.execute(sql`
        INSERT INTO labeling_sessions (
          project_id,
          company_id,
          label_studio_project_id,
          provider_base_url,
          provider_instance_id,
          status
        ) VALUES (
          ${fixture.project.id},
          ${fixture.company.id},
          ${fixture.providerProjectId},
          ${PROVIDER_BASE_URL},
          ${PROVIDER_INSTANCE_ID},
          'active'
        )
      `),
    ).rejects.toBeDefined();

    await expect(
      db.insert(labelingSessions).values({
        projectId: fixture.project.id,
        companyId: fixture.company.id,
        labelStudioProjectId: fixture.providerProjectId + 1,
        providerBaseUrl: PROVIDER_BASE_URL,
        providerInstanceId: PROVIDER_INSTANCE_ID,
        provisioningIntentId: fixture.intentId,
        status: "active",
      }),
    ).rejects.toBeDefined();
    await expect(
      db.insert(labelingSessions).values({
        projectId: fixture.project.id,
        companyId: fixture.company.id,
        labelStudioProjectId: fixture.providerProjectId,
        providerBaseUrl: "https://replacement-labels.test",
        providerInstanceId: PROVIDER_INSTANCE_ID,
        provisioningIntentId: fixture.intentId,
        status: "active",
      }),
    ).rejects.toBeDefined();
    await expect(
      db.insert(labelingSessions).values({
        projectId: foreign.project.id,
        companyId: foreign.company.id,
        labelStudioProjectId: fixture.providerProjectId,
        providerBaseUrl: PROVIDER_BASE_URL,
        providerInstanceId: PROVIDER_INSTANCE_ID,
        provisioningIntentId: fixture.intentId,
        status: "active",
      }),
    ).rejects.toBeDefined();
    await expect(
      db.insert(labelingSessions).values({
        projectId: fixture.project.id,
        companyId: fixture.company.id,
        labelStudioProjectId: fixture.providerProjectId,
        providerBaseUrl: PROVIDER_BASE_URL,
        providerInstanceId: PROVIDER_INSTANCE_ID,
        provisioningIntentId: fixture.intentId,
        status: "retiring",
      }),
    ).rejects.toBeDefined();

    await expect(activateGrant(fixture)).resolves.toEqual(
      expect.objectContaining({
        provisioningIntentId: fixture.intentId,
        providerBaseUrl: PROVIDER_BASE_URL,
        providerInstanceId: PROVIDER_INSTANCE_ID,
      }),
    );
  });

  it("cannot activate a grant onto another same-project provider session", async () => {
    const first = await seedProvisioningGrant(83_001);
    const firstSession = await activateGrant(first);
    const second = await seedProvisioningGrantFor(first, 83_002);

    await expect(
      db
        .update(labelStudioAssetGrants)
        .set({
          provisioningIntentId: null,
          labelingSessionId: firstSession.id,
          state: "active",
        })
        .where(eq(labelStudioAssetGrants.id, second.grant.id)),
    ).rejects.toBeDefined();

    const secondSession = await activateGrant(second);
    expect(secondSession).toEqual(
      expect.objectContaining({
        labelStudioProjectId: 83_002,
        provisioningIntentId: second.intentId,
      }),
    );
  });

  it("rejects a new intent before it can overlap a live provider session", async () => {
    const first = await seedProvisioningGrant();
    await activateGrant(first);
    const second = await createWorld();
    const secondIntentId = randomUUID();
    await db.insert(labelStudioProjectIntents).values({
      id: secondIntentId,
      projectId: second.project.id,
      companyId: second.company.id,
      lifecycleEpoch: second.project.lifecycleEpoch,
      marker: `bp-labeling-intent:${secondIntentId}`,
      providerBaseUrl: PROVIDER_BASE_URL,
      providerInstanceId: PROVIDER_INSTANCE_ID,
      state: "creating",
    });

    await expect(
      db
        .update(labelStudioProjectIntents)
        .set({
          providerProjectId: first.providerProjectId,
          state: "cleanup_pending",
        })
        .where(eq(labelStudioProjectIntents.id, secondIntentId)),
    ).rejects.toMatchObject({
      cause: expect.objectContaining({
        constraint: "label_studio_provider_identity_collision_guard",
      }),
    });

    const [retained] = await db
      .select()
      .from(labelStudioProjectIntents)
      .where(eq(labelStudioProjectIntents.id, secondIntentId));
    expect(retained).toEqual(
      expect.objectContaining({
        providerProjectId: null,
        state: "creating",
      }),
    );
  });

  it("serializes session finalization against a concurrent provider-ID assignment", async () => {
    const sessionOwner = await createWorld();
    const contender = await createWorld();
    const sessionIntentId = randomUUID();
    const contenderIntentId = randomUUID();
    const providerProjectId = 1_500_000_000 + sessionOwner.project.id;
    await db.insert(labelStudioProjectIntents).values([
      {
        id: sessionIntentId,
        projectId: sessionOwner.project.id,
        companyId: sessionOwner.company.id,
        lifecycleEpoch: sessionOwner.project.lifecycleEpoch,
        marker: `bp-labeling-intent:${sessionIntentId}`,
        providerProjectId,
        providerBaseUrl: PROVIDER_BASE_URL,
        providerInstanceId: PROVIDER_INSTANCE_ID,
        state: "cleanup_pending",
      },
      {
        id: contenderIntentId,
        projectId: contender.project.id,
        companyId: contender.company.id,
        lifecycleEpoch: contender.project.lifecycleEpoch,
        marker: `bp-labeling-intent:${contenderIntentId}`,
        providerBaseUrl: PROVIDER_BASE_URL,
        providerInstanceId: PROVIDER_INSTANCE_ID,
        state: "creating",
      },
    ]);

    const suffix = randomUUID();
    const finalizerPool = new Pool({
      connectionString: process.env.DATABASE_URL,
      application_name: `bp-provider-finalizer-${suffix}`,
      max: 1,
    });
    const contenderPool = new Pool({
      connectionString: process.env.DATABASE_URL,
      application_name: `bp-provider-contender-${suffix}`,
      max: 1,
    });
    const finalizerClient = await finalizerPool.connect();
    const contenderClient = await contenderPool.connect();
    let contenderUpdate: Promise<unknown> | undefined;

    try {
      await finalizerClient.query("BEGIN");
      await finalizerClient.query(
        `INSERT INTO labeling_sessions (
           project_id, company_id, label_studio_project_id,
           provider_base_url, provider_instance_id, status,
           provisioning_intent_id
         ) VALUES ($1, $2, $3, $4, $5, 'active', $6)`,
        [
          sessionOwner.project.id,
          sessionOwner.company.id,
          providerProjectId,
          PROVIDER_BASE_URL,
          PROVIDER_INSTANCE_ID,
          sessionIntentId,
        ],
      );
      await finalizerClient.query(
        "DELETE FROM label_studio_project_intents WHERE id = $1",
        [sessionIntentId],
      );

      await contenderClient.query("BEGIN");
      contenderUpdate = contenderClient.query(
        `UPDATE label_studio_project_intents
            SET provider_project_id = $1, state = 'cleanup_pending'
          WHERE id = $2`,
        [providerProjectId, contenderIntentId],
      );
      void contenderUpdate.catch(() => undefined);

      const deadline = Date.now() + 5_000;
      let waiting = false;
      while (Date.now() < deadline) {
        const result = await db.execute(sql`
          SELECT 1
            FROM pg_stat_activity
           WHERE application_name = ${`bp-provider-contender-${suffix}`}
             AND wait_event_type = 'Lock'
             AND wait_event = 'advisory'
           LIMIT 1
        `);
        if (result.rows.length > 0) {
          waiting = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(waiting).toBe(true);

      await finalizerClient.query("COMMIT");
      await expect(contenderUpdate).rejects.toMatchObject({
        constraint: "label_studio_provider_identity_collision_guard",
      });
      await contenderClient.query("ROLLBACK");
    } finally {
      await finalizerClient.query("ROLLBACK").catch(() => undefined);
      await contenderClient.query("ROLLBACK").catch(() => undefined);
      finalizerClient.release();
      contenderClient.release();
      await finalizerPool.end();
      await contenderPool.end();
    }

    const [retained] = await db
      .select()
      .from(labelStudioProjectIntents)
      .where(eq(labelStudioProjectIntents.id, contenderIntentId));
    expect(retained).toEqual(
      expect.objectContaining({
        providerProjectId: null,
        state: "creating",
      }),
    );
    expect(
      await db
        .select()
        .from(labelingSessions)
        .where(eq(labelingSessions.provisioningIntentId, sessionIntentId)),
    ).toHaveLength(1);
  }, 15_000);

  it("allows only provisioning-to-active-to-revoked and keeps authority immutable", async () => {
    const fixture = await seedProvisioningGrant();
    const session = await activateGrant(fixture);

    await expect(
      db
        .update(labelStudioAssetGrants)
        .set({ tokenHash: "e".repeat(64) })
        .where(eq(labelStudioAssetGrants.id, fixture.grant.id)),
    ).rejects.toBeDefined();

    await expect(
      db
        .delete(labelStudioAssetGrants)
        .where(eq(labelStudioAssetGrants.id, fixture.grant.id)),
    ).rejects.toBeDefined();

    await expect(
      db
        .update(labelStudioAssetGrants)
        .set({
          state: "revoked",
          revokedAt: sql`CURRENT_TIMESTAMP`,
          updatedAt: sql`CURRENT_TIMESTAMP`,
        })
        .where(eq(labelStudioAssetGrants.id, fixture.grant.id)),
    ).rejects.toBeDefined();

    await expect(
      db.delete(labelingSessions).where(eq(labelingSessions.id, session.id)),
    ).rejects.toBeDefined();
    await expect(
      db
        .update(labelingSessions)
        .set({ labelStudioUrl: "https://labels.test/changed" })
        .where(eq(labelingSessions.id, session.id)),
    ).rejects.toBeDefined();
    await db
      .update(labelingSessions)
      .set({ status: "retiring", updatedAt: sql`CURRENT_TIMESTAMP` })
      .where(eq(labelingSessions.id, session.id));
    await db
      .update(labelStudioAssetGrants)
      .set({
        state: "revoked",
        revokedAt: sql`CURRENT_TIMESTAMP`,
        updatedAt: sql`CURRENT_TIMESTAMP`,
      })
      .where(eq(labelStudioAssetGrants.id, fixture.grant.id));

    await expect(
      db
        .update(labelStudioAssetGrants)
        .set({ state: "active", revokedAt: null })
        .where(eq(labelStudioAssetGrants.id, fixture.grant.id)),
    ).rejects.toBeDefined();

    await db
      .delete(labelStudioAssetGrants)
      .where(eq(labelStudioAssetGrants.id, fixture.grant.id));
    await expect(
      db.delete(labelingSessions).where(eq(labelingSessions.id, session.id)),
    ).rejects.toBeDefined();
    await db
      .update(labelingSessions)
      .set({
        retirementLeaseToken: randomUUID(),
        retirementLeaseExpiresAt: new Date(Date.now() + 60_000),
        retirementAttemptCount: sql`${labelingSessions.retirementAttemptCount} + 1`,
        updatedAt: sql`CURRENT_TIMESTAMP`,
      })
      .where(eq(labelingSessions.id, session.id));
    await db
      .delete(labelingSessions)
      .where(eq(labelingSessions.id, session.id));
  });

  it("makes session and provider-intent ownership immutable", async () => {
    const fixture = await seedProvisioningGrant();
    await expect(
      db
        .update(labelStudioProjectIntents)
        .set({ lifecycleEpoch: fixture.project.lifecycleEpoch + 1 })
        .where(eq(labelStudioProjectIntents.id, fixture.intentId)),
    ).rejects.toBeDefined();
    await expect(
      db
        .update(labelStudioProjectIntents)
        .set({ providerProjectId: fixture.providerProjectId + 1 })
        .where(eq(labelStudioProjectIntents.id, fixture.intentId)),
    ).rejects.toBeDefined();

    const session = await activateGrant(fixture);
    await expect(
      db
        .update(labelingSessions)
        .set({ companyId: fixture.company.id + 1 })
        .where(eq(labelingSessions.id, session.id)),
    ).rejects.toBeDefined();
    await expect(
      db
        .update(labelingSessions)
        .set({ providerInstanceId: "fs-replacement" })
        .where(eq(labelingSessions.id, session.id)),
    ).rejects.toBeDefined();
  });

  it("rejects direct publication while any Label Studio authority witness exists", async () => {
    const provisioning = await seedProvisioningGrant();
    await expect(
      publishDemoFixture(provisioning.project.id),
    ).rejects.toBeDefined();

    const active = await seedProvisioningGrant();
    await activateGrant(active);
    await expect(publishDemoFixture(active.project.id)).rejects.toBeDefined();
  });
});
