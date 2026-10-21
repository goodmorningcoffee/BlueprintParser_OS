// UploadWidget against mocked fetch + XHR: the requests each mode actually sends.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import UploadWidget from "../UploadWidget";

interface Call {
  url: string;
  body: string;
}

let calls: Call[] = [];
let projectSeq = 0;
let credCalls = 0;
// Returns a response to send instead of credentials for this (1-based) credentials call, or null.
let credResponder: (n: number) => { status: number; json: unknown } | null = () => null;
let projectResponder: (body: { name: string }) => { status: number; json: unknown } = () => ({
  status: 200,
  json: { id: "x", name: "x", status: "uploading" },
});

function jsonResponse(status: number, json: unknown): Response {
  return { ok: status < 300, status, json: async () => json } as unknown as Response;
}

const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
  const body = String(init.body);
  calls.push({ url, body });
  if (url === "/api/s3/staging-credentials") {
    const refusal = credResponder(++credCalls);
    if (refusal) return jsonResponse(refusal.status, refusal.json);
    const { filenames } = JSON.parse(body) as { filenames: string[] };
    const projectPath = `co/p${++projectSeq}`;
    return jsonResponse(200, {
      projectPath,
      files: filenames.map((filename, index) => ({
        filename,
        url: "https://s3.example/staging",
        fields: { key: `${projectPath}/staging/${index}/${filename}` },
        stagingKey: `${projectPath}/staging/${index}/${filename}`,
        index,
      })),
    });
  }
  if (url === "/api/projects") {
    const r = projectResponder(JSON.parse(body) as { name: string });
    return jsonResponse(r.status, r.json);
  }
  throw new Error(`unexpected fetch ${url}`);
});

class FakeXHR {
  status = 204;
  upload: { onprogress: ((e: ProgressEvent) => void) | null } = { onprogress: null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  open() {}
  send() {
    setTimeout(() => {
      this.upload.onprogress?.({ lengthComputable: true, loaded: 1, total: 1 } as ProgressEvent);
      this.onload?.();
    }, 0);
  }
}

function pdf(name: string): File {
  return new File(["%PDF-1.4"], name, { type: "application/pdf" });
}

// A pdf File that reports `bytes` as its size without allocating them.
function sizedPdf(name: string, bytes: number): File {
  const f = pdf(name);
  Object.defineProperty(f, "size", { value: bytes });
  return f;
}

const MB = 1024 * 1024;

function uploadButton(name: string): HTMLButtonElement {
  return screen.getByRole("button", { name }) as HTMLButtonElement;
}

function pick(files: File[]) {
  fireEvent.change(screen.getByTestId("upload-input"), { target: { files } });
}

function projectBodies() {
  return calls.filter((c) => c.url === "/api/projects").map((c) => JSON.parse(c.body) as Record<string, unknown>);
}

beforeEach(() => {
  calls = [];
  projectSeq = 0;
  credCalls = 0;
  credResponder = () => null;
  projectResponder = () => ({ status: 200, json: { id: "x", name: "x", status: "uploading" } });
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("XMLHttpRequest", FakeXHR);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  fetchMock.mockClear();
});

describe("UploadWidget", () => {
  it("single file: unchanged — one credentials call, one project named after the file, no toggle", async () => {
    const done = vi.fn();
    render(<UploadWidget onUploadComplete={done} />);
    pick([pdf("A-101.pdf")]);
    expect(screen.queryByLabelText(/Merge into one project/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Upload 1 file" }));
    await waitFor(() => expect(done).toHaveBeenCalledTimes(1));
    expect(calls.map((c) => c.url)).toEqual(["/api/s3/staging-credentials", "/api/projects"]);
    expect(calls[0].body).toBe(JSON.stringify({ filenames: ["A-101.pdf"] }));
    expect(calls[1].body).toBe(
      JSON.stringify({
        name: "A-101",
        dataUrl: "co/p1",
        stagingFiles: [{ filename: "A-101.pdf", stagingKey: "co/p1/staging/0/A-101.pdf" }],
      }),
    );
  });

  it("several files default to one project per file, named after each file; onUploadComplete once", async () => {
    const done = vi.fn();
    render(<UploadWidget onUploadComplete={done} />);
    pick([pdf("C.pdf"), pdf("A.pdf"), pdf("B.pdf")]);
    const toggle = screen.getByLabelText(/Merge into one project/) as HTMLInputElement;
    expect(toggle.checked).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Upload 3 files as 3 projects" }));
    await waitFor(() => expect(done).toHaveBeenCalledTimes(1));
    expect(calls.map((c) => c.url)).toEqual([
      "/api/s3/staging-credentials",
      "/api/projects",
      "/api/s3/staging-credentials",
      "/api/projects",
      "/api/s3/staging-credentials",
      "/api/projects",
    ]);
    expect(projectBodies().map((b) => b.name)).toEqual(["A", "B", "C"]);
    expect(done).toHaveBeenCalledTimes(1);
    // Fully successful batch clears the selection, as the single-file path does.
    expect(screen.queryAllByTestId("upload-row")).toHaveLength(0);
  });

  it("merge toggle ON reproduces today's single request shape", async () => {
    const done = vi.fn();
    render(<UploadWidget onUploadComplete={done} />);
    pick([pdf("B.pdf"), pdf("A.pdf"), pdf("C.pdf")]);
    fireEvent.click(screen.getByLabelText(/Merge into one project/));
    fireEvent.click(screen.getByRole("button", { name: "Upload 3 files" }));
    await waitFor(() => expect(done).toHaveBeenCalledTimes(1));
    expect(calls.map((c) => c.url)).toEqual(["/api/s3/staging-credentials", "/api/projects"]);
    expect(calls[0].body).toBe(JSON.stringify({ filenames: ["A.pdf", "B.pdf", "C.pdf"] }));
    expect(calls[1].body).toBe(
      JSON.stringify({
        name: "A (+2)",
        dataUrl: "co/p1",
        stagingFiles: [
          { filename: "A.pdf", stagingKey: "co/p1/staging/0/A.pdf" },
          { filename: "B.pdf", stagingKey: "co/p1/staging/1/B.pdf" },
          { filename: "C.pdf", stagingKey: "co/p1/staging/2/C.pdf" },
        ],
      }),
    );
  });

  it("a failing file does not stop the rest; only the failed file stays selected", async () => {
    projectResponder = (b) =>
      b.name === "A"
        ? { status: 400, json: { error: { code: "VALIDATION", message: "Staged file missing in S3: A.pdf" } } }
        : { status: 200, json: { id: "x", name: b.name, status: "uploading" } };
    const done = vi.fn();
    render(<UploadWidget onUploadComplete={done} />);
    pick([pdf("A.pdf"), pdf("B.pdf"), pdf("C.pdf")]);
    fireEvent.click(screen.getByRole("button", { name: "Upload 3 files as 3 projects" }));
    await screen.findByText("2 of 3 projects created · 1 failed — see rows below");
    expect(projectBodies().map((b) => b.name)).toEqual(["A", "B", "C"]);
    expect(done).toHaveBeenCalledTimes(1);
    const rows = screen.getAllByTestId("upload-row");
    expect(rows).toHaveLength(1);
    expect(rows[0].textContent).toContain("A.pdf");
    expect(rows[0].textContent).toContain("Staged file missing in S3: A.pdf");
    // Retry is offered for what is left.
    expect((screen.getByRole("button", { name: "Upload 1 file" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("a 429 stops the remaining files and shows the server's message plus N not uploaded", async () => {
    projectResponder = (b) =>
      b.name === "B"
        ? { status: 429, json: { error: { code: "RATE_LIMITED", message: "Daily upload limit reached" } } }
        : { status: 200, json: { id: "x", name: b.name, status: "uploading" } };
    const done = vi.fn();
    render(<UploadWidget onUploadComplete={done} />);
    pick([pdf("A.pdf"), pdf("B.pdf"), pdf("C.pdf"), pdf("D.pdf")]);
    fireEvent.click(screen.getByRole("button", { name: "Upload 4 files as 4 projects" }));
    await screen.findByText("Daily upload limit reached · 3 not uploaded · 1 of 4 projects created");
    expect(projectBodies().map((b) => b.name)).toEqual(["A", "B"]);
    expect(calls.filter((c) => c.url === "/api/s3/staging-credentials")).toHaveLength(2);
    expect(done).toHaveBeenCalledTimes(1);
    const statuses = screen.getAllByTestId("upload-row-status").map((s) => s.textContent);
    expect(statuses).toEqual(["failed", "not uploaded", "not uploaded"]);
  });

  it("a 429 from staging credentials (the daily-quota path) stops the rest the same way", async () => {
    // The server checks the daily quota in stagingCredentials before any upload, so mid-batch
    // over-quota surfaces here, not on /api/projects. This drives the widget's real wiring.
    credResponder = (n) =>
      n === 2
        ? { status: 429, json: { error: { code: "RATE_LIMITED", message: "Daily upload limit reached" } } }
        : null;
    const done = vi.fn();
    render(<UploadWidget onUploadComplete={done} />);
    pick([pdf("A.pdf"), pdf("B.pdf"), pdf("C.pdf"), pdf("D.pdf")]);
    fireEvent.click(screen.getByRole("button", { name: "Upload 4 files as 4 projects" }));
    await screen.findByText("Daily upload limit reached · 3 not uploaded · 1 of 4 projects created");
    expect(calls.filter((c) => c.url === "/api/s3/staging-credentials")).toHaveLength(2);
    expect(projectBodies().map((b) => b.name)).toEqual(["A"]);
    expect(done).toHaveBeenCalledTimes(1);
    const statuses = screen.getAllByTestId("upload-row-status").map((s) => s.textContent);
    expect(statuses).toEqual(["failed", "not uploaded", "not uploaded"]);
  });

  it("no project created → onUploadComplete is not called", async () => {
    projectResponder = () => ({ status: 500, json: { error: { code: "INTERNAL", message: "Internal error" } } });
    const done = vi.fn();
    render(<UploadWidget onUploadComplete={done} />);
    pick([pdf("A.pdf"), pdf("B.pdf")]);
    fireEvent.click(screen.getByRole("button", { name: "Upload 2 files as 2 projects" }));
    await screen.findByText("0 of 2 projects created · 2 failed — see rows below");
    expect(done).not.toHaveBeenCalled();
  });

  it("31 files are refused in both modes: error shown, upload disabled, nothing sent", () => {
    render(<UploadWidget onUploadComplete={vi.fn()} />);
    pick(Array.from({ length: 31 }, (_, i) => pdf(`S${String(i).padStart(2, "0")}.pdf`)));
    expect(screen.getByText("Maximum 30 files per upload (got 31)")).toBeTruthy();
    const perFile = uploadButton("Upload 31 files as 31 projects");
    expect(perFile.disabled).toBe(true);
    fireEvent.click(perFile);
    fireEvent.click(screen.getByLabelText(/Merge into one project/));
    expect(screen.getByText("Maximum 30 files per project (got 31)")).toBeTruthy();
    const merged = uploadButton("Upload 31 files");
    expect(merged.disabled).toBe(true);
    fireEvent.click(merged);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("over 2 GB in total: blocked when merging, allowed one project per file", async () => {
    const done = vi.fn();
    render(<UploadWidget onUploadComplete={done} />);
    // 5 × 450 MB: each under the 500 MB per-file limit, 2250 MB together.
    pick(["A", "B", "C", "D", "E"].map((n) => sizedPdf(`${n}.pdf`, 450 * MB)));
    expect(screen.queryByText(/exceeds 2 GB cap/)).toBeNull();
    expect(uploadButton("Upload 5 files as 5 projects").disabled).toBe(false);
    fireEvent.click(screen.getByLabelText(/Merge into one project/));
    expect(screen.getByText("Aggregate size 2250.0 MB exceeds 2 GB cap")).toBeTruthy();
    const merged = uploadButton("Upload 5 files");
    expect(merged.disabled).toBe(true);
    fireEvent.click(merged);
    expect(fetchMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByLabelText(/Merge into one project/));
    expect(screen.queryByText(/exceeds 2 GB cap/)).toBeNull();
    fireEvent.click(uploadButton("Upload 5 files as 5 projects"));
    await waitFor(() => expect(done).toHaveBeenCalledTimes(1));
    expect(projectBodies().map((b) => b.name)).toEqual(["A", "B", "C", "D", "E"]);
  });

  it("per-file limits are checked at pick time in both modes: row messages, upload disabled, nothing sent", () => {
    render(<UploadWidget onUploadComplete={vi.fn()} />);
    const doc = new File(["x"], "notes.docx", { type: "application/octet-stream" });
    pick([sizedPdf("big.pdf", 501 * MB), doc, pdf("ok.pdf")]);
    const rowText = screen.getAllByTestId("upload-row").map((r) => r.textContent ?? "");
    expect(rowText[0]).toContain("Too large (501.0 MB > 500 MB)");
    expect(rowText[1]).toContain("Unsupported type: .docx");
    expect(rowText[2]).not.toMatch(/Too large|Unsupported/);
    const perFile = uploadButton("Upload 3 files as 3 projects");
    expect(perFile.disabled).toBe(true);
    fireEvent.click(perFile);
    fireEvent.click(screen.getByLabelText(/Merge into one project/));
    const merged = uploadButton("Upload 3 files");
    expect(merged.disabled).toBe(true);
    fireEvent.click(merged);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a new selection resets the merge toggle to off (per-file default)", async () => {
    const done = vi.fn();
    render(<UploadWidget onUploadComplete={done} />);
    pick([pdf("A.pdf"), pdf("B.pdf")]);
    fireEvent.click(screen.getByLabelText(/Merge into one project/));
    expect((screen.getByLabelText(/Merge into one project/) as HTMLInputElement).checked).toBe(true);
    pick([pdf("X.pdf"), pdf("Y.pdf")]);
    expect((screen.getByLabelText(/Merge into one project/) as HTMLInputElement).checked).toBe(false);
    fireEvent.click(uploadButton("Upload 2 files as 2 projects"));
    await waitFor(() => expect(done).toHaveBeenCalledTimes(1));
    expect(projectBodies().map((b) => b.name)).toEqual(["X", "Y"]);
  });
});
