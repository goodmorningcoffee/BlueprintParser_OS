# `src/lib/oneclick/` — VENDORED THIRD-PARTY CODE

Everything in this directory is **adapted from OpenTakeoff** (https://github.com/Kentucky-ai/opentakeoff),
commit `70d10ce`, under the **Apache License 2.0** — a *different licence* to the rest of this
repository, which is non-commercial source-available.

Licence text: `LICENSES/Apache-2.0.txt` · Notices: `NOTICE`, `THIRD-PARTY-NOTICES.md`

---

## The rules, and why each exists

**1. All vendored code lives here. Never scatter it.**
Apache-2.0 compliance is per-file and auditable only if the boundary is one directory. The moment
vendored code is moved into an app module, "which files are third-party?" stops having a checkable
answer.

**2. Record every edit in the file's MODIFICATIONS list.**
That list *is* §4(b) compliance — the licence requires prominent notices stating that you changed
the files. A modification made without updating the list is a licence defect, not a style slip.

**3. Do not merge app code *into* these files.**
Adaptation happens at the boundary (`adapter.ts`), not inside the vendored bodies. That is what
keeps the drift check meaningful and the upstream diff readable.

**4. Say "adapted from OpenTakeoff, Apache-2.0" — not "inspired by".**
"Inspired by" would be inaccurate and would not discharge the attribution condition. It also
misstates the legal position: a close reimplementation is a derivative work anyway, and it would
forfeit the patent grant in Apache §3 that taking the code outright preserves.

---

## Vendor posture: FORK / FREEZE at `70d10ce`

Decision 8 of the rebuild plan, settled against version control rather than intent:

- all core `oneclick.ts` algorithm work landed in six days, 2026-07-05 → 07-11;
- its only change since is an MCP feature that does not touch the flood path;
- `rastermask.ts` has been untouched since 07-11;
- none of the last 20 upstream commits touch the flood engine.

**Re-verified 2026-07-26** by re-reading the tracker: issues #60 and #85 are both still open and
**nothing has landed on either vendored file.**

Surveillance is therefore a quarterly `git log`, not tracking machinery:

```bash
git log --oneline -- web/src/lib/oneclick.ts web/src/lib/rastermask.ts
```

`scripts/probes/oneclick-drift.mjs` automates the comparison. It is **informational only** — it
never merges, and a drift report is a prompt to make a decision, not an instruction to sync.

---

## What we deliberately did NOT take

Recorded so a future reader does not "restore" it:

- **their threading** — they flood on the React main thread; we keep worker isolation, timeouts,
  and the race-tested request protocol;
- **their tracer's hole story** — outer-contour-only with manual ⌥-click deducts; we keep BP2's
  automatic hole detection (12 behavioural tests defend it);
- **their persistence** — IndexedDB/localStorage with no server;
- **their `geometry.js` snap grid** — it declares itself byte-identical with a commercial product
  we have no copy of and cannot check. ~20 lines of grid hashing is not worth that entanglement,
  so `snapgrid.ts` is hand-rolled;
- **batch room detection without its guards** — on their own demo sheet, 25 of 26 "rooms" were
  label bubbles that passed every quality gate.

## What is known-limited about what we DID take

`notes/UPSTREAM_KNOWN_LIMITS.md` in the rebuild repo maps upstream's own seven documented ceilings
onto BP2's RC1–RC9 vocabulary. Two are worth knowing before touching this code:

- **the tuned constants are mask-pixel literals** calibrated on one sheet and one CAD style —
  which is why mask dim is pinned at 3000 and why changing it is a calibration decision;
- **hidden optional-content layers are traced** — pdf.js resolves visibility at paint time, so the
  operator list contains linework the user cannot see. Upstream's own words: *"Honor it or you will
  trace demolition."* Still unfixed upstream; guarded on our side by phase 2's routing guard.
