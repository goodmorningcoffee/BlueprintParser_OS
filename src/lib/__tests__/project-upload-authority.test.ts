import { describe, expect, it } from "vitest";
import {
  PROJECT_UPLOAD_STAGING_ROOT,
  projectUploadStagingKey,
  projectUploadStagingPrefix,
} from "@/lib/project-upload-authority";

describe("project upload staging authority", () => {
  it("keeps every browser-writable key outside the immutable project prefix", () => {
    const projectPath = "company-key/0123456789abcdef0123";
    const stagingKey = projectUploadStagingKey(
      projectPath,
      "Floor Plan.pdf",
      7,
    );

    expect(stagingKey).toBe(
      `${PROJECT_UPLOAD_STAGING_ROOT}/${projectPath}/007_Floor_Plan.pdf`,
    );
    expect(stagingKey.startsWith(`${projectPath}/`)).toBe(false);
    expect(
      projectUploadStagingPrefix(projectPath).startsWith(`${projectPath}/`),
    ).toBe(false);
  });

  it("binds order and sanitized filename into the exact server-verifiable key", () => {
    const projectPath = "company/project";
    expect(
      projectUploadStagingKey(projectPath, "../unsafe\\name?.PDF", 0),
    ).toBe(`${PROJECT_UPLOAD_STAGING_ROOT}/${projectPath}/000_name_.PDF`);
    expect(projectUploadStagingKey(projectPath, "a.pdf", 0)).not.toBe(
      projectUploadStagingKey(projectPath, "a.pdf", 1),
    );
  });

  it("rejects invalid staging indexes", () => {
    expect(() =>
      projectUploadStagingKey("company/project", "a.pdf", -1),
    ).toThrow("Invalid project upload staging index");
    expect(() =>
      projectUploadStagingKey("company/project", "a.pdf", 0.5),
    ).toThrow("Invalid project upload staging index");
  });
});
