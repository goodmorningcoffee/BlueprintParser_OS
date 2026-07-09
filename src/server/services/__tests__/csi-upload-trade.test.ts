/**
 * csi-upload-trade.test.ts — inferTradeFromCode trade-string pins.
 *
 * [refactor jul9 P2-A C1] Written as FREEZE-FIRST baselines in commit C0
 * (SPEC_FINAL §6.2-2, C2-F4; `inferTradeFromCode` exported for exactly this).
 *
 * RE-PINNED in commit C2 [C1 approval 2026-07-09]: csi-upload's local
 * DIVISION_TRADES table was replaced by the canonical 25-division map
 * (@/lib/csi-divisions), whose majority-rule wording drops the
 * " Protection" / " & Security" suffixes for Div 07 / Div 28 (ledger D-9 —
 * affects FUTURE uploads' stored TSVs only; past uploads immutable in S3).
 * Everything else survived C2 byte-identical.
 */
import { describe, it, expect } from "vitest";
import { inferTradeFromCode } from "@/server/services/csi-upload";

describe("inferTradeFromCode — trade-string pins (canonical map, post-C2)", () => {
  it("Div 03 → Concrete (stable through C2)", () => {
    expect(inferTradeFromCode("03 30 00")).toEqual({
      trade: "Concrete",
      division: "03 00 00",
    });
  });

  it("Div 07 → 'Thermal & Moisture' (C2 re-pin — was '… Protection') [C1 approval 2026-07-09, D-9]", () => {
    expect(inferTradeFromCode("07 21 00")).toEqual({
      trade: "Thermal & Moisture",
      division: "07 00 00",
    });
  });

  it("Div 28 → 'Electronic Safety' (C2 re-pin — was '… & Security') [C1 approval 2026-07-09, D-9]", () => {
    expect(inferTradeFromCode("28 31 00")).toEqual({
      trade: "Electronic Safety",
      division: "28 00 00",
    });
  });

  it("unknown division falls back to 'Division NN' (stable through C2)", () => {
    expect(inferTradeFromCode("99 99 99")).toEqual({
      trade: "Division 99",
      division: "99 00 00",
    });
  });

  it("strips whitespace before extracting the division (code with/without spaces agree)", () => {
    expect(inferTradeFromCode("033000")).toEqual(inferTradeFromCode("03 30 00"));
  });
});
