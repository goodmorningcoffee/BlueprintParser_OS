// @vitest-environment node
// [table pipeline WP-2.F, K58] Parse-hint semantics: every "Parse this table" sets a hint that carries the
// proposalId; `rowSource` only for "Accept with tags"; the request hints carry the proposalId; ANY matching
// hint is consumed by the parse that uses it; a hint never leaks to another region, page or project.
import { beforeEach, describe, expect, it } from "vitest";
import { consumeTableParseHints, tableParseRequestHints, useTableParseHintStore, type TableParseHint } from "@/stores/tableParseHintStore";

const BOX: [number, number, number, number] = [0.1, 0.2, 0.5, 0.6];
const OTHER: [number, number, number, number] = [0.6, 0.6, 0.9, 0.9];
const plain: TableParseHint = { publicId: "pub-1", pageNumber: 2, bbox: BOX, proposalId: "prop-1" };
const withTags: TableParseHint = { ...plain, rowSource: "shape-centres" };

beforeEach(() => useTableParseHintStore.setState({ hint: null }));

describe("tableParseHintStore (K58)", () => {
  it("a plain parse carries the proposalId and keeps the default row source", () => {
    useTableParseHintStore.getState().setHint(plain);
    expect(tableParseRequestHints("pub-1", 2, BOX)).toEqual({ proposalId: "prop-1" });
    expect("rowSource" in tableParseRequestHints("pub-1", 2, BOX)).toBe(false);
  });

  it("with tags carries both", () => {
    useTableParseHintStore.getState().setHint(withTags);
    expect(tableParseRequestHints("pub-1", 2, BOX)).toEqual({ rowSource: "shape-centres", proposalId: "prop-1" });
  });

  it("a proposalId-only hint is consumed by the parse that uses it (clear on ANY match)", () => {
    useTableParseHintStore.getState().setHint(plain);
    expect(consumeTableParseHints("pub-1", 2, [BOX])).toEqual([{ proposalId: "prop-1" }]);
    expect(useTableParseHintStore.getState().hint).toBeNull();
    expect(consumeTableParseHints("pub-1", 2, [BOX])).toEqual([{}]); // a later parse of that region runs plain
  });

  it("no leak: a second region of the same run gets nothing; another region, page or project leaves the hint", () => {
    useTableParseHintStore.getState().setHint(plain);
    expect(consumeTableParseHints("pub-1", 2, [OTHER])).toEqual([{}]);
    expect(consumeTableParseHints("pub-1", 3, [BOX])).toEqual([{}]);
    expect(consumeTableParseHints("pub-2", 2, [BOX])).toEqual([{}]);
    expect(useTableParseHintStore.getState().hint).toEqual(plain);
    expect(consumeTableParseHints("pub-1", 2, [BOX, OTHER])).toEqual([{ proposalId: "prop-1" }, {}]);
    expect(useTableParseHintStore.getState().hint).toBeNull();
  });
});
