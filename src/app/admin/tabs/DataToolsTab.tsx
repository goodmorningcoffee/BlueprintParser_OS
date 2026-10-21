"use client";

// Admin › Data tools — container for the data-maintenance sections. Each section lives in its own
// file (DataToolsStuckJobs / DataToolsDuplicates / DataToolsExport) so the tracks merge cleanly.

import DataToolsStuckJobs from "./DataToolsStuckJobs";

export default function DataToolsTab({ isRootAdmin }: { isRootAdmin: boolean }) {
  return (
    <div className="space-y-10">
      <DataToolsStuckJobs isRootAdmin={isRootAdmin} />
    </div>
  );
}
