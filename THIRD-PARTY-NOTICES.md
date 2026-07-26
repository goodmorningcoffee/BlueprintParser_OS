# Third-party notices

Components in this repository that are **not** covered by BlueprintParser's own LICENSE, with
where their licence text lives and what was changed.

> ⚠ BlueprintParser's own LICENSE is a **non-commercial source-available** licence. It does not
> and cannot govern the third-party code listed here, which is distributed under its own terms.
> A §5 carve-out sentence naming that distinction is an owner-only edit to LICENSE and is
> tracked as decision 2 of the bucket-fill rebuild plan. **It has not been made yet.**

---

## OpenTakeoff — vendored source

| | |
|---|---|
| **Upstream** | https://github.com/Kentucky-ai/opentakeoff |
| **Commit** | `70d10ce` (pinned 2026-07-25) |
| **Licence** | Apache License 2.0 — `LICENSES/Apache-2.0.txt` |
| **Copyright** | Copyright 2026 Kentucky AI and the OpenTakeoff contributors |
| **Vendored** | 2026-07-26 |

### Files

| vendored path | upstream path | upstream LOC |
|---|---|---|
| `src/lib/oneclick/oneclick.ts` | `web/src/lib/oneclick.ts` | 655 |
| `src/lib/oneclick/rastermask.ts` | `web/src/lib/rastermask.ts` | 160 |

### Modifications

Per Apache-2.0 §4(b), every change to a vendored file is recorded in a **MODIFICATIONS** list at
the head of that file. That list is the compliance artifact; this table is a summary.

| file | modifications |
|---|---|
| `oneclick.ts` | none yet — vendored verbatim |
| `rastermask.ts` | none yet — vendored verbatim |

### Attribution

Where this work is described in product documentation, the accurate phrasing is
**"adapted from OpenTakeoff, Apache-2.0"** — not "inspired by". A close reimplementation would be
a derivative work regardless, and would additionally forfeit the patent grant in Apache §3.

### Not covered by this grant

OpenTakeoff's demo drawing (`demo/sample-finish-plan.pdf`) is a third party's document — a
stripped federal solicitation set — not OpenTakeoff's code. **It is deliberately not in this
repository.** It is used as an out-of-tree, SHA-256-pinned test fixture
(`53aa2a44efc8f9a2e625ed223fcfbf9ee19d15eb8469ba57183874b6a8e2a56f`, 1,176,246 bytes) and the
harness fails loudly when it is absent rather than silently substituting a thinner fixture.

---

## Mozilla pdf.js — vendored build artifact

| | |
|---|---|
| **Upstream** | https://github.com/mozilla/pdf.js |
| **Licence** | Apache License 2.0 — `LICENSES/Apache-2.0.txt` |
| **Copyright** | Copyright Mozilla Foundation and contributors |
| **File** | `public/pdf.worker.min.mjs` — redistributed **unmodified** |

This is a pre-existing dependency that predates the bucket-fill work; the notice is added here
because this repository previously had no `NOTICE` file at all.

The `pdfjs-dist` npm package is also Apache-2.0 and is declared in `package.json` rather than
vendored, so it is covered by the usual npm dependency provenance rather than by this file.

---

## Everything else

Runtime and build dependencies are declared in `package.json` and carry their own licences in
`node_modules/*/LICENSE`. This file covers only code that is **vendored into the repository** or
**redistributed as a build artifact**.
