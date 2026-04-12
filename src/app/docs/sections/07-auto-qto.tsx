import { Section } from "../_components/Section";
import { SubSection } from "../_components/SubSection";
import { Figure } from "../_components/Figure";
import { InlineCode } from "../_components/InlineCode";
import { Callout } from "../_components/Callout";
import { CodeBlock } from "../_components/CodeBlock";
import { MaterialPickerDemo } from "../_components/demos/MaterialPickerDemo";
import { AutoQtoProgressBar } from "../_components/demos/AutoQtoProgressBar";

export function Section07AutoQto() {
  return (
    <Section id="auto-qto" eyebrow="Engines" title="Auto-QTO: Schedule-Driven Takeoff">
      <p>
        Auto-QTO is the pipeline from &quot;I parsed a schedule and mapped its
        tags to YOLO shapes&quot; to &quot;I have a line-item quantity takeoff
        ready to export to CSV.&quot; It is the feature that most directly
        translates BP&apos;s structured preprocessing into a deliverable an
        estimator actually sends to a bid. It lives in{" "}
        <InlineCode>src/components/viewer/AutoQtoTab.tsx</InlineCode> and is the
        Auto QTO sub-tab of the QTO panel.
      </p>

      <SubSection title="What Auto-QTO actually does">
        <p>
          Given a material type (doors, finishes, equipment, plumbing, or
          electrical), Auto-QTO:
        </p>
        <ol className="list-decimal pl-6 space-y-1 text-[13px]">
          <li>Finds or asks you to parse the relevant schedule page.</li>
          <li>Reads the parsed schedule&apos;s tag column.</li>
          <li>Asks you which YOLO tag-shape class the tags are drawn inside.</li>
          <li>
            Runs Map Tags (Section 06) over the entire project, binding every
            unique tag value to its YOLO shape instances, while excluding the
            schedule region itself and the title block so it doesn&apos;t
            double-count.
          </li>
          <li>
            Produces a line-item list with counts, pages, and an editable review
            surface. Estimators can hand-adjust before exporting.
          </li>
          <li>Exports to CSV / Excel for the bid package.</li>
        </ol>
        <p>
          The thing to understand: Auto-QTO does not invent quantities. It simply
          counts tag occurrences identified by YOLO + OCR, and the fidelity of
          the count is a function of the fidelity of the YOLO model and the
          schedule parse. If the model missed a door, Auto-QTO will miss that
          count; that&apos;s why the review step matters and why the user always
          has an override.
        </p>
      </SubSection>

      <SubSection title="Preflight — the strict YOLO class requirement">
        <p>
          Auto-QTO hard-blocks the material picker unless the project&apos;s YOLO
          run includes three specific classes:{" "}
          <InlineCode>tables</InlineCode>, <InlineCode>title_block</InlineCode>,
          and <InlineCode>drawings</InlineCode>. These are exclusion / inclusion
          markers for the counting logic &mdash; without them, Auto-QTO
          can&apos;t cleanly differentiate &quot;tags inside the schedule&quot;
          from &quot;tags out on the drawings.&quot;
        </p>
        <CodeBlock lang="ts" caption="src/components/viewer/AutoQtoTab.tsx:51–52">
{`const QTO_STRICT_EXCLUSION_CLASSES = ["tables", "title_block", "drawings"] as const;
const QTO_RECOMMENDED_CLASSES = ["grid", "vertical_area", "horizontal_area"] as const;`}
        </CodeBlock>
        <p>
          If a strict class is missing, Auto-QTO shows a blocker callout with a
          link to <InlineCode>Admin → AI Models</InlineCode>: you need to run a
          YOLO model that has those classes before you can proceed. The
          recommended classes (<InlineCode>grid</InlineCode>,{" "}
          <InlineCode>vertical_area</InlineCode>,{" "}
          <InlineCode>horizontal_area</InlineCode>) are soft &mdash; missing them
          just produces a warning banner, not a block.
        </p>
        <Callout variant="warn" title="Why these exact classes">
          The exclusion classes exist so that the tag in the door schedule&apos;s
          &quot;Door Type&quot; column (e.g. &quot;D-01&quot;) does not itself
          count as a door. Auto-QTO sees that the tag text lives inside a{" "}
          <InlineCode>tables</InlineCode> region and skips it. The same applies
          to title blocks (which often have a legend that re-uses tag symbols).
          Without these markers, a schedule with 20 rows of &quot;D-01 D-02
          D-03&quot; would double-count every door.
        </Callout>
      </SubSection>

      <SubSection title="Material picker">
        <p>
          Auto-QTO starts with the material picker. Each option binds to a
          schedule category that the table classifier uses when suggesting pages
          for the schedule step. Custom material types are supported via a free
          text input &mdash; BP singularizes by stripping a trailing{" "}
          <InlineCode>s</InlineCode> as a rough stem.
        </p>
        <CodeBlock lang="ts" caption="AutoQtoTab.tsx:14–20">
{`const MATERIALS = [
  { type: "doors",      label: "Doors",       scheduleCategory: "door-schedule",       icon: "D" },
  { type: "finishes",   label: "Finishes",    scheduleCategory: "finish-schedule",     icon: "F" },
  { type: "equipment",  label: "Equipment",   scheduleCategory: "material-schedule",   icon: "E" },
  { type: "plumbing",   label: "Plumbing",    scheduleCategory: "plumbing-schedule",   icon: "P" },
  { type: "electrical", label: "Electrical",  scheduleCategory: "electrical-schedule", icon: "Z" },
];`}
        </CodeBlock>
        <Figure kind="live" caption="MaterialPickerDemo — styles match the real wizard." size="md">
          <MaterialPickerDemo />
        </Figure>
      </SubSection>

      <SubSection title="The 5-step state machine">
        <p>
          Once a material is picked, Auto-QTO drops you into a step machine whose
          state lives in the <InlineCode>qto_workflows</InlineCode> table. The
          canonical step IDs come from{" "}
          <InlineCode>AutoQtoTab.tsx:11</InlineCode>:
        </p>
        <CodeBlock lang="ts" caption="AutoQtoTab.tsx:11">
{`const STEP_SEQUENCE = ["select-schedule", "confirm-tags", "map-tags", "review", "done"] as const;`}
        </CodeBlock>
        <Figure
          kind="live"
          caption="AutoQtoProgressBar — click Next/Back to move through the real step IDs."
          size="full"
        >
          <AutoQtoProgressBar />
        </Figure>

        <div className="space-y-4 mt-4">
          <div>
            <h4 className="text-[var(--fg)] font-semibold mb-1">1. select-schedule</h4>
            <p className="text-[13px]">
              Auto-QTO reads from{" "}
              <InlineCode>summaries.schedules</InlineCode> (built by{" "}
              <InlineCode>computeProjectSummaries()</InlineCode>) and surfaces pages
              whose classified tables match the selected material. Each suggestion
              shows a confidence badge. If nothing is parsed yet, the wizard can
              launch into the Table Parse panel inline &mdash; you parse the
              schedule, the wizard picks up where you left off.
            </p>
          </div>

          <div>
            <h4 className="text-[var(--fg)] font-semibold mb-1">2. confirm-tags</h4>
            <p className="text-[13px]">
              Auto-QTO reads the parsed schedule&apos;s headers and rows and asks
              the user to confirm the tag column (pre-selected from the parse).
              This is also where the user picks the{" "}
              <strong>tag-shape class</strong> from{" "}
              <InlineCode>QTO_TAG_SHAPE_CLASSES</InlineCode>:{" "}
              <InlineCode>circle</InlineCode>, <InlineCode>arch_sheet_circle</InlineCode>,{" "}
              <InlineCode>dot_small_circle</InlineCode>,{" "}
              <InlineCode>hexagon</InlineCode>, <InlineCode>hex_pill</InlineCode>,{" "}
              <InlineCode>diamond</InlineCode>, <InlineCode>triangle</InlineCode>,{" "}
              <InlineCode>pill</InlineCode>, <InlineCode>oval</InlineCode>,{" "}
              <InlineCode>rectangle</InlineCode>, <InlineCode>square</InlineCode>.
            </p>
          </div>

          <div>
            <h4 className="text-[var(--fg)] font-semibold mb-1">3. map-tags</h4>
            <p className="text-[13px]">
              The user clicks <strong>Run Mapping</strong>. Auto-QTO invokes{" "}
              <InlineCode>POST /api/projects/[id]/map-tags-batch</InlineCode> with
              the schedule&apos;s tag column and the selected YOLO shape class.
              The backend runs Map Tags across every page, excludes regions
              labeled <InlineCode>tables</InlineCode> / <InlineCode>title_block</InlineCode>,
              and writes the resulting YoloTags. Results stream back as line
              items with counts per tag value.
            </p>
          </div>

          <div>
            <h4 className="text-[var(--fg)] font-semibold mb-1">4. review</h4>
            <p className="text-[13px]">
              Each row of the review surface is one line item:{" "}
              <InlineCode>{"{"} itemType, label, yoloClass?, text?, count, pages, annotations {"}"}</InlineCode>.
              Auto-QTO flags ambiguity &mdash; e.g. if a tag appears on more pages
              than its schedule row implies &mdash; as a{" "}
              <InlineCode>QtoFlag</InlineCode>. The user can edit counts, add
              notes, and fix miscategorizations. Edits are stored in{" "}
              <InlineCode>qto_workflows.userEdits</InlineCode> so they survive a
              re-run.
            </p>
          </div>

          <div>
            <h4 className="text-[var(--fg)] font-semibold mb-1">5. done</h4>
            <p className="text-[13px]">
              Terminal state. The user exports via{" "}
              <InlineCode>TakeoffCsvModal</InlineCode> or{" "}
              <InlineCode>ExportCsvModal</InlineCode> (CSV / Excel). The workflow
              stays in the project — you can re-enter it later, advance back to{" "}
              <InlineCode>review</InlineCode>, and re-export if a schedule was
              updated.
            </p>
          </div>
        </div>
      </SubSection>

      <SubSection title="Item types (SHIP 2 taxonomy)">
        <p>
          Under the hood, the counting engine supports five item-type strategies
          via <InlineCode>findItemOccurrences()</InlineCode> in{" "}
          <InlineCode>src/lib/yolo-tag-engine.ts</InlineCode>. Auto-QTO almost
          always defaults to type 4 (<InlineCode>yolo-object-with-tag-shape</InlineCode>),
          but the other four are available to composite-classifier and manual
          QTO workflows:
        </p>
        <ul className="list-disc pl-5 space-y-1 text-[13px]">
          <li><InlineCode>yolo-only</InlineCode> — count instances of a class with no text.</li>
          <li><InlineCode>text-only</InlineCode> — count occurrences of a literal OCR string, no YOLO.</li>
          <li><InlineCode>yolo-with-inner-text</InlineCode> — YOLO shape containing specific text.</li>
          <li><InlineCode>yolo-object-with-tag-shape</InlineCode> — primary object + tag-shape combo (the default for Auto-QTO).</li>
          <li><InlineCode>text-pattern</InlineCode> — detect a repeating tag series (T-01, T-02, T-03, ...).</li>
        </ul>
      </SubSection>

      <SubSection title="Demo mode">
        <p>
          In demo mode (<InlineCode>isDemo === true</InlineCode>), Auto-QTO
          workflows persist in the Zustand store only &mdash; they disappear when
          the tab is closed. The same is true for annotations, markups, takeoff
          items, and parse results. This is a deliberate design choice so that
          the public <InlineCode>/demo/project/*</InlineCode> route can let
          anonymous users drive a full Auto-QTO workflow without polluting the
          shared demo project.
        </p>
      </SubSection>
    </Section>
  );
}
