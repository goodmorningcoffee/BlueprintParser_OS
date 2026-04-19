"use client";

/**
 * Shared visibility toggle eye — extracts the 👁 / 👁‍🗨 / — pattern
 * inlined in DetectionPanel model rows, ClassGroupHeader, TextPanel
 * category rows, AnnotationListItem, and yoloTag rows. Same unicode
 * symbols, same muted-opacity states, same stopPropagation behavior.
 *
 * Two variants:
 *   - "category" → 👁 visible, 👁‍🗨 hidden. Used at every aggregate level
 *     (section, sub-section, group). Supports the mixed ("partial")
 *     state — when some children are hidden and some visible.
 *   - "row" → 👁 visible, — (em-dash) hidden. Used on leaf rows.
 *     Usually hover-revealed to keep rows clean; set `showOnHover`.
 *
 * Click behavior is always `e.stopPropagation()` so parent-row click
 * handlers (navigate, expand) don't fire.
 */

export type VisibilityState = "all-visible" | "all-hidden" | "partial";

interface VisibilityEyeProps {
  state: VisibilityState;
  onClick: () => void;
  variant?: "category" | "row";
  title?: string;
  showOnHover?: boolean;
  size?: "sm" | "md";
}

export default function VisibilityEye({
  state,
  onClick,
  variant = "row",
  title,
  showOnHover = false,
  size = "md",
}: VisibilityEyeProps) {
  const isVisible = state !== "all-hidden";
  const isPartial = state === "partial";
  const defaultTitle = isVisible ? (isPartial ? "Some hidden — click to hide all" : "Hide") : "Show";
  const resolvedTitle = title ?? defaultTitle;

  // Opacity ladder: hidden = 40%, partial = 70%, visible = 100%.
  const opacityClass =
    state === "all-hidden" ? "opacity-40" : state === "partial" ? "opacity-70" : "";
  const colorClass = isVisible ? "text-[var(--fg)]" : "text-[var(--muted)]";
  const sizeClass = size === "sm" ? "text-[11px]" : "text-sm";
  const hoverClass = showOnHover ? "opacity-0 group-hover:opacity-100" : "";

  const glyph = (() => {
    if (variant === "row") {
      return state === "all-hidden" ? "\u2014" : "\u{1F441}";
    }
    // category variant
    return state === "all-hidden" ? "\u{1F441}\u200D\u{1F5E8}" : "\u{1F441}";
  })();

  return (
    <button
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className={`shrink-0 ${sizeClass} ${colorClass} ${opacityClass} ${hoverClass}`}
      title={resolvedTitle}
      aria-label={resolvedTitle}
    >
      {glyph}
    </button>
  );
}
