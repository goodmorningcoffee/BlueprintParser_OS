import { Section } from "../_components/Section";
import { SubSection } from "../_components/SubSection";
import { Figure } from "../_components/Figure";
import { InlineCode } from "../_components/InlineCode";
import { Callout } from "../_components/Callout";
import { CodeBlock } from "../_components/CodeBlock";
import { TableEl } from "../_components/TableEl";
import { BucketFillButtonDemo } from "../_components/demos/BucketFillButtonDemo";
import { AreaUnitChipDemo } from "../_components/demos/AreaUnitChipDemo";
import { BucketFillStagesDiagram } from "../_components/demos/BucketFillStagesDiagram";

export function Section08BucketFill() {
  return (
    <Section id="bucket-fill" eyebrow="Engines" title="Bucket Fill: Click-to-Area">
      {/* Plain-English lead */}
      <div className="max-w-3xl text-[15px] text-[var(--fg)]/80 leading-relaxed border-l-2 border-[var(--accent)]/40 pl-4 py-1 mb-4">
        In plain English: you click inside a room, BP traces the walls for you
        and tells you the square footage. The hard part is thin walls, open
        doorways, and text inside the room &mdash; solved with four tuning
        knobs and the option to draw virtual walls.
      </div>

      <p>
        Bucket Fill is BP&apos;s answer to the most tedious part of a manual
        takeoff: tracing polygons around rooms on a 200-page floor plan set. You
        click once inside a room, and a browser-side Web Worker floods from that
        seed point, stops at walls (and any virtual barriers you&apos;ve drawn
        across open doorways), simplifies the resulting polygon, and hands it
        back as normalized 0&ndash;1 vertices. If the page is scale-calibrated,
        BP converts those vertices to a real-world area in the unit you chose
        at calibration time.
      </p>

      <SubSection title="Where it lives">
        <p>
          Bucket Fill is the top strip of the <strong>Area</strong> tab inside
          the QTO panel (<InlineCode>src/components/viewer/AreaTab.tsx</InlineCode>).
          It appears as a tri-state button: disabled (no active area item), idle,
          active, or barrier mode. The state is controlled by two Zustand flags:{" "}
          <InlineCode>bucketFillActive</InlineCode> and{" "}
          <InlineCode>bucketFillBarrierMode</InlineCode>. A third store field,{" "}
          <InlineCode>bucketFillResolution</InlineCode>, drives the dominant
          tuning knob (see below).
        </p>
        <Figure
          kind="live"
          caption="BucketFillButtonDemo — click through the four states to see the exact styling each uses."
          size="md"
        >
          <BucketFillButtonDemo />
        </Figure>
      </SubSection>

      <SubSection title="The 8-stage worker pipeline">
        <p>
          The client-side Web Worker at{" "}
          <InlineCode>src/workers/bucket-fill.worker.ts</InlineCode> does all the
          heavy lifting. It&apos;s one pass: no retry, no speculative seeding.
          The single-pass design is the reason the tool feels instant even on
          a 4096-pixel image: no round-trip to the server, no Python subprocess,
          just an <InlineCode>OffscreenCanvas</InlineCode> and a tight
          TypeScript loop.
        </p>
        <Figure
          kind="live"
          caption="BucketFillStagesDiagram — verified against src/workers/bucket-fill.worker.ts:processFill (L453+). Text is a dark region like any other; the flood stops at letter boundaries."
          size="full"
        >
          <BucketFillStagesDiagram />
        </Figure>
      </SubSection>

      <SubSection title="Tuning hierarchy — maxDimension is dominant">
        <p>
          The four knobs are not equal. If your fill leaks, or stops short, or
          over-bleeds through text, the order in which to reach for them is:
        </p>
        <TableEl
          headers={["Knob", "What it does", "Default", "Secondary effect"]}
          rows={[
            [
              <strong key="1">maxDimension (dominant)</strong>,
              "Largest dimension of the downscaled image before Otsu runs. 1000 / 2000 / 3000 / 4000 slider.",
              <span key="1c" className="font-mono">1000</span>,
              "Raise when thin wall lines get smeared away at low resolution. Doubles runtime each step.",
            ],
            [
              <span key="2">Tolerance</span>,
              "Offset applied to the Otsu threshold. Negative → treat more pixels as walls; positive → more pixels as floor.",
              <span key="2c" className="font-mono">0</span>,
              "Use to rescue thin walls if raising maxDimension alone isn't enough.",
            ],
            [
              <span key="3">Dilation</span>,
              "morphClose radius after threshold. Fills small gaps in line art (1–2 px door-frame breaks).",
              <span key="3c" className="font-mono">3</span>,
              "Dilation=0 skips morphClose entirely. Use for plans with thin mullions where closing bridges real gaps.",
            ],
            [
              <span key="4">Barriers</span>,
              "User-drawn virtual walls to seal open doorways. Drawn by clicking two points in barrier mode.",
              <span key="4c" className="font-mono">∅</span>,
              "Tertiary. Reach for this when the underlying plan genuinely lacks a wall (e.g. an open doorway you don't want the fill to cross).",
            ],
          ]}
        />
        <Callout variant="info" title="Why maxDimension is the big lever">
          Downscaling happens <em>before</em> Otsu thresholds the image. If you
          downscale a 3000-pixel floor plan to 1000 pixels, a 1-pixel wall becomes
          a sub-pixel gradient and Otsu loses it. Doubling <InlineCode>maxDimension</InlineCode>{" "}
          preserves the wall. Tolerance and dilation can sometimes rescue a low-
          resolution fill, but it&apos;s much cheaper (in user effort) to bump
          the resolution first.
        </Callout>
      </SubSection>

      <SubSection title="Text is a wall">
        <p>
          Post-2026-04-22, the worker does not pre-erase text blocks. Letter
          boundaries simply act as dark pixels and the flood stops at them like
          it stops at walls. The reasoning: pre-erasing OCR&apos;d text was
          error-prone (it enlarged bboxes and erased parts of adjacent walls)
          and the user rarely wants a fill to cross text anyway &mdash; text
          in a room almost always labels the room or notes something inside it,
          which stays inside the polygon.
        </p>
        <Callout variant="tip" title="Area accounting, explained">
          The <InlineCode>areaFraction</InlineCode> returned from the worker is
          <strong> decorative</strong>. It&apos;s the pixel-count ratio of the
          flood, which slightly under-estimates the real room area because the
          text blocks inside the room are not filled. For reporting, BP uses{" "}
          <InlineCode>computeRealArea(vertices, pageW, pageH, calibration)</InlineCode>{" "}
          on the traced outer polygon &mdash; which correctly includes the
          text-punctuated interior. Section 7 and{" "}
          <InlineCode>src/lib/areaCalc.ts</InlineCode> own this math.
        </Callout>
      </SubSection>

      <SubSection title="The workflow">
        <ol className="list-decimal pl-6 space-y-1 text-[13px]">
          <li>
            Open <InlineCode>QTO → Area</InlineCode>.
          </li>
          <li>
            Calibrate the page scale (<strong>Set Scale</strong> → click two
            points → enter distance + unit). Without calibration the areas still
            render but the quantity column will say &quot;page units&quot;
            instead of a real measurement.
          </li>
          <li>
            Create an area item (name, color) or click an existing one to make
            it the active target.
          </li>
          <li>
            Click the <strong>Bucket Fill</strong> button to arm. Pick a
            resolution on the slider (1k / 2k / 3k / 4k).
          </li>
          <li>
            Click inside the room you want to measure. The worker runs; you see
            the preview overlay appear.
          </li>
          <li>
            If the fill leaked through an open doorway, toggle{" "}
            <strong>Barrier</strong> mode. Click two points to draw a virtual
            wall. Click inside the room again. Repeat until the fill is sealed.
          </li>
        </ol>
      </SubSection>

      <SubSection title="Holes work natively (courtyards, light wells)">
        <p>
          For U-shaped rooms and hallways enclosing a courtyard, the worker
          runs <InlineCode>findHoleBorders()</InlineCode> after the outer
          contour trace. Each hole is simplified separately with Douglas&ndash;
          Peucker. The preview overlay uses <InlineCode>fill-rule=&quot;evenodd&quot;</InlineCode>{" "}
          so the courtyard renders as a true hole rather than a filled island,
          and <InlineCode>computeRealArea()</InlineCode> subtracts the hole
          areas from the outer polygon.
        </p>
      </SubSection>

      <SubSection title="Server fallback">
        <p>
          When the client worker fails (very old browser, extremely large
          images, corrupted ImageBitmap), the viewer falls back to the server
          path: <InlineCode>POST /api/bucket-fill</InlineCode> →{" "}
          <InlineCode>src/lib/bucket-fill.ts</InlineCode> →{" "}
          <InlineCode>scripts/bucket_fill.py</InlineCode> (Python OpenCV). The
          server path predates the Web Worker and uses an adaptive-threshold
          algorithm rather than Otsu, so its results can differ on low-contrast
          images. It&apos;s a safety net, not the preferred path.
        </p>
        <CodeBlock lang="json" caption="BucketFillResult — same shape for worker and server">
{`{
  "type": "result",
  "polygon": [{ "x": 0.142, "y": 0.388 }, ...],
  "holes": [[{ "x": 0.32, "y": 0.51 }, ...]],   // evenodd-compatible
  "vertexCount": 24,
  "areaFraction": 0.017,     // decorative — use computeRealArea()
  "retryHistory": [...]      // present only when worker retried
}`}
        </CodeBlock>
      </SubSection>

      <SubSection title="Scale calibration and computeRealArea">
        <p>
          Bucket Fill returns a polygon in normalized 0&ndash;1 coordinates. To
          turn that into square feet, BP needs two pieces of information: the
          scale calibration for the current page, and the page&apos;s pixel
          dimensions. <InlineCode>src/lib/areaCalc.ts</InlineCode> runs{" "}
          <InlineCode>computeRealArea(vertices, pageWidth, pageHeight,
          calibration)</InlineCode> &mdash; shoelace formula in pixel space,
          divided by the calibration&apos;s pixels-per-unit, returning a real
          area in the calibrated unit. Holes are subtracted. Supported units:
        </p>
        <Figure kind="live" caption="The four base units from AreaTab.tsx AREA_UNITS." size="sm">
          <AreaUnitChipDemo />
        </Figure>
        <Callout variant="warn" title="Calibration is per-page">
          If you calibrate a scale on one page and then reuse an area item on a
          different page, the new polygon inherits the area item&apos;s color
          and name but <strong>not</strong> its scale. You&apos;ll need to
          recalibrate &mdash; most sheet sets use different scales per
          discipline. The viewer will show a warning chip next to polygons on
          uncalibrated pages.
        </Callout>
      </SubSection>

      <SubSection title="How it composes with the rest of QTO">
        <p>
          Bucket Fill is not a feature on its own &mdash; it&apos;s an input
          method into the Area tab of the takeoff panel. Once the polygon is
          created, it behaves like any other area takeoff entry: the underlying{" "}
          <InlineCode>annotations</InlineCode> row has{" "}
          <InlineCode>source = &quot;takeoff&quot;</InlineCode>, the group
          rollup appears in the QTO panel, the item can be edited, re-colored,
          moved between groups, or exported to CSV with the rest of the project.
          This is the design pattern the whole tool lives on: new capabilities
          stack on top of existing ones. Bucket Fill adds a fast path to create
          area polygons; everything downstream (aggregation, grouping, export)
          is unchanged.
        </p>
      </SubSection>
    </Section>
  );
}
