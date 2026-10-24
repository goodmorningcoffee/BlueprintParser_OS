// [csi-v2 S6] Call-site pin: a rule's output CSI code is normalized when the field loses focus
// ("081116" → "08 11 16"), not while typing, and the normalized value is what Save sends.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import HeuristicsTab from "@/app/admin/tabs/HeuristicsTab";

const RULE = {
  id: "custom-1", name: "Door rule", source: "custom", enabled: true,
  yoloRequired: [], yoloBoosters: [], textKeywordsRequired: [], textKeywordsBoosters: [],
  overlapRequired: false, outputLabel: "door", minConfidence: 0.5,
};

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === "/api/admin/models") return { ok: true, json: async () => [] };
    if (init?.method === "PUT") return { ok: true, json: async () => ({}) };
    return { ok: true, json: async () => ({ builtInRules: [], companyOverrides: [RULE] }) };
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("HeuristicsTab output CSI code", () => {
  it("keeps typed text as-is, normalizes on blur, and saves the normalized code", async () => {
    render(<HeuristicsTab onOpenReprocess={() => {}} />);
    fireEvent.click(await screen.findByText("▼ Edit"));
    const input = screen.getByPlaceholderText("e.g. 08 11 16") as HTMLInputElement;

    fireEvent.change(input, { target: { value: "081116" } });
    expect(input.value).toBe("081116");
    fireEvent.blur(input);
    expect(input.value).toBe("08 11 16");

    fireEvent.click(screen.getByText("Save Rules"));
    await waitFor(() => expect(fetchMock.mock.calls.some(([, i]) => i?.method === "PUT")).toBe(true));
    const [, put] = fetchMock.mock.calls.find(([, i]) => i?.method === "PUT")!;
    expect(JSON.parse(put.body).heuristics[0].outputCsiCode).toBe("08 11 16");
  });
});
