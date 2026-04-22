import { Section } from "../_components/Section";
import { SubSection } from "../_components/SubSection";
import { InlineCode } from "../_components/InlineCode";
import { Callout } from "../_components/Callout";
import { ApiEndpointList } from "../_components/demos/ApiEndpointList";

export function Section13ApiReference() {
  return (
    <Section id="api-reference" eyebrow="Operations" title="API Reference">
      {/* Plain-English lead */}
      <div className="max-w-3xl text-[15px] text-[var(--fg)]/80 leading-relaxed border-l-2 border-[var(--accent)]/40 pl-4 py-1 mb-4">
        In plain English: everything the viewer does &mdash; uploading a
        project, running YOLO, chatting with the LLM, exporting a takeoff
        &mdash; goes through an HTTP endpoint here. This page lists every one,
        grouped by domain, so you can find where in the code each button talks
        to the server.
      </div>

      <p>
        BP exposes roughly 91 HTTP endpoints from Next.js API routes. This
        reference groups them by domain, with a one-line description for each.
        Click a method/path row to expand parameters and examples where provided.
        This is not an OpenAPI spec &mdash; for machine-readable schemas,{" "}
        <InlineCode>src/lib/llm/tools.ts</InlineCode> has JSON Schemas for the
        LLM tool surface, which is the most formally typed set of endpoints.
      </p>

      <Callout variant="info" title="Auth model">
        Unless marked <InlineCode>public</InlineCode>, every endpoint requires a
        valid NextAuth session. Routes marked <InlineCode>admin</InlineCode>{" "}
        additionally check <InlineCode>user.isAdmin || user.isRootAdmin</InlineCode>.
        Routes marked <InlineCode>root</InlineCode> require{" "}
        <InlineCode>isRootAdmin</InlineCode>. Destructive admin toggles require
        an <em>additional</em> admin password stored in{" "}
        <InlineCode>app_settings</InlineCode> and checked at the route level in{" "}
        <InlineCode>/api/admin/toggles</InlineCode>. All authenticated routes
        enforce row-level multi-tenant scoping through{" "}
        <InlineCode>src/lib/audit.ts</InlineCode>.
      </Callout>

      <SubSection title="Endpoint catalog">
        <ApiEndpointList />
      </SubSection>

      <SubSection title="Notes on specific routes">
        <p>
          A few routes need extra context beyond the short description:
        </p>
        <ul className="list-disc pl-5 space-y-2 text-[13px]">
          <li>
            <InlineCode>POST /api/ai/chat</InlineCode> is Server-Sent Events,
            not request/response. The response stream yields <InlineCode>data:</InlineCode>{" "}
            lines encoding a sequence of{" "}
            <InlineCode>{"{ type: \"text_delta\" | \"tool_call_start\" | \"tool_call_result\" | \"done\" }"}</InlineCode>{" "}
            events. The client reads them as they arrive. <InlineCode>DELETE</InlineCode>{" "}
            on the same path clears the scoped conversation history.
          </li>
          <li>
            <InlineCode>POST /api/yolo/run</InlineCode> is the only way to
            trigger YOLO inference. The request body is{" "}
            <InlineCode>{"{ projectId, modelId }"}</InlineCode> and the response
            returns the SageMaker execution ID. Watch it via{" "}
            <InlineCode>GET /api/yolo/status</InlineCode>. Results ingest via
            the webhook.
          </li>
          <li>
            <InlineCode>POST /api/processing/webhook</InlineCode> is the
            callback surface for Step Functions and SageMaker. Requests are
            HMAC-SHA256 signed with the{" "}
            <InlineCode>PROCESSING_WEBHOOK_SECRET</InlineCode> from Secrets
            Manager. Unsigned or mis-signed requests are rejected.
          </li>
          <li>
            <InlineCode>POST /api/projects/[id]/map-tags-batch</InlineCode> is
            the heavy-lifter for Auto-QTO. It takes a parsed schedule&apos;s
            tag column, a target YOLO class (or a free-floating-text marker),
            and runs the mapping across the entire project at once. Expect it
            to take several seconds for large projects.
          </li>
          <li>
            <InlineCode>POST /api/bucket-fill</InlineCode> returns a polygon in
            normalized 0&ndash;1 coordinates, not the image space. The viewer
            converts to canvas coordinates at render time; areaCalc.ts converts
            to real-world units using the page&apos;s scale calibration.
          </li>
          <li>
            <InlineCode>POST /api/csi/detect</InlineCode> is the public entry
            point to the 3-tier CSI matcher (see Section 04). Accepts a{" "}
            <InlineCode>text</InlineCode> string in the body, returns an array
            of matches with codes, descriptions, divisions, trades, and
            confidence scores.
          </li>
          <li>
            <InlineCode>/api/demo/*</InlineCode> is a parallel, read-only
            mirror of the project and search routes that does not require auth.
            These are what power the <InlineCode>/demo</InlineCode> route and
            the docs page&apos;s live component demos.
          </li>
        </ul>
      </SubSection>

      <SubSection title="Where to read the source">
        <p>
          Every endpoint in the catalog above maps to a file under{" "}
          <InlineCode>src/app/api/**/route.ts</InlineCode>. The Next.js App Router
          uses directory-based routing, so{" "}
          <InlineCode>/api/csi/detect</InlineCode> is{" "}
          <InlineCode>src/app/api/csi/detect/route.ts</InlineCode> and{" "}
          <InlineCode>/api/projects/[id]/map-tags-batch</InlineCode> is{" "}
          <InlineCode>src/app/api/projects/[id]/map-tags-batch/route.ts</InlineCode>.
          Each file exports HTTP method handlers (<InlineCode>GET</InlineCode>,{" "}
          <InlineCode>POST</InlineCode>, etc.) and most hand off immediately to
          helper functions in <InlineCode>src/lib/</InlineCode>. Handlers are
          thin by design &mdash; the real logic lives in{" "}
          <InlineCode>lib/</InlineCode> and is unit-tested.
        </p>
      </SubSection>
    </Section>
  );
}
