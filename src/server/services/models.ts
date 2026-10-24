// [refactor jul8 S057] admin/models SOLO — 5-method admin route (GET list/presign/access,
// POST register, PUT config-merge, DELETE, PATCH share/toggle), folded from the legacy route
// (git show 6203586:src/app/api/admin/models/route.ts). Char:
// __tests__/admin-models.route.test.ts (MD-*). requireAdmin → the shell provides auth:"admin".
// Sanctioned diffs:
//   • A — every flat {error} → envelope ApiError, message BYTE-verbatim + status preserved
//     ("Not authorized"@403, both kill-switch literals@403, "name required"@400, "name and
//     s3Path required"@400, "id required"@400, "At least one field required"@400, "Model not
//     found"@404, "Not found"@404, "modelId required"@400, root-only share literal@403).
//   • E — POST/PUT/DELETE/PATCH `await req.json()` (no catch) subsumed by the shell raw-parse
//     (malformed → 400 BAD_REQUEST "Invalid JSON body"). GET reads searchParams → NO E.
//   • ★ S051 OWNER-SANCTIONED ordering flip — legacy POST ran the ALLOW_MODEL_UPLOAD
//     kill-switch BEFORE requireAdmin; the fold is auth-first, so signed-out on a disabled
//     deployment now gets 401 (was the 403 disabled-literal). Authed callers see the identical
//     403 literal (MD-6 pins both).
//   • NO B — legacy has ZERO try/catch and zero err.message leaks; the shell's generic
//     INTERNAL 500 on uncaught S3/DB throws is NEW uniform wrapping, not a B retirement.
// PRESERVED verbatim (recon batch-2 + DR006 traps):
//   • WEIGHTS-2 masking — shared-listing s3Path forced NULL via sql`NULL` (leak vector; own +
//     root listings keep s3Path; do NOT "clean up"). CLAUDE.md hard-invariant adjacent.
//   • GET presign ROOT-only + its own kill-switch check (weights-leak audit finding 4);
//   • GET action=access root-only BY FALL-THROUGH — non-root lands in the default listing;
//   • PUT/DELETE UNSCOPED fetch then JS tenancy 404 (missing="Model not found" vs
//     cross-company="Not found", DISTINCT) — do NOT push companyId into the query;
//   • PUT jsonb SPREAD-MERGE {...existingConfig, ...updates} (H6-class: merge, never replace)
//     + truthy-gated class fields vs !==undefined-gated numeric fields + Number() coercion;
//   • DELETE has NO !id guard — id undefined matches nothing → 404 (MD-14 freeze correction);
//   • PATCH company-level upsert only (userId IS NULL; per-user grants managed by
//     /api/admin/model-access) + enabled ?? !existing.enabled toggle + grantedBy actor +
//     the per-user-grant-passes-hasAccess quirk (MD-16);
//   • POST configYaml template byte-exact (conf ?? 0.10, iou ?? 0.60, image_size 1280,
//     max_detections 2000) + classes.txt only when non-empty + partial-S3-write-before-DB-
//     insert with no error handling (uncaught throws → shell 500).
// Dropped the legacy dead NextResponse import only; every behavior line ports 1:1.

import { db } from "@/lib/db";
import { models, modelAccess, companies } from "@/lib/db/schema";
import { eq, and, or, isNull, sql } from "drizzle-orm";
import { uploadToS3, createModelUploadPresignedPost } from "@/lib/s3";
import { ApiError } from "@/server/api/envelope";
import type { AuthSession } from "@/lib/api-utils";
import { isCanonicalModelStoragePath } from "@/lib/model-storage-authority";

// GET — list models, or get presigned URL for upload
export async function listModels(
  req: Request,
  session: AuthSession,
): Promise<unknown> {
  const url = new URL(req.url);
  const action = url.searchParams.get("action");

  // Presign action: return presigned S3 URL for direct upload.
  // Root-only: weights are a root-managed asset, and an upload presign is a
  // write/overwrite primitive over models/<slug>/model.pt — a company-admin
  // must not be able to overwrite a model (which would poison the pickle that
  // SageMaker later loads). Also honor the same ALLOW_MODEL_UPLOAD kill-switch
  // as POST register so "uploads disabled" truly disables the upload path.
  // (weights-leak audit, finding 4.)
  if (action === "presign") {
    if (!session.user.isRootAdmin) {
      throw new ApiError("FORBIDDEN", "Not authorized");
    }
    if (process.env.ALLOW_MODEL_UPLOAD !== "true") {
      throw new ApiError(
        "FORBIDDEN",
        "Model uploads are disabled on this deployment.",
      );
    }
    const name = url.searchParams.get("name");
    if (!name) {
      throw new ApiError("VALIDATION", "name required");
    }
    const presigned = await createModelUploadPresignedPost(name);
    return presigned;
  }

  // Access query: get model_access rows for a specific model (root admin only —
  // a NON-root admin with action=access FALLS THROUGH to the default listing, MD-3)
  if (action === "access" && session.user.isRootAdmin) {
    const modelId = Number(url.searchParams.get("modelId"));
    if (!modelId) return [];
    const rows = await db
      .select({
        companyId: modelAccess.companyId,
        companyName: companies.name,
        enabled: modelAccess.enabled,
      })
      .from(modelAccess)
      .innerJoin(companies, eq(modelAccess.companyId, companies.id))
      // Company-level grants only (user_id NULL). Per-user grants are managed in
      // the Usage tab via /api/admin/model-access, not this legacy share panel.
      .where(and(eq(modelAccess.modelId, modelId), isNull(modelAccess.userId)));
    return rows;
  }

  // Default: list models accessible to this company
  const companyId = session.user.companyId;

  if (session.user.isRootAdmin) {
    // Root admin sees all models with company names
    const allModels = await db
      .select({
        id: models.id,
        name: models.name,
        type: models.type,
        s3Path: models.s3Path,
        config: models.config,
        isDefault: models.isDefault,
        createdAt: models.createdAt,
        companyId: models.companyId,
        companyName: companies.name,
      })
      .from(models)
      .leftJoin(companies, eq(models.companyId, companies.id))
      .orderBy(models.createdAt);

    return allModels;
  }

  // Company admin: own models + shared models with enabled flag
  const ownModels = await db
    .select({
      id: models.id,
      name: models.name,
      type: models.type,
      s3Path: models.s3Path,
      config: models.config,
      isDefault: models.isDefault,
      createdAt: models.createdAt,
      companyId: models.companyId,
      enabled: sql<boolean>`true`.as("enabled"),
      shared: sql<boolean>`false`.as("shared"),
    })
    .from(models)
    .where(eq(models.companyId, companyId));

  const sharedModels = await db
    .select({
      // WEIGHTS-2 (belt-and-suspenders): never return the S3 path for models
      // granted from another company — it reveals models/<slug> and lets a
      // grantee reconstruct the object key. The real fix is the CloudFront
      // Deny in s3.tf; this just stops handing out the path. Own-company and
      // root listings keep s3Path. No client consumes s3Path from this list.
      id: models.id,
      name: models.name,
      type: models.type,
      s3Path: sql<string | null>`NULL`.as("s3Path"),
      config: models.config,
      isDefault: models.isDefault,
      createdAt: models.createdAt,
      companyId: models.companyId,
      enabled: modelAccess.enabled,
      shared: sql<boolean>`true`.as("shared"),
    })
    .from(modelAccess)
    .innerJoin(models, eq(modelAccess.modelId, models.id))
    .where(
      and(
        eq(modelAccess.companyId, companyId),
        eq(modelAccess.enabled, true),
        // Company-wide grant (user_id NULL) OR a grant to this specific user.
        or(
          isNull(modelAccess.userId),
          eq(modelAccess.userId, session.user.dbId),
        ),
      ),
    );

  // Deduplicate (own models might also have model_access rows)
  const ownIds = new Set(ownModels.map((m) => m.id));
  const combined = [
    ...ownModels,
    ...sharedModels.filter((m) => !ownIds.has(m.id)),
  ];

  return combined;
}

// POST — register model after S3 upload is complete
export async function registerModel(
  session: AuthSession,
  body: Record<string, unknown>,
): Promise<unknown> {
  // Pre-launch kill-switch. YOLO .pt files are Python pickles and loading
  // one via Ultralytics/PyTorch can execute arbitrary code inside SageMaker,
  // where the role holds broad S3 access. Proper fix (weights_only=True,
  // signed artifacts, isolated IAM) is multi-day; for the OSS launch we
  // hard-disable tenant model uploads. If ops needs to add a model later,
  // set ALLOW_MODEL_UPLOAD=true in the ECS task env, restart, upload, and
  // flip it back.
  // [S057] ★ S051 owner-sanctioned ordering flip: legacy ran this check BEFORE
  // requireAdmin (signed-out on a disabled deployment saw this 403); under the
  // auth-first shell it now runs AFTER auth (signed-out → 401). MD-6 pins it.
  if (process.env.ALLOW_MODEL_UPLOAD !== "true") {
    throw new ApiError(
      "FORBIDDEN",
      "Model uploads are disabled on this deployment. Contact an administrator to enable ALLOW_MODEL_UPLOAD.",
    );
  }

  // Model storage is a single global namespace (models/<canonical-slug>), and
  // the resulting artifacts may be shared across companies. Keep both halves
  // of the upload protocol root-only: a tenant admin must not be able to
  // register a colliding slug after a root admin minted the presign.
  if (!session.user.isRootAdmin) {
    throw new ApiError("FORBIDDEN", "Not authorized");
  }

  const { name, s3Path, classes, confidence, iou } = body as {
    name?: string;
    s3Path?: string;
    classes?: string[];
    confidence?: number;
    iou?: number;
  };

  if (!name || !s3Path) {
    throw new ApiError("VALIDATION", "name and s3Path required");
  }
  if (!isCanonicalModelStoragePath(name, s3Path)) {
    throw new ApiError("VALIDATION", "Invalid model storage path");
  }

  const conf = confidence ?? 0.1;
  const iouVal = iou ?? 0.6;
  const classList = classes || [];

  // Generate and upload config.yaml to S3. TWIN of the template in services/yolo.ts `yoloRun`,
  // which REGENERATES this file at run time from model.config. The two differ in exactly two
  // fields, deliberately: yoloRun emits `image_size: ${imgSize}` and
  // `max_detections: ${model.config?.maxDetections ?? <default>}`, this registration-time template
  // hardcodes 1280 / 2000. Those hardcoded values ARE yoloRun's own `??` defaults (except a
  // text-only model, whose run-time default is 6000 — lib/yolo-config-yaml.ts; every run rewrites
  // this file first), so a model with no imageSize/maxDetections override otherwise yields identical YAML — and registerModel
  // accepts neither field in its body. Every other line is byte-identical: keep it that way.
  const configYaml = `model_file: model.pt
confidence_threshold: ${conf}
iou_threshold: ${iouVal}
image_size: 1280
device: auto
half_precision: true
max_detections: 2000
save_annotated: false
classes:
${classList.map((c: string) => `  - ${c}`).join("\n")}
`;
  await uploadToS3(
    `${s3Path}/config.yaml`,
    Buffer.from(configYaml),
    "text/yaml",
  );

  // Upload classes.txt if provided
  if (classList.length > 0) {
    await uploadToS3(
      `${s3Path}/classes.txt`,
      Buffer.from(classList.join("\n")),
      "text/plain",
    );
  }

  // Save to DB
  const [model] = await db
    .insert(models)
    .values({
      companyId: session.user.companyId,
      name,
      type: "yolo",
      s3Path,
      config: {
        classes: classList,
        confidence: conf,
        iou: iouVal,
        imageSize: 1280,
      },
      isDefault: false,
    })
    .returning();

  return {
    id: model.id,
    name: model.name,
    s3Path: model.s3Path,
    config: model.config,
  };
}

// PUT — update model class config (types, CSI codes, keywords)
export async function updateModelConfig(
  session: AuthSession,
  body: Record<string, unknown>,
): Promise<unknown> {
  const {
    id,
    classTypes,
    classCsiCodes,
    classKeywords,
    confidence,
    iou,
    imageSize,
  } = body as {
    id?: number;
    classTypes?: unknown;
    classCsiCodes?: unknown;
    classKeywords?: unknown;
    confidence?: unknown;
    iou?: unknown;
    imageSize?: unknown;
  };
  if (!id) {
    throw new ApiError("VALIDATION", "id required");
  }
  if (
    !classTypes &&
    !classCsiCodes &&
    !classKeywords &&
    confidence === undefined &&
    iou === undefined &&
    imageSize === undefined
  ) {
    throw new ApiError("VALIDATION", "At least one field required");
  }

  // Fetch existing model UNSCOPED, then JS-side tenancy 404 (scoped to company unless
  // root admin). Do NOT push companyId into the query — the missing-vs-cross-company
  // message distinction ("Model not found" vs "Not found") is frozen (MD-11).
  const [model] = await db
    .select()
    .from(models)
    .where(eq(models.id, id))
    .limit(1);
  if (!model) {
    throw new ApiError("NOT_FOUND", "Model not found");
  }
  if (!session.user.isRootAdmin && model.companyId !== session.user.companyId) {
    throw new ApiError("NOT_FOUND", "Not found");
  }

  // Merge provided fields into existing config JSONB — SPREAD-MERGE (H6-class), never a
  // column replace. Class fields are TRUTHY-gated; numeric fields are !==undefined-gated
  // with Number() coercion (confidence:0 applies, classTypes:"" does not) — MD-12 pins.
  const existingConfig =
    (model.config as unknown as Record<string, unknown>) || {};
  const updates: Record<string, unknown> = {};
  if (classTypes) updates.classTypes = classTypes;
  if (classCsiCodes) updates.classCsiCodes = classCsiCodes;
  if (classKeywords) updates.classKeywords = classKeywords;
  if (confidence !== undefined) updates.confidence = Number(confidence);
  if (iou !== undefined) updates.iou = Number(iou);
  if (imageSize !== undefined) updates.imageSize = Number(imageSize);
  const updatedConfig = { ...existingConfig, ...updates };

  await db
    .update(models)
    .set({ config: updatedConfig as never })
    .where(eq(models.id, id));

  return { success: true, config: updatedConfig };
}

// DELETE — remove model
export async function deleteModel(
  session: AuthSession,
  body: Record<string, unknown>,
): Promise<unknown> {
  const { id } = body as { id?: number };

  // Verify ownership. NB: NO !id guard (legacy) — an absent id matches nothing and lands
  // on the ordinary 404 below (MD-14 freeze correction: NOT a throw).
  const [model] = await db
    .select()
    .from(models)
    .where(eq(models.id, id!))
    .limit(1);
  if (!model) {
    throw new ApiError("NOT_FOUND", "Model not found");
  }
  if (!session.user.isRootAdmin && model.companyId !== session.user.companyId) {
    throw new ApiError("NOT_FOUND", "Not found");
  }

  await db.delete(models).where(eq(models.id, id!));

  return { success: true };
}

// PATCH — share model to a company or toggle enabled
export async function shareModel(
  session: AuthSession,
  body: Record<string, unknown>,
): Promise<unknown> {
  const {
    modelId,
    companyId: targetCompanyId,
    enabled,
  } = body as {
    modelId?: number;
    companyId?: number;
    enabled?: boolean;
  };

  if (!modelId) {
    throw new ApiError("VALIDATION", "modelId required");
  }

  // Sharing to another company requires root admin
  if (
    targetCompanyId &&
    targetCompanyId !== session.user.companyId &&
    !session.user.isRootAdmin
  ) {
    throw new ApiError(
      "FORBIDDEN",
      "Only root admin can share models to other companies",
    );
  }

  const effectiveCompanyId = targetCompanyId || session.user.companyId;

  // Non-root admin: can only toggle existing access (not create new)
  if (!session.user.isRootAdmin) {
    const [model] = await db
      .select({ companyId: models.companyId })
      .from(models)
      .where(eq(models.id, modelId))
      .limit(1);
    if (!model) throw new ApiError("NOT_FOUND", "Model not found");
    // Company admin can only toggle models they own or that were shared to them.
    // (ANY modelAccess row for (model, own company) passes — even a per-user grant;
    // the upsert below then creates a COMPANY-level row beside it. MD-16 pins.)
    if (model.companyId !== session.user.companyId) {
      const [hasAccess] = await db
        .select()
        .from(modelAccess)
        .where(
          and(
            eq(modelAccess.modelId, modelId),
            eq(modelAccess.companyId, session.user.companyId),
          ),
        )
        .limit(1);
      if (!hasAccess) throw new ApiError("NOT_FOUND", "Not found");
    }
  }

  // Upsert the COMPANY-level grant (user_id NULL). Per-user grants are managed
  // separately in the Usage tab; this legacy share toggle never touches them.
  const [existing] = await db
    .select()
    .from(modelAccess)
    .where(
      and(
        eq(modelAccess.modelId, modelId),
        eq(modelAccess.companyId, effectiveCompanyId),
        isNull(modelAccess.userId),
      ),
    )
    .limit(1);

  if (existing) {
    await db
      .update(modelAccess)
      .set({ enabled: enabled ?? !existing.enabled })
      .where(eq(modelAccess.id, existing.id));
  } else {
    await db.insert(modelAccess).values({
      modelId,
      companyId: effectiveCompanyId,
      enabled: enabled ?? true,
      grantedBy: session.user.dbId,
    });
  }

  return { success: true };
}
