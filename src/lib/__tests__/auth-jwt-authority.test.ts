// @vitest-environment node
import { describe, expect, inject, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { refreshJwtUserAuthority } from "@/server/services/auth-jwt-authority";
import { createCompany, createUser } from "@/test/harness";

const dbUp = inject("dbUp") as boolean;

describe("JWT authority fail-closed admission", () => {
  it("rejects missing or invalid database identities without querying", async () => {
    const selectSpy = vi.spyOn(db, "select");
    try {
      await expect(refreshJwtUserAuthority({})).resolves.toBeNull();
      await expect(refreshJwtUserAuthority({ dbId: 0 })).resolves.toBeNull();
      await expect(refreshJwtUserAuthority({ dbId: -1 })).resolves.toBeNull();
      await expect(refreshJwtUserAuthority({ dbId: 1.5 })).resolves.toBeNull();
      expect(selectSpy).not.toHaveBeenCalled();
    } finally {
      selectSpy.mockRestore();
    }
  });

  it("propagates database failures instead of preserving stale authority", async () => {
    const failure = new Error("authority lookup failed");
    const selectSpy = vi.spyOn(db, "select").mockImplementationOnce((() => {
      throw failure;
    }) as typeof db.select);
    try {
      await expect(
        refreshJwtUserAuthority({
          dbId: 1,
          canRunModels: true,
          isRootAdmin: true,
        }),
      ).rejects.toBe(failure);
    } finally {
      selectSpy.mockRestore();
    }
  });
});

describe.skipIf(!dbUp)("JWT database authority refresh", () => {
  it("refreshes current authority and invalidates a deleted user's token", async () => {
    const company = await createCompany();
    const user = await createUser(company.id, {
      role: "admin",
      canRunModels: true,
      isRootAdmin: true,
    });
    const token = {
      dbId: user.id,
      companyId: company.id + 1000,
      role: "member",
      canRunModels: false,
      isRootAdmin: false,
    };

    await expect(refreshJwtUserAuthority(token)).resolves.toMatchObject({
      dbId: user.id,
      companyId: company.id,
      role: "admin",
      canRunModels: true,
      isRootAdmin: true,
    });

    await db.delete(users).where(eq(users.id, user.id));
    await expect(refreshJwtUserAuthority(token)).resolves.toBeNull();
  });
});
