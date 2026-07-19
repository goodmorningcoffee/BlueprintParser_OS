import type { NormalizedPoint } from "@/lib/annotation-split-contract";
import { orient2d } from "robust-predicates";

const SPLIT_SEGMENT_INTERSECTION_TOLERANCE = 1e-12;
const SWEEP_MINIMUM_RELATIVE_X_PROJECTION = 1e-6;

type SweepPoint = Readonly<{
  x: number;
  y: number;
}>;

type BoundaryEdge = Readonly<{
  index: number;
  a: NormalizedPoint;
  b: NormalizedPoint;
  left: SweepPoint;
  right: SweepPoint;
  leftSource: NormalizedPoint;
  rightSource: NormalizedPoint;
  vertical: boolean;
}>;

interface EdgeNode {
  edge: BoundaryEdge;
  left: EdgeNode | null;
  right: EdgeNode | null;
  parent: EdgeNode | null;
  height: number;
}

type BoundaryEvent = Readonly<{
  x: number;
  kind: "start" | "end" | "vertical";
  edge: BoundaryEdge;
}>;

function robustOrientation(
  a: NormalizedPoint,
  b: NormalizedPoint,
  c: NormalizedPoint,
): number {
  return orient2d(a.x, a.y, b.x, b.y, c.x, c.y);
}

function onSegment(
  point: NormalizedPoint,
  a: NormalizedPoint,
  b: NormalizedPoint,
): boolean {
  return (
    robustOrientation(a, b, point) === 0 &&
    point.x >= Math.min(a.x, b.x) &&
    point.x <= Math.max(a.x, b.x) &&
    point.y >= Math.min(a.y, b.y) &&
    point.y <= Math.max(a.y, b.y)
  );
}

function edgesIntersect(left: BoundaryEdge, right: BoundaryEdge): boolean {
  const exactAbC = robustOrientation(left.a, left.b, right.a);
  const exactAbD = robustOrientation(left.a, left.b, right.b);
  const exactCdA = robustOrientation(right.a, right.b, left.a);
  const exactCdB = robustOrientation(right.a, right.b, left.b);
  if (
    exactAbC !== 0 &&
    exactAbD !== 0 &&
    exactCdA !== 0 &&
    exactCdB !== 0 &&
    exactAbC < 0 !== exactAbD < 0 &&
    exactCdA < 0 !== exactCdB < 0
  ) {
    return true;
  }
  return (
    (exactAbC === 0 && onSegment(right.a, left.a, left.b)) ||
    (exactAbD === 0 && onSegment(right.b, left.a, left.b)) ||
    (exactCdA === 0 && onSegment(left.a, right.a, right.b)) ||
    (exactCdB === 0 && onSegment(left.b, right.a, right.b))
  );
}

function edgesAreAdjacent(
  left: BoundaryEdge,
  right: BoundaryEdge,
  edgeCount: number,
): boolean {
  const distance = Math.abs(left.index - right.index);
  return distance === 1 || distance === edgeCount - 1;
}

function edgeYAt(edge: BoundaryEdge, x: number): number {
  const progress = (x - edge.left.x) / (edge.right.x - edge.left.x);
  return edge.left.y + progress * (edge.right.y - edge.left.y);
}

function chooseSweepShear(polygon: readonly NormalizedPoint[]): number {
  const forbidden: Array<Readonly<{ start: number; end: number }>> = [];
  for (let index = 0; index < polygon.length; index += 1) {
    const a = polygon[index];
    const b = polygon[(index + 1) % polygon.length];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    if (dy === 0) continue;
    const center = -dx / dy;
    const radius =
      (SWEEP_MINIMUM_RELATIVE_X_PROJECTION * Math.hypot(dx, dy)) / Math.abs(dy);
    const start = Math.max(0, center - radius);
    const end = Math.min(1, center + radius);
    if (start <= end && end >= 0 && start <= 1) forbidden.push({ start, end });
  }
  forbidden.sort(
    (left, right) => left.start - right.start || left.end - right.end,
  );

  let coveredThrough = 0;
  let bestStart = 0;
  let bestEnd = 0;
  for (const interval of forbidden) {
    if (interval.start > coveredThrough) {
      if (interval.start - coveredThrough > bestEnd - bestStart) {
        bestStart = coveredThrough;
        bestEnd = interval.start;
      }
      coveredThrough = interval.end;
    } else {
      coveredThrough = Math.max(coveredThrough, interval.end);
    }
  }
  if (1 - coveredThrough > bestEnd - bestStart) {
    bestStart = coveredThrough;
    bestEnd = 1;
  }
  return (bestStart + bestEnd) / 2;
}

/**
 * Detects a non-neighbor boundary intersection in O(n log n) for a simple polygon.
 *
 * This is the Shamos-Hoey existence sweep: while no invalid intersection has been found, the
 * vertical order of active non-vertical edges cannot change. Therefore an intersecting pair must
 * become neighbors at an insertion or removal. Exact vertical edges are range-queried against the
 * same status tree; a valid polygon produces only its two neighboring endpoint hits.
 */
export function hasSimplePolygonBoundary(
  polygon: readonly NormalizedPoint[],
): boolean {
  const tolerance = SPLIT_SEGMENT_INTERSECTION_TOLERANCE;
  const edgeCount = polygon.length;
  const pointCells = new Map<string, NormalizedPoint[]>();
  for (const point of polygon) {
    const cellX = Math.floor(point.x / tolerance);
    const cellY = Math.floor(point.y / tolerance);
    for (let xOffset = -1; xOffset <= 1; xOffset += 1) {
      for (let yOffset = -1; yOffset <= 1; yOffset += 1) {
        const nearby = pointCells.get(`${cellX + xOffset}:${cellY + yOffset}`);
        if (
          nearby?.some(
            (candidate) =>
              Math.hypot(point.x - candidate.x, point.y - candidate.y) <=
              tolerance,
          )
        ) {
          return false;
        }
      }
    }
    const cellKey = `${cellX}:${cellY}`;
    const cell = pointCells.get(cellKey);
    if (cell) cell.push(point);
    else pointCells.set(cellKey, [point]);
  }
  for (let index = 0; index < edgeCount; index += 1) {
    const previous = polygon[(index - 1 + edgeCount) % edgeCount];
    const point = polygon[index];
    const next = polygon[(index + 1) % edgeCount];
    if (
      Math.hypot(point.x - next.x, point.y - next.y) <= tolerance ||
      (robustOrientation(previous, point, next) === 0 &&
        (previous.x - point.x) * (next.x - point.x) +
          (previous.y - point.y) * (next.y - point.y) >
          tolerance)
    ) {
      return false;
    }
  }

  const sweepShear = chooseSweepShear(polygon);
  const edges: BoundaryEdge[] = polygon.map((a, index) => {
    const b = polygon[(index + 1) % edgeCount];
    const sweepA = { x: a.x + sweepShear * a.y, y: a.y };
    const sweepB = { x: b.x + sweepShear * b.y, y: b.y };
    const vertical = sweepA.x === sweepB.x;
    const reversed = !vertical && sweepA.x > sweepB.x;
    return {
      index,
      a,
      b,
      vertical,
      left: reversed ? sweepB : sweepA,
      right: reversed ? sweepA : sweepB,
      leftSource: reversed ? b : a,
      rightSource: reversed ? a : b,
    };
  });

  let root: EdgeNode | null = null;
  let sweepX = 0;
  const nodes = new Map<number, EdgeNode>();

  const compareEdges = (left: BoundaryEdge, right: BoundaryEdge): number => {
    if (left.index === right.index) return 0;
    // `left` is the edge being inserted at its left endpoint. Compare that source point against
    // the active edge with adaptive exact orientation; interpolated y values can round to the
    // wrong side and silently corrupt the sweep order for nearly collinear vertices.
    const orientation = robustOrientation(
      right.leftSource,
      right.rightSource,
      left.leftSource,
    );
    if (orientation !== 0) return -Math.sign(orientation);
    // When the insertion point lies on the active edge, compare the inserted edge's departure
    // exactly as well. A floating slope determinant can round a nonzero sub-ULP separation to zero
    // and reverse the status order by falling through to the stable index tie-breaker.
    const departureOrientation = robustOrientation(
      right.leftSource,
      right.rightSource,
      left.rightSource,
    );
    if (departureOrientation !== 0) {
      return -Math.sign(departureOrientation);
    }
    return left.index - right.index;
  };

  const replaceParentLink = (
    node: EdgeNode,
    replacement: EdgeNode | null,
  ): void => {
    if (!node.parent) {
      root = replacement;
    } else if (node.parent.left === node) {
      node.parent.left = replacement;
    } else {
      node.parent.right = replacement;
    }
    if (replacement) replacement.parent = node.parent;
  };

  const nodeHeight = (node: EdgeNode | null): number => node?.height ?? 0;
  const refreshHeight = (node: EdgeNode): void => {
    node.height = 1 + Math.max(nodeHeight(node.left), nodeHeight(node.right));
  };

  const rotateLeft = (node: EdgeNode): EdgeNode => {
    const replacement = node.right;
    if (!replacement) return node;
    const parent = node.parent;
    node.right = replacement.left;
    if (node.right) node.right.parent = node;
    replacement.left = node;
    node.parent = replacement;
    replacement.parent = parent;
    if (!parent) root = replacement;
    else if (parent.left === node) parent.left = replacement;
    else parent.right = replacement;
    refreshHeight(node);
    refreshHeight(replacement);
    return replacement;
  };

  const rotateRight = (node: EdgeNode): EdgeNode => {
    const replacement = node.left;
    if (!replacement) return node;
    const parent = node.parent;
    node.left = replacement.right;
    if (node.left) node.left.parent = node;
    replacement.right = node;
    node.parent = replacement;
    replacement.parent = parent;
    if (!parent) root = replacement;
    else if (parent.left === node) parent.left = replacement;
    else parent.right = replacement;
    refreshHeight(node);
    refreshHeight(replacement);
    return replacement;
  };

  const rebalanceFrom = (start: EdgeNode | null): void => {
    let current = start;
    while (current) {
      refreshHeight(current);
      const balance = nodeHeight(current.left) - nodeHeight(current.right);
      let subtreeRoot = current;
      if (balance > 1) {
        if (
          current.left &&
          nodeHeight(current.left.left) < nodeHeight(current.left.right)
        ) {
          rotateLeft(current.left);
        }
        subtreeRoot = rotateRight(current);
      } else if (balance < -1) {
        if (
          current.right &&
          nodeHeight(current.right.right) < nodeHeight(current.right.left)
        ) {
          rotateRight(current.right);
        }
        subtreeRoot = rotateLeft(current);
      }
      current = subtreeRoot.parent;
    }
  };

  const predecessor = (node: EdgeNode): EdgeNode | null => {
    if (node.left) {
      let current = node.left;
      while (current.right) current = current.right;
      return current;
    }
    let current = node;
    while (current.parent?.left === current) current = current.parent;
    return current.parent;
  };

  const successor = (node: EdgeNode): EdgeNode | null => {
    if (node.right) {
      let current = node.right;
      while (current.left) current = current.left;
      return current;
    }
    let current = node;
    while (current.parent?.right === current) current = current.parent;
    return current.parent;
  };

  const firstNonAdjacent = (
    edge: BoundaryEdge,
    node: EdgeNode | null,
    move: (current: EdgeNode) => EdgeNode | null,
  ): EdgeNode | null => {
    let current = node;
    while (current && edgesAreAdjacent(edge, current.edge, edgeCount)) {
      current = move(current);
    }
    return current;
  };

  const invalidNeighbor = (
    edge: BoundaryEdge,
    node: EdgeNode | null,
    move: (current: EdgeNode) => EdgeNode | null,
  ): boolean => {
    const candidate = firstNonAdjacent(edge, node, move);
    return candidate ? edgesIntersect(edge, candidate.edge) : false;
  };

  const insertEdge = (edge: BoundaryEdge): EdgeNode => {
    const node: EdgeNode = {
      edge,
      left: null,
      right: null,
      parent: null,
      height: 1,
    };
    if (!root) {
      root = node;
      nodes.set(edge.index, node);
      return node;
    }

    let parent = root;
    for (;;) {
      if (compareEdges(edge, parent.edge) < 0) {
        if (parent.left) parent = parent.left;
        else {
          parent.left = node;
          break;
        }
      } else if (parent.right) {
        parent = parent.right;
      } else {
        parent.right = node;
        break;
      }
    }
    node.parent = parent;
    rebalanceFrom(parent);
    nodes.set(edge.index, node);
    return node;
  };

  const removeEdge = (node: EdgeNode): void => {
    const removedEdge = node.edge;
    let target = node;
    if (node.left && node.right) {
      target = node.right;
      while (target.left) target = target.left;
      node.edge = target.edge;
      nodes.set(node.edge.index, node);
    }
    const parent = target.parent;
    replaceParentLink(target, target.left ?? target.right);
    nodes.delete(removedEdge.index);
    rebalanceFrom(parent);
  };

  const invalidVerticalStatusIntersection = (
    vertical: BoundaryEdge,
  ): boolean => {
    const minY = Math.min(vertical.a.y, vertical.b.y) - tolerance;
    const maxY = Math.max(vertical.a.y, vertical.b.y) + tolerance;
    let current = root;
    let first: EdgeNode | null = null;
    while (current) {
      if (edgeYAt(current.edge, sweepX) >= minY) {
        first = current;
        current = current.left;
      } else {
        current = current.right;
      }
    }
    for (current = first; current; current = successor(current)) {
      if (edgeYAt(current.edge, sweepX) > maxY) break;
      if (
        !edgesAreAdjacent(vertical, current.edge, edgeCount) &&
        edgesIntersect(vertical, current.edge)
      ) {
        return true;
      }
    }
    return false;
  };

  const events: BoundaryEvent[] = [];
  for (const edge of edges) {
    if (edge.vertical) {
      events.push({ x: edge.left.x, kind: "vertical", edge });
    } else {
      events.push(
        { x: edge.left.x, kind: "start", edge },
        { x: edge.right.x, kind: "end", edge },
      );
    }
  }
  events.sort((left, right) => left.x - right.x);

  for (let eventIndex = 0; eventIndex < events.length;) {
    sweepX = events[eventIndex].x;
    const ending: BoundaryEdge[] = [];
    const starting: BoundaryEdge[] = [];
    const vertical: BoundaryEdge[] = [];
    let nextEventIndex = eventIndex;
    while (
      nextEventIndex < events.length &&
      events[nextEventIndex].x === sweepX
    ) {
      const event = events[nextEventIndex];
      if (event.kind === "end") ending.push(event.edge);
      else if (event.kind === "start") starting.push(event.edge);
      else vertical.push(event.edge);
      nextEventIndex += 1;
    }

    for (const edge of vertical) {
      if (invalidVerticalStatusIntersection(edge)) return false;
    }

    for (const edge of ending) {
      const node = nodes.get(edge.index);
      if (!node) return false;
      const before = predecessor(node);
      const after = successor(node);
      const beforeEdge = before?.edge;
      const afterEdge = after?.edge;
      if (
        invalidNeighbor(edge, before, predecessor) ||
        invalidNeighbor(edge, after, successor)
      ) {
        return false;
      }
      removeEdge(node);
      if (beforeEdge && afterEdge) {
        const beforeNode = nodes.get(beforeEdge.index);
        const afterNode = nodes.get(afterEdge.index);
        if (
          (beforeNode &&
            invalidNeighbor(beforeEdge, successor(beforeNode), successor)) ||
          (afterNode &&
            invalidNeighbor(afterEdge, predecessor(afterNode), predecessor))
        ) {
          return false;
        }
      }
    }

    for (const edge of starting) {
      const node = insertEdge(edge);
      if (
        invalidNeighbor(edge, predecessor(node), predecessor) ||
        invalidNeighbor(edge, successor(node), successor)
      ) {
        return false;
      }
    }

    for (const edge of vertical) {
      if (invalidVerticalStatusIntersection(edge)) return false;
    }

    const verticalByMinY = [...vertical].sort(
      (left, right) =>
        Math.min(left.a.y, left.b.y) - Math.min(right.a.y, right.b.y) ||
        left.index - right.index,
    );
    const greatestPriorMaxY: BoundaryEdge[] = [];
    for (const edge of verticalByMinY) {
      const minY = Math.min(edge.a.y, edge.b.y) - tolerance;
      for (const candidate of greatestPriorMaxY) {
        if (Math.max(candidate.a.y, candidate.b.y) < minY) break;
        if (
          !edgesAreAdjacent(edge, candidate, edgeCount) &&
          edgesIntersect(edge, candidate)
        ) {
          return false;
        }
      }
      greatestPriorMaxY.push(edge);
      greatestPriorMaxY.sort(
        (left, right) =>
          Math.max(right.a.y, right.b.y) - Math.max(left.a.y, left.b.y),
      );
      if (greatestPriorMaxY.length > 3) greatestPriorMaxY.length = 3;
    }

    eventIndex = nextEventIndex;
  }

  return root === null;
}
