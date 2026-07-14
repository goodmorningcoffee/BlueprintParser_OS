// @vitest-environment node
// [refactor jul12 P2.4 A2e] Exact-generation Shape consumption at the Table command boundary.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import { useParseFlowStore } from "@/stores/parseFlowStore";
import { consumeTableParseRegionForShape } from "@/stores/viewerCommands";

type ParseRegion = [number, number, number, number];

function restoreStore(): void {
  useParseFlowStore.setState(useParseFlowStore.getInitialState(), true);
}

beforeEach(() => {
  restoreStore();
});

describe("Table region consumption for Shape", () => {
  it("adopts the rendered region locally only after the exact consume command succeeds", () => {
    const source = readFileSync(
      join(process.cwd(), "src/hooks/useShapeParseInteraction.ts"),
      "utf8",
    ).replace(/\s+/g, "");

    expect(source).toContain(
      "consttableRevision=useParseFlowStore((s)=>s.parseOperations.table.revision);",
    );
    // The command-level denial cases below prove stale/equal-by-value inputs return false. This
    // source pin closes the consumer half of that contract: a denied CAS must return before the
    // React-local region is adopted. The same captured drawing lifecycle must own both sides of
    // the synchronous shared-store publication because a subscriber can retire it reentrantly.
    expect(source).toContain(
      "constcanPublish=drawingAuthorityRef.current;" +
      "if(!canPublish?.())return;" +
      "if(!consumeTableParseRegionForShape(tableParseRegion,tableRevision))return;" +
      "if(!canPublish())return;" +
      "setRegion(tableParseRegionas[number,number,number,number]);",
    );
  });

  it("consumes only the exact region identity and exact rendered revision", () => {
    const region: ParseRegion = [0.1, 0.2, 0.8, 0.9];
    useParseFlowStore.setState({ tableParseRegion: region });
    const revision = useParseFlowStore.getState().parseOperations.table.revision;
    let publications = 0;
    const unsubscribe = useParseFlowStore.subscribe(() => {
      publications += 1;
    });

    expect(consumeTableParseRegionForShape(region, revision)).toBe(true);

    expect(publications).toBe(1);
    expect(useParseFlowStore.getState().tableParseRegion).toBeNull();
    expect(useParseFlowStore.getState().parseOperations.table).toEqual({
      revision: revision + 1,
      busy: false,
    });
    unsubscribe();
  });

  it("rejects equal-by-value replacement regions without publishing or signaling acceptance", () => {
    const currentRegion: ParseRegion = [0.1, 0.2, 0.8, 0.9];
    const staleRenderedRegion: ParseRegion = [0.1, 0.2, 0.8, 0.9];
    useParseFlowStore.setState({ tableParseRegion: currentRegion });
    const before = useParseFlowStore.getState();
    let publications = 0;
    const unsubscribe = useParseFlowStore.subscribe(() => {
      publications += 1;
    });

    expect(
      consumeTableParseRegionForShape(
        staleRenderedRegion,
        before.parseOperations.table.revision,
      ),
    ).toBe(false);

    expect(publications).toBe(0);
    expect(useParseFlowStore.getState()).toBe(before);
    expect(useParseFlowStore.getState().tableParseRegion).toBe(currentRegion);
    unsubscribe();
  });

  for (const settleReplacement of [false, true]) {
    it(`rejects a stale revision after a synchronous ${
      settleReplacement ? "settled" : "busy"
    } replacement without publishing or signaling acceptance`, () => {
      const region: ParseRegion = [0.1, 0.2, 0.8, 0.9];
      useParseFlowStore.setState({ tableParseRegion: region });
      const staleRevision = useParseFlowStore.getState().parseOperations.table.revision;
      const started = useParseFlowStore.getState().beginParseOperation("table");
      expect(started.status).toBe("started");
      if (started.status !== "started") return;
      if (settleReplacement) {
        expect(useParseFlowStore.getState().finishParseOperation(started.token)).toBe(true);
      }
      const before = useParseFlowStore.getState();
      let publications = 0;
      const unsubscribe = useParseFlowStore.subscribe(() => {
        publications += 1;
      });

      expect(consumeTableParseRegionForShape(region, staleRevision)).toBe(false);

      expect(publications).toBe(0);
      expect(useParseFlowStore.getState()).toBe(before);
      expect(useParseFlowStore.getState().tableParseRegion).toBe(region);
      expect(useParseFlowStore.getState().parseOperations.table).toEqual({
        revision: started.token.revision,
        busy: !settleReplacement,
      });
      unsubscribe();
    });
  }

  for (const settleReplacement of [false, true]) {
    it(`leaves a synchronous ${
      settleReplacement ? "settled" : "busy"
    } replacement intact after its terminal consumption publication`, () => {
      const region: ParseRegion = [0.1, 0.2, 0.8, 0.9];
      useParseFlowStore.setState({ tableParseRegion: region });
      const revision = useParseFlowStore.getState().parseOperations.table.revision;
      let replacementRevision: number | null = null;
      let firstPublication = true;
      const unsubscribe = useParseFlowStore.subscribe(() => {
        if (!firstPublication) return;
        firstPublication = false;
        const started = useParseFlowStore.getState().beginParseOperation("table");
        expect(started.status).toBe("started");
        if (started.status !== "started") return;
        replacementRevision = started.token.revision;
        if (settleReplacement) {
          expect(useParseFlowStore.getState().finishParseOperation(started.token)).toBe(true);
        }
      });

      expect(consumeTableParseRegionForShape(region, revision)).toBe(true);

      expect(replacementRevision).not.toBeNull();
      expect(useParseFlowStore.getState().tableParseRegion).toBeNull();
      expect(useParseFlowStore.getState().parseOperations.table).toEqual({
        revision: replacementRevision,
        busy: !settleReplacement,
      });
      unsubscribe();
    });
  }
});
