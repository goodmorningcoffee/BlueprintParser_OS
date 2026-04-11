import { TWENTY_COLORS } from "../constants";

const SAMPLE_CLASSES = [
  { name: "door_single", count: 42, model: "yolo_medium" },
  { name: "door_double", count: 8, model: "yolo_medium" },
  { name: "window", count: 28, model: "yolo_medium" },
  { name: "circle", count: 156, model: "yolo_primitive" },
  { name: "hexagon", count: 24, model: "yolo_primitive" },
  { name: "tables", count: 14, model: "yolo_precise" },
  { name: "title_block", count: 52, model: "yolo_precise" },
  { name: "drawings", count: 68, model: "yolo_precise" },
];

function classColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = ((hash << 5) - hash + name.charCodeAt(i)) | 0;
  }
  return TWENTY_COLORS[Math.abs(hash) % TWENTY_COLORS.length];
}

/** Matches the YOLO class chip rendering in the Detection Panel. Stable
 *  hashing from TWENTY_COLORS — same algorithm as DetectionPanel.tsx:11-15. */
export function YoloClassChipDemo() {
  return (
    <div className="flex flex-wrap gap-2">
      {SAMPLE_CLASSES.map((c) => {
        const color = classColor(c.name);
        return (
          <span
            key={c.name}
            className="inline-flex items-center gap-2 px-2 py-1 rounded border text-[11px] font-mono"
            style={{ borderColor: `${color}80`, backgroundColor: `${color}18` }}
          >
            <span
              className="w-2 h-2 rounded-full"
              style={{ backgroundColor: color }}
              aria-hidden="true"
            />
            <span className="text-[var(--fg)] font-semibold">{c.name}</span>
            <span className="text-[var(--muted)]">{c.count}</span>
            <span className="text-[var(--muted)]/60">({c.model})</span>
          </span>
        );
      })}
    </div>
  );
}
