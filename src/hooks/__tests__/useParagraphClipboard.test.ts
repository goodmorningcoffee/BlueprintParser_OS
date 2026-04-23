import { describe, it, expect } from "vitest";
import { _testOnly_shouldIgnoreKeyEvent } from "../useParagraphClipboard";

describe("useParagraphClipboard focus-gate predicate", () => {
  it("ignores HTMLInputElement", () => {
    const el = document.createElement("input");
    expect(_testOnly_shouldIgnoreKeyEvent(el)).toBe(true);
  });

  it("ignores HTMLTextAreaElement", () => {
    const el = document.createElement("textarea");
    expect(_testOnly_shouldIgnoreKeyEvent(el)).toBe(true);
  });

  it("ignores contenteditable elements", () => {
    const el = document.createElement("div");
    el.contentEditable = "true";
    expect(_testOnly_shouldIgnoreKeyEvent(el)).toBe(true);
  });

  it("ignores elements inside [data-focus-ignore] wrapper", () => {
    const wrapper = document.createElement("div");
    wrapper.setAttribute("data-focus-ignore", "true");
    const inner = document.createElement("button");
    wrapper.appendChild(inner);
    document.body.appendChild(wrapper);
    expect(_testOnly_shouldIgnoreKeyEvent(inner)).toBe(true);
    document.body.removeChild(wrapper);
  });

  it("does NOT ignore plain buttons outside gated regions", () => {
    const el = document.createElement("button");
    expect(_testOnly_shouldIgnoreKeyEvent(el)).toBe(false);
  });

  it("does NOT ignore canvas elements", () => {
    const el = document.createElement("canvas");
    expect(_testOnly_shouldIgnoreKeyEvent(el)).toBe(false);
  });

  it("returns false for null target", () => {
    expect(_testOnly_shouldIgnoreKeyEvent(null)).toBe(false);
  });

  it("returns false for non-HTMLElement target", () => {
    const fakeText = { nodeType: 3 } as unknown as EventTarget;
    expect(_testOnly_shouldIgnoreKeyEvent(fakeText)).toBe(false);
  });
});
