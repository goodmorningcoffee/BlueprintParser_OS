// @vitest-environment node
// P2 close-review security freeze: the application must never serialize the shared Label Studio
// bootstrap identity to a browser. Label Studio is a single operator-owned provider; exposing its
// login to a company-scoped admin crosses every application tenant boundary because that provider
// identity can enumerate all projects and inspect the bearer asset URLs embedded in their tasks.
import { afterEach, describe, expect, inject, it, vi } from "vitest";

vi.mock("@/lib/auth", async () => {
  const { sessionState } = await import("@/test/harness");
  return { auth: async () => sessionState.current };
});

import { GET } from "@/app/api/labeling/credentials/route";
import {
  asUser,
  createCompany,
  createUser,
  makeReq,
  readJson,
  signedOut,
} from "@/test/harness";

const requestCredentials = () =>
  GET(makeReq("/api/labeling/credentials", { method: "GET" }));
const dbUp = inject("dbUp") as boolean;

afterEach(() => vi.unstubAllEnvs());

describe.skipIf(!dbUp)("GET /api/labeling/credentials — retired shared-secret surface", () => {
  it.each([
    ["signed out", async () => signedOut()],
    [
      "company admin",
      async () =>
        asUser(await createUser((await createCompany()).id, { role: "admin" })),
    ],
    [
      "root admin",
      async () =>
        asUser(
          await createUser((await createCompany()).id, {
            role: "admin",
            isRootAdmin: true,
          }),
        ),
    ],
  ])("returns the same 410 tombstone for %s", async (_label, arrange) => {
    vi.stubEnv("LABEL_STUDIO_ADMIN_EMAIL", "shared-admin@test.invalid");
    vi.stubEnv("LABEL_STUDIO_ADMIN_PASSWORD", "must-never-cross-http");
    await arrange();

    const { status, body } = await readJson(await requestCredentials());

    expect(status).toBe(410);
    expect(body).toEqual({
      error: {
        code: "NOT_FOUND",
        message: "Label Studio browser credentials are disabled",
      },
    });
    expect(JSON.stringify(body)).not.toContain("shared-admin@test.invalid");
    expect(JSON.stringify(body)).not.toContain("must-never-cross-http");
  });
});
