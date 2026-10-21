// [csi-v2 S6] Call-site pin: the CSI admin tab loads a stored config through `pickCsiV2Config`
// and saves exactly the two v2 settings `{tau, maxCodesPerPage}`. Dropping `tau` from the PUT body,
// or spreading the raw stored blob (legacy pre-v2 keys) into state instead of the picked fields,
// fails here.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import CsiTab from "@/app/admin/tabs/CsiTab";

let storedConfig: Record<string, unknown> = {};
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  storedConfig = {};
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === "/api/admin/models") return { ok: true, json: async () => [] };
    if (init?.method === "PUT") return { ok: true, json: async () => ({}) };
    return { ok: true, json: async () => ({ config: storedConfig }) };
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function renderTab(): Promise<{ tau: HTMLInputElement; maxCodes: HTMLInputElement }> {
  render(<CsiTab reprocessing={false} reprocessLog={[]} onReprocess={() => {}} />);
  const tau = (await screen.findByRole("slider")) as HTMLInputElement;
  const maxCodes = screen.getByRole("spinbutton") as HTMLInputElement;
  return { tau, maxCodes };
}

async function saveAndReadBody(): Promise<unknown> {
  fireEvent.click(screen.getByText("Save Configuration"));
  await waitFor(() => expect(fetchMock.mock.calls.some(([, i]) => i?.method === "PUT")).toBe(true));
  const [url, put] = fetchMock.mock.calls.find(([, i]) => i?.method === "PUT")!;
  expect(url).toBe("/api/admin/csi/config");
  return JSON.parse(put.body);
}

describe("CsiTab v2 config", () => {
  it("saves exactly {tau, maxCodesPerPage} with the values edited in the UI", async () => {
    const { tau, maxCodes } = await renderTab();
    expect(tau.value).toBe("0.75");
    expect(maxCodes.value).toBe("40");

    fireEvent.change(tau, { target: { value: "0.9" } });
    fireEvent.change(maxCodes, { target: { value: "12" } });
    expect(screen.getByText("90%")).toBeTruthy();

    expect(await saveAndReadBody()).toEqual({ tau: 0.9, maxCodesPerPage: 12 });
  });

  it("maps a legacy stored config and never re-saves its legacy keys", async () => {
    // matchingConfidenceThreshold 0.4 is at/below 0.704, so pickCsiV2Config ignores it (tau stays
    // the 0.75 default); tier2MinWords is a pre-v2 key; maxCodesPerPage 25 is kept.
    storedConfig = { matchingConfidenceThreshold: 0.4, tier2MinWords: 3, maxCodesPerPage: 25 };
    const { tau, maxCodes } = await renderTab();
    expect(tau.value).toBe("0.75");
    expect(maxCodes.value).toBe("25");

    expect(await saveAndReadBody()).toEqual({ tau: 0.75, maxCodesPerPage: 25 });
  });

  it("reads a legacy threshold above 0.704 as tau and drops an out-of-range cap", async () => {
    storedConfig = { matchingConfidenceThreshold: 0.9, tier2MinWords: 3, maxCodesPerPage: 500 };
    const { tau, maxCodes } = await renderTab();
    expect(tau.value).toBe("0.9");
    expect(maxCodes.value).toBe("40");

    expect(await saveAndReadBody()).toEqual({ tau: 0.9, maxCodesPerPage: 40 });
  });
});
