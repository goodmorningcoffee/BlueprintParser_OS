import {
  pgTable,
  pgEnum,
  serial,
  uuid,
  varchar,
  text,
  integer,
  real,
  boolean,
  jsonb,
  timestamp,
  doublePrecision,
  bigint,
  index,
  uniqueIndex,
  primaryKey,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import type {
  ProjectIntelligence,
  PageIntelligence,
  TextractPageData,
  KeynoteShapeData,
  CsiCode,
  TextAnnotationResult,
  AnnotationData,
  QtoParsedSchedule,
  QtoLineItem,
  QtoUserEdits,
  QtoItemType,
  ModelConfig,
  StagingFile,
} from "@/types";

// Enums
export const projectStatusEnum = pgEnum("project_status", [
  "uploading",
  "processing",
  "completed",
  "error",
]);

export const jobStatusEnum = pgEnum("job_status", [
  "running",
  "completed",
  "failed",
]);

// ─── Companies ───────────────────────────────────────────────
export const companies = pgTable("companies", {
  id: serial("id").primaryKey(),
  publicId: uuid("public_id").defaultRandom().unique().notNull(),
  name: varchar("name", { length: 255 }).unique().notNull(),
  dataKey: varchar("data_key", { length: 255 }).unique().notNull(),
  accessKey: varchar("access_key", { length: 255 }).notNull(),
  emailDomain: varchar("email_domain", { length: 255 }).notNull(),
  subscription: integer("subscription").default(0).notNull(),
  pipelineConfig: jsonb("pipeline_config").$type<{
    textAnnotation?: {
      enabledDetectors?: string[];
    };
    csi?: {
      matchingConfidenceThreshold?: number;
      taggerKeywordOverlap?: number;
      taggerMinWordMatches?: number;
      maxCsiTagsPerAnnotation?: number;
      tier2MinWords?: number;
      tier3MinWords?: number;
      tier2Weight?: number;
      tier3Weight?: number;
      customDatabaseS3Key?: string;
      customDatabaseName?: string;
      customDatabaseCodes?: number;
    };
    heuristics?: Array<{
      id: string;
      name: string;
      source: "built-in" | "custom";
      enabled: boolean;
      modelId?: number;
      modelName?: string;
      // YOLO side
      yoloRequired: string[];
      yoloBoosters: string[];
      yoloRequiredMinConfidence?: number;
      yoloAvailabilityMode?: "require" | "degrade" | "ignore";
      // Text side — new split (2026-04-24 DSL). Legacy `textKeywords` is kept
      // optional so pre-migration DB rows still typecheck; getEffectiveRules()
      // normalizes on read via migrateRule() in heuristic-rule-migrate.ts.
      textKeywords?: string[];
      textKeywordsRequired?: string[];
      textKeywordsBoosters?: string[];
      textKeywordsMode?: "any-required" | "all-required";
      // Spatial / CSI
      overlapRequired: boolean;
      textRegionType?: string;
      csiDivisionsRequired?: string[];
      // Output
      outputLabel: string;
      outputCsiCode?: string;
      minConfidence: number;
    }>;
    llm?: {
      systemPrompt?: string;
      sectionConfig?: Record<string, unknown>;
      toolUse?: boolean;
      domainKnowledge?: string;
    };
    pipeline?: Record<string, unknown>;
    /** Array of step IDs the admin has toggled off in PipelineTab. Every
     *  gated pipeline stage checks `!disabledSteps.includes(step.id)`. */
    disabledSteps?: string[];
    demo?: Record<string, boolean>;
    pageNaming?: {
      enabled?: boolean;
      yoloSources?: Array<{
        modelId: number;
        modelName: string;
        classes: string[];
      }>;
    };
    /** Stage 2d: pluggable pipeline toggles. Each detector is independently
     *  enable-able; absent/undefined fields default to the legacy behavior
     *  (enabled for back-compat). */
    ensemble?: {
      /** Enable the Stage 2b ensemble reducer. Default: enabled. */
      enabled?: boolean;
      /** Override the ensemble reducer's minDistinctVotes / probabilityThreshold / etc. */
      config?: {
        minDistinctVotes?: number;
        iouThreshold?: number;
        containThreshold?: number;
        probabilityThreshold?: number;
        sourceWeights?: Record<string, number>;
      };
    };
    autoDetect?: {
      /** [refactor jul9 P2-A S1] Stage 2c pipeline emission REMOVED (stored
       *  autoTableProposals had zero readers). These keys are currently
       *  inert config — the PipelineTab toggle still writes them; only the
       *  deferred S5 chain-slim (with P5 frozen-route deletion) may retire
       *  them fully. Default: disabled (admin opt-in). */
      tables?: boolean;
      /** Override the auto-detector's minProbability floor. */
      minProbability?: number;
      /** Restrict auto-detection to specific categories. */
      categoryFilter?: string[];
    };
    /** Stage 2a: toggle for the YOLO density heatmap. Default: enabled when
     *  YOLO data is present. Disable to skip the heatmap step entirely. */
    heatmap?: {
      enabled?: boolean;
    };
  }>(),
  features: jsonb("features").$type<{
    yolo: boolean;
    llm: boolean;
    textract: boolean;
    labelStudio?: boolean;
  }>(),
  // ─── Compute-usage caps (root_admin metering, 2026-06) ───
  // Net per-company pools. SageMaker (GPU) is the real money gate; Textract is
  // cheap and tracked for visibility. `usageWindowStart` is the counting anchor
  // (null = since company creation); a "reset" advances it so used → 0.
  sagemakerPageLimit: integer("sagemaker_page_limit").default(500).notNull(),
  textractPageLimit: integer("textract_page_limit").default(10000).notNull(),
  usageResetInterval: varchar("usage_reset_interval", { length: 50 })
    .default("manual")
    .notNull(),
  usageWindowStart: timestamp("usage_window_start", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
});

// ─── Users ───────────────────────────────────────────────────
export const users = pgTable(
  "users",
  {
    id: serial("id").primaryKey(),
    publicId: uuid("public_id").defaultRandom().unique().notNull(),
    username: varchar("username", { length: 255 }).notNull(),
    email: varchar("email", { length: 255 }).unique().notNull(),
    passwordHash: varchar("password_hash", { length: 255 }),
    role: varchar("role", { length: 50 }).default("member").notNull(),
    canRunModels: boolean("can_run_models").default(false).notNull(),
    isRootAdmin: boolean("is_root_admin").default(false).notNull(),
    oauthProvider: varchar("oauth_provider", { length: 50 }),
    oauthProviderId: varchar("oauth_provider_id", { length: 255 }),
    passwordResetToken: varchar("password_reset_token", { length: 255 }),
    passwordResetExpires: timestamp("password_reset_expires", {
      withTimezone: true,
    }),
    companyId: integer("company_id")
      .notNull()
      .references(() => companies.id),
    // Optional per-user SageMaker sub-cap. null = no personal cap (governed
    // only by the company pool); usageWindowStart is this user's reset anchor.
    sagemakerPageLimit: integer("sagemaker_page_limit"),
    usageWindowStart: timestamp("usage_window_start", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [index("idx_users_company").on(table.companyId)],
);

// ─── User API Keys (BYOK for LLM providers) ─────────────────
export const userApiKeys = pgTable(
  "user_api_keys",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    provider: varchar("provider", { length: 50 }).notNull(), // 'anthropic' | 'openai' | 'groq'
    encryptedKey: text("encrypted_key").notNull(),
    label: varchar("label", { length: 255 }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [index("idx_api_keys_user").on(table.userId)],
);

// ─── Projects ────────────────────────────────────────────────
export const projects = pgTable(
  "projects",
  {
    id: serial("id").primaryKey(),
    publicId: uuid("public_id").defaultRandom().unique().notNull(),
    name: varchar("name", { length: 255 }).notNull(),
    dataUrl: varchar("data_url", { length: 255 }).unique().notNull(),
    numPages: integer("num_pages"),
    status: projectStatusEnum("status").default("uploading").notNull(),
    processingError: text("processing_error"),
    processingTime: integer("processing_time"),
    jobId: varchar("job_id", { length: 255 }),
    address: text("address"),
    latitude: doublePrecision("latitude"),
    longitude: doublePrecision("longitude"),
    authorId: integer("author_id")
      .notNull()
      .references(() => users.id),
    companyId: integer("company_id")
      .notNull()
      .references(() => companies.id),
    isDemo: boolean("is_demo").default(false).notNull(),
    // Monotonic authority generation for private <-> public-demo lifecycle transitions.
    // Unlike updatedAt this is not content metadata and cannot collide at JS millisecond precision.
    lifecycleEpoch: bigint("lifecycle_epoch", { mode: "number" })
      .default(0)
      .notNull(),
    projectIntelligence: jsonb(
      "project_intelligence",
    ).$type<ProjectIntelligence>(),
    stagingManifest: jsonb("staging_manifest").$type<StagingFile[]>(),
    projectSummary: text("project_summary"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [index("idx_projects_company").on(table.companyId)],
);

// Permanent storage-root tombstone + retry outbox for project deletion. The row intentionally has no
// foreign keys: it must survive deletion of the project, company, and user that created the assets.
// `storageRoot` is never reused, while the pending state drives idempotent S3-version purge and
// CloudFront invalidation until both have been observed complete.
export const projectAssetDeletions = pgTable(
  "project_asset_deletions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    projectPublicId: uuid("project_public_id").notNull(),
    companyId: integer("company_id").notNull(),
    storageRoot: varchar("storage_root", { length: 255 }).unique().notNull(),
    lifecycleEpoch: bigint("lifecycle_epoch", { mode: "number" }).notNull(),
    status: varchar("status", { length: 20 }).default("pending").notNull(),
    phase: varchar("phase", { length: 20 }).default("purge").notNull(),
    attemptCount: integer("attempt_count").default(0).notNull(),
    consecutiveFailures: integer("consecutive_failures").default(0).notNull(),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    leaseToken: uuid("lease_token"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    s3PurgedAt: timestamp("s3_purged_at", { withTimezone: true }),
    invalidationGeneration: integer("invalidation_generation")
      .default(0)
      .notNull(),
    objectEventGeneration: bigint("object_event_generation", { mode: "number" })
      .default(0)
      .notNull(),
    lastReconciledEventGeneration: bigint("last_reconciled_event_generation", {
      mode: "number",
    })
      .default(0)
      .notNull(),
    cloudfrontInvalidationId: text("cloudfront_invalidation_id"),
    lastError: text("last_error"),
    lastVerifiedAt: timestamp("last_verified_at", { withTimezone: true }),
    attentionRequiredAt: timestamp("attention_required_at", {
      withTimezone: true,
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [
    index("idx_project_asset_deletions_due").on(
      table.status,
      table.nextAttemptAt,
    ),
    index("idx_project_asset_deletions_lease").on(table.leaseExpiresAt),
  ],
);

// Durable coordination for long project mutations that cross external systems. The lease is
// acquired in a short parent-locked transaction; manageDemo rejects every live lease instead of
// holding a database connection across AWS/S3/LLM work.
export const projectMutationLeases = pgTable(
  "project_mutation_leases",
  {
    token: uuid("token").defaultRandom().primaryKey(),
    projectId: integer("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    lifecycleEpoch: bigint("lifecycle_epoch", { mode: "number" }).notNull(),
    kind: varchar("kind", { length: 80 }).notNull(),
    idempotencyKey: varchar("idempotency_key", { length: 255 }),
    status: varchar("status", { length: 20 }).default("active").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    heartbeatAt: timestamp("heartbeat_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("idx_project_mutation_leases_project").on(table.projectId),
    index("idx_project_mutation_leases_expiry").on(table.expiresAt),
    uniqueIndex("uq_project_mutation_leases_idempotency").on(
      table.projectId,
      table.idempotencyKey,
    ),
  ],
);

// ─── Compute Usage Ledger ────────────────────────────────────
// Append-only record of metered compute (SageMaker YOLO pages, Textract
// pages, Lambda CV fan-out). Source of truth for the per-company / per-user
// usage caps enforced in src/lib/compute-usage.ts and for the root_admin
// Usage dashboard. One YOLO run inserts one row charging the project's full
// page count. userId/projectId are nullable so system-attributed usage can
// still be recorded.
export const computeUsage = pgTable(
  "compute_usage",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id")
      .notNull()
      .references(() => companies.id),
    // ON DELETE SET NULL: the ledger is append-only billing history — keep the
    // row (companyId + pages) even if the user/project is later deleted, just
    // drop the link. Without this, a referenced user/project can't be deleted.
    userId: integer("user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    projectId: integer("project_id").references(() => projects.id, {
      onDelete: "set null",
    }),
    resource: varchar("resource", { length: 50 }).notNull(), // 'sagemaker' | 'textract' | 'lambda_cv'
    pages: integer("pages").notNull(),
    jobId: varchar("job_id", { length: 255 }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("idx_compute_usage_company").on(
      table.companyId,
      table.resource,
      table.createdAt,
    ),
    index("idx_compute_usage_user").on(
      table.userId,
      table.resource,
      table.createdAt,
    ),
  ],
);

// ─── Pages ───────────────────────────────────────────────────
// NOTE: A `search_vector tsvector` column + GIN index exists on this table
// but is managed via raw SQL (drizzle/0001_add_search_vector.sql) since
// Drizzle ORM does not support tsvector columns.
export const pages = pgTable(
  "pages",
  {
    id: serial("id").primaryKey(),
    pageNumber: integer("page_number").notNull(),
    name: varchar("name", { length: 255 }).notNull(),
    drawingNumber: varchar("drawing_number", { length: 100 }),
    rawText: text("raw_text"),
    textractData: jsonb("textract_data").$type<TextractPageData>(),
    keynotes: jsonb("keynotes").$type<KeynoteShapeData[]>(),
    // [refactor jul23 P4.1 U9] Widened inline anonymous type → CsiCode[] (adds the
    // optional `triggers` field the anonymous type omitted; reprocess.ts already
    // persists triggers into these bytes). Compile-time only — a pure widening.
    csiCodes: jsonb("csi_codes").$type<CsiCode[]>(),
    textAnnotations: jsonb("text_annotations").$type<TextAnnotationResult>(),
    pageIntelligence: jsonb("page_intelligence").$type<PageIntelligence>(),
    error: text("error"),
    projectId: integer("project_id")
      .notNull()
      .references(() => projects.id),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [
    index("idx_pages_project").on(table.projectId),
    index("idx_pages_project_page").on(table.projectId, table.pageNumber),
  ],
);

// ─── Annotations ─────────────────────────────────────────────
export const annotations = pgTable(
  "annotations",
  {
    id: serial("id").primaryKey(),
    name: varchar("name", { length: 255 }).notNull(),
    minX: real("min_x").notNull(),
    maxX: real("max_x").notNull(),
    minY: real("min_y").notNull(),
    maxY: real("max_y").notNull(),
    pageNumber: integer("page_number").notNull(),
    threshold: real("threshold"),
    data: jsonb("data").$type<AnnotationData>(),
    note: text("note"),
    source: varchar("source", { length: 50 }).default("user").notNull(), // 'user' | 'yolo' | 'takeoff'
    creatorId: integer("creator_id").references(() => users.id),
    projectId: integer("project_id")
      .notNull()
      .references(() => projects.id),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [
    index("idx_annotations_project").on(table.projectId),
    index("idx_annotations_name").on(table.name),
    index("idx_annotations_project_page").on(table.projectId, table.pageNumber),
  ],
);

// ─── Takeoff Groups ─────────────────────────────────────────
export const takeoffGroups = pgTable(
  "takeoff_groups",
  {
    id: serial("id").primaryKey(),
    projectId: integer("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 255 }).notNull(),
    kind: varchar("kind", { length: 20 }).notNull(), // "count" | "area" | "linear"
    color: varchar("color", { length: 20 }),
    csiCode: varchar("csi_code", { length: 20 }),
    sortOrder: integer("sort_order").default(0).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [
    index("idx_takeoff_groups_project").on(table.projectId),
    index("idx_takeoff_groups_project_kind").on(table.projectId, table.kind),
  ],
);

// ─── Takeoff Items ──────────────────────────────────────────
export const takeoffItems = pgTable(
  "takeoff_items",
  {
    id: serial("id").primaryKey(),
    projectId: integer("project_id")
      .notNull()
      .references(() => projects.id),
    groupId: integer("group_id").references(() => takeoffGroups.id, {
      onDelete: "set null",
    }),
    name: varchar("name", { length: 255 }).notNull(),
    shape: varchar("shape", { length: 50 }).notNull(),
    color: varchar("color", { length: 20 }).notNull(),
    size: integer("size").default(10).notNull(),
    notes: text("notes"),
    sortOrder: integer("sort_order").default(0).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [index("idx_takeoff_items_project").on(table.projectId)],
);

// ─── Chat Messages ───────────────────────────────────────────
export const chatMessages = pgTable(
  "chat_messages",
  {
    id: serial("id").primaryKey(),
    // [refactor jun13 P0.5-G2] nullable: NULL = global (cross-project) chat.
    // Was NOT NULL; global chat passed projectId=0 → FK violation after the
    // full response had streamed → assistant message silently never saved.
    projectId: integer("project_id").references(() => projects.id),
    pageNumber: integer("page_number"), // NULL = project-wide chat
    role: varchar("role", { length: 20 }).notNull(), // 'user' | 'assistant'
    content: text("content").notNull(),
    model: varchar("model", { length: 100 }),
    userId: integer("user_id").references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [index("idx_chat_project").on(table.projectId)],
);

// ─── Sessions (for NextAuth) ─────────────────────────────────
export const sessions = pgTable("sessions", {
  id: serial("id").primaryKey(),
  sessionToken: varchar("session_token", { length: 255 }).unique().notNull(),
  userId: integer("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  expires: timestamp("expires", { withTimezone: true }).notNull(),
});

// ─── Processing Jobs ─────────────────────────────────────────
export const processingJobs = pgTable(
  "processing_jobs",
  {
    id: serial("id").primaryKey(),
    projectId: integer("project_id")
      .notNull()
      .references(() => projects.id),
    stepFunctionArn: text("step_function_arn"),
    executionId: text("execution_id"),
    status: jobStatusEnum("status").default("running").notNull(),
    modelConfig: jsonb("model_config").$type<Record<string, unknown>>(),
    startedAt: timestamp("started_at", { withTimezone: true }).defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    error: text("error"),
  },
  (table) => [index("idx_jobs_project").on(table.projectId)],
);

// ─── Model Registry ──────────────────────────────────────────
export const models = pgTable(
  "models",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id")
      .notNull()
      .references(() => companies.id),
    name: varchar("name", { length: 255 }).notNull(),
    type: varchar("type", { length: 50 }).notNull(),
    s3Path: text("s3_path").notNull(),
    config: jsonb("config").$type<ModelConfig>(),
    isDefault: boolean("is_default").default(false).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [index("idx_models_company").on(table.companyId)],
);

// ─── Model Access (which companies can use which models) ────
export const modelAccess = pgTable(
  "model_access",
  {
    id: serial("id").primaryKey(),
    modelId: integer("model_id")
      .notNull()
      .references(() => models.id, { onDelete: "cascade" }),
    companyId: integer("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    // Per-user grant: NULL = the whole company may use the model (legacy
    // behavior); set = only that one user (within companyId) may use it.
    userId: integer("user_id").references(() => users.id, {
      onDelete: "cascade",
    }),
    enabled: boolean("enabled").default(true).notNull(),
    grantedBy: integer("granted_by").references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [
    index("idx_model_access_company").on(table.companyId),
    index("idx_model_access_model").on(table.modelId),
    index("idx_model_access_user").on(table.userId),
  ],
);

// ─── App Settings (global key-value, root admin configurable) ─
export const appSettings = pgTable("app_settings", {
  key: varchar("key", { length: 100 }).primaryKey(),
  value: jsonb("value").$type<Record<string, unknown>>().notNull(),
  updatedBy: integer("updated_by").references(() => users.id),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
});

// ─── Audit Log ──────────────────────────────────────────────
export const auditLog = pgTable(
  "audit_log",
  {
    id: serial("id").primaryKey(),
    action: varchar("action", { length: 100 }).notNull(),
    userId: integer("user_id"),
    companyId: integer("company_id"),
    details: jsonb("details").$type<Record<string, unknown>>(),
    ip: varchar("ip", { length: 45 }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [index("idx_audit_action").on(table.action)],
);

// ─── Admin Logs — abuse events + manual IP bans ─────────────
//
// abuseEvents: high-signal row per rate-limit breach, auto-ban, failed login,
// 404-scan burst, or deprecated-route hit. Read by the Root_Admin Logs tab's
// Security panel. `seen_at IS NULL` drives the tab's alert badge pulse.
// Expected volume <1k rows/day even under active abuse; safely unindexed
// beyond the two maintained indexes.
export const abuseEvents = pgTable(
  "abuse_events",
  {
    id: serial("id").primaryKey(),
    eventType: varchar("event_type", { length: 40 }).notNull(),
    ip: varchar("ip", { length: 45 }).notNull(),
    country: varchar("country", { length: 2 }),
    path: varchar("path", { length: 255 }),
    userAgent: varchar("user_agent", { length: 500 }),
    details: jsonb("details").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    seenAt: timestamp("seen_at", { withTimezone: true }),
  },
  (table) => [
    index("idx_abuse_events_created").on(table.createdAt),
    index("idx_abuse_events_unseen").on(table.seenAt),
  ],
);

// manualIpBans: Root_Admin-initiated bans AND (as of P5.4) the converged home
// for the formerly in-memory auto-ban `banStore`. Middleware reads with a 60s
// in-memory cache to avoid per-request DB hits.
//
// [refactor jul23 P5.4-B] Additive columns so auto-bans land in this same table
// (one cache + one admin read path serves both):
//   source            — 'manual' (Root_Admin, the historical default) | 'auto'
//                        (parser-abuse escalation). Backfills to 'manual'.
//   violations        — auto-only: strikes counted inside the 5-minute window.
//   firstViolationAt  — auto-only: window anchor for the 2-strike escalation.
export const manualIpBans = pgTable("manual_ip_bans", {
  id: serial("id").primaryKey(),
  ip: varchar("ip", { length: 45 }).notNull().unique(),
  reason: varchar("reason", { length: 500 }),
  bannedByUserId: integer("banned_by_user_id"),
  bannedUntil: timestamp("banned_until", { withTimezone: true }),
  source: varchar("source", { length: 10 }).notNull().default("manual"),
  violations: integer("violations"),
  firstViolationAt: timestamp("first_violation_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

// ─── P5.4 PG-backed shared runtime state ────────────────────
//
// [refactor jul23 P5.4-B] These three tables move per-ECS-task in-memory state
// (rate buckets, login lockouts, parse-history ring) to Postgres so a multi-task
// autoscaled cluster stops N×-multiplying every threshold and stops being
// per-task ban-blind. Additive migration 0039_runtime_state. A pg_advisory_lock
// janitor (entrypoint `janitor` mode) sweeps expired rows.

// runtimeCounters: generic fixed-window buckets (rate limits, cooldowns).
// Increment atomically via INSERT ... ON CONFLICT (scope,key) DO UPDATE with a
// CASE that resets the window when reset_at has passed. One statement = one
// round-trip, so the hot path adds at most a single upsert per request.
export const runtimeCounters = pgTable(
  "runtime_counters",
  {
    scope: text("scope").notNull(),
    key: text("key").notNull(),
    count: integer("count").notNull().default(0),
    resetAt: timestamp("reset_at", { withTimezone: true }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.scope, table.key] })],
);

// loginLockouts: dedicated table (not overloaded onto runtimeCounters) because
// brute-force lockout keeps extra semantics — an exponentially growing
// locked_until AND a count that survives an expired lockout. Keyed by lowercased
// email. Mirrors the extracted src/lib/login-lockout.ts field-for-field.
export const loginLockouts = pgTable("login_lockouts", {
  email: text("email").primaryKey(),
  count: integer("count").notNull().default(0),
  lockedUntil: timestamp("locked_until", { withTimezone: true }),
  lastAttempt: timestamp("last_attempt", { withTimezone: true }),
});

// opLog: durable replacement for the 50-entry in-memory parse-history ring.
// getHistory becomes ORDER BY created_at DESC LIMIT N; the janitor trims old
// rows. request/response hold the same payloads the ring stored per entry.
export const opLog = pgTable(
  "op_log",
  {
    id: serial("id").primaryKey(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    kind: varchar("kind", { length: 40 }).notNull(),
    request: jsonb("request"),
    response: jsonb("response"),
  },
  (table) => [index("idx_op_log_created").on(table.createdAt)],
);

// ─── Invite Requests ────────────────────────────────────────
export const inviteRequests = pgTable("invite_requests", {
  id: serial("id").primaryKey(),
  email: varchar("email", { length: 255 }).notNull(),
  name: varchar("name", { length: 255 }),
  company: varchar("company", { length: 255 }),
  seen: boolean("seen").default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
});

// ─── LLM Configs (admin-configured provider/model per company) ─
export const llmConfigs = pgTable(
  "llm_configs",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    userId: integer("user_id").references(() => users.id, {
      onDelete: "cascade",
    }), // NULL = company-wide
    provider: varchar("provider", { length: 50 }).notNull(), // 'groq' | 'anthropic' | 'openai' | 'custom'
    model: varchar("model", { length: 100 }).notNull(),
    encryptedApiKey: text("encrypted_api_key"), // NULL = use env var fallback
    baseUrl: text("base_url"), // for Ollama/custom endpoints
    isDemo: boolean("is_demo").default(false).notNull(),
    isDefault: boolean("is_default").default(false).notNull(),
    config: jsonb("config").$type<{
      temperature?: number;
      maxTokens?: number;
    }>(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [index("idx_llm_configs_company").on(table.companyId)],
);

// ─── Labeling Sessions (Label Studio integration) ───────────
// Durable provider-create cleanup intent. The provider assigns its numeric project ID, so an
// application UUID marker is committed before POST and searched after any ambiguous outcome.
export const labelStudioProjectIntents = pgTable(
  "label_studio_project_intents",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    projectId: integer("project_id")
      .notNull()
      .unique()
      .references(() => projects.id),
    companyId: integer("company_id")
      .notNull()
      .references(() => companies.id),
    lifecycleEpoch: bigint("lifecycle_epoch", { mode: "number" }).notNull(),
    marker: varchar("marker", { length: 255 }).notNull().unique(),
    providerProjectId: integer("provider_project_id"),
    providerBaseUrl: text("provider_base_url").notNull(),
    providerInstanceId: text("provider_instance_id").notNull(),
    state: varchar("state", { length: 30 }).default("creating").notNull(),
    attemptCount: integer("attempt_count").default(0).notNull(),
    consecutiveFailures: integer("consecutive_failures").default(0).notNull(),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    leaseToken: uuid("lease_token"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("idx_label_studio_project_intents_due").on(table.nextAttemptAt),
    index("idx_label_studio_project_intents_lease").on(table.leaseExpiresAt),
    uniqueIndex("uq_ls_intents_provider_project")
      .on(
        table.providerBaseUrl,
        table.providerInstanceId,
        table.providerProjectId,
      )
      .where(sql`${table.providerProjectId} IS NOT NULL`),
  ],
);

export const labelingSessions = pgTable(
  "labeling_sessions",
  {
    id: serial("id").primaryKey(),
    projectId: integer("project_id")
      .notNull()
      .references(() => projects.id),
    companyId: integer("company_id")
      .notNull()
      .references(() => companies.id),
    labelStudioProjectId: integer("label_studio_project_id").notNull(),
    providerBaseUrl: text("provider_base_url").notNull(),
    providerInstanceId: text("provider_instance_id").notNull(),
    labelStudioUrl: varchar("label_studio_url", { length: 500 }),
    taskType: varchar("task_type", { length: 50 }).default("generic"),
    labels: jsonb("labels").$type<string[]>(),
    pageRange: varchar("page_range", { length: 100 }),
    tilingEnabled: boolean("tiling_enabled").default(false),
    tileGrid: integer("tile_grid"),
    status: varchar("status", { length: 50 }).default("active").notNull(),
    // Audit/finalization witness only. The intent row is removed atomically when this session is
    // activated, so this deliberately is not an FK.
    provisioningIntentId: uuid("provisioning_intent_id").notNull().unique(),
    // A failed/idempotent provider DELETE is a durable retirement queue item. Unlike the
    // project-wide mutation lease (whose expiry is diagnostic only), this lease may be reclaimed:
    // deleting the same Label Studio project is idempotent and every task bearer was revoked
    // before the first attempt.
    retirementAttemptCount: integer("retirement_attempt_count")
      .default(0)
      .notNull(),
    retirementConsecutiveFailures: integer("retirement_consecutive_failures")
      .default(0)
      .notNull(),
    retirementNextAttemptAt: timestamp("retirement_next_attempt_at", {
      withTimezone: true,
    })
      .defaultNow()
      .notNull(),
    retirementLeaseToken: uuid("retirement_lease_token"),
    retirementLeaseExpiresAt: timestamp("retirement_lease_expires_at", {
      withTimezone: true,
    }),
    retirementLastError: text("retirement_last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [
    index("idx_labeling_sessions_project").on(table.projectId),
    index("idx_labeling_sessions_retirement_due").on(
      table.status,
      table.retirementNextAttemptAt,
    ),
    index("idx_labeling_sessions_retirement_lease").on(
      table.retirementLeaseExpiresAt,
    ),
    uniqueIndex("uq_labeling_sessions_provider_project").on(
      table.providerBaseUrl,
      table.providerInstanceId,
      table.labelStudioProjectId,
    ),
  ],
);

// One immutable, exact-version image capability per imported Label Studio task. The plaintext
// bearer is embedded in Label Studio's task URL and therefore also enters the shared ALB's
// request-target access log; BP stores only its SHA-256 digest. Terraform isolates those logs in a
// private SSE-S3 bucket with one-day lifecycle expiry. Snapshot keys are derived from
// `(project.dataUrl, id)` and therefore cannot be redirected by a mutable DB field.
export const labelStudioAssetGrants = pgTable(
  "label_studio_asset_grants",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    projectId: integer("project_id")
      .notNull()
      .references(() => projects.id),
    companyId: integer("company_id")
      .notNull()
      .references(() => companies.id),
    lifecycleEpoch: bigint("lifecycle_epoch", { mode: "number" }).notNull(),
    provisioningIntentId: uuid("provisioning_intent_id").references(
      () => labelStudioProjectIntents.id,
    ),
    labelingSessionId: integer("labeling_session_id").references(
      () => labelingSessions.id,
    ),
    tokenHash: varchar("token_hash", { length: 64 }).notNull().unique(),
    snapshotVersionId: text("snapshot_version_id").notNull(),
    state: varchar("state", { length: 20 }).default("provisioning").notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("idx_label_studio_asset_grants_project").on(table.projectId),
    index("idx_label_studio_asset_grants_intent").on(
      table.provisioningIntentId,
    ),
    index("idx_label_studio_asset_grants_session").on(table.labelingSessionId),
  ],
);

// ─── QTO Workflows (Auto-QTO feature) ──────────────────────
// SHIP 2 (migration 0024): dropped yolo_model_filter + tag_pattern (dead
// columns never wired to any UI), added item_type + tag_shape_class for
// the 5-type item taxonomy.
export const qtoWorkflows = pgTable(
  "qto_workflows",
  {
    id: serial("id").primaryKey(),
    projectId: integer("project_id")
      .notNull()
      .references(() => projects.id),
    materialType: text("material_type").notNull(),
    materialLabel: text("material_label"),
    step: text("step").notNull().default("pick"),
    schedulePageNumber: integer("schedule_page_number"),
    yoloClassFilter: text("yolo_class_filter"),
    itemType: text("item_type")
      .notNull()
      .default("yolo-with-inner-text")
      .$type<QtoItemType>(),
    tagShapeClass: text("tag_shape_class"),
    parsedSchedule: jsonb("parsed_schedule").$type<QtoParsedSchedule>(),
    lineItems: jsonb("line_items").$type<QtoLineItem[]>(),
    userEdits: jsonb("user_edits").$type<QtoUserEdits>(),
    exportedAt: timestamp("exported_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [index("idx_qto_workflows_project").on(table.projectId)],
);

// ─── Annotation Groups ─────────────────────────────────────
// User-created groupings over annotations (YOLO detections, Shape Parse
// keynotes, Symbol Search matches, markups, etc.). Project-scoped.
// Groups carry their own name/CSI/notes/color metadata — the membership
// is M:N via annotation_group_members so one annotation can belong to
// many groups.
export const annotationGroups = pgTable(
  "annotation_groups",
  {
    id: serial("id").primaryKey(),
    projectId: integer("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 255 }).notNull(),
    csiCode: varchar("csi_code", { length: 20 }),
    notes: text("notes"),
    color: varchar("color", { length: 20 }),
    isActive: boolean("is_active").notNull().default(true),
    createdBy: integer("created_by").references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [index("idx_annotation_groups_project").on(table.projectId)],
);

// Junction table — M:N annotations ↔ annotation_groups. Composite PK
// prevents duplicate memberships. Both sides cascade on delete so
// removing an annotation or a group cleans up stale links without
// touching the other side's primary row.
export const annotationGroupMembers = pgTable(
  "annotation_group_members",
  {
    annotationId: integer("annotation_id")
      .notNull()
      .references(() => annotations.id, { onDelete: "cascade" }),
    groupId: integer("group_id")
      .notNull()
      .references(() => annotationGroups.id, { onDelete: "cascade" }),
    addedAt: timestamp("added_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.annotationId, table.groupId] }),
    index("idx_annotation_group_members_group").on(table.groupId),
  ],
);
