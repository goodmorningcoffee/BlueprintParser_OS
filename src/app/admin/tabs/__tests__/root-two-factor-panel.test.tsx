// [2026-10-23 fix round 2] RootTwoFactorPanel: a successful /confirm calls session.update() (the
// enrolling login picks up its verified marker, as RootTwoFactorGate does after /verify); a refused
// confirm does not, and shows the server's message.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

const h = vi.hoisted(() => ({ update: vi.fn(async () => null) }));
vi.mock("next-auth/react", () => ({ useSession: () => ({ data: null, status: "authenticated", update: h.update }) }));

import RootTwoFactorPanel from "@/app/admin/tabs/RootTwoFactorPanel";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

let confirmResponse: () => Response;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  h.update.mockClear();
  confirmResponse = () => json(200, { enrolled: true, backupCodes: ["AAAAA-BBBBB"] });
  fetchMock = vi.fn(async (url: string) => {
    if (url === "/api/auth/2fa/status") {
      return json(200, { enrolled: false, enrolledAt: null, backupCodesRemaining: 0, pendingEnrollment: false });
    }
    if (url === "/api/auth/2fa/enroll") return json(200, { secret: "JBSWY3DPEHPK3PXP", otpauth: "otpauth://totp/x", account: "x" });
    if (url === "/api/auth/2fa/confirm") return confirmResponse();
    throw new Error(`unexpected fetch ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function enrollAndSubmit(code: string) {
  render(<RootTwoFactorPanel />);
  await act(async () => {
    fireEvent.click(await screen.findByRole("button", { name: "Enable two-factor" }));
  });
  fireEvent.change(await screen.findByPlaceholderText("6-digit code"), { target: { value: code } });
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Activate" }));
  });
}

describe("RootTwoFactorPanel confirm", () => {
  it("calls session.update() after a successful confirm", async () => {
    await enrollAndSubmit("123456");
    expect(await screen.findByText("Two-factor authentication is now active for your root account.")).toBeTruthy();
    expect(h.update).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith("/api/auth/2fa/confirm", expect.objectContaining({ method: "POST" }));
  });

  it("does not call session.update() when confirm is refused, and shows the server's message", async () => {
    confirmResponse = () =>
      json(401, { error: { code: "UNAUTHORIZED", message: "This session cannot be verified: sign out and sign back in, then try again" } });
    await enrollAndSubmit("123456");
    expect(await screen.findByText("This session cannot be verified: sign out and sign back in, then try again")).toBeTruthy();
    expect(h.update).not.toHaveBeenCalled();
  });
});
