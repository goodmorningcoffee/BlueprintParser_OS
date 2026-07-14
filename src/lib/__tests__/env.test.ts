import { describe, expect, it } from "vitest";

import { checkEnv } from "@/lib/env";

const baseEnv: NodeJS.ProcessEnv = {
  NODE_ENV: "test",
  DATABASE_URL: "postgresql://example.test/blueprintparser",
  NEXTAUTH_URL: "https://app.example.test",
  NEXTAUTH_SECRET: "test-secret",
  S3_BUCKET: "private-project-assets",
  AWS_REGION: "us-east-1",
  STEP_FUNCTION_ARN:
    "arn:aws:states:us-east-1:000000000000:stateMachine:test",
  PROCESSING_WEBHOOK_SECRET: "test-webhook-secret",
};

describe("CloudFront environment contract", () => {
  it("allows self-hosted deployments to omit the invalidation pair", () => {
    expect(checkEnv(baseEnv).missing).toEqual([]);
  });

  it("requires the distribution ID when the legacy edge domain is configured", () => {
    expect(
      checkEnv({
        ...baseEnv,
        CLOUDFRONT_DOMAIN: "assets.example.test",
      }).missing,
    ).toEqual(["CLOUDFRONT_DISTRIBUTION_ID"]);
  });

  it("requires the legacy edge domain when the distribution ID is configured", () => {
    expect(
      checkEnv({
        ...baseEnv,
        CLOUDFRONT_DISTRIBUTION_ID: "EDIST123",
      }).missing,
    ).toEqual(["CLOUDFRONT_DOMAIN"]);
  });

  it("accepts the complete server-side invalidation pair", () => {
    expect(
      checkEnv({
        ...baseEnv,
        CLOUDFRONT_DOMAIN: "assets.example.test",
        CLOUDFRONT_DISTRIBUTION_ID: "EDIST123",
      }).missing,
    ).toEqual([]);
  });
});

describe("Label Studio provider identity contract", () => {
  it("accepts the complete server-only integration triple", () => {
    expect(
      checkEnv({
        ...baseEnv,
        LABEL_STUDIO_URL: "https://labelstudio.example.test",
        LABEL_STUDIO_API_KEY: "server-token",
        LABEL_STUDIO_INSTANCE_ID: "fs-provider-state-123",
      }).warnings,
    ).not.toEqual(expect.arrayContaining([expect.stringContaining("Label Studio partially configured")]));
  });

  it("names a missing immutable instance identity in partial configuration", () => {
    expect(
      checkEnv({
        ...baseEnv,
        LABEL_STUDIO_URL: "https://labelstudio.example.test",
        LABEL_STUDIO_API_KEY: "server-token",
      }).warnings,
    ).toEqual(
      expect.arrayContaining([
        expect.stringContaining("missing LABEL_STUDIO_INSTANCE_ID"),
      ]),
    );
  });
});
