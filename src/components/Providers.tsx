"use client";

// [refactor jul8 P2.1] TanStack Query introduced (plan 03 §2.1 — zero behavior change:
// no component consumes the cache yet). Each §2.2 domain migration (①chat→⑨yoloTags)
// starts pointing its reads/mutations here; keys come from src/queries/queryKeys.ts.
// Client instantiated inside useState so SSR/App-Router re-renders reuse ONE instance
// (a module-level client would leak state across requests in dev HMR).
// Defaults stay TanStack's own — per-domain staleTime/gcTime land WITH each migration,
// pinned by that domain's tests, not preemptively here.
import { useState } from "react";
import { SessionProvider } from "next-auth/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ReactQueryDevtools } from "@tanstack/react-query-devtools";

export default function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(() => new QueryClient());
  return (
    <SessionProvider>
      <QueryClientProvider client={queryClient}>
        {children}
        {process.env.NODE_ENV === "development" && (
          <ReactQueryDevtools initialIsOpen={false} buttonPosition="bottom-left" />
        )}
      </QueryClientProvider>
    </SessionProvider>
  );
}
