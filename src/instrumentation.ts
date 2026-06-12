// [refactor jun12 P0.2] Next.js instrumentation hook — runs ONCE when a server
// instance boots (dev server or production `next start`), NOT during build.
// Sole job for now: validate the env contract so a misconfigured task fails
// its boot loudly with named vars instead of 500ing from deep inside handlers.
export async function register() {
  // nodejs guard: skip the edge runtime (middleware) — env validation only
  // makes sense where the full node env exists.
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { assertEnv } = await import("./lib/env");
    assertEnv();
  }
}
