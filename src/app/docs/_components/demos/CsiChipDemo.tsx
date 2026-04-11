import { getDivColor, DIVISION_NAMES } from "../constants";

interface CsiChipProps {
  code: string;
  description?: string;
  confidence?: number;
}

/** A chip mirroring the CSI code rendering in CsiPanel and Detection Panel. */
export function CsiChip({ code, description, confidence }: CsiChipProps) {
  const division = code.slice(0, 2);
  const { color } = getDivColor(division);
  const desc = description ?? DIVISION_NAMES[division] ?? "";

  return (
    <span
      className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded border text-[11px] font-mono"
      style={{ borderColor: `${color}60`, color, backgroundColor: `${color}12` }}
    >
      <span className="font-semibold tabular-nums">{code}</span>
      {desc && <span className="text-[var(--fg)]/80 font-sans">{desc}</span>}
      {typeof confidence === "number" && (
        <span className="text-[var(--muted)] tabular-nums">{Math.round(confidence * 100)}%</span>
      )}
    </span>
  );
}

export function CsiChipDemo() {
  return (
    <div className="flex flex-wrap gap-2">
      <CsiChip code="22 00 00" description="Plumbing" confidence={0.95} />
      <CsiChip code="23 00 00" description="HVAC" confidence={0.88} />
      <CsiChip code="26 00 00" description="Electrical" confidence={0.92} />
      <CsiChip code="08 14 00" description="Wood Doors" confidence={0.78} />
      <CsiChip code="09 51 13" description="Acoustical Panel Ceilings" confidence={0.62} />
      <CsiChip code="03 30 00" description="Cast-in-Place Concrete" confidence={0.85} />
    </div>
  );
}
