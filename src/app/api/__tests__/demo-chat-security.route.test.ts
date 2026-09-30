// @vitest-environment node
// L5 freeze-first oracle for the anonymous cross-demo RAG endpoint: streaming is compute-only and
// must not create user, assistant, or tool-authored rows.
import { beforeEach, describe, expect, inject, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  checkDemoChatQuota: vi.fn(),
  resolveLLMConfig: vi.fn(),
  createLLMClient: vi.fn(),
}));

// The route now imports the demo feature gate, which reaches @/lib/auth through api-utils.
vi.mock("@/lib/auth", async () => {
  const { sessionState } = await import("@/test/harness");
  return { auth: async () => sessionState.current };
});
vi.mock("@/lib/quotas", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/quotas")>()),
  checkDemoChatQuota: h.checkDemoChatQuota,
}));
vi.mock("@/lib/llm/resolve", () => ({ resolveLLMConfig: h.resolveLLMConfig }));
vi.mock("@/lib/llm", async () => ({
  createLLMClient: h.createLLMClient,
  LLMError: (await import("@/lib/llm/types")).LLMError,
}));

import { POST } from "@/app/api/demo/chat/route";
import { db } from "@/lib/db";
import { chatMessages } from "@/lib/db/schema";
import { createPage, createWorld, makeReq, publishDemoFixture } from "@/test/harness";

const dbUp = inject("dbUp") as boolean;

beforeEach(() => {
  vi.clearAllMocks();
  h.checkDemoChatQuota.mockResolvedValue({ allowed: true });
  h.resolveLLMConfig.mockResolvedValue({
    provider: "groq",
    model: "demo-model",
    apiKey: "test-key",
  });
  h.createLLMClient.mockReturnValue({
    provider: "groq",
    streamChat: async function* () {
      yield "Public demo answer";
    },
  });
});

describe.skipIf(!dbUp)("POST /api/demo/chat security policy", () => {
  it("L5 freeze: drains a successful stream with zero chat-message persistence", async () => {
    const { project } = await createWorld({ status: "completed" });
    await createPage(project.id, 1, { rawText: "Public demo OCR" });
    await publishDemoFixture(project.id);
    const before = await db.select().from(chatMessages);

    const response = await POST(
      makeReq("/api/demo/chat", { method: "POST", body: { message: "What is shown?" } }),
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("data: [DONE]");

    const after = await db.select().from(chatMessages);
    expect(after).toEqual(before);
  });
});

// [hardening sep30] Anonymous input to a paid provider. Every refusal below must be free:
// no quota unit consumed, no provider call.
describe("POST /api/demo/chat input bounds", () => {
  const post = (body: string) =>
    POST(
      new Request("http://test.local/api/demo/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      }),
    );

  it("message over 2000 characters → 400", async () => {
    const response = await post(JSON.stringify({ message: "x".repeat(2001) }));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "message too long (max 2000 characters)" });
    expect(h.checkDemoChatQuota).not.toHaveBeenCalled();
    expect(h.createLLMClient).not.toHaveBeenCalled();
  });

  it("body over 16 KB → 413", async () => {
    const response = await post(JSON.stringify({ message: "hi", pad: "x".repeat(17_000) }));
    expect(response.status).toBe(413);
    expect(h.checkDemoChatQuota).not.toHaveBeenCalled();
  });

  it("malformed JSON → 400, not a 500", async () => {
    const response = await post("{not json");
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Invalid JSON body" });
    expect(h.checkDemoChatQuota).not.toHaveBeenCalled();
  });
});
