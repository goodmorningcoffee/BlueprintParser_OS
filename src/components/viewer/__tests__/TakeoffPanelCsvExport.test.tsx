// [TP-1 WP-1.C fix, K64 / VERIFY L3] The takeoff "CSV" export runs every name and note through
// csvQuotedSafe, in all three row shapes (area, linear, count). The helper itself is unit-tested in
// csv-safe.test.ts; this pins the wiring, so a row that goes back to raw quoting fails here.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { seedTakeoff } from "@/test/seed-takeoff";
import type { ClientTakeoffItem } from "@/types";
import TakeoffPanel from "../TakeoffPanel";
import { resetProjectData } from "@/stores/viewerCommands";
import { setViewerStoreStateForTest } from "@/test/viewer-store-state";

let qc: QueryClient;
function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}
function item(over: Partial<ClientTakeoffItem> & { id: number; name: string }): ClientTakeoffItem {
  return { shape: "circle", color: "#ef4444", size: 10, sortOrder: 0, groupId: null, ...over };
}

let exported: string[];
beforeEach(() => {
  qc = new QueryClient();
  resetProjectData();
  setViewerStoreStateForTest({ publicId: "pid", isDemo: false });
  exported = [];
  vi.stubGlobal("fetch", vi.fn(async (url: unknown) => {
    throw new Error(`unexpected raw fetch in takeoff CSV export test: ${url}`);
  }));
  vi.stubGlobal("Blob", class {
    constructor(parts: string[]) { exported.push(parts.join("")); }
  });
  vi.stubGlobal("URL", Object.assign(Object.create(URL), {
    createObjectURL: vi.fn(() => "blob:takeoff"),
    revokeObjectURL: vi.fn(),
  }));
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("TakeoffPanel CSV export neutralises formula-led names and notes (K64)", () => {
  it("area, linear and count rows all write '-prefixed, quoted cells", async () => {
    seedTakeoff(qc, [
      item({ id: 1, name: "=1+1", notes: "@SUM(A1)", shape: "polygon" }),
      item({ id: 2, name: "+cmd", notes: "-2+3", shape: "linear" }),
      item({ id: 3, name: "=HYPERLINK(\"x\")", notes: "plain", shape: "circle" }),
    ], []);
    render(<TakeoffPanel />, { wrapper });
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: "CSV" }));

    expect(exported).toHaveLength(1);
    const [header, ...rows] = exported[0].split("\n");
    expect(header).toBe("Item Name,Type,Shape,Quantity,Unit,Pages,Notes,Color");
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatch(/^"'=1\+1",area,polygon,/);
    expect(rows[0]).toMatch(/,"'@SUM\(A1\)",#ef4444$/);
    expect(rows[1]).toMatch(/^"'\+cmd",linear,linear,/);
    expect(rows[1]).toMatch(/,"'-2\+3",#ef4444$/);
    expect(rows[2]).toMatch(/^"'=HYPERLINK\(""x""\)",count,circle,0,EA,"",/);
    expect(rows[2]).toMatch(/,"plain",#ef4444$/);
  });
});
