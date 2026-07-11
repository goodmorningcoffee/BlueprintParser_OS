import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";

export type DemoFeatureConfig = Record<string, boolean>;

export interface LabelingSession {
  labelStudioUrl: string;
  pageRange: string;
  taskCount: number;
}

export interface LabelingCredentials {
  email: string;
  password: string;
}

export interface SessionData {
  projectId: number;
  publicId: string;
  dataUrl: string;
  isDemo: boolean;
  demoFeatureConfig: DemoFeatureConfig | null;
  pageNames: Record<number, string>;
  pageDrawingNumbers: Record<number, string | null>;
  showLabelingWizard: boolean;
  labelingWizardStep: number;
  labelingSessions: LabelingSession[];
  labelingCredentials: LabelingCredentials | null;
}

interface SessionActions {
  setProjectId: (projectId: number) => void;
  setPublicId: (publicId: string) => void;
  setDataUrl: (dataUrl: string) => void;
  setIsDemo: (isDemo: boolean) => void;
  setDemoFeatureConfig: (demoFeatureConfig: DemoFeatureConfig) => void;
  setPageNames: (pageNames: Record<number, string>) => void;
  setPageName: (pageNum: number, name: string) => void;
  setPageDrawingNumbers: (pageDrawingNumbers: Record<number, string | null>) => void;
  setShowLabelingWizard: (showLabelingWizard: boolean) => void;
  setLabelingWizardStep: (labelingWizardStep: number) => void;
  setLabelingSessions: (labelingSessions: LabelingSession[]) => void;
  setLabelingCredentials: (labelingCredentials: LabelingCredentials | null) => void;
  resetSession: () => void;
}

export interface SessionState extends SessionData, SessionActions {}

export const initialSessionState: SessionData = {
  projectId: 0,
  publicId: "",
  dataUrl: "",
  isDemo: false,
  demoFeatureConfig: null,
  pageNames: {},
  pageDrawingNumbers: {},
  showLabelingWizard: false,
  labelingWizardStep: 1,
  labelingSessions: [],
  labelingCredentials: null,
};

function freshSessionState(): SessionData {
  return {
    ...initialSessionState,
    // Reset gets fresh containers just as resetProjectData does today. This avoids an escaped map
    // or array from one project becoming the next project's nominally-empty initial value.
    pageNames: {},
    pageDrawingNumbers: {},
    labelingSessions: [],
  };
}

// This leaf deliberately imports no Query facade or sibling store. Project-open/reset ordering is
// a coordinator concern, so the additive slice can become the sole owner in one later flip.
export const useSessionStore = create<SessionState>((set) => ({
  ...freshSessionState(),
  setProjectId: (projectId) => set({ projectId }),
  setPublicId: (publicId) => set({ publicId }),
  setDataUrl: (dataUrl) => set({ dataUrl }),
  setIsDemo: (isDemo) => set({ isDemo }),
  setDemoFeatureConfig: (demoFeatureConfig) => set({ demoFeatureConfig }),
  setPageNames: (pageNames) => set({ pageNames }),
  setPageName: (pageNum, name) =>
    set((state) => ({ pageNames: { ...state.pageNames, [pageNum]: name } })),
  setPageDrawingNumbers: (pageDrawingNumbers) => set({ pageDrawingNumbers }),
  setShowLabelingWizard: (showLabelingWizard) => set({ showLabelingWizard }),
  setLabelingWizardStep: (labelingWizardStep) => set({ labelingWizardStep }),
  setLabelingSessions: (labelingSessions) => set({ labelingSessions }),
  setLabelingCredentials: (labelingCredentials) => set({ labelingCredentials }),
  resetSession: () => set(freshSessionState()),
}));

/**
 * Compatibility surface for the existing read-mostly `useProject` consumers.
 * `projectIntelligenceData` is intentionally absent: server bootstrap data gets Query ownership
 * before the later session flip instead of acquiring a second home in this leaf store.
 */
export const useProject = () =>
  useSessionStore(
    useShallow((state) => ({
      projectId: state.projectId,
      publicId: state.publicId,
      dataUrl: state.dataUrl,
      isDemo: state.isDemo,
      demoFeatureConfig: state.demoFeatureConfig,
      pageNames: state.pageNames,
    })),
  );

/** Identity/policy projection for Query keys and request guards. */
export const useProjectIdentity = () =>
  useSessionStore(
    useShallow((state) => ({
      projectId: state.projectId,
      publicId: state.publicId,
      dataUrl: state.dataUrl,
      isDemo: state.isDemo,
      demoFeatureConfig: state.demoFeatureConfig,
    })),
  );

/** Page labels are session metadata, not viewer navigation state. */
export const usePageSession = () =>
  useSessionStore(
    useShallow((state) => ({
      pageNames: state.pageNames,
      setPageNames: state.setPageNames,
      setPageName: state.setPageName,
      pageDrawingNumbers: state.pageDrawingNumbers,
      setPageDrawingNumbers: state.setPageDrawingNumbers,
    })),
  );

export const useLabelingSession = () =>
  useSessionStore(
    useShallow((state) => ({
      showLabelingWizard: state.showLabelingWizard,
      setShowLabelingWizard: state.setShowLabelingWizard,
      labelingWizardStep: state.labelingWizardStep,
      setLabelingWizardStep: state.setLabelingWizardStep,
      labelingSessions: state.labelingSessions,
      setLabelingSessions: state.setLabelingSessions,
      labelingCredentials: state.labelingCredentials,
      setLabelingCredentials: state.setLabelingCredentials,
    })),
  );

/**
 * Demo policy is live state by design: delayed handlers must not rely on a render-time capture.
 * Non-demo projects and omitted config keys retain the existing default-enabled behavior.
 */
export function isDemoFeatureEnabled(feature: string): boolean {
  const { isDemo, demoFeatureConfig } = useSessionStore.getState();
  if (!isDemo) return true;
  if (!demoFeatureConfig) return true;
  return demoFeatureConfig[feature] !== false;
}
