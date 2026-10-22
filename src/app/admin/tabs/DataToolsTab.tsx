"use client";

/**
 * Admin › Data tools — container for the data-maintenance sections, in order:
 * Stuck jobs · Duplicates · Annotation cleanup (root only) · Export. Each section lives in its own
 * file (DataToolsStuckJobs / DataToolsDuplicates / DataToolsAnnotationCleanup / DataToolsExport);
 * this one only stacks them.
 */

import DataToolsStuckJobs from "./DataToolsStuckJobs";
import DataToolsDuplicates from "./DataToolsDuplicates";
import DataToolsAnnotationCleanup from "./DataToolsAnnotationCleanup";
import DataToolsExport from "./DataToolsExport";

export default function DataToolsTab({ isRootAdmin }: { isRootAdmin: boolean }) {
  return (
    <div className="space-y-10">
      <DataToolsStuckJobs isRootAdmin={isRootAdmin} />
      <DataToolsDuplicates isRootAdmin={isRootAdmin} />
      <DataToolsAnnotationCleanup isRootAdmin={isRootAdmin} />
      <DataToolsExport isRootAdmin={isRootAdmin} />
    </div>
  );
}
