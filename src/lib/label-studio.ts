/**
 * Label Studio REST API client.
 * No SDK exists for Node.js — uses fetch directly.
 * Requires LABEL_STUDIO_URL and LABEL_STUDIO_API_KEY env vars.
 *
 * Dual-auth: tries legacy Token auth first, falls back to JWT Bearer refresh.
 * Works whether LABEL_STUDIO_ENABLE_LEGACY_API_TOKEN is set on LS or not.
 *
 * @see https://api.labelstud.io/
 */

function getConfig() {
  const url = process.env.LABEL_STUDIO_URL;
  const token = process.env.LABEL_STUDIO_API_KEY;
  if (!url || !token) {
    throw new Error("LABEL_STUDIO_URL and LABEL_STUDIO_API_KEY must be set");
  }
  return { url: url.replace(/\/$/, ""), token };
}

// Cache auth state to avoid retrying on every call
let authMode: "token" | "bearer" | null = null;
let cachedAccessToken: string | null = null;
let cachedTokenExpiry = 0;

async function getAuthHeader(): Promise<string> {
  const { token } = getConfig();

  // If we already know bearer works, use cached access token
  if (authMode === "bearer") {
    const now = Date.now();
    if (cachedAccessToken && now < cachedTokenExpiry) {
      return `Bearer ${cachedAccessToken}`;
    }
    // Refresh
    const { url } = getConfig();
    const res = await fetch(`${url}/api/token/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refresh: token }),
      signal: AbortSignal.timeout(10000),
    });
    if (res.ok) {
      const data = await res.json();
      cachedAccessToken = data.access;
      cachedTokenExpiry = now + 5 * 60 * 1000;
      return `Bearer ${cachedAccessToken}`;
    }
  }

  // Default to Token (legacy) auth
  return `Token ${token}`;
}

async function lsFetch(path: string, options: RequestInit = {}) {
  const { url } = getConfig();
  const authorization = await getAuthHeader();

  const res = await fetch(`${url}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      Authorization: authorization,
      ...options.headers,
    },
    signal: AbortSignal.timeout(15000),
  });

  // If 401 and we haven't tried the other auth method, try JWT refresh
  if (res.status === 401 && authMode !== "bearer") {
    const { token } = getConfig();
    const refreshRes = await fetch(`${url}/api/token/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refresh: token }),
      signal: AbortSignal.timeout(10000),
    });

    if (refreshRes.ok) {
      const data = await refreshRes.json();
      authMode = "bearer";
      cachedAccessToken = data.access;
      cachedTokenExpiry = Date.now() + 5 * 60 * 1000;

      // Retry with bearer token
      const retryRes = await fetch(`${url}${path}`, {
        ...options,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${cachedAccessToken}`,
          ...options.headers,
        },
        signal: AbortSignal.timeout(15000),
      });
      if (!retryRes.ok) {
        const body = await retryRes.text().catch(() => "");
        throw new Error(`Label Studio API error ${retryRes.status}: ${body.slice(0, 500)}`);
      }
      return retryRes.json();
    }
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Label Studio API error ${res.status}: ${body.slice(0, 500)}`);
  }

  // Token auth worked — cache this for future calls
  if (authMode === null) authMode = "token";
  return res.json();
}

/**
 * Create a new Label Studio project with labeling config.
 */
export async function createProject(title: string, labelConfig: string) {
  return lsFetch("/api/projects", {
    method: "POST",
    body: JSON.stringify({ title, label_config: labelConfig }),
  }) as Promise<{ id: number; title: string; created_at: string }>;
}

/**
 * Import tasks into a Label Studio project.
 */
export async function importTasks(
  projectId: number,
  tasks: Array<{ data: { image: string } }>
) {
  return lsFetch(`/api/projects/${projectId}/import`, {
    method: "POST",
    body: JSON.stringify(tasks),
  }) as Promise<{ task_count: number }>;
}

/**
 * Get project details including task counts.
 */
export async function getProject(projectId: number) {
  return lsFetch(`/api/projects/${projectId}`) as Promise<{
    id: number;
    title: string;
    task_number: number;
    finished_task_number: number;
    total_annotations_number: number;
  }>;
}

/**
 * Delete a Label Studio project and all its tasks/annotations.
 */
export async function deleteProject(projectId: number) {
  const { url } = getConfig();
  const authorization = await getAuthHeader();
  const res = await fetch(`${url}/api/projects/${projectId}`, {
    method: "DELETE",
    headers: { Authorization: authorization },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok && res.status !== 404) {
    throw new Error(`Failed to delete LS project ${projectId}: ${res.status}`);
  }
}

/**
 * Check if Label Studio is reachable.
 */
export async function healthCheck(): Promise<boolean> {
  try {
    const { url } = getConfig();
    const res = await fetch(`${url}/health`, {
      signal: AbortSignal.timeout(5000),
    });
    return res.ok;
  } catch {
    return false;
  }
}
