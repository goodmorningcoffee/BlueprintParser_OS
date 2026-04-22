import { Section } from "../_components/Section";
import { SubSection } from "../_components/SubSection";
import { Figure } from "../_components/Figure";
import { InlineCode } from "../_components/InlineCode";
import { Callout } from "../_components/Callout";
import { ProjectWalkthroughDiagram } from "../_components/demos/ProjectWalkthroughDiagram";

export function Section00Walkthrough() {
  return (
    <Section id="walkthrough" eyebrow="Start Here" title="Your First Project in Five Minutes">
      <p className="text-[16px]">
        If you have never seen BlueprintParser before, read this section first. It
        ignores the code, the AWS stack, and the tool-registry plumbing. It shows
        you the happy path a working estimator takes: upload a PDF, wait a minute,
        open the viewer, let BP find the things on the page, and export numbers
        for a bid.
      </p>

      <Figure
        kind="live"
        caption="The happy path — five steps, no jargon. Each step corresponds to a section later in these docs if you want the full depth."
        size="full"
      >
        <ProjectWalkthroughDiagram />
      </Figure>

      <SubSection title="1. Upload a PDF">
        <p>
          From the dashboard at <InlineCode>/home</InlineCode>, drag a drawing
          set onto the upload card. BP accepts a normal multi-page PDF; individual
          pages up to roughly 10,000 px on either axis work fine at 300 DPI, which
          covers the common 24&times;36 and 30&times;42 sheet sizes. You get a
          progress bar; when it finishes, the project appears in the project list.
        </p>
        <p>
          Behind the scenes, the file is uploaded to S3 and a processing job is
          kicked off. You do not have to wait on the page; you can close the tab
          and come back later.
        </p>
      </SubSection>

      <SubSection title="2. BP reads the pages">
        <p>
          For each page, BP runs OCR, detects CSI MasterFormat codes (the
          industry-standard classification scheme &mdash; &quot;08 14 00 = Wood
          Doors&quot;), extracts drawing numbers from title blocks, detects
          schedules and keynotes, and classifies what&apos;s on the sheet. This
          takes roughly one minute per ten pages. A 200-page set is usually
          ready in five to ten minutes on the default Fargate tier.
        </p>
        <p>
          You don&apos;t have to do anything during this step. When the project
          card shows <strong>Ready</strong>, click in.
        </p>
      </SubSection>

      <SubSection title="3. Open the viewer">
        <p>
          The viewer lives at <InlineCode>/project/&#91;id&#93;</InlineCode>.
          It looks like a drawing review tool: a page sidebar on the left, a
          big canvas in the middle, a toolbar across the top, and a stack of
          panels you can flip open from the right edge. Pan with{" "}
          <strong>V</strong>, click with <strong>A</strong>, scroll to zoom
          (hold <strong>⌘</strong> / Ctrl if you&apos;re on a trackpad). The
          panels on the right &mdash; Text, CSI, LLM Chat, QTO, Schedules,
          Keynotes &mdash; are the feature surface. You only open the ones
          you need.
        </p>
        <Callout variant="tip" title="First thing to try">
          Click <strong>LLM Chat</strong> and ask &quot;what disciplines are in
          this project?&quot;. The chat has tools to look up the CSI network
          graph, schedules, and spatial context; it will usually answer with a
          breakdown and offer to jump to relevant pages.
        </Callout>
      </SubSection>

      <SubSection title="4. Run detection and tag a schedule">
        <p>
          BP&apos;s text pipeline already knows where the schedules and keynotes
          are. What it doesn&apos;t know, until you ask, is where every door and
          window <em>physically is</em> on the floor plans. That&apos;s a YOLO
          run (an admin kicks it off &mdash; see Section 5). Once it&apos;s
          done, open the <strong>Schedules/Tables</strong> panel, point at the
          door schedule, and click <strong>Auto Parse</strong>. Then pick which
          YOLO class the tags are drawn inside (usually <strong>circle</strong>)
          and run <strong>Map Tags</strong>. BP binds each schedule row to every
          matching shape in the drawings and gives you a count per row.
        </p>
        <p>
          Auto-QTO (the <strong>QTO → Auto</strong> tab) does all of that on
          autopilot: pick a material type, confirm the schedule, run the
          mapping, review the counts, export.
        </p>
      </SubSection>

      <SubSection title="5. Export">
        <p>
          Everything in the QTO panel exports to CSV or Excel through the{" "}
          <strong>Export CSV</strong> button at the bottom of the panel. One row
          per tag or area item, with counts, pages, annotations, and notes. Paste
          it into the bid spreadsheet and you&apos;re done.
        </p>
      </SubSection>

      <SubSection title="When something looks off">
        <p>
          Most of the complexity in these docs is the answer to one question:{" "}
          <em>what if the happy path doesn&apos;t work?</em> If bucket fill
          leaks through an open doorway, Section 8 covers barriers and the four
          tuning knobs. If Auto-QTO blocks you at the start, Section 7 covers
          the YOLO class requirements and how to fix them from Admin. If chat
          runs out of context room on a big project, Section 9 explains the
          budget and the presets that trade structure for OCR. And if you want
          to know how the whole thing runs on AWS, Section 11 is the tour.
        </p>
      </SubSection>
    </Section>
  );
}
