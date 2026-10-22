"use client";

// [2026-10-22] Module-scope store for GET /api/admin/yolo-instance/options (root only): the current
// YOLO instance + timeout, the live-annotated allowlist and past-run timing. The Inference-instance
// picker loads and patches it; the bulk bar and each per-project Run read it for the cost estimate.
// Module scope (not component state) so the picker and the estimates agree without prop threading,
// and a save in the picker updates every estimate at once. Non-root admins never load it, so their
// estimates simply do not render.

import { useSyncExternalStore } from "react";
import { apiErrorMessage } from "@/lib/client-persist";
import type { YoloInstanceOptionsResponse } from "@/lib/yolo-cost";

export interface YoloOptionsState {
  data: YoloInstanceOptionsResponse | null;
  loading: boolean;
  error: string;
}

let state: YoloOptionsState = { data: null, loading: false, error: "" };
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((fn) => fn());
const set = (next: Partial<YoloOptionsState>) => {
  state = { ...state, ...next };
  emit();
};
const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
};
const read = () => state;

function isOptionsResponse(v: unknown): v is YoloInstanceOptionsResponse {
  const o = v as Partial<YoloInstanceOptionsResponse> | null;
  return (
    !!o &&
    typeof o.instanceType === "string" &&
    typeof o.maxRuntimeSeconds === "number" &&
    Array.isArray(o.catalog?.options) &&
    Array.isArray(o.runStats)
  );
}

export async function loadYoloOptions(refresh = false): Promise<void> {
  set({ loading: true, error: "" });
  try {
    const res = await fetch(`/api/admin/yolo-instance/options${refresh ? "?refresh=1" : ""}`);
    const body: unknown = await res.json().catch(() => null);
    if (!res.ok) {
      set({ loading: false, error: apiErrorMessage(body) || `Could not read the instance options (HTTP ${res.status})` });
      return;
    }
    if (!isOptionsResponse(body)) {
      set({ loading: false, error: "Unexpected instance-options response" });
      return;
    }
    set({ data: body, loading: false });
  } catch {
    set({ loading: false, error: "Could not read the instance options" });
  }
}

/** After a successful save: reflect it everywhere without a refetch. */
export function patchYoloOptions(patch: Partial<Pick<YoloInstanceOptionsResponse, "instanceType" | "valid" | "maxRuntimeSeconds">>): void {
  if (state.data) set({ data: { ...state.data, ...patch } });
}

export function readYoloOptions(): YoloInstanceOptionsResponse | null {
  return state.data;
}

export function useYoloOptions(): YoloOptionsState {
  return useSyncExternalStore(subscribe, read, read);
}

/** Test hook. */
export function resetYoloOptionsForTests(data: YoloInstanceOptionsResponse | null = null): void {
  state = { data, loading: false, error: "" };
  emit();
}
