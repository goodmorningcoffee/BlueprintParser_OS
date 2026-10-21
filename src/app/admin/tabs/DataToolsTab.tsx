"use client";

import DataToolsExport from "./DataToolsExport";

/**
 * Admin › Data tools. Each tool is its own section file (DataToolsStuckJobs, DataToolsDuplicates,
 * DataToolsExport); this container only stacks them.
 */
export default function DataToolsTab({ isRootAdmin }: { isRootAdmin: boolean }) {
  return (
    <div className="space-y-6">
      <DataToolsExport isRootAdmin={isRootAdmin} />
    </div>
  );
}
