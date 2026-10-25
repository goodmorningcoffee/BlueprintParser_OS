/**
 * Freeze-first L5 project security manifest.
 *
 * This file is an oracle input, not runtime application code. Every generic project-owned
 * mutation and every anonymous demo read/compute surface must be named here. The checker fails
 * closed when it discovers an unclassified demo resolver/query or project-owned write sink.
 */

export const CANONICAL_DEMO_WRITE_ERROR = {
  status: 403,
  code: "FORBIDDEN",
  message: "Demo projects are read-only",
  databaseCode: "P0001",
  constraint: "demo_project_read_only",
};

/**
 * HTTP surfaces retained only as deterministic tombstones while stale clients drain. A tombstone
 * is not an authenticated compatibility API: its handler must unconditionally return the named
 * status without reading or serializing any former authority.
 */
export const TOMBSTONED_HTTP_SURFACES = [
  {
    id: "label-studio-browser-credentials",
    route: "/api/labeling/credentials",
    method: "GET",
    routeFile: "src/app/api/labeling/credentials/route.ts",
    auth: "none",
    status: 410,
    code: "NOT_FOUND",
    message: "Label Studio browser credentials are disabled",
  },
];

/**
 * The application task accepts traffic only from this ALB. Append mode makes the socket client
 * address the rightmost X-Forwarded-For hop; left hops remain untrusted caller input. Deprecated
 * unauthenticated tombstones are admitted and sampled in process before any durable abuse write.
 */
export const EDGE_CLIENT_IP_POLICY = {
  middlewareFile: "src/middleware.ts",
  parserFile: "src/lib/trusted-client-ip.ts",
  terraformFile: "infrastructure/terraform/ecs.tf",
  loadBalancerResource: "beaver",
  xffMode: "append",
  xffClientPort: false,
  trustedHop: "rightmost-nonempty",
  parseTailMaxChars: 2_048,
  parseSuffixMaxSegments: 8,
  invalidAddress: "unknown",
  deprecatedRouteLimit: 5,
  deprecatedRouteWindowMs: 60_000,
  deprecatedTelemetryPerWindow: 1,
  durableTelemetryConsumers: [
    {
      file: "src/server/services/yolo.ts",
      function: "yoloRun",
      header: "x-forwarded-for",
    },
  ],
};

/** Provider-global job names are never bearer capabilities; status requires an own-company row. */
export const PROVIDER_JOB_STATUS_AUTHORITIES = [
  {
    id: "yolo-sagemaker-status",
    routeFile: "src/app/api/yolo/status/route.ts",
    method: "GET",
    auth: "session",
    serviceFile: "src/server/services/yolo.ts",
    serviceFunction: "yoloStatus",
    providerCall: "getYoloJobStatus",
    rootBypass: false,
  },
  {
    id: "admin-sagemaker-details",
    routeFile: "src/app/api/admin/sagemaker-details/route.ts",
    method: "GET",
    auth: "admin",
    serviceFile: "src/server/services/sagemaker-details.ts",
    serviceFunction: "getSagemakerDetails",
    providerCall: "send",
    rootBypass: true,
  },
];

/** Canonical redirect-free paths documented by the Label Studio project API. */
export const LABEL_STUDIO_PROVIDER_PATHS = {
  create: "/api/projects/",
  search: "/api/projects/?search=${encodeURIComponent(marker)}&page_size=100",
  project: "/api/projects/${projectId}/",
  import: "/api/projects/${projectId}/import",
};

/**
 * Application-owned tasks that may call Label Studio. Numeric provider project IDs are scoped to
 * one persistent instance, so every caller needs the same stable instance ID and API token while
 * remaining isolated from the provider's human bootstrap username/password.
 */
export const LABEL_STUDIO_PROVIDER_TASKS = [
  {
    id: "application",
    terraformFile: "infrastructure/terraform/ecs.tf",
    resource: "beaver_app",
    requiredEnvironment: ["LABEL_STUDIO_URL", "LABEL_STUDIO_INSTANCE_ID"],
    requiredSecrets: ["LABEL_STUDIO_API_KEY"],
    instanceIdentity:
      "${aws_efs_file_system.label_studio.id}:${var.label_studio_instance_generation}",
    rootAdminIdentity: "var.root_admin_email",
    forbiddenAuthority: [
      "LABEL_STUDIO_ADMIN_EMAIL",
      "LABEL_STUDIO_ADMIN_PASSWORD",
      "LABEL_STUDIO_USERNAME",
      "LABEL_STUDIO_PASSWORD",
      "label_studio_admin_email",
      "label_studio_admin_password",
      "aws_secretsmanager_secret.ls_admin_email.arn",
      "aws_secretsmanager_secret.ls_admin_password.arn",
    ],
  },
  {
    id: "cleanup-worker",
    terraformFile: "infrastructure/terraform/project-asset-deletions.tf",
    resource: "beaver_project_asset_deletions",
    requiredEnvironment: ["LABEL_STUDIO_URL", "LABEL_STUDIO_INSTANCE_ID"],
    requiredSecrets: ["LABEL_STUDIO_API_KEY"],
    instanceIdentity:
      "${aws_efs_file_system.label_studio.id}:${var.label_studio_instance_generation}",
    forbiddenAuthority: [
      "LABEL_STUDIO_ADMIN_EMAIL",
      "LABEL_STUDIO_ADMIN_PASSWORD",
      "LABEL_STUDIO_USERNAME",
      "LABEL_STUDIO_PASSWORD",
      "label_studio_admin_email",
      "label_studio_admin_password",
      "aws_secretsmanager_secret.ls_admin_email.arn",
      "aws_secretsmanager_secret.ls_admin_password.arn",
    ],
  },
];

export const PROJECT_OWNED_TABLES = [
  "projects",
  "pages",
  "annotations",
  "annotationGroups",
  "annotationGroupMembers",
  "takeoffItems",
  "takeoffGroups",
  "qtoWorkflows",
  "labelingSessions",
  "labelStudioAssetGrants",
  "labelStudioProjectIntents",
  "chatMessages",
  "processingJobs",
  "projectMutationLeases",
];

/**
 * Tables whose project FK is attribution rather than ownership. These are derived from schema just
 * like protected tables, then subtracted only after this exact policy/writer inventory is checked.
 * compute_usage contains short-lived quota reservations (hence its narrowly named update/delete
 * writers) plus completed metering rows; it does not contain project content and its nullable FK is
 * deliberately cleared when a project is deleted.
 */
export const PROJECT_FK_TABLE_EXEMPTIONS = [
  {
    table: "computeUsage",
    sqlTable: "compute_usage",
    policy: "billing-attribution-ledger",
    projectReference: { nullable: true, onDelete: "set null" },
    reason:
      "Compute metering survives project deletion and cannot publish project content.",
    writers: [
      ["src/lib/compute-usage.ts", "recordComputeUsage", "insert"],
      ["src/lib/compute-usage.ts", "releaseReservation", "delete"],
      ["src/lib/compute-usage.ts", "reserveSagemakerPages", "insert"],
      ["src/lib/compute-usage.ts", "stampReservationJob", "update"],
    ],
  },
];

/**
 * Stable database backstop inventory. Adding a project-owned table is deliberately a two-part
 * change: classify it above, then name the trigger that serializes its writes with the project
 * lifecycle row here. The checker requires exact, bidirectional coverage of this inventory and
 * the migration, so a silently unprotected child table cannot land.
 */
export const DEMO_WRITE_TRIGGER_MIGRATION =
  "drizzle/0033_project_lifecycle_epoch_and_leases.sql";

export const DEMO_WRITE_TRIGGER_INVENTORY = [
  {
    table: "annotationGroupMembers",
    sqlTable: "annotation_group_members",
    trigger: "annotation_group_members_demo_write_guard",
    function: "bp_guard_annotation_group_member",
  },
  {
    table: "annotationGroups",
    sqlTable: "annotation_groups",
    trigger: "annotation_groups_demo_write_guard",
    function: "bp_guard_direct_project_child",
    argument: "project_id",
  },
  {
    table: "annotations",
    sqlTable: "annotations",
    trigger: "annotations_demo_write_guard",
    function: "bp_guard_direct_project_child",
    argument: "project_id",
  },
  {
    table: "chatMessages",
    sqlTable: "chat_messages",
    trigger: "chat_messages_demo_write_guard",
    function: "bp_guard_direct_project_child",
    argument: "project_id",
  },
  {
    table: "labelStudioAssetGrants",
    sqlTable: "label_studio_asset_grants",
    trigger: "label_studio_asset_grants_demo_write_guard",
    function: "bp_guard_direct_project_child",
    argument: "project_id",
    migration: "drizzle/0037_label_studio_asset_grants.sql",
  },
  {
    table: "labelStudioProjectIntents",
    sqlTable: "label_studio_project_intents",
    trigger: "label_studio_project_intents_demo_write_guard",
    function: "bp_guard_direct_project_child",
    argument: "project_id",
    migration: "drizzle/0035_label_studio_project_intents.sql",
  },
  {
    table: "labelingSessions",
    sqlTable: "labeling_sessions",
    trigger: "labeling_sessions_demo_write_guard",
    function: "bp_guard_direct_project_child",
    argument: "project_id",
  },
  {
    table: "pages",
    sqlTable: "pages",
    trigger: "pages_demo_write_guard",
    function: "bp_guard_direct_project_child",
    argument: "project_id",
  },
  {
    table: "processingJobs",
    sqlTable: "processing_jobs",
    trigger: "processing_jobs_demo_write_guard",
    function: "bp_guard_direct_project_child",
    argument: "project_id",
  },
  {
    table: "projectMutationLeases",
    sqlTable: "project_mutation_leases",
    trigger: "project_mutation_leases_demo_write_guard",
    function: "bp_guard_direct_project_child",
    argument: "project_id",
  },
  {
    table: "projects",
    sqlTable: "projects",
    trigger: "projects_lifecycle_guard",
    function: "bp_guard_project_lifecycle",
  },
  {
    table: "qtoWorkflows",
    sqlTable: "qto_workflows",
    trigger: "qto_workflows_demo_write_guard",
    function: "bp_guard_direct_project_child",
    argument: "project_id",
  },
  {
    table: "takeoffGroups",
    sqlTable: "takeoff_groups",
    trigger: "takeoff_groups_demo_write_guard",
    function: "bp_guard_direct_project_child",
    argument: "project_id",
  },
  {
    table: "takeoffItems",
    sqlTable: "takeoff_items",
    trigger: "takeoff_items_demo_write_guard",
    function: "bp_guard_direct_project_child",
    argument: "project_id",
  },
];

const durableMutation = (id, sourceFile, symbol, kind, options = {}) => ({
  id,
  sourceFile,
  symbol,
  kind,
  ...options,
});

/**
 * Named operations that cross a long external await after obtaining project authority. They must
 * hold a durable, heartbeated lease rather than a database transaction while AWS/S3/Label Studio
 * work is in flight. Ordinary database publications inside them still require withProjectWrite.
 */
export const DURABLE_MUTATION_DOMAINS = [
  durableMutation(
    "admin-reprocess",
    "src/server/services/reprocess.ts",
    "reprocessProjects",
    "admin-reprocess:",
    { kindPrefix: true, requireIdempotencyKey: true },
  ),
  durableMutation(
    "labeling-session-create",
    "src/server/services/labeling.ts",
    "createLabelingSessions",
    "labeling-session-create",
    { requireIdempotencyKey: true },
  ),
  durableMutation(
    "process-project",
    "src/lib/processing.ts",
    "processProject",
    "project-processing",
    { requireIdempotencyKey: true },
  ),
  durableMutation(
    "project-processing-start",
    "src/server/services/projects.ts",
    "createProject",
    "processing-start",
    { requireIdempotencyKey: true },
  ),
  durableMutation(
    "yolo-load",
    "src/server/services/yolo.ts",
    "yoloLoad",
    "yolo-load",
    { requireIdempotencyKey: true },
  ),
  durableMutation(
    "yolo-run",
    "src/server/services/yolo.ts",
    "yoloRun",
    "yolo-run",
    { requireIdempotencyKey: true },
  ),
  // [2026-10-22] Root-only batched run: the same yolo-run lease (project:model) held per project.
  durableMutation(
    "yolo-run-batch",
    "src/server/services/yolo-batch-run.ts",
    "withRunLeases",
    "yolo-run",
    { requireIdempotencyKey: true },
  ),
];

const mutation = (id, route, method, policy, checks) => ({
  id,
  route,
  method,
  policy,
  routeFile: `src/app/api${route.slice("/api".length)}/route.ts`,
  checks,
});

export const MUTATION_SURFACES = [
  mutation("annotations-create", "/api/annotations", "POST", "shared-guard", [
    ["src/server/services/annotations.ts", "createAnnotationBatch"],
    ["src/server/services/annotations.ts", "createAnnotationSingle"],
  ]),
  mutation(
    "annotations-split",
    "/api/annotations/split",
    "POST",
    "shared-guard",
    [["src/server/services/annotations.ts", "splitAnnotation"]],
  ),
  mutation(
    "annotations-update",
    "/api/annotations/[id]",
    "PUT",
    "shared-guard",
    [["src/server/services/annotations.ts", "updateAnnotation"]],
  ),
  mutation(
    "annotations-delete",
    "/api/annotations/[id]",
    "DELETE",
    "shared-guard",
    [["src/server/services/annotations.ts", "deleteAnnotation"]],
  ),
  mutation(
    "annotations-batch-delete",
    "/api/annotations/batch-delete",
    "POST",
    "shared-guard",
    [["src/server/services/annotations.ts", "batchDeleteAnnotations"]],
  ),

  mutation(
    "annotation-groups-create",
    "/api/annotation-groups",
    "POST",
    "shared-guard",
    [["src/server/services/annotation-groups.ts", "createAnnotationGroup"]],
  ),
  mutation(
    "annotation-groups-update",
    "/api/annotation-groups/[id]",
    "PUT",
    "shared-guard",
    [["src/server/services/annotation-groups.ts", "updateAnnotationGroup"]],
  ),
  mutation(
    "annotation-groups-delete",
    "/api/annotation-groups/[id]",
    "DELETE",
    "shared-guard",
    [["src/server/services/annotation-groups.ts", "deleteAnnotationGroup"]],
  ),
  mutation(
    "annotation-groups-members-add",
    "/api/annotation-groups/[id]/members",
    "POST",
    "shared-guard",
    [["src/server/services/annotation-groups.ts", "addGroupMembers"]],
  ),
  mutation(
    "annotation-groups-members-remove",
    "/api/annotation-groups/[id]/members",
    "DELETE",
    "shared-guard",
    [["src/server/services/annotation-groups.ts", "removeGroupMembers"]],
  ),

  mutation(
    "takeoff-items-create",
    "/api/takeoff-items",
    "POST",
    "shared-guard",
    [["src/server/services/takeoff.ts", "createTakeoffItem"]],
  ),
  mutation(
    "takeoff-items-update",
    "/api/takeoff-items/[id]",
    "PUT",
    "shared-guard",
    [["src/server/services/takeoff.ts", "updateTakeoffItem"]],
  ),
  mutation(
    "takeoff-items-delete",
    "/api/takeoff-items/[id]",
    "DELETE",
    "shared-guard",
    [["src/server/services/takeoff.ts", "deleteTakeoffItem"]],
  ),
  mutation(
    "takeoff-groups-create",
    "/api/takeoff-groups",
    "POST",
    "shared-guard",
    [["src/server/services/takeoff.ts", "createTakeoffGroup"]],
  ),
  mutation(
    "takeoff-groups-update",
    "/api/takeoff-groups/[id]",
    "PUT",
    "shared-guard",
    [["src/server/services/takeoff.ts", "updateTakeoffGroup"]],
  ),
  mutation(
    "takeoff-groups-delete",
    "/api/takeoff-groups/[id]",
    "DELETE",
    "shared-guard",
    [["src/server/services/takeoff.ts", "deleteTakeoffGroup"]],
  ),

  mutation("qto-create", "/api/qto-workflows", "POST", "shared-guard", [
    ["src/server/services/qto-workflows.ts", "createQtoWorkflow"],
  ]),
  mutation("qto-update", "/api/qto-workflows/[id]", "PUT", "shared-guard", [
    ["src/server/services/qto-workflows.ts", "updateQtoWorkflow"],
  ]),
  mutation("qto-delete", "/api/qto-workflows/[id]", "DELETE", "shared-guard", [
    ["src/server/services/qto-workflows.ts", "deleteQtoWorkflow"],
  ]),

  mutation("page-rename", "/api/pages/update", "POST", "shared-guard", [
    ["src/server/services/pages.ts", "updatePageName"],
  ]),
  mutation(
    "page-intelligence",
    "/api/pages/intelligence",
    "PATCH",
    "shared-guard",
    [["src/server/services/pages.ts", "updatePageIntelligence"]],
  ),
  mutation(
    "page-textract-rerun",
    "/api/pages/textract-rerun",
    "POST",
    "inline-demo-denial",
    [["src/server/services/pages.ts", "rerunPageTextract"]],
  ),
  mutation(
    "page-csi-recompute",
    "/api/pages/csi-recompute",
    "POST",
    "shared-guard",
    [["src/server/services/pages.ts", "recomputePageCsi"]],
  ),
  // [classifier-builder 2026-10-24] Proposal verdicts: one user label per stored classifier proposal,
  // features snapshotted server-side; demo refused for every role by assertProjectWritable.
  mutation(
    "proposal-verdict-record",
    "/api/projects/[id]/proposals/verdict",
    "POST",
    "shared-guard",
    [["src/server/services/proposal-verdicts.ts", "recordProposalVerdict"]],
  ),
  mutation(
    "proposal-verdict-delete",
    "/api/projects/[id]/proposals/verdict",
    "DELETE",
    "shared-guard",
    [["src/server/services/proposal-verdicts.ts", "deleteProposalVerdict"]],
  ),
  mutation("region-promote", "/api/regions/promote", "POST", "shared-guard", [
    ["src/server/services/regions.ts", "promoteRegion"],
  ]),
  mutation("region-delete", "/api/regions", "DELETE", "inline-demo-denial", [
    ["src/app/api/regions/route.ts", null],
  ]),

  mutation("project-update", "/api/projects/[id]", "PUT", "shared-guard", [
    ["src/server/services/projects.ts", "updateProject"],
  ]),
  mutation("project-delete", "/api/projects/[id]", "DELETE", "shared-guard", [
    ["src/server/services/projects.ts", "deleteProject"],
  ]),
  mutation("project-create", "/api/projects", "POST", "new-private-project", [
    ["src/server/services/projects.ts", "createProject"],
  ]),

  mutation("chat-post", "/api/ai/chat", "POST", "demo-read-only", [
    ["src/server/services/ai-chat.ts", "chatPost"],
    ["src/lib/services/chat/scoped.ts", "handleScopedChat"],
  ]),
  mutation("chat-delete", "/api/ai/chat", "DELETE", "shared-guard", [
    ["src/server/services/ai-chat.ts", "chatDelete"],
  ]),
  mutation("demo-chat-post", "/api/demo/chat", "POST", "demo-read-only", [
    ["src/app/api/demo/chat/route.ts", "POST"],
    ["src/lib/llm/stream.ts", "streamChatResponse"],
  ]),

  // [2026-10-23] run/load are root-only: the shells reach the services through the root gate
  // (services/yolo-root-gate.ts — demo preflight, then root), which delegates to the durable domains.
  mutation("yolo-run", "/api/yolo/run", "POST", "shared-guard", [
    ["src/server/services/yolo-root-gate.ts", "yoloRunRootOnly"],
    ["src/server/services/yolo.ts", "yoloRun"],
  ]),
  mutation("yolo-run-batch", "/api/yolo/run-batch", "POST", "shared-guard", [
    ["src/server/services/yolo-batch-run.ts", "yoloRunBatch"],
  ]),
  mutation("yolo-load", "/api/yolo/load", "POST", "shared-guard", [
    ["src/server/services/yolo-root-gate.ts", "yoloLoadRootOnly"],
    ["src/server/services/yolo.ts", "yoloLoad"],
  ]),
  mutation("labeling-create", "/api/labeling/create", "POST", "shared-guard", [
    ["src/server/services/labeling.ts", "createLabelingSessions"],
  ]),
  mutation(
    "labeling-delete",
    "/api/labeling/sessions/[id]",
    "DELETE",
    "shared-guard",
    [["src/server/services/labeling.ts", "deleteLabelingSession"]],
  ),
  mutation("processing-dev", "/api/processing/dev", "POST", "shared-guard", [
    ["src/server/services/processing-routes.ts", "processingDev"],
  ]),
  mutation(
    "processing-webhook",
    "/api/processing/webhook",
    "POST",
    "shared-guard",
    [["src/server/services/processing-routes.ts", "processingWebhook"]],
  ),

  mutation(
    "admin-reprocess",
    "/api/admin/reprocess",
    "POST",
    "batch-non-demo",
    [["src/server/services/reprocess.ts", "reprocessProjects"]],
  ),
  // [classifier builder track 3 2026-10-24] Admin › Classifiers "Run on project": ONE project of the
  // caller's company through reprocessProjects (scope=classifiers) — its lease, demo exclusion and stream.
  mutation(
    "admin-classifiers-run",
    "/api/admin/classifiers/run",
    "POST",
    "shared-guard",
    [["src/server/services/classifier-builder.ts", "runClassifiersOnProject"]],
  ),
  mutation(
    "admin-reprocess-csi",
    "/api/admin/models/reprocess-csi",
    "POST",
    "batch-tenant-non-demo",
    [["src/server/services/reprocess-csi.ts", "reprocessCsi"]],
  ),
  // [2026-10-23] Route is auth:"root" (company-scoped purge unchanged).
  mutation(
    "admin-yolo-purge",
    "/api/admin/yolo-purge",
    "DELETE",
    "batch-non-demo",
    [["src/server/services/yolo-admin.ts", "purgeYolo"]],
  ),
  mutation(
    "admin-duplicates-apply",
    "/api/admin/duplicates/apply",
    "POST",
    "batch-non-demo",
    [["src/server/services/page-duplicates-apply.ts", "applyDuplicates"]],
  ),
  mutation(
    "admin-duplicates-apply-selection",
    "/api/admin/duplicates/apply-selection",
    "POST",
    "shared-guard",
    [["src/server/services/page-duplicates-select.ts", "applyDuplicateSelection"]],
  ),
  mutation(
    "admin-project-duplicates-delete",
    "/api/admin/project-duplicates/delete",
    "POST",
    "batch-non-demo",
    [["src/server/services/project-duplicates.ts", "deleteProjectDuplicates"]],
  ),
  mutation(
    "admin-annotation-cleanup",
    "/api/admin/annotation-cleanup",
    "POST",
    "batch-non-demo",
    [["src/server/services/annotation-cleanup.ts", "runAnnotationCleanup"]],
  ),
  // [clf step 4 2026-10-24] Root-only, read-only weight fit over one company's non-demo verdicts (dryRun only).
  mutation(
    "admin-classifiers-fit",
    "/api/admin/classifiers/fit",
    "POST",
    "batch-non-demo",
    [["src/server/services/classifier-fit.ts", "fitCompanyClassifiers"]],
  ),
  mutation(
    "admin-duplicates-restore",
    "/api/admin/duplicates/restore",
    "POST",
    "shared-guard",
    [["src/server/services/page-duplicates-apply.ts", "restoreDuplicates"]],
  ),
  mutation(
    "admin-duplicates-delete-hidden",
    "/api/admin/duplicates/delete-hidden",
    "POST",
    "batch-non-demo",
    [["src/server/services/page-permanent-delete.ts", "deleteHiddenPages"]],
  ),
  mutation(
    "admin-running-jobs",
    "/api/admin/running-jobs",
    "PUT",
    "indirect-session-guard",
    [["src/server/services/running-jobs.ts", "updateRunningJob"]],
  ),
  mutation(
    "admin-stuck-jobs-reconcile",
    "/api/admin/stuck-jobs/reconcile",
    "POST",
    "shared-guard",
    [["src/server/services/stuck-jobs.ts", "reconcileStuckJobs"]],
  ),
  mutation(
    "admin-stuck-jobs-force-release",
    "/api/admin/stuck-jobs/force-release",
    "POST",
    "shared-guard",
    [["src/server/services/stuck-jobs.ts", "forceReleaseStuckLeases"]],
  ),
  mutation(
    "admin-user-delete",
    "/api/admin/users",
    "DELETE",
    "demo-aware-lifecycle",
    [["src/server/services/admin-users.ts", "deleteUser"]],
  ),
  mutation(
    "admin-demo-lifecycle",
    "/api/admin/demo",
    "POST",
    "lifecycle-exception",
    [["src/server/services/demo.ts", "manageDemo"]],
  ),
];

export const INTERNAL_MUTATION_SINKS = [
  // The one duplicate-page hide path (apply + apply-selection): withProjectWrite per project.
  [
    "src/server/services/page-duplicates-apply.ts",
    "applyPlannedHides",
    "atomic-project-write",
  ],
  // [2026-10-24] Project analysis + summaries refresh after a visible-page change (permanent
  // delete, duplicate hide/restore): withProjectWrite on the projects row, then computeProjectSummaries.
  [
    "src/server/services/project-recompute.ts",
    "recomputeProject",
    "atomic-project-write",
  ],
  [
    "src/lib/project-analysis.ts",
    "computeProjectSummaries",
    "atomic-project-write",
  ],
  [
    "src/lib/project-analysis.ts",
    "patchProjectSummaries",
    "atomic-project-write",
  ],
  [
    "src/lib/project-delete.ts",
    "deleteProjectFully",
    "atomic-project-storage-write",
  ],
  [
    "src/lib/label-studio-asset-grant.ts",
    "activateLabelStudioAssetGrants",
    "project-write-transaction-helper",
  ],
  [
    "src/lib/label-studio-asset-grant.ts",
    "deleteIntentLabelStudioAssetGrants",
    "project-write-transaction-helper",
  ],
  [
    "src/lib/label-studio-asset-grant.ts",
    "deleteSessionLabelStudioAssetGrants",
    "project-write-transaction-helper",
  ],
  [
    "src/lib/label-studio-asset-grant.ts",
    "revokeIntentLabelStudioAssetGrants",
    "project-write-transaction-helper",
  ],
  [
    "src/lib/label-studio-asset-grant.ts",
    "revokeSessionLabelStudioAssetGrants",
    "project-write-transaction-helper",
  ],
  [
    "src/lib/label-studio-project-intent.ts",
    "reconcileLabelStudioProjectIntent",
    "parent-locked-project-intent",
  ],
  [
    "src/lib/label-studio-session-retirement.ts",
    "reconcileLabelStudioSessionRetirement",
    "leased-reclaimable-session-retirement",
  ],
  ["src/lib/processing.ts", "processProject", "atomic-project-write"],
  [
    "src/server/services/regions.ts",
    "deleteParsedRegion",
    "atomic-project-write",
  ],
  // [fix 2026-10-21 reprocess-persistence] the one shape-parse page swap (pages.keynotes +
  // source='shape-parse' annotations, one tx). Callers: reprocess-shape-parse (admin
  // reprocess, under its durable lease) and shape-parse.ts (viewer, non-demo only).
  [
    "src/server/services/shape-parse-persist.ts",
    "swapShapeParsePage",
    "atomic-project-write",
  ],
  // [fix 2026-10-22] upload pipeline (lib/processing.ts, under its processing lease): replace
  // one page's source='shape-parse' annotation rows (delete + insert, one tx).
  [
    "src/server/services/shape-parse-persist.ts",
    "replaceShapeParseAnnotations",
    "atomic-project-write",
  ],
  // [evidence T4 2026-10-24] admin reprocess scope=evidence (under the reprocess lease): merge
  // ONE key, pageIntelligence.evidence, into one page row via withProjectWrite.
  [
    "src/server/services/reprocess-evidence.ts",
    "writeEvidence",
    "atomic-project-write",
  ],
  // [tiles T9 2026-10-24] Reprocess "Tile images": merge the manifest pointer into
  // pageIntelligence.tiles (one page per tx) under the admin-reprocess lease.
  [
    "src/server/services/reprocess-tiles.ts",
    "persistPageTiles",
    "atomic-project-write",
  ],
  // [census F2 2026-10-24] Upload channel census: merge ONE key, projectIntelligence.channels (kind
  // counts + shares), under the caller's capability — upload pipeline (processing lease) and the
  // Reprocess "PDF channels" stage (admin-reprocess lease).
  [
    "src/server/services/channel-census.ts",
    "writeProjectChannels",
    "atomic-project-write",
  ],
  // [census F2 2026-10-24] Upload (after the page loop) and Reprocess "PDF channels": merge
  // pageIntelligence.channels into every page row of one project (one tx) under the caller's capability.
  [
    "src/server/services/channel-census.ts",
    "persistPageChannels",
    "atomic-project-write",
  ],
  // [graph T8 2026-10-24] Knowledge graph: merge ONE key, projectIntelligence.knowledgeGraph (the
  // compact summary; the graph itself is an S3 object under the project's data prefix), under the
  // caller's capability — upload pipeline, intelligence reprocess, recomputeProject, scope=graph.
  [
    "src/server/services/project-graph.ts",
    "writeSummary",
    "atomic-project-write",
  ],
  // [cross-set F3 2026-10-24] Cross-set links: merge ONE key, projectIntelligence.crossSetLinks (publicIds
  // + counts; the links are an S3 object under the project's data prefix), under the caller's
  // capability — upload end (lib/processing.ts) and scope=cross-set (under the reprocess lease).
  [
    "src/server/services/cross-set-links.ts",
    "writeCrossSetSummary",
    "atomic-project-write",
  ],
  // [tag-mapping v2 2026-10-24] Tag families: merge ONE key, projectIntelligence.tagFamilies, in one
  // tx under the caller's capability — yolo/load (its durable lease) and the intelligence reprocess.
  [
    "src/server/services/tag-families-write.ts",
    "writeProjectTagFamilies",
    "atomic-project-write",
  ],
  // [classifier engine 2a 2026-10-24] Classifier proposals: merge ONE key, projectIntelligence.proposals
  // (the compact list), in one tx under the caller's capability — yolo/load, the intelligence reprocess
  // and scope=classifiers.
  [
    "src/server/services/classifier-proposals-write.ts",
    "writeProjectProposals",
    "atomic-project-write",
  ],
  // [classifier engine 2a 2026-10-24] Reprocess "Classifiers" stage (admin-reprocess lease): jsonb-merge
  // ONE key, pageIntelligence.classifierProposals, per changed page under the caller's capability.
  [
    "src/server/services/reprocess-classifiers.ts",
    "reprocessClassifiersScope",
    "atomic-project-write",
  ],
  ["src/lib/llm/stream.ts", "streamChatResponse", "atomic-or-no-persist"],
  [
    "src/lib/services/chat/scoped.ts",
    "handleScopedChat",
    "atomic-or-no-persist",
  ],
  ["src/lib/llm/tools.ts", "executeToolCall", "atomic-tool-write"],
  [
    "src/server/api/project-write-capability.ts",
    "acquireProjectMutationLease",
    "atomic-project-write",
  ],
  [
    "src/server/api/project-write-capability.ts",
    "heartbeatProjectMutationLease",
    "atomic-project-write",
  ],
  [
    "src/server/api/project-write-capability.ts",
    "releaseProjectMutationLease",
    "atomic-project-write",
  ],
  [
    "src/server/api/project-write-capability.ts",
    "forceReleaseWebHeldLeases",
    "atomic-project-write",
  ],
  [
    "src/server/services/ingest-reconcile.ts",
    "reconcileIngestJob",
    "atomic-project-write",
  ],
];

const projection = (symbol, fields) => ({ kind: "projection", symbol, fields });
const debt = (tracking, reason) => ({ kind: "debt", tracking, reason });

const publicSurface = (id, route, method, policy, sources, contract) => ({
  id,
  route,
  method,
  policy,
  routeFile: `src/app/api${route.slice("/api".length)}/route.ts`,
  sources,
  contract,
});

export const PUBLIC_DEMO_SURFACES = [
  publicSurface(
    "demo-project-list",
    "/api/demo/projects",
    "GET",
    "strict-public-shape",
    ["src/server/services/projects.ts"],
    projection("listDemoProjects", [
      "[].id",
      "[].name",
      "[].numPages",
      "[].status",
      "[].thumbnailUrl",
    ]),
  ),
  publicSurface(
    "demo-project-detail",
    "/api/demo/projects/[id]",
    "GET",
    "requires-redaction",
    ["src/server/services/projects.ts"],
    debt(
      "L5-public-project-detail",
      "Replace the bootstrap row/JSONB denylist with a recursive public serializer.",
    ),
  ),
  publicSurface(
    "demo-page-window",
    "/api/demo/projects/[id]/pages",
    "GET",
    "requires-redaction",
    ["src/server/services/pages.ts"],
    debt(
      "L5-public-page-window",
      "Nested OCR, intelligence, and annotation JSONB still require positive serializers.",
    ),
  ),
  publicSurface(
    "demo-thumbnail",
    "/api/projects/[id]/thumbnail/[page]",
    "GET",
    "public-asset",
    ["src/server/services/pages.ts"],
    debt(
      "L5-public-thumbnail-asset",
      "Binary public-asset headers and key non-disclosure remain runtime-pinned.",
    ),
  ),
  publicSurface(
    "project-asset-gateway",
    "/api/project-assets/[id]/[...asset]",
    "GET",
    "public-asset",
    ["src/server/services/project-assets.ts"],
    debt(
      "P2-private-asset-gateway",
      "Exact browser asset allowlist, tenant/demo access, current-row lifecycle/root/rebuild admission, forced MIME, abort-bound Range forwarding, storage-key non-disclosure, bounded PDF transport, and all-outcome no-store delivery are runtime-pinned.",
    ),
  ),
  publicSurface(
    "label-studio-asset-grant",
    "/api/label-assets/[id]",
    "GET",
    "anonymous-bearer-asset",
    ["src/lib/label-studio-asset-grant.ts"],
    debt(
      "P2-label-studio-asset-grant",
      "Anonymous access is limited to hashed, revocable bearer grants over exact immutable snapshot versions; exact active provisioning-lease admission, owner/lifecycle locking, generic misses, narrow Label Studio CORS, and a dedicated bounded IP rate bucket are runtime-pinned.",
    ),
  ),
  publicSurface(
    "demo-textract",
    "/api/pages/textract",
    "GET",
    "owner-threat-model-debt",
    ["src/server/services/pages.ts"],
    debt(
      "L5-public-textract",
      "Full provider OCR JSON needs a versioned public primitive allowlist.",
    ),
  ),
  publicSurface(
    "demo-search",
    "/api/demo/search",
    "GET",
    "strict-public-shape",
    ["src/server/services/search.ts"],
    projection("searchGallery", [
      "query",
      "results[].matchCount",
      "results[].pageCount",
      "results[].projectId",
      "results[].projectName",
    ]),
  ),
  publicSurface(
    "demo-csi",
    "/api/demo/csi",
    "GET",
    "owner-threat-model-debt",
    ["src/app/api/demo/csi/route.ts"],
    debt(
      "L5-public-csi",
      "Custom CSI vocabulary publication policy is owner threat-model debt.",
    ),
  ),
  publicSurface(
    "demo-labeling",
    "/api/demo/labeling/sessions",
    "GET",
    "strict-public-shape",
    ["src/server/services/labeling.ts"],
    projection("listDemoLabelingSessions", [
      "[].id",
      "[].labelStudioUrl",
      "[].pageRange",
      "[].taskCount",
      "[].taskType",
    ]),
  ),
  publicSurface(
    "demo-admin",
    "/api/demo/admin",
    "GET",
    "strict-public-shape",
    ["src/server/services/demo-landing.ts"],
    projection("serializePublicDemoAdminBundle", [
      "models[].id",
      "models[].isDefault",
      "models[].name",
      "models[].type",
      "pipelineConfig.demo",
      "projects[].id",
      "projects[].isDemo",
      "projects[].name",
      "projects[].numPages",
      "projects[].status",
      "toggles.hasPassword",
      "toggles.quotaEnabled",
      "toggles.sagemakerEnabled",
      "yoloStatus",
    ]),
  ),
  publicSurface(
    "demo-config",
    "/api/demo/config",
    "GET",
    "strict-public-shape",
    ["src/server/services/demo-landing.ts"],
    projection("serializePublicHeaderLinks", [
      "headerLinks.hded",
      "headerLinks.home",
      "headerLinks.labelFleet",
      "headerLinks.modelExchange",
      "headerLinks.planExchange",
    ]),
  ),
  publicSurface(
    "demo-domain-knowledge",
    "/api/demo/domain-knowledge",
    "GET",
    "public-asset",
    ["src/server/services/demo-landing.ts"],
    debt(
      "L5-public-domain-asset",
      "Raw bundled text asset is non-JSON and remains hash/content pinned.",
    ),
  ),
  publicSurface(
    "demo-export",
    "/api/projects/[id]/export",
    "GET",
    "requires-auth",
    ["src/server/services/export.ts"],
    debt(
      "B2-authenticated-export-only",
      "No anonymous demo export projection is permitted.",
    ),
  ),
  publicSurface(
    "demo-annotation-groups",
    "/api/annotation-groups",
    "GET",
    "requires-empty-or-redaction",
    ["src/server/services/annotation-groups.ts"],
    debt(
      "B2-public-demo-groups-empty",
      "Demo response is explicitly empty until a public group schema exists.",
    ),
  ),
  publicSurface(
    "demo-map-tags",
    "/api/projects/[id]/map-tags-batch",
    "POST",
    "requires-public-input-filter",
    ["src/server/services/map-tags.ts"],
    debt(
      "B2-public-map-tags-compute",
      "Public input filtering is enforced semantically; output schema remains runtime-pinned.",
    ),
  ),
  publicSurface(
    "demo-bucket-fill",
    "/api/bucket-fill",
    "POST",
    "owner-threat-model-debt",
    ["src/server/services/bucket-fill.ts"],
    debt(
      "L5-public-bucket-fill",
      "Owner-approved raster compute input/output policy remains explicit debt.",
    ),
  ),
  publicSurface(
    "demo-shape-parse",
    "/api/shape-parse",
    "POST",
    "owner-threat-model-debt",
    ["src/server/services/shape-parse.ts"],
    debt(
      "L5-public-shape-parse",
      "Owner-approved compute input/output policy remains explicit debt.",
    ),
  ),
  publicSurface(
    "demo-symbol-search",
    "/api/symbol-search",
    "POST",
    "owner-threat-model-debt",
    ["src/server/services/symbol-search.ts"],
    debt(
      "L5-public-symbol-search",
      "Owner-approved compute input/output policy remains explicit debt.",
    ),
  ),
  publicSurface(
    "demo-table-parse",
    "/api/table-parse",
    "POST",
    "owner-threat-model-debt",
    ["src/server/services/table-parse.ts"],
    debt(
      "L5-public-table-parse",
      "Owner-approved compute input/output policy remains explicit debt.",
    ),
  ),
  publicSurface(
    "demo-table-structure",
    "/api/table-structure",
    "POST",
    "owner-threat-model-debt",
    ["src/server/services/table-structure.ts"],
    debt(
      "L5-public-table-structure",
      "Owner-approved compute input/output policy remains explicit debt.",
    ),
  ),
  publicSurface(
    "demo-notes-parse",
    "/api/notes-parse",
    "POST",
    "owner-threat-model-debt",
    [
      "src/server/services/notes-parse.ts",
      "src/server/services/region-parse-shared.ts",
    ],
    debt(
      "L5-public-notes-parse",
      "Owner-approved compute input/output policy remains explicit debt.",
    ),
  ),
  publicSurface(
    "demo-notes-propose",
    "/api/notes-parse/propose",
    "POST",
    "owner-threat-model-debt",
    [
      "src/server/services/notes-parse.ts",
      "src/server/services/region-parse-shared.ts",
    ],
    debt(
      "L5-public-notes-propose",
      "Owner-approved compute input/output policy remains explicit debt.",
    ),
  ),
  publicSurface(
    "demo-spec-parse",
    "/api/spec-parse",
    "POST",
    "owner-threat-model-debt",
    [
      "src/server/services/spec-parse.ts",
      "src/server/services/region-parse-shared.ts",
    ],
    debt(
      "L5-public-spec-parse",
      "Owner-approved compute input/output policy remains explicit debt.",
    ),
  ),
  publicSurface(
    "demo-spec-propose",
    "/api/spec-parse/propose",
    "POST",
    "owner-threat-model-debt",
    [
      "src/server/services/spec-parse.ts",
      "src/server/services/region-parse-shared.ts",
    ],
    debt(
      "L5-public-spec-propose",
      "Owner-approved compute input/output policy remains explicit debt.",
    ),
  ),
  publicSurface(
    "demo-scoped-chat",
    "/api/ai/chat",
    "POST",
    "requires-private-canary-exclusion",
    ["src/server/services/ai-chat.ts", "src/lib/services/chat/scoped.ts"],
    debt(
      "B2-public-demo-chat-stream",
      "SSE output is non-JSON; private-context exclusion/no-persist/tool policy is semantic.",
    ),
  ),
  publicSurface(
    "demo-global-chat",
    "/api/demo/chat",
    "POST",
    "requires-zero-persistence",
    ["src/app/api/demo/chat/route.ts", "src/lib/llm/stream.ts"],
    debt(
      "B2-global-demo-chat-stream",
      "SSE output is non-JSON; zero persistence is enforced semantically.",
    ),
  ),
];

/** Shared helpers that intentionally query demo-only state for one of the public surfaces above. */
export const PUBLIC_DEMO_SHARED_DEPENDENCIES = [
  {
    sourceFile: "src/lib/quotas.ts",
    consumers: ["demo-scoped-chat", "demo-global-chat"],
  },
];

/** Central access-policy modules that deliberately enable demo visibility before applying a
 * stricter public-read or all-role write-denial policy at the same boundary. */
export const DEMO_RESOLVER_SHARED_DEPENDENCIES = [
  {
    sourceFile: "src/server/api/access.ts",
    consumers: ["all-role-demo-write-guard"],
  },
];

export const LIFECYCLE_EXCEPTIONS = [
  {
    id: "manage-demo-publish-withdraw",
    route: "/api/admin/demo",
    method: "POST",
    sourceFile: "src/server/services/demo.ts",
    symbol: "manageDemo",
    allowedColumns: ["isDemo", "lifecycleEpoch", "updatedAt"],
  },
];

export const EXPLICIT_NON_PUBLIC_DEMO_SURFACES = [
  {
    route: "/api/search",
    method: "GET",
    sourceFile: "src/server/services/search.ts",
    symbol: "searchProjectPages",
    policy: "deny-demo",
  },
  {
    route: "/api/table-parse/propose",
    method: "POST",
    sourceFile: "src/server/services/table-parse-propose.ts",
    symbol: "tableParsePropose",
    policy: "deny-demo",
  },
];

/**
 * [2026-10-25] Root authenticator-app (TOTP) two-factor — MANDATORY. Every surface is a defineRoute
 * shell over ONE service module. A root login that has not enrolled ("enroll") or not proved a code
 * in this session ("verify") is projected by the session callback as a session WITHOUT a user, so
 * every auth level fails closed; the four GATED surfaces (status / enroll / confirm / verify) are
 * therefore auth:"none" shells whose service identifies the caller from the encrypted cookie
 * (`callerFunction`, which re-reads users.isRootAdmin). Enroll, disable and regenerate also require
 * the account password (`password: true`). Every code/password-taking surface is bounded by its own
 * user-keyed middleware rule that root is never exempt from, plus the persistent lockout ladder in
 * the enrollment row. The enrollment document lives in app_settings under `settingKeyPrefix`,
 * hidden from and unwritable through the generic settings route; the only other writer is the
 * break-glass operation in root_admin.sh, which now also inserts an audit_log row. `enforceEnv`=0
 * is the logged emergency off-switch (lib/root-two-factor-claims.ts rootTwoFactorEnforced).
 */
export const ROOT_TWO_FACTOR_POLICY = {
  settingKeyPrefix: "root-2fa:",
  enforceEnv: "ROOT_2FA_ENFORCE",
  claimsFile: "src/lib/root-two-factor-claims.ts",
  serviceFile: "src/server/services/root-two-factor.ts",
  authFile: "src/lib/auth.ts",
  routeShellFile: "src/server/api/defineRoute.ts",
  rootAuthorityFile: "src/server/api/root-authority.ts",
  apiUtilsFile: "src/lib/api-utils.ts",
  appSettingsServiceFile: "src/server/services/app-settings.ts",
  rateRuleFile: "src/lib/middleware-rate-limit.ts",
  callerFunction: "requireRootTwoFactorCaller",
  passwordFunction: "assertAccountPassword",
  verifyRoute: "/api/auth/2fa/verify",
  /** Code/password-taking POST surfaces: exact user-keyed rule, limit ≤ 10, root never exempt. */
  throttledRoutes: [
    "/api/auth/2fa/verify",
    "/api/auth/2fa/enroll",
    "/api/auth/2fa/confirm",
    "/api/auth/2fa/disable",
    "/api/auth/2fa/backup-codes",
  ],
  breakGlass: { file: "root_admin.sh", operation: "reset2fa" },
  surfaces: [
    { id: "root-2fa-status", route: "/api/auth/2fa/status", method: "GET", auth: "none", gated: true, password: false, serviceFunction: "getRootTwoFactorStatus" },
    { id: "root-2fa-enroll", route: "/api/auth/2fa/enroll", method: "POST", auth: "none", gated: true, password: true, serviceFunction: "beginRootTwoFactorEnrollment" },
    { id: "root-2fa-confirm", route: "/api/auth/2fa/confirm", method: "POST", auth: "none", gated: true, password: false, serviceFunction: "confirmRootTwoFactorEnrollment" },
    { id: "root-2fa-verify", route: "/api/auth/2fa/verify", method: "POST", auth: "none", gated: true, password: false, serviceFunction: "verifyRootTwoFactor" },
    { id: "root-2fa-disable", route: "/api/auth/2fa/disable", method: "POST", auth: "root", gated: false, password: true, serviceFunction: "disableRootTwoFactor" },
    { id: "root-2fa-backup-codes", route: "/api/auth/2fa/backup-codes", method: "POST", auth: "root", gated: false, password: true, serviceFunction: "regenerateRootTwoFactorBackupCodes" },
  ].map((surface) => ({
    ...surface,
    routeFile: `src/app/api${surface.route.slice("/api".length)}/route.ts`,
  })),
};

/**
 * [2026-10-25 root hardening] THE root-only list. Owner rule: only root — with 2FA — may change
 * quotas / limits / usage caps, compute / infra / GPU settings and cost-bearing app settings, grant
 * or revoke model or feature access, change roles to admin, or trigger owner-billed bulk spend.
 * Every entry is either a shell with `auth: "root"` (the shell goes through requireVerifiedRoot) or
 * a shell at a lower level whose named service function re-checks the verified-root claim in
 * service (`inService`: the function calls requireVerifiedRoot / isVerifiedRoot, or reads the
 * projected `session.user.isRootAdmin`, which is the same claim — server/api/root-authority.ts).
 * A `conditional` entry is root-only for the condition named, admin-level otherwise.
 */
const rootOnly = (route, methods, extra = {}) => ({
  route,
  methods,
  routeFile: `src/app/api${route.slice("/api".length)}/route.ts`,
  ...extra,
});
export const ROOT_ONLY_SURFACES = [
  // quotas, limits, usage caps
  rootOnly("/api/admin/quota-overrides", ["GET", "PUT"], { inService: ["src/server/services/quota-overrides.ts", "putQuotaOverride"] }),
  rootOnly("/api/admin/usage", ["GET", "PUT"]),
  rootOnly("/api/admin/toggles", ["GET", "PUT"], { inService: ["src/server/services/toggles.ts", "updateToggle"] }),
  // compute / infra / GPU settings and cost-bearing app settings
  rootOnly("/api/admin/upload-compute", ["GET", "PUT"], { inService: ["src/server/services/upload-compute.ts", "putUploadComputePreset"] }),
  rootOnly("/api/admin/yolo-instance", ["GET", "PUT"], { inService: ["src/server/services/yolo-instance.ts", "putYoloInstanceType"] }),
  rootOnly("/api/admin/yolo-instance/options", ["GET"]),
  rootOnly("/api/admin/yolo-runtime", ["PUT"], { inService: ["src/server/services/yolo-instance.ts", "putYoloMaxRuntime"] }),
  rootOnly("/api/admin/tiles", ["GET", "PUT"], { inService: ["src/server/services/tiles-setting.ts", "putTilesSetting"] }),
  rootOnly("/api/admin/app-settings", ["PUT"], { shellAuth: "admin", inService: ["src/server/services/app-settings.ts", "putAppSetting"] }),
  // model / feature access and roles
  rootOnly("/api/admin/model-access", ["GET", "POST", "DELETE"]),
  rootOnly("/api/admin/models", ["POST"], { shellAuth: "admin", inService: ["src/server/services/models.ts", "registerModel"] }),
  rootOnly("/api/admin/models", ["PATCH"], { shellAuth: "admin", inService: ["src/server/services/models.ts", "shareModel"], conditional: "enabling access (non-root may only disable its own)" }),
  rootOnly("/api/admin/users", ["POST"], { shellAuth: "admin", inService: ["src/server/services/admin-users.ts", "createUser"], conditional: "role admin" }),
  rootOnly("/api/admin/users", ["PUT"], { shellAuth: "admin", inService: ["src/server/services/admin-users.ts", "updateUser"], conditional: "role / company moves" }),
  rootOnly("/api/admin/users/reset-password", ["POST"], { shellAuth: "admin", inService: ["src/server/services/users-reset-password.ts", "resetUserPassword"] }),
  rootOnly("/api/admin/companies", ["GET", "POST", "PUT", "DELETE"]),
  // owner-billed spend
  rootOnly("/api/yolo/run", ["POST"], { shellAuth: "none", inService: ["src/server/services/yolo-root-gate.ts", "requireYoloRoot"] }),
  rootOnly("/api/yolo/load", ["POST"], { shellAuth: "none", inService: ["src/server/services/yolo-root-gate.ts", "requireYoloRoot"] }),
  rootOnly("/api/yolo/run-batch", ["POST"]),
  rootOnly("/api/pages/textract-rerun", ["POST"], { inService: ["src/server/services/pages.ts", "rerunPageTextract"] }),
  rootOnly("/api/admin/reprocess", ["POST"], { shellAuth: "admin", inService: ["src/server/services/reprocess-admission.ts", "admitReprocess"], conditional: "scope=shape-parse with Lambda CV enabled" }),
  rootOnly("/api/processing/dev", ["POST"], { shellAuth: "none", inService: ["src/server/services/processing-routes.ts", "processingDev"] }),
  rootOnly("/api/admin/yolo-purge", ["DELETE"]),
  rootOnly("/api/admin/yolo-status", ["GET"]),
  rootOnly("/api/admin/yolo-debug", ["GET"]),
  rootOnly("/api/admin/stuck-jobs/stop", ["POST"], { inService: ["src/server/services/stuck-jobs.ts", "stopStuckExecution"] }),
  rootOnly("/api/admin/stuck-jobs/force-release", ["POST"], { inService: ["src/server/services/stuck-jobs.ts", "forceReleaseStuckLeases"] }),
  rootOnly("/api/admin/stuck-jobs/yolo-stop", ["POST"]),
  rootOnly("/api/admin/stuck-jobs/yolo-fix", ["POST"]),
  rootOnly("/api/admin/classifiers/fit", ["POST"]),
  // cross-company data / security
  rootOnly("/api/admin/projects", ["GET"]),
  rootOnly("/api/admin/project-duplicates/scan", ["POST"]),
  rootOnly("/api/admin/project-duplicates/delete", ["POST"]),
  rootOnly("/api/admin/duplicates/delete-hidden", ["POST"]),
  rootOnly("/api/admin/annotation-cleanup", ["GET", "POST"]),
  rootOnly("/api/admin/logs/accounts", ["GET"]),
  rootOnly("/api/admin/logs/alert-count", ["GET"]),
  rootOnly("/api/admin/logs/engagement", ["GET"]),
  rootOnly("/api/admin/logs/monitor", ["GET"]),
  rootOnly("/api/admin/logs/security", ["GET"]),
  rootOnly("/api/admin/logs/visitors", ["GET"]),
  rootOnly("/api/admin/logs/ban-ip", ["POST"]),
  rootOnly("/api/admin/logs/unban-ip", ["POST"]),
  rootOnly("/api/auth/2fa/disable", ["POST"]),
  rootOnly("/api/auth/2fa/backup-codes", ["POST"]),
];

/**
 * [2026-10-25] Every root (or cost-relevant) mutation writes one audit_log row: the named service
 * function must contain a literal `audit("<action>"` call. Who / what / before → after ride in
 * `details` (checked by reading, not pinned here).
 */
export const ROOT_AUDITED_MUTATIONS = [
  ["src/server/services/toggles.ts", "updateToggle", "toggle_changed"],
  ["src/server/services/admin-usage.ts", "updateUsage", "usage_limit_changed"],
  ["src/server/services/app-settings.ts", "putAppSetting", "app_setting_changed"],
  ["src/server/services/quota-overrides.ts", "putQuotaOverride", "quota_override_changed", "QUOTA_OVERRIDE_AUDIT_ACTION"],
  ["src/server/services/upload-compute.ts", "putUploadComputePreset", "upload_compute_preset_changed", "UPLOAD_COMPUTE_AUDIT_ACTION"],
  ["src/server/services/yolo-instance.ts", "putYoloInstanceType", "yolo_instance_type_changed", "YOLO_INSTANCE_AUDIT_ACTION"],
  ["src/server/services/yolo-instance.ts", "putYoloMaxRuntime", "yolo_max_runtime_changed", "YOLO_RUNTIME_AUDIT_ACTION"],
  ["src/server/services/tiles-setting.ts", "putTilesSetting", "tiles_setting_changed", "TILES_AUDIT_ACTION"],
  ["src/server/services/companies.ts", "createCompany", "company_created"],
  ["src/server/services/companies.ts", "updateCompany", "company_updated"],
  ["src/server/services/companies.ts", "deleteCompany", "company_deleted"],
  ["src/server/services/model-access.ts", "grantModelAccess", "model_access_granted"],
  ["src/server/services/model-access.ts", "revokeModelAccess", "model_access_revoked"],
  ["src/server/services/models.ts", "shareModel", "model_access_shared"],
  ["src/server/services/admin-users.ts", "createUser", "user_created"],
  ["src/server/services/admin-users.ts", "updateUser", "user_updated"],
  ["src/server/services/admin-users.ts", "deleteUser", "user_deleted"],
  ["src/server/services/users-reset-password.ts", "resetUserPassword", "user_password_force_reset"],
  ["src/server/services/change-password.ts", "changePassword", "password_changed"],
  ["src/server/services/yolo-admin.ts", "purgeYolo", "yolo_purged"],
  ["src/server/services/llm-config.ts", "upsertLlmConfig", "llm_config_changed"],
  ["src/server/services/llm-config.ts", "deleteLlmConfig", "llm_config_deleted"],
  ["src/server/services/company-settings.ts", "putPipelineConfig", "pipeline_config_changed"],
  ["src/server/services/reprocess-admission.ts", "admitReprocess", "admin.reprocess"],
  ["src/server/services/labeling.ts", "createLabelingSessions", "labeling_session_created"],
  ["src/server/services/pages.ts", "rerunPageTextract", "textract_rerun"],
  ["src/server/services/root-two-factor.ts", "disableRootTwoFactor", "root_2fa_disabled"],
  ["src/server/services/root-two-factor.ts", "revokeRootTwoFactorSessions", "root_2fa_sessions_revoked"],
].map(([serviceFile, serviceFunction, action, actionConstant]) => ({ serviceFile, serviceFunction, action, actionConstant }));
