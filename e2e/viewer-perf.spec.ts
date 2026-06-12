// [refactor jun12 P0.4] Viewer performance baseline + golden open path.
//
// THE point of this file (owner mandate): the PDF viewer's performance is
// sacred and nobody fully remembers how it was achieved — so every phase that
// touches src/components/viewer or the hot stores re-runs this spec and
// compares against perf/baseline.json. Numbers are DEV-MODE and machine-local:
// only phase-over-phase deltas mean anything, never absolutes.
//
// Measures (100-page / ~62MB synthetic fixture over the Range+CORS cdn-stub):
//   coldOpenWarmMs — reload-to-first-rendered-canvas after a warmup visit
//                    (warmup absorbs turbopack route compilation)
//   nav20Ms        — wall time to scroll+click through 20 sidebar thumbnails,
//                    double-rAF settled per step (page-swap responsiveness).
//                    Pre-scroll per step is REQUIRED: the sidebar is
//                    virtualized (~20 buttons in DOM) and sidebar clicks
//                    suppress its auto-scroll (sidebarClickRef), so far
//                    targets never mount on their own. Protocol is part of
//                    the metric — keep it identical across phases.
//   zoom10Ms       — wall time for 10 wheel-zoom steps over the canvas
//   rafP95NavMs / rafP95ZoomMs — frame-gap p95 during those phases (jank)
import { expect, test } from "@playwright/test";
import { readFileSync, mkdirSync, writeFileSync, existsSync } from "node:fs";

const world = JSON.parse(readFileSync("e2e/.state/world.json", "utf8"));

async function settleFrames(page: import("@playwright/test").Page, n = 2) {
  await page.evaluate(
    (count) =>
      new Promise<void>((resolve) => {
        let left = count;
        const tick = () => (--left <= 0 ? resolve() : requestAnimationFrame(tick));
        requestAnimationFrame(tick);
      }),
    n,
  );
}

function startFrameSampler(page: import("@playwright/test").Page) {
  return page.evaluate(() => {
    const w = window as unknown as { __gaps: number[]; __stop: boolean };
    w.__gaps = [];
    w.__stop = false;
    let last = performance.now();
    const loop = (t: number) => {
      w.__gaps.push(t - last);
      last = t;
      if (!w.__stop) requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  });
}
async function stopFrameSampler(page: import("@playwright/test").Page): Promise<number[]> {
  return page.evaluate(() => {
    const w = window as unknown as { __gaps: number[]; __stop: boolean };
    w.__stop = true;
    return w.__gaps;
  });
}
const p95 = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? +s[Math.min(s.length - 1, Math.floor(s.length * 0.95))].toFixed(1) : 0;
};

// The sidebar's scroll container has no test id (P0 = no viewer edits), so
// walk up from any mounted thumbnail to the first scrollable ancestor.
function setSidebarScroll(page: import("@playwright/test").Page, top: number) {
  return page.evaluate((t) => {
    let el = document.querySelector("[data-page-num]")?.parentElement ?? null;
    while (el && el.scrollHeight <= el.clientHeight) el = el.parentElement;
    if (!el) throw new Error("sidebar scroll container not found");
    el.scrollTop = t;
    return { scrollHeight: el.scrollHeight, clientHeight: el.clientHeight };
  }, top);
}

test("viewer perf baseline on the synthetic 100-page set", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));

  // ── login (golden path: real credentials form) ──
  await page.goto("/login");
  await page.getByPlaceholder("Email").first().fill(world.email);
  await page.getByPlaceholder("Password").first().fill(world.password);
  await page.locator('button[type="submit"]').first().click();
  await page.waitForURL("**/home**", { timeout: 60_000 });

  // ── warmup visit: compiles the route, primes pdf.js worker chunk ──
  await page.goto(`/project/${world.publicId}`);
  await page.waitForSelector("canvas", { timeout: 120_000 });
  await settleFrames(page, 10);

  // ── cold-open (warm route): reload → first canvas ──
  const t0 = Date.now();
  await page.reload();
  await page.waitForSelector("canvas", { timeout: 60_000 });
  const coldOpenWarmMs = Date.now() - t0;
  await settleFrames(page, 10);

  // ── golden assertions: the sidebar VIRTUALIZES (PageSidebar ITEM_HEIGHT
  // window + buffer) — freeze that: page 1 mounted, page 100 NOT, only a
  // window's worth of buttons in the DOM…
  await expect(page.locator('[data-page-num="1"]')).toBeAttached({ timeout: 30_000 });
  await expect(page.locator('[data-page-num="100"]')).not.toBeAttached();
  expect(await page.locator("[data-page-num]").count()).toBeLessThan(30);
  // …while every page stays REACHABLE by scroll (page 100 mounts at bottom)
  const { scrollHeight } = await setSidebarScroll(page, Number.MAX_SAFE_INTEGER);
  await expect(page.locator('[data-page-num="100"]')).toBeAttached({ timeout: 10_000 });
  await setSidebarScroll(page, 0);
  await settleFrames(page, 2);
  // spacer height / numPages — runtime ITEM_HEIGHT, headers make it inexact
  // but the VIRTUAL_BUFFER absorbs the error
  const itemHeight = scrollHeight / world.pages;

  // ── page-nav: scroll+click through 20 thumbnails ──
  await startFrameSampler(page);
  const tNav = Date.now();
  for (let n = 2; n <= 21; n++) {
    await setSidebarScroll(page, (n - 1) * itemHeight);
    await settleFrames(page, 2); // scroll → rAF'd setScrollTop → window remount
    await page.locator(`[data-page-num="${n}"]`).click();
    await settleFrames(page, 2);
  }
  const nav20Ms = Date.now() - tNav;
  const navGaps = await stopFrameSampler(page);

  // ── wheel-zoom: 10 steps at canvas center ──
  const canvas = page.locator("canvas").first();
  const box = await canvas.boundingBox();
  if (box) await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await startFrameSampler(page);
  const tZoom = Date.now();
  for (let i = 0; i < 10; i++) {
    await page.mouse.wheel(0, -120);
    await settleFrames(page, 2);
  }
  const zoom10Ms = Date.now() - tZoom;
  const zoomGaps = await stopFrameSampler(page);

  // no uncaught page errors during the whole run (404'd PNG underlays are
  // fine and expected offline; exceptions are not)
  expect(pageErrors).toEqual([]);

  const result = {
    date: new Date().toISOString().slice(0, 10),
    mode: "dev-turbopack-offline-stub",
    fixture: { pages: 100, approxMB: 62.6, underlays: "absent (404) — pure pdf.js canvas path" },
    coldOpenWarmMs,
    nav20Ms,
    navProtocol: "per-step sidebar scroll + thumbnail click (virtualized list)",
    navPerPageMs: +(nav20Ms / 20).toFixed(1),
    zoom10Ms,
    rafP95NavMs: p95(navGaps),
    rafP95ZoomMs: p95(zoomGaps),
  };
  mkdirSync("perf", { recursive: true });
  writeFileSync("perf/latest.json", JSON.stringify(result, null, 2));
  if (!existsSync("perf/baseline.json")) {
    writeFileSync("perf/baseline.json", JSON.stringify(result, null, 2));
    console.log("[perf] baseline.json created", result);
  } else {
    console.log("[perf] latest run", result);
  }
});
