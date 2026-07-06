import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/api-utils";
import { db } from "@/lib/db";
import { models, modelAccess, companies } from "@/lib/db/schema";
import { eq, and, or, isNull, sql } from "drizzle-orm";
import { uploadToS3, createModelUploadPresignedPost } from "@/lib/s3";

// GET — list models, or get presigned URL for upload
export async function GET(req: Request) {
  const { session, error } = await requireAdmin();
  if (error) return error;

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
      return NextResponse.json({ error: "Not authorized" }, { status: 403 });
    }
    if (process.env.ALLOW_MODEL_UPLOAD !== "true") {
      return NextResponse.json(
        { error: "Model uploads are disabled on this deployment." },
        { status: 403 },
      );
    }
    const name = url.searchParams.get("name");
    if (!name) {
      return NextResponse.json({ error: "name required" }, { status: 400 });
    }
    const modelSlug = name.toLowerCase().replace(/[^a-z0-9-]/g, "-");
    const presigned = await createModelUploadPresignedPost(modelSlug);
    return NextResponse.json(presigned);
  }

  // Access query: get model_access rows for a specific model (root admin only)
  if (action === "access" && session.user.isRootAdmin) {
    const modelId = Number(url.searchParams.get("modelId"));
    if (!modelId) return NextResponse.json([], { status: 200 });
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
    return NextResponse.json(rows);
  }

  // Default: list models accessible to this company
  const companyId = session.user.companyId;

  if (session.user.isRootAdmin) {
    // Root admin sees all models with company names
    const allModels = await db
      .select({
        id: models.id, name: models.name, type: models.type, s3Path: models.s3Path,
        config: models.config, isDefault: models.isDefault, createdAt: models.createdAt,
        companyId: models.companyId, companyName: companies.name,
      })
      .from(models)
      .leftJoin(companies, eq(models.companyId, companies.id))
      .orderBy(models.createdAt);

    return NextResponse.json(allModels);
  }

  // Company admin: own models + shared models with enabled flag
  const ownModels = await db
    .select({
      id: models.id, name: models.name, type: models.type, s3Path: models.s3Path,
      config: models.config, isDefault: models.isDefault, createdAt: models.createdAt,
      companyId: models.companyId, enabled: sql<boolean>`true`.as("enabled"),
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
      id: models.id, name: models.name, type: models.type,
      s3Path: sql<string | null>`NULL`.as("s3Path"),
      config: models.config, isDefault: models.isDefault, createdAt: models.createdAt,
      companyId: models.companyId, enabled: modelAccess.enabled,
      shared: sql<boolean>`true`.as("shared"),
    })
    .from(modelAccess)
    .innerJoin(models, eq(modelAccess.modelId, models.id))
    .where(
      and(
        eq(modelAccess.companyId, companyId),
        eq(modelAccess.enabled, true),
        // Company-wide grant (user_id NULL) OR a grant to this specific user.
        or(isNull(modelAccess.userId), eq(modelAccess.userId, session.user.dbId))
      )
    );

  // Deduplicate (own models might also have model_access rows)
  const ownIds = new Set(ownModels.map((m) => m.id));
  const combined = [...ownModels, ...sharedModels.filter((m) => !ownIds.has(m.id))];

  return NextResponse.json(combined);
}

// POST — register model after S3 upload is complete
export async function POST(req: Request) {
  // Pre-launch kill-switch. YOLO .pt files are Python pickles and loading
  // one via Ultralytics/PyTorch can execute arbitrary code inside SageMaker,
  // where the role holds broad S3 access. Proper fix (weights_only=True,
  // signed artifacts, isolated IAM) is multi-day; for the OSS launch we
  // hard-disable tenant model uploads. If ops needs to add a model later,
  // set ALLOW_MODEL_UPLOAD=true in the ECS task env, restart, upload, and
  // flip it back.
  if (process.env.ALLOW_MODEL_UPLOAD !== "true") {
    return NextResponse.json(
      {
        error:
          "Model uploads are disabled on this deployment. Contact an administrator to enable ALLOW_MODEL_UPLOAD.",
      },
      { status: 403 },
    );
  }

  const { session, error } = await requireAdmin();
  if (error) return error;

  const { name, s3Path, classes, confidence, iou } = await req.json();

  if (!name || !s3Path) {
    return NextResponse.json(
      { error: "name and s3Path required" },
      { status: 400 }
    );
  }

  const conf = confidence ?? 0.10;
  const iouVal = iou ?? 0.60;
  const classList = classes || [];

  // Generate and upload config.yaml to S3
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
  await uploadToS3(`${s3Path}/config.yaml`, Buffer.from(configYaml), "text/yaml");

  // Upload classes.txt if provided
  if (classList.length > 0) {
    await uploadToS3(
      `${s3Path}/classes.txt`,
      Buffer.from(classList.join("\n")),
      "text/plain"
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
      config: { classes: classList, confidence: conf, iou: iouVal, imageSize: 1280 },
      isDefault: false,
    })
    .returning();

  return NextResponse.json({
    id: model.id,
    name: model.name,
    s3Path: model.s3Path,
    config: model.config,
  });
}

// PUT — update model class config (types, CSI codes, keywords)
export async function PUT(req: Request) {
  const { session, error } = await requireAdmin();
  if (error) return error;

  const { id, classTypes, classCsiCodes, classKeywords, confidence, iou, imageSize } = await req.json();
  if (!id) {
    return NextResponse.json({ error: "id required" }, { status: 400 });
  }
  if (!classTypes && !classCsiCodes && !classKeywords && confidence === undefined && iou === undefined && imageSize === undefined) {
    return NextResponse.json({ error: "At least one field required" }, { status: 400 });
  }

  // Fetch existing model (scoped to company unless root admin)
  const [model] = await db.select().from(models).where(eq(models.id, id)).limit(1);
  if (!model) {
    return NextResponse.json({ error: "Model not found" }, { status: 404 });
  }
  if (!session.user.isRootAdmin && model.companyId !== session.user.companyId) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // Merge provided fields into existing config JSONB
  const existingConfig = (model.config as any) || {};
  const updates: Record<string, unknown> = {};
  if (classTypes) updates.classTypes = classTypes;
  if (classCsiCodes) updates.classCsiCodes = classCsiCodes;
  if (classKeywords) updates.classKeywords = classKeywords;
  if (confidence !== undefined) updates.confidence = Number(confidence);
  if (iou !== undefined) updates.iou = Number(iou);
  if (imageSize !== undefined) updates.imageSize = Number(imageSize);
  const updatedConfig = { ...existingConfig, ...updates };

  await db.update(models).set({ config: updatedConfig }).where(eq(models.id, id));

  return NextResponse.json({ success: true, config: updatedConfig });
}

// DELETE — remove model
export async function DELETE(req: Request) {
  const { session, error } = await requireAdmin();
  if (error) return error;

  const { id } = await req.json();

  // Verify ownership
  const [model] = await db.select().from(models).where(eq(models.id, id)).limit(1);
  if (!model) {
    return NextResponse.json({ error: "Model not found" }, { status: 404 });
  }
  if (!session.user.isRootAdmin && model.companyId !== session.user.companyId) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  await db.delete(models).where(eq(models.id, id));

  return NextResponse.json({ success: true });
}

// PATCH — share model to a company or toggle enabled
export async function PATCH(req: Request) {
  const { session, error } = await requireAdmin();
  if (error) return error;

  const { modelId, companyId: targetCompanyId, enabled } = await req.json();

  if (!modelId) {
    return NextResponse.json({ error: "modelId required" }, { status: 400 });
  }

  // Sharing to another company requires root admin
  if (targetCompanyId && targetCompanyId !== session.user.companyId && !session.user.isRootAdmin) {
    return NextResponse.json({ error: "Only root admin can share models to other companies" }, { status: 403 });
  }

  const effectiveCompanyId = targetCompanyId || session.user.companyId;

  // Non-root admin: can only toggle existing access (not create new)
  if (!session.user.isRootAdmin) {
    const [model] = await db.select({ companyId: models.companyId }).from(models).where(eq(models.id, modelId)).limit(1);
    if (!model) return NextResponse.json({ error: "Model not found" }, { status: 404 });
    // Company admin can only toggle models they own or that were shared to them
    if (model.companyId !== session.user.companyId) {
      const [hasAccess] = await db.select().from(modelAccess)
        .where(and(eq(modelAccess.modelId, modelId), eq(modelAccess.companyId, session.user.companyId)))
        .limit(1);
      if (!hasAccess) return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
  }

  // Upsert the COMPANY-level grant (user_id NULL). Per-user grants are managed
  // separately in the Usage tab; this legacy share toggle never touches them.
  const [existing] = await db
    .select()
    .from(modelAccess)
    .where(and(
      eq(modelAccess.modelId, modelId),
      eq(modelAccess.companyId, effectiveCompanyId),
      isNull(modelAccess.userId)
    ))
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

  return NextResponse.json({ success: true });
}
