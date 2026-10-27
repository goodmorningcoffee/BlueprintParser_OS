// @vitest-environment jsdom
// [table pipeline WP-2.F] The verdict bar: ✓ and ✗ only; reads the page's labels with one GET; a click POSTs
// the verdict (no client snapshot), clicking the active one DELETEs it; an inferred "corrected" shows; an
// edit of the region's data re-reads the labels; demo shows nothing and never fetches. All strings synthetic.

import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const project = vi.hoisted(() => ({ value: { publicId: "pub-1", isDemo: false, projectId: 1 } }));
vi.mock("@/stores/sessionStore", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/stores/sessionStore")>();
  return { ...actual, useProject: () => project.value };
});

import ParseVerdictBar from "../ParseVerdictBar";

let queryClient: QueryClient;
const fetchMock = vi.fn();
let labels: Record<string, unknown>;

const json = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body }) as unknown as Response;

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

const REGION = { id: "parsed-a", data: { headers: ["Mark"], rows: [{ Mark: "QX-1" }] } };

beforeEach(() => {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  project.value = { publicId: "pub-1", isDemo: false, projectId: 1 };
  labels = {};
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (method === "GET") return json({ page: 2, labels });
    const body = JSON.parse(String(init!.body));
    if (method === "POST") return json({ regionId: body.regionId, label: { verdict: body.verdict, at: "2026-10-27T00:00:00.000Z" } });
    return json({ removed: true });
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  queryClient.clear();
  vi.unstubAllGlobals();
});

const gets = () => fetchMock.mock.calls.filter(([, init]) => !init?.method || init.method === "GET");
const writes = () => fetchMock.mock.calls.filter(([, init]) => init?.method && init.method !== "GET");

describe("ParseVerdictBar", () => {
  it("renders exactly ✓ and ✗, reads the page's labels once, and POSTs only region + verdict", async () => {
    render(<ParseVerdictBar pageNumber={2} region={REGION} />, { wrapper });
    const group = screen.getByRole("group", { name: "Parse verdict" });
    expect(group.querySelectorAll("button")).toHaveLength(2);
    await waitFor(() => expect(gets()).toHaveLength(1));
    expect(gets()[0][0]).toBe("/api/projects/pub-1/parse-labels?page=2");
    fireEvent.click(screen.getByRole("button", { name: "Parse is wrong" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Parse is wrong" })).toHaveAttribute("aria-pressed", "true"));
    const [url, init] = writes()[0];
    expect(url).toBe("/api/projects/pub-1/parse-labels");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ pageNumber: 2, regionId: "parsed-a", verdict: "wrong" });
    expect(screen.getByRole("button", { name: "Parse is correct" })).toHaveAttribute("aria-pressed", "false");
  });

  it("clicking the active verdict removes it (DELETE)", async () => {
    labels = { "parsed-a": { verdict: "correct", at: "x" } };
    render(<ParseVerdictBar pageNumber={2} region={REGION} />, { wrapper });
    await waitFor(() => expect(screen.getByRole("button", { name: "Parse is correct" })).toHaveAttribute("aria-pressed", "true"));
    fireEvent.click(screen.getByRole("button", { name: "Parse is correct" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Parse is correct" })).toHaveAttribute("aria-pressed", "false"));
    expect(writes()[0][1].method).toBe("DELETE");
    expect(JSON.parse(String(writes()[0][1].body))).toEqual({ pageNumber: 2, regionId: "parsed-a" });
  });

  it("an edit of the region re-reads the labels, and a server-inferred corrected shows", async () => {
    labels = { "parsed-a": { verdict: "wrong", at: "x" } };
    const view = render(<ParseVerdictBar pageNumber={2} region={REGION} />, { wrapper });
    await waitFor(() => expect(screen.getByRole("button", { name: "Parse is wrong" })).toHaveAttribute("aria-pressed", "true"));
    expect(gets()).toHaveLength(1);
    labels = { "parsed-a": { verdict: "corrected", at: "x", was: "wrong" } };
    view.rerender(<ParseVerdictBar pageNumber={2} region={{ ...REGION, data: { ...REGION.data, rows: [{ Mark: "QX-9" }] } }} />);
    await waitFor(() => expect(screen.getByText("corrected")).toBeInTheDocument());
    expect(gets()).toHaveLength(2);
    expect(screen.getByRole("button", { name: "Parse is wrong" })).toHaveAttribute("aria-pressed", "false");
  });

  it("a failed write shows the server message", async () => {
    fetchMock.mockImplementation(async (_url: string, init?: RequestInit) =>
      !init?.method || init.method === "GET" ? json({ page: 2, labels: {} }) : json({ error: { message: "Parsed region not found" } }, 404));
    render(<ParseVerdictBar pageNumber={2} region={REGION} />, { wrapper });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Parse is correct" })); });
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Parsed region not found"));
  });

  it("demo or a region without a saved id renders nothing and never fetches", async () => {
    project.value = { publicId: "pub-1", isDemo: true, projectId: 1 };
    const view = render(<ParseVerdictBar pageNumber={2} region={REGION} />, { wrapper });
    expect(screen.queryByRole("group", { name: "Parse verdict" })).toBeNull();
    await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
    expect(fetchMock).not.toHaveBeenCalled();
    project.value = { publicId: "pub-1", isDemo: false, projectId: 1 };
    view.rerender(<ParseVerdictBar pageNumber={2} region={{ data: {} }} />);
    expect(screen.queryByRole("group", { name: "Parse verdict" })).toBeNull();
    expect(writes()).toHaveLength(0);
  });
});
