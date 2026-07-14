// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const aws = vi.hoisted(() => ({
  send: vi.fn(),
}));

vi.mock("@aws-sdk/client-cloudfront", () => {
  class Command<T> {
    constructor(readonly input: T) {}
  }

  return {
    CloudFrontClient: class {
      send = aws.send;
    },
    CreateInvalidationCommand: class<T> extends Command<T> {},
    GetInvalidationCommand: class<T> extends Command<T> {},
  };
});

import { ensureProjectCloudFrontInvalidation } from "@/lib/cloudfront";

const originalDistributionId = process.env.CLOUDFRONT_DISTRIBUTION_ID;
const originalDomain = process.env.CLOUDFRONT_DOMAIN;

beforeEach(() => {
  aws.send.mockReset();
  process.env.CLOUDFRONT_DOMAIN = "assets.example.test";
  process.env.CLOUDFRONT_DISTRIBUTION_ID = "EDIST123";
});

afterEach(() => {
  if (originalDistributionId === undefined) {
    delete process.env.CLOUDFRONT_DISTRIBUTION_ID;
  } else {
    process.env.CLOUDFRONT_DISTRIBUTION_ID = originalDistributionId;
  }
  if (originalDomain === undefined) {
    delete process.env.CLOUDFRONT_DOMAIN;
  } else {
    process.env.CLOUDFRONT_DOMAIN = originalDomain;
  }
});

describe("project deletion CloudFront invalidation", () => {
  it("fails closed when a CDN domain is configured without its distribution identity", async () => {
    delete process.env.CLOUDFRONT_DISTRIBUTION_ID;

    await expect(
      ensureProjectCloudFrontInvalidation(
        "tenant/0123456789abcdef0123",
        "bp-project-delete:outbox-id:0",
      ),
    ).rejects.toThrow(
      "CLOUDFRONT_DISTRIBUTION_ID is required when CLOUDFRONT_DOMAIN is configured",
    );
    expect(aws.send).not.toHaveBeenCalled();
  });

  it("creates the exact wildcard path with the supplied deterministic caller reference", async () => {
    aws.send.mockResolvedValueOnce({
      Invalidation: { Id: "INV-new", Status: "InProgress" },
    });

    await expect(
      ensureProjectCloudFrontInvalidation(
        "tenant/0123456789abcdef0123",
        "bp-project-delete:outbox-id:7",
      ),
    ).resolves.toEqual({ id: "INV-new", complete: false });

    expect(aws.send).toHaveBeenCalledTimes(1);
    expect(aws.send.mock.calls[0]?.[0]).toMatchObject({
      input: {
        DistributionId: "EDIST123",
        InvalidationBatch: {
          CallerReference: "bp-project-delete:outbox-id:7",
          Paths: {
            Quantity: 1,
            Items: ["/tenant/0123456789abcdef0123/*"],
          },
        },
      },
    });
  });

  it("polls the stored invalidation identity instead of creating another invalidation", async () => {
    aws.send.mockResolvedValueOnce({
      Invalidation: { Id: "INV-stored", Status: "Completed" },
    });

    await expect(
      ensureProjectCloudFrontInvalidation(
        "tenant/0123456789abcdef0123",
        "bp-project-delete:outbox-id:7",
        "INV-stored",
      ),
    ).resolves.toEqual({ id: "INV-stored", complete: true });

    expect(aws.send).toHaveBeenCalledTimes(1);
    expect(aws.send.mock.calls[0]?.[0]).toMatchObject({
      input: {
        DistributionId: "EDIST123",
        Id: "INV-stored",
      },
    });
  });
});
