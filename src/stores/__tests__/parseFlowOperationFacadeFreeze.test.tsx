// @vitest-environment jsdom
// [refactor jul12 P2.4 A2a] Narrow operation facade over per-kind parse ownership.

import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";

import { useParseFlow } from "@/hooks/useParseFlow";
import { commitParseOperation, useParseOperation } from "@/hooks/useParseOperation";
import { useParseFlowStore } from "@/stores/parseFlowStore";
import type {
  BeginParseOperationResult,
  ParseKind,
  ParseOperationToken,
} from "@/lib/parse-operation-state";
import type { BboxMinMax } from "@/types";

const BBOX = [0.1, 0.2, 0.7, 0.8] as BboxMinMax;
const ACTION_KEYS = ["begin", "isCurrent", "finish", "invalidate"] as const;

type OperationFacade<K extends ParseKind> = ReturnType<typeof useParseOperation<K>>;
type ExpectedOperationFacade<K extends ParseKind> = {
  kind: K;
  revision: number;
  busy: boolean;
  begin: (policy?: "reject" | "supersede") => BeginParseOperationResult<K>;
  isCurrent: (token: ParseOperationToken<K>) => boolean;
  finish: (token: ParseOperationToken<K>) => boolean;
  invalidate: () => void;
};

function expectStarted<K extends ParseKind>(
  result: BeginParseOperationResult<K>,
): ParseOperationToken<K> {
  expect(result.status).toBe("started");
  if (result.status !== "started") throw new Error("expected parse operation to start");
  return result.token;
}

function expectActionsStable<K extends ParseKind>(
  before: OperationFacade<K>,
  after: OperationFacade<K>,
): void {
  for (const key of ACTION_KEYS) expect(after[key], `retains ${key}`).toBe(before[key]);
}

beforeEach(() => {
  useParseFlowStore.setState(useParseFlowStore.getInitialState(), true);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("P2.4 A2a parse-operation facade type and shape contract", () => {
  it("keeps each hook token kind-specific and returns only the seven operation fields", () => {
    expectTypeOf<OperationFacade<"table">>()
      .toEqualTypeOf<ExpectedOperationFacade<"table">>();
    expectTypeOf<OperationFacade<"keynote">>()
      .toEqualTypeOf<ExpectedOperationFacade<"keynote">>();
    expectTypeOf<OperationFacade<"notes">>()
      .toEqualTypeOf<ExpectedOperationFacade<"notes">>();
    expectTypeOf<OperationFacade<"spec">>()
      .toEqualTypeOf<ExpectedOperationFacade<"spec">>();
    type TableStarted = Extract<
      ReturnType<OperationFacade<"table">["begin"]>,
      { status: "started" }
    >;
    expectTypeOf<TableStarted["token"]>().toEqualTypeOf<ParseOperationToken<"table">>();

    const { result } = renderHook(() => useParseOperation("table"));
    expect(Object.keys(result.current)).toEqual([
      "kind",
      "revision",
      "busy",
      "begin",
      "isCurrent",
      "finish",
      "invalidate",
    ]);
    expect(result.current).toMatchObject({
      kind: "table",
      revision: 0,
      busy: false,
      begin: expect.any(Function),
      isCurrent: expect.any(Function),
      finish: expect.any(Function),
      invalidate: expect.any(Function),
    });
  });
});

describe("P2.4 A2a parse-operation facade ownership and render contract", () => {
  it("shares one same-kind owner, rerenders both consumers once, and suppresses busy no-ops", () => {
    let rendersA = 0;
    let rendersB = 0;
    const consumerA = renderHook(() => {
      rendersA += 1;
      return useParseOperation("table");
    });
    const consumerB = renderHook(() => {
      rendersB += 1;
      return useParseOperation("table");
    });
    const initialA = consumerA.result.current;
    const initialB = consumerB.result.current;
    const baselineA = rendersA;
    const baselineB = rendersB;

    let token!: ParseOperationToken<"table">;
    act(() => {
      token = expectStarted(consumerA.result.current.begin());
    });
    expect(rendersA).toBe(baselineA + 1);
    expect(rendersB).toBe(baselineB + 1);
    expect(consumerA.result.current).toMatchObject({ revision: 1, busy: true });
    expect(consumerB.result.current).toMatchObject({ revision: 1, busy: true });
    expectActionsStable(initialA, consumerA.result.current);
    expectActionsStable(initialB, consumerB.result.current);
    expect(consumerB.result.current.isCurrent(token)).toBe(true);

    const beforeBusyA = rendersA;
    const beforeBusyB = rendersB;
    let busyResult!: BeginParseOperationResult<"table">;
    act(() => {
      busyResult = consumerB.result.current.begin();
    });
    expect(busyResult).toEqual({ status: "busy" });
    expect(rendersA).toBe(beforeBusyA);
    expect(rendersB).toBe(beforeBusyB);

    let finished = false;
    act(() => {
      finished = consumerB.result.current.finish(token);
    });
    expect(finished).toBe(true);
    expect(rendersA).toBe(beforeBusyA + 1);
    expect(rendersB).toBe(beforeBusyB + 1);
    expect(consumerA.result.current).toMatchObject({ revision: 1, busy: false });
    expect(consumerB.result.current).toMatchObject({ revision: 1, busy: false });
    expectActionsStable(initialA, consumerA.result.current);
    expectActionsStable(initialB, consumerB.result.current);
  });

  it("isolates operation, lifecycle, extension, and other-kind publications", () => {
    let operationRenders = 0;
    let lifecycleRenders = 0;
    const operation = renderHook(() => {
      operationRenders += 1;
      return useParseOperation("table");
    });
    const lifecycle = renderHook(() => {
      lifecycleRenders += 1;
      return useParseFlow("table");
    });
    expect(Object.keys(lifecycle.result.current)).toEqual([
      "kind",
      "step",
      "region",
      "setStep",
      "setRegion",
      "reset",
    ]);
    const initialOperation = operation.result.current;
    const initialLifecycle = lifecycle.result.current;
    const operationBaseline = operationRenders;
    const lifecycleBaseline = lifecycleRenders;

    act(() => {
      useParseFlowStore.getState().setTableParsedGrid({ headers: ["TAG"], rows: [] });
      useParseFlowStore.getState().setKeynoteParseRegion(BBOX);
      expectStarted(useParseFlowStore.getState().beginParseOperation("keynote"));
    });
    expect(operationRenders).toBe(operationBaseline);
    expect(lifecycleRenders).toBe(lifecycleBaseline);
    expect(operation.result.current).toBe(initialOperation);
    expect(lifecycle.result.current).toBe(initialLifecycle);

    let tableToken!: ParseOperationToken<"table">;
    act(() => {
      tableToken = expectStarted(operation.result.current.begin());
    });
    expect(operationRenders).toBe(operationBaseline + 1);
    expect(lifecycleRenders).toBe(lifecycleBaseline);
    expect(lifecycle.result.current).toBe(initialLifecycle);

    const afterBeginOperation = operation.result.current;
    act(() => useParseFlowStore.getState().setTableParseRegion(BBOX));
    expect(operationRenders).toBe(operationBaseline + 1);
    expect(operation.result.current).toBe(afterBeginOperation);
    expect(lifecycleRenders).toBe(lifecycleBaseline + 1);
    expect(lifecycle.result.current.region).toBe(BBOX);
    expect(operation.result.current.isCurrent(tableToken)).toBe(true);
  });

  it("keeps all bound actions stable through begin, supersede, invalidate, and finish", () => {
    const { result } = renderHook(() => useParseOperation("notes"));
    const initial = result.current;

    let tokenA!: ParseOperationToken<"notes">;
    act(() => {
      tokenA = expectStarted(result.current.begin());
    });
    expectActionsStable(initial, result.current);

    let tokenB!: ParseOperationToken<"notes">;
    act(() => {
      tokenB = expectStarted(result.current.begin("supersede"));
    });
    expectActionsStable(initial, result.current);
    expect(result.current.isCurrent(tokenA)).toBe(false);
    expect(result.current.isCurrent(tokenB)).toBe(true);

    act(() => result.current.invalidate());
    expect(result.current).toMatchObject({ revision: 3, busy: false });
    expectActionsStable(initial, result.current);

    let tokenC!: ParseOperationToken<"notes">;
    act(() => {
      tokenC = expectStarted(result.current.begin());
    });
    act(() => {
      expect(result.current.finish(tokenC)).toBe(true);
    });
    expectActionsStable(initial, result.current);
  });

  it("commits one synchronous tail only for the live busy token", () => {
    const { result } = renderHook(() => useParseOperation("spec"));
    const callback = vi.fn();
    let tokenA!: ParseOperationToken<"spec">;
    act(() => {
      tokenA = expectStarted(result.current.begin());
    });

    expect(commitParseOperation(tokenA, callback)).toBe(true);
    expect(callback).toHaveBeenCalledTimes(1);

    act(() => result.current.invalidate());
    expect(commitParseOperation(tokenA, callback)).toBe(false);
    expect(callback).toHaveBeenCalledTimes(1);

    let tokenB!: ParseOperationToken<"spec">;
    act(() => {
      tokenB = expectStarted(result.current.begin());
    });
    expect(commitParseOperation(tokenA, callback)).toBe(false);
    expect(commitParseOperation(tokenB, callback)).toBe(true);
    expect(callback).toHaveBeenCalledTimes(2);
  });

  it("switches one unconditional hook through exhaustive module-bound kind adapters", () => {
    const { result, rerender } = renderHook(
      ({ kind }: { kind: ParseKind }) => useParseOperation(kind),
      { initialProps: { kind: "table" as ParseKind } },
    );
    const tableActions = Object.fromEntries(
      ACTION_KEYS.map((key) => [key, result.current[key]]),
    );

    rerender({ kind: "spec" });
    expect(result.current).toMatchObject({ kind: "spec", revision: 0, busy: false });
    for (const key of ACTION_KEYS) {
      expect(result.current[key], `${key} is bound to Spec`).not.toBe(tableActions[key]);
    }
    let specToken!: ParseOperationToken<ParseKind>;
    act(() => {
      const started = result.current.begin();
      expect(started.status).toBe("started");
      if (started.status !== "started" || started.token.kind !== "spec") {
        throw new Error("expected the dynamic facade to dispatch to Spec");
      }
      specToken = started.token;
    });
    expect(specToken).toEqual({ kind: "spec", revision: 1 });
    expect(useParseFlowStore.getState().parseOperations.table).toEqual({
      revision: 0,
      busy: false,
    });

    rerender({ kind: "table" });
    expect(result.current).toMatchObject({ kind: "table", revision: 0, busy: false });
    for (const key of ACTION_KEYS) {
      expect(result.current[key], `${key} returns to its Table binding`).toBe(tableActions[key]);
    }
    act(() => {
      const started = result.current.begin();
      expect(started.status).toBe("started");
      if (started.status !== "started") throw new Error("expected Table operation to start");
      expect(started.token.kind).toBe("table");
    });
    expect(useParseFlowStore.getState().parseOperations.spec).toEqual({
      revision: 1,
      busy: true,
    });
  });
});
