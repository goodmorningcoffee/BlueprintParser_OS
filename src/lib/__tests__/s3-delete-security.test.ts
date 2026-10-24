import { beforeEach, describe, expect, it, vi } from "vitest";

const { sendMock } = vi.hoisted(() => ({ sendMock: vi.fn() }));

vi.mock("@aws-sdk/client-s3", () => {
  class TaggedCommand {
    constructor(
      readonly input: Record<string, unknown>,
      readonly kind: string,
    ) {}
  }
  return {
    S3Client: class {
      send = sendMock;
    },
    ListObjectVersionsCommand: class extends TaggedCommand {
      constructor(input: Record<string, unknown>) {
        super(input, "list-versions");
      }
    },
    DeleteObjectsCommand: class extends TaggedCommand {
      constructor(input: Record<string, unknown>) {
        super(input, "delete-objects");
      }
    },
    PutObjectCommand: class extends TaggedCommand {
      constructor(input: Record<string, unknown>) {
        super(input, "put");
      }
    },
    GetObjectCommand: class extends TaggedCommand {
      constructor(input: Record<string, unknown>) {
        super(input, "get");
      }
    },
    HeadObjectCommand: class extends TaggedCommand {
      constructor(input: Record<string, unknown>) {
        super(input, "head");
      }
    },
  };
});

import { deleteProjectFiles, deleteProjectStagingFiles } from "@/lib/s3";
import { projectUploadStagingPrefix } from "@/lib/project-upload-authority";

beforeEach(() => {
  sendMock.mockReset();
});

describe("version-aware project S3 deletion", () => {
  it("deletes current/noncurrent versions and delete markers, then verifies an empty sweep", async () => {
    sendMock
      .mockResolvedValueOnce({
        Versions: [
          { Key: "company/project/original.pdf", VersionId: "current" },
          { Key: "company/project/original.pdf", VersionId: "old" },
        ],
        DeleteMarkers: [
          { Key: "company/project/pages/page_0001.png", VersionId: "marker" },
        ],
        IsTruncated: false,
      })
      .mockResolvedValueOnce({ Errors: [] })
      .mockResolvedValueOnce({
        Versions: [],
        DeleteMarkers: [],
        IsTruncated: false,
      });

    const result = await deleteProjectFiles("company/project");
    expect(result).toEqual({ deletedObjects: 3, emptySweepObserved: true });

    const deleteCommand = sendMock.mock.calls[1][0] as {
      kind: string;
      input: { Delete: { Objects: Array<{ Key: string; VersionId: string }> } };
    };
    expect(deleteCommand.kind).toBe("delete-objects");
    expect(deleteCommand.input.Delete.Objects).toEqual([
      { Key: "company/project/original.pdf", VersionId: "current" },
      { Key: "company/project/original.pdf", VersionId: "old" },
      { Key: "company/project/pages/page_0001.png", VersionId: "marker" },
    ]);
  });

  it("treats HTTP-200 per-object delete errors as cleanup failure", async () => {
    sendMock
      .mockResolvedValueOnce({
        Versions: [{ Key: "company/project/original.pdf", VersionId: "v1" }],
        IsTruncated: false,
      })
      .mockResolvedValueOnce({
        Errors: [{ Key: "company/project/original.pdf", Code: "AccessDenied" }],
      });

    await expect(deleteProjectFiles("company/project")).rejects.toThrow(
      "S3 version purge reported 1 object error(s): AccessDenied",
    );
  });

  it("purges the isolated staging namespace rather than the public project prefix", async () => {
    sendMock.mockResolvedValueOnce({
      Versions: [],
      DeleteMarkers: [],
      IsTruncated: false,
    });

    await deleteProjectStagingFiles("company/project");

    expect(sendMock.mock.calls[0][0].input.Prefix).toBe(
      projectUploadStagingPrefix("company/project"),
    );
  });

  it("follows both version-list continuation markers before beginning the empty verification sweep", async () => {
    sendMock
      .mockResolvedValueOnce({
        Versions: [{ Key: "company/project/a", VersionId: "v2" }],
        IsTruncated: true,
        NextKeyMarker: "company/project/a",
        NextVersionIdMarker: "v1",
      })
      .mockResolvedValueOnce({ Errors: [] })
      .mockResolvedValueOnce({
        Versions: [{ Key: "company/project/a", VersionId: "v1" }],
        IsTruncated: false,
      })
      .mockResolvedValueOnce({ Errors: [] })
      .mockResolvedValueOnce({
        Versions: [],
        DeleteMarkers: [],
        IsTruncated: false,
      });

    const result = await deleteProjectFiles("company/project");

    expect(result.deletedObjects).toBe(2);
    expect(sendMock.mock.calls[2][0].input).toMatchObject({
      KeyMarker: "company/project/a",
      VersionIdMarker: "v1",
    });
  });

  it("[tiles T9 fix round] a tiled project's purge is not cut off at 20 list pages; the attempt is bounded by wall clock instead", async () => {
    // 40 truncated pages of 1000 versions each (~40 tiled pages' worth of ~90 objects + versions) → one attempt
    const PAGES = 40;
    let page = 0;
    sendMock.mockImplementation(async (command) => {
      if (command.kind === "list-versions") {
        page++;
        if (page > PAGES) return { Versions: [], DeleteMarkers: [], IsTruncated: false };
        return {
          Versions: Array.from({ length: 1000 }, (_, i) => ({ Key: `company/project/tiles/L3600/page_${page}/r${i}_c0.png`, VersionId: `v${i}` })),
          IsTruncated: page < PAGES,
          NextKeyMarker: `company/project/tiles/L3600/page_${page}/r999_c0.png`,
          NextVersionIdMarker: "v999",
        };
      }
      return { Errors: [] };
    });

    const result = await deleteProjectFiles("company/project");
    expect(result.deletedObjects).toBe(PAGES * 1000);
    expect(result.emptySweepObserved).toBe(true);
  });

  it("[tiles T9 fix round] the attempt deadline stops the purge between list pages, after progress, with a retryable error", async () => {
    let page = 0;
    sendMock.mockImplementation(async (command) => {
      if (command.kind === "list-versions") {
        page++; // markers progress, so only the deadline can stop this listing
        return {
          Versions: [{ Key: `company/project/a${page}`, VersionId: "v1" }],
          IsTruncated: true,
          NextKeyMarker: `company/project/a${page}`,
          NextVersionIdMarker: "v1",
        };
      }
      return { Errors: [] };
    });

    await expect(deleteProjectFiles("company/project", { attemptDeadlineMs: 0 })).rejects.toThrow(
      /exceeded its 0s attempt deadline after 1 deletions/,
    );
    // the first page was listed AND deleted before the deadline check; the second list never happened
    expect(sendMock.mock.calls.map(([c]) => c.kind)).toEqual(["list-versions", "delete-objects"]);
  });

  it("fails closed when a truncated version listing omits its continuation marker", async () => {
    sendMock.mockResolvedValueOnce({
      Versions: [],
      DeleteMarkers: [],
      IsTruncated: true,
    });

    await expect(deleteProjectFiles("company/project")).rejects.toThrow(
      "missing or non-progressing continuation marker",
    );
  });

  it("persists a caller-provided late-object intent before issuing DeleteObjects", async () => {
    const events: string[] = [];
    sendMock.mockImplementation(async (command) => {
      if (command.kind === "list-versions") {
        events.push("list");
        return events.filter((event) => event === "list").length === 1
          ? {
              Versions: [{ Key: "company/project/new.png", VersionId: "late" }],
              IsTruncated: false,
            }
          : { Versions: [], DeleteMarkers: [], IsTruncated: false };
      }
      events.push("delete");
      return { Errors: [] };
    });

    await deleteProjectFiles("company/project", {
      onObjectsFound: async () => {
        events.push("intent");
      },
    });

    expect(events.slice(0, 3)).toEqual(["list", "intent", "delete"]);
  });

  it("does not issue DeleteObjects when the late-object intent callback fails", async () => {
    sendMock.mockResolvedValueOnce({
      Versions: [{ Key: "company/project/new.png", VersionId: "late-version" }],
      IsTruncated: false,
    });

    await expect(
      deleteProjectFiles("company/project", {
        onObjectsFound: async () => {
          throw new Error("durable late-object intent failed");
        },
      }),
    ).rejects.toThrow("durable late-object intent failed");

    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(
      sendMock.mock.calls.some(
        ([command]) => command.kind === "delete-objects",
      ),
    ).toBe(false);
  });
});
