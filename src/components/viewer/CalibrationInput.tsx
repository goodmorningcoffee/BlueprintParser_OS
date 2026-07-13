"use client";

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  publishSettledCalibrationReset,
  useToolStore,
} from "@/stores/toolStore";
import { useViewerCoreStore } from "@/stores/viewerCoreStore";
import { useSessionStore } from "@/stores/sessionStore";
import { useAnnotations } from "@/queries/useAnnotations";
import { queryKeys } from "@/queries/queryKeys";
import type { AreaUnit, ClientAnnotation, ScaleCalibrationData } from "@/types";
// [refactor jun17 P1.3] /api/annotations now serves the {error:{code,message}} envelope;
// apiErrorMessage reads both that and the legacy {error:string} from un-migrated routes.
import { apiErrorMessage } from "@/lib/client-persist";
import {
  claimToolTailAuthority,
  consumeToolTailAuthority,
  ownsToolTailAuthority,
} from "@/lib/parse-tool-authority";

const AREA_UNITS: AreaUnit[] = ["ft", "in", "m", "cm"];

/** Scale calibration distance input — used by AreaTab, reusable by future tools. */
export default function CalibrationInput() {
  const queryClient = useQueryClient();
  const calibrationPoints = useToolStore((s) => s.calibrationPoints);
  const setScaleCalibration = useToolStore((s) => s.setScaleCalibration);
  const resetCalibration = useToolStore((s) => s.resetCalibration);
  // [refactor jul10 P2.2⑥] Both demo and persisted calibration branches retain their original
  // render-captured value replacement, including the post-await concurrent-write hazard.
  const { annotations } = useAnnotations();

  const [distance, setDistance] = useState("");
  const [unit, setUnit] = useState<AreaUnit>("ft");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleOk() {
    const dist = parseFloat(distance);
    const tool = useToolStore.getState();
    const activation = tool.activeTool;
    const points = tool.calibrationPoints;
    if (
      !dist || dist <= 0 || !points.p1 || !points.p2 ||
      activation?.kind !== "calibration"
    ) return;
    const session = useSessionStore.getState();
    const capturedPublicId = session.publicId;
    const capturedPageNumber = useViewerCoreStore.getState().pageNumber;
    const capturedAnnotationsKey = queryKeys.annotations.all(capturedPublicId);
    const token = claimToolTailAuthority({});

    setSaving(true);
    setError(null);
    const p1 = points.p1;
    const p2 = points.p2;
    const cal: ScaleCalibrationData = {
      type: "scale-calibration",
      point1: p1,
      point2: p2,
      realDistance: dist,
      unit,
    };

    // Derive bbox from the two calibration points (API rejects [0,0,0,0])
    const EPS = 0.001;
    const bMinX = Math.min(p1.x, p2.x);
    const bMaxX = Math.max(p1.x, p2.x);
    const bMinY = Math.min(p1.y, p2.y);
    const bMaxY = Math.max(p1.y, p2.y);
    const calBbox: [number, number, number, number] = [
      bMinX,
      bMinY,
      bMaxX - bMinX < EPS ? bMinX + EPS : bMaxX,
      bMaxY - bMinY < EPS ? bMinY + EPS : bMaxY,
    ];

    if (session.isDemo) {
      if (useSessionStore.getState().publicId === capturedPublicId) {
        setScaleCalibration(capturedPageNumber, cal);
      }
      const tempAnn: ClientAnnotation = {
        id: -Date.now(),
        pageNumber: capturedPageNumber,
        name: `Scale (pg ${capturedPageNumber})`,
        bbox: [0, 0, 0, 0],
        note: null,
        source: "takeoff-scale",
        data: cal as unknown as Record<string, unknown>,
      };
      queryClient.setQueryData(capturedAnnotationsKey, [
        ...annotations.filter(
          (a) => !(a.source === "takeoff-scale" && a.pageNumber === capturedPageNumber)
        ),
        tempAnn,
      ]);
      if (
        ownsToolTailAuthority(token) &&
        useSessionStore.getState().publicId === capturedPublicId &&
        useViewerCoreStore.getState().pageNumber === capturedPageNumber &&
        useToolStore.getState().activeTool === activation
      ) {
        consumeToolTailAuthority(token, () => publishSettledCalibrationReset(activation));
      }
      setDistance("");
      setSaving(false);
      return;
    }

    try {
      const existingScaleAnns = annotations.filter(
        (a) => a.source === "takeoff-scale" && a.pageNumber === capturedPageNumber
      );
      for (const ann of existingScaleAnns) {
        await fetch(`/api/annotations/${ann.id}`, { method: "DELETE" });
      }
      const res = await fetch("/api/annotations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId: capturedPublicId,
          pageNumber: capturedPageNumber,
          name: `Scale (pg ${capturedPageNumber})`,
          bbox: calBbox,
          note: null,
          source: "takeoff-scale",
          data: cal,
        }),
      });
      if (res.ok) {
        const saved = await res.json();
        queryClient.setQueryData(capturedAnnotationsKey, [
          ...annotations.filter(
            (a) => !(a.source === "takeoff-scale" && a.pageNumber === capturedPageNumber)
          ),
          saved,
        ]);
        if (useSessionStore.getState().publicId === capturedPublicId) {
          setScaleCalibration(capturedPageNumber, cal);
        }
        if (
          ownsToolTailAuthority(token) &&
          useSessionStore.getState().publicId === capturedPublicId &&
          useViewerCoreStore.getState().pageNumber === capturedPageNumber &&
          useToolStore.getState().activeTool === activation
        ) {
          consumeToolTailAuthority(token, () => publishSettledCalibrationReset(activation));
        }
        setDistance("");
      } else {
        const errData = await res.json().catch(() => null);
        setError(apiErrorMessage(errData) || `Failed (${res.status})`);
      }
    } catch (err) {
      setError("Network error — could not save calibration");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex items-center gap-1.5 mt-1.5">
      <input
        autoFocus
        type="number"
        min="0"
        step="any"
        value={distance}
        onChange={(e) => setDistance(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") handleOk();
          if (e.key === "Escape") resetCalibration();
        }}
        placeholder="Distance..."
        className="w-20 px-1.5 py-0.5 text-xs bg-[var(--bg)] border border-[var(--border)] rounded focus:outline-none focus:border-[var(--accent)]"
      />
      <select
        value={unit}
        onChange={(e) => setUnit(e.target.value as AreaUnit)}
        className="px-1 py-0.5 text-xs bg-[var(--bg)] border border-[var(--border)] rounded focus:outline-none"
      >
        {AREA_UNITS.map((u) => (
          <option key={u} value={u}>{u}</option>
        ))}
      </select>
      <button
        onClick={handleOk}
        disabled={!distance || parseFloat(distance) <= 0 || saving || !calibrationPoints.p1 || !calibrationPoints.p2}
        className="text-xs px-2 py-0.5 rounded bg-emerald-600 text-white disabled:opacity-40 hover:bg-emerald-500"
      >
        {saving ? "..." : "OK"}
      </button>
      <button
        onClick={resetCalibration}
        className="text-xs px-1.5 py-0.5 text-[var(--muted)] hover:text-[var(--fg)]"
      >
        Cancel
      </button>
      {error && <span className="text-[10px] text-red-400 ml-1">{error}</span>}
    </div>
  );
}
