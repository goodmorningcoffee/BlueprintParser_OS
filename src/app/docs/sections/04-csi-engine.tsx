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
      {/* Plain-English lead */}
      <div className="max-w-3xl text-[15px] text-[var(--fg)]/80 leading-relaxed border-l-2 border-[var(--accent)]/40 pl-4 py-1 mb-4">
        In plain English: CSI MasterFormat is the construction industry&apos;s
        Dewey Decimal system. Every spec section has a 6-digit code like{" "}
        &quot;08 14 00 = Wood Doors&quot;. BP detects these codes on every page,
        uses them to summarize what&apos;s on the sheet, and builds a project-
        wide graph showing how trades connect. An LLM can navigate a 200-page
        set through that graph without ever reading most of the OCR.
      </div>

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
        <Figure kind="live" caption="CSI chips — how detected codes show up across the UI. The percentage is the page confidence (see below)." size="md">
          <div className="flex flex-wrap gap-2">
            <CsiChip code="22 34 00" description="Fuel-Fired Domestic Water Heaters" confidence={0.88} />
            <CsiChip code="23 00 00" description="Heating, Ventilating, and Air Conditioning" confidence={0.94} />
            <CsiChip code="08 11 13" description="Hollow Metal Doors and Frames" confidence={1} />
            <CsiChip code="03 30 00" description="Cast-in-Place Concrete" confidence={0.91} />
            <CsiChip code="09 29 00" description="Gypsum Board" confidence={0.97} />
            <CsiChip code="09 51 13" description="Acoustical Panel Ceilings" confidence={0.88} />
          </div>
        </Figure>
      </SubSection>

      <SubSection title="Layer 1: per-page detection (the CSI tagger)">
        <p>
          The tagger reads a page the way an estimator skims it: line by line, looking for phrases
          that name a MasterFormat section. It is fully deterministic &mdash; no AI model runs at
          detection time, so the same page always gets the same codes, and every code can point to
          the exact words on the sheet that produced it.
        </p>

        <h4 className="text-[13px] font-semibold mt-4 mb-1">1. The lookup table</h4>
        <p>
          Everything the tagger knows comes from one lookup table built once, offline, from the
          MasterFormat 2018 PDF: <strong>8,935 codes</strong> and about <strong>20,300 phrases</strong>{" "}
          that point at them &mdash; every section title (8,927), the phrases from the book&apos;s
          index (10,165), alternate titles (962), the index&apos;s &quot;see&quot; cross-references
          (206), and a short hand-curated list of drawing abbreviations (58 rows, e.g. GWB, ACT, HM,
          CMU, VCT) so that <InlineCode>PTD GWB</InlineCode> finds Gypsum Board and Painting. The
          table is checked when the server image is built, so a deployed server always has it.
          Because the index text is MasterFormat&apos;s own wording, the table is rebuilt from the PDF
          rather than published in the open-source repository.
        </p>
        <p>
          MasterFormat is a nested menu (Division 08 &rarr; 08 10 00 Doors and Frames &rarr; 08 11 13
          Hollow Metal Doors and Frames), and the table keeps that shape. For each phrase it records
          which words it shares with its parent (the <em>family</em> words) and which words it adds
          (its <em>distinguishing</em> words). A generic word on its own &mdash; &quot;concrete&quot;,
          &quot;door&quot;, &quot;equipment&quot; &mdash; is evidence for a family, never a tag by itself.
        </p>

        <h4 className="text-[13px] font-semibold mt-4 mb-1">2. Spans: which words name which code</h4>
        <p>
          Each OCR line, table cell or sentence is matched on its own; a phrase never reaches across
          two lines or two cells. A phrase matches a stretch of text (a <em>span</em>) when:
        </p>
        <ul className="list-disc pl-5 space-y-1 text-[13px]">
          <li>every one of its distinguishing words is present,</li>
          <li>at least 80% of the phrase&apos;s weight is present (rare words weigh more than common ones),</li>
          <li>the words sit close together and do not cross punctuation like a period, colon or bracket.</li>
        </ul>
        <p>
          The span scores <strong>1.00</strong> when the words appear exactly as printed,{" "}
          <strong>0.85</strong> when they are spread out or reordered, and <strong>0.70</strong> when
          a phrase whose word order matters appears out of order (which keeps it from being listed).
          A one-word match counts only for a curated abbreviation; any other single word just hints
          at a division.
        </p>

        <h4 className="text-[13px] font-semibold mt-4 mb-1">3. Ownership: the most specific code wins</h4>
        <p>
          When several phrases match the same words, the tagger keeps only the deepest one:{" "}
          &quot;HOLLOW METAL FRAME&quot; gives 08 12 13 Hollow Metal Frames, not 08 10 00 or
          Division 08. Then each stretch of words gets exactly one <em>owner</em>:
        </p>
        <ul className="list-disc pl-5 space-y-1 text-[13px]">
          <li>one code matches &rarr; it owns the words;</li>
          <li>
            several sibling codes match equally well &rarr; their shared parent owns the words (its
            score &times; 0.9) and the siblings are kept as alternatives;
          </li>
          <li>
            codes from different divisions match &rarr; the sheet&apos;s discipline decides (A-, S-,
            M-, P-, E-, FP- or C- drawing numbers each point at their own divisions); if that does not
            settle it, nobody owns the words and they only hint at the divisions involved.
          </li>
        </ul>

        <h4 className="text-[13px] font-semibold mt-4 mb-1">4. Page rules</h4>
        <ul className="list-disc pl-5 space-y-1 text-[13px]">
          <li>
            Text that ends in <strong>BY OTHERS</strong>, <strong>BY OWNER</strong>,{" "}
            <strong>N.I.C.</strong> or <strong>NOT IN CONTRACT</strong> is recorded but never tags
            the page.
          </li>
          <li>
            <strong>Division 00 and 01</strong> (procurement, general requirements) only hint on
            drawings &mdash; title blocks and general notes would otherwise tag every sheet. Typed
            text such as a note or a spec page can still list them from a phrase of three or more
            words.
          </li>
          <li>
            <strong>Site and process divisions</strong> (33&ndash;35, 40&ndash;48) are listed only
            when at least two different phrases belonging to that code match, or the sheet is a civil
            (C-) sheet.
          </li>
        </ul>

        <h4 className="text-[13px] font-semibold mt-4 mb-1">5. Confidence and the threshold (tau)</h4>
        <p>
          A code&apos;s page confidence is its best span score times a repetition factor: 0.88 for
          one occurrence, plus 0.03 for each further place it appears, up to 1.00 at five. A code is
          listed when its confidence reaches <InlineCode>tau</InlineCode> (default{" "}
          <strong>0.75</strong>) and its best span scores at least 0.80; at most{" "}
          <InlineCode>maxCodesPerPage</InlineCode> codes (default 40) are kept, highest confidence
          first. With the defaults, one exact phrase is enough (0.88), while one loose match (0.85
          &times; 0.88 &asymp; 0.75) needs to repeat. Every listed code therefore scores at least 0.704,
          so lowering tau below that changes nothing. The tier shown on a highlight is read from the
          confidence: tier 1 at 0.80 and above, tier 2 from 0.60.
        </p>
        <TableEl
          headers={["Stored per code", "What it is"]}
          rows={[
            [<InlineCode key="c">code</InlineCode>, "Spaced MasterFormat code, e.g. 09 29 00 (sub-levels like 08 11 13.13 keep their suffix)."],
            [<InlineCode key="d">description</InlineCode>, "The MasterFormat 2018 title."],
            [<InlineCode key="f">confidence</InlineCode>, "Page confidence, 0.704 to 1.00."],
            [<InlineCode key="l">level</InlineCode>, "Depth in the MasterFormat tree: 2 for a division (08 00 00), up to 5 for a sub-level (08 11 13.13)."],
            [<InlineCode key="t">triggers</InlineCode>, "One record per owned span: the matched words, a box around them and a box per word, so the viewer can highlight exactly what was read."],
          ]}
        />

        <h4 className="text-[13px] font-semibold mt-4 mb-1">Measured</h4>
        <p>
          On the 471-page evaluation corpus the previous engine listed <strong>41.5 codes per page</strong>{" "}
          on average; this tagger lists <strong>6.4</strong> (median 4, 90th percentile 14). On the
          19 hand-labelled pilot pages, precision went from <strong>4% to 35%</strong> and recall from{" "}
          <strong>21% to 37%</strong>. The pilot labels are not yet certified, so treat these numbers
          as direction, not a guarantee; <InlineCode>eval/csi/run-eval.sh</InlineCode> re-measures
          them after every change.
        </p>

        <h4 className="text-[13px] font-semibold mt-4 mb-1">Settings</h4>
        <p>
          There are two, per company, in <InlineCode>Admin &rarr; CSI</InlineCode>:{" "}
          <InlineCode>tau</InlineCode> and <InlineCode>maxCodesPerPage</InlineCode>. Everything else
          above is fixed. The same tab accepts a custom CSI list (CSV, TSV or JSON with code and
          description columns): it <em>adds</em> codes and phrases on top of the built-in table and
          never changes what the built-in table already finds.
        </p>
        <CodeBlock lang="ts" caption="DEFAULT_CSI_V2_CONFIG in src/lib/csi-v2-config.ts">
{`export const DEFAULT_CSI_V2_CONFIG: Readonly<CsiV2Config> = Object.freeze({
  tau: 0.75,            // minimum page confidence to list a code
  maxCodesPerPage: 40,  // highest confidence first
});`}
        </CodeBlock>
        <Callout variant="tip" title="Where the code lives">
          <InlineCode>src/lib/csi-detect.ts</InlineCode> is the entry point every caller uses (
          <InlineCode>detectCsiCodes</InlineCode>, <InlineCode>detectCsiFromGrid</InlineCode>). It
          runs <InlineCode>detectCsiV2</InlineCode> in <InlineCode>src/lib/csi-page.ts</InlineCode>{" "}
          (page rules), which uses <InlineCode>csi-span-match.ts</InlineCode> (spans) and{" "}
          <InlineCode>csi-span-own.ts</InlineCode> (ownership). The previous engine is kept unchanged
          in <InlineCode>csi-detect-legacy.ts</InlineCode> as the evaluation baseline only.
        </Callout>
        <Figure
          kind="live"
          caption="Try the live tagger. The input hits /api/csi/detect with a debounce and renders the returned codes. Falls back to a recorded example if the backend is unavailable."
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
            <InlineCode>detectCsiFromText(text)</InlineCode> lets the LLM run the same
            tagger on arbitrary input strings (e.g. a user&apos;s question).
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
