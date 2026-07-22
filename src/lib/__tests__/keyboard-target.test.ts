// @vitest-environment jsdom
//
// [refactor jul22 P3.4 K3] Direct unit net for the shared editable-target predicate. The
// dispatcher and page-handler jsdom suites exercise the common paths; this file pins the
// fallback branches the tranche-close review found unwitnessed: the contenteditable="false"
// island override, plaintext-only, invalid attribute values, and non-HTMLElement targets.

import { describe, expect, it } from "vitest";

import { isEditableKeyboardTarget } from "@/lib/keyboard-target";

function div(attributes: Record<string, string> = {}): HTMLDivElement {
  const element = document.createElement("div");
  for (const [name, value] of Object.entries(attributes)) {
    element.setAttribute(name, value);
  }
  return element;
}

describe("isEditableKeyboardTarget", () => {
  it("accepts native text controls regardless of attributes", () => {
    expect(isEditableKeyboardTarget(document.createElement("input"))).toBe(true);
    expect(isEditableKeyboardTarget(document.createElement("textarea"))).toBe(true);
  });

  it("rejects non-editable and non-HTMLElement targets without throwing", () => {
    expect(isEditableKeyboardTarget(null)).toBe(false);
    expect(isEditableKeyboardTarget(window)).toBe(false);
    expect(isEditableKeyboardTarget(document)).toBe(false);
    expect(
      isEditableKeyboardTarget(document.createElementNS("http://www.w3.org/2000/svg", "svg")),
    ).toBe(false);
    expect(isEditableKeyboardTarget(document.createElement("button"))).toBe(false);
    expect(isEditableKeyboardTarget(div())).toBe(false);
  });

  it("honors the live isContentEditable flag before any attribute walk", () => {
    const element = div();
    Object.defineProperty(element, "isContentEditable", { configurable: true, value: true });
    expect(isEditableKeyboardTarget(element)).toBe(true);
  });

  it.each([
    ["", true],
    ["true", true],
    ["TRUE", true],
    ["  true  ", true],
    ["plaintext-only", true],
    ["false", false],
  ])("maps contenteditable=%j on the target itself to %s", (value, editable) => {
    expect(isEditableKeyboardTarget(div({ contenteditable: value }))).toBe(editable);
  });

  it("inherits editability from an ancestor through attribute-less descendants", () => {
    const root = div({ contenteditable: "true" });
    const child = div();
    const grandchild = div();
    root.appendChild(child);
    child.appendChild(grandchild);
    expect(isEditableKeyboardTarget(grandchild)).toBe(true);
  });

  it("respects a nearer contenteditable=false island inside an editable ancestor", () => {
    const root = div({ contenteditable: "true" });
    const island = div({ contenteditable: "false" });
    const inner = div();
    root.appendChild(island);
    island.appendChild(inner);
    expect(isEditableKeyboardTarget(inner)).toBe(false);
  });

  it("ignores invalid attribute values and keeps walking upward", () => {
    const root = div({ contenteditable: "plaintext-only" });
    const noise = div({ contenteditable: "banana" });
    const inner = div();
    root.appendChild(noise);
    noise.appendChild(inner);
    expect(isEditableKeyboardTarget(inner)).toBe(true);
  });

  it("stays non-editable when the walk exhausts undecorated ancestors", () => {
    const root = div();
    const inner = div();
    root.appendChild(inner);
    document.body.appendChild(root);
    try {
      expect(isEditableKeyboardTarget(inner)).toBe(false);
    } finally {
      root.remove();
    }
  });
});
