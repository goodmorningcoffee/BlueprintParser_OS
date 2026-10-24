// [2026-10-24 master Reprocess tab] The admin page owns no reprocess state any more: a tab's
// "Reprocess →" link hands a preset to the Reprocess tab and switches to it; the tab stays mounted
// (hidden) after the first visit so a running plan's console survives a tab switch; ?tab=reprocess
// deep-links. Real AdminPage + AdminTabs, stubbed HeuristicsTab and ReprocessTab.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

const h = vi.hoisted(() => ({
  session: { data: { user: { role: "admin", isRootAdmin: false } }, status: "authenticated" },
  router: { push: () => {}, replace: () => {} },
  reprocessProps: [] as Array<{ presetRequest: { preset: string; n: number } | null; isRootAdmin: boolean }>,
}));

vi.mock("next-auth/react", () => ({ useSession: () => h.session }));
vi.mock("next/navigation", () => ({ useRouter: () => h.router }));
vi.mock("@/components/dashboard/Header", () => ({ default: () => null }));
vi.mock("@/app/admin/tabs/HeuristicsTab", () => ({
  default: (props: { onOpenReprocess: (preset: string) => void }) => (
    <button onClick={() => props.onOpenReprocess("rules-changed")}>open-reprocess</button>
  ),
}));
vi.mock("@/app/admin/tabs/ReprocessTab", () => ({
  default: (props: { presetRequest: { preset: string; n: number } | null; isRootAdmin: boolean }) => {
    h.reprocessProps.push(props);
    return <div data-testid="reprocess-tab">reprocess</div>;
  },
}));

import AdminPage from "@/app/admin/page";
import { TAB_IDS } from "@/app/admin/AdminTabs";

beforeEach(() => {
  h.reprocessProps = [];
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, json: async () => [] })));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("admin page × Reprocess tab", () => {
  it("'reprocess' is a real tab id (deep link) and renders the tab", async () => {
    expect(TAB_IDS).toContain("reprocess");
    window.history.replaceState(null, "", "/admin?tab=reprocess");
    await act(async () => { render(<AdminPage />); });
    expect(screen.getByTestId("reprocess-tab")).toBeTruthy();
    expect(h.reprocessProps.at(-1)?.presetRequest).toBeNull();
  });

  it("a tab's Reprocess link hands over its preset, switches the tab, and the tab stays mounted (hidden) afterwards", async () => {
    window.history.replaceState(null, "", "/admin?tab=heuristics");
    await act(async () => { render(<AdminPage />); });
    expect(screen.queryByTestId("reprocess-tab")).toBeNull();

    await act(async () => { fireEvent.click(screen.getByText("open-reprocess")); });
    expect(window.location.search).toBe("?tab=reprocess");
    const tab = screen.getByTestId("reprocess-tab");
    expect(h.reprocessProps.at(-1)?.presetRequest).toEqual({ preset: "rules-changed", n: 1 });
    expect((tab.parentElement as HTMLElement).hidden).toBe(false);

    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Pipeline" })); });
    expect(window.location.search).toBe("?tab=pipeline");
    expect((screen.getByTestId("reprocess-tab").parentElement as HTMLElement).hidden).toBe(true);
  });
});
