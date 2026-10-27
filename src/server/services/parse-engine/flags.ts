/**
 * Parse-engine flags (table pipeline PLAN §2.2 "flags", §1.1 row 13; WP-2.E).
 *
 * Stored in the existing `app_settings` table under `parseEngine` (no schema change), read the way
 * `tableParse.debugMode` is read: one row, never fatal. Shape of the stored document:
 *   { killSwitch?: boolean, tools?: { tablesRoute | keynoteRoute | notesClassifier | specClassifier |
 *     notesAuto | specAuto | workspace: "legacy" | "engine" }, cropCache?: boolean }
 *
 * The defaults live HERE, in code (`PARSE_ENGINE_FLAG_DEFAULTS`): every tool `legacy` except the
 * workspace (`engine`), crop cache on. A builder flips a default when the §6.4 promotion report
 * passes, and the owner's next release ships the flip. A stored value overrides a default field by
 * field; an unknown or malformed field falls back to its default (and is logged), so a hand-edited
 * row can never turn something on by accident. The kill switch wins over everything: every tool
 * `legacy`, the workspace off (`legacy`) and the crop cache off.
 *
 * TP-2 reads only. The validated root writer (`PUT /api/admin/parse-engine`) lands in WP-3.E; until
 * then nothing in the app writes this key.
 *
 *   GET /api/projects/[id]/parse-engine/flags → ParseEngineFlags (public for demo projects: the
 *   flags are global and hold no project data).
 */

import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { appSettings } from "@/lib/db/schema";
import { logger } from "@/lib/logger";
import {
  PARSE_ENGINE_TOOL_IDS,
  type ParseEngineFlags,
  type ParseEngineMode,
  type ParseEngineToolId,
} from "@/lib/parse-engine/types";

export const PARSE_ENGINE_SETTING_KEY = "parseEngine";

export const PARSE_ENGINE_FLAG_DEFAULTS: Readonly<ParseEngineFlags> = Object.freeze({
  killSwitch: false,
  tools: Object.freeze({
    tablesRoute: "legacy",
    keynoteRoute: "legacy",
    notesClassifier: "legacy",
    specClassifier: "legacy",
    notesAuto: "legacy",
    specAuto: "legacy",
    workspace: "engine",
  }) as Record<ParseEngineToolId, ParseEngineMode>,
  cropCache: true,
});

const isMode = (v: unknown): v is ParseEngineMode => v === "legacy" || v === "engine";
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/**
 * Pure: code defaults ⊕ the stored document, then the kill switch. `invalid` lists the stored fields
 * that were ignored (unknown keys, wrong types), for the log line and the TP-3 admin card.
 */
export function resolveParseEngineFlags(stored: unknown): { flags: ParseEngineFlags; invalid: string[] } {
  const d = PARSE_ENGINE_FLAG_DEFAULTS;
  const invalid: string[] = [];
  const doc = isObj(stored) ? stored : {};
  if (stored !== undefined && stored !== null && !isObj(stored)) invalid.push("(document)");
  for (const k of Object.keys(doc)) if (k !== "killSwitch" && k !== "tools" && k !== "cropCache") invalid.push(k);

  let killSwitch = d.killSwitch;
  if (doc.killSwitch !== undefined) {
    if (typeof doc.killSwitch === "boolean") killSwitch = doc.killSwitch;
    else invalid.push("killSwitch");
  }
  let cropCache = d.cropCache;
  if (doc.cropCache !== undefined) {
    if (typeof doc.cropCache === "boolean") cropCache = doc.cropCache;
    else invalid.push("cropCache");
  }
  const tools = { ...d.tools };
  if (doc.tools !== undefined) {
    if (!isObj(doc.tools)) invalid.push("tools");
    else {
      for (const [k, v] of Object.entries(doc.tools)) {
        if (!(PARSE_ENGINE_TOOL_IDS as readonly string[]).includes(k)) invalid.push(`tools.${k}`);
        else if (!isMode(v)) invalid.push(`tools.${k}`);
        else tools[k as ParseEngineToolId] = v;
      }
    }
  }
  if (killSwitch) {
    for (const id of PARSE_ENGINE_TOOL_IDS) tools[id] = "legacy";
    cropCache = false;
  }
  return { flags: { killSwitch, tools, cropCache }, invalid };
}

/** The invalid-field list last logged: a bad row is logged once, not on every (public) read (VERIFY LOW-5). */
let lastLoggedInvalid = "";

/** Run-path reader. Never throws: a missing row is the defaults, a failed read is the defaults (logged). */
export async function readParseEngineFlags(): Promise<ParseEngineFlags> {
  try {
    const [row] = await db
      .select({ value: appSettings.value })
      .from(appSettings)
      .where(eq(appSettings.key, PARSE_ENGINE_SETTING_KEY))
      .limit(1);
    const { flags, invalid } = resolveParseEngineFlags(row?.value);
    const key = invalid.join(",");
    if (key && key !== lastLoggedInvalid) logger.warn("[parse-engine] app_settings.parseEngine has fields that were ignored", { invalid });
    lastLoggedInvalid = key;
    return flags;
  } catch (err) {
    logger.error("[parse-engine] reading app_settings.parseEngine failed; using the code defaults", { error: err });
    return resolveParseEngineFlags(undefined).flags;
  }
}

/** The tool's effective mode (the kill switch is already folded in). */
export const parseEngineMode = (flags: ParseEngineFlags, tool: ParseEngineToolId): ParseEngineMode => flags.tools[tool];

/** GET /api/projects/[id]/parse-engine/flags — the effective flags, as a fixed public shape. */
export async function getParseEngineFlags(): Promise<ParseEngineFlags> {
  const flags = await readParseEngineFlags();
  return {
    killSwitch: flags.killSwitch,
    tools: {
      tablesRoute: flags.tools.tablesRoute,
      keynoteRoute: flags.tools.keynoteRoute,
      notesClassifier: flags.tools.notesClassifier,
      specClassifier: flags.tools.specClassifier,
      notesAuto: flags.tools.notesAuto,
      specAuto: flags.tools.specAuto,
      workspace: flags.tools.workspace,
    },
    cropCache: flags.cropCache,
  };
}
