import { Section } from "../_components/Section";
import { SubSection } from "../_components/SubSection";
import { Figure } from "../_components/Figure";
import { InlineCode } from "../_components/InlineCode";
import { Callout } from "../_components/Callout";
import { CodeBlock } from "../_components/CodeBlock";
import { TableEl } from "../_components/TableEl";
import { CsiChip } from "../_components/demos/CsiChipDemo";
import { CsiDivisionChipGrid } from "../_components/demos/CsiDivisionChipGrid";
import { CsiSpatialHeatmapDemo } from "../_components/demos/CsiSpatialHeatmapDemo";
import { CsiTierExplainer } from "../_components/demos/CsiTierExplainer";

export function Section04CsiEngine() {
  return (
    <Section id="csi-engine" eyebrow="Engines" title="CSI as a Token-Efficient Blueprint Encoding">
      <p>
        The hardest thing about putting a construction project in front of an
        LLM is the raw token cost. A typical 200-page drawing set runs to
        ~2&nbsp;million characters of OCR text &mdash; roughly 500,000 tokens
        &mdash; and the useful content is scattered across specifications, notes,
        schedules, dimensions, legends, and title blocks. Dumping all of that into
        a context window is both expensive and counterproductive: the model gets
        lost in the noise.
      </p>
      <p>
        BP&apos;s answer is the CSI engine: a three-layer encoding that turns a
        page into a structured, compact tag set, turns a project into a navigable
        graph, and lets the LLM zoom from project-level structure down to
        individual pages through tool calls rather than by paging through OCR. CSI
        codes are the primary key &mdash; they&apos;re a shared vocabulary across
        all construction documents and map directly to how estimators and
        specifiers think.
      </p>

      <SubSection title="Why CSI and not raw keywords">
        <p>
          CSI MasterFormat is an industry-standard classification system
          maintained by the Construction Specifications Institute. Every
          specification section has a code like <InlineCode>08 14 00</InlineCode>{" "}
          &mdash; Division 08 (Openings), section 14 (Wood Doors), subsection 00
          (general). Division is the most useful unit: it maps to trade, it&apos;s
          stable across projects, and it&apos;s dense enough that 25 divisions can
          meaningfully describe any project while being small enough to fit the
          whole project&apos;s division breakdown into a single paragraph of LLM
          context.
        </p>
        <p>
          Because CSI is a closed vocabulary, BP can turn a full page of OCR
          (easily 4&ndash;10k characters) into a single short tag list like{" "}
          <InlineCode>[22 00 00, 23 05 00, 26 05 00]</InlineCode> plus confidence
          scores and then look up detailed division data on demand through tool
          calls. That pattern is what lets BP scale LLM chat to 200-page projects
          without ever exceeding a Sonnet-sized context budget.
        </p>
        <Figure kind="live" caption="CSI chips — how detected codes show up across the UI." size="md">
          <div className="flex flex-wrap gap-2">
            <CsiChip code="22 00 00" description="Plumbing" confidence={0.95} />
            <CsiChip code="23 00 00" description="HVAC" confidence={0.88} />
            <CsiChip code="26 00 00" description="Electrical" confidence={0.92} />
            <CsiChip code="08 14 00" description="Wood Doors" confidence={0.78} />
            <CsiChip code="03 30 00" description="Cast-in-Place Concrete" confidence={0.85} />
            <CsiChip code="09 51 13" description="Acoustical Panel Ceilings" confidence={0.62} />
          </div>
        </Figure>
      </SubSection>

      <SubSection title="Layer 1: per-page detection (3-tier algorithm)">
        <p>
          <InlineCode>src/lib/csi-detect.ts</InlineCode> implements a rule-based
          matcher against a MasterFormat database. The matcher runs three tiers
          in order of specificity; a code can be tagged by any tier it passes, and
          the tier with the highest confidence wins. Defaults:
        </p>
        <TableEl
          headers={["Tier", "What it matches", "Confidence", "Why it exists"]}
          rows={[
            [
              <strong key="1">Tier 1</strong>,
              "Exact consecutive-word subphrase from the MasterFormat description (e.g. 'cast-in-place concrete' anywhere in the OCR).",
              <span key="1c" className="font-mono">0.95</span>,
              "High-signal: the literal phrase is in the text, which essentially never happens by accident.",
            ],
            [
              <strong key="2">Tier 2</strong>,
              <span key="2b">
                Bag-of-words overlap &mdash; at least <InlineCode>tier2MinWords</InlineCode> significant
                words from the description appear anywhere on the page (stop words excluded).
              </span>,
              <span key="2c" className="font-mono">≤ 0.75 (tier2Weight)</span>,
              "Catches rephrased matches: 'acoustical ceiling panel' matches 'Acoustical Panel Ceilings' without insisting on word order.",
            ],
            [
              <strong key="3">Tier 3</strong>,
              <span key="3b">
                Keyword-anchor &mdash; at least <InlineCode>tier3MinWords</InlineCode> high-signal
                anchor words match a description.
              </span>,
              <span key="3c" className="font-mono">≤ 0.50 (tier3Weight)</span>,
              "Fallback: rescues obvious trades (plumbing, electrical, HVAC) when neither subphrase nor bag-of-words hits.",
            ],
          ]}
        />
        <p>
          The matcher keeps only codes whose final score beats{" "}
          <InlineCode>matchingConfidenceThreshold</InlineCode> (default 0.40). All
          defaults are overridable per-company through{" "}
          <InlineCode>companies.pipelineConfig.csi</InlineCode> and the{" "}
          <InlineCode>Admin → CSI</InlineCode> tab, which also lets admins upload a
          custom CSI database TSV (useful for trades like fire alarm that benefit
          from an expanded vocabulary).
        </p>
        <CodeBlock lang="ts" caption="src/lib/csi-detect.ts:38-52 — DEFAULT_CONFIG">
{`const DEFAULT_CONFIG: CsiDetectConfig = {
  matchingConfidenceThreshold: 0.4,
  tier2MinWords: 3,
  tier3MinWords: 5,
  tier2Weight: 0.75,
  tier3Weight: 0.50,
};`}
        </CodeBlock>
        <Figure
          kind="live"
          caption="Try the live detector. The input hits /api/csi/detect with a debounce and renders the returned tier + confidence. Falls back to a static example when unauthenticated."
          size="lg"
        >
          <CsiTierExplainer />
        </Figure>
      </SubSection>

      <SubSection title="Layer 2: per-page spatial heatmap">
        <p>
          After detection, <InlineCode>computeCsiSpatialMap()</InlineCode> bins
          every CSI-tagged text annotation (and, after a YOLO pass, every
          YOLO-inferred region) into a 9&times;9 grid plus two special zones:{" "}
          <InlineCode>title-block</InlineCode> (y &gt; 0.85) and{" "}
          <InlineCode>right-margin</InlineCode> (x &gt; 0.75, y &lt; 0.85). The
          output is a list of zones with per-division counts, which is what the
          LLM sees when it calls <InlineCode>getCsiSpatialMap(pageNumber)</InlineCode>.
        </p>
        <p>
          The spatial map is how the LLM answers questions like &quot;what&apos;s in
          the top-right of this sheet?&quot; or &quot;where are the MEP systems
          concentrated?&quot; without having to scan every word box on the page.
          The 3&times;3 demo below is a simplified view of a single page; the
          real default grid is 9&times;9.
        </p>
        <Figure
          kind="live"
          caption="CSI spatial heatmap — a toy 3×3 grid. Darker = more instances of that division."
          size="md"
        >
          <CsiSpatialHeatmapDemo />
        </Figure>
      </SubSection>

      <SubSection title="Layer 3: the CSI network graph">
        <p>
          At the project level, <InlineCode>buildCsiGraph()</InlineCode> converts
          the per-page CSI tags into a graph: <strong>nodes</strong> are CSI
          divisions, <strong>edges</strong> are co-occurrence relationships
          between divisions (with three types: <InlineCode>co-occurrence</InlineCode>,{" "}
          <InlineCode>cross-reference</InlineCode>, and{" "}
          <InlineCode>containment</InlineCode>), and <strong>clusters</strong> are
          pre-defined groupings: MEP (22, 23, 26, 27, 28), Architectural (08, 09,
          12), Structural (03, 05), and Site (31, 32, 33). The graph carries a{" "}
          <InlineCode>fingerprint</InlineCode> that BP uses as a cache key so it
          can avoid re-computing the graph when nothing on the project has
          changed.
        </p>
        <p>
          The graph is what makes LLM-driven navigation tractable. Tools like{" "}
          <InlineCode>getCrossReferences</InlineCode> return hub pages ranked by
          incoming reference count;{" "}
          <InlineCode>lookupPagesByIndex({"{"}&nbsp;index: &quot;csi&quot;&nbsp;{"}"})</InlineCode>{" "}
          answers &quot;which pages have Division 22?&quot; in O(1). When the LLM
          wants to find plumbing plans, it doesn&apos;t scan 200 pages &mdash; it
          queries the graph once and gets page numbers back.
        </p>
        <Figure
          kind="live"
          caption="CSI division grid — each division colored by cluster. Colors are imported from src/lib/csi-colors.ts, which is the same module the D3 graph view uses."
          size="full"
        >
          <CsiDivisionChipGrid />
        </Figure>
        <Figure
          kind="shot"
          src="/docs/shots/csi-graph-d3.png"
          alt="D3 force-directed CSI network graph showing division clusters"
          caption="The live CSI network graph rendered at /project/[id]/csi-graph. Nodes are divisions, links are co-occurrences, and the four standard clusters (MEP/Arch/Struct/Site) are visibly separated."
          frame="page"
          size="full"
        />
        <Figure
          kind="shot"
          src="/docs/shots/csi-panel-divisions.png"
          alt="CSI panel with all divisions expanded"
          caption="CSI panel in the viewer. Page and project scope switch; clicking a division filters the canvas to show only annotations tagged with that division."
          frame="panel"
          size="md"
        />
      </SubSection>

      <SubSection title="How the LLM uses all three layers">
        <p>
          All three layers surface to the LLM as tool calls. Section 09 walks
          through the full tool set, but the CSI-specific story is:
        </p>
        <ul className="list-disc pl-5 space-y-1 text-[13px]">
          <li>
            <InlineCode>getProjectOverview()</InlineCode> returns the project-level
            CSI divisions and cluster membership — the coarse first look.
          </li>
          <li>
            <InlineCode>getCsiSpatialMap(pageNumber)</InlineCode> returns the per-page
            heatmap — the &quot;zoom in&quot; query.
          </li>
          <li>
            <InlineCode>getCrossReferences(pageNumber?)</InlineCode> returns the
            cross-reference edges and hub pages — navigation.
          </li>
          <li>
            <InlineCode>lookupPagesByIndex({"{"}&nbsp;index: &quot;csi&quot;, key: &quot;22&quot;&nbsp;{"}"})</InlineCode> is
            the O(1) &quot;give me every page tagged with Division 22&quot; query.
          </li>
          <li>
            <InlineCode>detectCsiFromText(text)</InlineCode> lets the LLM run the 3-tier
            matcher on arbitrary input strings (e.g. a user&apos;s question).
          </li>
        </ul>
        <Callout variant="tip" title="Why the CSI graph matters for chat">
          The context builder (<InlineCode>src/lib/context-builder.ts</InlineCode>)
          feeds the CSI network graph into the LLM&apos;s system context at
          priority <InlineCode>1.0</InlineCode> &mdash; near the top, right after
          the project report. That means the model sees the division clusters and
          their edges <em>before</em> it sees raw OCR, so its first tool call is
          almost always a graph query rather than a full-text search. This is how
          a chat session starts &quot;hot&quot; even on a 200-page project.
        </Callout>
      </SubSection>
    </Section>
  );
}
