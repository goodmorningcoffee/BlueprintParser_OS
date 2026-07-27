/**
 * oneclick.worker.ts — worker #2. Shell only.
 *
 * Every decision lives in `@/lib/oneclick-worker-core`, which is a pure function over explicit
 * state and is therefore testable in a plain node environment. This file exists to own one thing:
 * the `self` binding. Keeping it this thin is deliberate — the legacy worker registers its
 * listener at module scope alongside all its logic, which is why importing it outside a DOM-ish
 * environment throws.
 *
 * ⚠ Runs ALONGSIDE `bucket-fill.worker.ts`, it does not replace it. Retiring the legacy worker is
 * phase 7 and is owner-initiated; until then both exist and the routing layer decides.
 */

import {
  createWorkerState,
  handleOneclickMessage,
  type OneclickRequest,
} from "@/lib/oneclick-worker-core";

const state = createWorkerState();

self.addEventListener("message", (e: MessageEvent<OneclickRequest>) => {
  // The core never throws — every failure is a typed response — so there is no try/catch here.
  // An exception at this boundary would surface as a bare `onerror` with no request id attached,
  // which the caller could not map back to a pending click.
  self.postMessage(handleOneclickMessage(state, e.data));
});
