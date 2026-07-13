/**
 * Non-reactive capabilities for delayed viewer-tool settlement.
 *
 * The canvas has one global late-tail owner, while Bucket and Symbol retain independent latest-
 * result lanes. Exact object identity prevents ABA/forged-token authority without a Zustand
 * publication, subscriber edge, timer, or stored counter. Target/project/page checks stay with
 * callers; this module proves causal recency only.
 */
export type ToolTailToken = Readonly<object>;
export type LatestToolLane = "bucketFill" | "symbolSession";

type ToolTailCancellation = Readonly<{
  token: ToolTailToken;
  cancel: () => void;
}>;

let currentToolTailOwner: ToolTailToken | null = null;
let currentToolTailCancellation: ToolTailCancellation | null = null;
const latestToolOperations: Record<LatestToolLane, ToolTailToken | null> = {
  bucketFill: null,
  symbolSession: null,
};

/**
 * Retire displaced tail-local UI (a canvas gesture or Bucket spinner) before the browser can
 * paint, without publishing from inside a Tool/Parse functional updater. Exact registration
 * identity lets a synchronous destination B replace A and survive A's queued cleanup.
 */
function queueToolTailCancellation(
  cancellation: ToolTailCancellation | null,
): void {
  if (cancellation === null) return;
  queueMicrotask(() => {
    if (currentToolTailCancellation !== cancellation) return;
    currentToolTailCancellation = null;
    cancellation.cancel();
  });
}

export function registerToolTailCancellation(
  token: ToolTailToken,
  cancel: () => void,
): void {
  currentToolTailCancellation = { token, cancel };
}

/** Remove one successfully settling tail without running its cancellation callback. */
export function releaseToolTailCancellation(token: ToolTailToken): boolean {
  if (currentToolTailCancellation?.token !== token) return false;
  currentToolTailCancellation = null;
  return true;
}

/** Synchronously cancel only the exact local tail generation requested by its owner. */
export function cancelToolTailExact(token: ToolTailToken): boolean {
  const cancellation = currentToolTailCancellation;
  if (cancellation?.token !== token) return false;
  currentToolTailCancellation = null;
  cancellation.cancel();
  return true;
}

export function claimToolTailAuthority<T extends object>(token: T): T {
  const displacedTail = currentToolTailCancellation?.token === token
    ? null
    : currentToolTailCancellation;
  currentToolTailOwner = token;
  queueToolTailCancellation(displacedTail);
  return token;
}

export function invalidateToolTailAuthority(): void {
  const displacedTail = currentToolTailCancellation;
  currentToolTailOwner = null;
  queueToolTailCancellation(displacedTail);
}

export function ownsToolTailAuthority(token: ToolTailToken): boolean {
  return currentToolTailOwner === token;
}

export function consumeToolTailAuthority(
  token: ToolTailToken,
  publish: () => void,
): boolean {
  if (currentToolTailOwner !== token) return false;
  // Clear before publication: a synchronous subscriber may claim B, and no A tail may erase it.
  currentToolTailOwner = null;
  queueToolTailCancellation(
    currentToolTailCancellation?.token === token
      ? currentToolTailCancellation
      : null,
  );
  publish();
  return true;
}

export function claimLatestToolOperation<T extends object>(
  lane: LatestToolLane,
  token: T,
): T {
  latestToolOperations[lane] = token;
  return token;
}

export function invalidateLatestToolOperation(lane: LatestToolLane): void {
  latestToolOperations[lane] = null;
}

export function ownsLatestToolOperation(
  lane: LatestToolLane,
  token: ToolTailToken,
): boolean {
  return latestToolOperations[lane] === token;
}

// Parse operations retain their named compatibility API; it is the same exact global slot.
export function claimParseToolAuthority<T extends object>(token: T): T {
  return claimToolTailAuthority(token);
}

export function invalidateParseToolAuthority(): void {
  invalidateToolTailAuthority();
}

export function ownsParseToolAuthority(token: object): boolean {
  return ownsToolTailAuthority(token);
}
