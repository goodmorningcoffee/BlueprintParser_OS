/** Static-open rendition of the viewer's Menu dropdown (ViewerToolbar.tsx
 *  lines 276-332). Items: Data Labeling / Export PDF (disabled) / Settings /
 *  Page Intelligence / Admin / Help. */
export function MenuDropdownDemo() {
  return (
    <div className="inline-block relative">
      <div className="px-2 py-1 text-xs rounded border border-[var(--fg)]/50 text-[var(--fg)] bg-[var(--fg)]/5 inline-block">
        Menu
      </div>
      <div className="mt-1 bg-[var(--surface)] border border-[var(--border)] rounded shadow-lg min-w-[180px]">
        <button className="w-full text-left px-3 py-2 text-xs hover:bg-[var(--surface-hover)] text-[var(--fg)]">
          Data Labeling
        </button>
        <button
          disabled
          className="w-full text-left px-3 py-2 text-xs text-[var(--muted)]/50 cursor-not-allowed"
        >
          Export PDF (coming soon)
        </button>
        <button className="w-full text-left px-3 py-2 text-xs hover:bg-[var(--surface-hover)] text-[var(--fg)]">
          Settings
        </button>
        <button className="w-full text-left px-3 py-2 text-xs hover:bg-[var(--surface-hover)] text-[var(--fg)]">
          Page Intelligence
        </button>
        <div className="border-t border-[var(--border)]" />
        <a
          href="#"
          className="block w-full text-left px-3 py-2 text-xs hover:bg-[var(--surface-hover)] text-[var(--fg)]"
        >
          Admin
        </a>
        <button className="w-full text-left px-3 py-2 text-xs hover:bg-[var(--surface-hover)] text-[var(--fg)]">
          Help
        </button>
      </div>
    </div>
  );
}
