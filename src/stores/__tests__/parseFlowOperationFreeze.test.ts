// @vitest-environment node
// [refactor jul12 P2.4 A2a] Per-kind async-operation ownership in the sole parse owner.

import { beforeEach, describe, expect, expectTypeOf, it } from "vitest";

import {
  useParseFlowStore,
  type ParseFlowState,
} from "@/stores/parseFlowStore";
import type {
  BeginParseOperationResult,
  ParseKind,
  ParseOperationRegistry,
  ParseOperationStatus,
  ParseOperationToken,
} from "@/lib/parse-operation-state";
import {
  createParseOperationRegistry,
  invalidateParseOperationKinds,
} from "@/lib/parse-operation-state";

const PARSE_KINDS = ["table", "keynote", "notes", "spec"] as const satisfies readonly ParseKind[];

type OperationSurface = Pick<
  ParseFlowState,
  | "parseOperations"
  | "beginParseOperation"
  | "isParseOperationCurrent"
  | "finishParseOperation"
  | "invalidateParseOperation"
>;

type ExpectedOperationSurface = {
  parseOperations: ParseOperationRegistry;
  beginParseOperation: <K extends ParseKind>(
    kind: K,
    policy?: "reject" | "supersede",
  ) => BeginParseOperationResult<K>;
  isParseOperationCurrent: (token: ParseOperationToken<ParseKind>) => boolean;
  finishParseOperation: (token: ParseOperationToken<ParseKind>) => boolean;
  invalidateParseOperation: (kind: ParseKind) => void;
};

function expectStarted<K extends ParseKind>(
  result: BeginParseOperationResult<K>,
): ParseOperationToken<K> {
  expect(result.status).toBe("started");
  if (result.status !== "started") throw new Error("expected parse operation to start");
  return result.token;
}

function resetKind(kind: ParseKind): void {
  const state = useParseFlowStore.getState();
  if (kind === "table") state.resetTableParse();
  else if (kind === "keynote") state.resetKeynoteParse();
  else if (kind === "notes") state.resetNotesParse();
  else state.resetSpecParse();
}

beforeEach(() => {
  useParseFlowStore.setState(useParseFlowStore.getInitialState(), true);
});

describe("P2.4 A2a parse-operation state and type contract", () => {
  it("adds the exact four-kind registry and owner action surface at revision zero", () => {
    expectTypeOf<ParseKind>().toEqualTypeOf<"table" | "keynote" | "notes" | "spec">();
    expectTypeOf<ParseOperationStatus>()
      .toEqualTypeOf<Readonly<{ revision: number; busy: boolean }>>();
    expectTypeOf<ParseOperationRegistry>()
      .toEqualTypeOf<Readonly<Record<ParseKind, ParseOperationStatus>>>();
    expectTypeOf<OperationSurface>().toEqualTypeOf<ExpectedOperationSurface>();
    expectTypeOf<ParseOperationToken<"table">>()
      .toEqualTypeOf<Readonly<{ kind: "table"; revision: number }>>();

    const registry = useParseFlowStore.getState().parseOperations;
    expect(registry).toEqual({
      table: { revision: 0, busy: false },
      keynote: { revision: 0, busy: false },
      notes: { revision: 0, busy: false },
      spec: { revision: 0, busy: false },
    });
    expect(new Set(Object.values(registry))).toHaveLength(4);
  });

  it.each(PARSE_KINDS)(
    "%s: atomically owns A, invalidates it through the kind reset, and denies its late finish",
    (kind) => {
      const publications: ParseOperationStatus[] = [];
      const unsubscribe = useParseFlowStore.subscribe((state) => {
        publications.push(state.parseOperations[kind]);
      });
      const initial = useParseFlowStore.getState();
      const initialRegistry = initial.parseOperations;

      const tokenA = expectStarted(initial.beginParseOperation(kind));
      expect(tokenA).toEqual({ kind, revision: 1 });
      expect(publications).toEqual([{ revision: 1, busy: true }]);
      expect(useParseFlowStore.getState().parseOperations[kind]).toEqual({
        revision: 1,
        busy: true,
      });
      for (const otherKind of PARSE_KINDS) {
        if (otherKind === kind) continue;
        expect(useParseFlowStore.getState().parseOperations[otherKind]).toBe(
          initialRegistry[otherKind],
        );
      }

      publications.length = 0;
      const beforeReject = useParseFlowStore.getState();
      expect(beforeReject.beginParseOperation(kind)).toEqual({ status: "busy" });
      expect(useParseFlowStore.getState()).toBe(beforeReject);
      expect(publications).toEqual([]);

      publications.length = 0;
      const beforeResetRegistry = useParseFlowStore.getState().parseOperations;
      resetKind(kind);
      const afterReset = useParseFlowStore.getState();
      expect(publications).toEqual([{ revision: 2, busy: false }]);
      expect(afterReset.parseOperations[kind]).toEqual({ revision: 2, busy: false });
      expect(afterReset.isParseOperationCurrent(tokenA)).toBe(false);
      for (const otherKind of PARSE_KINDS) {
        if (otherKind === kind) continue;
        expect(afterReset.parseOperations[otherKind]).toBe(beforeResetRegistry[otherKind]);
      }

      publications.length = 0;
      const tokenB = expectStarted(afterReset.beginParseOperation(kind));
      expect(tokenB).toEqual({ kind, revision: 3 });
      expect(publications).toEqual([{ revision: 3, busy: true }]);
      expect(useParseFlowStore.getState().isParseOperationCurrent(tokenB)).toBe(true);

      publications.length = 0;
      const beforeStaleFinish = useParseFlowStore.getState();
      expect(beforeStaleFinish.finishParseOperation(tokenA)).toBe(false);
      expect(useParseFlowStore.getState()).toBe(beforeStaleFinish);
      expect(publications).toEqual([]);
      expect(useParseFlowStore.getState().parseOperations[kind]).toEqual({
        revision: 3,
        busy: true,
      });

      expect(useParseFlowStore.getState().finishParseOperation(tokenB)).toBe(true);
      expect(publications).toEqual([{ revision: 3, busy: false }]);
      expect(useParseFlowStore.getState().isParseOperationCurrent(tokenB)).toBe(false);

      publications.length = 0;
      const beforeRepeatedFinish = useParseFlowStore.getState();
      expect(beforeRepeatedFinish.finishParseOperation(tokenB)).toBe(false);
      expect(useParseFlowStore.getState()).toBe(beforeRepeatedFinish);
      expect(publications).toEqual([]);
      unsubscribe();
    },
  );

  it("supersedes one busy owner atomically while reject remains a reference-preserving no-op", () => {
    const observed: ParseOperationStatus[] = [];
    const unsubscribe = useParseFlowStore.subscribe((state) => {
      observed.push(state.parseOperations.table);
    });
    const tokenA = expectStarted(
      useParseFlowStore.getState().beginParseOperation("table", "reject"),
    );

    observed.length = 0;
    const beforeReject = useParseFlowStore.getState();
    expect(beforeReject.beginParseOperation("table", "reject")).toEqual({ status: "busy" });
    expect(useParseFlowStore.getState()).toBe(beforeReject);
    expect(observed).toEqual([]);

    const tokenB = expectStarted(
      useParseFlowStore.getState().beginParseOperation("table", "supersede"),
    );
    expect(tokenB).toEqual({ kind: "table", revision: 2 });
    expect(observed).toEqual([{ revision: 2, busy: true }]);
    expect(useParseFlowStore.getState().isParseOperationCurrent(tokenA)).toBe(false);
    expect(useParseFlowStore.getState().isParseOperationCurrent(tokenB)).toBe(true);

    observed.length = 0;
    const beforeStaleFinish = useParseFlowStore.getState();
    expect(beforeStaleFinish.finishParseOperation(tokenA)).toBe(false);
    expect(useParseFlowStore.getState()).toBe(beforeStaleFinish);
    expect(observed).toEqual([]);
    expect(useParseFlowStore.getState().parseOperations.table).toEqual({
      revision: 2,
      busy: true,
    });
    unsubscribe();
  });

  it("invalidates monotonically from busy and idle while preserving every other status identity", () => {
    const token = expectStarted(useParseFlowStore.getState().beginParseOperation("notes"));
    const beforeBusyInvalidation = useParseFlowStore.getState().parseOperations;
    const observed: ParseOperationStatus[] = [];
    const unsubscribe = useParseFlowStore.subscribe((state) => {
      observed.push(state.parseOperations.notes);
    });

    useParseFlowStore.getState().invalidateParseOperation("notes");
    expect(observed).toEqual([{ revision: 2, busy: false }]);
    expect(useParseFlowStore.getState().isParseOperationCurrent(token)).toBe(false);
    for (const otherKind of PARSE_KINDS) {
      if (otherKind === "notes") continue;
      expect(useParseFlowStore.getState().parseOperations[otherKind]).toBe(
        beforeBusyInvalidation[otherKind],
      );
    }

    observed.length = 0;
    const beforeIdleInvalidation = useParseFlowStore.getState().parseOperations;
    useParseFlowStore.getState().invalidateParseOperation("notes");
    expect(observed).toEqual([{ revision: 3, busy: false }]);
    for (const otherKind of PARSE_KINDS) {
      if (otherKind === "notes") continue;
      expect(useParseFlowStore.getState().parseOperations[otherKind]).toBe(
        beforeIdleInvalidation[otherKind],
      );
    }
    unsubscribe();
  });

  it("deduplicates pure multi-kind invalidation and preserves an empty transform by identity", () => {
    const initial = createParseOperationRegistry();
    const empty = invalidateParseOperationKinds(initial, []);
    expect(empty).toBe(initial);

    const next = invalidateParseOperationKinds(initial, [
      "table",
      "table",
      "keynote",
      "table",
      "keynote",
    ]);
    expect(next).not.toBe(initial);
    expect(next.table).toEqual({ revision: 1, busy: false });
    expect(next.keynote).toEqual({ revision: 1, busy: false });
    expect(next.notes).toBe(initial.notes);
    expect(next.spec).toBe(initial.spec);
  });

  it("allows all four kinds to own work concurrently and finishes exactly one kind", () => {
    const tokens = Object.fromEntries(PARSE_KINDS.map((kind) => [
      kind,
      expectStarted(useParseFlowStore.getState().beginParseOperation(kind)),
    ])) as { [K in ParseKind]: ParseOperationToken<K> };

    expect(useParseFlowStore.getState().parseOperations).toEqual({
      table: { revision: 1, busy: true },
      keynote: { revision: 1, busy: true },
      notes: { revision: 1, busy: true },
      spec: { revision: 1, busy: true },
    });
    for (const kind of PARSE_KINDS) {
      expect(useParseFlowStore.getState().isParseOperationCurrent(tokens[kind])).toBe(true);
    }

    const beforeFinish = useParseFlowStore.getState().parseOperations;
    expect(useParseFlowStore.getState().finishParseOperation(tokens.notes)).toBe(true);
    expect(useParseFlowStore.getState().parseOperations.notes).toEqual({
      revision: 1,
      busy: false,
    });
    for (const otherKind of ["table", "keynote", "spec"] as const) {
      expect(useParseFlowStore.getState().parseOperations[otherKind]).toBe(beforeFinish[otherKind]);
      expect(useParseFlowStore.getState().parseOperations[otherKind].busy).toBe(true);
    }
  });

  it("looks up runtime tokens by kind as well as revision and never publishes for a wrong slot", () => {
    const tableToken = expectStarted(
      useParseFlowStore.getState().beginParseOperation("table"),
    );
    useParseFlowStore.getState().invalidateParseOperation("keynote");
    const keynoteToken = expectStarted(
      useParseFlowStore.getState().beginParseOperation("keynote"),
    );
    expect(tableToken.revision).toBe(1);
    expect(keynoteToken.revision).toBe(2);

    const forgedWrongSlot: ParseOperationToken<"keynote"> = {
      kind: "keynote",
      revision: tableToken.revision,
    };
    const before = useParseFlowStore.getState();
    let publications = 0;
    const unsubscribe = useParseFlowStore.subscribe(() => {
      publications += 1;
    });
    expect(before.isParseOperationCurrent(forgedWrongSlot)).toBe(false);
    expect(before.finishParseOperation(forgedWrongSlot)).toBe(false);
    expect(useParseFlowStore.getState()).toBe(before);
    expect(publications).toBe(0);
    expect(useParseFlowStore.getState().isParseOperationCurrent(tableToken)).toBe(true);
    expect(useParseFlowStore.getState().isParseOperationCurrent(keynoteToken)).toBe(true);
    unsubscribe();
  });

  it("project reset invalidates every kind monotonically in its single parse publication", () => {
    useParseFlowStore.getState().invalidateParseOperation("keynote");
    useParseFlowStore.getState().invalidateParseOperation("spec");
    useParseFlowStore.getState().invalidateParseOperation("spec");
    for (const kind of PARSE_KINDS) {
      expectStarted(useParseFlowStore.getState().beginParseOperation(kind));
    }
    expect(useParseFlowStore.getState().parseOperations).toEqual({
      table: { revision: 1, busy: true },
      keynote: { revision: 2, busy: true },
      notes: { revision: 1, busy: true },
      spec: { revision: 3, busy: true },
    });

    const observed: ParseOperationRegistry[] = [];
    const unsubscribe = useParseFlowStore.subscribe((state) => {
      observed.push(state.parseOperations);
    });
    const beforeReset = useParseFlowStore.getState().parseOperations;
    useParseFlowStore.getState().resetProjectParseState();
    expect(observed).toEqual([{
      table: { revision: 2, busy: false },
      keynote: { revision: 3, busy: false },
      notes: { revision: 2, busy: false },
      spec: { revision: 4, busy: false },
    }]);
    for (const kind of PARSE_KINDS) {
      expect(useParseFlowStore.getState().parseOperations[kind]).not.toBe(beforeReset[kind]);
    }

    useParseFlowStore.getState().resetProjectParseState();
    expect(observed).toHaveLength(2);
    expect(observed[1]).toEqual({
      table: { revision: 3, busy: false },
      keynote: { revision: 4, busy: false },
      notes: { revision: 3, busy: false },
      spec: { revision: 5, busy: false },
    });
    unsubscribe();
  });
});
