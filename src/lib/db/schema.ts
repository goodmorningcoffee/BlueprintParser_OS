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
  index,
} from "drizzle-orm/pg-core";

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
      yoloRequired: string[];
      yoloBoosters: string[];
      textKeywords: string[];
      overlapRequired: boolean;
      outputLabel: string;
      outputCsiCode?: string;
      minConfidence: number;
    }>;
  }>(),
  features: jsonb("features").$type<{
    yolo: boolean;
    llm: boolean;
    textract: boolean;
    labelStudio?: boolean;
  }>(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
});

// ─── Users ───────────────────────────────────────────────────
export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  publicId: uuid("public_id").defaultRandom().unique().notNull(),
  username: varchar("username", { length: 255 }).notNull(),
  email: varchar("email", { length: 255 }).unique().notNull(),
  passwordHash: varchar("password_hash", { length: 255 }).notNull(),
  role: varchar("role", { length: 50 }).default("member").notNull(),
  canRunModels: boolean("can_run_models").default(false).notNull(),
  companyId: integer("company_id")
    .notNull()
    .references(() => companies.id),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
});

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
  (table) => [index("idx_api_keys_user").on(table.userId)]
);

// ─── Projects ────────────────────────────────────────────────
export const projects = pgTable("projects", {
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
  projectIntelligence: jsonb("project_intelligence"),
  projectSummary: text("project_summary"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
});

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
    textractData: jsonb("textract_data"), // Textract word-level bounding boxes
    keynotes: jsonb("keynotes"), // [{shape, text, bbox, contour}]
    csiCodes: jsonb("csi_codes"), // [{code, description, trade, division}]
    textAnnotations: jsonb("text_annotations"), // TextAnnotationResult
    pageIntelligence: jsonb("page_intelligence"), // PageIntelligence
    error: text("error"),
    projectId: integer("project_id")
      .notNull()
      .references(() => projects.id),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [index("idx_pages_project").on(table.projectId)]
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
    data: jsonb("data"),
    note: text("note"),
    source: varchar("source", { length: 50 }).default("user").notNull(), // 'user' | 'yolo'
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
  ]
);

// ─── Takeoff Items ──────────────────────────────────────────
export const takeoffItems = pgTable(
  "takeoff_items",
  {
    id: serial("id").primaryKey(),
    projectId: integer("project_id")
      .notNull()
      .references(() => projects.id),
    name: varchar("name", { length: 255 }).notNull(),
    shape: varchar("shape", { length: 50 }).notNull(),
    color: varchar("color", { length: 20 }).notNull(),
    size: integer("size").default(10).notNull(),
    notes: text("notes"),
    sortOrder: integer("sort_order").default(0).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [index("idx_takeoff_items_project").on(table.projectId)]
);

// ─── Chat Messages ───────────────────────────────────────────
export const chatMessages = pgTable(
  "chat_messages",
  {
    id: serial("id").primaryKey(),
    projectId: integer("project_id")
      .notNull()
      .references(() => projects.id),
    pageNumber: integer("page_number"), // NULL = project-wide chat
    role: varchar("role", { length: 20 }).notNull(), // 'user' | 'assistant'
    content: text("content").notNull(),
    model: varchar("model", { length: 100 }),
    userId: integer("user_id").references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [index("idx_chat_project").on(table.projectId)]
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
    modelConfig: jsonb("model_config"),
    startedAt: timestamp("started_at", { withTimezone: true }).defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    error: text("error"),
  },
  (table) => [index("idx_jobs_project").on(table.projectId)]
);

// ─── Model Registry ──────────────────────────────────────────
export const models = pgTable("models", {
  id: serial("id").primaryKey(),
  name: varchar("name", { length: 255 }).notNull(),
  type: varchar("type", { length: 50 }).notNull(),
  s3Path: text("s3_path").notNull(),
  config: jsonb("config"),
  isDefault: boolean("is_default").default(false).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
});

// ─── Audit Log ──────────────────────────────────────────────
export const auditLog = pgTable(
  "audit_log",
  {
    id: serial("id").primaryKey(),
    action: varchar("action", { length: 100 }).notNull(),
    userId: integer("user_id"),
    companyId: integer("company_id"),
    details: jsonb("details"),
    ip: varchar("ip", { length: 45 }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [index("idx_audit_action").on(table.action)]
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
    userId: integer("user_id").references(() => users.id, { onDelete: "cascade" }), // NULL = company-wide
    provider: varchar("provider", { length: 50 }).notNull(), // 'groq' | 'anthropic' | 'openai' | 'custom'
    model: varchar("model", { length: 100 }).notNull(),
    encryptedApiKey: text("encrypted_api_key"), // NULL = use env var fallback
    baseUrl: text("base_url"), // for Ollama/custom endpoints
    isDemo: boolean("is_demo").default(false).notNull(),
    isDefault: boolean("is_default").default(false).notNull(),
    config: jsonb("config").$type<{ temperature?: number; maxTokens?: number }>(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [
    index("idx_llm_configs_company").on(table.companyId),
  ]
);

// ─── Labeling Sessions (Label Studio integration) ───────────
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
    labelStudioUrl: varchar("label_studio_url", { length: 500 }),
    taskType: varchar("task_type", { length: 50 }).default("generic"),
    labels: jsonb("labels"),
    pageRange: varchar("page_range", { length: 100 }),
    tilingEnabled: boolean("tiling_enabled").default(false),
    tileGrid: integer("tile_grid"),
    status: varchar("status", { length: 50 }).default("active").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [index("idx_labeling_sessions_project").on(table.projectId)]
);

// ─── QTO Workflows (Auto-QTO feature) ──────────────────────
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
    yoloModelFilter: text("yolo_model_filter"),
    yoloClassFilter: text("yolo_class_filter"),
    tagPattern: text("tag_pattern"),
    parsedSchedule: jsonb("parsed_schedule"),
    lineItems: jsonb("line_items"),
    userEdits: jsonb("user_edits"),
    exportedAt: timestamp("exported_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [index("idx_qto_workflows_project").on(table.projectId)]
);
