/**
 * Label Studio REST API client.
 * No SDK exists for Node.js — uses fetch directly.
 * Requires LABEL_STUDIO_URL, LABEL_STUDIO_INSTANCE_ID, and LABEL_STUDIO_API_KEY.
 *
 * Provider project IDs are meaningful only within one persistent Label Studio
 * instance. Every project operation therefore carries the immutable provider
 * binding that was captured with its durable local witness.
 *
 * Dual-auth: tries legacy Token auth first, then JWT Bearer refresh.
 * Works whether LABEL_STUDIO_ENABLE_LEGACY_API_TOKEN is set on LS or not.
 *
 * @see https://api.labelstud.io/
 */

export type LabelStudioProviderBinding = Readonly<{
  baseUrl: string;
  instanceId: string;
}>;

interface LabelStudioConfig extends LabelStudioProviderBinding {
  token: string;
}

function invalidProviderConfig(message: string): Error {
  return new Error(`Invalid Label Studio provider configuration: ${message}`);
}

function canonicalLabelStudioBaseUrl(rawUrl: string): string {
  const value = rawUrl.trim();
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw invalidProviderConfig("LABEL_STUDIO_URL must be an absolute URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw invalidProviderConfig("LABEL_STUDIO_URL must use http or https");
  }
  if (parsed.username || parsed.password) {
    throw invalidProviderConfig(
      "LABEL_STUDIO_URL must not contain credentials",
    );
  }
  // Check the original spelling as URL normalizes a terminal bare `?` or `#`
  // into an empty search/hash value.
  if (value.includes("?") || value.includes("#")) {
    throw invalidProviderConfig(
      "LABEL_STUDIO_URL must not contain query or hash data",
    );
  }

  const pathname = parsed.pathname.replace(/\/+$/u, "");
  return `${parsed.origin}${pathname}`;
}

/** Return the canonical identity of the currently configured provider. */
export function configuredLabelStudioProvider(): LabelStudioProviderBinding {
  const rawUrl = process.env.LABEL_STUDIO_URL;
  const rawInstanceId = process.env.LABEL_STUDIO_INSTANCE_ID;
  if (!rawUrl) {
    throw invalidProviderConfig("LABEL_STUDIO_URL must be set");
  }
  const instanceId = rawInstanceId?.trim();
  if (!instanceId) {
    throw invalidProviderConfig("LABEL_STUDIO_INSTANCE_ID must be set");
  }
  return {
    baseUrl: canonicalLabelStudioBaseUrl(rawUrl),
    instanceId,
  };
}

function configForBinding(
  binding: LabelStudioProviderBinding,
): LabelStudioConfig {
  const configured = configuredLabelStudioProvider();
  if (
    !binding ||
    binding.baseUrl !== configured.baseUrl ||
    binding.instanceId !== configured.instanceId
  ) {
    throw new Error(
      "Label Studio provider binding differs from current configuration",
    );
  }
  const token = process.env.LABEL_STUDIO_API_KEY;
  if (!token) {
    throw invalidProviderConfig("LABEL_STUDIO_API_KEY must be set");
  }
  return { ...configured, token };
}

interface AuthState {
  baseUrl: string;
  instanceId: string;
  token: string;
  mode: "token" | "bearer" | null;
  accessToken: string | null;
  tokenExpiry: number;
}

// This cache is valid only for one exact URL + persistent instance + API key.
// A deployment/config rotation must never replay bearer authority across that boundary.
let authState: AuthState | null = null;

function stateForConfig(config: LabelStudioConfig): AuthState {
  if (
    !authState ||
    authState.baseUrl !== config.baseUrl ||
    authState.instanceId !== config.instanceId ||
    authState.token !== config.token
  ) {
    authState = {
      baseUrl: config.baseUrl,
      instanceId: config.instanceId,
      token: config.token,
      mode: null,
      accessToken: null,
      tokenExpiry: 0,
    };
  }
  return authState;
}

async function refreshAccessToken(
  config: LabelStudioConfig,
  state: AuthState,
): Promise<string | null> {
  const res = await fetch(`${config.baseUrl}/api/token/refresh`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refresh: config.token }),
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) return null;

  const data = (await res.json()) as { access?: unknown };
  if (typeof data.access !== "string" || data.access.length === 0) {
    throw new Error("Label Studio token refresh returned no access token");
  }
  state.mode = "bearer";
  state.accessToken = data.access;
  state.tokenExpiry = Date.now() + 5 * 60 * 1000;
  return data.access;
}

async function getAuthHeader(
  config: LabelStudioConfig,
  state: AuthState,
): Promise<string> {
  if (state.mode === "bearer") {
    if (state.accessToken && Date.now() < state.tokenExpiry) {
      return `Bearer ${state.accessToken}`;
    }
    const refreshed = await refreshAccessToken(config, state);
    if (refreshed) return `Bearer ${refreshed}`;
    state.mode = null;
    state.accessToken = null;
    state.tokenExpiry = 0;
  }
  return `Token ${config.token}`;
}

async function providerFetch(
  binding: LabelStudioProviderBinding,
  path: string,
  options: RequestInit = {},
): Promise<Response> {
  const config = configForBinding(binding);
  const state = stateForConfig(config);
  const authorization = await getAuthHeader(config, state);

  const send = (header: string) =>
    fetch(`${config.baseUrl}${path}`, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        Authorization: header,
        ...options.headers,
      },
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });

  let res = await send(authorization);
  if (res.status === 401) {
    const accessToken = await refreshAccessToken(config, state);
    if (accessToken) res = await send(`Bearer ${accessToken}`);
  } else if (state.mode === null && authorization.startsWith("Token ")) {
    state.mode = "token";
  }
  return res;
}

async function lsFetch(
  binding: LabelStudioProviderBinding,
  path: string,
  options: RequestInit = {},
): Promise<unknown> {
  const res = await providerFetch(binding, path, options);
  if (!res.ok) {
    // Import errors may echo task payloads. Those contain bearer asset URLs,
    // so status is the only provider diagnostic permitted to escape here.
    throw new Error(`Label Studio API error ${res.status}`);
  }
  return res.json();
}

/** Create a new Label Studio project with labeling config. */
export async function createProject(
  provider: LabelStudioProviderBinding,
  title: string,
  labelConfig: string,
  description?: string,
) {
  return lsFetch(provider, "/api/projects/", {
    method: "POST",
    body: JSON.stringify({ title, label_config: labelConfig, description }),
  }) as Promise<{
    id: number;
    title: string;
    description?: string;
    created_at: string;
  }>;
}

export interface LabelStudioProjectSummary {
  id: number;
  title: string;
  description?: string | null;
}

/**
 * Search every provider page, then exact-match the application marker. Label Studio's `search`
 * query is contains-based and therefore cannot itself establish identity.
 */
export async function findProjectsByExactDescription(
  provider: LabelStudioProviderBinding,
  marker: string,
): Promise<LabelStudioProjectSummary[]> {
  const configured = configForBinding(provider);
  let path: string | null =
    `/api/projects/?search=${encodeURIComponent(marker)}&page_size=100`;
  const matches: LabelStudioProjectSummary[] = [];

  for (let page = 0; path && page < 100; page++) {
    const response = (await lsFetch(provider, path)) as
      | LabelStudioProjectSummary[]
      | {
          results?: LabelStudioProjectSummary[];
          next?: string | null;
        };
    const projects = Array.isArray(response)
      ? response
      : (response.results ?? []);
    matches.push(
      ...projects.filter((project) => project.description === marker),
    );
    if (Array.isArray(response) || !response.next) return matches;

    const next = new URL(response.next, configured.baseUrl);
    if (next.origin !== new URL(configured.baseUrl).origin) {
      throw new Error("Label Studio pagination escaped the configured origin");
    }
    path = `${next.pathname}${next.search}`;
  }

  if (path) throw new Error("Label Studio project search exceeded 100 pages");
  return matches;
}

/** Import tasks into a Label Studio project. */
export async function importTasks(
  provider: LabelStudioProviderBinding,
  projectId: number,
  tasks: Array<{ data: { image: string } }>,
) {
  return lsFetch(provider, `/api/projects/${projectId}/import`, {
    method: "POST",
    body: JSON.stringify(tasks),
  }) as Promise<{ task_count: number }>;
}

/** Get project details including task counts. */
export async function getProject(
  provider: LabelStudioProviderBinding,
  projectId: number,
) {
  return lsFetch(provider, `/api/projects/${projectId}/`) as Promise<{
    id: number;
    title: string;
    task_number: number;
    finished_task_number: number;
    total_annotations_number: number;
  }>;
}

/** Delete a Label Studio project and all its tasks/annotations. */
export async function deleteProject(
  provider: LabelStudioProviderBinding,
  projectId: number,
): Promise<void> {
  // Label Studio documents this endpoint with a terminal slash and an empty
  // 204 response. A 404 is the only idempotent replay success.
  const res = await providerFetch(provider, `/api/projects/${projectId}/`, {
    method: "DELETE",
  });
  if (res.status !== 204 && res.status !== 404) {
    throw new Error(`Failed to delete LS project ${projectId}: ${res.status}`);
  }
}

/** Check if the currently configured Label Studio provider is reachable. */
export async function healthCheck(): Promise<boolean> {
  try {
    const provider = configuredLabelStudioProvider();
    const res = await fetch(`${provider.baseUrl}/health`, {
      redirect: "error",
      signal: AbortSignal.timeout(5_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}
