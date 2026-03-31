/**
 * page-utils.ts — Shared page grouping/classification utilities.
 *
 * Extracted from PageSidebar.tsx so AutoQtoTab and other components
 * can reuse discipline grouping logic.
 */

/** Extract discipline prefix from a drawing number like "A-101.00" → "A", "ES-201" → "ES" */
export function extractDisciplinePrefix(name: string): string {
  const match = name.match(/^([A-Za-z]+)[\s\-\.0-9]/);
  if (match) return match[1].toUpperCase();
  if (/^page\s/i.test(name)) return "OTHER";
  const letters = name.match(/^([A-Za-z]+)/);
  return letters ? letters[1].toUpperCase() : "OTHER";
}

/** Standard construction discipline sort order */
export function disciplineOrder(prefix: string): number {
  const order: Record<string, number> = {
    G: 0, A: 1, S: 2, M: 3, E: 4, P: 5, FP: 6, L: 7, C: 8, T: 9, D: 10,
  };
  return order[prefix] ?? 50;
}

/** Full discipline name from prefix */
export const DISCIPLINE_NAMES: Record<string, string> = {
  G: "General", A: "Architectural", S: "Structural", M: "Mechanical",
  E: "Electrical", P: "Plumbing", FP: "Fire Protection", L: "Landscape",
  C: "Civil", T: "Title/Cover", D: "Demolition", I: "Interior",
  ID: "Interior Design", SP: "Sprinkler", FA: "Fire Alarm",
};
