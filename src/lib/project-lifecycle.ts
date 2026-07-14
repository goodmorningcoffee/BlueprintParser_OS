"use client";

// [refactor jul13 P2.5] One project-open authority shared by the authenticated and demo routes.

import type { QueryClient } from "@tanstack/react-query";
import { queryKeys } from "@/queries/queryKeys";
import { seedAnnotationGroupsCache } from "@/queries/useAnnotationGroups";
import { seedChatCache } from "@/queries/useChatMessages";
import {
  clearCsiGraphProject,
  seedCsiGraphFromBootstrap,
} from "@/queries/useCsiGraph";
import { publishBootstrapPageWindow } from "@/queries/usePageWindow";
import {
  deriveProjectCatalogs,
  seedProjectCatalogsCache,
} from "@/queries/useProjectCatalogs";
import { seedSummariesCache } from "@/queries/useSummaries";
import { seedTakeoffCache } from "@/queries/useTakeoff";
import { clearTextractProject } from "@/queries/textractCache";
import {
  clearYoloTagsProject,
  seedYoloTagsFromBootstrap,
} from "@/queries/useYoloTags";
import { useParseFlowStore } from "@/stores/parseFlowStore";
import { useSessionStore } from "@/stores/sessionStore";
import { useToolStore } from "@/stores/toolStore";
import { useUiStore } from "@/stores/uiStore";
import { useViewerCoreStore } from "@/stores/viewerCoreStore";
import { resetProjectData } from "@/stores/viewerCommands";
import type {
  AnnotationGroup,
  AnnotationGroupMembership,
  ClientTakeoffItem,
  ProjectSummaries,
  ScaleCalibrationData,
  TakeoffGroup,
} from "@/types";
import type { PageWindowResponse } from "@/queries/pageWindowCore";

export interface ProjectBootstrapPage {
  pageNumber: number;
  name: string;
  drawingNumber: string | null;
}

export interface ProjectBootstrapChatRow {
  id: number;
  role: string;
  content: string;
  model: string | null;
}

/** Shared wire shape returned by either project-bootstrap metadata route. */
export interface ProjectResponse {
  id: string;
  dbId: number;
  name: string;
  dataUrl: string;
  pdfUrl: string;
  numPages: number;
  status: string;
  summaries: ProjectSummaries | null;
  projectIntelligence: Record<string, unknown> | null;
  pages: ProjectBootstrapPage[];
  takeoffItems?: ClientTakeoffItem[];
  takeoffGroups?: TakeoffGroup[];
  chatMessages?: ProjectBootstrapChatRow[];
  demoConfig?: Record<string, boolean>;
}

export interface OpenProjectOptions {
  demo: boolean;
  csiFilter?: string | null;
  searchQuery?: string | null;
}

export type OpenProjectResult =
  | { status: "opened"; project: ProjectResponse }
  | { status: "error"; error: Error }
  | { status: "superseded" };

export interface OpenProjectHandle {
  readonly generation: number;
  readonly result: Promise<OpenProjectResult>;
  dispose(): void;
}

const lifecycleToken = Symbol("project-lifecycle-token");

/** Opaque delayed-action authority captured from the current per-QueryClient generation. */
export interface ProjectLifecycleSnapshot {
  readonly generation: number;
  readonly publicId: string;
  readonly demo: boolean;
  readonly [lifecycleToken]: object;
}

interface LifecycleRecord {
  generation: number;
  token: object;
  /** Stable render-time authority object; invalidated only if metadata canonicalizes publicId. */
  snapshot: ProjectLifecycleSnapshot | null;
  controller: AbortController;
  publicId: string;
  demo: boolean;
  active: boolean;
  /** Previous project prefixes whose heavy private cache teardown has not completed yet. */
  cleanupPublicIds: Set<string>;
}

const lifecycleRecords = new WeakMap<QueryClient, LifecycleRecord>();

function ownsRecord(
  queryClient: QueryClient,
  record: LifecycleRecord,
): boolean {
  return lifecycleRecords.get(queryClient) === record && record.active;
}

function errorFrom(value: unknown): Error {
  return value instanceof Error ? value : new Error("Failed to load");
}

function pageLabels(data: ProjectResponse): {
  pageNames: Record<number, string>;
  pageDrawingNumbers: Record<number, string | null>;
} {
  const pageNames: Record<number, string> = {};
  const pageDrawingNumbers: Record<number, string | null> = {};
  for (const page of data.pages) {
    pageNames[page.pageNumber] = page.drawingNumber || page.name;
    pageDrawingNumbers[page.pageNumber] = page.drawingNumber;
  }
  return { pageNames, pageDrawingNumbers };
}

function yoloModelNames(chunk: PageWindowResponse | null): string[] {
  if (!chunk) return [];
  return [...new Set(
    chunk.annotations
      .filter((annotation) =>
        annotation.source === "yolo" &&
        typeof (annotation.data as { modelName?: unknown } | null)?.modelName === "string")
      .map((annotation) =>
        (annotation.data as { modelName: string }).modelName),
  )];
}

async function parseGroupsResponse(
  response: Response,
): Promise<{
  groups?: AnnotationGroup[] | null;
  memberships?: AnnotationGroupMembership[] | null;
} | null> {
  if (!response.ok) return null;
  return (await response.json().catch(() => null)) as {
    groups?: AnnotationGroup[] | null;
    memberships?: AnnotationGroupMembership[] | null;
  } | null;
}

function adoptProject(
  queryClient: QueryClient,
  record: LifecycleRecord,
  data: ProjectResponse,
  chunk: PageWindowResponse | null,
  groups: {
    groups?: AnnotationGroup[] | null;
    memberships?: AnnotationGroupMembership[] | null;
  } | null,
  options: OpenProjectOptions,
): boolean {
  const publicId = data.id;
  const canPublish = () => ownsRecord(queryClient, record);
  if (!canPublish()) return false;

  const projectIntelligenceWithoutYoloTags = seedYoloTagsFromBootstrap(
    queryClient,
    publicId,
    data.projectIntelligence,
  );
  if (!canPublish()) return false;
  seedCsiGraphFromBootstrap(
    queryClient,
    publicId,
    projectIntelligenceWithoutYoloTags,
  );
  if (!canPublish()) return false;
  seedSummariesCache(queryClient, publicId, data.summaries);
  if (!canPublish()) return false;
  seedChatCache(queryClient, publicId, options.demo ? undefined : data.chatMessages);
  if (!canPublish()) return false;
  if (!seedTakeoffCache(
    queryClient,
    publicId,
    options.demo ? undefined : data.takeoffItems,
    options.demo ? undefined : data.takeoffGroups,
    canPublish,
  )) return false;
  seedAnnotationGroupsCache(queryClient, publicId, options.demo ? null : groups);
  if (!canPublish()) return false;
  queryClient.setQueryData(queryKeys.qtoWorkflows.all(publicId), []);
  if (!canPublish()) return false;
  if (!publishBootstrapPageWindow(queryClient, publicId, chunk, data.numPages, canPublish)) {
    return false;
  }
  // Catalogs are identity-bearing bootstrap data. Publish an explicit empty value first so a
  // same-key predecessor can never remain observable while this generation chooses its source.
  seedProjectCatalogsCache(queryClient, publicId, null);
  if (!canPublish()) return false;
  seedProjectCatalogsCache(
    queryClient,
    publicId,
    deriveProjectCatalogs(data.summaries, chunk?.pages, options.demo),
  );
  if (!canPublish()) return false;

  const ui = useUiStore.getState();
  const tool = useToolStore.getState();

  if (options.demo) {
    ui.setConfidenceThreshold(0);
    if (!canPublish()) return false;
    useParseFlowStore.setState({ tableParseTab: "auto" });
    if (!canPublish()) return false;
    useUiStore.setState({
      helpMode: false,
      showTips: false,
      showChatPanel: false,
      showTableParsePanel: true,
    });
    if (!canPublish()) return false;
  }

  if (options.csiFilter) {
    ui.setCsiFilter(options.csiFilter);
    if (!canPublish()) return false;
  }
  if (options.searchQuery) {
    ui.setSearch(options.searchQuery);
    if (!canPublish()) return false;
  }

  const modelNames = data.summaries?.annotationSummary.modelNames ??
    yoloModelNames(chunk);
  if (modelNames.length > 0) {
    ui.initDetectionModels(modelNames);
    if (!canPublish()) return false;
    if (options.demo) {
      for (const modelName of modelNames) {
        useUiStore.getState().setModelConfidence(modelName, 0);
        if (!canPublish()) return false;
      }
    }
  }

  if (!options.demo && chunk) {
    for (const annotation of chunk.annotations) {
      if (
        annotation.source === "takeoff-scale" &&
        (annotation.data as { type?: unknown } | null)?.type === "scale-calibration"
      ) {
        tool.setScaleCalibration(
          annotation.pageNumber,
          // The wire union is intentionally unvalidated until P4; the discriminator above is the
          // same runtime gate the old loader used, so this assertion changes types only.
          annotation.data as unknown as ScaleCalibrationData,
        );
        if (!canPublish()) return false;
      }
    }
  }

  // Keep the destination stores fully prepared before the single activation publication below.
  useViewerCoreStore.setState({ numPages: data.numPages || 0 });
  if (!canPublish()) return false;
  const labels = pageLabels(data);
  useSessionStore.setState({
    projectId: data.dbId,
    publicId,
    dataUrl: data.dataUrl,
    isDemo: options.demo,
    demoFeatureConfig: options.demo ? (data.demoConfig ?? null) : null,
    pageNames: labels.pageNames,
    pageDrawingNumbers: labels.pageDrawingNumbers,
  });
  return canPublish();
}

async function runProjectOpen(
  queryClient: QueryClient,
  record: LifecycleRecord,
  routePublicId: string,
  options: OpenProjectOptions,
): Promise<OpenProjectResult> {
  try {
    // resetProjectData publishes synchronously. A reset subscriber may install B before A reaches
    // this async runner, including when A inherited no cleanup targets and would otherwise skip the
    // guarded cleanup loop entirely.
    if (!ownsRecord(queryClient, record)) return { status: "superseded" };
    for (const cleanupPublicId of [...record.cleanupPublicIds]) {
      if (!ownsRecord(queryClient, record)) return { status: "superseded" };
      // QTO is independently fetched under a publicId-only key. Cancel its exact TanStack retryer
      // before same-ID auth -> demo can seed/activate; even a transport that ignores AbortSignal
      // cannot later repopulate private rows once the retryer is cancelled.
      await queryClient.cancelQueries(
        { queryKey: queryKeys.qtoWorkflows.all(cleanupPublicId), exact: true },
        { silent: true },
      );
      if (!ownsRecord(queryClient, record)) return { status: "superseded" };
      clearYoloTagsProject(queryClient, cleanupPublicId);
      if (!ownsRecord(queryClient, record)) return { status: "superseded" };
      clearCsiGraphProject(queryClient, cleanupPublicId);
      if (!ownsRecord(queryClient, record)) return { status: "superseded" };
      await clearTextractProject(
        queryClient,
        cleanupPublicId,
        () => ownsRecord(queryClient, record),
      );
      if (!ownsRecord(queryClient, record)) return { status: "superseded" };
      record.cleanupPublicIds.delete(cleanupPublicId);
    }

    if (!ownsRecord(queryClient, record)) return { status: "superseded" };

    const request = (url: string, init?: RequestInit) =>
      fetch(url, { ...init, signal: record.controller.signal });
    const responses = options.demo
      ? await Promise.all([
          request(`/api/demo/projects/${routePublicId}`),
          request(`/api/demo/projects/${routePublicId}/pages?from=1&to=15`),
        ])
      : await Promise.all([
          request(`/api/projects/${routePublicId}`, { cache: "no-store" }),
          request(`/api/projects/${routePublicId}/pages?from=1&to=15`),
          request(`/api/annotation-groups?projectId=${routePublicId}`),
        ]);
    if (!ownsRecord(queryClient, record)) return { status: "superseded" };

    const metadataResponse = responses[0];
    const chunkResponse = responses[1];
    if (!metadataResponse.ok) {
      throw new Error(options.demo ? "Project not found" : "Failed to load project");
    }

    const data = (await metadataResponse.json()) as ProjectResponse;
    if (!ownsRecord(queryClient, record)) return { status: "superseded" };
    // Metadata is the first point at which the server-canonical cache identity is known. Record it
    // before any later failure-path or adoption publication so a reentrant successor inherits the
    // exact prefix A may already have touched, rather than only A's route alias.
    record.publicId = data.id;
    record.snapshot = null;

    const groups = options.demo
      ? null
      : await parseGroupsResponse(responses[2]!);
    if (!ownsRecord(queryClient, record)) return { status: "superseded" };

    let chunk: PageWindowResponse | null = null;
    if (chunkResponse.ok) {
      try {
        chunk = (await chunkResponse.json()) as PageWindowResponse;
      } catch (error) {
        if (!ownsRecord(queryClient, record)) return { status: "superseded" };
        // Preserve the loaders' fatal-decode semantics while clearing the same-ID paired caches.
        // Publication itself is reentrant: if its annotation write starts B, A must suppress the
        // window half and settle superseded rather than report an obsolete route error.
        if (!publishBootstrapPageWindow(
          queryClient,
          data.id,
          null,
          data.numPages,
          () => ownsRecord(queryClient, record),
        )) {
          return { status: "superseded" };
        }
        throw error;
      }
      if (!ownsRecord(queryClient, record)) return { status: "superseded" };
    }

    if (!adoptProject(queryClient, record, data, chunk, groups, options)) {
      return { status: "superseded" };
    }
    if (!options.demo) {
      // A same-publicId auth reopen may batch session reset+activation without changing the live
      // observer's selectors. Explicitly restart the exact active GET after its predecessor was
      // cancelled; different-ID opens still fetch normally when their observer mounts.
      void queryClient.refetchQueries({
        queryKey: queryKeys.qtoWorkflows.all(data.id),
        exact: true,
        type: "active",
      });
      if (!ownsRecord(queryClient, record)) return { status: "superseded" };
    }
    return { status: "opened", project: data };
  } catch (error) {
    if (!ownsRecord(queryClient, record)) return { status: "superseded" };
    // Revoke before notifying synchronous AbortSignal listeners so none can borrow A's authority.
    // A listener may install B during abort; registry identity then decides whether this failure is
    // still A's terminal result or became obsolete during notification.
    record.active = false;
    record.controller.abort();
    if (lifecycleRecords.get(queryClient) !== record) return { status: "superseded" };
    return { status: "error", error: errorFrom(error) };
  }
}

/** Begin one project-open generation and return its exact cleanup handle synchronously. */
export function openProject(
  queryClient: QueryClient,
  routePublicId: string,
  options: OpenProjectOptions,
): OpenProjectHandle {
  const previous = lifecycleRecords.get(queryClient);
  const cleanupPublicIds = new Set(previous?.cleanupPublicIds);
  // A can be superseded or disposed after publishing a canonical heavy-cache prefix but before
  // session activation. Its session is still empty, so transfer the record-owned identity itself.
  if (previous?.publicId) cleanupPublicIds.add(previous.publicId);
  const livePublicId = useSessionStore.getState().publicId;
  if (livePublicId) cleanupPublicIds.add(livePublicId);

  const record: LifecycleRecord = {
    generation: (previous?.generation ?? 0) + 1,
    token: Object.freeze({}),
    snapshot: null,
    controller: new AbortController(),
    publicId: routePublicId,
    demo: options.demo,
    active: true,
    cleanupPublicIds,
  };
  // Install the monotonically newer token before notifying the previous controller's synchronous
  // abort listeners. If a listener opens C, it will supersede this candidate with generation n+2;
  // the outer invocation must never resume and overwrite C with a duplicate n+1 record.
  lifecycleRecords.set(queryClient, record);
  if (previous?.active) {
    previous.active = false;
    previous.controller.abort();
  }
  const resetCompleted = resetProjectData(() => ownsRecord(queryClient, record));
  const result: Promise<OpenProjectResult> = resetCompleted
    ? runProjectOpen(queryClient, record, routePublicId, options)
    : Promise.resolve({ status: "superseded" });

  return {
    generation: record.generation,
    result,
    dispose: () => {
      if (!ownsRecord(queryClient, record)) return;
      record.active = false;
      record.controller.abort();
    },
  };
}

export function captureProjectLifecycle(
  queryClient: QueryClient,
): ProjectLifecycleSnapshot | null {
  const record = lifecycleRecords.get(queryClient);
  if (!record?.active) return null;
  // Render-adjacent consumers call this on every render. Retain one immutable object per record so
  // exact authority capture adds no allocation churn to the viewer hot path. Metadata may replace a
  // route alias with the canonical publicId; that assignment invalidates this cache above.
  record.snapshot ??= Object.freeze({
    generation: record.generation,
    publicId: record.publicId,
    demo: record.demo,
    [lifecycleToken]: record.token,
  });
  return record.snapshot;
}

export function isCurrentProjectLifecycle(
  queryClient: QueryClient,
  snapshot: ProjectLifecycleSnapshot | null | undefined,
): boolean {
  if (!snapshot) return false;
  const record = lifecycleRecords.get(queryClient);
  return !!record &&
    record.active &&
    record.generation === snapshot.generation &&
    record.publicId === snapshot.publicId &&
    record.demo === snapshot.demo &&
    record.token === snapshot[lifecycleToken];
}
