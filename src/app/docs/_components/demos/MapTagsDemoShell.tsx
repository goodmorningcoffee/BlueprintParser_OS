"use client";

import { useState } from "react";
import MapTagsSection from "@/components/viewer/MapTagsSection";

/** Direct-mount of the real src/components/viewer/MapTagsSection.tsx.
 *  MapTagsSection takes plain props (no Zustand) — we wire up fake state
 *  locally so readers can see how tag-to-shape binding works. */
export function MapTagsDemoShell() {
  const [tagYoloClass, setTagYoloClass] = useState<{ model: string; className: string } | null>(null);
  const [mapped, setMapped] = useState(false);

  const grid = {
    headers: ["Tag", "Size", "Material", "Fire Rating", "Notes"],
    tagColumn: "Tag",
    rows: [
      { Tag: "D-01", Size: "3'-0\" x 7'-0\"", Material: "HM", "Fire Rating": "20 min", Notes: "Office entry" },
      { Tag: "D-02", Size: "3'-0\" x 7'-0\"", Material: "HM", "Fire Rating": "20 min", Notes: "" },
      { Tag: "D-03", Size: "6'-0\" x 7'-0\"", Material: "WD", "Fire Rating": "—", Notes: "Double leaf" },
      { Tag: "D-04", Size: "3'-0\" x 7'-0\"", Material: "HM", "Fire Rating": "90 min", Notes: "Stair" },
    ],
  };

  const yoloInTableRegion = [
    { model: "yolo_primitive", className: "circle", count: 18 },
    { model: "yolo_primitive", className: "hexagon", count: 4 },
  ];

  return (
    <div className="max-w-md">
      <MapTagsSection
        grid={grid}
        yoloInTableRegion={yoloInTableRegion}
        tagYoloClass={tagYoloClass}
        onTagYoloClassChange={(cls) => {
          setTagYoloClass(cls);
          setMapped(false);
        }}
        onMapTags={() => setMapped(true)}
        tagMappingDone={mapped}
        tagMappingCount={mapped ? 18 : 0}
        showUniqueCount
      />
      <div className="mt-2 text-[10px] text-[var(--muted)]/70 italic">
        (This is the real MapTagsSection.tsx from src/components/viewer — the callbacks just toggle local state.)
      </div>
    </div>
  );
}
