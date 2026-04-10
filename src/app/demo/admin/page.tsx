"use client";

import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import AdminTabs, { type AdminTab } from "@/app/admin/AdminTabs";
import OverviewTab from "@/app/admin/tabs/OverviewTab";
import ProjectsTab from "@/app/admin/tabs/ProjectsTab";
import AiModelsTab from "@/app/admin/tabs/AiModelsTab";
import UsersTab from "@/app/admin/tabs/UsersTab";
import SettingsTab from "@/app/admin/tabs/SettingsTab";
import PipelineTab from "@/app/admin/tabs/PipelineTab";
import LlmContextTab from "@/app/admin/tabs/LlmContextTab";
import TextAnnotationsTab from "@/app/admin/tabs/TextAnnotationsTab";
import CsiTab from "@/app/admin/tabs/CsiTab";
import HeuristicsTab from "@/app/admin/tabs/HeuristicsTab";
import PageIntelligenceTab from "@/app/admin/tabs/PageIntelligenceTab";
import CompaniesUsersTab from "@/app/admin/tabs/CompaniesUsersTab";
import AiRbacTab from "@/app/admin/tabs/AiRbacTab";

interface ProjectItem { id: string; name: string; numPages: number | null; status: string; isDemo: boolean }
interface ModelItem { id: number; name: string; type: string; config: any; isDefault: boolean }
interface UserItem { id: string; username: string; email: string; role: string; canRunModels: boolean }

const noop = () => {};
const noopAsync = async () => {};
const noopAsyncStr = async () => "Read-only demo";

export default function DemoAdminPage() {
  const router = useRouter();
  const [activeTab, setActiveTab] = useState<AdminTab>("overview");
  const [loading, setLoading] = useState(true);
  const [projects, setProjects] = useState<ProjectItem[]>([]);
  const [yoloModels, setYoloModels] = useState<ModelItem[]>([]);
  const [users, setUsers] = useState<UserItem[]>([]);
  const [yoloStatus, setYoloStatus] = useState<Record<string, Record<string, number>>>({});
  const [toggles, setToggles] = useState({ sagemakerEnabled: true, quotaEnabled: false, hasPassword: true });

  useEffect(() => {
    fetch("/api/demo/admin")
      .then((r) => r.json())
      .then((data) => {
        setProjects((data.projects || []).map((p: any) => ({ ...p, isDemo: p.isDemo || false })));
        setYoloModels(data.models || []);
        // Replace real user data with fake demo users for privacy
        const fakeUsers: UserItem[] = [
          { id: "1", username: "root", email: "root@root.com", role: "admin", canRunModels: true },
          { id: "2", username: "admin", email: "admin@blueprintparser.com", role: "admin", canRunModels: true },
          { id: "3", username: "jsmith", email: "jsmith@acme-construction.com", role: "member", canRunModels: true },
          { id: "4", username: "koreya", email: "koreya@acme-construction.com", role: "member", canRunModels: true },
          { id: "5", username: "mrivera", email: "m.rivera@westside-builders.com", role: "admin", canRunModels: true },
          { id: "6", username: "tchen", email: "tchen@westside-builders.com", role: "member", canRunModels: false },
          { id: "7", username: "estimator1", email: "estimator1@summit-eng.com", role: "member", canRunModels: true },
          { id: "8", username: "dpatel", email: "d.patel@summit-eng.com", role: "member", canRunModels: false },
          { id: "9", username: "lnguyen", email: "l.nguyen@pacific-design.com", role: "admin", canRunModels: true },
          { id: "10", username: "bwilson", email: "b.wilson@pacific-design.com", role: "member", canRunModels: false },
        ];
        setUsers(fakeUsers);
        setYoloStatus(data.yoloStatus || {});
        if (data.toggles) setToggles(data.toggles);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  // Tab change handler — persist in URL hash
  const handleTabChange = useCallback((tab: AdminTab) => {
    setActiveTab(tab);
    window.history.replaceState(null, "", `#${tab}`);
  }, []);

  useEffect(() => {
    const hash = window.location.hash.slice(1) as AdminTab;
    if (hash) setActiveTab(hash);
  }, []);

  if (loading) {
    return <div className="min-h-screen flex items-center justify-center text-[var(--muted)]">Loading...</div>;
  }

  return (
    <div className="min-h-screen flex flex-col">
      {/* Header matching real admin */}
      <div className="h-14 border-b border-[var(--border)] bg-[var(--surface)] flex items-center justify-between px-6">
        <div className="flex items-center gap-4">
          <Link href="/demo" className="text-lg font-bold hover:text-[var(--accent)] transition-colors">BlueprintParser</Link>
          <span className="text-[10px] px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-400 border border-amber-400/30 font-medium">
            READ-ONLY DEMO
          </span>
        </div>
        <div className="flex items-center gap-3">
          <Link href="/demo" className="text-xs text-[var(--muted)] hover:text-[var(--fg)]">Back to Demo</Link>
          <Link href="/login" className="px-4 py-1.5 text-sm bg-[var(--accent)] text-white rounded hover:bg-[var(--accent-hover)] transition-colors">
            Sign In
          </Link>
        </div>
      </div>

      <main className="flex-1 p-6 max-w-7xl mx-auto w-full">
        <h1 className="text-2xl font-bold mb-4">Admin Panel</h1>

        <AdminTabs
          active={activeTab}
          onChange={handleTabChange}
          isRootAdmin={true}
        />

        {/* Read-only overlay — blocks all interaction */}
        <div className="read-only-wrapper">
          <style>{`
            .read-only-wrapper button:not([data-demo-nav]),
            .read-only-wrapper input,
            .read-only-wrapper select,
            .read-only-wrapper [role="button"],
            .read-only-wrapper a[href^="/api"] {
              pointer-events: none !important;
              cursor: default !important;
            }
            .read-only-wrapper button:not([data-tab]):not([data-demo-nav]),
            .read-only-wrapper input:not([type="range"]),
            .read-only-wrapper textarea,
            .read-only-wrapper form {
              opacity: 0.6;
            }
          `}</style>

          {activeTab === "overview" && (
            <OverviewTab
              invites={[]}
              unseenInvites={0}
              showInvites={false}
              onMarkSeen={noopAsync}
              isRootAdmin={true}
            />
          )}

          {activeTab === "projects" && (
            <ProjectsTab
              projects={projects}
              onToggleDemo={noopAsync}
              onRefreshDemo={noopAsyncStr}
              reprocessing={false}
              reprocessLog={[]}
              onReprocess={noopAsync}
              setMessage={noop}
            />
          )}

          {activeTab === "ai-models" && (
            <AiModelsTab
              yoloModels={yoloModels}
              projects={projects.filter((p) => p.status === "completed")}
              yoloJobs={{}}
              yoloStatus={yoloStatus}
              uploading={false}
              uploadProgress={0}
              onUploadModel={noopAsync}
              onDeleteModel={noopAsync}
              onRunYolo={noopAsync}
              onLoadResults={noopAsync}
              toggles={toggles}
              togglePassword=""
              setTogglePassword={noop}
              toggleError=""
              setToggleError={noop}
              newTogglePass=""
              setNewTogglePass={noop}
              currentTogglePass=""
              setCurrentTogglePass={noop}
              onToggle={noopAsync}
              onSetTogglePassword={noopAsync}
              isRootAdmin={true}
            />
          )}

          {activeTab === "pipeline" && (
            <PipelineTab
              reprocessing={false}
              reprocessLog={[]}
              onReprocess={noopAsync}
              projects={projects}
            />
          )}

          {activeTab === "llm-context" && (
            <LlmContextTab projects={projects} />
          )}

          {activeTab === "text-annotations" && (
            <TextAnnotationsTab
              reprocessing={false}
              reprocessLog={[]}
              onReprocess={noopAsync}
            />
          )}

          {activeTab === "csi" && (
            <CsiTab
              reprocessing={false}
              reprocessLog={[]}
              onReprocess={noopAsync}
            />
          )}

          {activeTab === "heuristics" && (
            <HeuristicsTab
              reprocessing={false}
              reprocessLog={[]}
              onReprocess={noopAsync}
            />
          )}

          {activeTab === "page-intelligence" && (
            <PageIntelligenceTab
              reprocessing={false}
              reprocessLog={[]}
              onReprocess={noopAsync}
            />
          )}

          {activeTab === "ai-rbac" && <AiRbacTab />}

          {activeTab === "companies" && <CompaniesUsersTab demoMode />}

          {activeTab === "users" && (
            <UsersTab
              users={users}
              currentEmail="root@root.com"
              newUser={{ username: "", email: "", password: "", role: "member" }}
              setNewUser={noop}
              onCreateUser={noopAsync}
              onToggleCanRunModels={noopAsync}
              onDeleteUser={noopAsync}
            />
          )}

          {activeTab === "settings" && (
            <SettingsTab />
          )}
        </div>
      </main>
    </div>
  );
}
