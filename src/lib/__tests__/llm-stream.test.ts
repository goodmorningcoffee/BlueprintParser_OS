// @vitest-environment node
// [refactor jun13 P0.5-G2] Regression net for the global-chat history loss:
// chat_messages.project_id was NOT NULL and global chat passed 0 → the insert
// at the end of streamChatResponse threw AFTER the answer had fully streamed,
// the catch appended an error event to a good response, and the assistant
// message was never saved. Freezes: null projectId persists (NULL = global
// chat), stream carries no error event, [DONE] still terminates the stream.
import { describe, expect, inject, it, vi } from "vitest";

vi.mock("@/lib/llm/index", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/lib/llm/index")>();
  return {
    ...orig,
    createLLMClient: () => ({
      streamChat: async function* () {
        yield "g2-global-chat ";
        yield "persists";
      },
    }),
  };
});

import { streamChatResponse } from "@/lib/llm/stream";
import { db } from "@/lib/db";
import { chatMessages } from "@/lib/db/schema";
import { desc, isNull } from "drizzle-orm";
import type { ResolvedLLMConfig } from "@/lib/llm/types";

const dbUp = inject("dbUp") as boolean;

const config = {
  provider: "openai",
  model: "test-model",
  apiKey: "test-key",
} as ResolvedLLMConfig;

describe.skipIf(!dbUp)("streamChatResponse with null projectId (global chat)", () => {
  it("streams cleanly and persists the assistant message with projectId NULL", async () => {
    const res = streamChatResponse(
      config,
      [{ role: "user", content: "hi" }],
      null, // ← global chat; was 0 before G2 (FK violation)
      null,
      null,
    );
    const sse = await new Response(res.body).text(); // drain = insert ran

    expect(sse).toContain("g2-global-chat");
    expect(sse).toContain("data: [DONE]");
    expect(sse).not.toContain('"error"'); // the old failure appended one

    const [row] = await db
      .select()
      .from(chatMessages)
      .where(isNull(chatMessages.projectId))
      .orderBy(desc(chatMessages.id))
      .limit(1);
    expect(row).toBeTruthy();
    expect(row.content).toBe("g2-global-chat persists");
    expect(row.projectId).toBeNull();
    expect(row.role).toBe("assistant");
  });
});
