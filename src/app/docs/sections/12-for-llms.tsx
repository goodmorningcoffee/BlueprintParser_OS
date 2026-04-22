import { Section } from "../_components/Section";
import { SubSection } from "../_components/SubSection";
import { Figure } from "../_components/Figure";
import { InlineCode } from "../_components/InlineCode";
import { Callout } from "../_components/Callout";
import { CodeBlock } from "../_components/CodeBlock";
import { TableEl } from "../_components/TableEl";
import { LlmGlossaryCards } from "../_components/demos/LlmGlossaryCards";
import { StoreSliceHookMap } from "../_components/demos/StoreSliceHookMap";
import { PostProcessingFlowDiagram } from "../_components/demos/PostProcessingFlowDiagram";

export function Section12ForLlms() {
  return (
    <Section id="for-llms" eyebrow="Meta" title="How BP Works — for LLMs">
      <p className="text-[16px]">
        This section is written for a language model reading the BP codebase
        cold. It packs the shape of the system, the construction vocabulary,
        the load-bearing file paths, and the known traps into one place. If
        you&apos;re a human reader you can still use it &mdash; it&apos;s just
        unusually dense because the target reader has a large context window.
      </p>

      <Callout variant="info" title="Grep anchors">
        Every subsection has an <InlineCode>[LLM-NAV:slug]</InlineCode> anchor
        near its heading so you can jump in from a grep. For the full,
        file:line-grade navigation manual, the companion doc is{" "}
        <InlineCode>featureRoadMap/BPArchitecture_422.md</InlineCode> &mdash;
        this section is the client-readable summary of that doc.
      </Callout>

      <SubSection title="Canonical mental model (read this first)">
        <p>
          <InlineCode>[LLM-NAV:mental-model]</InlineCode>
        </p>
        <p>
          <strong>BlueprintParser is a graph builder for construction PDFs.</strong>{" "}
          It turns a multi-page drawing set into two data axes:
        </p>
        <ul className="list-disc pl-5 space-y-1 text-[13px]">
          <li>
            <strong>Horizontal (per page)</strong> &mdash; each page carries
            OCR, CSI codes, text annotations, detected tables, a classification,
            and (optionally) YOLO detections. Stored on the{" "}
            <InlineCode>pages</InlineCode> row with a large{" "}
            <InlineCode>pageIntelligence</InlineCode> JSONB.
          </li>
          <li>
            <strong>Vertical (project-wide)</strong> &mdash;{" "}
            <InlineCode>annotations</InlineCode> (YOLO + user markups + takeoff),{" "}
            <InlineCode>takeoff_items</InlineCode> (count / area / linear),{" "}
            <InlineCode>yolo_tags</InlineCode> (schedule tag &harr; shape
            instance), and <InlineCode>projectIntelligence</InlineCode> (the
            project-level summary: disciplines, CSI network graph, hub pages).
          </li>
        </ul>
        <p>
          Everything downstream &mdash; the LLM chat, the viewer, takeoff, the
          CSI spatial heatmap, Auto-QTO &mdash; reads from those two shapes.
          The fastest way to get oriented in the code is: read{" "}
          <InlineCode>src/lib/db/schema.ts</InlineCode>,{" "}
          <InlineCode>src/types/index.ts</InlineCode>, and{" "}
          <InlineCode>src/lib/processing.ts#processProject()</InlineCode>.
        </p>
      </SubSection>

      <SubSection title="Construction glossary">
        <p>
          <InlineCode>[LLM-NAV:glossary]</InlineCode>
        </p>
        <p>
          BP&apos;s code uses construction-industry terms unapologetically. A
          model that doesn&apos;t know these will miscalibrate what the code
          is doing. Each card below gives the plain-English definition and
          the BP surface it appears in.
        </p>
        <LlmGlossaryCards />
      </SubSection>

      <SubSection title="File:line landmarks (the 20 that matter most)">
        <p>
          <InlineCode>[LLM-NAV:landmarks]</InlineCode>
        </p>
        <TableEl
          headers={["Symbol", "File:line", "Why it matters"]}
          rows={[
            [<InlineCode key="a1">processProject</InlineCode>, "src/lib/processing.ts:165-605", "Auto pipeline entry. 14 per-page stages + project rollup."],
            [<InlineCode key="a2">mapConcurrent</InlineCode>, "src/lib/processing.ts:35-52", "Worker-pool concurrency limit. Default 8."],
            [<InlineCode key="a3">analyzePageImageWithFallback</InlineCode>, "src/lib/textract.ts:~315", "3-tier OCR fallback: full Textract → half-res → Tesseract."],
            [<InlineCode key="a4">detectCsiCodes</InlineCode>, "src/lib/csi-detect.ts", "3-tier matcher. Returns CsiCode[] with trade + division + confidence."],
            [<InlineCode key="a5">findOccurrences</InlineCode>, "src/lib/tag-mapping/find-occurrences.ts:171", "Tag-mapping entry. Dispatches to 5 matcher types + composes scores."],
            [<InlineCode key="a6">processFill</InlineCode>, "src/workers/bucket-fill.worker.ts:453", "8-stage flood-fill pipeline. Text is a wall."],
            [<InlineCode key="a7">computeRealArea</InlineCode>, "src/lib/areaCalc.ts", "Shoelace → calibrated sqft. Truth for area takeoffs."],
            [<InlineCode key="a8">streamChatWithTools</InlineCode>, "src/lib/llm/anthropic.ts:85-169", "Agentic tool-use loop. maxRounds=10."],
            [<InlineCode key="a9">BP_TOOLS</InlineCode>, "src/lib/llm/tools-defs.ts", "20 tool definitions. Client-safe (no db/fs)."],
            [<InlineCode key="a10">executeToolCall</InlineCode>, "src/lib/llm/tools.ts", "Server-side tool executors. Full db + fs access."],
            [<InlineCode key="a11">canvasWantsEvents</InlineCode>, "src/components/viewer/AnnotationOverlay.tsx:2510", "Render-gate condition #1. Also touch L2521, L2550, L2554."],
            [<InlineCode key="a12">useViewerStore</InlineCode>, "src/stores/viewerStore.ts:609", "Zustand store. 17 slice hooks, L1675 onward."],
            [<InlineCode key="a13">resetAllTools</InlineCode>, "src/stores/viewerStore.ts", "Canonical tool reset. Compose into when adding a new tool."],
            [<InlineCode key="a14">focusAnnotationId</InlineCode>, "src/stores/viewerStore.ts", "One-shot signal. Read-and-clear pattern."],
            [<InlineCode key="a15">assembleContextWithConfig</InlineCode>, "src/lib/context-builder.ts", "LLM prompt assembly. Priority-sorted section packing."],
            [<InlineCode key="a16">ALL_DETECTORS</InlineCode>, "src/lib/detectors/registry.ts:21", "10 text-annotation detectors. Add here + wire to enable config."],
            [<InlineCode key="a17">QTO_STRICT_EXCLUSION_CLASSES</InlineCode>, "src/components/viewer/AutoQtoTab.tsx:52", "tables, title_block, drawings. Required for Auto-QTO."],
            [<InlineCode key="a18">startYoloJob</InlineCode>, "src/lib/yolo.ts", "SageMaker Processing job launch. Only caller: POST /api/yolo/run."],
            [<InlineCode key="a19">resolveConfig</InlineCode>, "src/lib/llm/resolve.ts", "Per-company LLM provider + model + key lookup."],
            [<InlineCode key="a20">buildCsiGraph</InlineCode>, "src/lib/csi-graph.ts (~430 LOC)", "Project-level CSI relationship graph. fingerprinted cache key."],
          ]}
        />
      </SubSection>

      <SubSection title="The 17 Zustand slice hooks">
        <p>
          <InlineCode>[LLM-NAV:store-slices]</InlineCode>
        </p>
        <p>
          Every panel, every toolbar button, every canvas overlay reads from
          one of these slices. Subscribing at the slice level &mdash; rather
          than with a raw <InlineCode>useViewerStore(s =&gt; s.field)</InlineCode>{" "}
          &mdash; is how the 1,986-line store doesn&apos;t cause cascading
          re-renders. If you&apos;re adding UI that needs state from the
          store, check this map for the existing slice before creating a new one.
        </p>
        <Figure
          kind="live"
          caption="17 slice hooks fan out from useViewerStore. Line numbers are from the current viewerStore.ts."
          size="full"
        >
          <StoreSliceHookMap />
        </Figure>
      </SubSection>

      <SubSection title="The 20 LLM tools — when to call each">
        <p>
          <InlineCode>[LLM-NAV:tool-selection]</InlineCode>
        </p>
        <p>
          Section 9 has the full tool grid. This subsection is the{" "}
          <em>selection heuristic</em>: given a user question, which tool
          should an LLM call first?
        </p>
        <TableEl
          headers={["User asks about…", "First tool to reach for", "Reasoning"]}
          rows={[
            ["Project overview / disciplines", <InlineCode key="t1">getProjectOverview</InlineCode>, "One call, returns cluster summary. Always cheaper than scanning pages."],
            ["A specific page", <InlineCode key="t2">getPageDetails(pageNumber)</InlineCode>, "Structured summary first, then raw OCR only if needed."],
            ["Pages containing Division X", <InlineCode key="t3">lookupPagesByIndex({"{"}index:\"csi\", key:\"X\"{"}"})</InlineCode>, "O(1). Don't iterate every page."],
            ["Cross-references / hub pages", <InlineCode key="t4">getCrossReferences</InlineCode>, "Returns edges and ranked hubs from the graph."],
            ["Text location on a page", <InlineCode key="t5">searchPages / getOcrTextInRegion</InlineCode>, "Search is ts_vector; in-region is bbox-scoped OCR."],
            ["Parsed schedules", <InlineCode key="t6">getParsedSchedule(pageNumber)</InlineCode>, "Headers + rows, already structured. Don't re-parse from OCR."],
            ["Spatial layout of a page", <InlineCode key="t7">getCsiSpatialMap / getSpatialContext</InlineCode>, "9×9 heatmap + YOLO-joined text."],
            ["YOLO detections", <InlineCode key="t8">getAnnotations({"{"}source:\"yolo\"{"}"})</InlineCode>, "Filter-based, returns bboxes + classes + confidence."],
            ["Tag instances across project", <InlineCode key="t9">mapTagsToPages</InlineCode>, "Bridges schedule rows to drawing shapes. Cached per tag list."],
            ["CSI code for arbitrary text", <InlineCode key="t10">detectCsiFromText(text)</InlineCode>, "Runs the 3-tier matcher on input you provide."],
            ["Jump the viewer to page X", <InlineCode key="t11">navigateToPage({"{"}pageNumber{"}"})</InlineCode>, "Side-effecting action. The user sees it happen."],
            ["Highlight a region", <InlineCode key="t12">highlightRegion</InlineCode>, "Cyan pulse on canvas. Drives attention."],
            ["Persist a new annotation", <InlineCode key="t13">createMarkup</InlineCode>, "Mutation. Writes to the annotations table."],
          ]}
        />
      </SubSection>

      <SubSection title="Signal valve state — what BP does NOT do yet">
        <p>
          <InlineCode>[LLM-NAV:signal-valves]</InlineCode>
        </p>
        <Callout variant="warn" title="Don't overpromise on tag mapping fidelity">
          The tag-mapping scoring system has two signals hardcoded to zero and
          one hardcoded to <InlineCode>true</InlineCode> as of 2026-04-22.
          These are reserved for the future Discrepancy Engine; matchers have
          not been wired to populate them yet.
        </Callout>
        <CodeBlock lang="ts" caption="src/lib/tag-mapping/find-occurrences.ts:131, 141-142">
{`// :131 — windowMatch hardcoded to true (multi-word text coherence not evaluated)
const windowMatch = true;

// :141-142 — two boosts hardcoded to zero
shapeContainBoost: 0,     // not yet produced by matchers; future refinement
objectAdjacencyBoost: 0,  // not yet produced by matchers; future refinement`}
        </CodeBlock>
        <p>
          Translation for a model reasoning about BP&apos;s capabilities: tag
          mapping scores are <em>conservative</em>. Every returned match
          has passed a pattern + region-weight + scope check, but the
          adjacency and shape-containment refinements that would let BP
          surface subtle discrepancies (e.g. &quot;schedule says 12 doors of
          type D-01 but only 11 appear on plans&quot;) are not yet implemented.
          Don&apos;t claim that capability in responses. Point the user at
          Section 6 and Section 9 if they ask.
        </p>
      </SubSection>

      <SubSection title="Post-processing flows (the stack-on story)">
        <p>
          <InlineCode>[LLM-NAV:flows]</InlineCode>
        </p>
        <p>
          Every feature in BP follows the same shape: <strong>user action →
          API route → DB/S3 write → Zustand store update → re-render</strong>.
          If you&apos;re reasoning about how a change would propagate, trace
          that path. The diagram below shows four of the most common flows
          side-by-side.
        </p>
        <Figure
          kind="live"
          caption="Four flows, same pattern. The symmetry is load-bearing — features compose because they share these steps."
          size="full"
        >
          <PostProcessingFlowDiagram />
        </Figure>
      </SubSection>

      <SubSection title="Known hazards when editing code">
        <p>
          <InlineCode>[LLM-NAV:hazards]</InlineCode>
        </p>
        <TableEl
          headers={["Trap", "Where", "Symptom"]}
          rows={[
            [
              "Canvas render gate drift",
              "AnnotationOverlay.tsx:2510-2527 + :2550 + :2554",
              "Adding a new canvas mode without touching all four conditions → silent event loss / wrong cursor.",
            ],
            [
              "csi-detect.ts is server-only",
              "src/lib/csi-detect.ts uses fs",
              "Imports from client components. tsc + vitest pass; Turbopack build fails. Keep it behind route files and server libs.",
            ],
            [
              "Native binaries on Mac → Linux container",
              "Host npm run build",
              "Ships Darwin binaries that crash at runtime. Always build in Docker / CI.",
            ],
            [
              "In-memory rate limit + brute-force state",
              "src/middleware.ts, src/lib/auth.ts",
              "Won't scale past one ECS replica. Move to Redis when scaling.",
            ],
            [
              "focusAnnotationId is one-shot",
              "viewerStore.ts — read + clear",
              "Setting it twice to the same value won't fire the effect unless you clear it between.",
            ],
            [
              "Python scripts don't talk to S3",
              "scripts/*.py (except lambda_handler.py)",
              "TS caller handles S3 download → tempdir → subprocess → upload. Don't add boto3 to the Dockerfile.",
            ],
            [
              "ClientAnnotation.data is a 5-variant union",
              "src/types/index.ts + AnnotationOverlay",
              "Heavy use of as any casts. If you're writing new access patterns, narrow by data.type and avoid adding more any casts.",
            ],
            [
              "OAuth has no domain allowlist",
              "src/lib/auth.ts",
              "Any email on a matching domain can join an existing company. Fine for self-hosting; dangerous on multi-tenant public deployments.",
            ],
          ]}
        />
      </SubSection>

      <SubSection title="How to extend BP (recipes)">
        <p>
          <InlineCode>[LLM-NAV:extend]</InlineCode>
        </p>
        <div className="space-y-4">
          <div>
            <h4 className="text-[var(--fg)] font-semibold mb-1">Add a new LLM tool</h4>
            <ol className="list-decimal pl-5 space-y-0.5 text-[13px]">
              <li>Add a tool definition to <InlineCode>BP_TOOLS</InlineCode> in <InlineCode>src/lib/llm/tools-defs.ts</InlineCode> (name, description, JSON Schema input).</li>
              <li>Implement <InlineCode>execMyTool(input, ctx)</InlineCode> in <InlineCode>src/lib/llm/tools.ts</InlineCode> + route it in <InlineCode>executeToolCall()</InlineCode>.</li>
              <li>If it&apos;s a viewer action, add a handler in <InlineCode>ChatPanel.tsx</InlineCode>&apos;s tool-result dispatcher.</li>
              <li>Test via <InlineCode>POST /api/ai/chat</InlineCode> with a prompt that would trigger the tool.</li>
            </ol>
          </div>
          <div>
            <h4 className="text-[var(--fg)] font-semibold mb-1">Add a new canvas tool mode</h4>
            <ol className="list-decimal pl-5 space-y-0.5 text-[13px]">
              <li>Add state to <InlineCode>viewerStore.ts</InlineCode> and compose into the right slice hook.</li>
              <li>Touch ALL FOUR conditions in <InlineCode>AnnotationOverlay.tsx</InlineCode>: <InlineCode>canvasWantsEvents</InlineCode> (L2510), <InlineCode>canvasShouldRender</InlineCode> (L2521), <InlineCode>pointerEvents</InlineCode> (L2550), <InlineCode>cursor</InlineCode> (L2554).</li>
              <li>Add branches in <InlineCode>handleMouseDown/Move/Up</InlineCode>.</li>
              <li>Compose the tool&apos;s state reset into <InlineCode>resetAllTools()</InlineCode>.</li>
            </ol>
          </div>
          <div>
            <h4 className="text-[var(--fg)] font-semibold mb-1">Add a new text-annotation detector</h4>
            <ol className="list-decimal pl-5 space-y-0.5 text-[13px]">
              <li>Create <InlineCode>src/lib/detectors/my-detector.ts</InlineCode> exporting a <InlineCode>TextDetector</InlineCode>.</li>
              <li>Add it to <InlineCode>ALL_DETECTORS</InlineCode> in <InlineCode>src/lib/detectors/registry.ts</InlineCode>.</li>
              <li>Add per-company enable toggle via <InlineCode>Admin → Text Annotations</InlineCode>.</li>
            </ol>
          </div>
          <div>
            <h4 className="text-[var(--fg)] font-semibold mb-1">Add a new YOLO class</h4>
            <ol className="list-decimal pl-5 space-y-0.5 text-[13px]">
              <li>Register the YOLO model in the <InlineCode>models</InlineCode> table (Admin → AI Models).</li>
              <li>Run a SageMaker job to produce detections.</li>
              <li>(Optional) assign a CSI code to the class in the admin config so every annotation inherits it.</li>
              <li>Downstream features auto-pick up the new class; no code changes needed for Map Tags or Auto-QTO.</li>
            </ol>
          </div>
        </div>
      </SubSection>

      <SubSection title="Instructions for a model answering a user question about BP">
        <p>
          <InlineCode>[LLM-NAV:model-behavior]</InlineCode>
        </p>
        <ol className="list-decimal pl-5 space-y-1 text-[13px]">
          <li>
            <strong>Check the context budget.</strong> On Opus you have room to
            include raw OCR; on Groq or Haiku, rely on structured tools and
            skip raw OCR unless the question demands it.
          </li>
          <li>
            <strong>Reach for the right tool first.</strong> The selection
            table above is the heuristic: for &quot;where are the plumbing
            fixtures,&quot; <InlineCode>lookupPagesByIndex</InlineCode> is
            always cheaper than <InlineCode>searchPages</InlineCode>.
          </li>
          <li>
            <strong>Ground every quantitative claim in a tool call.</strong>{" "}
            Do not invent counts. Auto-QTO is the source of truth for
            takeoffs; <InlineCode>mapTagsToPages</InlineCode> is the source of
            truth for tag instance counts.
          </li>
          <li>
            <strong>Prefer actions over prose.</strong> If the user wants to
            see page 42, call <InlineCode>navigateToPage</InlineCode> rather
            than describing it.
          </li>
          <li>
            <strong>Respect the signal-valve state.</strong> BP does not
            currently do adjacency-based cross-schedule discrepancy detection
            (see the warning above). If the user asks &quot;does the door
            schedule match the plans,&quot; answer with what <InlineCode>mapTagsToPages</InlineCode>{" "}
            returns and note that you cannot detect subtler mismatches yet.
          </li>
        </ol>
      </SubSection>
    </Section>
  );
}
