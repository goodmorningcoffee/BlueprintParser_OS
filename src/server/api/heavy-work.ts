// The ONE place the heavy-process gate is taken. Wrap the whole handler of a parser route that is
// reachable without a session (demo projects): the PDF download and rasterize then sit inside the
// slot, not just the python child at the end.
//
// A caller with a session is never gated and never queued behind anonymous traffic. `auth()` is
// resolved here only to decide that; the service authenticates again for access, as it always did.
import { auth } from "@/lib/auth";
import { withHeavyProcessSlot } from "@/lib/heavy-process-gate";

export async function withAnonymousHeavySlot<T>(task: () => Promise<T>): Promise<T> {
  const session = await auth();
  if (session?.user) return task();
  return withHeavyProcessSlot(task);
}
