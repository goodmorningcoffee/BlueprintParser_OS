// [TP-2 WP-2.E 2026-10-27] Loose additions to the stored Textract page (`pages.textract_data`).
//
// `lib/textract.ts` now keeps what AnalyzeDocument already returns and used to discard (K17), in a
// COMPACT form with no text:
//   - `layout`: the LAYOUT blocks the parse engine reads (list / text / section-header / title /
//     table), each `{ k, b }` with `b` a MinMax box rounded to 4 dp;
//   - `tables[].cells[].hdr`: true on a COLUMN_HEADER cell;
//   - `tables[].merged`: MERGED_CELL spans `{ r, c, rs, cs }` (1-based, as Textract numbers cells).
// The hand-written `TextractPageData` (types/index.ts, zero line headroom) stays authoritative and
// unchanged; these are optional siblings, so every existing reader keeps working. The viewer's
// textract GET drops `layout` (services/pages.ts getPageTextract). `.loose()` per this registry's
// idiom (primitives.ts).
import { z } from "zod";
import type { TextractCell, TextractPageData, TextractTable } from "@/types";
import { zBboxMinMax } from "./primitives";

export const TEXTRACT_LAYOUT_KINDS = ["list", "text", "section-header", "title", "table"] as const;
export type TextractLayoutKind = (typeof TEXTRACT_LAYOUT_KINDS)[number];

export const zTextractLayoutBlock = z.object({ k: z.enum(TEXTRACT_LAYOUT_KINDS), b: zBboxMinMax }).loose();
export type TextractLayoutBlock = { k: TextractLayoutKind; b: [number, number, number, number] };

export const zTextractMergedCell = z
  .object({ r: z.number().int().min(1), c: z.number().int().min(1), rs: z.number().int().min(1), cs: z.number().int().min(1) })
  .loose();
export type TextractMergedCell = { r: number; c: number; rs: number; cs: number };

export type TextractCellExt = TextractCell & { hdr?: true };
export type TextractTableExt = Omit<TextractTable, "cells"> & { cells: TextractCellExt[]; merged?: TextractMergedCell[] };
export type TextractPageDataExt = Omit<TextractPageData, "tables"> & { tables?: TextractTableExt[]; layout?: TextractLayoutBlock[] };
