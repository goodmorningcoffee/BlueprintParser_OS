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

type Props = {
  id: string;
  annotationCount?: number;
  selectedAnnotationId?: number | null;
};

/**
 * Measurement-only exact-parent render and annotation-state probe. It is copied only into the two
 * detached benchmark worktrees. Primitive AnnotationOverlay props expose a hidden, test-readable
 * before/after witness without walking the dense collection or changing production state.
 */
export default function AnnotationOwnerPerfRenderProbe({
  id,
  annotationCount,
  selectedAnnotationId,
}: Props) {
  return (
    <Profiler id={id} onRender={reportRender}>
      <RenderSentinel />
      {annotationCount === undefined ? null : (
        <span
          hidden
          aria-hidden="true"
          data-annotation-owner-witness="true"
          data-annotation-count={annotationCount}
          data-selected-annotation-id={selectedAnnotationId ?? ""}
        />
      )}
    </Profiler>
  );
}
