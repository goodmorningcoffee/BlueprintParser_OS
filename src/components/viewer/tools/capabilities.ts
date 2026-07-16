// [refactor jul16 P3.2] Module-level store capabilities for ToolContext.
// One frozen singleton built from the store module singletons: referencing it inside
// AnnotationOverlay's mousedown seam adds NO hook, NO subscription, and NO dependency-array
// entry (the physics contract pins the 37-entry list byte-identical). getState() readers only —
// controllers must never subscribe through ToolContext (types.ts contract).
import { useParseFlowStore } from "@/stores/parseFlowStore";
import { useSessionStore } from "@/stores/sessionStore";
import { useToolStore } from "@/stores/toolStore";
import { useUiStore } from "@/stores/uiStore";
import { useViewerCoreStore } from "@/stores/viewerCoreStore";

import type { ToolStoreCapabilities } from "./types";

export const TOOL_STORE_CAPABILITIES: Readonly<ToolStoreCapabilities> = Object.freeze({
  session: useSessionStore,
  viewerCore: useViewerCoreStore,
  tool: useToolStore,
  parseFlow: useParseFlowStore,
  ui: useUiStore,
});
