/**
 * heavy-process-gate.ts — admission control for the heavy work an ANONYMOUS web request can
 * start on a demo project: a whole-PDF download, a Ghostscript rasterize, then python +
 * torch/OpenCV (TATR, img2table, template crop, bucket fill).
 *
 * The web task has 4 GB and the per-IP limiter admits 5 of these every 10 s per address, with no
 * bound on how many run at once; a handful in flight is an OOM kill of the whole site. This gate
 * runs at most MAX_CONCURRENT, queues a few, and refuses the rest quickly with a 503.
 *
 * ★ ANONYMOUS CALLERS ONLY — see `withAnonymousHeavySlot` in src/server/api/heavy-work.ts, the
 * one place this is taken. A gate shared with signed-in users would let any anonymous visitor
 * occupy every slot and deny the owner their own parser: a worse failure than the one it prevents.
 * Signed-in work is bounded by accounts, not by this.
 *
 * A slot is also given back after MAX_HOLD_MS even if its task never settles. None of the S3,
 * Lambda or Textract clients has a request timeout, so without a ceiling two hung calls would
 * make every anonymous parse answer 503 until the task restarts.
 *
 * ⚠ Web-request paths only. The CPU pipeline worker (scripts/process-worker.ts) sizes its own
 * page concurrency and must never import this.
 */

import { ApiError } from "@/server/api/envelope";

const MAX_CONCURRENT = 2;
const MAX_QUEUED = 6;
const MAX_WAIT_MS = 20_000;
const MAX_HOLD_MS = 5 * 60_000;

export const HEAVY_PROCESS_BUSY_MESSAGE =
  "The server is busy with other parsing jobs. Try again in a moment.";

const busy = () => new ApiError("RATE_LIMITED", HEAVY_PROCESS_BUSY_MESSAGE, 503);

interface Waiter {
  admit: () => void;
  timer: ReturnType<typeof setTimeout>;
}

let active = 0;
const queue: Waiter[] = [];

function acquire(): Promise<void> {
  if (active < MAX_CONCURRENT) {
    active += 1;
    return Promise.resolve();
  }
  if (queue.length >= MAX_QUEUED) {
    return Promise.reject(busy());
  }
  return new Promise<void>((resolve, reject) => {
    const waiter: Waiter = {
      admit: () => {
        clearTimeout(waiter.timer);
        resolve();
      },
      timer: setTimeout(() => {
        const index = queue.indexOf(waiter);
        if (index !== -1) queue.splice(index, 1);
        reject(busy());
      }, MAX_WAIT_MS),
    };
    queue.push(waiter);
  });
}

function release(): void {
  const next = queue.shift();
  // Hand the slot straight to the next waiter: `active` does not change.
  if (next) next.admit();
  else active -= 1;
}

/** Run `task` holding one heavy-process slot. Rejects with a 503 ApiError when full. */
export async function withHeavyProcessSlot<T>(task: () => Promise<T>): Promise<T> {
  await acquire();
  let released = false;
  const releaseOnce = () => {
    if (released) return;
    released = true;
    clearTimeout(holdTimer);
    release();
  };
  const holdTimer = setTimeout(releaseOnce, MAX_HOLD_MS);
  try {
    return await task();
  } finally {
    releaseOnce();
  }
}

/** Test-only visibility. */
export function heavyProcessGateStateForTest(): { active: number; queued: number } {
  return { active, queued: queue.length };
}
