"use client";

import { useState } from "react";
import MarkupDialog from "@/components/viewer/MarkupDialog";

/** Direct-mount of the real src/components/viewer/MarkupDialog.tsx.
 *  MarkupDialog is prop-driven (no Zustand), so we can own state locally
 *  and ignore the save callback for demo purposes. */
export function MarkupDialogDemo() {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("RFI #12 — missing header detail");
  const [note, setNote] = useState("Check with the architect; this detail references sheet A-501 but that sheet doesn't include a header profile.");
  const [savedAt, setSavedAt] = useState<string | null>(null);

  return (
    <div className="space-y-3">
      <button
        onClick={() => setOpen(true)}
        className="px-3 py-1.5 text-xs rounded border border-[var(--border)] text-[var(--fg)] hover:bg-[var(--surface-hover)]"
      >
        Open Markup Dialog
      </button>
      {savedAt && (
        <div className="text-[11px] text-emerald-400">
          ✓ Saved locally at {savedAt} — name: &quot;{name}&quot;
        </div>
      )}
      {open && (
        <MarkupDialog
          isEditing={false}
          name={name}
          note={note}
          onNameChange={setName}
          onNoteChange={setNote}
          onSave={() => {
            setSavedAt(new Date().toLocaleTimeString());
            setOpen(false);
          }}
          onCancel={() => setOpen(false)}
        />
      )}
    </div>
  );
}
