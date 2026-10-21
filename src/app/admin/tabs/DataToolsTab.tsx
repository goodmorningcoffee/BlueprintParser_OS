"use client";

/**
 * Admin › Data tools — container for the admin data tools (stuck jobs, duplicate pages,
 * data export). Each section lives in its own file; this one renders the sections.
 */

import DataToolsDuplicates from "./DataToolsDuplicates";

export default function DataToolsTab({ isRootAdmin }: { isRootAdmin: boolean }) {
  return (
    <div className="space-y-8">
      <DataToolsDuplicates isRootAdmin={isRootAdmin} />
    </div>
  );
}
