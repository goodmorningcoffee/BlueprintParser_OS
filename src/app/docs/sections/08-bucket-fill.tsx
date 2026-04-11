import { Section } from "../_components/Section";
import { SubSection } from "../_components/SubSection";
import { Figure } from "../_components/Figure";
import { InlineCode } from "../_components/InlineCode";
import { Callout } from "../_components/Callout";
import { CodeBlock } from "../_components/CodeBlock";
import { BucketFillButtonDemo } from "../_components/demos/BucketFillButtonDemo";
import { AreaUnitChipDemo } from "../_components/demos/AreaUnitChipDemo";

export function Section08BucketFill() {
  return (
    <Section id="bucket-fill" eyebrow="Engines" title="Bucket Fill: Click-to-Area">
      <p>
        Bucket Fill is BP&apos;s answer to the most tedious part of a manual
        takeoff: tracing polygons around rooms on a 200-page floor plan set. You
        click once inside a room, and the backend floods from that seed point,
        stops at walls (and any virtual barriers you&apos;ve drawn across open
        doorways), simplifies the resulting polygon, and hands it back as
        normalized 0&ndash;1 vertices. If the page is scale-calibrated, BP
        converts those vertices to a real-world area in the unit you chose at
        calibration time.
      </p>

      <SubSection title="Where it lives">
        <p>
          Bucket Fill is the top strip of the <strong>Area</strong> tab inside
          the QTO panel (<InlineCode>src/components/viewer/AreaTab.tsx</InlineCode>,
          lines 309&ndash;385). It appears as a tri-state button: disabled (no
          active area item), idle, active, or barrier mode. The state is
          controlled by two Zustand flags:{" "}
          <InlineCode>bucketFillActive</InlineCode> and{" "}
          <InlineCode>bucketFillBarrierMode</InlineCode>.
        </p>
        <Figure
          kind="live"
          caption="BucketFillButtonDemo — click through the four states to see the exact styling each uses."
          size="md"
        >
          <BucketFillButtonDemo />
        </Figure>
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
            Click the <strong>Bucket Fill</strong> button to arm.
          </li>
          <li>
            Click inside the room you want to measure. BP calls{" "}
            <InlineCode>POST /api/bucket-fill</InlineCode> and shows the resulting
            polygon overlay.
          </li>
          <li>
            If the room has an open doorway the fill leaked through, toggle{" "}
            <strong>Barrier</strong> mode. Click two points to draw a virtual
            wall. Then click inside the room again. Repeat until the fill is
            sealed.
          </li>
        </ol>
        <Figure
          kind="shot"
          src="/docs/shots/bucket-fill-idle.png"
          alt="Area tab with Bucket Fill button in idle state and a calibrated scale indicator"
          caption="Bucket Fill in idle state. The scale indicator at the top confirms the page is calibrated; the button is armed-ready."
          frame="panel"
          size="md"
        />
        <Figure
          kind="shot"
          src="/docs/shots/bucket-fill-active.png"
          alt="Canvas showing a newly generated bucket-fill polygon"
          caption="Bucket Fill after a successful click. The generated polygon is overlaid on the room in the color of the active area item."
          frame="viewer"
          size="lg"
        />
        <Figure
          kind="shot"
          src="/docs/shots/bucket-fill-barrier.png"
          alt="Canvas with a barrier line drawn across an open doorway"
          caption="Barrier mode. The red barrier line seals an open doorway so the subsequent fill stays inside the room."
          frame="viewer"
          size="lg"
        />
      </SubSection>

      <SubSection title="Raster vs. vector methods">
        <p>
          The Python engine (<InlineCode>scripts/bucket_fill.py</InlineCode>)
          returns one of two methods in its result JSON:{" "}
          <InlineCode>&quot;raster&quot;</InlineCode> or <InlineCode>&quot;vector&quot;</InlineCode>.
        </p>
        <ul className="list-disc pl-5 space-y-1 text-[13px]">
          <li>
            <strong>Raster</strong> &mdash; the default fallback. Runs{" "}
            <InlineCode>cv2.floodFill</InlineCode> on the 300 DPI page PNG,
            dilates the wall pixels so thin lines still block the fill,
            approximates the boundary via{" "}
            <InlineCode>cv2.findContours</InlineCode>, and simplifies the result
            with Douglas&ndash;Peucker. Always works, even on scanned images
            with no vector data.
          </li>
          <li>
            <strong>Vector</strong> &mdash; when the source PDF has a text/vector
            layer, Bucket Fill can trace walls directly from the PDF paths
            instead of from the raster. Faster and gives sharper polygons.
          </li>
        </ul>
      </SubSection>

      <SubSection title="Defaults and the API contract">
        <p>
          The TypeScript wrapper (<InlineCode>src/lib/bucket-fill.ts</InlineCode>)
          spawns <InlineCode>scripts/bucket_fill.py</InlineCode> over stdin/stdout
          JSON with a 30-second timeout. Defaults for the options:
        </p>
        <CodeBlock lang="ts" caption="src/lib/bucket-fill.ts — default BucketFillOptions">
{`const config = {
  image_path: options.imagePath,
  pdf_path: options.pdfPath,
  page_number: options.pageNumber,
  seed_x: options.seedX,                       // normalized 0-1
  seed_y: options.seedY,                       // normalized 0-1
  tolerance: options.tolerance ?? 30,          // RGB distance threshold
  dilate_px: options.dilatePx ?? 3,            // wall-pixel dilation
  simplify_epsilon: options.simplifyEpsilon ?? 0.005,  // Douglas-Peucker ε
  barriers: options.barriers ?? [],            // virtual wall segments
};`}
        </CodeBlock>
        <p>
          The request is fronted by{" "}
          <InlineCode>POST /api/bucket-fill</InlineCode> which takes the project
          id, page number, seed point (normalized), and any barriers. The
          response shape is:
        </p>
        <CodeBlock lang="json" caption="BucketFillResult">
{`{
  "type": "result",
  "method": "raster",        // or "vector"
  "vertices": [
    { "x": 0.142, "y": 0.388 },
    { "x": 0.189, "y": 0.388 },
    ...
  ],
  "vertexCount": 24,
  "areaFraction": 0.017,     // fraction of page area
  "edgesOnPage": 0           // sanity: how many vertices touched the page edge
}`}
        </CodeBlock>
        <Callout variant="info" title="edgesOnPage as a sanity check">
          If <InlineCode>edgesOnPage</InlineCode> is non-zero, the fill leaked
          out to the page border &mdash; usually means a wall is missing or too
          thin. The viewer will still render the polygon, but it&apos;s a cue to
          either add barriers or bump <InlineCode>dilatePx</InlineCode>.
        </Callout>
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
          area in the calibrated unit. The unit system supports these four:
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
