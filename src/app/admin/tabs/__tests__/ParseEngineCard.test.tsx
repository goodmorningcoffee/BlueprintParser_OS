// [TP-3 WP-3.E] admin › Pipeline "Parse engine" card. The PUT sends only what is pinned, so a tool left on
// "default" keeps following its code default when a builder flips it (WP-3.Q); the kill switch and the
// standard crop-cache switch round-trip.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import ParseEngineCard, { bodyFromDraft, draftFromStored } from "@/app/admin/tabs/pipeline/ParseEngineCard";

const TOOLS = {
  tablesRoute: "legacy", keynoteRoute: "legacy", notesClassifier: "legacy", specClassifier: "legacy",
  notesAuto: "legacy", specAuto: "legacy", workspace: "engine",
} as const;
const VIEW = {
  stored: { killSwitch: false, tools: { keynoteRoute: "engine" } },
  effective: { killSwitch: false, tools: { ...TOOLS, keynoteRoute: "engine" }, cropCache: true },
  defaults: { killSwitch: false, tools: TOOLS, cropCache: true },
  invalid: [] as string[],
};

let fetchMock: ReturnType<typeof vi.fn>;
const puts = () => fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === "PUT");

beforeEach(() => {
  fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === "PUT") {
      const body = JSON.parse(String(init.body));
      return { ok: true, status: 200, json: async () => ({ ...VIEW, stored: body }) };
    }
    return { ok: true, status: 200, json: async () => VIEW };
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("draft ⇄ body (pure)", () => {
  it("unpinned fields stay absent; pinned ones round-trip", () => {
    const d = draftFromStored({ killSwitch: true, cropCache: false, tools: { workspace: "legacy", bogus: "engine" } });
    expect(d.killSwitch).toBe(true);
    expect(d.cropCache).toBe("off");
    expect(d.tools.workspace).toBe("legacy");
    expect(d.tools.tablesRoute).toBe("default");
    expect(bodyFromDraft(d)).toEqual({ killSwitch: true, cropCache: false, tools: { workspace: "legacy" } });
    expect(bodyFromDraft(draftFromStored(null))).toEqual({ killSwitch: false, tools: {} });
  });
});

describe("ParseEngineCard", () => {
  it("loads the stored overrides, pins one more tool and saves only the pinned fields", async () => {
    render(<ParseEngineCard />);
    const tables = await screen.findByRole("combobox", { name: "Schedules / tables (classic parse)" });
    await waitFor(() => expect((screen.getByRole("combobox", { name: "Keynotes (classic parse)" }) as HTMLSelectElement).value).toBe("engine"));
    const save = screen.getByRole("button", { name: "Save" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.change(tables, { target: { value: "engine" } });
    expect(save.disabled).toBe(false);
    fireEvent.click(save);
    await waitFor(() => expect(puts()).toHaveLength(1));
    const [url, init] = puts()[0] as [string, RequestInit];
    expect(url).toBe("/api/admin/parse-engine");
    expect(JSON.parse(String(init.body))).toEqual({ killSwitch: false, tools: { tablesRoute: "engine", keynoteRoute: "engine" } });
    await screen.findByText("Saved.");
  });

  it("the kill switch saves and says what it does", async () => {
    render(<ParseEngineCard />);
    const kill = (await screen.findByRole("checkbox", { name: "Kill switch" })) as HTMLInputElement;
    await waitFor(() => expect(kill.disabled).toBe(false));
    fireEvent.click(kill);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(puts()).toHaveLength(1));
    expect(JSON.parse(String((puts()[0][1] as RequestInit).body)).killSwitch).toBe(true);
    await screen.findByText(/kill switch is ON/);
  });
});
