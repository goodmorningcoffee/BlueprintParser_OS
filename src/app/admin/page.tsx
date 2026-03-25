"use client";

import { useEffect, useState, useRef, useCallback } from "react";
import { useSession } from "next-auth/react";
import { useRouter } from "next/navigation";
import Header from "@/components/dashboard/Header";

interface ProjectItem {
  id: string;
  name: string;
  numPages: number | null;
  status: string;
  isDemo: boolean;
}

interface ModelItem {
  id: number;
  name: string;
  type: string;
  config: any;
  isDefault: boolean;
}

interface UserItem {
  id: string;
  username: string;
  email: string;
  role: string;
}

export default function AdminPage() {
  const { data: session, status } = useSession();
  const router = useRouter();
  const [projects, setProjects] = useState<ProjectItem[]>([]);
  const [users, setUsers] = useState<UserItem[]>([]);
  const [yoloModels, setYoloModels] = useState<ModelItem[]>([]);
  const [newUser, setNewUser] = useState({ username: "", email: "", password: "", role: "member" });
  const [yoloJobs, setYoloJobs] = useState<Record<string, Record<string, string>>>({});
  const [passwordForm, setPasswordForm] = useState({ currentPassword: "", newPassword: "" });
  const [message, setMessage] = useState("");
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const pollingRef = useRef<Record<string, NodeJS.Timeout>>({});
  const [invites, setInvites] = useState<Array<{ id: number; email: string; name: string | null; company: string | null; seen: boolean; createdAt: string }>>([]);
  const [unseenInvites, setUnseenInvites] = useState(0);
  const [showInvites, setShowInvites] = useState(false);
  const [yoloStatus, setYoloStatus] = useState<Record<string, Record<string, number>>>({});
  const pollKey = (pid: string, mid: number) => `${pid}:${mid}`;
  const [toggles, setToggles] = useState({ sagemakerEnabled: true, quotaEnabled: true, hasPassword: false });
  const [togglePassword, setTogglePassword] = useState("");
  const [toggleError, setToggleError] = useState("");
  const [newTogglePass, setNewTogglePass] = useState("");
  const [currentTogglePass, setCurrentTogglePass] = useState("");

  useEffect(() => {
    if (status === "unauthenticated") router.push("/login");
    if (session?.user?.role !== "admin") return;
    loadData();
  }, [session, status, router]);

  // Cleanup all polling intervals on unmount
  useEffect(() => {
    return () => {
      Object.values(pollingRef.current).forEach(clearInterval);
    };
  }, []);

  async function loadData() {
    const [projRes, userRes, modelRes] = await Promise.all([
      fetch("/api/projects"),
      fetch("/api/admin/users"),
      fetch("/api/admin/models"),
    ]);
    if (projRes.ok) {
      const data = await projRes.json();
      setProjects(data.map((p: any) => ({ ...p, isDemo: p.isDemo || false })));
    }
    if (userRes.ok) setUsers(await userRes.json());
    if (modelRes.ok) setYoloModels(await modelRes.json());

    try {
      const invRes = await fetch("/api/admin/invites");
      if (invRes.ok) {
        const data = await invRes.json();
        setInvites(data.requests);
        setUnseenInvites(data.unseenCount);
      }
    } catch { /* table may not exist yet */ }

    try {
      const yoloRes = await fetch("/api/admin/yolo-status");
      if (yoloRes.ok) setYoloStatus(await yoloRes.json());
    } catch { /* ignore */ }

    try {
      const togRes = await fetch("/api/admin/toggles");
      if (togRes.ok) setToggles(await togRes.json());
    } catch { /* ignore */ }
  }

  async function handleToggle(toggle: "sagemaker" | "quota", enabled: boolean) {
    if (!togglePassword) { setToggleError("Toggle password required"); return; }
    setToggleError("");
    const res = await fetch("/api/admin/toggles", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ toggle, enabled, password: togglePassword }),
    });
    if (res.ok) {
      const data = await res.json();
      setToggles((prev) => ({ ...prev, sagemakerEnabled: data.sagemakerEnabled, quotaEnabled: data.quotaEnabled }));
      setTogglePassword("");
      setToggleError("");
    } else {
      const err = await res.json().catch(() => ({ error: "Failed" }));
      setToggleError(err.error || "Failed");
    }
  }

  async function handleSetTogglePassword() {
    if (!newTogglePass || newTogglePass.length < 6) { setToggleError("Min 6 characters"); return; }
    setToggleError("");
    const res = await fetch("/api/admin/toggles", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "set-password",
        newPassword: newTogglePass,
        currentPassword: currentTogglePass || undefined,
      }),
    });
    if (res.ok) {
      setToggles((prev) => ({ ...prev, hasPassword: true }));
      setNewTogglePass("");
      setCurrentTogglePass("");
      setToggleError("");
    } else {
      const err = await res.json().catch(() => ({ error: "Failed" }));
      setToggleError(err.error || "Failed");
    }
  }

  async function markInvitesSeen() {
    setShowInvites(true);
    if (unseenInvites > 0) {
      await fetch("/api/admin/invites", { method: "PUT" });
      setUnseenInvites(0);
      setInvites((prev) => prev.map((inv) => ({ ...inv, seen: true })));
    }
  }

  async function uploadModel(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setMessage("");
    setUploading(true);
    setUploadProgress(0);
    const form = e.currentTarget;
    const formData = new FormData(form);

    const name = formData.get("name") as string;
    const modelFile = formData.get("model") as File | null;
    const classesFile = formData.get("classes") as File | null;
    const confidence = parseFloat(formData.get("confidence") as string) || 0.25;
    const iou = parseFloat(formData.get("iou") as string) || 0.45;

    if (!name || !modelFile) {
      setMessage("Name and model file required");
      setUploading(false);
      return;
    }

    try {
      // Step 1: Get presigned URL
      setMessage("Preparing upload...");
      const presignRes = await fetch(`/api/admin/models?action=presign&name=${encodeURIComponent(name)}`);
      if (!presignRes.ok) {
        const err = await presignRes.json();
        throw new Error(err.error || "Failed to get upload URL");
      }
      const { url, fields, s3Path } = await presignRes.json();

      // Step 2: Upload .pt file directly to S3 with progress
      setMessage("Uploading model to S3...");
      await new Promise<void>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.upload.addEventListener("progress", (e) => {
          if (e.lengthComputable) {
            setUploadProgress(Math.round((e.loaded / e.total) * 100));
          }
        });
        xhr.addEventListener("load", () => {
          if (xhr.status >= 200 && xhr.status < 300) resolve();
          else reject(new Error(`S3 upload failed (${xhr.status}): ${xhr.responseText?.slice(0, 200)}`));
        });
        xhr.addEventListener("error", () => reject(new Error("S3 upload network error")));
        xhr.open("POST", url);

        const body = new FormData();
        Object.entries(fields).forEach(([k, v]) => body.append(k, v as string));
        body.append("file", modelFile);
        xhr.send(body);
      });

      // Step 3: Parse classes file
      let classes: string[] = [];
      if (classesFile && classesFile.size > 0) {
        const text = await classesFile.text();
        classes = text.split("\n").map((l) => l.trim()).filter(Boolean);
      } else {
        setMessage("Note: No classes file — results will use numeric class IDs");
      }

      // Step 4: Register model in DB
      setMessage("Registering model...");
      const registerRes = await fetch("/api/admin/models", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, s3Path, classes, confidence, iou }),
      });

      if (registerRes.ok) {
        setMessage("Model uploaded successfully");
        form.reset();
        setUploadProgress(0);
        loadData();
      } else {
        const err = await registerRes.json();
        setMessage(err.error || "Registration failed");
      }
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setUploading(false);
    }
  }

  async function loadYoloResults(projectId: string, modelId: number, modelName: string, retryCount = 0): Promise<void> {
    const mk = String(modelId);
    setYoloJobs((prev) => ({ ...prev, [projectId]: { ...(prev[projectId] || {}), [mk]: "Loading results..." } }));
    try {
      const loadRes = await fetch("/api/yolo/load", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, modelId, modelName }),
      });
      if (loadRes.ok) {
        const { detectionsLoaded, error: loadError } = await loadRes.json();
        const msg = loadError
          ? `Loaded ${detectionsLoaded} (errors: ${loadError})`
          : `Completed — ${detectionsLoaded} detections loaded`;
        setYoloJobs((prev) => ({ ...prev, [projectId]: { ...(prev[projectId] || {}), [mk]: msg } }));
        if (detectionsLoaded > 0) {
          setYoloStatus((prev) => ({
            ...prev,
            [projectId]: {
              ...(prev[projectId] || {}),
              [mk]: ((prev[projectId] || {})[mk] || 0) + detectionsLoaded,
            },
          }));
        }
      } else {
        const err = await loadRes.json().catch(() => ({ error: "Unknown error" }));
        if (err.error === "No results found" && retryCount < 1) {
          setYoloJobs((prev) => ({ ...prev, [projectId]: { ...(prev[projectId] || {}), [mk]: "Waiting for S3 results..." } }));
          await new Promise((r) => setTimeout(r, 5000));
          return loadYoloResults(projectId, modelId, modelName, retryCount + 1);
        }
        setYoloJobs((prev) => ({ ...prev, [projectId]: { ...(prev[projectId] || {}), [mk]: `Load failed: ${err.error}` } }));
      }
    } catch {
      setYoloJobs((prev) => ({ ...prev, [projectId]: { ...(prev[projectId] || {}), [mk]: "Load failed: network error" } }));
    }
  }

  async function runYolo(projectId: string, modelId: number) {
    const model = yoloModels.find((m) => m.id === modelId);
    if (!model) {
      setMessage("Model not found");
      return;
    }

    const mk = String(modelId);
    setMessage("");
    setYoloJobs((prev) => ({ ...prev, [projectId]: { ...(prev[projectId] || {}), [mk]: "Rasterizing & starting..." } }));

    const res = await fetch("/api/yolo/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId, modelId }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: "Unknown error" }));
      setYoloJobs((prev) => ({ ...prev, [projectId]: { ...(prev[projectId] || {}), [mk]: `Error: ${err.error}` } }));
      return;
    }

    const { jobName } = await res.json();
    setYoloJobs((prev) => ({ ...prev, [projectId]: { ...(prev[projectId] || {}), [mk]: `Running: ${jobName}` } }));

    // Clear any existing poll for this project+model
    const pk = pollKey(projectId, modelId);
    if (pollingRef.current[pk]) {
      clearInterval(pollingRef.current[pk]);
    }

    // Poll for completion
    const interval = setInterval(async () => {
      try {
        const statusRes = await fetch(`/api/yolo/status?jobName=${jobName}`);
        if (!statusRes.ok) return;

        const { status: jobStatus, failureReason } = await statusRes.json();
        setYoloJobs((prev) => ({ ...prev, [projectId]: { ...(prev[projectId] || {}), [mk]: jobStatus } }));

        if (jobStatus === "Completed" || jobStatus === "Failed" || jobStatus === "Stopped") {
          clearInterval(interval);
          delete pollingRef.current[pk];

          if (jobStatus === "Completed") {
            await new Promise((r) => setTimeout(r, 3000));
            await loadYoloResults(projectId, modelId, model.name);
          } else {
            const reason = failureReason ? `: ${failureReason}` : "";
            setYoloJobs((prev) => ({ ...prev, [projectId]: { ...(prev[projectId] || {}), [mk]: `${jobStatus}${reason}` } }));
          }
        }
      } catch {
        // Network error during poll — keep trying
      }
    }, 10000);

    pollingRef.current[pk] = interval;
  }

  async function toggleDemo(projectId: string, isDemo: boolean) {
    const res = await fetch("/api/admin/demo", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId, isDemo }),
    });
    if (res.ok) {
      setProjects((prev) =>
        prev.map((p) => (p.id === projectId ? { ...p, isDemo } : p))
      );
    }
  }

  async function createUser() {
    setMessage("");
    const res = await fetch("/api/admin/users", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(newUser),
    });
    if (res.ok) {
      setMessage("User created");
      setNewUser({ username: "", email: "", password: "", role: "member" });
      loadData();
    } else {
      const err = await res.json();
      setMessage(err.error || "Failed");
    }
  }

  async function changePassword() {
    setMessage("");
    const res = await fetch("/api/admin/password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(passwordForm),
    });
    if (res.ok) {
      setMessage("Password changed");
      setPasswordForm({ currentPassword: "", newPassword: "" });
    } else {
      const err = await res.json();
      setMessage(err.error || "Failed");
    }
  }

  if (status === "loading") {
    return <div className="min-h-screen flex items-center justify-center text-[var(--muted)]">Loading...</div>;
  }

  if (session?.user?.role !== "admin") {
    return <div className="min-h-screen flex items-center justify-center text-red-400">Admin access required</div>;
  }

  return (
    <div className="min-h-screen flex flex-col">
      <Header />
      <main className="flex-1 p-6 max-w-4xl mx-auto w-full space-y-8">
        <h1 className="text-2xl font-bold">Admin Panel</h1>

        {message && (
          <div className="px-4 py-2 rounded bg-[var(--accent)]/20 text-[var(--accent)] text-sm">
            {message}
          </div>
        )}

        {/* Invite Requests */}
        <section>
          <button
            onClick={markInvitesSeen}
            className={`px-3 py-1.5 text-sm rounded border ${
              unseenInvites > 0
                ? "chat-pulse"
                : showInvites
                  ? "border-[var(--accent)] text-[var(--accent)]"
                  : "border-[var(--border)] text-[var(--muted)] hover:text-[var(--fg)]"
            }`}
          >
            Invites{unseenInvites > 0 ? ` (${unseenInvites})` : ""}
          </button>
          {showInvites && (
            <div className="mt-4 border border-[var(--border)] rounded-lg overflow-hidden">
              {invites.length === 0 ? (
                <div className="p-4 text-sm text-[var(--muted)] text-center">No invite requests yet.</div>
              ) : (
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-[var(--border)] text-left text-[var(--muted)]">
                      <th className="px-3 py-2">Email</th>
                      <th className="px-3 py-2">Name</th>
                      <th className="px-3 py-2">Company</th>
                      <th className="px-3 py-2">Date</th>
                    </tr>
                  </thead>
                  <tbody>
                    {invites.map((inv) => (
                      <tr key={inv.id} className="border-b border-[var(--border)] last:border-0">
                        <td className="px-3 py-2">{inv.email}</td>
                        <td className="px-3 py-2 text-[var(--muted)]">{inv.name || "\u2014"}</td>
                        <td className="px-3 py-2 text-[var(--muted)]">{inv.company || "\u2014"}</td>
                        <td className="px-3 py-2 text-[var(--muted)]">{new Date(inv.createdAt).toLocaleDateString()}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          )}
        </section>

        {/* Demo Projects */}
        <section>
          <div className="flex items-center gap-3 mb-3">
            <h2 className="text-lg font-semibold">Projects — Push to Demo</h2>
            <button
              onClick={async () => {
                const res = await fetch("/api/admin/demo", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ action: "refresh" }),
                });
                if (res.ok) {
                  const { refreshed } = await res.json();
                  setMessage(`Refreshed ${refreshed} demo project${refreshed !== 1 ? "s" : ""}`);
                }
              }}
              className="px-3 py-1 text-xs border border-[var(--border)] rounded hover:border-[var(--accent)] text-[var(--muted)] hover:text-[var(--fg)]"
            >
              Refresh Demo
            </button>
          </div>
          <div className="space-y-2">
            {projects.map((p) => (
              <div
                key={p.id}
                className="flex items-center justify-between p-3 bg-[var(--surface)] border border-[var(--border)] rounded"
              >
                <div>
                  <span className="font-medium">{p.name}</span>
                  <span className="text-xs text-[var(--muted)] ml-2">
                    {p.numPages || "?"} pages — {p.status}
                  </span>
                </div>
                <button
                  onClick={() => toggleDemo(p.id, !p.isDemo)}
                  className={`px-3 py-1 text-xs rounded ${
                    p.isDemo
                      ? "bg-green-600 text-white"
                      : "bg-[var(--bg)] text-[var(--muted)] border border-[var(--border)]"
                  }`}
                >
                  {p.isDemo ? "Live on Demo" : "Push to Demo"}
                </button>
              </div>
            ))}
          </div>
        </section>

        {/* YOLO Models */}
        <section>
          <h2 className="text-lg font-semibold mb-3">YOLO Models</h2>

          {/* Existing models */}
          <div className="space-y-2 mb-4">
            {yoloModels.map((m) => (
              <div
                key={m.id}
                className="flex items-center justify-between p-3 bg-[var(--surface)] border border-[var(--border)] rounded"
              >
                <div>
                  <span className="font-medium">{m.name}</span>
                  <span className="text-xs text-[var(--muted)] ml-2">
                    {(m.config as any)?.classes?.length || 0} classes — conf {(m.config as any)?.confidence || 0.25}
                  </span>
                </div>
                <button
                  onClick={async () => {
                    await fetch("/api/admin/models", {
                      method: "DELETE",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ id: m.id }),
                    });
                    loadData();
                  }}
                  className="text-xs text-[var(--muted)] hover:text-red-400"
                >
                  Delete
                </button>
              </div>
            ))}
            {yoloModels.length === 0 && (
              <p className="text-sm text-[var(--muted)]">No models uploaded yet.</p>
            )}
          </div>

          {/* Upload model form */}
          <form
            onSubmit={uploadModel}
            className="p-4 bg-[var(--surface)] border border-[var(--border)] rounded space-y-3"
          >
            <h3 className="text-sm font-medium">Upload Model</h3>
            <div className="grid grid-cols-2 gap-2">
              <input
                name="name"
                placeholder="Model name"
                required
                className="px-3 py-1.5 text-sm bg-[var(--bg)] border border-[var(--border)] rounded"
              />
              <input
                name="confidence"
                type="number"
                step="any"
                min="0"
                max="1"
                defaultValue="0.25"
                placeholder="Confidence"
                className="px-3 py-1.5 text-sm bg-[var(--bg)] border border-[var(--border)] rounded"
              />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="text-xs text-[var(--muted)] block mb-1">Model file (.pt)</label>
                <input name="model" type="file" accept=".pt" required className="text-xs" />
              </div>
              <div>
                <label className="text-xs text-[var(--muted)] block mb-1">Classes file (.txt)</label>
                <input name="classes" type="file" accept=".txt" className="text-xs" />
              </div>
            </div>
            {uploading && uploadProgress > 0 && (
              <div className="w-full bg-[var(--bg)] rounded h-2 overflow-hidden">
                <div
                  className="h-full bg-[var(--accent)] transition-all duration-300"
                  style={{ width: `${uploadProgress}%` }}
                />
              </div>
            )}
            <button
              type="submit"
              disabled={uploading}
              className="px-4 py-1.5 text-sm bg-[var(--accent)] text-white rounded hover:bg-[var(--accent-hover)] disabled:opacity-40"
            >
              {uploading ? (uploadProgress > 0 ? `Uploading ${uploadProgress}%` : "Preparing...") : "Upload Model"}
            </button>
          </form>
        </section>

        {/* Safety Toggles */}
        <section>
          <h2 className="text-lg font-semibold mb-3">Safety Toggles</h2>
          <div className="p-3 bg-[var(--surface)] border border-[var(--border)] rounded space-y-3">
            {!toggles.hasPassword ? (
              <div className="space-y-2">
                <p className="text-xs text-amber-400">Set a toggle password first. This is independent of your login — a separate secret for controlling SageMaker and quotas.</p>
                <input
                  type="password"
                  placeholder="New toggle password (min 6 chars)"
                  value={newTogglePass}
                  onChange={(e) => { setNewTogglePass(e.target.value); setToggleError(""); }}
                  className="w-full px-3 py-1.5 text-sm bg-[var(--bg)] border border-[var(--border)] rounded focus:outline-none focus:border-[var(--accent)]"
                />
                <button
                  onClick={handleSetTogglePassword}
                  disabled={newTogglePass.length < 6}
                  className="px-3 py-1.5 text-xs bg-amber-600 text-white rounded disabled:opacity-40 hover:bg-amber-500"
                >
                  Set Toggle Password
                </button>
                {toggleError && <span className="text-xs text-red-400 block">{toggleError}</span>}
              </div>
            ) : (
              <>
                <div className="flex items-center justify-between">
                  <div>
                    <span className="font-medium">SageMaker</span>
                    <span className={`text-xs ml-2 ${toggles.sagemakerEnabled ? "text-green-400" : "text-red-400"}`}>
                      {toggles.sagemakerEnabled ? "ENABLED" : "DISABLED"}
                    </span>
                  </div>
                  <button
                    onClick={() => handleToggle("sagemaker", !toggles.sagemakerEnabled)}
                    disabled={!togglePassword}
                    className={`px-3 py-1 text-xs rounded border disabled:opacity-40 ${
                      toggles.sagemakerEnabled
                        ? "border-red-400/30 text-red-400 hover:bg-red-400/10"
                        : "border-green-400/30 text-green-400 hover:bg-green-400/10"
                    }`}
                  >
                    {toggles.sagemakerEnabled ? "Disable" : "Enable"}
                  </button>
                </div>
                <div className="flex items-center justify-between">
                  <div>
                    <span className="font-medium">Quota Limits</span>
                    <span className={`text-xs ml-2 ${toggles.quotaEnabled ? "text-green-400" : "text-amber-400"}`}>
                      {toggles.quotaEnabled ? "ENFORCED" : "BYPASSED"}
                    </span>
                  </div>
                  <button
                    onClick={() => handleToggle("quota", !toggles.quotaEnabled)}
                    disabled={!togglePassword}
                    className={`px-3 py-1 text-xs rounded border disabled:opacity-40 ${
                      toggles.quotaEnabled
                        ? "border-amber-400/30 text-amber-400 hover:bg-amber-400/10"
                        : "border-green-400/30 text-green-400 hover:bg-green-400/10"
                    }`}
                  >
                    {toggles.quotaEnabled ? "Bypass" : "Enforce"}
                  </button>
                </div>
                <div className="flex items-center gap-2 pt-2 border-t border-[var(--border)]">
                  <input
                    type="password"
                    placeholder="Toggle password"
                    value={togglePassword}
                    onChange={(e) => { setTogglePassword(e.target.value); setToggleError(""); }}
                    className="flex-1 px-3 py-1.5 text-sm bg-[var(--bg)] border border-[var(--border)] rounded focus:outline-none focus:border-[var(--accent)]"
                  />
                  {toggleError && <span className="text-xs text-red-400">{toggleError}</span>}
                </div>
                <div className="pt-1 border-t border-[var(--border)]">
                  <details className="text-xs text-[var(--muted)]">
                    <summary className="cursor-pointer hover:text-[var(--fg)]">Change toggle password</summary>
                    <div className="mt-2 space-y-1.5">
                      <input type="password" placeholder="Current toggle password" value={currentTogglePass}
                        onChange={(e) => setCurrentTogglePass(e.target.value)}
                        className="w-full px-3 py-1.5 text-sm bg-[var(--bg)] border border-[var(--border)] rounded focus:outline-none focus:border-[var(--accent)]" />
                      <input type="password" placeholder="New toggle password" value={newTogglePass}
                        onChange={(e) => setNewTogglePass(e.target.value)}
                        className="w-full px-3 py-1.5 text-sm bg-[var(--bg)] border border-[var(--border)] rounded focus:outline-none focus:border-[var(--accent)]" />
                      <button onClick={handleSetTogglePassword} disabled={newTogglePass.length < 6}
                        className="px-3 py-1 text-xs border border-[var(--border)] rounded hover:border-[var(--accent)] disabled:opacity-40">
                        Update
                      </button>
                    </div>
                  </details>
                </div>
              </>
            )}
          </div>
        </section>

        {/* Run YOLO */}
        {yoloModels.length > 0 && (
          <section>
            <h2 className="text-lg font-semibold mb-3">Run YOLO Inference</h2>
            <div className="space-y-2">
              {projects
                .filter((p) => p.status === "completed")
                .map((p) => (
                  <div
                    key={p.id}
                    className="flex items-center justify-between p-3 bg-[var(--surface)] border border-[var(--border)] rounded"
                  >
                    <div>
                      <span className="font-medium">{p.name}</span>
                      {yoloStatus[p.id] && Object.values(yoloStatus[p.id]).some(c => c > 0) && !(yoloJobs[p.id] && Object.values(yoloJobs[p.id]).some(Boolean)) && (
                        <span className="text-xs ml-2 text-emerald-400/70">
                          {Object.values(yoloStatus[p.id]).reduce((a, b) => a + b, 0)} detections loaded
                        </span>
                      )}
                    </div>
                    <div className="flex gap-2">
                      {yoloModels.map((m) => {
                        const mk = String(m.id);
                        const mStatus = (yoloStatus[p.id] || {})[mk] || 0;
                        const mJob = (yoloJobs[p.id] || {})[mk] || "";
                        return (
                        <div key={m.id} className="flex gap-1 items-center">
                          <button
                            onClick={() => runYolo(p.id, m.id)}
                            disabled={!!mJob && /^(Running|Rasterizing|InProgress|Loading|Waiting|starting)/.test(mJob)}
                            className={`px-3 py-1 text-xs rounded border disabled:opacity-40 ${
                              mStatus > 0
                                ? "bg-purple-500/10 border-purple-400/30 text-purple-300 hover:border-purple-400/60"
                                : "bg-[var(--bg)] border-[var(--border)] hover:border-[var(--accent)]"
                            }`}
                          >
                            Run {m.name}
                          </button>
                          <button
                            onClick={() => loadYoloResults(p.id, m.id, m.name)}
                            disabled={!!mJob && /^(Loading|Waiting)/.test(mJob)}
                            className={`px-2 py-1 text-xs rounded border disabled:opacity-40 ${
                              mStatus > 0
                                ? "bg-emerald-500/10 border-emerald-400/30 text-emerald-300 hover:border-emerald-400/60"
                                : "text-[var(--muted)] border-[var(--border)] hover:border-green-500 hover:text-green-400"
                            }`}
                          >
                            {mStatus > 0 ? "Loaded" : "Load"}
                          </button>
                          {mJob && (
                            <span className={`text-xs ${
                              mJob.startsWith("Error") || mJob.startsWith("Failed") || mJob.startsWith("Load failed")
                                ? "text-red-400"
                                : mJob.startsWith("Completed")
                                  ? "text-green-400"
                                  : "text-[var(--accent)]"
                            }`}>
                              {mJob}
                            </span>
                          )}
                        </div>
                        );
                      })}
                    </div>
                  </div>
                ))}
            </div>
          </section>
        )}

        {/* Users */}
        <section>
          <h2 className="text-lg font-semibold mb-3">Users</h2>
          <div className="space-y-2 mb-4">
            {users.map((u) => (
              <div
                key={u.id}
                className="flex items-center justify-between p-3 bg-[var(--surface)] border border-[var(--border)] rounded"
              >
                <div>
                  <span className="font-medium">{u.username}</span>
                  <span className="text-xs text-[var(--muted)] ml-2">{u.email}</span>
                </div>
                <div className="flex items-center gap-3">
                  <span className="text-xs px-2 py-0.5 rounded bg-[var(--bg)] text-[var(--muted)]">
                    {u.role}
                  </span>
                  {u.email !== session?.user?.email && (
                    <button
                      onClick={async () => {
                        if (!confirm(`Delete user ${u.username}?`)) return;
                        const res = await fetch("/api/admin/users", {
                          method: "DELETE",
                          headers: { "Content-Type": "application/json" },
                          body: JSON.stringify({ id: u.id }),
                        });
                        if (res.ok) {
                          setUsers((prev) => prev.filter((x) => x.id !== u.id));
                          setMessage("User deleted");
                        } else {
                          const err = await res.json();
                          setMessage(err.error || "Delete failed");
                        }
                      }}
                      className="text-xs text-[var(--muted)] hover:text-red-400"
                    >
                      Delete
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>

          <div className="p-4 bg-[var(--surface)] border border-[var(--border)] rounded space-y-3">
            <h3 className="text-sm font-medium">Add User</h3>
            <div className="grid grid-cols-2 gap-2">
              <input
                placeholder="Username"
                value={newUser.username}
                onChange={(e) => setNewUser({ ...newUser, username: e.target.value })}
                className="px-3 py-1.5 text-sm bg-[var(--bg)] border border-[var(--border)] rounded"
              />
              <input
                placeholder="Email"
                value={newUser.email}
                onChange={(e) => setNewUser({ ...newUser, email: e.target.value })}
                className="px-3 py-1.5 text-sm bg-[var(--bg)] border border-[var(--border)] rounded"
              />
              <input
                placeholder="Password (min 8)"
                type="password"
                value={newUser.password}
                onChange={(e) => setNewUser({ ...newUser, password: e.target.value })}
                className="px-3 py-1.5 text-sm bg-[var(--bg)] border border-[var(--border)] rounded"
              />
              <select
                value={newUser.role}
                onChange={(e) => setNewUser({ ...newUser, role: e.target.value })}
                className="px-3 py-1.5 text-sm bg-[var(--bg)] border border-[var(--border)] rounded"
              >
                <option value="member">Member</option>
                <option value="admin">Admin</option>
              </select>
            </div>
            <button
              onClick={createUser}
              className="px-4 py-1.5 text-sm bg-[var(--accent)] text-white rounded hover:bg-[var(--accent-hover)]"
            >
              Create User
            </button>
          </div>
        </section>

        {/* Change Password */}
        <section>
          <h2 className="text-lg font-semibold mb-3">Change Password</h2>
          <div className="p-4 bg-[var(--surface)] border border-[var(--border)] rounded space-y-3">
            <input
              placeholder="Current password"
              type="password"
              value={passwordForm.currentPassword}
              onChange={(e) => setPasswordForm({ ...passwordForm, currentPassword: e.target.value })}
              className="w-full px-3 py-1.5 text-sm bg-[var(--bg)] border border-[var(--border)] rounded"
            />
            <input
              placeholder="New password (min 8)"
              type="password"
              value={passwordForm.newPassword}
              onChange={(e) => setPasswordForm({ ...passwordForm, newPassword: e.target.value })}
              className="w-full px-3 py-1.5 text-sm bg-[var(--bg)] border border-[var(--border)] rounded"
            />
            <button
              onClick={changePassword}
              className="px-4 py-1.5 text-sm bg-[var(--accent)] text-white rounded hover:bg-[var(--accent-hover)]"
            >
              Update Password
            </button>
          </div>
        </section>
      </main>
    </div>
  );
}
