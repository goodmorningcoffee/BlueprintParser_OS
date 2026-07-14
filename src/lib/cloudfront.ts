import {
  CloudFrontClient,
  CreateInvalidationCommand,
  GetInvalidationCommand,
} from "@aws-sdk/client-cloudfront";

const cloudFrontClient = new CloudFrontClient({
  region: process.env.AWS_REGION || "us-east-1",
});
const CLOUDFRONT_CALL_TIMEOUT_MS = 30_000;

export interface ProjectInvalidationState {
  id: string | null;
  complete: boolean;
}

/**
 * Create or poll the deterministic invalidation for one retired project root.
 * CallerReference makes an ambiguous CreateInvalidation response retry-safe.
 */
export async function ensureProjectCloudFrontInvalidation(
  storageRoot: string,
  callerReference: string,
  invalidationId?: string | null,
): Promise<ProjectInvalidationState> {
  const distributionId = process.env.CLOUDFRONT_DISTRIBUTION_ID;
  if (!distributionId) {
    // Local/self-hosted S3 mode has no CDN to invalidate. A configured CDN domain without its
    // distribution ID is a deployment error and must stay pending instead of falsely completing.
    if (process.env.CLOUDFRONT_DOMAIN) {
      throw new Error(
        "CLOUDFRONT_DISTRIBUTION_ID is required when CLOUDFRONT_DOMAIN is configured",
      );
    }
    return { id: null, complete: true };
  }

  if (invalidationId) {
    const response = await cloudFrontClient.send(
      new GetInvalidationCommand({
        DistributionId: distributionId,
        Id: invalidationId,
      }),
      { abortSignal: AbortSignal.timeout(CLOUDFRONT_CALL_TIMEOUT_MS) },
    );
    if (!response.Invalidation?.Id) {
      throw new Error("CloudFront invalidation lookup returned no identity");
    }
    return {
      id: response.Invalidation.Id,
      complete: response.Invalidation.Status === "Completed",
    };
  }

  const response = await cloudFrontClient.send(
    new CreateInvalidationCommand({
      DistributionId: distributionId,
      InvalidationBatch: {
        CallerReference: callerReference,
        Paths: {
          Quantity: 1,
          Items: [`/${storageRoot}/*`],
        },
      },
    }),
    { abortSignal: AbortSignal.timeout(CLOUDFRONT_CALL_TIMEOUT_MS) },
  );
  if (!response.Invalidation?.Id) {
    throw new Error("CloudFront invalidation creation returned no identity");
  }
  return {
    id: response.Invalidation.Id,
    complete: response.Invalidation.Status === "Completed",
  };
}
