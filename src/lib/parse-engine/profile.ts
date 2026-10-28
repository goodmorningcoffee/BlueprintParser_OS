/**
 * Fusion weights (table pipeline WP-3.D; PLAN §1.4 R8, §5 WP-3.Q). Server-only (reads a file).
 *
 * R8 initial weights: rows `textract-cells 1.0 · rulings 1.0 · hanging-indent .6 · primitive-grid .6 · ocr-lines .5
 * · layout .4 · img2table .7 · tatr .8` (`types-rows.ts` `DEFAULT_ROW_WEIGHTS`, WP-3.A); columns `x-starts .7 ·
 * textract-cells 1.0 · rulings 1.0 · primitive-grid .6`. WP-3.Q refits them on the ODD gold sets and writes
 * `eval/parse-engine/profile.json` (a ledger of numbers only); when that file is present and valid it overrides the
 * defaults, else the defaults stand. A malformed file is ignored (logged once by the caller through `error`), never
 * half-applied. The resolved profile is cached per process.
 *
 * File shape: `{ "v": 1, "id": "<free text>", "rows": { "<method>": w, … }, "cols": { "<method>": w, … } }`.
 * Weights are finite numbers in [0, 4]; an unknown method id makes the file invalid.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { METHOD_IDS, type MethodId } from "./types";
import { DEFAULT_ROW_WEIGHTS } from "./types-rows";

export type MethodWeights = Readonly<Partial<Record<MethodId, number>>>;

export interface ParseEngineProfile {
  /** "default" for the R8 values, else the file's id. Part of the engine's `paramsHash`. */
  id: string;
  rows: MethodWeights;
  cols: MethodWeights;
}

/** R8 column weights (§1.4: x-starts .7 for columns). */
export const DEFAULT_COL_WEIGHTS: MethodWeights = Object.freeze({
  "textract-cells": 1.0,
  rulings: 1.0,
  "x-starts": 0.7,
  "primitive-grid": 0.6,
});

export const DEFAULT_PROFILE: ParseEngineProfile = Object.freeze({ id: "default", rows: DEFAULT_ROW_WEIGHTS, cols: DEFAULT_COL_WEIGHTS });

export const PROFILE_PATH = "eval/parse-engine/profile.json";
const MAX_WEIGHT = 4;

function weights(value: unknown): MethodWeights | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const out: Partial<Record<MethodId, number>> = {};
  for (const [k, w] of Object.entries(value as Record<string, unknown>)) {
    if (!(METHOD_IDS as readonly string[]).includes(k)) return null;
    if (typeof w !== "number" || !Number.isFinite(w) || w < 0 || w > MAX_WEIGHT) return null;
    out[k as MethodId] = w;
  }
  return out;
}

/** A profile from parsed JSON, or an error (the defaults then stand). Missing axes keep their defaults. */
export function parseProfile(json: unknown): { profile: ParseEngineProfile } | { error: string } {
  if (!json || typeof json !== "object" || Array.isArray(json)) return { error: "profile is not an object" };
  const j = json as Record<string, unknown>;
  if (j.v !== 1) return { error: "profile v must be 1" };
  const id = typeof j.id === "string" && j.id.trim() ? j.id.trim().slice(0, 80) : "profile";
  const rows = j.rows === undefined ? DEFAULT_ROW_WEIGHTS : weights(j.rows);
  const cols = j.cols === undefined ? DEFAULT_COL_WEIGHTS : weights(j.cols);
  if (!rows || !cols) return { error: "profile weights must be known method ids with weights in [0, 4]" };
  return { profile: { id, rows: { ...DEFAULT_ROW_WEIGHTS, ...rows }, cols: { ...DEFAULT_COL_WEIGHTS, ...cols } } };
}

let cached: { profile: ParseEngineProfile; error?: string } | null = null;

/** The process profile: `eval/parse-engine/profile.json` under `root` when present and valid, else the R8 defaults. */
export function loadParseEngineProfile(root: string = process.cwd(), read: (p: string) => string = (p) => readFileSync(p, "utf8")): { profile: ParseEngineProfile; error?: string } {
  let text: string;
  try {
    text = read(join(root, PROFILE_PATH));
  } catch {
    return { profile: DEFAULT_PROFILE };
  }
  try {
    const r = parseProfile(JSON.parse(text));
    return "profile" in r ? { profile: r.profile } : { profile: DEFAULT_PROFILE, error: r.error };
  } catch {
    return { profile: DEFAULT_PROFILE, error: "profile is not valid JSON" };
  }
}

/** Cached `loadParseEngineProfile()` (one read per process). */
export function parseEngineProfile(): ParseEngineProfile {
  if (!cached) cached = loadParseEngineProfile();
  return cached.profile;
}

/** Tests only: forget the cached profile. */
export function resetParseEngineProfileCache(): void {
  cached = null;
}
