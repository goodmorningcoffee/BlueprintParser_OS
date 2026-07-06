// @vitest-environment node
// [refactor jul6 S039] CHARACTERIZATION for the ADMIN B4 WRITE-CLUSTER — the 2 root IP-ban
// writes (logs/ban-ip POST · logs/unban-ip POST), written as THE FREEZE before the fold onto
// services/manual-ip-bans.ts. B4 is a WRITE-CLUSTER: shared freeze, but ONE DETECTOR PER
// ROUTE (DR002 §5 — writes never share an aggregate DETECTOR verdict).
//
// Common skeleton (both): requireRootAdmin → try/catch req.json() (→ 400 "Invalid JSON") →
// validate ip → write manualIpBans → bumpManualBanCacheVersion() → recordAbuseEvent(...) →
// { ok:true }; catch → 500 fixed literal ("Ban failed" / "Unban failed").
// Frozen quirk inventory:
//   • AUTH: requireRootAdmin → 401 flat {error:"Unauthorized"} / 403 flat {error:"Root admin
//     only"}; root passes. Legacy auth-FIRST (signed-out + malformed body → 401).
//   • ban-ip validation: ip = trim; reject empty / len>45 / !/^[0-9a-fA-F:.]+$/ → 400
//     "Invalid IP address". reason = String.slice(0,500) or null. durationHours>0 number →
//     bannedUntil = now + h*3600s, else null. WRITE = insert onConflictDoUpdate(target ip)
//     (idempotent re-ban overwrites reason/bannedUntil/actor/createdAt). abuse "MANUAL_BAN".
//   • unban-ip validation: ip = trim; reject empty → 400 "ip required" (NO regex/len check —
//     simpler than ban). WRITE = delete where ip. abuse "MANUAL_UNBAN". Deleting a
//     non-existent ip is a no-op success (delete matches 0 rows → still {ok:true}).
//   • Both: bumpManualBanCacheVersion() called AFTER the write, BEFORE recordAbuseEvent.
//     recordAbuseEvent is fire-and-forget (not awaited). catch → 500 fixed literal (no
//     err.message leak) → flips to generic INTERNAL 500 at fold (diff B).
//   • The malformed-JSON 400 "Invalid JSON" (route's own try/catch) → shell 400 BAD_REQUEST
//     "Invalid JSON body" at fold (diff E; message drift). Auth-before-parse ordering flips
//     for signed-out+malformed (401 → 400 pre-auth; PR-D5(a)).
// Assertions tagged [S039 fold: … applied] were flipped in the fold commit onto
// services/manual-ip-bans.ts (sanctioned A/B/E only).
import { describe, expect, inject, it, beforeEach, vi } from "vitest";

vi.mock("@/lib/auth", async () => {
  const { sessionState } = await import("@/test/harness");
  return { auth: async () => sessionState.current };
});

const h = vi.hoisted(() => ({
  recordAbuseEvent: vi.fn(),
  bumpManualBanCacheVersion: vi.fn(),
}));
vi.mock("@/lib/admin-logs/record-abuse", () => ({ recordAbuseEvent: h.recordAbuseEvent }));
vi.mock("@/lib/admin-logs/manual-ban-cache", () => ({ bumpManualBanCacheVersion: h.bumpManualBanCacheVersion }));

import { POST as banPOST } from "@/app/api/admin/logs/ban-ip/route";
import { POST as unbanPOST } from "@/app/api/admin/logs/unban-ip/route";
import { db } from "@/lib/db";
import { manualIpBans } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import {
  asUser,
  createCompany,
  createUser,
  makeReq,
  readJson,
  signedOut,
} from "@/test/harness";

const dbUp = inject("dbUp") as boolean;

async function makeRoot() {
  const company = await createCompany();
  const root = await createUser(company.id, { isRootAdmin: true });
  const member = await createUser(company.id);
  return { company, root, member };
}

const UNAUTH = { error: { code: "UNAUTHORIZED", message: "Unauthorized" } }; // [S039 fold: A applied]
const ROOT_ONLY = { error: { code: "FORBIDDEN", message: "Root admin only" } }; // [S039 fold: A applied]

const banReq = (body: unknown) => makeReq("/api/admin/logs/ban-ip", { method: "POST", body });
const unbanReq = (body: unknown) => makeReq("/api/admin/logs/unban-ip", { method: "POST", body });
/** raw (possibly malformed) body request */
const rawReq = (path: string, raw?: string) =>
  new Request(`http://test.local${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: raw });

async function banRowFor(ip: string) {
  const [row] = await db.select().from(manualIpBans).where(eq(manualIpBans.ip, ip)).limit(1);
  return row;
}

beforeEach(() => {
  vi.clearAllMocks();
  signedOut();
});

// ── ban-ip ────────────────────────────────────────────────────────────────────
describe.skipIf(!dbUp)("admin/logs/ban-ip (BAN)", () => {
  it("BAN-1 auth: signed-out→401, member→403, root passes", async () => {
    const { root, member } = await makeRoot();
    let r = await readJson(await banPOST(banReq({ ip: "1.2.3.4" })));
    expect(r.status).toBe(401);
    expect(r.body).toEqual(UNAUTH); // [S039 fold: A applied]
    asUser(member);
    r = await readJson(await banPOST(banReq({ ip: "1.2.3.4" })));
    expect(r.status).toBe(403);
    expect(r.body).toEqual(ROOT_ONLY); // [S039 fold: A applied]
    asUser(root);
    r = await readJson(await banPOST(banReq({ ip: "1.2.3.9" })));
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true });
  });

  it("BAN-2 malformed JSON → 400 'Invalid JSON' (route try/catch); no write", async () => {
    const { root } = await makeRoot();
    asUser(root);
    // [S039 fold: E — shell parses raw body pre-auth → 400 BAD_REQUEST "Invalid JSON body"]
    const r = await readJson(await banPOST(rawReq("/api/admin/logs/ban-ip", "{oops")));
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ error: { code: "BAD_REQUEST", message: "Invalid JSON body" } }); // [S039 fold: E applied]
    expect(h.bumpManualBanCacheVersion).not.toHaveBeenCalled();
  });

  it("BAN-3 IP validation: empty / too-long / bad-chars → 400 'Invalid IP address'; no write", async () => {
    const { root } = await makeRoot();
    asUser(root);
    for (const ip of ["", "   ", "x".repeat(46), "1.2.3.4; DROP", "not_an_ip!"]) {
      const r = await readJson(await banPOST(banReq({ ip })));
      expect(r.status).toBe(400);
      expect(r.body).toEqual({ error: { code: "VALIDATION", message: "Invalid IP address" } }); // [S039 fold: A applied]
    }
    // non-string ip → treated as "" → same
    const r = await readJson(await banPOST(banReq({ ip: 12345 })));
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ error: { code: "VALIDATION", message: "Invalid IP address" } }); // [S039 fold: A applied]
    expect(h.recordAbuseEvent).not.toHaveBeenCalled();
  });

  it("BAN-4 write: inserts row, trims ip, reason slice(0,500), durationHours→bannedUntil; bump + MANUAL_BAN abuse", async () => {
    const { root } = await makeRoot();
    asUser(root);
    const longReason = "z".repeat(600);
    const r = await readJson(await banPOST(banReq({ ip: "  10.0.0.5  ", reason: longReason, durationHours: 2 })));
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true });
    const row = await banRowFor("10.0.0.5"); // trimmed
    expect(row).toBeTruthy();
    expect(row.reason).toHaveLength(500); // sliced
    expect(row.bannedByUserId).toBe(root.id);
    expect(row.bannedUntil).toBeTruthy(); // durationHours>0 → set
    expect(h.bumpManualBanCacheVersion).toHaveBeenCalledTimes(1);
    expect(h.recordAbuseEvent).toHaveBeenCalledWith(expect.objectContaining({
      eventType: "MANUAL_BAN", ip: "10.0.0.5",
      details: expect.objectContaining({ durationHours: 2, actor: root.id }),
    }));
  });

  it("BAN-5 re-ban same ip → onConflictDoUpdate overwrites (no duplicate row); no-duration→null bannedUntil", async () => {
    const { root } = await makeRoot();
    asUser(root);
    await banPOST(banReq({ ip: "10.0.0.6", reason: "first", durationHours: 5 }));
    await banPOST(banReq({ ip: "10.0.0.6", reason: "second" })); // no duration → null
    const rows = await db.select().from(manualIpBans).where(eq(manualIpBans.ip, "10.0.0.6"));
    expect(rows).toHaveLength(1); // upsert, not duplicate
    expect(rows[0].reason).toBe("second");
    expect(rows[0].bannedUntil).toBeNull(); // overwritten to null
  });
});

// ── unban-ip ──────────────────────────────────────────────────────────────────
describe.skipIf(!dbUp)("admin/logs/unban-ip (UNBAN)", () => {
  it("UNBAN-1 auth: signed-out→401, member→403", async () => {
    const { member } = await makeRoot();
    let r = await readJson(await unbanPOST(unbanReq({ ip: "1.2.3.4" })));
    expect(r.status).toBe(401);
    expect(r.body).toEqual(UNAUTH); // [S039 fold: A applied]
    asUser(member);
    r = await readJson(await unbanPOST(unbanReq({ ip: "1.2.3.4" })));
    expect(r.status).toBe(403);
    expect(r.body).toEqual(ROOT_ONLY); // [S039 fold: A applied]
  });

  it("UNBAN-2 validation: empty ip → 400 'ip required' (NO regex — unlike ban); no write", async () => {
    const { root } = await makeRoot();
    asUser(root);
    for (const ip of ["", "   ", 999]) {
      const r = await readJson(await unbanPOST(unbanReq({ ip })));
      expect(r.status).toBe(400);
      expect(r.body).toEqual({ error: { code: "VALIDATION", message: "ip required" } }); // [S039 fold: A applied]
    }
    // NOTE: unban accepts "malformed" ips that ban would reject (no regex) — frozen asymmetry
    expect(h.bumpManualBanCacheVersion).not.toHaveBeenCalled();
  });

  it("UNBAN-3 malformed JSON → 400 'Invalid JSON'", async () => {
    const { root } = await makeRoot();
    asUser(root);
    // [S039 fold: E — shell → 400 BAD_REQUEST "Invalid JSON body"]
    const r = await readJson(await unbanPOST(rawReq("/api/admin/logs/unban-ip", "{oops")));
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ error: { code: "BAD_REQUEST", message: "Invalid JSON body" } }); // [S039 fold: E applied]
  });

  it("UNBAN-4 write: deletes ban row, trims ip, bump + MANUAL_UNBAN abuse", async () => {
    const { root } = await makeRoot();
    asUser(root);
    await db.insert(manualIpBans).values({ ip: "10.0.0.7", reason: "x" });
    const r = await readJson(await unbanPOST(unbanReq({ ip: "  10.0.0.7 " })));
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true });
    expect(await banRowFor("10.0.0.7")).toBeUndefined(); // deleted
    expect(h.bumpManualBanCacheVersion).toHaveBeenCalledTimes(1);
    expect(h.recordAbuseEvent).toHaveBeenCalledWith(expect.objectContaining({
      eventType: "MANUAL_UNBAN", ip: "10.0.0.7", details: expect.objectContaining({ actor: root.id }),
    }));
  });

  it("UNBAN-5 deleting a non-existent ip is a no-op success", async () => {
    const { root } = await makeRoot();
    asUser(root);
    const r = await readJson(await unbanPOST(unbanReq({ ip: "203.0.113.99" })));
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true }); // 0 rows deleted → still ok
    expect(h.recordAbuseEvent).toHaveBeenCalledWith(expect.objectContaining({ eventType: "MANUAL_UNBAN" }));
  });
});
