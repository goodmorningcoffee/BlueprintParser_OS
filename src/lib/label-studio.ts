/**
 * Label Studio REST API client.
 * No SDK exists for Node.js — uses fetch directly.
 * Requires LABEL_STUDIO_URL and LABEL_STUDIO_API_KEY env vars.
 *
 * Uses legacy token auth (Authorization: Token <token>).
 * Enable via LABEL_STUDIO_ENABLE_LEGACY_API_TOKEN=true on the LS container.
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

async function lsFetch(path: string, options: RequestInit = {}) {
  const { url, token } = getConfig();
  const res = await fetch(`${url}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Token ${token}`,
      ...options.headers,
    },
    signal: AbortSignal.timeout(15000),
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
 */
export async function deleteProject(projectId: number) {
  const { url, token } = getConfig();
  const res = await fetch(`${url}/api/projects/${projectId}`, {
    method: "DELETE",
    headers: { Authorization: `Token ${token}` },
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
