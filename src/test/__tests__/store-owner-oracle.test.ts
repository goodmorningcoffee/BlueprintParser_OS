// @vitest-environment node

import { describe, expect, it } from "vitest";
import {
  formatStoreOwnerFinding,
  scanStoreOwnerText,
  type StoreOwnerScanResult,
} from "@/test/store-owner-oracle";

const OWNER = {
  moduleName: "@/stores/viewerStore",
  exportName: "useViewerStore",
  members: [
    "alpha",
    "beta",
    "gamma",
    "delta",
    "epsilon",
    "zeta",
  ],
} as const;

function signatures(result: StoreOwnerScanResult): string[] {
  return result.findings.map(formatStoreOwnerFinding);
}

describe("store owner oracle — import, selector, and snapshot self-calibration", () => {
  it("follows named/namespace imports, casts, aliases, assignments, useShallow, and named selectors", () => {
    const result = scanStoreOwnerText("fixture.tsx", `
      import { useViewerStore as importedStore } from "@/stores/viewerStore";
      import * as StoreNamespace from "@/stores/viewerStore";

      const storeExport = "useViewerStore";
      const computedAlpha = "alpha";
      const storeAlias = importedStore as any;
      let namespaceAlias: any;
      namespaceAlias = StoreNamespace;
      let assignedStore: any;
      assignedStore = namespaceAlias[storeExport] as any;
      const { useViewerStore: destructuredStore } = StoreNamespace;

      const selectAlpha = (state: any) => state.alpha;
      function selectBeta(state: any) {
        const stateAlias = state as any;
        return stateAlias["beta"];
      }
      let assignedSelector: any;
      assignedSelector = (state: any) => state[computedAlpha];

      storeAlias(({ gamma }: any) => gamma);
      storeAlias(useShallow(selectAlpha));
      StoreNamespace[storeExport](selectBeta);
      destructuredStore((state: any) => state.delta);
      assignedStore(assignedSelector);
    `, OWNER);

    expect(signatures(result)).toEqual(expect.arrayContaining([
      "selector:read:known:gamma",
      "selector:read:known:alpha",
      "selector:read:known:beta",
      "selector:read:known:delta",
    ]));
    expect(result.uncertain).toEqual([]);
  });

  it("resolves every direct selector in a local registry while rejecting unresolved registry access", () => {
    const resolved = scanStoreOwnerText("fixture.tsx", `
      import { useViewerStore as importedStore } from "@/stores/viewerStore";
      declare const kind: "table" | "notes";

      const selectors = {
        table: (state: any) => ({ alpha: state.alpha, beta: state.beta }),
        notes: function notesSelector(state: any) { return state.gamma; },
      } satisfies Record<typeof kind, (state: any) => unknown>;
      const selectorAlias = selectors;
      const selected = kind === "table" ? selectors.table : selectors.notes;

      importedStore(useShallow(selected));
      importedStore(selectorAlias["table"]);
      importedStore(selectors.notes);
    `, OWNER);

    expect(signatures(resolved)).toEqual(expect.arrayContaining([
      "selector:read:known:alpha",
      "selector:read:known:beta",
      "selector:read:known:gamma",
    ]));
    expect(resolved.uncertain).toEqual([]);

    const unresolved = scanStoreOwnerText("fixture.tsx", `
      import { useViewerStore as importedStore } from "@/stores/viewerStore";
      declare const kind: string;
      declare const external: Record<string, (state: any) => unknown>;
      const selectors = { table: (state: any) => state.alpha };
      const cleanRegistry = { table: (state: any) => state.beta };
      const spreadRegistry = { ...selectors };

      importedStore(selectors["missing"]);
      importedStore(cleanRegistry[kind]);
      importedStore(spreadRegistry[kind]);
      importedStore(external[kind]);
    `, OWNER);

    expect(unresolved.uncertain.map(formatStoreOwnerFinding)).toEqual([
      "selector:read:opaque:*",
      "selector:read:opaque:*",
      "selector:read:opaque:*",
      "selector:read:opaque:*",
    ]);
    expect(unresolved.uncertain.map((finding) => finding.detail)).toEqual([
      "selector could not be resolved locally",
      "selector could not be resolved locally",
      "selector could not be resolved locally",
      "selector could not be resolved locally",
    ]);
    expect(signatures(unresolved)).toContain("selector:read:known:beta");
  });

  it("finds whole hooks, getState/getInitialState aliases, destructuring, brackets, assignments, and Proxy snapshots", () => {
    const result = scanStoreOwnerText("fixture.tsx", `
      import { useViewerStore as importedStore } from "@/stores/viewerStore";
      const computed = "beta";

      const whole = (importedStore as any)();
      whole.alpha;
      const { gamma: wholeGamma } = whole;

      let getter: any;
      getter = importedStore["getState"];
      let snapshot: any;
      snapshot = getter() as any;
      snapshot[computed];
      const { delta: renamedDelta } = snapshot;

      const { getInitialState: initialGetter } = importedStore;
      const initial = initialGetter();
      initial.epsilon;

      const proxy = new Proxy(snapshot, {});
      let assignedProxy: any;
      assignedProxy = proxy;
      assignedProxy["zeta"];
    `, OWNER);

    expect(signatures(result)).toEqual(expect.arrayContaining([
      "wholeHook:broad:broad:*",
      "wholeHook:read:known:alpha",
      "wholeHook:read:known:gamma",
      "getState:read:known:beta",
      "getState:read:known:delta",
      "getInitialState:read:known:epsilon",
      "getState:read:known:zeta",
    ]));
    expect(result.uncertain.map(formatStoreOwnerFinding)).toEqual([
      "wholeHook:broad:broad:*",
    ]);
  });
});

describe("store owner oracle — setState resolution and fail-closed findings", () => {
  it("resolves direct/local/assigned patch aliases, updater aliases, nested spreads, and updater reads", () => {
    const result = scanStoreOwnerText("fixture.ts", `
      import { useViewerStore as importedStore } from "@/stores/viewerStore";
      const set = importedStore.setState;

      const first = { alpha: 1 };
      const second = { ...first, beta: 2 };
      let assignedPatch: any;
      assignedPatch = { gamma: 3 };
      set(second);
      set(assignedPatch);

      const updater = (state: any) => ({
        delta: state.alpha,
        ...{ epsilon: 5 },
      });
      set(updater);

      function namedUpdater(state: any) {
        return { zeta: state.beta };
      }
      let updaterAlias: any;
      updaterAlias = namedUpdater;
      set(updaterAlias);
    `, OWNER);

    expect(signatures(result)).toEqual(expect.arrayContaining([
      "setState:write:known:alpha",
      "setState:write:known:beta",
      "setState:write:known:gamma",
      "setState:write:known:delta",
      "setState:write:known:epsilon",
      "setState:write:known:zeta",
      "setState:read:known:alpha",
      "setState:read:known:beta",
    ]));
    expect(result.uncertain).toEqual([]);
  });

  it("reports dynamic keys, opaque selectors/patches/spreads, broad selectors, and rest snapshots instead of skipping them", () => {
    const result = scanStoreOwnerText("fixture.tsx", `
      import { useViewerStore as importedStore } from "@/stores/viewerStore";
      declare const dynamicKey: string;
      declare const externalSelector: (state: any) => unknown;
      declare function makePatch(): Record<string, unknown>;

      importedStore(externalSelector);
      importedStore((state: any) => state);

      const snapshot = importedStore.getState();
      snapshot[dynamicKey];
      const { alpha, ...rest } = snapshot;

      const setter = importedStore["setState"];
      setter({ [dynamicKey]: true });
      setter(makePatch());
      setter({ ...makePatch() });
    `, OWNER);

    expect(signatures(result)).toEqual(expect.arrayContaining([
      "selector:read:opaque:*",
      "selector:broad:broad:*",
      "getState:read:dynamic:*",
      "getState:read:known:alpha",
      "getState:read:opaque:*",
      "setState:write:dynamic:*",
      "setState:write:opaque:*",
    ]));
    expect(result.uncertain.length).toBeGreaterThanOrEqual(6);
    expect(result.uncertain.every((finding) => finding.member === null)).toBe(true);
  });

  it("handles destructured and assignment-aliased owner methods", () => {
    const result = scanStoreOwnerText("fixture.ts", `
      import * as StoreNamespace from "@/stores/viewerStore";
      const exportName = "useViewerStore";
      const store = StoreNamespace[exportName];
      let setter: any;
      ({ setState: setter } = store);
      const key = "epsilon";
      const patch = { [key]: 1 };
      setter(patch);
    `, OWNER);

    expect(signatures(result)).toContain("setState:write:known:epsilon");
    expect(result.uncertain).toEqual([]);
  });

  it("follows bind-derived setState and does not call a fully resolved non-ledger spread opaque", () => {
    const result = scanStoreOwnerText("fixture.ts", `
      import { useViewerStore as importedStore } from "@/stores/viewerStore";
      const residualOnly = { allTrades: ["Electrical"] };
      const boundSetter = importedStore.setState.bind(null);
      boundSetter({ ...residualOnly, alpha: 1 });
      importedStore.setState.bind(importedStore)({ ...residualOnly, beta: 2 });
      boundSetter({ ...residualOnly });
    `, OWNER);

    expect(signatures(result)).toEqual(expect.arrayContaining([
      "setState:write:known:alpha",
      "setState:write:known:beta",
    ]));
    expect(result.uncertain).toEqual([]);
  });
});

describe("store owner oracle — single-argument subscribe listener classification", () => {
  it("allows resolvable listeners that ignore state or read only non-ledger residual members", () => {
    const result = scanStoreOwnerText("fixture.ts", `
      import { useViewerStore as importedStore } from "@/stores/viewerStore";
      const trace: unknown[] = [];

      importedStore.subscribe(() => trace.push("inline ignored"));
      importedStore.subscribe((_state: any) => trace.push("declared state ignored"));
      function ignoredNamed() { trace.push("named ignored"); }
      importedStore.subscribe(ignoredNamed);
      importedStore.subscribe((state: any) => trace.push(state.allTrades));
      const residualDestructure = ({ activeQtoWorkflow }: any) => activeQtoWorkflow;
      importedStore.subscribe(residualDestructure);
      importedStore.subscribe((_state: any, previousState: any) =>
        trace.push(previousState.allCsiCodes));
    `, OWNER);

    expect(signatures(result)).toEqual([]);
    expect(result.uncertain).toEqual([]);
  });

  it("preserves known findings from current state, previous state, and destructured listeners", () => {
    const result = scanStoreOwnerText("fixture.ts", `
      import { useViewerStore as importedStore } from "@/stores/viewerStore";

      importedStore.subscribe((state: any, previousState: any) => [
        state.alpha,
        previousState.beta,
      ]);
      importedStore.subscribe(({ gamma }: any, { delta }: any) => gamma + delta);
    `, OWNER);

    expect(signatures(result)).toEqual([
      "subscribe:read:known:alpha",
      "subscribe:read:known:beta",
      "subscribe:read:known:gamma",
      "subscribe:read:known:delta",
    ]);
    expect(result.uncertain).toEqual([]);
  });

  it("keeps an unresolved listener opaque without inventing a blanket broad read", () => {
    const result = scanStoreOwnerText("fixture.ts", `
      import { useViewerStore as importedStore } from "@/stores/viewerStore";
      declare const externalListener: (state: unknown, previousState: unknown) => void;
      importedStore.subscribe(externalListener);
    `, OWNER);

    expect(signatures(result)).toEqual(["subscribe:read:opaque:*"]);
    expect(result.uncertain[0]?.detail).toBe(
      "subscribe callback/selector could not be resolved locally",
    );
  });

  it("keeps subscribeWithSelector's first callback under selector-style fail-closed rules", () => {
    const result = scanStoreOwnerText("fixture.ts", `
      import { useViewerStore as importedStore } from "@/stores/viewerStore";
      importedStore.subscribe(() => "constant", () => {});
    `, OWNER);

    expect(signatures(result)).toEqual(["subscribe:read:opaque:*"]);
    expect(result.uncertain[0]?.detail).toBe("state callback has no parameter");
  });

  it("fails closed when either listener state is passed, returned, spread, or retained whole", () => {
    const result = scanStoreOwnerText("fixture.ts", `
      import { useViewerStore as importedStore } from "@/stores/viewerStore";
      declare function consume(value: unknown): void;

      importedStore.subscribe((state: any) => consume(state));
      importedStore.subscribe((state: any) => state);
      importedStore.subscribe((state: any) => ({ ...state }));
      importedStore.subscribe(function returnWhole(state: any) { return state; });
      importedStore.subscribe((state: any) => ({ retained: state }));
      importedStore.subscribe((_state: any, previousState: any) => consume(previousState));
    `, OWNER);

    expect(result.known).toEqual([]);
    expect(signatures(result)).toEqual([
      "subscribe:read:opaque:*",
      "subscribe:broad:broad:*",
      "subscribe:read:broad:*",
      "subscribe:broad:broad:*",
      "subscribe:read:opaque:*",
      "subscribe:read:opaque:*",
    ]);
    expect(result.uncertain.map((finding) => finding.detail)).toEqual([
      "state is passed to an opaque helper",
      "callback returns the whole state",
      "spreading the state observes every member",
      "callback returns the whole state",
      "state escapes through an object property",
      "state is passed to an opaque helper",
    ]);
  });
});

describe("store owner oracle — provenance escape hardening", () => {
  it("taints identity/Proxy-derived stores and reports calls, returns, spreads, and dynamic namespace exports", () => {
    const result = scanStoreOwnerText("fixture.tsx", `
      import { useViewerStore as importedStore } from "@/stores/viewerStore";
      import * as StoreNamespace from "@/stores/viewerStore";
      declare const dynamicExport: string;
      declare function identity<T>(value: T): T;
      declare function consume(value: unknown): void;

      const wrappedStore = identity(importedStore);
      wrappedStore.getState().alpha;
      const proxiedStore = new Proxy(importedStore, {});
      proxiedStore((state: any) => state.beta);
      consume(importedStore);
      function exposeStore() { return importedStore; }
      const exposeStoreExpression = () => importedStore;
      const copiedStore = { ...importedStore };

      const dynamicStore = StoreNamespace[dynamicExport];
      dynamicStore((state: any) => state.gamma);
    `, OWNER);

    expect(signatures(result)).toEqual(expect.arrayContaining([
      "getState:read:known:alpha",
      "selector:read:known:beta",
      "selector:read:known:gamma",
      "wholeHook:broad:opaque:*",
      "wholeHook:broad:dynamic:*",
    ]));
    expect(result.uncertain.filter((finding) => finding.certainty === "opaque").length)
      .toBeGreaterThanOrEqual(5);
    expect(result.uncertain.some((finding) =>
      finding.detail?.includes("dynamic owner namespace export"))).toBe(true);
  });

  it("reports bare snapshots and selector state crossing opaque call/return/spread boundaries", () => {
    const result = scanStoreOwnerText("fixture.tsx", `
      import { useViewerStore as importedStore } from "@/stores/viewerStore";
      declare function consume(value: unknown): void;
      declare function pick(value: unknown): unknown;

      const snapshot = importedStore.getState();
      consume(snapshot);
      function exposeSnapshot() { return snapshot; }
      const exposeSnapshotExpression = () => snapshot;
      const copiedSnapshot = { ...snapshot };
      const retainedSnapshot = { snapshot };

      importedStore((state: any) => pick(state));
    `, OWNER);

    expect(signatures(result)).toEqual(expect.arrayContaining([
      "getState:read:opaque:*",
      "getState:broad:broad:*",
      "selector:read:opaque:*",
    ]));
    expect(result.uncertain.some((finding) =>
      finding.detail === "state is passed to an opaque helper")).toBe(true);
    expect(result.uncertain.filter((finding) => finding.operation === "getState").length)
      .toBeGreaterThanOrEqual(5);
  });
});
