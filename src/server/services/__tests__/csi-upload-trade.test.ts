/**
 * csi-upload-trade.test.ts — inferTradeFromCode FREEZE-FIRST trade-string pins.
 *
 * [refactor jul9 P2-A C1] Commit C0 of the CSI Option C1 server-half arc
 * (SPEC_FINAL §6.2-2, C2-F4). `inferTradeFromCode` was exported from
 * csi-upload.ts in this commit (one-line mechanical change) purely so these
 * baselines can pin its output directly.
 *
 * Pins the CURRENT (pre-C2) trade strings from csi-upload's local
 * DIVISION_TRADES table. Commit C2 replaces that table with the canonical
 * 25-division map (@/lib/csi-divisions), whose majority-rule wording drops
 * the " Protection" / " & Security" suffixes for Div 07 / Div 28 — those two
 * pins FLIP in C2 with the [C1 approval 2026-07-09] citation (ledger D-9).
 * Everything else here must survive C2 byte-identical.
 */
import { describe, it, expect } from "vitest";
import { inferTradeFromCode } from "@/server/services/csi-upload";

describe("inferTradeFromCode — trade-string baseline (pre-C2)", () => {
  it("Div 03 → Concrete (stable through C2)", () => {
    expect(inferTradeFromCode("03 30 00")).toEqual({
      trade: "Concrete",
      division: "03 00 00",
    });
  });

  it("Div 07 → 'Thermal & Moisture Protection' (C2 flips to 'Thermal & Moisture' — D-9)", () => {
    expect(inferTradeFromCode("07 21 00")).toEqual({
      trade: "Thermal & Moisture Protection",
      division: "07 00 00",
    });
  });

  it("Div 28 → 'Electronic Safety & Security' (C2 flips to 'Electronic Safety' — D-9)", () => {
    expect(inferTradeFromCode("28 31 00")).toEqual({
      trade: "Electronic Safety & Security",
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
