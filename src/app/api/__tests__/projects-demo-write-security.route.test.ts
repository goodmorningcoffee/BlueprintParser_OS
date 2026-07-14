// @vitest-environment node
// L5 freeze-first oracle: public demo projects are immutable for every caller role. The destructive
// sink and audit are mocked so this proves the route rejects before side effects without deleting
// fixture state while the production defect is still RED.
import { beforeEach, describe, expect, inject, it, vi } from "vitest";

vi.mock("@/lib/auth", async () => {
  const { sessionState } = await import("@/test/harness");
  return { auth: async () => sessionState.current };
});
vi.mock("@/lib/project-delete", () => ({ deleteProjectFully: vi.fn(async () => undefined) }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));

import { DELETE, PUT } from "@/app/api/projects/[id]/route";
import { audit } from "@/lib/audit";
import { db } from "@/lib/db";
import { projects } from "@/lib/db/schema";
import { deleteProjectFully } from "@/lib/project-delete";
import { eq } from "drizzle-orm";
import {
  asUser,
  createCompany,
  createUser,
  createWorld,
  makeReq,
  params,
  readJson,
  signedOut,
} from "@/test/harness";

const dbUp = inject("dbUp") as boolean;

beforeEach(() => {
  vi.mocked(deleteProjectFully).mockClear();
  vi.mocked(audit).mockClear();
});

describe.skipIf(!dbUp)("L5 demo project generic mutation policy", () => {
  it("denies generic PUT and DELETE for signed-out, member, admin, and root before any side effect", async () => {
    const { company, project } = await createWorld({
      isDemo: true,
      projectIntelligence: { privateCanary: "keep" } as any,
    });
    const member = await createUser(company.id);
    const admin = await createUser(company.id, { role: "admin" });
    const root = await createUser((await createCompany()).id, { role: "admin", isRootAdmin: true });
    const putResponses = [];
    const deleteResponses = [];

    for (const actor of [null, member, admin, root]) {
      actor ? asUser(actor) : signedOut();
      putResponses.push(
        await readJson(
          await PUT(
            makeReq(`/api/projects/${project.publicId}`, {
              method: "PUT",
              body: {
                name: "MUTATED",
                address: "PRIVATE-ADDRESS-TAINT",
                classCsiOverrides: { "PRIVATE-CLASS": "99 99 99" },
              },
            }),
            params({ id: project.publicId }),
          ),
        ),
      );
      deleteResponses.push(
        await readJson(
          await DELETE(
            makeReq(`/api/projects/${project.publicId}`, { method: "DELETE" }),
            params({ id: project.publicId }),
          ),
        ),
      );
    }

    expect.soft(putResponses.map((response) => response.status)).toEqual([403, 403, 403, 403]);
    expect.soft(deleteResponses.map((response) => response.status)).toEqual([403, 403, 403, 403]);
    expect.soft(deleteProjectFully).not.toHaveBeenCalled();
    expect.soft(audit).not.toHaveBeenCalled();

    const [row] = await db.select().from(projects).where(eq(projects.id, project.id));
    expect.soft(row).toBeDefined();
    expect.soft(row.name).toBe(project.name);
    expect.soft(row.address).toBe(project.address);
    expect.soft(row.projectIntelligence).toEqual({ privateCanary: "keep" });
  });
});
