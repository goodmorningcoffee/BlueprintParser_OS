"use client";

// [refactor jul14 P2] TanStack Query is the live client owner for migrated project server data.
// This provider supplies the single browser QueryClient used by the domain hooks and project
// lifecycle bootstrap/reset; keys come from src/queries/queryKeys.ts.
// Client instantiated inside useState so SSR/App-Router re-renders reuse ONE instance
// (a module-level client would leak state across requests in dev HMR).
// Defaults stay TanStack's own — each live domain owns and tests its staleTime/gcTime policy.
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
