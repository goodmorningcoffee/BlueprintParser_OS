/**
 * Label Studio REST API client.
 * No SDK exists for Node.js — uses fetch directly.
 * Requires LABEL_STUDIO_URL and LABEL_STUDIO_API_KEY env vars.
 *
 * LS 1.23+ uses JWT Personal Access Tokens (PATs). The stored token
 * is a refresh token — must be exchanged for a short-lived access token
 * via POST /api/token/refresh before making API calls.
 *
 * @see https://api.labelstud.io/
 */

function getConfig() {
  const url = process.env.LABEL_STUDIO_URL;
  const refreshToken = process.env.LABEL_STUDIO_API_KEY;
  if (!url || !refreshToken) {
    throw new Error("LABEL_STUDIO_URL and LABEL_STUDIO_API_KEY must be set");
  }
  return { url: url.replace(/\/$/, ""), refreshToken };
}

// Cache the access token to avoid refreshing on every call
let cachedAccessToken: string | null = null;
let cachedTokenExpiry = 0;

/**
 * Exchange the JWT refresh token for a short-lived access token.
 * Caches the result for 5 minutes.
 */
async function getAccessToken(): Promise<string> {
  const now = Date.now();
  if (cachedAccessToken && now < cachedTokenExpiry) {
    return cachedAccessToken;
  }

  const { url, refreshToken } = getConfig();
  const res = await fetch(`${url}/api/token/refresh`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refresh: refreshToken }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Failed to refresh LS token (${res.status}): ${body.slice(0, 300)}`);
  }

  const data = await res.json();
  cachedAccessToken = data.access;
  cachedTokenExpiry = now + 5 * 60 * 1000; // Cache for 5 minutes
  return cachedAccessToken!;
}

async function lsFetch(path: string, options: RequestInit = {}) {
  const { url } = getConfig();
  const accessToken = await getAccessToken();
  const res = await fetch(`${url}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
      ...options.headers,
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Label Studio API error ${res.status}: ${body.slice(0, 500)}`);
  }
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
 * Each task should have { data: { image: "presigned-url" } }.
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
 * Uses raw fetch instead of lsFetch because DELETE returns no body (204),
 * and lsFetch always calls res.json() which would fail.
 */
export async function deleteProject(projectId: number) {
  const { url } = getConfig();
  const accessToken = await getAccessToken();
  const res = await fetch(`${url}/api/projects/${projectId}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok && res.status !== 404) {
    throw new Error(`Failed to delete LS project ${projectId}: ${res.status}`);
  }
}

/**
 * Check if Label Studio is reachable and auth works.
 */
export async function healthCheck(): Promise<boolean> {
  try {
    const { url } = getConfig();
    const accessToken = await getAccessToken();
    const res = await fetch(`${url}/api/projects`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    return res.ok;
  } catch {
    return false;
  }
}
