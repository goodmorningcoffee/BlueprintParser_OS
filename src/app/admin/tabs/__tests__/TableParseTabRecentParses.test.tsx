// [TP-1 WP-1.C fix, K08 / VERIFY L1] /api/admin/recent-parses is root-only, so the Recent Parses
// card renders for root only (a company admin would only ever see the route's 403), and Clear
// reports a refused DELETE instead of emptying the list as if it had worked.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import TableParseTab from "@/app/admin/tabs/TableParseTab";

const ENTRY = {
  id: "e1",
  timestamp: new Date(0).toISOString(),
  request: { projectId: 1, pageNumber: 1, regionBbox: [0, 0, 1, 1], debugMode: false, options: {} },
  response: {
    status: 200, durationMs: 5, headers: ["A"], rowCount: 1, confidence: 0.9,
    methods: [], methodResults: [], infraStages: [], infraErrors: [],
  },
};

let fetchMock: ReturnType<typeof vi.fn>;
let deleteStatus = 200;
const recentCalls = () => fetchMock.mock.calls.filter(([u]) => String(u) === "/api/admin/recent-parses");

beforeEach(() => {
  deleteStatus = 200;
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === "/api/admin/recent-parses") {
      if (init?.method === "DELETE") return { ok: deleteStatus < 400, status: deleteStatus, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => ({ entries: [ENTRY], maxEntries: 50 }) };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  });
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(window, "confirm").mockReturnValue(true);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("TableParseTab › Recent Parses (K08)", () => {
  it("is not rendered, and never fetched, for a company admin", async () => {
    render(<TableParseTab />);
    await screen.findByText("Table Parsing Debug");
    expect(screen.queryByText("Recent Parses")).toBeNull();
    expect(recentCalls()).toHaveLength(0);
  });

  it("renders for root; a refused DELETE says so and keeps the list", async () => {
    deleteStatus = 403;
    render(<TableParseTab isRootAdmin />);
    expect(await screen.findByText("Recent Parses")).toBeInTheDocument();
    await screen.findByText("1 / 50");
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(await screen.findByText("Failed to clear")).toBeInTheDocument();
    expect(screen.getByText("1 / 50")).toBeInTheDocument();
  });
});
