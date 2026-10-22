"use client";

// [fix 2026-10-21 reprocess-persistence] Admin reprocess console "Debug" toggle. When on, every
// reprocess run started from any admin tab adds ?trace=1 and the server streams per-step
// diagnostics (Lambda config, each invocation's status/FunctionError/duration, result files
// expected vs found, fallback reasons, DB rows written per page) into the reprocess log.
export default function ReprocessDebugToggle({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <label className="flex items-center gap-2 mb-3 text-xs text-[var(--muted)] cursor-pointer select-none">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="rounded"
      />
      <span>
        Reprocess debug output — stream per-step diagnostics (Lambda invocations, fallbacks, rows written) into the
        reprocess log
      </span>
    </label>
  );
}
