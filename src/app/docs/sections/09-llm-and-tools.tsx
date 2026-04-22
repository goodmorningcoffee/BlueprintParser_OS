import { Section } from "../_components/Section";
import { SubSection } from "../_components/SubSection";
import { Figure } from "../_components/Figure";
import { InlineCode } from "../_components/InlineCode";
import { Callout } from "../_components/Callout";
import { CodeBlock } from "../_components/CodeBlock";
import { TableEl } from "../_components/TableEl";
import { ToolCardGrid } from "../_components/demos/ToolCardGrid";
import { AgenticLoopDiagram } from "../_components/demos/AgenticLoopDiagram";
import { ContextBudgetTable } from "../_components/demos/ContextBudgetTable";
import { SectionPrioritySliders } from "../_components/demos/SectionPrioritySliders";

export function Section09LlmAndTools() {
  return (
    <Section id="llm-and-tools" eyebrow="Engines" title="The LLM Loop: Tool-Making, Agentic Rounds, Context Budgets">
      {/* Plain-English lead */}
      <div className="max-w-3xl text-[15px] text-[var(--fg)]/80 leading-relaxed border-l-2 border-[var(--accent)]/40 pl-4 py-1 mb-4">
        In plain English: you can chat with your project. The model can&apos;t
        read the whole PDF directly &mdash; it&apos;s too big &mdash; so BP
        gives it 20 tools that query pre-computed structured data (CSI codes,
        schedules, detections, text search). The model calls tools in rounds,
        up to ten times, until it can answer. Which tools it has, what order it
        prefers them in, and how much context it starts with are all tunable
        per company.
      </div>

      <p>
        BP&apos;s LLM integration is the payoff for everything in sections 3–8.
        The preprocessing pipeline builds structured data, CSI encodes it
        compactly, YOLO makes it spatially aware, Auto-QTO materializes quantities.
        The LLM loop is what a user actually talks to, and it reaches into all of
        that structured data through a tool set, an agentic round loop, and a
        per-model context budget. This is the densest section in the docs &mdash;
        there&apos;s a lot happening under the hood.
      </p>

      <SubSection title="The framing">
        <p>
          A blueprint LLM has a fundamental problem: it can&apos;t read the PDF.
          Even if you chunk a 200-page drawing set into text, the raw OCR is too
          noisy (page numbers, dimensions, plot stamps, revision blocks) and too
          long to fit into a context window while leaving room for reasoning. BP
          solves this by inverting the flow:
        </p>
        <ol className="list-decimal pl-6 space-y-1 text-[13px]">
          <li>
            <strong>The LLM does not see the blueprint directly.</strong> What it
            sees is a compact structured summary built by the context builder.
          </li>
          <li>
            <strong>The LLM gets tools.</strong> Twenty of them &mdash; the
            full BP_TOOLS set. They query the pre-computed structured data, run
            BP engines on arbitrary inputs, and (for a small subset) drive the
            viewer. Tools are what give the model leverage.
          </li>
          <li>
            <strong>Tools compose inside an agentic loop.</strong> The model can
            call multiple tools in parallel per round, feed results back, and
            iterate up to ten rounds per turn before being forced to answer.
          </li>
          <li>
            <strong>Context budgets are per-model.</strong> A Sonnet call gets
            a very different slice of data than a Groq call. Admins can override
            priorities per-company via a preset system.
          </li>
        </ol>
        <p>
          The &quot;LLM tool making&quot; story the user gets isn&apos;t a
          feature in the UI &mdash; it&apos;s the shape of the tool registry in{" "}
          <InlineCode>src/lib/llm/tools.ts</InlineCode> and the pattern you use
          when adding a new tool: write a tool definition with a JSON Schema input,
          write an executor, flip a switch in{" "}
          <InlineCode>executeToolCall()</InlineCode>, and the model can call it on
          the next request. The next subsection enumerates all twenty.
        </p>
      </SubSection>

      <SubSection title="The 20 tools">
        <p>
          Every tool in <InlineCode>BP_TOOLS</InlineCode> gets a card below,
          pulled live from <InlineCode>src/lib/llm/tools.ts</InlineCode>. Filter
          by group. Action tools (the ones that mutate data or drive the viewer)
          are marked amber so the distinction between &quot;read&quot; and
          &quot;write&quot; is visually obvious.
        </p>
        <Figure
          kind="live"
          caption="ToolCardGrid — all 20 tools from BP_TOOLS. Data is read directly from tools.ts."
          size="full"
        >
          <ToolCardGrid />
        </Figure>
      </SubSection>

      <SubSection title="Why these particular tools exist">
        <p>
          The set is small by design. Each tool corresponds to one of the
          structured surfaces BP already maintains, rather than being a
          low-level primitive the model has to compose. An LLM given 20
          purpose-built tools will pick the right one faster than one given 80
          composable primitives.
        </p>
        <ul className="list-disc pl-5 space-y-1 text-[13px]">
          <li>
            <strong>Navigation tools</strong> &mdash;{" "}
            <InlineCode>getProjectOverview</InlineCode>,{" "}
            <InlineCode>getPageDetails</InlineCode>,{" "}
            <InlineCode>lookupPagesByIndex</InlineCode>,{" "}
            <InlineCode>getCrossReferences</InlineCode> &mdash; answer &quot;where
            is&quot; questions without paging through pages.
          </li>
          <li>
            <strong>Structured reads</strong> &mdash;{" "}
            <InlineCode>getAnnotations</InlineCode>,{" "}
            <InlineCode>getParsedSchedule</InlineCode>,{" "}
            <InlineCode>getCsiSpatialMap</InlineCode>,{" "}
            <InlineCode>getSpatialContext</InlineCode> &mdash; pull a single
            structured chunk at a time, so the model can ask for exactly what it
            needs.
          </li>
          <li>
            <strong>Text fallback</strong> &mdash;{" "}
            <InlineCode>searchPages</InlineCode> and{" "}
            <InlineCode>getPageOcrText</InlineCode> let the model hit raw OCR
            only when structured data is insufficient. Raw OCR sits at priority
            10 in the context builder for the same reason: last resort.
          </li>
          <li>
            <strong>Engine invocation</strong> &mdash;{" "}
            <InlineCode>detectCsiFromText</InlineCode> lets the model run the 3-tier
            CSI matcher on a user&apos;s phrase.{" "}
            <InlineCode>detectTagPatterns</InlineCode> runs the tag-pattern
            detector. Tools can wrap BP engines so the model can do analysis on
            the fly.
          </li>
          <li>
            <strong>YOLO tag tools</strong> &mdash;{" "}
            <InlineCode>scanYoloClassTexts</InlineCode>,{" "}
            <InlineCode>mapTagsToPages</InlineCode>,{" "}
            <InlineCode>getOcrTextInRegion</InlineCode> &mdash; bridge between
            OCR text and YOLO regions. These are what let the model answer
            &quot;how many doors have a 90-minute fire rating on the second
            floor&quot; by joining schedule rows to shape detections.
          </li>
          <li>
            <strong>Action tools (amber)</strong> &mdash;{" "}
            <InlineCode>navigateToPage</InlineCode>,{" "}
            <InlineCode>highlightRegion</InlineCode>,{" "}
            <InlineCode>createMarkup</InlineCode>,{" "}
            <InlineCode>addNoteToAnnotation</InlineCode>,{" "}
            <InlineCode>batchAddNotes</InlineCode>. The viewer interprets these
            as side effects. The model can say &quot;show me page 42&quot; and
            the viewer actually scrolls there.
          </li>
        </ul>
      </SubSection>

      <SubSection title="The agentic loop">
        <p>
          BP&apos;s chat endpoint (<InlineCode>POST /api/ai/chat</InlineCode>)
          invokes <InlineCode>streamChatWithTools()</InlineCode> on the configured
          adapter. All three SDK adapters (<InlineCode>anthropic.ts</InlineCode>,{" "}
          <InlineCode>openai.ts</InlineCode>, <InlineCode>groq.ts</InlineCode>)
          implement the same interface:
        </p>
        <CodeBlock lang="ts" caption="src/lib/llm/anthropic.ts — streamChatWithTools (abridged)">
{`async *streamChatWithTools(options: LLMToolUseOptions): AsyncIterable<ToolStreamEvent> {
  const maxRounds = options.maxToolRounds ?? 10;
  const tools: Tool[] = options.tools.map(toAnthropicShape);
  const msgHistory = prepareMessages(options.messages);

  for (let round = 0; round < maxRounds; round++) {
    const stream = await client.messages.stream({ model, system, messages: msgHistory, tools, ... });

    for await (const event of stream) {
      if (event.type === "content_block_delta" && event.delta.type === "text_delta")
        yield { type: "text_delta", text: event.delta.text };
      else if (event.type === "content_block_start" && event.content_block.type === "tool_use")
        yield { type: "tool_call_start", name: event.content_block.name, id: event.content_block.id };
    }

    const finalMsg = await stream.finalMessage();
    const toolUseBlocks = finalMsg.content.filter(b => b.type === "tool_use");

    if (toolUseBlocks.length === 0 || finalMsg.stop_reason !== "tool_use") {
      yield { type: "done" };
      return;
    }

    const toolResults = [];
    for (const block of toolUseBlocks) {
      const result = await options.executeToolCall(block.name, block.input);
      yield { type: "tool_call_result", name: block.name, id: block.id, result: JSON.stringify(result) };
      toolResults.push({ type: "tool_result", tool_use_id: block.id, content: JSON.stringify(result) });
    }

    msgHistory.push({ role: "assistant", content: finalMsg.content });
    msgHistory.push({ role: "user", content: toolResults });
  }

  yield { type: "text_delta", text: "\\n\\n(Reached maximum tool call rounds)" };
  yield { type: "done" };
}`}
        </CodeBlock>
        <Figure
          kind="live"
          caption="AgenticLoopDiagram — the text/tool_call flow. Text deltas stream as they arrive; tool calls are batched at round boundaries."
          size="full"
        >
          <AgenticLoopDiagram />
        </Figure>
        <p>
          The key behaviors to notice: text deltas stream live (the user sees
          the response materialize a word at a time); tool calls don&apos;t
          block the stream (the model&apos;s reasoning text shows up before the
          tools execute); each round&apos;s tool calls run in parallel before
          the next LLM turn starts; the loop terminates as soon as{" "}
          <InlineCode>stop_reason !== &quot;tool_use&quot;</InlineCode> or after
          10 rounds, whichever comes first. On Opus-sized models, 3 rounds is
          typical; 10 is a safety cap, not an expected value.
        </p>
      </SubSection>

      <SubSection title="Context budgets per model">
        <p>
          Before the loop even starts, the server calls{" "}
          <InlineCode>assembleContextWithConfig()</InlineCode> in{" "}
          <InlineCode>src/lib/context-builder.ts</InlineCode>. The function takes
          a list of candidate sections (CSI codes, classification, annotations,
          parsed tables, etc.), sorts them by priority, and packs them into a
          character budget chosen for the current model. Bigger-window models
          get more context; smaller free-tier models stay lean to leave room for
          tool rounds.
        </p>
        <Figure
          kind="live"
          caption="Character budgets per model. Numbers are verbatim from getContextBudget() in src/lib/context-builder.ts."
          size="full"
        >
          <ContextBudgetTable />
        </Figure>
        <p>
          The fallback default is <InlineCode>DEFAULT_CONTEXT_BUDGET = 24000</InlineCode>{" "}
          characters &mdash; ~6000 tokens &mdash; which is what unknown providers
          and unknown models get.
        </p>
      </SubSection>

      <SubSection title="Section registry and presets">
        <p>
          <InlineCode>SECTION_REGISTRY</InlineCode> enumerates the 20 sections
          the context builder can assemble into a page- or project-scope prompt.
          Each has a default priority (lower = earlier, higher priority) and a
          description. At run time the builder sorts by priority, computes per-
          section budgets from the admin&apos;s preset or per-company overrides,
          fills each section to its budget, and truncates anything that
          overflows. Unused allocations flow into an overflow pool so the next
          section can use the slack.
        </p>
        <Figure
          kind="live"
          caption="Default priorities from SECTION_REGISTRY. Lower = higher priority. Admins can override these per-company."
          size="full"
        >
          <SectionPrioritySliders />
        </Figure>
        <p>There are three presets in <InlineCode>SECTION_PRESETS</InlineCode>:</p>
        <TableEl
          headers={["Preset", "Shape", "When to use"]}
          rows={[
            [
              <strong key="1">balanced</strong>,
              "Equal-share allocation across every enabled section. Simple and predictable.",
              "Default for general-purpose chat. Unopinionated.",
            ],
            [
              <strong key="2">structured</strong>,
              <span key="2b">
                Front-loads <InlineCode>parsed-tables</InlineCode> (25%),{" "}
                <InlineCode>spatial-context</InlineCode> (12%),{" "}
                <InlineCode>csi-codes</InlineCode> (11%),{" "}
                <InlineCode>yolo-counts</InlineCode> (10%),{" "}
                <InlineCode>csi-spatial</InlineCode> (9%),{" "}
                <InlineCode>detected-regions</InlineCode> (5%),{" "}
                <InlineCode>raw-ocr</InlineCode> (1%).
              </span>,
              "When the project has well-parsed schedules and you want the model to reason from structured data, not from OCR. Best for takeoff questions.",
            ],
            [
              <strong key="3">verbose</strong>,
              <span key="3b">
                Front-loads <InlineCode>raw-ocr</InlineCode> (40%),{" "}
                <InlineCode>spatial-context</InlineCode> (15%),{" "}
                <InlineCode>parsed-tables</InlineCode> (10%).
              </span>,
              "Exploratory work on projects that aren't fully preprocessed. The model gets more text to read, at the cost of less structure.",
            ],
          ]}
        />
        <Callout variant="info" title="Global vs project vs page scope">
          Chat scope controls which registry is used. Project and page scope use{" "}
          <InlineCode>SECTION_REGISTRY</InlineCode> with 20 sections. The global
          dashboard chat (the widget on <InlineCode>/home</InlineCode>) uses{" "}
          <InlineCode>GLOBAL_SECTION_REGISTRY</InlineCode> &mdash; 6 sections
          focused on cross-project discovery (project catalog, discipline
          breakdown, CSI summary, detection counts, search results, search OCR).
          Same loop, different data surface.
        </Callout>
      </SubSection>

      <SubSection title="Provider selection">
        <p>
          The adapter is chosen by{" "}
          <InlineCode>src/lib/llm/resolve.ts</InlineCode> based on the{" "}
          <InlineCode>llm_configs</InlineCode> table and, optionally, per-user
          overrides from <InlineCode>user_api_keys</InlineCode>. The fallback
          chain is:
        </p>
        <ol className="list-decimal pl-6 space-y-1 text-[13px]">
          <li>The user&apos;s API key (from <InlineCode>user_api_keys</InlineCode>, encrypted at rest).</li>
          <li>Company-wide config from <InlineCode>llm_configs</InlineCode> (set by company admin).</li>
          <li>
            Environment variable (<InlineCode>ANTHROPIC_API_KEY</InlineCode>,{" "}
            <InlineCode>OPENAI_API_KEY</InlineCode>,{" "}
            <InlineCode>GROQ_API_KEY</InlineCode>).
          </li>
        </ol>
        <p>
          The adapter interface is identical across providers &mdash;{" "}
          <InlineCode>LLMClient</InlineCode> in{" "}
          <InlineCode>src/lib/llm/types.ts</InlineCode> defines{" "}
          <InlineCode>streamChat()</InlineCode> and{" "}
          <InlineCode>streamChatWithTools()</InlineCode>. Adding a new provider
          is a matter of writing a new file in <InlineCode>src/lib/llm/</InlineCode>{" "}
          that implements the interface and wiring it into{" "}
          <InlineCode>resolve.ts</InlineCode>. For OpenAI-compatible endpoints
          (Ollama, self-hosted vLLM, llama.cpp servers), the existing{" "}
          <InlineCode>openai.ts</InlineCode> adapter works directly &mdash; you
          set <InlineCode>provider = &quot;custom&quot;</InlineCode> and a{" "}
          <InlineCode>baseUrl</InlineCode>.
        </p>
      </SubSection>

      <SubSection title="Where to configure all of this">
        <p>
          The user-facing surface is <InlineCode>Admin → LLM Context</InlineCode>{" "}
          (<InlineCode>src/app/admin/tabs/LlmContextTab.tsx</InlineCode>). It
          exposes:
        </p>
        <ul className="list-disc pl-5 space-y-1 text-[13px]">
          <li>Enable / disable each of the 20 sections per company.</li>
          <li>Override any section&apos;s default priority.</li>
          <li>Pick a preset or set custom percent allocations.</li>
          <li>
            Inspect post-assembly section metadata (included, truncated, char
            count) &mdash; so admins can see exactly what made it into the prompt.
          </li>
          <li>
            Edit the system prompt (overrides <InlineCode>DEFAULT_SYSTEM_PROMPT</InlineCode>).
          </li>
          <li>Attach company-specific domain knowledge (free-text).</li>
        </ul>
        <p>
          The LLM provider / model picker lives next door in{" "}
          <InlineCode>Admin → AI Models → LLM Config</InlineCode>. Both pages
          write to the same set of tables and both updates take effect on the
          next chat turn (no deployment required).
        </p>
      </SubSection>
    </Section>
  );
}
