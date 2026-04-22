/**
 * note-keyword-tiers.ts
 *
 * Hierarchical keyword dictionary for note/spec/legend pattern classification.
 *
 * - Tier 1 (broad class): the pattern family a region belongs to.
 * - Tier 2 (subtype):     a finer label within the family (e.g. RCP vs DEMO notes).
 * - Tier 3 (trade):       CSI-aligned trade keywords that add domain context.
 *
 * Tiers are independent labels that ride on top of the region's structural
 * `type` — they do not change classification, only add semantic context
 * surfaced as `TextRegion.classifiedLabels`.
 *
 * Matching is case-insensitive, substring-based, first-hit-wins within a tier.
 * Longer patterns are tried first so "GENERAL NOTES" beats "NOTES".
 */

// ─── Tier 1: pattern families ──────────────────────────────
export const TIER1_KEYWORDS = [
  "SPECIFICATIONS",
  "SPECIFICATION",
  "SCHEDULE",
  "LEGEND",
  "ABBREVIATIONS",
  "NOTES",
  "NOTE",
] as const;

// ─── Tier 2: subtypes within a family ──────────────────────
export const TIER2_KEYWORDS = [
  // Note subtypes
  "REFLECTED CEILING",
  "GENERAL NOTES",
  "GENERAL NOTE",
  "DEMOLITION",
  "DEMO NOTE",
  "KEY NOTE",
  "KEYNOTE",
  "SHEET NOTE",
  "DRAWING NOTE",
  "RCP",
  "GENERAL",
  "DEMO",
  "KEY",

  // Spec section markers
  "PART 1",
  "PART 2",
  "PART 3",
  "GENERAL",

  // Schedule subtypes
  "DOOR SCHEDULE",
  "FINISH SCHEDULE",
  "WINDOW SCHEDULE",
  "EQUIPMENT SCHEDULE",
  "ROOM FINISH",
  "MATERIAL SCHEDULE",

  // Legend subtypes
  "SYMBOL LEGEND",
  "EQUIPMENT TAG",
  "HVAC",
  "PLUMBING",
  "ELECTRICAL",
] as const;

// ─── Tier 3: CSI-aligned trade keywords ────────────────────
export const TIER3_KEYWORDS = [
  // Division 03 Concrete / 04 Masonry / 05 Metals / 06 Wood
  "CONCRETE", "REBAR", "MASONRY", "STEEL", "METAL", "WOOD", "LUMBER",
  // Division 07 Thermal/Moisture / 08 Openings / 09 Finishes
  "ROOFING", "INSULATION", "DOOR", "WINDOW", "GLAZING",
  "GYPSUM", "DRYWALL", "PAINT", "CEILING", "FLOORING", "TILE",
  // Division 10-14 Specialties
  "SIGNAGE", "PARTITION", "FURNISHING", "ELEVATOR",
  // Division 21 Fire / 22 Plumbing / 23 HVAC / 26 Electrical / 27 Comms
  "FIRE PROTECTION", "SPRINKLER", "PLUMBING", "HVAC",
  "MECHANICAL", "ELECTRICAL", "LIGHTING", "COMMUNICATION",
  // Division 31-33 Sitework
  "EARTHWORK", "PAVING", "LANDSCAPE", "UTILITIES",
] as const;

export interface TierMatch {
  tier1?: string;
  tier2?: string;
  trade?: string;
}

/**
 * Match hierarchical tier keywords against arbitrary text.
 * Case-insensitive, substring-match, first-hit-wins per tier.
 * Longer patterns are tried before shorter ones to prefer specific over generic.
 */
export function matchTiers(text: string): TierMatch {
  const upper = text.toUpperCase();
  return {
    tier1: findFirstMatch(upper, TIER1_KEYWORDS),
    tier2: findFirstMatch(upper, TIER2_KEYWORDS),
    trade: findFirstMatch(upper, TIER3_KEYWORDS),
  };
}

function findFirstMatch(
  upperText: string,
  candidates: readonly string[],
): string | undefined {
  // Sort by descending length so "GENERAL NOTES" wins over "NOTES"
  const ordered = [...candidates].sort((a, b) => b.length - a.length);
  for (const kw of ordered) {
    if (upperText.includes(kw)) return kw;
  }
  return undefined;
}
