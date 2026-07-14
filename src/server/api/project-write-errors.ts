type DatabaseErrorShape = {
  code?: unknown;
  constraint?: unknown;
  message?: unknown;
  cause?: unknown;
};

/** Recognize the database demo-write backstop without trusting message text alone. */
export function isDemoWriteProtectionError(error: unknown): boolean {
  const visited = new Set<object>();
  let current: unknown = error;

  for (let depth = 0; depth < 8 && current && typeof current === "object"; depth += 1) {
    if (visited.has(current)) return false;
    visited.add(current);

    const candidate = current as DatabaseErrorShape;
    if (
      candidate.code === "P0001" &&
      candidate.constraint === "demo_project_read_only" &&
      candidate.message === "Demo projects are read-only"
    ) {
      return true;
    }
    current = candidate.cause;
  }
  return false;
}
