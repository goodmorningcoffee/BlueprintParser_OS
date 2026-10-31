// [refactor jun16 P0-review] Carried-forward browser golden paths (S004→S007).
//
// The P0.3 route tests froze the API layer; these freeze the BROWSER round-trip
// through the viewer — the user-visible contracts that must hold before any P2
// viewer refactor. Five flows, all offline over the cdn-stub + seeded test DB
// (e2e/global-setup.ts):
//   1. draw a COUNT marker → reload → it persisted (a real POST /api/annotations
//      round-trip; the thing G6 made reliable)
//   2. TABLE parse — draw a region, consume deterministic parser output, then
//      promote/delete through the real browser client and survive both reloads
//   3. DEMO read-only — drawing in a demo project fires NO write request
//      (canPersist short-circuit; cross-tenant/demo invariant)
//   4. DEMO retained table delete is local-only and returns after reload
//   5. SEARCH jump — a query filters the sidebar to matching pages and a click
//      navigates to one (server FTS over pages.search_vector)
//
// Selectors verified against source (CountTab/ViewerToolbar/PageSidebar) — see
// the scouting notes in the S007 memory. world.json carries the seeded ids.
import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";

const world = JSON.parse(readFileSync("e2e/.state/world.json", "utf8"));
// { publicId, projectDbId, demoPublicId, demoProjectDbId, email, password, dataUrl, demoDataUrl, pages }

test.beforeEach(async ({ page }) => {
  // The offline fixture intentionally has no page/thumbnail PNG underlays. Replace those missing
  // browser requests with deterministic 404s so fallback/preload/sidebar probes do not spend
  // gateway DB/S3 admission. This interception is fixture isolation, not gateway evidence.
  await page.route(
    /\/api\/project-assets\/[^/]+\/(?:pages|thumbnails)\/page_\d{4}\.png(?:\?.*)?$/,
    async (route) => {
      if (route.request().method() !== "GET") return route.continue();
      await route.fulfill({
        status: 404,
        contentType: "text/plain",
        body: "not found",
      });
    },
  );
});

async function login(page: import("@playwright/test").Page) {
  await page.goto("/login");
  await page.getByPlaceholder("Email").first().fill(world.email);
  await page.getByPlaceholder("Password").first().fill(world.password);
  await page.locator('button[type="submit"]').first().click();
  await page.waitForURL("**/home**", { timeout: 60_000 });
}

async function openViewer(page: import("@playwright/test").Page, path: string) {
  await page.goto(path);
  await page.waitForSelector("canvas", { timeout: 120_000 });
}

async function interactiveViewerCanvas(page: import("@playwright/test").Page) {
  // The PDF canvas mounts at its HTML default 300×150 before pdf.js publishes real page
  // dimensions; event overlays therefore exist briefly at 0×0. Wait for the overlay itself,
  // not merely for any canvas, before dispatching a gesture.
  await page.waitForFunction(
    () =>
      Array.from(document.querySelectorAll("canvas")).some((node) => {
        const canvas = node as HTMLCanvasElement;
        const rect = canvas.getBoundingClientRect();
        const style = getComputedStyle(canvas);
        return (
          canvas.dataset.pageCanvas !== "true" &&
          style.position === "absolute" &&
          style.pointerEvents === "auto" &&
          rect.width > 0 &&
          rect.height > 0 &&
          rect.right > 0 &&
          rect.bottom > 0 &&
          rect.left < innerWidth &&
          rect.top < innerHeight
        );
      }),
    undefined,
    { timeout: 120_000 },
  );

  const canvases = page.locator("canvas");
  const index = await canvases.evaluateAll((nodes) => {
    let lastMatch = -1;
    nodes.forEach((node, candidateIndex) => {
      const canvas = node as HTMLCanvasElement;
      const rect = canvas.getBoundingClientRect();
      const style = getComputedStyle(canvas);
      if (
        canvas.dataset.pageCanvas !== "true" &&
        style.position === "absolute" &&
        style.pointerEvents === "auto" &&
        rect.width > 0 &&
        rect.height > 0 &&
        rect.right > 0 &&
        rect.bottom > 0 &&
        rect.left < innerWidth &&
        rect.top < innerHeight
      ) {
        lastMatch = candidateIndex;
      }
    });
    return lastMatch;
  });
  if (index < 0)
    throw new Error("interactive viewer canvas not found after readiness wait");
  return canvases.nth(index);
}

async function visibleCanvasBox(
  page: import("@playwright/test").Page,
  canvas: import("@playwright/test").Locator,
) {
  const box = await canvas.boundingBox();
  const viewport = page.viewportSize();
  if (!box || !viewport) throw new Error("canvas has no visible box");
  const x = Math.max(0, box.x);
  const y = Math.max(0, box.y);
  const right = Math.min(viewport.width, box.x + box.width);
  const bottom = Math.min(viewport.height, box.y + box.height);
  if (right - x < 50 || bottom - y < 50)
    throw new Error("canvas visible area is too small");
  return { x, y, width: right - x, height: bottom - y };
}

async function openSchedulesPanel(page: import("@playwright/test").Page) {
  const heading = page.getByRole("heading", { name: "Schedules / Tables" });
  if (await heading.isVisible()) return;
  await page.getByTitle("Schedules & Table Parser").click();
  // [TP-3] With the parse-engine workspace flag on (the code default) the toolbar opens the Tables
  // workspace once its flags have loaded, and the classic panel is one click inside
  // ("Classic tools ▸"). Before the flags resolve the same button opens the classic panel directly
  // (and the demo viewer always does), so the outcome of one click is a fetch race: wait for
  // whichever surface appears and step through the workspace when it is the one that did.
  const classicTools = page.getByRole("button", { name: "Classic tools" });
  await Promise.race([
    heading.waitFor({ state: "visible", timeout: 15_000 }),
    classicTools.waitFor({ state: "visible", timeout: 15_000 }),
  ]).catch(() => undefined);
  if (!(await heading.isVisible()) && (await classicTools.isVisible())) {
    await classicTools.click();
  }
  await expect(heading).toBeVisible({ timeout: 15_000 });
}

async function openAllTables(page: import("@playwright/test").Page) {
  await openSchedulesPanel(page);
  await page.getByRole("button", { name: "All Tables", exact: true }).click();
}

async function drawViewerRegion(page: import("@playwright/test").Page) {
  await page.getByRole("button", { name: "Fit" }).click();
  await page.waitForTimeout(400);
  const canvas = await interactiveViewerCanvas(page);
  const box = await visibleCanvasBox(page, canvas);
  await page.mouse.move(box.x + box.width * 0.25, box.y + box.height * 0.25);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.55, {
    steps: 8,
  });
  await page.mouse.up();
}

// Write requests the viewer makes for annotation/takeoff/region mutations —
// the two demo flows assert NONE of these fire.
const WRITE_RE =
  /\/api\/(annotations|takeoff-items|takeoff-groups|regions|qto-workflows|pages\/intelligence)/;
const isWrite = (req: import("@playwright/test").Request) =>
  !["GET", "HEAD", "OPTIONS"].includes(req.method()) &&
  WRITE_RE.test(req.url());

// ── FLOW 1 — draw a count marker, reload, confirm it persisted ──────────────
// Fit first, then target the computed pointer-enabled overlay canvas—not the first PDF/render
// canvas in the multi-canvas stack. This closes the old coordinate-only fixme without adding a
// production test id or changing sacred canvas order.
test("draw-count → reload → persists", async ({ page }) => {
  await login(page);
  await openViewer(page, `/project/${world.publicId}`);

  // open the QTO panel and create a count item (sets it active for placement)
  await page.getByRole("button", { name: "QTO" }).click();
  await page.getByText("+ Add Count Item").click();
  await page.getByPlaceholder("Item name...").fill("Doors");
  const itemSaved = page.waitForResponse(
    (r) =>
      r.url().includes("/api/takeoff-items") &&
      r.request().method() === "POST" &&
      r.ok(),
  );
  await page.getByRole("button", { name: "Create" }).click();
  await itemSaved;

  // place 3 markers on the canvas (page 1). Each plain click drops a marker and
  // POSTs it. Stagger > 14px apart (a near-click selects instead of placing).
  await page.getByRole("button", { name: "Fit" }).click();
  await page.waitForTimeout(400);
  const canvas = await interactiveViewerCanvas(page);
  const box = await visibleCanvasBox(page, canvas);
  for (const [dx, dy] of [
    [0.3, 0.3],
    [0.55, 0.4],
    [0.45, 0.65],
  ]) {
    const saved = page.waitForResponse(
      (r) =>
        r.url().includes("/api/annotations") &&
        r.request().method() === "POST" &&
        r.ok(),
    );
    await page.mouse.click(box.x + box.width * dx, box.y + box.height * dy);
    await saved;
  }

  // footer reads "{total} total across {n} items" — 3 markers in 1 item
  await expect(page.getByText(/3 total across 1 item/)).toBeVisible({
    timeout: 10_000,
  });

  // the real assertion: reload, reopen QTO, the 3 still there (loaded from DB)
  await page.reload();
  await page.waitForSelector("canvas", { timeout: 60_000 });
  await page.getByRole("button", { name: "QTO" }).click();
  await expect(page.getByText(/3 total across 1 item/)).toBeVisible({
    timeout: 15_000,
  });
});

// ── FLOW 2 — ParsedRegion promote → render → reload → delete → reload absent ─
test("parsed schedule promote and delete both survive reload", async ({
  page,
}) => {
  await login(page);
  const tableName = "E2E Door Schedule";
  let tableParseCalls = 0;
  await page.route("**/api/table-parse", async (route) => {
    tableParseCalls++;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        headers: ["TAG", "DESCRIPTION"],
        rows: [{ TAG: "D-101", DESCRIPTION: "Single door" }],
        tagColumn: "TAG",
        colBoundaries: [0, 0.4, 1],
        rowBoundaries: [0, 1],
        methods: [],
        methodResults: [],
        infraErrors: [],
        mergerNotes: null,
      }),
    });
  });

  await openViewer(page, `/project/${world.publicId}`);
  await openSchedulesPanel(page);
  await page.getByRole("button", { name: "Auto Parse" }).click();
  await page.getByRole("button", { name: "Draw Table Region" }).click();
  await drawViewerRegion(page);

  const process = page.getByRole("button", { name: "Process Region" });
  await expect(process).toBeVisible({ timeout: 15_000 });
  const parsed = page.waitForRequest(
    (request) =>
      new URL(request.url()).pathname === "/api/table-parse" &&
      request.method() === "POST",
  );
  const autoPromoted = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/regions/promote") &&
      response.request().method() === "POST" &&
      response.ok(),
  );
  await process.click();
  const parseRequest = await parsed;
  const parseBody = parseRequest.postDataJSON();
  expect(parseBody.projectId).toBe(world.projectDbId);
  expect(parseBody.pageNumber).toBe(1);
  expect(parseBody.regionBbox).toHaveLength(4);
  const autoPromoteResponse = await autoPromoted;
  const autoPromoteBody = autoPromoteResponse.request().postDataJSON();
  expect(autoPromoteBody.publicId).toBe(world.publicId);
  expect(autoPromoteBody.pageNumber).toBe(1);
  expect(autoPromoteBody.type).toBe("schedule");
  expect(autoPromoteBody.overrides.data.rows).toEqual([
    { TAG: "D-101", DESCRIPTION: "Single door" },
  ]);
  expect(tableParseCalls).toBe(1);

  // Auto Parse persists immediately. Name the retained row through the same client command so
  // reload assertions can identify this exact table instead of relying on a generic category.
  await page
    .getByPlaceholder("Name this table (e.g. Door Schedule)...")
    .fill(tableName);
  const named = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/regions/promote") &&
      response.request().method() === "POST" &&
      response.ok(),
  );
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await named;
  await expect(
    page.getByPlaceholder("Name this table (e.g. Door Schedule)..."),
  ).not.toBeAttached({ timeout: 15_000 });
  await page.getByRole("button", { name: "All Tables" }).click();
  await expect(page.getByText(tableName)).toBeVisible({ timeout: 15_000 });

  await page.reload();
  await page.waitForSelector("canvas", { timeout: 120_000 });
  await openAllTables(page);
  await expect(page.getByText(tableName)).toBeVisible({ timeout: 15_000 });

  const deleted = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/regions") &&
      response.request().method() === "DELETE" &&
      response.ok(),
  );
  await page.getByTitle("Delete table").click();
  const deletedResponse = await deleted;
  expect(deletedResponse.request().postDataJSON()).toMatchObject({
    publicId: world.publicId,
    pageNumber: 1,
  });
  await expect(page.getByText(tableName)).not.toBeAttached({ timeout: 15_000 });

  await page.reload();
  await page.waitForSelector("canvas", { timeout: 120_000 });
  await openAllTables(page);
  await expect(page.getByText(tableName)).not.toBeAttached({ timeout: 15_000 });
  await expect(page.getByText("No parsed tables found.")).toBeVisible({
    timeout: 15_000,
  });
});

// ── FLOW 3 — demo project is read-only: drawing fires no write request ───────
test("demo viewer fires no write requests", async ({ page }) => {
  const writes: string[] = [];
  page.on("request", (r) => {
    if (isWrite(r)) writes.push(`${r.method()} ${r.url()}`);
  });

  // /demo/* routes are public — no login needed
  await openViewer(page, `/demo/project/${world.demoPublicId}`);

  // perform the exact Flow-1 actions; in demo they mutate local state only
  await page.getByRole("button", { name: "QTO" }).click();
  await page.getByText("+ Add Count Item").click();
  await page.getByPlaceholder("Item name...").fill("Doors");
  await page.getByRole("button", { name: "Create" }).click();
  await page.getByRole("button", { name: "Fit" }).click();
  await page.waitForTimeout(400);
  const canvas = await interactiveViewerCanvas(page);
  const box = await visibleCanvasBox(page, canvas);
  await page.mouse.click(box.x + box.width * 0.4, box.y + box.height * 0.4);

  // The item and marker both exist LOCALLY, proving the same gesture ran rather than a wrong-canvas
  // no-op making the zero-write assertion pass vacuously.
  // .first(): "Doors" renders twice in the panel (active-item header + list row)
  await expect(page.getByText("Doors").first()).toBeVisible({
    timeout: 10_000,
  });
  await expect(page.getByText(/1 total across 1 item/)).toBeVisible({
    timeout: 10_000,
  });

  // let any debounced/async save attempt fire, then assert NONE did
  await page.waitForTimeout(1000);
  expect(writes, `unexpected write(s) in demo: ${writes.join(", ")}`).toEqual(
    [],
  );
});

// ── FLOW 4 — demo retained-region delete is local-only ──────────────────────────────────
test("demo parsed schedule delete stays local and returns after reload", async ({
  page,
}) => {
  const writes: string[] = [];
  page.on("request", (request) => {
    if (isWrite(request)) writes.push(`${request.method()} ${request.url()}`);
  });
  const tableName = "E2E Demo Door Schedule";

  await openViewer(page, `/demo/project/${world.demoPublicId}`);
  await openAllTables(page);
  await expect(page.getByText(tableName)).toBeVisible({ timeout: 15_000 });
  await page.getByTitle("Delete table").click();
  await expect(page.getByText(tableName)).not.toBeAttached({ timeout: 15_000 });
  await page.waitForTimeout(500);
  expect(
    writes,
    `unexpected demo delete write(s): ${writes.join(", ")}`,
  ).toEqual([]);

  await page.reload();
  await page.waitForSelector("canvas", { timeout: 120_000 });
  await openAllTables(page);
  await expect(page.getByText(tableName)).toBeVisible({ timeout: 15_000 });
});

// ── FLOW 5 — search filters the sidebar and a click jumps to a page ──────────
test("search filters the sidebar and jumps to a page", async ({ page }) => {
  await login(page);
  await openViewer(page, `/project/${world.publicId}`);

  // type a term seeded into every page's search_vector; server FTS responds
  const searched = page.waitForResponse(
    (response) =>
      response.url().includes("/api/search") &&
      response.request().method() === "GET",
  );
  await page.getByPlaceholder("Search text...").fill("schedule");
  const searchResponse = await searched;
  expect(searchResponse.ok(), await searchResponse.text()).toBe(true);

  // sidebar enters search-filter mode: "Found on N page(s)" header + a "{n}pg"
  // results badge in the toolbar
  await expect(page.getByText(/Found on \d+ page/)).toBeVisible({
    timeout: 10_000,
  });

  // jump: click a result page button (page 3 is within the initial virtualized
  // window) and assert it becomes the active page (accent highlight class)
  const target = page.locator('[data-page-num="3"]');
  await target.click();
  await expect(target).toHaveClass(/bg-\[var\(--accent\)\]\/20/, {
    timeout: 10_000,
  });
});
