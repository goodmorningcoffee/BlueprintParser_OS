import { readFileSync } from "node:fs";
import { readMigrationFiles } from "drizzle-orm/migrator";

export const MIGRATIONS_FOLDER = "./drizzle";
export const P2_DURABLE_CHECKPOINT_TAG = "0032_chat_global_nullable_project";
export const P2_PRE_CUTOVER_TAG = "0036_project_asset_object_event_generation";
export const P2_BOUNDARY_TAG = "0037_label_studio_asset_grants";
export const P2_CURRENT_TAG = "0038_label_studio_session_retirements";

export function localMigrationContract(folder = MIGRATIONS_FOLDER) {
  const migrations = readMigrationFiles({ migrationsFolder: folder });
  const journal = JSON.parse(
    readFileSync(`${folder}/meta/_journal.json`, "utf8"),
  );
  const entries = journal.entries.map((entry, index) => ({
    ...entry,
    hash: migrations[index]?.hash,
  }));
  if (
    entries.length !== migrations.length ||
    entries.some((entry) => typeof entry.hash !== "string")
  ) {
    throw new Error("Migration journal and SQL files are out of sync");
  }
  return { entries, latest: entries.at(-1) };
}

export async function appliedMigrationContract(client) {
  const relation = await client.query(
    "SELECT to_regclass('drizzle.__drizzle_migrations') AS relation",
  );
  if (!relation.rows[0]?.relation) return [];
  const result = await client.query(
    `SELECT hash, created_at
       FROM drizzle.__drizzle_migrations
      ORDER BY created_at ASC`,
  );
  return result.rows.map((row) => ({
    hash: row.hash,
    when: Number(row.created_at),
  }));
}

function formatApplied(applied) {
  const latest = applied.at(-1);
  return latest
    ? `${applied.length} rows ending ${latest.when}/${latest.hash}`
    : "unmigrated";
}

function matches(entry, applied) {
  return (
    !!entry &&
    !!applied &&
    entry.when === applied.when &&
    entry.hash === applied.hash
  );
}

function historyMatches(expected, applied) {
  return (
    expected.length === applied.length &&
    expected.every((entry, index) => matches(entry, applied[index]))
  );
}

export function assertSchemaCurrent(local, applied) {
  if (!local.latest) throw new Error("No local migrations found");
  if (!historyMatches(local.entries, applied)) {
    throw new Error(
      `Database schema history is not exactly current for this image: expected ${local.entries.length} ` +
        `ordered rows through ${local.latest.tag} ${local.latest.when}/${local.latest.hash}, ` +
        `found ${formatApplied(applied)}. ` +
        "Application and worker startup never run migrations; use the explicit singleton cutover workflow.",
    );
  }
}

export function assertP2CutoverStart(local, applied) {
  const { durableCheckpoint } = assertP2LocalMigrationContract(local);
  const allowed = local.entries.filter(
    (entry) =>
      entry.idx >= durableCheckpoint.idx && entry.idx <= local.latest.idx,
  );
  const matchingPrefix = allowed.find((entry) =>
    matches(entry, applied.at(-1)),
  );
  const expectedHistory = matchingPrefix
    ? local.entries.slice(0, matchingPrefix.idx + 1)
    : [];
  if (!matchingPrefix || !historyMatches(expectedHistory, applied)) {
    throw new Error(
      `P2 cutover requires an exact full-history prefix from ${P2_DURABLE_CHECKPOINT_TAG} through ${P2_CURRENT_TAG}; found ${formatApplied(applied)}`,
    );
  }
}

export function assertP2LocalMigrationContract(local) {
  const latest = local.latest;
  if (latest?.tag !== P2_CURRENT_TAG) {
    throw new Error(
      `The P2 cutover runner is pinned to ${P2_CURRENT_TAG}; found ${latest?.tag ?? "no migration"}`,
    );
  }
  const durableCheckpoint = local.entries.find(
    (entry) => entry.tag === P2_DURABLE_CHECKPOINT_TAG,
  );
  const boundary = local.entries.find((entry) => entry.tag === P2_BOUNDARY_TAG);
  if (!durableCheckpoint || !boundary) {
    throw new Error(
      "The P2 migration boundary is incomplete in the local journal",
    );
  }
  return { durableCheckpoint, boundary };
}

export async function assertEmptyDatabaseBootstrapStart(client, local, applied) {
  if (historyMatches(local.entries, applied)) {
    return;
  }
  if (applied.length !== 0) {
    throw new Error(
      `Empty-database bootstrap requires zero applied migrations or the exact current history for an idempotent retry; found ${formatApplied(applied)}`,
    );
  }
  const publicObjects = await client.query(
    `SELECT pg_catalog.pg_describe_object(classid, objid, objsubid) AS description
       FROM pg_catalog.pg_depend
      WHERE refclassid = 'pg_catalog.pg_namespace'::pg_catalog.regclass
        AND refobjid = 'public'::pg_catalog.regnamespace
      ORDER BY classid, objid, objsubid
      LIMIT 1`,
  );
  if (publicObjects.rows.length > 0) {
    throw new Error(
      `Empty-database bootstrap refuses an existing public object (${publicObjects.rows[0].description})`,
    );
  }
}

export async function assertStrictEmptyDatabaseBootstrapStart(
  client,
  local,
  applied,
) {
  if (applied.length !== 0) {
    throw new Error(
      `An unarmed empty-database bootstrap requires zero applied migrations; found ${formatApplied(applied)}. Exact-current history is admitted only by an armed retry witness.`,
    );
  }
  await assertEmptyDatabaseBootstrapStart(client, local, applied);
}

export async function assertLegacyStorageNamespaces(client) {
  const invalid = await client.query(
    `SELECT id, data_key
       FROM companies
      WHERE data_key !~ '^[a-z0-9-]+$'
         OR data_key IN ('_bp-staging', '_bp-public', 'models', 'tmp', 'config', 'csi-databases')
      ORDER BY id
      LIMIT 1`,
  );
  if (invalid.rows.length > 0) {
    throw new Error(
      `P2 cutover requires every legacy companies.data_key to be a valid, non-reserved storage namespace; company ${invalid.rows[0].id} uses ${invalid.rows[0].data_key}`,
    );
  }
  const invalidProject = await client.query(
    `SELECT p.id, p.data_url, c.data_key
       FROM projects p
       LEFT JOIN companies c ON c.id = p.company_id
      WHERE c.id IS NULL
         OR p.data_url !~ ('^' || c.data_key || '/[a-f0-9]{20}$')
      ORDER BY p.id
      LIMIT 1`,
  );
  if (invalidProject.rows.length > 0) {
    throw new Error(
      `P2 cutover requires every legacy projects.data_url to match its company storage namespace; project ${invalidProject.rows[0].id} uses ${invalidProject.rows[0].data_url}`,
    );
  }
}

export async function assertLegacyLabelingRowsRetired(client, local, applied) {
  const boundary = local.entries.find(
    (entry) => entry.tag === P2_BOUNDARY_TAG,
  );
  const latestApplied = applied.at(-1);
  if (!boundary || !latestApplied) {
    throw new Error("Cannot resolve the P2 legacy Label Studio boundary");
  }

  // Once 0037 has applied, rows follow the new provider-binding protocol and
  // are legitimate. Only legacy prefixes must be empty before crossing 0037.
  if (
    local.entries
      .slice(boundary.idx)
      .some((entry) => matches(entry, latestApplied))
  ) {
    return;
  }

  const session = await client.query(
    "SELECT id FROM public.labeling_sessions ORDER BY id LIMIT 1",
  );
  if (session.rows.length > 0) {
    throw new Error(
      `P2 cutover requires zero legacy labeling_sessions rows before migration 0037; found session ${session.rows[0].id}`,
    );
  }

  const intentRelation = await client.query(
    "SELECT pg_catalog.to_regclass('public.label_studio_project_intents') AS relation",
  );
  if (intentRelation.rows[0]?.relation) {
    const intent = await client.query(
      "SELECT id FROM public.label_studio_project_intents ORDER BY id LIMIT 1",
    );
    if (intent.rows.length > 0) {
      throw new Error(
        `P2 cutover requires zero legacy label_studio_project_intents rows before migration 0037; found intent ${intent.rows[0].id}`,
      );
    }
  }
}
