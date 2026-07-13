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

let currentToolTailOwner: ToolTailToken | null = null;
const latestToolOperations: Record<LatestToolLane, ToolTailToken | null> = {
  bucketFill: null,
  symbolSession: null,
};

export function claimToolTailAuthority<T extends object>(token: T): T {
  currentToolTailOwner = token;
  return token;
}

export function invalidateToolTailAuthority(): void {
  currentToolTailOwner = null;
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

// Existing parse callers retain their named API until the atomic AT2 consumer migration.
export function claimParseToolAuthority<T extends object>(token: T): T {
  return claimToolTailAuthority(token);
}

export function invalidateParseToolAuthority(): void {
  invalidateToolTailAuthority();
}

export function ownsParseToolAuthority(token: object): boolean {
  return ownsToolTailAuthority(token);
}
