/**
 * rooms-detector.test.ts — [zones T2] the `rooms` detector's title-block exclusion for room numbers.
 *
 * Pins: with no YOLO in the context the legacy rule holds (word centre in the bottom 15 % is
 * excluded); with a detected `title_block` the detected box decides instead, so a room number in
 * the bottom band of a plan is kept and one inside a right-strip title block is dropped.
 */
import { describe, it, expect } from "vitest";
import { roomsDetector } from "@/lib/detectors/rooms";
import type { DetectorContext } from "@/lib/detectors/types";
import type { TextractWord } from "@/types";

const W = (text: string, x: number, y: number): TextractWord => ({ text, confidence: 90, bbox: [x, y, 0.03, 0.015] });

// 101 on the plan · 102 in the bottom 15 % band (plan area on this sheet) · 103 inside a right strip
const words = [W("101", 0.4, 0.5), W("102", 0.4, 0.9), W("103", 0.95, 0.5), W("LOBBY", 0.3, 0.3)];
const ctx = (yoloDetections?: DetectorContext["yoloDetections"]): DetectorContext =>
  ({ words, lines: [], csiCodes: [], yoloDetections });
const roomNumbers = (c: DetectorContext) =>
  roomsDetector.detect(c).filter((a) => a.type === "room-number").map((a) => a.text).sort();

describe("rooms detector — room-number title-block exclusion", () => {
  it("legacy (no YOLO in context): bottom 15 % band excluded, everything else kept", () => {
    expect(roomNumbers(ctx())).toEqual(["101", "103"]);
    expect(roomNumbers(ctx([]))).toEqual(["101", "103"]);
  });

  it("detected right-strip title block: the strip is excluded, the bottom band is kept", () => {
    const dets = [{ name: "title_block", minX: 0.9, minY: 0, maxX: 1, maxY: 1, confidence: 0.9 }];
    expect(roomNumbers(ctx(dets))).toEqual(["101", "102"]);
  });

  it("YOLO present but no title_block class ⇒ fixed fallback ⇒ legacy rule", () => {
    const dets = [{ name: "drawings", minX: 0.05, minY: 0.05, maxX: 0.85, maxY: 0.95, confidence: 0.8 }];
    expect(roomNumbers(ctx(dets))).toEqual(["101", "103"]);
  });

  it("other outputs are untouched by the zone rule", () => {
    // (the detector emits the single-word and sliding-window hit for LOBBY; the orchestrator dedups)
    const names = (c: DetectorContext) =>
      new Set(roomsDetector.detect(c).filter((a) => a.type === "room-name").map((a) => a.text));
    expect(names(ctx())).toEqual(new Set(["LOBBY"]));
    expect(names(ctx([{ name: "title_block", minX: 0.9, minY: 0, maxX: 1, maxY: 1, confidence: 0.9 }])))
      .toEqual(new Set(["LOBBY"]));
  });
});
