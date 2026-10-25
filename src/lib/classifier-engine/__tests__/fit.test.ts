// Step 4 weight fitter: the damped-Newton L2 logistic solver (separable, noisy, prior pull,
// determinism), re-scoring from stored features, fitRecipe's small-n refusal, threshold choice and
// proposed patch, verdict → sample mapping, and the overlay's head-qualified signal keys + detectBias.
import { describe, expect, it } from "vitest";
import { evaluateRecipe, scoreFeatures, type FitSample } from "../fit-score";
import { fitLogistic, fitRecipe, MIN_POSITIVES, overlayFromFits, samplesFromVerdicts } from "../fit";
import { applyOverlay, validateRecipe } from "../recipes";
import type { ClassifierRecipe, ProposalVerdict } from "../types";

/** Deterministic PRNG (mulberry32). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const sig = (id: string, weight: number, role: "score" | "required" | "veto" = "score") => ({ id, label: id, spec: { type: "sheet" }, weight, role, enabled: true });
const toy = (): ClassifierRecipe => validateRecipe({
  id: "toy.v1", name: "Toy", version: 3, target: "schedule", unit: "region", candidates: [{ type: "parsed-regions" }], scope: {},
  detect: { bias: -1, threshold: 0.5, signals: [sig("a", 1), sig("b", 1)] },
  classes: [
    { id: "door", name: "Door", group: "arch", bias: -2, signals: [sig("header", 2), sig("cols", 1)] },
    { id: "panel", name: "Panel", group: "elec", bias: -2, signals: [sig("header", 2), sig("cols", 1)] },
  ],
  nameThreshold: 0.5, minMargin: 0.05, fallbackClassName: "Other schedule",
}, "custom");

describe("fitLogistic", () => {
  it("separable data: finite weights, perfect split, converged", () => {
    const X = [[0], [0.1], [0.2], [0.8], [0.9], [1]];
    const y = [0, 0, 0, 1, 1, 1];
    const f = fitLogistic(X, y, { lambda: 0.01 });
    expect(f.converged).toBe(true);
    expect(Number.isFinite(f.weights[0])).toBe(true);
    for (let i = 0; i < X.length; i++) expect(f.bias + f.weights[0] * X[i][0] > 0).toBe(y[i] === 1);
  });

  it("noisy data: recovers the generating weights", () => {
    const r = rng(7);
    const X: number[][] = [];
    const y: number[] = [];
    for (let i = 0; i < 6000; i++) {
      const x = [r(), r()];
      const p = 1 / (1 + Math.exp(-(-0.5 + 2 * x[0] - 1.5 * x[1])));
      X.push(x); y.push(r() < p ? 1 : 0);
    }
    const f = fitLogistic(X, y, { lambda: 1e-3 });
    expect(f.bias).toBeCloseTo(-0.5, 0);
    expect(Math.abs(f.weights[0] - 2)).toBeLessThan(0.3);
    expect(Math.abs(f.weights[1] + 1.5)).toBeLessThan(0.3);
  });

  it("a strong penalty pulls toward the prior (the hand weights), not toward 0; an uninformative feature keeps its prior", () => {
    const X = [[1, 0], [0, 0], [1, 0], [0, 0]];
    const y = [1, 0, 1, 0];
    const strong = fitLogistic(X, y, { lambda: 1e6, prior: { bias: 0, weights: [-3, 5] } });
    expect(strong.weights[0]).toBeCloseTo(-3, 2);
    const weak = fitLogistic(X, y, { lambda: 0.1, prior: { bias: 0, weights: [-3, 5] } });
    expect(weak.weights[0]).toBeGreaterThan(0);
    expect(weak.weights[1]).toBeCloseTo(5, 6);
  });

  it("is deterministic and rejects bad input", () => {
    const r = rng(1);
    const X = Array.from({ length: 200 }, () => [r(), r(), r()]);
    const y = X.map((x) => (x[0] + r() * 0.5 > 0.7 ? 1 : 0));
    expect(fitLogistic(X, y, { lambda: 0.5 })).toEqual(fitLogistic(X, y, { lambda: 0.5 }));
    expect(() => fitLogistic(X, y, { lambda: 0 })).toThrow(/lambda/);
    expect(() => fitLogistic([[1], [1, 2]], [0, 1], { lambda: 1 })).toThrow(/ragged/);
  });
});

function corpus(n: number, seed: number): FitSample[] {
  const r = rng(seed);
  const out: FitSample[] = [];
  for (let i = 0; i < n; i++) {
    const isTarget = r() < 0.5;
    // "a" separates targets well; the hand weights trust "b" too, which is noise.
    const a = isTarget ? 0.6 + 0.4 * r() : 0.4 * r();
    const b = r();
    const cls = isTarget ? (r() < 0.5 ? "door" : "panel") : null;
    // door: header high, cols low; panel: header high, cols high. Hand weights can't tell them apart.
    const f: Record<string, number> = { "detect.a": a, "detect.b": b };
    f["door.header"] = cls ? 0.8 + 0.2 * r() : r();
    f["door.cols"] = cls === "panel" ? 0.8 + 0.2 * r() : 0.2 * r();
    f["panel.header"] = f["door.header"];
    f["panel.cols"] = f["door.cols"];
    out.push({ features: f, isTarget, classId: cls });
  }
  return out;
}

describe("fitRecipe", () => {
  it("refuses small n: every head keeps its hand weights and no patch is proposed", () => {
    const fit = fitRecipe(toy(), corpus(12, 3));
    expect(fit.report.detect.status).toBe("small-n");
    expect(fit.report.classes.every((c) => c.status === "small-n")).toBe(true);
    expect(fit.patch).toBeNull();
    expect(fit.fitted).toEqual(toy());
  });

  it("fits detect and naming, beats the hand weights in sample, and emits a qualified patch that applies", () => {
    const train = corpus(400, 11);
    const fit = fitRecipe(toy(), train, { lambda: 0.1 });
    const rep = fit.report;
    expect(rep.detect.status).toBe("fitted");
    expect(rep.classes.map((c) => c.status)).toEqual(["fitted", "fitted"]);
    expect(rep.inSample.fitted.detect.recall!).toBeGreaterThanOrEqual(rep.inSample.hand.detect.recall! - 1e-12);
    expect(rep.inSample.fitted.detect.precision!).toBeGreaterThanOrEqual(rep.inSample.hand.detect.precision!);
    expect(rep.inSample.fitted.naming.top1.ok).toBeGreaterThan(rep.inSample.hand.naming.top1.ok);
    expect(fit.patch).toMatchObject({ version: 4, detectBias: expect.any(Number), detectThreshold: expect.any(Number) });
    expect(Object.keys(fit.patch!.signals!).sort()).toEqual(["detect.a", "detect.b", "door.cols", "door.header", "panel.cols", "panel.header"]);
    // door must learn a NEGATIVE cols weight, panel a positive one — one shared bare key could not express that.
    expect(fit.patch!.signals!["door.cols"].weight!).toBeLessThan(fit.patch!.signals!["panel.cols"].weight!);
    const applied = applyOverlay([toy()], overlayFromFits([fit], "2026-10-24T00:00:00Z"))[0];
    expect(applied).toEqual(fit.fitted);
    // held out: the fitted recipe generalises
    const test = corpus(400, 99);
    expect(evaluateRecipe(fit.fitted, test).naming.top1.ok).toBeGreaterThan(evaluateRecipe(toy(), test).naming.top1.ok);
    // determinism
    expect(fitRecipe(toy(), train, { lambda: 0.1 })).toEqual(fit);
  });

  it("needs minPositives of each label; required / veto signals are never fitted", () => {
    const r = { ...toy(), detect: { ...toy().detect, signals: [sig("a", 1), sig("v", 1, "veto")] } } as ClassifierRecipe;
    const fit = fitRecipe(r, corpus(200, 5).map((s) => ({ ...s, features: { ...s.features, "detect.v": 0 } })), { lambda: 0.1 });
    expect(Object.keys(fit.report.detect.fitted!.weights)).toEqual(["detect.a"]);
    expect(MIN_POSITIVES).toBe(8);
  });
});

describe("scoreFeatures", () => {
  it("mirrors pickClass: highest p, threshold, margin, required rejection, fallback", () => {
    const r = toy();
    expect(scoreFeatures(r, { "detect.a": 1, "detect.b": 1, "door.header": 1, "door.cols": 1, "panel.header": 0, "panel.cols": 0 }))
      .toMatchObject({ detected: true, classId: "door", detectP: 0.731 });
    // tie → margin 0 < minMargin → fallback
    expect(scoreFeatures(r, { "door.header": 1, "panel.header": 1 }).classId).toBeNull();
    const req = { ...r, classes: [{ ...r.classes[0], signals: [...r.classes[0].signals, sig("must", 0, "required")] }, r.classes[1]] } as ClassifierRecipe;
    expect(scoreFeatures(req, { "door.header": 1, "door.cols": 1, "door.must": 0, "panel.header": 1, "panel.cols": 1 }).classId).toBe("panel");
  });
});

describe("samplesFromVerdicts", () => {
  const v = (verdict: ProposalVerdict["verdict"], extra: Partial<ProposalVerdict> = {}): ProposalVerdict => ({
    proposalId: "x", recipeId: "toy.v1", recipeVersion: 3, verdict, features: { "detect.a": 1 }, proposedClassId: "door", userId: 1, at: "t", ...extra,
  });
  it("accept → proposed class, rename → its class, reject → non-target; other-schedule / unknown → null; other recipes skipped", () => {
    const s = samplesFromVerdicts([
      v("accept"), v("rename", { classId: "panel" }), v("reject"), v("rename", { classId: "other-schedule" }),
      v("accept", { proposedClassId: null }), v("rename", { classId: "window" }), v("accept", { recipeId: "other" }),
    ], toy());
    expect(s.map((x) => [x.isTarget, x.classId])).toEqual([[true, "door"], [true, "panel"], [false, null], [true, null], [true, null], [true, null]]);
  });
});

describe("overlay signal keys", () => {
  it("a head-qualified key wins over the bare id and touches only its head; detectBias replaces the detect bias", () => {
    // [fix round] baseVersion = the built-in's version: a patch saved against an older (or unrecorded) built-in keeps the built-in's detect head
    const out = applyOverlay([toy()], { custom: [], patches: { "toy.v1": { version: 4, baseVersion: 3, detectBias: 0.25, signals: { header: { weight: 7 }, "door.header": { weight: 9 }, "detect.a": { weight: 3 } } } } })[0];
    expect(out.detect.bias).toBe(0.25);
    expect(out.detect.signals.find((s) => s.id === "a")!.weight).toBe(3);
    expect(out.classes[0].signals.find((s) => s.id === "header")!.weight).toBe(9);
    expect(out.classes[1].signals.find((s) => s.id === "header")!.weight).toBe(7);
    const stale = applyOverlay([toy()], { custom: [], patches: { "toy.v1": { version: 4, detectBias: 0.25, signals: { "door.header": { weight: 9 }, "detect.a": { weight: 3 } } } } })[0];
    expect(stale.detect.bias).toBe(toy().detect.bias);
    expect(stale.detect.signals.find((s) => s.id === "a")!.weight).toBe(toy().detect.signals.find((s) => s.id === "a")!.weight);
    expect(stale.classes[0].signals.find((s) => s.id === "header")!.weight).toBe(9);
  });
});
