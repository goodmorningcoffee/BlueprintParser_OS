"use client";

import { useEffect, useState, useRef, useCallback } from "react";
import { useSession } from "next-auth/react";
import { useRouter } from "next/navigation";
import Header from "@/components/dashboard/Header";
// [refactor jul6 S031] apiErrorMessage: yolo routes now serve {error:{code,message}};
// reads both shapes (the retry below compares the MESSAGE, not the raw body field).
import { apiErrorMessage, persistFetch } from "@/lib/client-persist";
import AdminTabs, { TAB_IDS, type AdminTab } from "./AdminTabs";
import OverviewTab from "./tabs/OverviewTab";
import ProjectsTab from "./tabs/ProjectsTab";
import AiModelsTab from "./tabs/AiModelsTab";
import TextAnnotationsTab from "./tabs/TextAnnotationsTab";
import CsiTab from "./tabs/CsiTab";
import HeuristicsTab from "./tabs/HeuristicsTab";
import ClassifiersTab from "./tabs/ClassifiersTab";
import PageIntelligenceTab from "./tabs/PageIntelligenceTab";
import TableParseTab from "./tabs/TableParseTab";
import UsersTab from "./tabs/UsersTab";
import CompaniesUsersTab from "./tabs/CompaniesUsersTab";
import UsageTab from "./tabs/UsageTab";
import AiRbacTab from "./tabs/AiRbacTab";
import SettingsTab from "./tabs/SettingsTab";
import LogsTab from "./tabs/LogsTab";
import PipelineTab from "./tabs/PipelineTab";
import ReprocessTab from "./tabs/ReprocessTab";
import type { ReprocessPreset } from "./tabs/reprocess-plan";
import { fetchYoloStatus, type YoloStatusLoad } from "./tabs/yolo-status-load";
import LlmContextTab from "./tabs/LlmContextTab";
import DataToolsTab from "./tabs/DataToolsTab";
import RootTwoFactorGate from "./RootTwoFactorGate";

interface ProjectItem {
  id: string;
  name: string;
  numPages: number | null;
  status: string;
  isDemo: boolean;
  /** Root sees every company's projects (listProjects); the Reprocess tab marks foreign ones as skipped. */
  companyId?: number;
  companyName?: string;
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

// The API accepts a company admin OR a root admin (defineRoute "admin"); this page must too. It
// used to check `role === "admin"` alone, and the ROOT_ADMIN_EMAIL bootstrap only sets isRootAdmin
// on a `member` row — so the first root admin of a fresh deployment was told "Admin access required".
type AdminSession = { user?: { role?: string; isRootAdmin?: boolean } } | null | undefined;
const canOpenAdmin = (session: AdminSession) =>
  session?.user?.role === "admin" || session?.user?.isRootAdmin === true;

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
  // Abuse-event alert badge for the Logs tab. Polls every 60s when the admin
  // page is open. Root_Admin only — others never see the Logs tab anyway.
  const [unseenAbuseEvents, setUnseenAbuseEvents] = useState(0);
  const [showInvites, setShowInvites] = useState(false);
  const [yoloStatus, setYoloStatus] = useState<Record<string, Record<string, number>>>({});
  const [yoloStatusLoad, setYoloStatusLoad] = useState<YoloStatusLoad>({ loaded: false, error: null });
  const pollKey = (pid: string, mid: number) => `${pid}:${mid}`;
  const [toggles, setToggles] = useState({ sagemakerEnabled: true, quotaEnabled: true, hasPassword: true });
  const [togglePassword, setTogglePassword] = useState("");
  // [2026-10-24] Reprocess state (running / log / Debug toggle) moved into tabs/ReprocessTab.tsx;
  // other tabs hand over a preset through openReprocess instead of running their own requests.
  // `n` makes a repeated click on the same preset re-apply it; the tab stays mounted once visited so a
  // running plan's console survives a tab switch (the old page-level log did too).
  const [reprocessPreset, setReprocessPreset] = useState<{ preset: ReprocessPreset; n: number } | null>(null);
  const [toggleError, setToggleError] = useState("");
  const [newTogglePass, setNewTogglePass] = useState("");
  const [currentTogglePass, setCurrentTogglePass] = useState("");

  useEffect(() => {
    if (status === "unauthenticated") router.push("/login");
    if (!canOpenAdmin(session)) return;
    loadData();
  }, [session, status, router]);

  // Cleanup all polling intervals on unmount
  useEffect(() => {
    return () => {
      Object.values(pollingRef.current).forEach(clearInterval);
    };
  }, []);

  // Root_Admin: poll abuse event count every 60s so the Logs tab badge stays
  // fresh without continuous queries. Only runs for root admins — regular
  // admins don't see the Logs tab so no poll is needed for them.
  useEffect(() => {
    if (!session?.user?.isRootAdmin) return;
    const poll = async () => {
      try {
        const res = await fetch("/api/admin/logs/alert-count");
        if (res.ok) {
          const data = await res.json();
          setUnseenAbuseEvents(data.unseen ?? 0);
        }
      } catch { /* silent */ }
    };
    const id = setInterval(poll, 60_000);
    return () => clearInterval(id);
  }, [session?.user?.isRootAdmin]);

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

    // Root_Admin: fetch unseen abuse event count for the Logs tab badge.
    // Silent failure — non-root accounts get 403 here which we ignore.
    if (session?.user?.isRootAdmin) {
      try {
        const res = await fetch("/api/admin/logs/alert-count");
        if (res.ok) {
          const data = await res.json();
          setUnseenAbuseEvents(data.unseen ?? 0);
        }
      } catch { /* table may not exist yet */ }
    }

    // [2026-10-23] Root-only (the YOLO controls are); the bulk bar shows "loading results…" until this lands.
    if (session?.user?.isRootAdmin) {
      const r = await fetchYoloStatus();
      if (r.status) setYoloStatus(r.status);
      setYoloStatusLoad({ loaded: !!r.status, error: r.error });
    }

    // [2026-10-25] Root-only since the hardening (a company admin got a silent 403 and default state).
    if (session?.user?.isRootAdmin) {
      try {
        const togRes = await fetch("/api/admin/toggles");
        if (togRes.ok) setToggles(await togRes.json());
      } catch { /* ignore */ }
    }

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

        // Keep "Running: jobName" while job is active so Details panel stays visible
        if (jobStatus !== "Completed" && jobStatus !== "Failed" && jobStatus !== "Stopped") {
          setYoloJobs((prev) => ({ ...prev, [projectId]: { ...(prev[projectId] || {}), [mk]: `Running: ${jobName}` } }));
        }

        if (jobStatus === "Completed" || jobStatus === "Failed" || jobStatus === "Stopped") {
          clearInterval(interval);
          delete pollingRef.current[pk];

          // Update DB status. NOT awaited — an awaited rejection would be swallowed by this tick's
          // outer catch AND would skip loadYoloResults below; persistFetch rejects on !ok.
          persistFetch("/api/admin/running-jobs", { executionId: jobName, status: jobStatus, projectId }, "PUT")
            .catch((err) => {
              console.error("[yolo] Job status write failed:", err);
              setMessage(`Job ${jobName} finished (${jobStatus}) but its status could not be saved: ${err instanceof Error ? err.message : String(err)} — it stays marked running and will be retried on the next page load.`);
            });

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
      setToggleError(apiErrorMessage(err) || "Failed");
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
      setToggleError(apiErrorMessage(err) || "Failed");
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
        // [refactor jul8 S057] folded route serves {error:{code,message}} — read both envelopes
        throw new Error(apiErrorMessage(err) || "Failed to get upload URL");
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
        // [refactor jul8 S057] envelope OBJECT in a string state would crash React — unwrap
        setMessage(apiErrorMessage(err) || "Registration failed");
      }
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setUploading(false);
    }
  }

  async function loadYoloResults(projectId: string, modelId: number, modelName: string, retryCount = 0): Promise<string> {
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
        return msg;
      } else {
        const err = await loadRes.json().catch(() => ({ error: "Unknown error" }));
        const errMsg = apiErrorMessage(err) || "Unknown error";
        if (errMsg === "No results found" && retryCount < 1) {
          setYoloJobs((prev) => ({ ...prev, [projectId]: { ...(prev[projectId] || {}), [mk]: "Waiting for S3 results..." } }));
          await new Promise((r) => setTimeout(r, 5000));
          return loadYoloResults(projectId, modelId, modelName, retryCount + 1);
        }
        setYoloJobs((prev) => ({ ...prev, [projectId]: { ...(prev[projectId] || {}), [mk]: `Load failed: ${errMsg}` } }));
        return `Load failed: ${errMsg}`;
      }
    } catch {
      setYoloJobs((prev) => ({ ...prev, [projectId]: { ...(prev[projectId] || {}), [mk]: "Load failed: network error" } }));
      return "Load failed: network error";
    }
  }

  async function runYolo(projectId: string, modelId: number, bulk = false) { // bulk: the YoloBulkBar queue polls + loads
    const model = yoloModels.find((m) => m.id === modelId);
    if (!model) { setMessage("Model not found"); return { error: "Model not found" }; }

    const mk = String(modelId);
    setMessage("");
    setYoloJobs((prev) => ({ ...prev, [projectId]: { ...(prev[projectId] || {}), [mk]: "Rasterizing & starting..." } }));

    const res = await fetch("/api/yolo/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId, modelId }),
    });

    if (!res.ok) {
      const error = apiErrorMessage(await res.json().catch(() => ({ error: "Unknown error" }))) || "Unknown error";
      setYoloJobs((prev) => ({ ...prev, [projectId]: { ...(prev[projectId] || {}), [mk]: `Error: ${error}` } }));
      return { error, httpStatus: res.status };
    }

    const { jobName } = await res.json();
    setYoloJobs((prev) => ({ ...prev, [projectId]: { ...(prev[projectId] || {}), [mk]: `Running: ${jobName}` } }));
    if (bulk) return { jobName: String(jobName) };

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

        // Keep "Running: jobName" while job is active so Details panel stays visible
        if (jobStatus !== "Completed" && jobStatus !== "Failed" && jobStatus !== "Stopped") {
          setYoloJobs((prev) => ({ ...prev, [projectId]: { ...(prev[projectId] || {}), [mk]: `Running: ${jobName}` } }));
        }

        if (jobStatus === "Completed" || jobStatus === "Failed" || jobStatus === "Stopped") {
          clearInterval(interval);
          delete pollingRef.current[pk];

          // Update DB status. NOT awaited — an awaited rejection would be swallowed by this tick's
          // outer catch AND would skip loadYoloResults below; persistFetch rejects on !ok.
          persistFetch("/api/admin/running-jobs", { executionId: jobName, status: jobStatus, projectId }, "PUT")
            .catch((err) => {
              console.error("[yolo] Job status write failed:", err);
              setMessage(`Job ${jobName} finished (${jobStatus}) but its status could not be saved: ${err instanceof Error ? err.message : String(err)} — it stays marked running and will be retried on the next page load.`);
            });

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
      setNewUser({ username: "", email: "", password: "", role: "member" });
      loadData();
    } else {
      const err = await res.json();
      // [refactor jul8 S058] envelope unwrap — err.error is {code,message} post-fold
      throw new Error(apiErrorMessage(err) || "Failed to create user");
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
      // [refactor jul8 S058] envelope unwrap — object in string state crashes React
      setMessage(apiErrorMessage(err) || "Failed to update permission");
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
      setMessage(apiErrorMessage(err) || "Failed");
    }
  }

  // Tab state — read initial tab from URL, persist on change
  const [activeTab, setActiveTab] = useState<AdminTab>(() => {
    if (typeof window !== "undefined") {
      const params = new URLSearchParams(window.location.search);
      const tab = params.get("tab") as AdminTab;
      if (tab && TAB_IDS.includes(tab)) return tab;
    }
    return "overview";
  });

  const handleTabChange = useCallback((tab: AdminTab) => {
    setActiveTab(tab);
    window.history.replaceState(null, "", `?tab=${tab}`);
  }, []);

  const openReprocess = useCallback((preset: ReprocessPreset) => {
    setReprocessPreset((prev) => ({ preset, n: (prev?.n ?? 0) + 1 }));
    handleTabChange("reprocess");
  }, [handleTabChange]);
  const [reprocessSeen, setReprocessSeen] = useState(activeTab === "reprocess");
  useEffect(() => {
    if (activeTab === "reprocess") setReprocessSeen(true);
  }, [activeTab]);

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
      // [refactor jul8 S058] envelope unwrap — object in string state crashes React
      setMessage(apiErrorMessage(err) || "Delete failed");
    }
  }, []);

  if (status === "loading") {
    return <div className="min-h-screen flex items-center justify-center text-[var(--muted)]">Loading...</div>;
  }

  // [2026-10-25] Root 2FA is mandatory: a root login that still owes enrollment or its code holds a
  // user-less session carrying only `twoFactorGate`; it gets the enrollment panel or the code prompt
  // before any other check, and nothing else on this page until the gate clears.
  const twoFactorGate = (session as { twoFactorGate?: "enroll" | "verify" | null } | null)?.twoFactorGate;
  if (twoFactorGate === "enroll" || twoFactorGate === "verify") return <RootTwoFactorGate gate={twoFactorGate} />;

  if (!canOpenAdmin(session)) {
    return <div className="min-h-screen flex items-center justify-center text-red-400">Admin access required</div>;
  }

  return (
    <div className="min-h-screen flex flex-col">
      <Header />
      <main className="flex-1 p-6 max-w-7xl mx-auto w-full">
        <h1 className="text-2xl font-bold mb-4">Admin Panel</h1>

        {message && (
          <div className="px-4 py-2 rounded bg-[var(--accent)]/20 text-[var(--accent)] text-sm mb-4">
            {message}
          </div>
        )}

        <AdminTabs
          active={activeTab}
          onChange={handleTabChange}
          badges={{
            ...(unseenInvites > 0 ? { overview: unseenInvites } : {}),
            ...(unseenAbuseEvents > 0 ? { logs: unseenAbuseEvents } : {}),
          }}
          isRootAdmin={session?.user?.isRootAdmin}
        />

        {activeTab === "overview" && (
          <OverviewTab
            invites={invites}
            unseenInvites={unseenInvites}
            showInvites={showInvites}
            onMarkSeen={markInvitesSeen}
            isRootAdmin={session?.user?.isRootAdmin || false}
            onOpenReprocess={openReprocess}
          />
        )}

        {activeTab === "projects" && (
          <ProjectsTab
            projects={projects}
            onToggleDemo={toggleDemo}
            onRefreshDemo={handleRefreshDemo}
            setMessage={setMessage}
          />
        )}

        {activeTab === "ai-models" && (
          <AiModelsTab
            yoloModels={yoloModels}
            projects={projects}
            yoloJobs={yoloJobs}
            yoloStatus={yoloStatus}
            yoloStatusLoad={yoloStatusLoad}
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
            isRootAdmin={session?.user?.isRootAdmin || false}
          />
        )}

        {activeTab === "pipeline" && (
          <PipelineTab onOpenReprocess={openReprocess} isRootAdmin={session?.user?.isRootAdmin === true} />
        )}

        {reprocessSeen && (
          <div hidden={activeTab !== "reprocess"}>
            <ReprocessTab
              projects={projects}
              isRootAdmin={session?.user?.isRootAdmin === true}
              presetRequest={reprocessPreset}
              onOpenTab={handleTabChange}
            />
          </div>
        )}

        {activeTab === "llm-context" && (
          <LlmContextTab projects={projects} />
        )}

        {activeTab === "text-annotations" && <TextAnnotationsTab onOpenReprocess={openReprocess} />}

        {activeTab === "csi" && <CsiTab onOpenReprocess={openReprocess} />}

        {activeTab === "heuristics" && <HeuristicsTab onOpenReprocess={openReprocess} />}

        {activeTab === "classifiers" && <ClassifiersTab projects={projects} isRootAdmin={session?.user?.isRootAdmin === true} />}

        {activeTab === "page-intelligence" && <PageIntelligenceTab onOpenReprocess={openReprocess} />}

        {activeTab === "table-parse" && (
          <TableParseTab isRootAdmin={session?.user?.isRootAdmin === true} />
        )}

        {activeTab === "ai-rbac" && session?.user?.isRootAdmin && (
          <AiRbacTab />
        )}

        {activeTab === "companies" && session?.user?.isRootAdmin && (
          <CompaniesUsersTab />
        )}

        {activeTab === "usage" && session?.user?.isRootAdmin && (
          <UsageTab />
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
            isRootAdmin={session?.user?.isRootAdmin === true}
          />
        )}

        {activeTab === "data-tools" && <DataToolsTab isRootAdmin={session?.user?.isRootAdmin === true} onOpenReprocess={openReprocess} />}
        {activeTab === "settings" && (
          <SettingsTab isRootAdmin={session?.user?.isRootAdmin === true} />
        )}

        {activeTab === "logs" && session?.user?.isRootAdmin && (
          <LogsTab />
        )}
      </main>
    </div>
  );
}
