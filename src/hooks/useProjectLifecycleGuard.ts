"use client";

import { useCallback, useMemo } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import {
  captureProjectLifecycle,
  isCurrentProjectLifecycle,
  type ProjectLifecycleSnapshot,
} from "@/lib/project-lifecycle";
import { useSessionStore } from "@/stores/sessionStore";

type RenderedAuthority = {
  owner: QueryClient;
  publicId: string;
  demo: boolean;
  snapshot: ProjectLifecycleSnapshot | null;
};

/**
 * Capture exact project-open authority during render and expose a stable post-await predicate.
 *
 * Capturing inside an eventual event/debounce callback would let a stale closure borrow its
 * successor's token. This hook instead retains the token that owned the render which created the
 * callback. It subscribes to no store and therefore adds no notification edge to viewer hot paths.
 *
 * Unit/component harnesses that do not install `openProject` retain their historical behavior only
 * while both the registry and the exact rendered session tuple remain unchanged. A null capture can
 * never borrow a lifecycle that appears later.
 *
 * Placement: check the guard at handler entry and after every `await` or external publication
 * (`queryClient.setQueryData`, store `setState`) — the points where the snapshot can go stale. Checks
 * between consecutive synchronous `useState` setters are inert; neither add new ones nor retro-trim them.
 */
export function useProjectLifecycleGuard(
  publicId: string,
  demo: boolean,
): () => boolean {
  const queryClient = useQueryClient();
  const captured = captureProjectLifecycle(queryClient);
  const authority = useMemo<RenderedAuthority>(
    () => ({
      owner: queryClient,
      publicId,
      demo,
      snapshot: captured,
    }),
    [captured, demo, publicId, queryClient],
  );

  return useCallback(() => {
    const session = useSessionStore.getState();
    if (
      session.publicId !== authority.publicId ||
      session.isDemo !== authority.demo
    ) {
      return false;
    }

    if (!authority.snapshot) {
      return captureProjectLifecycle(queryClient) === null;
    }

    return authority.snapshot.publicId === authority.publicId &&
      authority.snapshot.demo === authority.demo &&
      isCurrentProjectLifecycle(queryClient, authority.snapshot);
  }, [authority, queryClient]);
}
