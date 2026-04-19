import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/api-utils";
import { db } from "@/lib/db";
import { companies } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import {
  createStagingUploadPresignedPost,
  generateProjectPath,
  extensionFromFilename,
} from "@/lib/s3";
import { checkUploadQuota } from "@/lib/quotas";

/**
 * POST /api/s3/staging-credentials
 *
 * Multi-file upload presign. Client posts an ordered list of filenames
 * (already sorted client-side via Intl.Collator), server returns N
 * presigned POSTs keyed under `${projectPath}/staging/${idx3}_${safe}`.
 *
 * Client then uploads each file in parallel, then POSTs /api/projects
 * with the stagingFiles array to create the project and kick off SFN.
 *
 * POST (not GET) because long filename lists would hit CloudFront's
 * ~8 KB query-string header cap and pollute access logs with filenames.
 */

const ALLOWED_EXTENSIONS = new Set(["pdf", "png", "jpg", "jpeg", "tif", "tiff", "heic"]);
const MAX_FILES = 30;

export async function POST(req: Request) {
  const { session, error } = await requireAuth();
  if (error) return error;

  let body: { filenames?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const filenames = body.filenames;
  if (!Array.isArray(filenames) || filenames.length === 0) {
    return NextResponse.json(
      { error: "filenames must be a non-empty array of strings" },
      { status: 400 },
    );
  }
  if (filenames.length > MAX_FILES) {
    return NextResponse.json(
      { error: `Maximum ${MAX_FILES} files per project` },
      { status: 400 },
    );
  }
  for (const fn of filenames) {
    if (typeof fn !== "string" || fn.length === 0 || fn.length > 255) {
      return NextResponse.json(
        { error: "Each filename must be a non-empty string ≤255 chars" },
        { status: 400 },
      );
    }
    const ext = extensionFromFilename(fn);
    if (!ALLOWED_EXTENSIONS.has(ext)) {
      return NextResponse.json(
        { error: `Unsupported file type: ${fn} (allowed: ${[...ALLOWED_EXTENSIONS].join(", ")})` },
        { status: 400 },
      );
    }
  }

  // Daily project-count quota (existing) — each staging upload batch creates one project.
  const quota = await checkUploadQuota(session.user.companyId, session.user.role);
  if (!quota.allowed) {
    return NextResponse.json({ error: quota.message }, { status: 429 });
  }

  const [company] = await db
    .select({ dataKey: companies.dataKey })
    .from(companies)
    .where(eq(companies.id, session.user.companyId))
    .limit(1);
  if (!company) {
    return NextResponse.json({ error: "Company not found" }, { status: 404 });
  }

  const projectPath = generateProjectPath(company.dataKey);

  const files = await Promise.all(
    (filenames as string[]).map(async (filename, index) => {
      const presign = await createStagingUploadPresignedPost(projectPath, filename, index);
      return {
        filename,
        url: presign.url,
        fields: presign.fields,
        stagingKey: presign.stagingKey,
        index,
      };
    }),
  );

  return NextResponse.json({ projectPath, files });
}
