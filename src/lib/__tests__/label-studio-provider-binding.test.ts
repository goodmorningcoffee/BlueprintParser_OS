// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const originalEnv = {
  url: process.env.LABEL_STUDIO_URL,
  instanceId: process.env.LABEL_STUDIO_INSTANCE_ID,
  apiKey: process.env.LABEL_STUDIO_API_KEY,
};

function restore(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function emptyResponse(status: number): Response {
  return new Response(null, { status });
}

async function loadClient() {
  vi.resetModules();
  return import("@/lib/label-studio");
}

beforeEach(() => {
  process.env.LABEL_STUDIO_URL = "https://labels.example.test";
  process.env.LABEL_STUDIO_INSTANCE_ID = "provider-volume-v1";
  process.env.LABEL_STUDIO_API_KEY = "api-key-v1";
  vi.stubGlobal("fetch", vi.fn<typeof fetch>());
});

afterEach(() => {
  vi.unstubAllGlobals();
  restore("LABEL_STUDIO_URL", originalEnv.url);
  restore("LABEL_STUDIO_INSTANCE_ID", originalEnv.instanceId);
  restore("LABEL_STUDIO_API_KEY", originalEnv.apiKey);
});

describe("configuredLabelStudioProvider", () => {
  it("canonicalizes a safe http(s) base URL and trims only binding boundaries", async () => {
    process.env.LABEL_STUDIO_URL =
      "  HTTPS://Labels.Example.TEST:443/nested/provider///  ";
    process.env.LABEL_STUDIO_INSTANCE_ID = "  persistent volume / v1  ";
    const { configuredLabelStudioProvider } = await loadClient();

    expect(configuredLabelStudioProvider()).toEqual({
      baseUrl: "https://labels.example.test/nested/provider",
      instanceId: "persistent volume / v1",
    });

    process.env.LABEL_STUDIO_URL = "http://localhost:8080////";
    expect(configuredLabelStudioProvider().baseUrl).toBe(
      "http://localhost:8080",
    );
  });

  it.each([
    "ftp://labels.example.test",
    "https://user:secret@labels.example.test",
    "https://labels.example.test/provider?tenant=a",
    "https://labels.example.test/provider?",
    "https://labels.example.test/provider#fragment",
    "https://labels.example.test/provider#",
  ])("rejects an unsafe provider URL before fetch: %s", async (url) => {
    process.env.LABEL_STUDIO_URL = url;
    const { configuredLabelStudioProvider } = await loadClient();

    expect(() => configuredLabelStudioProvider()).toThrow(
      "Invalid Label Studio provider configuration",
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects an empty opaque instance identity", async () => {
    process.env.LABEL_STUDIO_INSTANCE_ID = " \t ";
    const { configuredLabelStudioProvider } = await loadClient();

    expect(() => configuredLabelStudioProvider()).toThrow(
      "LABEL_STUDIO_INSTANCE_ID must be set",
    );
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("immutable provider operation binding", () => {
  it("rejects config drift before every provider operation performs a fetch", async () => {
    const client = await loadClient();
    const provider = client.configuredLabelStudioProvider();
    process.env.LABEL_STUDIO_INSTANCE_ID = "replacement-volume-v2";

    const operations = [
      () => client.createProject(provider, "Example", "<View />"),
      () => client.importTasks(provider, 41, []),
      () => client.getProject(provider, 41),
      () => client.findProjectsByExactDescription(provider, "marker"),
      () => client.deleteProject(provider, 41),
    ];
    for (const operation of operations) {
      await expect(operation()).rejects.toThrow(
        "Label Studio provider binding differs from current configuration",
      );
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects a URL binding drift before auth refresh or provider fetch", async () => {
    const client = await loadClient();
    const provider = client.configuredLabelStudioProvider();
    process.env.LABEL_STUDIO_URL = "https://replacement.example.test";

    await expect(client.getProject(provider, 7)).rejects.toThrow(
      "Label Studio provider binding differs from current configuration",
    );
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("provider request policy and auth cache", () => {
  it("uses canonical provider URLs and sets redirect:error on every fetch", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ id: 1 }))
      .mockResolvedValueOnce(jsonResponse({ task_count: 1 }))
      .mockResolvedValueOnce(jsonResponse({ id: 1 }))
      .mockResolvedValueOnce(jsonResponse([]))
      .mockResolvedValueOnce(emptyResponse(204))
      .mockResolvedValueOnce(emptyResponse(200));
    const client = await loadClient();
    const provider = client.configuredLabelStudioProvider();

    await client.createProject(provider, "Example", "<View />");
    await client.importTasks(provider, 1, [
      { data: { image: "https://app.example.test/api/label-assets/grant" } },
    ]);
    await client.getProject(provider, 1);
    await client.findProjectsByExactDescription(provider, "marker");
    await client.deleteProject(provider, 1);
    await client.healthCheck();

    expect(fetchMock).toHaveBeenCalledTimes(6);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "https://labels.example.test/api/projects/",
      "https://labels.example.test/api/projects/1/import",
      "https://labels.example.test/api/projects/1/",
      "https://labels.example.test/api/projects/?search=marker&page_size=100",
      "https://labels.example.test/api/projects/1/",
      "https://labels.example.test/health",
    ]);
    for (const [, init] of fetchMock.mock.calls) {
      expect(init).toEqual(expect.objectContaining({ redirect: "error" }));
    }
  });

  it("sets redirect:error on token refresh and the bearer retry", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock
      .mockResolvedValueOnce(emptyResponse(401))
      .mockResolvedValueOnce(jsonResponse({ access: "access-v1" }))
      .mockResolvedValueOnce(jsonResponse({ id: 1 }));
    const client = await loadClient();
    const provider = client.configuredLabelStudioProvider();

    await client.getProject(provider, 1);

    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "https://labels.example.test/api/token/refresh",
      expect.objectContaining({ redirect: "error" }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      "https://labels.example.test/api/projects/1/",
      expect.objectContaining({
        redirect: "error",
        headers: expect.objectContaining({ Authorization: "Bearer access-v1" }),
      }),
    );
  });

  it("does not reuse bearer auth after the API token changes", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock
      .mockResolvedValueOnce(emptyResponse(401))
      .mockResolvedValueOnce(jsonResponse({ access: "access-v1" }))
      .mockResolvedValueOnce(jsonResponse({ id: 1 }))
      .mockResolvedValueOnce(jsonResponse({ id: 2 }));
    const client = await loadClient();
    const provider = client.configuredLabelStudioProvider();

    await client.getProject(provider, 1);
    process.env.LABEL_STUDIO_API_KEY = "api-key-v2";
    await client.getProject(provider, 2);

    expect(fetchMock).toHaveBeenNthCalledWith(
      4,
      "https://labels.example.test/api/projects/2/",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Token api-key-v2" }),
      }),
    );
  });

  it("does not reuse bearer auth across configured provider instances", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock
      .mockResolvedValueOnce(emptyResponse(401))
      .mockResolvedValueOnce(jsonResponse({ access: "access-v1" }))
      .mockResolvedValueOnce(jsonResponse({ id: 1 }))
      .mockResolvedValueOnce(jsonResponse({ id: 2 }));
    const client = await loadClient();
    const providerV1 = client.configuredLabelStudioProvider();

    await client.getProject(providerV1, 1);
    process.env.LABEL_STUDIO_URL = "https://labels-v2.example.test/";
    process.env.LABEL_STUDIO_INSTANCE_ID = "provider-volume-v2";
    const providerV2 = client.configuredLabelStudioProvider();
    await client.getProject(providerV2, 2);

    expect(fetchMock).toHaveBeenNthCalledWith(
      4,
      "https://labels-v2.example.test/api/projects/2/",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Token api-key-v1" }),
      }),
    );
  });
});

describe("Label Studio DELETE terminal contract", () => {
  it.each([204, 404])(
    "accepts terminal status %s without parsing a response body",
    async (status) => {
      const fetchMock = vi.mocked(fetch);
      fetchMock.mockResolvedValueOnce(emptyResponse(status));
      const client = await loadClient();
      const provider = client.configuredLabelStudioProvider();

      await expect(client.deleteProject(provider, 42)).resolves.toBeUndefined();
      expect(fetchMock).toHaveBeenCalledWith(
        "https://labels.example.test/api/projects/42/",
        expect.objectContaining({
          method: "DELETE",
          redirect: "error",
        }),
      );
    },
  );

  it.each([200, 201, 202, 206, 299])(
    "rejects non-terminal success status %s",
    async (status) => {
      vi.mocked(fetch).mockResolvedValueOnce(emptyResponse(status));
      const client = await loadClient();
      const provider = client.configuredLabelStudioProvider();

      await expect(client.deleteProject(provider, 42)).rejects.toThrow(
        `Failed to delete LS project 42: ${status}`,
      );
    },
  );
});
