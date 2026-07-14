// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest";

const { sendMock } = vi.hoisted(() => ({ sendMock: vi.fn() }));

vi.mock("@aws-sdk/client-s3", () => {
  class TaggedCommand {
    constructor(
      readonly input: Record<string, unknown>,
      readonly kind: string,
    ) {}
  }

  const command = (kind: string) =>
    class extends TaggedCommand {
      constructor(input: Record<string, unknown>) {
        super(input, kind);
      }
    };

  return {
    S3Client: class {
      send = sendMock;
    },
    CopyObjectCommand: command("copy"),
    DeleteObjectsCommand: command("delete-objects"),
    GetObjectCommand: command("get"),
    HeadObjectCommand: command("head"),
    ListObjectVersionsCommand: command("list-versions"),
    PutObjectCommand: command("put"),
  };
});

import {
  copyS3ObjectVersion,
  getS3ObjectStream,
  getS3ObjectVersionStream,
  headS3Object,
  uploadS3VersionedSnapshot,
} from "@/lib/s3";

interface SentCommand {
  input: Record<string, unknown>;
  kind: string;
}

interface SendOptions {
  abortSignal?: AbortSignal;
}

function sent(index: number): {
  command: SentCommand;
  options: SendOptions | undefined;
} {
  const [command, options] = sendMock.mock.calls[index] as [
    SentCommand,
    SendOptions | undefined,
  ];
  return { command, options };
}

beforeEach(() => {
  sendMock.mockReset();
});

describe("Label Studio immutable S3 snapshots", () => {
  it("copies one exact source version with segment-safe CopySource encoding", async () => {
    sendMock
      .mockRejectedValueOnce(
        Object.assign(new Error("missing"), {
          name: "NotFound",
          $metadata: { httpStatusCode: 404 },
        }),
      )
      .mockResolvedValueOnce({ VersionId: "snapshot-version" });

    const sourceKey = "tenant key/project+%/pages/page #1?.png";
    const sourceVersionId = "v/1+?=% space";
    const destinationKey =
      "tenant-key/project/label-studio-assets/11111111-1111-4111-8111-111111111111.png";

    await expect(
      copyS3ObjectVersion(sourceKey, sourceVersionId, destinationKey),
    ).resolves.toBe("snapshot-version");

    expect(sent(0).command).toEqual({
      kind: "head",
      input: {
        Bucket: process.env.S3_BUCKET,
        Key: destinationKey,
      },
    });
    expect(sent(1).command).toEqual({
      kind: "copy",
      input: {
        Bucket: process.env.S3_BUCKET,
        Key: destinationKey,
        CopySource:
          `${process.env.S3_BUCKET}/tenant%20key/project%2B%25/pages/` +
          "page%20%231%3F.png?versionId=v%2F1%2B%3F%3D%25%20space",
        MetadataDirective: "REPLACE",
        ContentType: "image/png",
        CacheControl: "private, no-store",
      },
    });
    expect(sent(1).options?.abortSignal).toBeInstanceOf(AbortSignal);
  });

  it("refuses a destination that already exists without issuing CopyObject", async () => {
    sendMock.mockResolvedValueOnce({
      ContentLength: 17,
      VersionId: "existing-version",
    });

    await expect(
      copyS3ObjectVersion(
        "tenant/project/pages/page_0001.png",
        "source-version",
        "tenant/project/label-studio-assets/existing.png",
      ),
    ).rejects.toThrow("Label Studio snapshot key already exists");

    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sent(0).command.kind).toBe("head");
  });

  it("fails closed when a versioned copy succeeds without returning VersionId", async () => {
    sendMock
      .mockRejectedValueOnce(
        Object.assign(new Error("missing"), {
          name: "NotFound",
          $metadata: { httpStatusCode: 404 },
        }),
      )
      .mockResolvedValueOnce({});

    await expect(
      copyS3ObjectVersion(
        "tenant/project/pages/page_0001.png",
        "source-version",
        "tenant/project/label-studio-assets/new.png",
      ),
    ).rejects.toThrow(
      "Versioned Label Studio snapshot copy returned no VersionId",
    );
  });

  it("uploads tiles with create-only If-None-Match semantics and returns the exact version", async () => {
    const body = Buffer.from("tile bytes");
    sendMock.mockResolvedValueOnce({ VersionId: "tile-version" });

    await expect(
      uploadS3VersionedSnapshot(
        "tenant/project/label-studio-assets/tile.png",
        body,
      ),
    ).resolves.toBe("tile-version");

    expect(sent(0).command).toEqual({
      kind: "put",
      input: {
        Bucket: process.env.S3_BUCKET,
        Key: "tenant/project/label-studio-assets/tile.png",
        Body: body,
        ContentType: "image/png",
        CacheControl: "private, no-store",
        IfNoneMatch: "*",
      },
    });
    expect(sent(0).options?.abortSignal).toBeInstanceOf(AbortSignal);
  });

  it("fails closed when a versioned upload returns no VersionId", async () => {
    sendMock.mockResolvedValueOnce({});

    await expect(
      uploadS3VersionedSnapshot(
        "tenant/project/label-studio-assets/no-version.png",
        Buffer.from("tile"),
      ),
    ).rejects.toThrow(
      "Versioned Label Studio snapshot upload returned no VersionId",
    );
  });

  it("propagates a conditional-write failure without retrying an overwrite", async () => {
    const preconditionFailed = Object.assign(
      new Error("destination already exists"),
      {
        name: "PreconditionFailed",
        $metadata: { httpStatusCode: 412 },
      },
    );
    sendMock.mockRejectedValueOnce(preconditionFailed);

    await expect(
      uploadS3VersionedSnapshot(
        "tenant/project/label-studio-assets/collision.png",
        Buffer.from("tile"),
      ),
    ).rejects.toBe(preconditionFailed);

    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sent(0).command.input.IfNoneMatch).toBe("*");
  });

  it("pins VersionId and forwards the caller AbortSignal on HEAD", async () => {
    const controller = new AbortController();
    sendMock.mockResolvedValueOnce({
      ContentLength: 123,
      ETag: '"etag"',
      VersionId: "observed-version",
    });

    await expect(
      headS3Object("tenant/project/page.png", {
        signal: controller.signal,
        versionId: "requested-version",
      }),
    ).resolves.toEqual({
      exists: true,
      size: 123,
      eTag: '"etag"',
      versionId: "observed-version",
    });

    expect(sent(0)).toEqual({
      command: {
        kind: "head",
        input: {
          Bucket: process.env.S3_BUCKET,
          Key: "tenant/project/page.png",
          VersionId: "requested-version",
        },
      },
      options: { abortSignal: controller.signal },
    });
  });

  it("streams only the requested object version and forwards abort authority", async () => {
    const controller = new AbortController();
    const body = new ReadableStream<Uint8Array>();
    const sdkBody = { transformToWebStream: vi.fn(() => body) };
    const lastModified = new Date("2026-07-14T00:00:00Z");
    sendMock.mockResolvedValueOnce({
      Body: sdkBody,
      ContentLength: 456,
      ETag: '"snapshot-etag"',
      LastModified: lastModified,
    });

    await expect(
      getS3ObjectVersionStream(
        "tenant/project/label-studio-assets/grant.png",
        "immutable-version",
        controller.signal,
      ),
    ).resolves.toEqual({
      body,
      contentLength: 456,
      eTag: '"snapshot-etag"',
      lastModified,
    });

    expect(sent(0)).toEqual({
      command: {
        kind: "get",
        input: {
          Bucket: process.env.S3_BUCKET,
          Key: "tenant/project/label-studio-assets/grant.png",
          VersionId: "immutable-version",
        },
      },
      options: { abortSignal: controller.signal },
    });
    expect(sdkBody.transformToWebStream).toHaveBeenCalledOnce();
  });

  it("does not convert aborts or authorization failures into a false missing result", async () => {
    const abortError = Object.assign(new Error("aborted"), {
      name: "AbortError",
    });
    const accessDenied = Object.assign(new Error("denied"), {
      name: "AccessDenied",
      $metadata: { httpStatusCode: 403 },
    });

    sendMock
      .mockRejectedValueOnce(abortError)
      .mockRejectedValueOnce(accessDenied);

    await expect(
      headS3Object("tenant/project/snapshot.png", {
        signal: AbortSignal.abort(),
      }),
    ).rejects.toBe(abortError);
    await expect(headS3Object("tenant/project/snapshot.png")).rejects.toBe(
      accessDenied,
    );
  });

  it("maps only a real missing version to exists:false", async () => {
    sendMock.mockRejectedValueOnce(
      Object.assign(new Error("missing"), {
        name: "NoSuchKey",
        $metadata: { httpStatusCode: 404 },
      }),
    );

    await expect(
      headS3Object("tenant/project/missing.png", {
        versionId: "missing-version",
      }),
    ).resolves.toEqual({ exists: false });
  });

  it("fails instead of constructing a response when S3 omits the GET body", async () => {
    sendMock.mockResolvedValueOnce({ ContentLength: 0 });

    await expect(
      getS3ObjectVersionStream(
        "tenant/project/label-studio-assets/bodyless.png",
        "version",
      ),
    ).rejects.toThrow("S3 object response had no body");
  });
});

describe("private project S3 streaming", () => {
  it("forwards an exact byte range and caller abort authority to GetObject", async () => {
    const controller = new AbortController();
    const body = new ReadableStream<Uint8Array>();
    const sdkBody = { transformToWebStream: vi.fn(() => body) };
    const lastModified = new Date("2026-07-14T00:00:00Z");
    sendMock.mockResolvedValueOnce({
      Body: sdkBody,
      ContentType: "application/pdf",
      ContentLength: 1024,
      ContentRange: "bytes 1048576-1049599/65682593",
      ETag: '"pdf-etag"',
      LastModified: lastModified,
    });

    await expect(
      getS3ObjectStream("tenant/project/original.pdf", {
        range: "bytes=1048576-1049599",
        signal: controller.signal,
      }),
    ).resolves.toEqual({
      body,
      contentType: "application/pdf",
      contentLength: 1024,
      contentRange: "bytes 1048576-1049599/65682593",
      eTag: '"pdf-etag"',
      lastModified,
    });

    expect(sent(0)).toEqual({
      command: {
        kind: "get",
        input: {
          Bucket: process.env.S3_BUCKET,
          Key: "tenant/project/original.pdf",
          Range: "bytes=1048576-1049599",
        },
      },
      options: { abortSignal: controller.signal },
    });
    expect(sdkBody.transformToWebStream).toHaveBeenCalledOnce();
  });
});
