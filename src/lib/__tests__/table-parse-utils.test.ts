import { describe, it, expect } from "vitest";
import { escCsv } from "@/lib/table-parse-utils";

describe("escCsv", () => {
  it("returns plain text unchanged", () => {
    expect(escCsv("hello")).toBe("hello");
  });

  it("wraps text with commas in quotes", () => {
    expect(escCsv("hello, world")).toBe('"hello, world"');
  });

  it("escapes double quotes by doubling them", () => {
    expect(escCsv('say "hi"')).toBe('"say ""hi"""');
  });

  it("wraps text with newlines in quotes", () => {
    expect(escCsv("line1\nline2")).toBe('"line1\nline2"');
  });

  it("handles empty string", () => {
    expect(escCsv("")).toBe("");
  });

  it("handles text with all special characters", () => {
    expect(escCsv('a,b\n"c"')).toBe('"a,b\n""c"""');
  });
});
