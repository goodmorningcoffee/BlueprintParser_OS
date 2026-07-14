// [refactor jul6 S033] s3 pair route contracts, folded from the legacy routes (git show
// HEAD^:src/app/api/s3/*/route.ts at the freeze). PRESIGN ENGINES BYTE-UNTOUCHED
// (@/lib/s3 createStagingUploadPresignedPost /
// generateProjectPath / extensionFromFilename). Char: __tests__/s3-credentials.route.test.ts.
//   • SQ3-1 staging: validation ladder IN ORDER (non-empty array → MAX 30 → per-file
//     non-empty string ≤255 → extension allowlist w/ interpolated message);
//     checkUploadQuota(companyId, role) 2-ARG (root-limited, S012); company 404;
//     submission-order fanout {projectPath, files}. The legacy route's own
//     req.json-catch emitted the SAME "Invalid JSON body" text the shell uses — the
//     malformed-body flip is SHAPE-ONLY (A/E hybrid); the route-local try/catch retired.
//   • SQ3-2 credentials GET had ZERO runtime consumers and wrote directly to final
//     original.pdf. It is disabled: reusable credentials cannot survive demo publication.

import { db } from "@/lib/db";
import { companies } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import {
  createStagingUploadPresignedPost,
  generateProjectPath,
  extensionFromFilename,
} from "@/lib/s3";
import { checkUploadQuota } from "@/lib/quotas";
import type { AuthSession } from "@/lib/api-utils";
import { ApiError } from "@/server/api/envelope";

const ALLOWED_EXTENSIONS = new Set(["pdf", "png", "jpg", "jpeg", "tif", "tiff", "heic"]);
const MAX_FILES = 30;

export async function stagingCredentials(rawBody: Record<string, unknown>, session: AuthSession): Promise<unknown> {
  const filenames = rawBody.filenames;
  if (!Array.isArray(filenames) || filenames.length === 0) {
    throw new ApiError("VALIDATION", "filenames must be a non-empty array of strings");
  }
  if (filenames.length > MAX_FILES) {
    throw new ApiError("VALIDATION", `Maximum ${MAX_FILES} files per project`);
  }
  for (const fn of filenames) {
    if (typeof fn !== "string" || fn.length === 0 || fn.length > 255) {
      throw new ApiError("VALIDATION", "Each filename must be a non-empty string ≤255 chars");
    }
    const ext = extensionFromFilename(fn);
    if (!ALLOWED_EXTENSIONS.has(ext)) {
      throw new ApiError("VALIDATION", `Unsupported file type: ${fn} (allowed: ${[...ALLOWED_EXTENSIONS].join(", ")})`);
    }
  }

  // Daily project-count quota (existing) — each staging upload batch creates one project.
  const quota = await checkUploadQuota(session.user.companyId, session.user.role);
  if (!quota.allowed) {
    throw new ApiError("RATE_LIMITED", quota.message as string); // no fallback (frozen)
  }

  const [company] = await db
    .select({ dataKey: companies.dataKey })
    .from(companies)
    .where(eq(companies.id, session.user.companyId))
    .limit(1);
  if (!company) {
    throw new ApiError("NOT_FOUND", "Company not found");
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

  return { projectPath, files };
}

export async function uploadCredentials(session: AuthSession): Promise<unknown> {
  void session;
  // The supported staging flow signs disposable staging keys. This legacy endpoint signed the
  // final original.pdf key, so replay within its 15-minute lifetime could mutate a public demo.
  throw new ApiError("NOT_FOUND", "Legacy direct upload credentials are disabled", 410);
}
