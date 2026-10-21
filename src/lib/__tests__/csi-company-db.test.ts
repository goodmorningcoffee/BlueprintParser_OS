/**
 * csi-company-db.test.ts — resolver unit tests (SPEC_FINAL §6.2-3, commit C3).
 *
 * [refactor jul9 P2-A C1] Covers getCompanyCsiContext + pickEngineConfig:
 * fallback-never-throws (I-4), per-company cache + inflight coalescing (I-3),
 * generation-guarded invalidation race (§1.8), tenant guard + traversal-key pin
 * (I-7/C3-F-5), size/row caps (I-9), threshold blowup guard (I-10), garbage
 * shapes, and delimiter-terminated key isolation (companies 1 vs 11, C3-F-9).
 *
 * @/lib/db + @/lib/s3 are mocked; the BUILTIN db loads for real off disk (fs is
 * NOT mocked) so `ctx.db === loadBuiltinCsiDatabase()` (a memoized singleton)
 * is a clean, exact "fell back to builtin" assertion.
 *
 * Hygiene (Critic-1 F6): cache/inflight/generation are module singletons in
 * query-cache.ts — beforeEach wipes the `csi-db:` keyspace so assertions are
 * not test-order-dependent.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks (declared before the module-under-test import) ─────────────────────
const h = vi.hoisted(() => {
  const companyRows = new Map<number, unknown>(); // companyId -> pipelineConfig
  const download = vi.fn<(key: string) => Promise<Buffer>>();
  const select = vi.fn();
  return { companyRows, download, select };
});

vi.mock("@/lib/db", () => ({
  db: {
    // per-where closure binds the resolved id so concurrent selects can't clobber a shared var
    select: () => {
      h.select();
      return {
        from: () => ({
          where: (cond: { val: number }) => ({
            limit: async () => {
              const pc = h.companyRows.get(cond.val);
              return pc === undefined ? [] : [{ pipelineConfig: pc }];
            },
          }),
        }),
      };
    },
  },
}));
vi.mock("@/lib/db/schema", () => ({ companies: { id: "id", pipelineConfig: "pipelineConfig" } }));
vi.mock("drizzle-orm", () => ({ eq: (col: unknown, val: number) => ({ col, val }) }));
vi.mock("@/lib/s3", () => ({ downloadFromS3: (key: string) => h.download(key) }));

import {
  getCompanyCsiContext,
  pickEngineConfig,
  csiDbCacheKey,
  CSI_DB_CACHE_TTL_MS,
} from "@/lib/csi-company-db";
import { invalidateCache } from "@/lib/admin-logs/query-cache";
import { CSI_V2_LOWEST_EMITTED_CONFIDENCE } from "@/lib/csi-v2-config";
import {
  loadBuiltinCsiDatabase,
  CSI_DB_MAX_BYTES,
  CSI_DB_MAX_ENTRIES,
} from "@/lib/csi-database";

// ── Fixtures ─────────────────────────────────────────────────────────────────
// Single custom entry whose code the builtin masterformat does NOT contain, so
// "resolved to custom" is unambiguous.
const CUSTOM_TSV = [
  "col0\tcol1\tcode\tdescription\ttrade\tdivision",
  "x\tx\t99 99 99\tzebra fixture widget\tFixture Trade\t99 00 00",
].join("\n");
const CUSTOM_KEY = (id: number) => `csi-databases/company-${id}/custom-csi.tsv`;

const buf = (s: string) => Buffer.from(s, "utf-8");
const flush = () => new Promise((r) => setTimeout(r, 0)); // drain all pending microtasks

beforeEach(() => {
  vi.clearAllMocks();
  h.companyRows.clear();
  invalidateCache("csi-db:"); // wipe the resolver keyspace (cache + inflight)
});

// ═════════════════════════════════════════════════════════════════════════════
describe("getCompanyCsiContext — no-op / fallback shapes", () => {
  it("no companyId → builtin, ZERO db + S3 calls", async () => {
    const ctx = await getCompanyCsiContext(undefined);
    expect(ctx.db).toBe(loadBuiltinCsiDatabase());
    expect(ctx.config).toBeUndefined();
    expect(h.select).not.toHaveBeenCalled();
    expect(h.download).not.toHaveBeenCalled();
  });

  it("no customDatabaseS3Key → builtin + parsed config, ZERO S3 ([csi-v2 S6] a pre-v2 stored threshold above 0.704 is read as tau)", async () => {
    h.companyRows.set(7, { csi: { matchingConfidenceThreshold: 0.8 } });
    const ctx = await getCompanyCsiContext(7);
    expect(ctx.db).toBe(loadBuiltinCsiDatabase());
    expect(ctx.config).toEqual({ tau: 0.8 });
    expect(h.download).not.toHaveBeenCalled();
  });

  it("preloadedPipelineConfig legacy scalar (5) → builtin + config undefined, NO db select, NO throw", async () => {
    const ctx = await getCompanyCsiContext(7, 5);
    expect(ctx.db).toBe(loadBuiltinCsiDatabase());
    expect(ctx.config).toBeUndefined();
    expect(h.select).not.toHaveBeenCalled();
    expect(h.download).not.toHaveBeenCalled();
  });

  it("csi stored as ARRAY → treated as {} → builtin + config undefined", async () => {
    h.companyRows.set(7, { csi: [1, 2, 3] });
    const ctx = await getCompanyCsiContext(7);
    expect(ctx.db).toBe(loadBuiltinCsiDatabase());
    expect(ctx.config).toBeUndefined();
    expect(h.download).not.toHaveBeenCalled();
  });

  it("customDatabaseS3Key non-string / empty string → builtin, NO S3", async () => {
    h.companyRows.set(7, { csi: { customDatabaseS3Key: 123 } });
    let ctx = await getCompanyCsiContext(7);
    expect(ctx.db).toBe(loadBuiltinCsiDatabase());
    h.companyRows.set(8, { csi: { customDatabaseS3Key: "" } });
    ctx = await getCompanyCsiContext(8);
    expect(ctx.db).toBe(loadBuiltinCsiDatabase());
    expect(h.download).not.toHaveBeenCalled();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe("getCompanyCsiContext — custom DB resolution + cache", () => {
  it("valid pointer → custom bundle (+ config); downloadFromS3 called EXACTLY ONCE across 3 concurrent + 5 sequential", async () => {
    h.companyRows.set(2, { csi: { customDatabaseS3Key: CUSTOM_KEY(2), tau: 0.8, maxCodesPerPage: 12 } });
    h.download.mockResolvedValue(buf(CUSTOM_TSV));

    // cold concurrent burst → inflight coalescing collapses to ONE fetch
    const [a, b, c] = await Promise.all([
      getCompanyCsiContext(2),
      getCompanyCsiContext(2),
      getCompanyCsiContext(2),
    ]);
    // warm sequential → cache hits, zero further fetches
    for (let i = 0; i < 5; i++) await getCompanyCsiContext(2);

    expect(h.download).toHaveBeenCalledTimes(1);
    for (const ctx of [a, b, c]) {
      expect(ctx.db).not.toBe(loadBuiltinCsiDatabase());
      expect(ctx.db.entries.some((e) => e.code === "99 99 99")).toBe(true);
      expect(ctx.config).toEqual({ tau: 0.8, maxCodesPerPage: 12 });
    }
  });

  it("invalidateCache(csiDbCacheKey(id)) → next resolve REFETCHES (2nd S3 call)", async () => {
    h.companyRows.set(2, { csi: { customDatabaseS3Key: CUSTOM_KEY(2) } });
    h.download.mockResolvedValue(buf(CUSTOM_TSV));
    await getCompanyCsiContext(2);
    expect(h.download).toHaveBeenCalledTimes(1);
    await getCompanyCsiContext(2); // cache hit
    expect(h.download).toHaveBeenCalledTimes(1);
    invalidateCache(csiDbCacheKey(2));
    await getCompanyCsiContext(2); // refetch
    expect(h.download).toHaveBeenCalledTimes(2);
  });

  it("generation-guard race: invalidate mid-flight → stale settle does NOT repopulate; next resolve triggers a FRESH GET (§1.8)", async () => {
    h.companyRows.set(2, { csi: { customDatabaseS3Key: CUSTOM_KEY(2) } });
    let resolveStale!: (b: Buffer) => void;
    h.download.mockImplementationOnce(() => new Promise<Buffer>((res) => { resolveStale = res; }));

    const inflight = getCompanyCsiContext(2); // starts the fetch, parks on the hanging download
    await flush();
    expect(h.download).toHaveBeenCalledTimes(1); // inflight entry now set

    invalidateCache(csiDbCacheKey(2)); // bump generation + drop inflight
    resolveStale(buf(CUSTOM_TSV));     // OLD fetch settles → its cache.set must be skipped
    await inflight;

    h.download.mockResolvedValueOnce(buf(CUSTOM_TSV));
    await getCompanyCsiContext(2); // cache is empty (stale settle guarded out) → fresh GET
    expect(h.download).toHaveBeenCalledTimes(2);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe("getCompanyCsiContext — failure fallback (I-4) + failure-cached-for-TTL", () => {
  it("S3 rejects → builtin, no throw; second call makes ZERO additional S3 calls (C3-F-4)", async () => {
    h.companyRows.set(2, { csi: { customDatabaseS3Key: CUSTOM_KEY(2) } });
    h.download.mockRejectedValue(new Error("NoSuchKey"));
    const ctx = await getCompanyCsiContext(2);
    expect(ctx.db).toBe(loadBuiltinCsiDatabase());
    expect(h.download).toHaveBeenCalledTimes(1);
    const ctx2 = await getCompanyCsiContext(2); // failure cached for the TTL
    expect(ctx2.db).toBe(loadBuiltinCsiDatabase());
    expect(h.download).toHaveBeenCalledTimes(1);
  });

  it("empty TSV (header only, 0 rows) → builtin", async () => {
    h.companyRows.set(2, { csi: { customDatabaseS3Key: CUSTOM_KEY(2) } });
    h.download.mockResolvedValue(buf("col0\tcol1\tcode\tdescription\ttrade\tdivision"));
    const ctx = await getCompanyCsiContext(2);
    expect(ctx.db).toBe(loadBuiltinCsiDatabase());
  });

  it("downloaded buffer > CSI_DB_MAX_BYTES → builtin (I-9 resolver guard, covers pre-existing oversized objects)", async () => {
    h.companyRows.set(2, { csi: { customDatabaseS3Key: CUSTOM_KEY(2) } });
    h.download.mockResolvedValue(Buffer.alloc(CSI_DB_MAX_BYTES + 1));
    const ctx = await getCompanyCsiContext(2);
    expect(ctx.db).toBe(loadBuiltinCsiDatabase());
  });

  it("parsed entries > CSI_DB_MAX_ENTRIES → builtin (I-9)", async () => {
    h.companyRows.set(2, { csi: { customDatabaseS3Key: CUSTOM_KEY(2) } });
    const header = "col0\tcol1\tcode\tdescription\ttrade\tdivision";
    const row = "x\tx\t01\tw\tt\t01";
    const big = header + "\n" + Array(CSI_DB_MAX_ENTRIES + 1).fill(row).join("\n");
    expect(Buffer.byteLength(big)).toBeLessThan(CSI_DB_MAX_BYTES); // passes byte gate, fails row gate
    h.download.mockResolvedValue(buf(big));
    const ctx = await getCompanyCsiContext(2);
    expect(ctx.db).toBe(loadBuiltinCsiDatabase());
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe("getCompanyCsiContext — tenant guard (I-7)", () => {
  it("foreign-prefix key → builtin + NO S3 call", async () => {
    h.companyRows.set(1, { csi: { customDatabaseS3Key: CUSTOM_KEY(2) } }); // company 1 pointing at company 2
    const ctx = await getCompanyCsiContext(1);
    expect(ctx.db).toBe(loadBuiltinCsiDatabase());
    expect(h.download).not.toHaveBeenCalled();
  });

  it("traversal-shaped key passes the startsWith guard but S3 rejects (literal keys) → builtin (C3-F-5: do NOT normalize)", async () => {
    h.companyRows.set(1, { csi: { customDatabaseS3Key: "csi-databases/company-1/../company-2/x.tsv" } });
    h.download.mockRejectedValue(new Error("NoSuchKey")); // literal key 404s
    const ctx = await getCompanyCsiContext(1);
    expect(ctx.db).toBe(loadBuiltinCsiDatabase());
    expect(h.download).toHaveBeenCalledTimes(1); // guard let it through; S3 literal-key 404 caught it
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe("getCompanyCsiContext — key isolation (companies 1 vs 11, C3-F-9)", () => {
  it("distinct bundles, no cross-bleed; invalidating company 1 does NOT evict company 11", async () => {
    const TSV1 = [
      "c0\tc1\tcode\tdescription\ttrade\tdivision",
      "x\tx\t11 11 11\talpha one entry\tT\t11 00 00",
    ].join("\n");
    const TSV11 = [
      "c0\tc1\tcode\tdescription\ttrade\tdivision",
      "x\tx\t22 22 22\tbeta eleven entry\tT\t22 00 00",
    ].join("\n");
    h.companyRows.set(1, { csi: { customDatabaseS3Key: CUSTOM_KEY(1) } });
    h.companyRows.set(11, { csi: { customDatabaseS3Key: CUSTOM_KEY(11) } });
    h.download.mockImplementation((key: string) =>
      Promise.resolve(buf(key === CUSTOM_KEY(1) ? TSV1 : TSV11)));

    const c1 = await getCompanyCsiContext(1);
    const c11 = await getCompanyCsiContext(11);
    expect(c1.db.entries.some((e) => e.code === "11 11 11")).toBe(true);
    expect(c1.db.entries.some((e) => e.code === "22 22 22")).toBe(false); // no bleed
    expect(c11.db.entries.some((e) => e.code === "22 22 22")).toBe(true);
    expect(h.download).toHaveBeenCalledTimes(2);

    invalidateCache(csiDbCacheKey(1)); // must NOT touch csi-db:11:v2 (delimiter-terminated)
    await getCompanyCsiContext(11); // still cached → no new fetch
    expect(h.download).toHaveBeenCalledTimes(2);
    await getCompanyCsiContext(1); // evicted → refetch
    expect(h.download).toHaveBeenCalledTimes(3);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe("pickEngineConfig — [csi-v2 S6] v2 subset {tau, maxCodesPerPage} + I-10 guard", () => {
  it("garbage scalars → undefined", () => {
    expect(pickEngineConfig(5)).toBeUndefined();
    expect(pickEngineConfig(null)).toBeUndefined();
    expect(pickEngineConfig(undefined)).toBeUndefined();
    expect(pickEngineConfig([1, 2])).toBeUndefined();
  });

  it("only valid-typed v2 fields survive; pre-v2 tier keys and unknown keys are ignored", () => {
    expect(pickEngineConfig({ tau: 0.8, maxCodesPerPage: 25, bogus: 9 })).toEqual({ tau: 0.8, maxCodesPerPage: 25 });
    expect(pickEngineConfig({ tau: "x", maxCodesPerPage: 25 })).toEqual({ maxCodesPerPage: 25 });
    expect(pickEngineConfig({ tier2MinWords: 3, tier3Weight: 0.2, tier1WeightByWordCount: [0, 0.5, 1] })).toBeUndefined();
  });

  it("a pre-v2 matchingConfidenceThreshold is read as tau only above 0.704; a stored tau wins over it", () => {
    expect(pickEngineConfig({ matchingConfidenceThreshold: 0.8 })).toEqual({ tau: 0.8 });
    expect(pickEngineConfig({ matchingConfidenceThreshold: 0.8, tau: 0.85 })).toEqual({ tau: 0.85 });
    expect(pickEngineConfig({ matchingConfidenceThreshold: 0.5, tau: 0.85 })).toEqual({ tau: 0.85 });
    // the pre-v2 admin's default 0.4 (saved with every pre-v2 save) and anything ≤ 0.704 is ignored:
    // on the old scale it cannot mean "list more than v2's default" (review fix round 1)
    for (const low of [0.4, 0.5, 0.7, CSI_V2_LOWEST_EMITTED_CONFIDENCE]) {
      expect(pickEngineConfig({ matchingConfidenceThreshold: low })).toBeUndefined();
      expect(pickEngineConfig({ matchingConfidenceThreshold: low, maxCodesPerPage: 9 })).toEqual({ maxCodesPerPage: 9 });
    }
    expect(pickEngineConfig({ matchingConfidenceThreshold: 0.705 })).toEqual({ tau: 0.705 });
  });

  it("I-10: a tau (or legacy threshold) <= 0, > 1, NaN or Infinity is DROPPED", () => {
    for (const bad of [0, -0.5, 1.5, NaN, Infinity]) {
      expect(pickEngineConfig({ tau: bad })).toBeUndefined();
      expect(pickEngineConfig({ matchingConfidenceThreshold: bad })).toBeUndefined();
    }
    // a valid sibling still survives while the bad threshold is dropped
    expect(pickEngineConfig({ tau: 0, maxCodesPerPage: 10 })).toEqual({ maxCodesPerPage: 10 });
  });

  it("maxCodesPerPage must be an integer in [1, 200]", () => {
    for (const bad of [0, -3, 201, 2.5, "40"]) expect(pickEngineConfig({ maxCodesPerPage: bad })).toBeUndefined();
    expect(pickEngineConfig({ maxCodesPerPage: 1 })).toEqual({ maxCodesPerPage: 1 });
    expect(pickEngineConfig({ maxCodesPerPage: 200 })).toEqual({ maxCodesPerPage: 200 });
  });

  it("the cache key is delimiter-terminated and versioned :v2", () => {
    expect(csiDbCacheKey(7)).toBe("csi-db:7:v2");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe("parseCsiTsv characterization (via resolver's parser) — malformed inputs", () => {
  // Reuse the parser through the resolver: mixed good/bad rows → only good rows.
  it("mixed good/<6-col rows → only the well-formed row survives", async () => {
    h.companyRows.set(2, { csi: { customDatabaseS3Key: CUSTOM_KEY(2) } });
    const content = [
      "c0\tc1\tcode\tdescription\ttrade\tdivision",
      "x\tx\t77 77 77\tgood mixed row\tT\t77 00 00",
      "onlytwo\tcols", // < 6 cols → dropped
    ].join("\n");
    h.download.mockResolvedValue(buf(content));
    const ctx = await getCompanyCsiContext(2);
    expect(ctx.db.entries).toHaveLength(1);
    expect(ctx.db.entries[0].code).toBe("77 77 77");
  });

  it("CRLF file → no crash; parses cleanly (the C1 parser trims every field, so \\r does NOT survive — see deviation note)", async () => {
    // SPEC_FINAL §6.2-3 anticipated a "\\r-suffixed division" quirk from the
    // pre-C1 parser; the extracted parseCsiTsv (.trim() on all fields, C1)
    // neutralizes it. Pin the ACTUAL behavior: division is clean "88".
    h.companyRows.set(2, { csi: { customDatabaseS3Key: CUSTOM_KEY(2) } });
    const crlf = "c0\tc1\tcode\tdescription\ttrade\tdivision\r\nx\tx\t88 88 88\tcrlf row\tT\t88\r\n";
    h.download.mockResolvedValue(buf(crlf));
    const ctx = await getCompanyCsiContext(2);
    expect(ctx.db.entries).toHaveLength(1);
    expect(ctx.db.entries[0].division).toBe("88"); // trimmed, no trailing \r
  });
});

// keep the TTL constant referenced so an accidental removal is a compile error
it("exports a 15-minute TTL", () => {
  expect(CSI_DB_CACHE_TTL_MS).toBe(15 * 60_000);
});
