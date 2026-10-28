/**
 * Per-caller in-flight cap for the parse engine (table pipeline PLAN §3.2, WP-3.E; C1-M3).
 *
 * A `standard` parse starts a Python child on a crop and a `thorough` one a paid Textract crop or a
 * model call, on a 4 GB task. The middleware bounds how OFTEN a caller may ask (rule
 * `parse-engine-parse` + the parser burst bucket); this bounds how MANY of one caller's parses run at
 * once: `standard` ≤ 2 and `thorough` ≤ 1 in flight. `instant` (pure methods on stored evidence) is
 * not capped here. The two budgets are separate pools.
 *
 * Scope (memory "shared gates become owner DoS"): the key is the CALLER, never the project or the
 * route, and signed-in and anonymous callers live in separate namespaces (`user:<id>`, `ip:<addr>`),
 * so one caller can only ever fill its own slots. Acquire happens after auth and validation. Every
 * slot has a hold ceiling: a slot older than `PARSE_SLOT_HOLD_CEILING_MS` is treated as leaked and
 * dropped on the next acquire, so a release that never ran cannot lock a caller out for good.
 *
 * Process-local, like the middleware buckets: with N ECS tasks a caller may hold N × the cap.
 * INFERRED adequate at today's single task (PLAN WP-3.E); a shared store is the upgrade.
 */

import type { Budget } from "@/lib/parse-engine/types";

export const PARSE_CONCURRENCY_LIMITS: Readonly<Record<Exclude<Budget, "instant">, number>> = Object.freeze({
  standard: 2,
  thorough: 1,
});
/** Longer than any crop run (Python ≤ 10 s, Textract a few s, retries included). */
export const PARSE_SLOT_HOLD_CEILING_MS = 120_000;

export type ParseCallerKey = `user:${number}` | `ip:${string}`;

interface Slot { id: number; budget: Exclude<Budget, "instant">; at: number }
const inFlight = new Map<string, Slot[]>();
let nextId = 1;

export interface ParseSlot {
  /** Idempotent: the slot is freed once, however many times this is called. */
  release(): void;
}

const NOOP_SLOT: ParseSlot = Object.freeze({ release() {} });

/**
 * Take one of the caller's slots for this budget, or null when they are all in use (the caller answers
 * 429). `instant` always succeeds with a no-op slot.
 */
export function acquireParseSlot(caller: ParseCallerKey, budget: Budget, now: number = Date.now()): ParseSlot | null {
  if (budget === "instant") return NOOP_SLOT;
  const live = (inFlight.get(caller) ?? []).filter((s) => now - s.at < PARSE_SLOT_HOLD_CEILING_MS);
  if (live.filter((s) => s.budget === budget).length >= PARSE_CONCURRENCY_LIMITS[budget]) {
    if (live.length) inFlight.set(caller, live);
    else inFlight.delete(caller);
    return null;
  }
  const slot: Slot = { id: nextId++, budget, at: now };
  live.push(slot);
  inFlight.set(caller, live);
  let released = false;
  return {
    release() {
      if (released) return;
      released = true;
      const rest = (inFlight.get(caller) ?? []).filter((s) => s.id !== slot.id);
      if (rest.length) inFlight.set(caller, rest);
      else inFlight.delete(caller);
    },
  };
}

/** Test-only: how many slots a caller holds (optionally for one budget). */
export function parseSlotsInUseForTest(caller: ParseCallerKey, budget?: Exclude<Budget, "instant">): number {
  return (inFlight.get(caller) ?? []).filter((s) => !budget || s.budget === budget).length;
}

/** Test-only: forget every slot. */
export function resetParseSlotsForTest(): void {
  inFlight.clear();
}
