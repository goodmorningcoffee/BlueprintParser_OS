// [TP-1 WP-1.C fix, K75 / VERIFY L2] Data tools › Annotation cleanup sends `allCompanies:true` only
// when the root user left the picker on "All companies"; a picked company goes as `?companyId` and
// the flag is absent. The server refuses an unscoped POST without the flag, so losing it would make
// "All companies" fail with a 400 while every route test stays green.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import DataToolsAnnotationCleanup from "@/app/admin/tabs/DataToolsAnnotationCleanup";

const SCOPE = {
  projects: [
    { publicId: "p3", name: "Three", companyId: 3, annotations: 4 },
    { publicId: "p4", name: "Four", companyId: 4, annotations: 2 },
  ],
  sources: [{ source: "yolo", count: 6, userMade: false }],
};

let fetchMock: ReturnType<typeof vi.fn>;
const posts = () => fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === "POST");

beforeEach(() => {
  fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      const body = JSON.parse(String(init.body));
      return {
        ok: true, status: 200,
        json: async () => ({
          dryRun: true, mode: body.mode, sources: body.sources, clearPageCsi: false, confirmPhrase: "DELETE",
          projects: [], total: 0, pagesCsiCleared: 0,
        }),
      };
    }
    return { ok: true, status: 200, json: async () => SCOPE };
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("DataToolsAnnotationCleanup — company scope on the cleanup POST (K75)", () => {
  it("'All companies' sends allCompanies:true with no companyId; a picked company sends neither the flag nor all companies", async () => {
    render(<DataToolsAnnotationCleanup isRootAdmin onOpenReprocess={() => {}} />);
    await screen.findByRole("option", { name: "Company 4" });

    fireEvent.click(screen.getByRole("button", { name: "Count (dry run)" }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    const [allUrl, allInit] = posts()[0] as [string, RequestInit];
    expect(allUrl).toBe("/api/admin/annotation-cleanup");
    expect(JSON.parse(String(allInit.body))).toMatchObject({ allCompanies: true, dryRun: true, all: true });

    fireEvent.change(screen.getByRole("combobox"), { target: { value: "3" } });
    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([u, i]) => u === "/api/admin/annotation-cleanup?companyId=3" && !i?.method?.startsWith("P"))).toBe(true),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Count (dry run)" }));
    await waitFor(() => expect(posts()).toHaveLength(2));
    const [oneUrl, oneInit] = posts()[1] as [string, RequestInit];
    expect(oneUrl).toBe("/api/admin/annotation-cleanup?companyId=3");
    expect(JSON.parse(String(oneInit.body))).not.toHaveProperty("allCompanies");
  });
});
