"use client";

import { Profiler, type ProfilerOnRenderCallback } from "react";

declare global {
  interface Window {
    __BP_PERF_V2_PROFILER__?: {
      record: (
        id: string,
        phase: string,
        actualDuration: number,
        baseDuration: number,
        startTime: number,
        commitTime: number,
        servedSha: string,
      ) => void;
    };
  }
}

const reportRender: ProfilerOnRenderCallback = (
  id,
  phase,
  actualDuration,
  baseDuration,
  startTime,
  commitTime,
) => {
  window.__BP_PERF_V2_PROFILER__?.record(
    id,
    phase,
    actualDuration,
    baseDuration,
    startTime,
    commitTime,
    process.env.NEXT_PUBLIC_BP_PERF_APP_SHA || "missing-source-sha",
  );
};

function RenderSentinel() {
  return null;
}

/**
 * Measurement-only exact-parent render probe.
 *
 * The overlay script inserts one instance as a child of each target component. An un-memoized
 * sentinel renders whenever that parent renders, and the surrounding React Profiler reports that
 * one render without counting descendant-only work. The public app never contains this file: the
 * same versioned overlay is applied only to detached pre/post benchmark worktrees.
 */
export default function PerfRenderProbe({ id }: { id: string }) {
  return (
    <Profiler id={id} onRender={reportRender}>
      <RenderSentinel />
    </Profiler>
  );
}
