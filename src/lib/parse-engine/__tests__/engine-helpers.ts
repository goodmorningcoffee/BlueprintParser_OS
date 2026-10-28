// [table pipeline WP-3.D] Test helpers: engine evidence from the committed synthetic fixtures, through the REAL
// loader (`buildPageEvidence`: words, visual lines, Textract tables), with the fixture's tag shapes. All text is
// pseudo-text (rule 12).
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { buildPageEvidence } from "@/server/services/parse-engine/evidence";
import { ltwhToMinMax } from "../geometry";
import type { BboxMinMax, EnginePageEvidence, ParseRequest, StructureKind } from "../types";

export const FIXTURE_DIR = join(process.cwd(), "src/lib/parse-engine/__fixtures__");
export const AT = "2026-10-28T00:00:00.000Z";

type Ltwh = [number, number, number, number];
export interface Fixture {
  id: string;
  kind: string;
  title: string;
  region: BboxMinMax;
  page: { words: { text: string; confidence?: number; bbox: Ltwh }[]; tables?: unknown[]; lines?: unknown[] };
  shapes: { bbox: BboxMinMax; label: string; source: "yolo" | "classical"; text?: string | null }[];
  truth: { type: "grid"; headers: string[]; rows: string[][] } | { type: "items"; items: { key: string; text: string }[] };
}

export function fixtureIds(): string[] {
  return readdirSync(FIXTURE_DIR).filter((f) => f.startsWith("syn-") && f.endsWith(".synthetic.json")).map((f) => f.replace(".synthetic.json", "")).sort();
}

export function fixture(id: string): Fixture {
  return JSON.parse(readFileSync(join(FIXTURE_DIR, `${id}.synthetic.json`), "utf8")) as Fixture;
}

/** The engine kind a fixture's `kind` field names. */
export function fixtureKind(f: Fixture): StructureKind {
  if (f.kind === "kv-legend") return "legend";
  return f.kind as StructureKind;
}

export function fixtureEvidence(f: Fixture, extra: Partial<EnginePageEvidence> = {}): EnginePageEvidence {
  const loaded = buildPageEvidence({
    pageNumber: 1, drawingNumber: null, keynotes: null, csiCodes: null,
    words: f.page.words, tables: f.page.tables ?? null, layout: null,
    pageZones: null, regionsV2: null, parsedRegions: null, channels: null, classifierProposals: null, yolo: [],
  }, { recompute: true });
  const { sources: _s, ...ev } = loaded;
  void _s;
  return {
    ...ev,
    shapes: f.shapes.map((s) => ({ b: s.bbox, cls: s.label, src: s.source, text: s.text ?? null, textSrc: s.text ? ("crop" as const) : null })),
    ...extra,
  };
}

export function fixtureRequest(f: Fixture, over: Partial<ParseRequest> = {}): ParseRequest {
  return { page: 1, bbox: f.region, budget: "instant", kind: fixtureKind(f), ...over };
}

export { ltwhToMinMax };
