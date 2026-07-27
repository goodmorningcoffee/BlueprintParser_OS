/**
 * pdf-optional-content.ts — does this page paint linework the user CANNOT SEE?
 *
 * ── ★★ THE PORT'S SINGLE REGRESSION RISK, IN ONE SENTENCE ───────────────────────────────
 * pdf.js resolves Optional Content Groups (CAD layers) **at paint time**. The operator list it
 * hands us therefore contains the linework of layers that are switched OFF, and the vendored
 * extractor — like upstream's — does not read marked-content operators. So a hidden
 * `A-WALL-DEMO` layer running through a room becomes a wall the flood cannot cross, and the tool
 * returns a confidently wrong half-room: status `ok`, no warning, number commits.
 *
 * MEASURED on our own `hidden-ocg` fixture: the vector path returned **70,814 pt² — exactly 50%**
 * of a 142,100 pt² room, while the legacy raster path got it right at 98%, because the hidden layer
 * was never painted onto the canvas it reads. This is the one case where the port is strictly
 * WORSE than what it replaces. Upstream's own issue #85 describes it in their words — *"honor
 * visibility or you will trace demolition"* — and it is still open.
 *
 * Until the real fix lands (a marked-content visibility stack inside the extractor, a named
 * vendored MODIFICATION scheduled for phase 3 or 5), the guard is: **detect it, and route the page
 * to raster.** Raster is correct here precisely because it reads painted pixels.
 *
 * ── PER-PAGE, WHICH IS A DELIBERATE REFINEMENT OF PLAN §4.4 ─────────────────────────────
 * PLAN says "if the DOCUMENT's default OC config has any non-visible group, mark the page
 * `ocUnsafe`". This detects per PAGE instead, and that is strictly more accurate rather than
 * merely cheaper: a hidden layer whose operators never appear in *this* page's op list cannot
 * affect *this* page's geometry, so demoting the page would forfeit the vector path for nothing.
 * The two agree exactly when it matters — when hidden linework is actually present to be traced.
 *
 * The representation was MEASURED, not assumed, while building the corpus census:
 *     argsArray[i] === ["OC", { type: "OCG", id: "5R" }]
 * and validated against a known answer — the `ocg.pdf` fixture reports hidden, with 2 segments,
 * confirming visibility is not being honoured.
 */

/** The slice of pdf.js's `OptionalContentConfig` we need. Structural, so tests need no pdf.js. */
export interface OptionalContentConfigLike {
  /** `false` means the group is switched off. Anything else is treated as visible. */
  isVisible(group: unknown): boolean | undefined;
  /** Present on pdf.js's config; used only to skip the scan when a document has no groups. */
  getGroups?: () => Record<string, unknown> | null | undefined;
}

/**
 * The slice of an operator list we need.
 *
 * `argsArray` is typed structurally rather than as pdf.js's own `any[]`: `any` here would need an
 * eslint suppression AND would move the repo's `as-any` guardrail counter, both for a value this
 * function only ever reads two positions of. pdf.js's `any[]` remains assignable to it.
 */
export interface OpListLike {
  fnArray: ArrayLike<number>;
  argsArray: ArrayLike<readonly unknown[] | null | undefined>;
}

/**
 * Does this page reference at least one optional-content group that is NOT visible?
 *
 * Returns `false` for every "cannot tell" case — no config, no groups, an unreadable ref. That is
 * deliberate: this predicate DEMOTES a page to raster, so a false positive silently forfeits the
 * vector path on a page that was fine. `undefined` from `isVisible` is treated as visible for the
 * same reason; only an explicit `false` counts.
 *
 * ⚠ The asymmetry is worth stating because it looks backwards. Elsewhere in this rebuild we fail
 * closed. Here the "safe" direction is already the fallback, so failing closed on uncertainty would
 * mean routing whole documents to raster because one group reference did not parse.
 */
export function pageHasHiddenOptionalContent(
  opList: OpListLike,
  config: OptionalContentConfigLike | null | undefined,
  beginMarkedContentPropsOp: number,
): boolean {
  if (!config) return false;

  // A document with no groups at all cannot hide anything, and this is the common case — skip the
  // whole scan rather than walking a 71,819-op list to learn nothing.
  if (typeof config.getGroups === "function") {
    const groups = config.getGroups();
    if (!groups || Object.keys(groups).length === 0) return false;
  }

  const { fnArray, argsArray } = opList;
  const seen = new Set<string>();
  for (let i = 0; i < fnArray.length; i++) {
    if (fnArray[i] !== beginMarkedContentPropsOp) continue;
    const args = argsArray[i];
    if (!args || args[0] !== "OC" || !args[1]) continue;

    const ref = args[1];
    // Dedupe: a real sheet re-enters the same layer thousands of times, and `isVisible` is not
    // free. On the VA plan this turns tens of thousands of lookups into a handful.
    const key =
      typeof ref === "object" && ref !== null
        ? `${(ref as { type?: string }).type}:${(ref as { id?: string }).id ?? JSON.stringify(ref)}`
        : String(ref);
    if (seen.has(key)) continue;
    seen.add(key);

    try {
      if (config.isVisible(ref) === false) return true;
    } catch {
      // An unresolvable OC reference is not evidence of a hidden layer. See the note above.
    }
  }
  return false;
}
