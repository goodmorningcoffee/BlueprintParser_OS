/**
 * classifier-engine/spec-check.ts — field-level validation of the three pieces a recipe is assembled
 * from: a `SignalSpec`, a `ClassifierScope` and the `CandidateSource` list (types.ts). Every field the
 * engine reads (signals.ts, candidates.ts, evidence.ts) is checked for the exact shape it reads — a
 * `words` scope must be one of the eight bands, a term weight a finite number, a CSI division two digits,
 * a sheet-number pattern a compilable regex — because a spec that passes here is applied without a
 * try/catch per page, and a bad one used to throw on every page (zero proposals, silently) or make `p`
 * NaN (every candidate proposed). Pure, client-safe; recipes.ts and overlay-edit.ts build on it. Each
 * checker returns messages (empty = valid) so a validator can collect them, or throw the first.
 */

import { CHANNEL_KINDS } from "@/lib/pdf-channels/types";
import type { CandidateSource, SignalSpec } from "./types";

export const SPEC_TYPES = new Set<SignalSpec["type"]>(["words", "csi", "sheet", "yolo", "structure", "textract-table", "shapes", "zone", "channel"]);
export const CANDIDATE_TYPES = new Set<CandidateSource["type"]>(["regions-v2", "yolo", "textract-tables", "parsed-regions"]);

const SCOPES = new Set(["box", "header", "columns", "body", "above", "page", "titleBlock", "sheetTitle"]);
const CSI_WHERE = new Set(["box", "page"]);
const CSI_MEASURE = new Set(["share", "count"]);
const YOLO_WHERE = new Set(["inside", "overlap", "page", "near"]);
const YOLO_MEASURE = new Set(["presence", "count", "maxConfidence", "cover"]);
const SHAPES_WHERE = new Set(["inside", "leftColumn"]);
const ZONE = new Set(["titleBlock", "drawing", "margin"]);
const REGION_KINDS = new Set(["table", "legend", "notes", "keynotes"]);
const PAGE_KINDS = new Set<string>(CHANNEL_KINDS);
/** RegionV2Signals keys + structureScore (region-classifier-v2/types.ts). */
const STRUCTURE_FEATURES = new Set(["structureScore", "detConf", "areaCover", "textLines", "textRows", "textCols", "words", "textractTable", "tagShapes", "shapes", "legendColumn", "keyShapes", "scheduleWord", "csiCodes"]);

/** The fields each spec type may carry (anything else is a typo the engine would ignore). */
const SPEC_FIELDS: Record<SignalSpec["type"], readonly string[]> = {
  words: ["where", "terms", "saturation"],
  csi: ["where", "divisions", "sectionPrefixes", "measure", "minCodes"],
  sheet: ["disciplines", "numberPattern"],
  yolo: ["where", "classes", "model", "minConfidence", "measure"],
  structure: ["feature", "min", "max", "scale"],
  "textract-table": ["minContainment"],
  shapes: ["shapes", "where", "min"],
  zone: ["zone", "minContainment"],
  channel: ["pageKinds"],
};
const SCOPE_FIELDS = ["disciplines", "excludeDisciplines", "sheetNumberPattern", "pageKinds", "excludeTitleBlock", "minWords", "maxWords"];

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isStrList = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string" && x.trim().length > 0);
const regexOk = (s: string): boolean => { try { new RegExp(s, "i"); return true; } catch { return false; } };

/** Collects messages with a common prefix. */
class Errs {
  readonly out: string[] = [];
  constructor(private readonly at: string) {}
  add(msg: string): void { this.out.push(`${this.at} ${msg}`); }
  /** Optional finite number, optionally within [lo, hi]. */
  num(o: Record<string, unknown>, k: string, lo?: number, hi?: number): void {
    const v = o[k];
    if (v === undefined) return;
    if (!isNum(v) || (lo !== undefined && v < lo) || (hi !== undefined && v > hi)) this.add(`${k} must be a number${lo !== undefined || hi !== undefined ? ` in [${lo ?? "-∞"}, ${hi ?? "∞"}]` : ""}`);
  }
  /** Optional integer ≥ min. */
  int(o: Record<string, unknown>, k: string, min: number): void {
    const v = o[k];
    if (v !== undefined && !(isNum(v) && Number.isInteger(v) && v >= min)) this.add(`${k} must be a whole number ≥ ${min}`);
  }
  oneOf(o: Record<string, unknown>, k: string, set: Set<string>, required = true): void {
    const v = o[k];
    if (v === undefined) { if (required) this.add(`${k} is required`); return; }
    if (typeof v !== "string" || !set.has(v)) this.add(`${k} must be one of ${[...set].join(" | ")}`);
  }
  /** A list of non-empty strings; `required` also demands at least one entry; `each` restricts the values. */
  list(o: Record<string, unknown>, k: string, required: boolean, each?: (s: string) => boolean, what?: string): void {
    const v = o[k];
    if (v === undefined) { if (required) this.add(`${k} needs at least one entry`); return; }
    if (!isStrList(v)) { this.add(`${k} must be a list of strings`); return; }
    if (required && !v.length) this.add(`${k} needs at least one entry`);
    if (each) { const bad = v.filter((s) => !each(s)); if (bad.length) this.add(`${k} has invalid ${what ?? "entries"}: ${bad.slice(0, 3).join(", ")}`); }
  }
  str(o: Record<string, unknown>, k: string): void {
    if (o[k] !== undefined && (typeof o[k] !== "string" || !(o[k] as string).trim())) this.add(`${k} must be a non-empty string`);
  }
  unknownKeys(o: Record<string, unknown>, known: readonly string[]): void {
    for (const k of Object.keys(o)) if (!known.includes(k)) this.add(`has an unknown field "${k}"`);
  }
}

/** Messages for one signal spec (empty = valid). `at` prefixes each ("signal \"header\""). */
export function checkSpec(spec: unknown, at: string): string[] {
  const e = new Errs(at);
  if (!isRecord(spec) || typeof spec.type !== "string" || !SPEC_TYPES.has(spec.type as SignalSpec["type"])) { e.add("has an unknown spec type"); return e.out; }
  const type = spec.type as SignalSpec["type"];
  e.unknownKeys(spec, ["type", ...SPEC_FIELDS[type]]);
  switch (type) {
    case "words": {
      e.oneOf(spec, "where", SCOPES);
      if (!isRecord(spec.terms)) e.add("words spec needs terms");
      else {
        const entries = Object.entries(spec.terms);
        if (!entries.length) e.add("needs at least one term");
        const bad = entries.filter(([t, w]) => !t.trim() || !isNum(w));
        if (bad.length) e.add(`term weights must be numbers (${bad.slice(0, 3).map(([t]) => JSON.stringify(t)).join(", ")})`);
      }
      e.num(spec, "saturation", Number.MIN_VALUE);
      break;
    }
    case "csi":
      e.oneOf(spec, "where", CSI_WHERE);
      e.oneOf(spec, "measure", CSI_MEASURE);
      e.list(spec, "divisions", false, (d) => /^\d{2}$/.test(d), "divisions (two digits)");
      e.list(spec, "sectionPrefixes", false, (p) => /\d/.test(p), "section prefixes");
      if (!(Array.isArray(spec.divisions) && spec.divisions.length) && !(Array.isArray(spec.sectionPrefixes) && spec.sectionPrefixes.length)) e.add("needs divisions or sectionPrefixes");
      e.int(spec, "minCodes", 1);
      break;
    case "sheet":
      e.list(spec, "disciplines", false);
      if (spec.numberPattern !== undefined && (typeof spec.numberPattern !== "string" || !regexOk(spec.numberPattern))) e.add("numberPattern must be a valid regular expression");
      break;
    case "yolo":
      e.oneOf(spec, "where", YOLO_WHERE);
      e.oneOf(spec, "measure", YOLO_MEASURE);
      e.list(spec, "classes", true);
      e.str(spec, "model");
      e.num(spec, "minConfidence", 0, 1);
      break;
    case "structure":
      e.oneOf(spec, "feature", STRUCTURE_FEATURES);
      e.num(spec, "min");
      e.num(spec, "max");
      e.num(spec, "scale", Number.MIN_VALUE);
      break;
    case "textract-table":
      e.num(spec, "minContainment", 0, 1);
      break;
    case "shapes":
      e.list(spec, "shapes", true);
      e.oneOf(spec, "where", SHAPES_WHERE);
      e.num(spec, "min", 1);
      break;
    case "zone":
      e.oneOf(spec, "zone", ZONE);
      e.num(spec, "minContainment", 0, 1);
      break;
    case "channel":
      e.list(spec, "pageKinds", true, (k) => PAGE_KINDS.has(k), "page kinds");
      break;
  }
  return e.out;
}

/** Messages for a recipe scope (empty = valid). */
export function checkScope(scope: unknown, at: string): string[] {
  const e = new Errs(at);
  if (!isRecord(scope)) { e.add("scope must be an object"); return e.out; }
  e.unknownKeys(scope, SCOPE_FIELDS);
  e.list(scope, "disciplines", false);
  e.list(scope, "excludeDisciplines", false);
  e.list(scope, "pageKinds", false, (k) => PAGE_KINDS.has(k), "page kinds");
  if (scope.sheetNumberPattern !== undefined && (typeof scope.sheetNumberPattern !== "string" || !regexOk(scope.sheetNumberPattern))) e.add("sheetNumberPattern must be a valid regular expression");
  if (scope.excludeTitleBlock !== undefined && typeof scope.excludeTitleBlock !== "boolean") e.add("excludeTitleBlock must be true/false");
  e.int(scope, "minWords", 0);
  e.int(scope, "maxWords", 0);
  if (isNum(scope.minWords) && isNum(scope.maxWords) && scope.maxWords < scope.minWords) e.add("maxWords must be ≥ minWords");
  return e.out;
}

/** Messages for a candidate-source list (empty = valid). */
export function checkCandidates(c: unknown, at: string): string[] {
  const e = new Errs(at);
  if (!Array.isArray(c) || !c.length) { e.add("candidates must be a non-empty list"); return e.out; }
  c.forEach((src, i) => {
    const s = new Errs(`${at} candidates[${i}]`);
    if (!isRecord(src) || typeof src.type !== "string" || !CANDIDATE_TYPES.has(src.type as CandidateSource["type"])) { s.add("has an unknown type"); e.out.push(...s.out); return; }
    switch (src.type as CandidateSource["type"]) {
      case "regions-v2":
        s.unknownKeys(src, ["type", "kinds"]);
        s.list(src, "kinds", true, (k) => REGION_KINDS.has(k), "region kinds");
        break;
      case "yolo":
        s.unknownKeys(src, ["type", "model", "classes", "minConfidence"]);
        s.list(src, "classes", true);
        s.str(src, "model");
        s.num(src, "minConfidence", 0, 1);
        break;
      case "textract-tables":
        s.unknownKeys(src, ["type", "minRows"]);
        s.int(src, "minRows", 0);
        break;
      case "parsed-regions":
        s.unknownKeys(src, ["type"]);
        break;
    }
    e.out.push(...s.out);
  });
  return e.out;
}

