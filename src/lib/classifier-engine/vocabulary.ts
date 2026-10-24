/**
 * classifier-engine/vocabulary.ts — the schedule-kind vocabulary shared by the rulebook
 * (src/data/classifiers/), the proposals UI (rename menu, grouping) and the labelled set
 * (gitignore/projects/classifier_builder/labels/). Ids are stable: verdicts and fitted weights key on them.
 */

export interface ScheduleKind { id: string; name: string; group: ScheduleGroup }

export type ScheduleGroup = "arch" | "struct" | "fire" | "plumb" | "hvac" | "elec" | "site" | "other";

export const SCHEDULE_GROUP_NAMES: Record<ScheduleGroup, string> = {
  arch: "Architectural", struct: "Structural", fire: "Fire protection", plumb: "Plumbing",
  hvac: "HVAC", elec: "Electrical", site: "Civil / landscape", other: "Other",
};

const k = (group: ScheduleGroup, rows: Array<[string, string]>): ScheduleKind[] => rows.map(([id, name]) => ({ id, name, group }));

export const SCHEDULE_KINDS: readonly ScheduleKind[] = [
  ...k("arch", [
    ["door", "Door schedule"], ["door-hardware", "Door hardware schedule"], ["window", "Window / glazing schedule"],
    ["room-finish", "Room finish schedule"], ["finish-legend", "Finish / material legend"], ["room-area", "Room / area schedule"],
    ["partition-type", "Partition / wall type schedule"], ["toilet-accessory", "Toilet accessory schedule"],
    ["specialties", "Specialties schedule"], ["food-service-equipment", "Food service equipment schedule"],
    ["furniture-equipment", "Furniture / equipment schedule"], ["casework", "Casework / millwork schedule"],
    ["signage", "Signage schedule"], ["code-occupancy", "Code / occupancy table"], ["drawing-list", "Drawing list"],
  ]),
  ...k("struct", [
    ["footing-foundation", "Footing / foundation schedule"], ["column", "Column schedule"], ["beam-joist", "Beam / joist schedule"],
    ["lintel", "Lintel schedule"], ["shear-wall-holdown", "Shear wall / holdown schedule"],
    ["reinforcing-connection", "Reinforcing / connection schedule"], ["pile-pier", "Pile / pier schedule"],
  ]),
  ...k("fire", [["fire-protection", "Fire protection schedule"], ["fire-alarm", "Fire alarm schedule"]]),
  ...k("plumb", [["plumbing-fixture", "Plumbing fixture schedule"], ["plumbing-equipment", "Plumbing equipment schedule"]]),
  ...k("hvac", [
    ["hvac-air-handling", "Air handling equipment schedule"], ["hvac-fan", "Fan schedule"], ["hvac-terminal", "Terminal unit (VAV) schedule"],
    ["air-distribution", "Air distribution schedule"], ["hvac-hydronic", "Hydronic equipment schedule"],
    ["hvac-heater", "Heater schedule"], ["hvac-controls", "Controls / points schedule"],
  ]),
  ...k("elec", [
    ["panel", "Panel schedule"], ["lighting-fixture", "Lighting fixture schedule"], ["lighting-control", "Lighting control schedule"],
    ["equipment-connection", "Equipment connection schedule"], ["feeder", "Feeder schedule"],
    ["distribution-equipment", "Distribution equipment schedule"], ["low-voltage", "Low voltage / systems schedule"],
  ]),
  ...k("site", [
    ["plant", "Plant schedule"], ["civil-structure", "Civil structure / pipe schedule"], ["site-paving", "Site / paving schedule"],
    ["irrigation", "Irrigation schedule"],
  ]),
  ...k("other", [["revision", "Revision schedule"], ["other-schedule", "Other schedule"]]),
];

/** Label-only id: the candidate is not a schedule/table at all (used by verdicts and the labelled set). */
export const NOT_A_SCHEDULE = "not-a-schedule";
export const OTHER_SCHEDULE = "other-schedule";

const BY_ID = new Map(SCHEDULE_KINDS.map((x) => [x.id, x]));
export const scheduleKind = (id: string): ScheduleKind | undefined => BY_ID.get(id);
