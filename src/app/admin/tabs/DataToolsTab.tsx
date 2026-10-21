"use client";

/**
 * Admin › Data tools — container for the data-maintenance sections, in order:
 * Stuck jobs · Duplicates · Export. Each section lives in its own file
 * (DataToolsStuckJobs / DataToolsDuplicates / DataToolsExport); this one only stacks them.
 */

import DataToolsStuckJobs from "./DataToolsStuckJobs";
import DataToolsDuplicates from "./DataToolsDuplicates";

export default function DataToolsTab({ isRootAdmin }: { isRootAdmin: boolean }) {
  return (
    <div className="space-y-10">
      <DataToolsStuckJobs isRootAdmin={isRootAdmin} />
      <DataToolsDuplicates isRootAdmin={isRootAdmin} />
    </div>
  );
}
