// [TP-1 WP-1.C, K64] CSV exports neutralise spreadsheet formulas.
import { describe, expect, it } from "vitest";
import { csvQuotedSafe, escCsvSafe, neutraliseCsvFormula } from "@/lib/csv-safe";
import { escCsv } from "@/lib/table-parse-utils";

describe("neutraliseCsvFormula", () => {
  it.each(["=1+1", "+1+1", "-1+1", "@SUM(A1)", "\t=1+1", "\r=1+1", "=HYPERLINK(\"x\")", "--x", "+"])(
    "prefixes an apostrophe to %j",
    (val) => {
      expect(neutraliseCsvFormula(val)).toBe(`'${val}`);
    },
  );

  it.each(["", "door", "1+1", " =1+1", "-5", "+0.25", "-1,200", "-.5", "-", "---", "A-1"])("leaves %j unchanged", (val) => {
    expect(neutraliseCsvFormula(val)).toBe(val);
  });
});

describe("escCsvSafe", () => {
  it("exports =1+1 as '=1+1", () => {
    expect(escCsvSafe("=1+1")).toBe("'=1+1");
  });

  it("neutralises first, then quotes", () => {
    expect(escCsvSafe('=A1,"x"')).toBe('"\'=A1,""x"""');
    expect(escCsvSafe("a\r\nb")).toBe('"a\r\nb"');
  });

  it("is what escCsv (table and Auto-QTO exports) now uses", () => {
    expect(escCsv("=1+1")).toBe("'=1+1");
    expect(escCsv("@cmd")).toBe("'@cmd");
    expect(escCsv("hello, world")).toBe('"hello, world"');
  });
});

describe("csvQuotedSafe (takeoff export)", () => {
  it("always quotes, doubles quotes and neutralises", () => {
    expect(csvQuotedSafe("Room 1")).toBe('"Room 1"');
    expect(csvQuotedSafe('say "hi"')).toBe('"say ""hi"""');
    expect(csvQuotedSafe("=1+1")).toBe('"\'=1+1"');
    expect(csvQuotedSafe("")).toBe('""');
  });
});
