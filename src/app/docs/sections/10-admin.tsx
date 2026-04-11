import { Section } from "../_components/Section";
import { SubSection } from "../_components/SubSection";
import { Figure } from "../_components/Figure";
import { InlineCode } from "../_components/InlineCode";
import { Callout } from "../_components/Callout";
import { TableEl } from "../_components/TableEl";

export function Section10Admin() {
  return (
    <Section id="admin" eyebrow="Operations" title="Admin Dashboard">
      <p>
        The admin dashboard at <InlineCode>/admin</InlineCode> is where every
        company-level tuning knob lives: YOLO model management, CSI detection
        thresholds, heuristic rules, LLM provider configuration, user and
        invite management, pipeline concurrency, text-annotation detector
        toggles, and root-admin-only settings. It is deliberately flat &mdash;
        14 tabs across the top of one page &mdash; rather than hidden behind
        wizards, because the intended audience is technical.
      </p>

      <SubSection title="The 14 tabs">
        <TableEl
          headers={["Tab", "What it controls", "Backing route(s)"]}
          rows={[
            [
              <strong key="o">Overview</strong>,
              "System health snapshot: recent parses, running jobs, disk usage, quotas.",
              <span key="oa" className="font-mono text-xs">
                /api/admin/parser-health, /api/admin/recent-parses, /api/admin/running-jobs
              </span>,
            ],
            [
              <strong key="p">Projects</strong>,
              "Every project in the company. Filter by status, bulk re-trigger processing, delete.",
              <span key="pa" className="font-mono text-xs">
                /api/admin/reprocess, /api/projects/[id]
              </span>,
            ],
            [
              <strong key="am">AI Models</strong>,
              "Upload and register YOLO models. Run SageMaker Processing jobs. Configure the LLM provider + default model. House the sagemakerEnabled kill switch + quota. (See Section 05 for the run path.)",
              <span key="ama" className="font-mono text-xs">
                /api/admin/models, /api/yolo/run, /api/admin/llm-config, /api/admin/toggles
              </span>,
            ],
            [
              <strong key="u">Users</strong>,
              "Per-company user list, invites, password resets, canRunModels grants.",
              <span key="ua" className="font-mono text-xs">
                /api/admin/invites, /api/admin/users/reset-password
              </span>,
            ],
            [
              <strong key="c">Companies</strong>,
              "Root admin only. Create companies, assign root admin, configure pipelineConfig per company (CSI thresholds, heuristics, pageConcurrency, csiSpatialGrid).",
              <span key="ca" className="font-mono text-xs">
                /api/admin/companies (root only)
              </span>,
            ],
            [
              <strong key="csi">CSI</strong>,
              "Company CSI detection config (threshold + tier weights), custom CSI database upload, re-run CSI on all annotations after a database change.",
              <span key="csa" className="font-mono text-xs">
                /api/admin/csi/config, /api/admin/csi/upload, /api/admin/models/reprocess-csi
              </span>,
            ],
            [
              <strong key="h">Heuristics</strong>,
              "Built-in rules (enable/disable) + custom rules. Each rule supports text keywords, yoloRequired, yoloBoosters, spatial conditions, output labels, output CSI codes.",
              <span key="ha" className="font-mono text-xs">/api/admin/heuristics/config</span>,
            ],
            [
              <strong key="tp">Table Parse</strong>,
              "Tuning defaults for Auto Parse, Guided Parse propose endpoints. Controls rowTolerance, minColGap, minHitsRatio defaults per company.",
              <span key="tpa" className="font-mono text-xs">Same pipelineConfig fields</span>,
            ],
            [
              <strong key="pi">Page Intelligence</strong>,
              "Classifier tuning, cross-ref detector config. Test on specific pages.",
              <span key="pia" className="font-mono text-xs">/api/admin/pipeline</span>,
            ],
            [
              <strong key="ta">Text Annotations</strong>,
              "Enable/disable the 10 detector modules, view counts, configure regex patterns for custom detectors.",
              <span key="taa" className="font-mono text-xs">/api/admin/text-annotations/config</span>,
            ],
            [
              <strong key="ai">AI RBAC</strong>,
              "Per-role tool access control. Lock individual LLM tools out of non-admin roles.",
              <span key="aia" className="font-mono text-xs">llm_configs + role table</span>,
            ],
            [
              <strong key="lc">LLM Context</strong>,
              "Section registry enable/disable, priority overrides, preset (balanced / structured / verbose), system prompt, domain knowledge, per-section telemetry.",
              <span key="lca" className="font-mono text-xs">/api/admin/llm-config, pipelineConfig.llm</span>,
            ],
            [
              <strong key="pip">Pipeline</strong>,
              "pageConcurrency (default 8), csiSpatialGrid (default 9×9), queue visibility.",
              <span key="pipa" className="font-mono text-xs">/api/admin/pipeline</span>,
            ],
            [
              <strong key="s">Settings</strong>,
              "App settings, feature flags, non-sensitive env var reveal. Root admin only.",
              <span key="sa" className="font-mono text-xs">/api/admin/app-settings (root)</span>,
            ],
          ]}
        />
      </SubSection>

      <SubSection title="Root admin vs company admin">
        <p>
          BP is multi-tenant at the row level. Every user-visible table carries
          a <InlineCode>company_id</InlineCode>, and every{" "}
          <InlineCode>/api/admin/*</InlineCode> route runs a row-scope check in{" "}
          <InlineCode>src/lib/audit.ts</InlineCode> before reading or writing.
          A company admin sees their own company&apos;s projects, users, CSI
          config, heuristics, and LLM configs &mdash; nothing cross-company.
        </p>
        <p>
          A <strong>root admin</strong> (a user with{" "}
          <InlineCode>isRootAdmin = true</InlineCode>) bypasses company scoping.
          Root admins can create new companies, assign root admins, edit any
          company&apos;s pipelineConfig, reveal global app settings, and flip
          the sagemakerEnabled toggle on any company. There is intentionally no
          UI for &quot;become root admin&quot; &mdash; the bit is set directly
          in the database by a system operator.
        </p>
        <Callout variant="warn" title="Destructive admin toggles require a password">
          The <InlineCode>sagemakerEnabled</InlineCode> toggle and the quota
          kill switch both require an admin password stored in{" "}
          <InlineCode>app_settings</InlineCode>. The password check is enforced
          in <InlineCode>/api/admin/toggles</InlineCode>. This is a belt-and-
          suspenders precaution on top of the RBAC &mdash; destructive toggles
          shouldn&apos;t be one forgotten session away from flipping.
        </Callout>
      </SubSection>

      <SubSection title="Visual reference">
        <Figure
          kind="shot"
          src="/docs/shots/admin-overview.png"
          alt="Admin Overview tab showing recent parses, running jobs, and system health"
          caption="Admin → Overview. Recent parses on the left, running jobs on the right, per-company quota readouts across the top."
          frame="page"
          size="full"
        />
        <Figure
          kind="shot"
          src="/docs/shots/admin-heuristics.png"
          alt="Admin Heuristics tab showing built-in rules and a custom rule editor"
          caption="Admin → Heuristics. Built-in rules toggleable on the left; a custom rule editor on the right with JSON input for text keywords, YOLO requirements, spatial conditions, and output CSI codes."
          frame="page"
          size="full"
        />
        <Figure
          kind="shot"
          src="/docs/shots/admin-csi-config.png"
          alt="Admin CSI tab with threshold sliders and custom database upload"
          caption="Admin → CSI. Threshold and tier-weight sliders on top; custom database upload (TSV) below; re-process CSI button on the right."
          frame="page"
          size="full"
        />
      </SubSection>
    </Section>
  );
}
