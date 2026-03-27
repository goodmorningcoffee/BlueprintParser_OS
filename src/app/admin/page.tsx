"use client";

import { useEffect, useState, useRef, useCallback } from "react";
import { useSession } from "next-auth/react";
import { useRouter } from "next/navigation";
import Header from "@/components/dashboard/Header";
import AdminTabs, { type AdminTab } from "./AdminTabs";
import OverviewTab from "./tabs/OverviewTab";
import ProjectsTab from "./tabs/ProjectsTab";
import AiModelsTab from "./tabs/AiModelsTab";
import UsersTab from "./tabs/UsersTab";
import SettingsTab from "./tabs/SettingsTab";

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
  canRunModels: boolean;
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
  const [reprocessing, setReprocessing] = useState(false);
  const [reprocessLog, setReprocessLog] = useState<string[]>([]);
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

    // Resume polling for any running YOLO jobs
    try {
      const runRes = await fetch("/api/admin/running-jobs");
      if (runRes.ok) {
        const runningJobs = await runRes.json();
        for (const job of runningJobs) {
          if (job.executionId && job.modelId && job.projectPublicId) {
            resumeJobPolling(job.projectPublicId, job.modelId, job.modelName, job.executionId);
          }
        }
      }
    } catch { /* ignore */ }
  }

  /** Resume polling for a job that was already running (e.g., after page navigation) */
  function resumeJobPolling(projectId: string, modelId: number, modelName: string, jobName: string) {
    const mk = String(modelId);
    const pk = pollKey(projectId, modelId);

    // Don't double-poll
    if (pollingRef.current[pk]) return;

    setYoloJobs((prev) => ({ ...prev, [projectId]: { ...(prev[projectId] || {}), [mk]: `Running: ${jobName}` } }));

    const interval = setInterval(async () => {
      try {
        const statusRes = await fetch(`/api/yolo/status?jobName=${jobName}`);
        if (!statusRes.ok) return;

        const { status: jobStatus, failureReason } = await statusRes.json();
        setYoloJobs((prev) => ({ ...prev, [projectId]: { ...(prev[projectId] || {}), [mk]: jobStatus } }));

        if (jobStatus === "Completed" || jobStatus === "Failed" || jobStatus === "Stopped") {
          clearInterval(interval);
          delete pollingRef.current[pk];

          // Update DB status
          fetch("/api/admin/running-jobs", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ executionId: jobName, status: jobStatus }),
          }).catch(() => {});

          if (jobStatus === "Completed") {
            await new Promise((r) => setTimeout(r, 3000));
            await loadYoloResults(projectId, modelId, modelName);
          } else {
            const reason = failureReason ? `: ${failureReason}` : "";
            setYoloJobs((prev) => ({ ...prev, [projectId]: { ...(prev[projectId] || {}), [mk]: `${jobStatus}${reason}` } }));
          }
        }
      } catch { /* network error — keep trying */ }
    }, 10000);

    pollingRef.current[pk] = interval;
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
      setYoloJobs({}); // Clear stale YOLO error states after toggle change
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

          // Update DB status so the job isn't re-polled on next page load
          fetch("/api/admin/running-jobs", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ executionId: jobName, status: jobStatus }),
          }).catch(() => {});

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

  async function toggleCanRunModels(userId: string, canRunModels: boolean) {
    const res = await fetch("/api/admin/users", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: userId, canRunModels }),
    });
    if (res.ok) {
      setUsers((prev) => prev.map((u) => u.id === userId ? { ...u, canRunModels } : u));
    } else {
      const err = await res.json().catch(() => ({ error: "Failed" }));
      setMessage(err.error || "Failed to update permission");
    }
  }

  async function reprocessAll() {
    setReprocessing(true);
    setReprocessLog(["Starting reprocess..."]);
    try {
      const res = await fetch("/api/admin/reprocess", { method: "POST" });
      if (!res.ok || !res.body) {
        setReprocessLog((prev) => [...prev, `Error: ${res.status}`]);
        setReprocessing(false);
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const data = JSON.parse(line);
            if (data.type === "start") setReprocessLog((prev) => [...prev, `Found ${data.projects} projects`]);
            else if (data.type === "project") setReprocessLog((prev) => [...prev, `Processing: ${data.name} (${data.pages} pages)`]);
            else if (data.type === "progress") setReprocessLog((prev) => [...prev, `  ${data.updated} pages updated...`]);
            else if (data.type === "done") setReprocessLog((prev) => [...prev, `Done! ${data.updated} pages updated, ${data.skipped} skipped.`]);
          } catch { /* ignore parse errors */ }
        }
      }
    } catch (err) {
      setReprocessLog((prev) => [...prev, `Failed: ${err instanceof Error ? err.message : "unknown"}`]);
    } finally {
      setReprocessing(false);
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

  // Tab state — read initial tab from URL, persist on change
  const [activeTab, setActiveTab] = useState<AdminTab>(() => {
    if (typeof window !== "undefined") {
      const params = new URLSearchParams(window.location.search);
      const tab = params.get("tab") as AdminTab;
      if (tab && ["overview", "projects", "ai-models", "users", "settings"].includes(tab)) return tab;
    }
    return "overview";
  });

  const handleTabChange = useCallback((tab: AdminTab) => {
    setActiveTab(tab);
    window.history.replaceState(null, "", `?tab=${tab}`);
  }, []);

  // Handlers passed to tab components
  const handleRefreshDemo = useCallback(async () => {
    const res = await fetch("/api/admin/demo", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "refresh" }),
    });
    if (res.ok) {
      const { refreshed } = await res.json();
      return `Refreshed ${refreshed} demo project${refreshed !== 1 ? "s" : ""}`;
    }
    return "Refresh failed";
  }, []);

  const handleDeleteModel = useCallback(async (id: number) => {
    await fetch("/api/admin/models", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });
    loadData();
  }, []);

  const handleDeleteUser = useCallback(async (userId: string, username: string) => {
    if (!confirm(`Delete user ${username}?`)) return;
    const res = await fetch("/api/admin/users", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: userId }),
    });
    if (res.ok) {
      setUsers((prev) => prev.filter((x) => x.id !== userId));
      setMessage("User deleted");
    } else {
      const err = await res.json();
      setMessage(err.error || "Delete failed");
    }
  }, []);

  if (status === "loading") {
    return <div className="min-h-screen flex items-center justify-center text-[var(--muted)]">Loading...</div>;
  }

  if (session?.user?.role !== "admin") {
    return <div className="min-h-screen flex items-center justify-center text-red-400">Admin access required</div>;
  }

  return (
    <div className="min-h-screen flex flex-col">
      <Header />
      <main className="flex-1 p-6 max-w-4xl mx-auto w-full">
        <h1 className="text-2xl font-bold mb-4">Admin Panel</h1>

        {message && (
          <div className="px-4 py-2 rounded bg-[var(--accent)]/20 text-[var(--accent)] text-sm mb-4">
            {message}
          </div>
        )}

        <AdminTabs
          active={activeTab}
          onChange={handleTabChange}
          badges={unseenInvites > 0 ? { overview: unseenInvites } : undefined}
        />

        {activeTab === "overview" && (
          <OverviewTab
            invites={invites}
            unseenInvites={unseenInvites}
            showInvites={showInvites}
            onMarkSeen={markInvitesSeen}
          />
        )}

        {activeTab === "projects" && (
          <ProjectsTab
            projects={projects}
            onToggleDemo={toggleDemo}
            onRefreshDemo={handleRefreshDemo}
            reprocessing={reprocessing}
            reprocessLog={reprocessLog}
            onReprocess={reprocessAll}
            setMessage={setMessage}
          />
        )}

        {activeTab === "ai-models" && (
          <AiModelsTab
            yoloModels={yoloModels}
            projects={projects}
            yoloJobs={yoloJobs}
            yoloStatus={yoloStatus}
            uploading={uploading}
            uploadProgress={uploadProgress}
            onUploadModel={uploadModel}
            onDeleteModel={handleDeleteModel}
            onRunYolo={runYolo}
            onLoadResults={loadYoloResults}
            toggles={toggles}
            togglePassword={togglePassword}
            setTogglePassword={setTogglePassword}
            toggleError={toggleError}
            setToggleError={setToggleError}
            newTogglePass={newTogglePass}
            setNewTogglePass={setNewTogglePass}
            currentTogglePass={currentTogglePass}
            setCurrentTogglePass={setCurrentTogglePass}
            onToggle={handleToggle}
            onSetTogglePassword={handleSetTogglePassword}
          />
        )}

        {activeTab === "users" && (
          <UsersTab
            users={users}
            currentEmail={session?.user?.email || ""}
            newUser={newUser}
            setNewUser={setNewUser}
            onCreateUser={createUser}
            onToggleCanRunModels={toggleCanRunModels}
            onDeleteUser={handleDeleteUser}
          />
        )}

        {activeTab === "settings" && (
          <SettingsTab
            passwordForm={passwordForm}
            setPasswordForm={setPasswordForm}
            onChangePassword={changePassword}
          />
        )}
      </main>
    </div>
  );
}
