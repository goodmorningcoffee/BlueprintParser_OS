"use client";

import { useState, useEffect, useCallback } from "react";

interface CompanyItem {
  id: number;
  publicId: string;
  name: string;
  accessKey: string;
  dataKey: string;
  userCount: number;
  projectCount: number;
}

interface UserItem {
  id: string;
  username: string;
  email: string;
  role: string;
  companyId: number;
  companyName?: string;
  canRunModels: boolean;
  isRootAdmin: boolean;
}

// Demo fake data — shown instead of real user/company data in demo mode
const DEMO_COMPANIES: CompanyItem[] = [
  { id: 1, publicId: "acme-001", name: "Acme Construction", accessKey: "demo-key-acme", dataKey: "acme-data", userCount: 2, projectCount: 4 },
  { id: 2, publicId: "west-002", name: "Westside Builders", accessKey: "demo-key-west", dataKey: "westside-data", userCount: 2, projectCount: 2 },
  { id: 3, publicId: "summ-003", name: "Summit Engineering", accessKey: "demo-key-summ", dataKey: "summit-data", userCount: 2, projectCount: 3 },
  { id: 4, publicId: "pacf-004", name: "Pacific Design Group", accessKey: "demo-key-pacf", dataKey: "pacific-data", userCount: 2, projectCount: 1 },
];
const DEMO_USERS: UserItem[] = [
  { id: "1", username: "demo-admin", email: "admin@acme-construction.com", role: "admin", companyId: 1, companyName: "Acme Construction", canRunModels: true, isRootAdmin: true },
  { id: "3", username: "jsmith", email: "jsmith@acme-construction.com", role: "member", companyId: 1, companyName: "Acme Construction", canRunModels: true, isRootAdmin: false },
  { id: "5", username: "mrivera", email: "m.rivera@westside-builders.com", role: "admin", companyId: 2, companyName: "Westside Builders", canRunModels: true, isRootAdmin: false },
  { id: "6", username: "tchen", email: "tchen@westside-builders.com", role: "member", companyId: 2, companyName: "Westside Builders", canRunModels: false, isRootAdmin: false },
  { id: "7", username: "estimator1", email: "estimator1@summit-eng.com", role: "member", companyId: 3, companyName: "Summit Engineering", canRunModels: true, isRootAdmin: false },
  { id: "8", username: "dpatel", email: "d.patel@summit-eng.com", role: "member", companyId: 3, companyName: "Summit Engineering", canRunModels: false, isRootAdmin: false },
  { id: "9", username: "lnguyen", email: "l.nguyen@pacific-design.com", role: "admin", companyId: 4, companyName: "Pacific Design Group", canRunModels: true, isRootAdmin: false },
  { id: "10", username: "bwilson", email: "b.wilson@pacific-design.com", role: "member", companyId: 4, companyName: "Pacific Design Group", canRunModels: false, isRootAdmin: false },
];

export default function CompaniesUsersTab({ demoMode = false }: { demoMode?: boolean } = {}) {
  const [companies, setCompanies] = useState<CompanyItem[]>(demoMode ? DEMO_COMPANIES : []);
  const [users, setUsers] = useState<UserItem[]>(demoMode ? DEMO_USERS : []);
  const [expanded, setExpanded] = useState<Record<number, boolean>>({});
  const [loading, setLoading] = useState(!demoMode);
  const [newCompanyName, setNewCompanyName] = useState("");
  const [creating, setCreating] = useState(false);
  const [addingUserTo, setAddingUserTo] = useState<number | null>(null);
  const [addingUser, setAddingUser] = useState(false);
  const [newUser, setNewUser] = useState({ username: "", email: "", password: "", role: "member" });
  const [message, setMessage] = useState("");
  const [formError, setFormError] = useState("");
  const [copiedKey, setCopiedKey] = useState<number | null>(null);
  // Password reset state
  const [resettingUserId, setResettingUserId] = useState<string | null>(null);
  const [resetNewPw, setResetNewPw] = useState("");
  const [resetAdminPw, setResetAdminPw] = useState("");
  const [resetBusy, setResetBusy] = useState(false);
  const [resetMessage, setResetMessage] = useState("");

  const loadData = useCallback(async () => {
    if (demoMode) { setLoading(false); return; }
    try {
      const [compRes, userRes] = await Promise.all([
        fetch("/api/admin/companies"),
        fetch("/api/admin/users"),
      ]);
      if (compRes.ok) setCompanies((await compRes.json()).companies);
      if (userRes.ok) setUsers(await userRes.json());
    } catch { /* ignore */ }
    setLoading(false);
  }, [demoMode]);

  useEffect(() => { loadData(); }, [loadData]);

  const createCompany = async () => {
    if (demoMode || !newCompanyName.trim()) return;
    setCreating(true);
    try {
      const res = await fetch("/api/admin/companies", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newCompanyName.trim() }),
      });
      if (res.ok) {
        setNewCompanyName("");
        setMessage("Company created");
        setTimeout(() => setMessage(""), 3000);
        loadData();
      } else {
        const err = await res.json();
        setMessage(err.error || "Failed");
      }
    } catch { setMessage("Failed"); }
    setCreating(false);
  };

  const addUser = async (companyId: number) => {
    if (demoMode) return;
    setFormError("");
    if (!newUser.username || !newUser.email || !newUser.password) {
      setFormError("Username, email, and password are required");
      return;
    }
    if (newUser.password.length < 8) {
      setFormError("Password must be at least 8 characters");
      return;
    }
    setAddingUser(true);
    try {
      const res = await fetch("/api/admin/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...newUser, companyId }),
      });
      if (res.ok) {
        setAddingUserTo(null);
        setNewUser({ username: "", email: "", password: "", role: "member" });
        setFormError("");
        setMessage("User created");
        setTimeout(() => setMessage(""), 3000);
        loadData();
      } else {
        const err = await res.json();
        setFormError(err.error || "Failed to create user");
      }
    } catch { setFormError("Failed to create user"); }
    setAddingUser(false);
  };

  const deleteUser = async (userId: string) => {
    if (demoMode || !confirm("Delete this user?")) return;
    const res = await fetch("/api/admin/users", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: userId }),
    });
    if (res.ok) loadData();
  };

  const resetPassword = async (userId: string) => {
    if (demoMode) return;
    if (!resetNewPw || resetNewPw.length < 8) { setResetMessage("Password must be 8+ chars"); return; }
    if (!resetAdminPw) { setResetMessage("Enter your admin password to confirm"); return; }
    setResetBusy(true);
    setResetMessage("");
    const res = await fetch("/api/admin/users/reset-password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId, newPassword: resetNewPw, adminPassword: resetAdminPw }),
    });
    if (res.ok) {
      setResetMessage("Password reset");
      setResetNewPw("");
      setResetAdminPw("");
      setTimeout(() => { setResettingUserId(null); setResetMessage(""); }, 2000);
    } else {
      const err = await res.json().catch(() => ({ error: "Failed" }));
      setResetMessage(err.error || "Failed");
    }
    setResetBusy(false);
  };

  const toggleRole = async (userId: string, currentRole: string) => {
    const newRole = currentRole === "admin" ? "member" : "admin";
    const res = await fetch("/api/admin/users", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: userId, role: newRole }),
    });
    if (res.ok) {
      loadData();
    } else {
      const err = await res.json().catch(() => ({ error: "Failed" }));
      setMessage(err.error || "Failed to update role");
      setTimeout(() => setMessage(""), 4000);
    }
  };

  const copyKey = (companyId: number, key: string) => {
    navigator.clipboard.writeText(key);
    setCopiedKey(companyId);
    setTimeout(() => setCopiedKey(null), 2000);
  };

  const deleteCompany = async (companyId: number) => {
    if (demoMode || !confirm("Delete this company? Must have 0 users and 0 projects.")) return;
    const res = await fetch("/api/admin/companies", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ companyId }),
    });
    if (res.ok) {
      loadData();
    } else {
      const err = await res.json();
      setMessage(err.error || "Failed");
      setTimeout(() => setMessage(""), 4000);
    }
  };

  if (loading) return <div className="text-sm text-[var(--muted)]">Loading...</div>;

  return (
    <div className="max-w-4xl space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold">Companies / Users</h2>
        {message && <span className="text-xs text-[var(--accent)]">{message}</span>}
      </div>

      {/* Create company */}
      <div className="flex gap-2 items-center">
        <input
          value={newCompanyName}
          onChange={(e) => setNewCompanyName(e.target.value)}
          placeholder="New company name..."
          className="flex-1 text-xs px-3 py-1.5 bg-[var(--bg)] border border-[var(--border)] rounded text-[var(--fg)] outline-none focus:border-[var(--accent)]/50"
          onKeyDown={(e) => e.key === "Enter" && createCompany()}
        />
        <button
          onClick={createCompany}
          disabled={creating || !newCompanyName.trim()}
          className="px-4 py-1.5 text-xs rounded bg-[var(--accent)] text-white font-medium disabled:opacity-40"
        >
          + New Company
        </button>
      </div>

      {/* Company list */}
      <div className="space-y-2">
        {companies.map((company) => {
          const isExpanded = expanded[company.id] !== false;
          const companyUsers = users.filter((u) => u.companyId === company.id);

          return (
            <div key={company.id} className="border border-[var(--border)] rounded bg-[var(--bg)]">
              {/* Company header */}
              <div className="flex items-center gap-3 px-3 py-2 bg-[var(--surface)]">
                <button
                  onClick={() => setExpanded((p) => ({ ...p, [company.id]: !isExpanded }))}
                  className="text-[10px] text-[var(--muted)] hover:text-[var(--fg)] w-3"
                >
                  {isExpanded ? "\u25BC" : "\u25B6"}
                </button>
                <span className="text-xs font-medium text-[var(--fg)] flex-1">{company.name}</span>
                <span className="text-[10px] text-[var(--muted)]">
                  {company.userCount} user{company.userCount !== 1 ? "s" : ""}, {company.projectCount} project{company.projectCount !== 1 ? "s" : ""}
                </span>
                {company.userCount === 0 && company.projectCount === 0 && (
                  <button onClick={() => deleteCompany(company.id)} className="text-[10px] text-red-400 hover:text-red-300">&times;</button>
                )}
              </div>

              {isExpanded && (
                <div className="px-3 pb-3 space-y-2">
                  {/* Access key */}
                  <div className="flex items-center gap-2 py-1">
                    <span className="text-[10px] text-[var(--muted)]">Access Key:</span>
                    <code className="text-[10px] font-mono text-[var(--fg)] bg-[var(--surface)] px-2 py-0.5 rounded select-all">
                      {company.accessKey}
                    </code>
                    <button
                      onClick={() => copyKey(company.id, company.accessKey)}
                      className="text-[10px] text-[var(--muted)] hover:text-[var(--fg)]"
                    >
                      {copiedKey === company.id ? "Copied!" : "Copy"}
                    </button>
                  </div>

                  {/* Users list */}
                  {companyUsers.length > 0 ? (
                    <div className="space-y-0.5">
                      {companyUsers.map((user) => (
                        <div key={user.id}>
                        <div className="flex items-center gap-2 px-2 py-1 rounded hover:bg-[var(--surface-hover)] text-[11px]">
                          <span className="text-[var(--fg)] flex-1 truncate">{user.email}</span>
                          <span className="text-[var(--muted)]">{user.username}</span>
                          <button
                            onClick={() => toggleRole(user.id, user.role)}
                            className={`px-1.5 py-0.5 rounded text-[9px] font-medium ${
                              user.role === "admin" ? "bg-amber-500/20 text-amber-400" : "bg-[var(--surface)] text-[var(--muted)]"
                            }`}
                          >
                            {user.isRootAdmin ? "root" : user.role}
                          </button>
                          <button
                            onClick={() => { setResettingUserId(resettingUserId === user.id ? null : user.id); setResetNewPw(""); setResetAdminPw(""); setResetMessage(""); }}
                            className="text-[9px] text-[var(--muted)] hover:text-amber-400 px-1"
                            title="Reset password"
                          >
                            PW
                          </button>
                          {!user.isRootAdmin && (
                            <button onClick={() => deleteUser(user.id)} className="text-red-400/60 hover:text-red-400 text-xs">&times;</button>
                          )}
                        </div>
                        {resettingUserId === user.id && (
                          <div className="mx-2 mb-1 p-2 border border-amber-500/30 rounded bg-amber-500/5 space-y-1.5">
                            <div className="text-[9px] text-amber-400 font-medium">Reset password for {user.email}</div>
                            <input
                              value={resetNewPw}
                              onChange={(e) => { setResetMessage(""); setResetNewPw(e.target.value); }}
                              placeholder="New password (8+ chars)"
                              type="password"
                              className="w-full text-[10px] px-2 py-1 bg-[var(--bg)] border border-[var(--border)] rounded text-[var(--fg)] outline-none"
                            />
                            <input
                              value={resetAdminPw}
                              onChange={(e) => { setResetMessage(""); setResetAdminPw(e.target.value); }}
                              placeholder="Your admin password (confirm identity)"
                              type="password"
                              className="w-full text-[10px] px-2 py-1 bg-[var(--bg)] border border-[var(--border)] rounded text-[var(--fg)] outline-none"
                            />
                            {resetMessage && <div className={`text-[9px] ${resetMessage === "Password reset" ? "text-green-400" : "text-red-400"}`}>{resetMessage}</div>}
                            <div className="flex gap-1">
                              <button onClick={() => resetPassword(user.id)} disabled={resetBusy} className="flex-1 text-[10px] px-2 py-1 rounded bg-amber-600 text-white disabled:opacity-40">{resetBusy ? "Resetting..." : "Reset Password"}</button>
                              <button onClick={() => setResettingUserId(null)} className="text-[10px] px-2 py-1 text-[var(--muted)]">Cancel</button>
                            </div>
                          </div>
                        )}
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="text-[10px] text-[var(--muted)] italic px-2">No users</div>
                  )}

                  {/* Add user form */}
                  {addingUserTo === company.id ? (
                    <div className="border border-[var(--border)] rounded p-2 space-y-1.5">
                      <input value={newUser.username} onChange={(e) => { setFormError(""); setNewUser({ ...newUser, username: e.target.value }); }} placeholder="Username" className="w-full text-[10px] px-2 py-1 bg-[var(--bg)] border border-[var(--border)] rounded text-[var(--fg)] outline-none" />
                      <input value={newUser.email} onChange={(e) => { setFormError(""); setNewUser({ ...newUser, email: e.target.value }); }} placeholder="Email" className="w-full text-[10px] px-2 py-1 bg-[var(--bg)] border border-[var(--border)] rounded text-[var(--fg)] outline-none" />
                      <input value={newUser.password} onChange={(e) => { setFormError(""); setNewUser({ ...newUser, password: e.target.value }); }} placeholder="Password (8+ chars)" type="password" className="w-full text-[10px] px-2 py-1 bg-[var(--bg)] border border-[var(--border)] rounded text-[var(--fg)] outline-none" />
                      {formError && <div className="text-[10px] text-red-400 px-1">{formError}</div>}
                      <div className="flex gap-1">
                        <select value={newUser.role} onChange={(e) => setNewUser({ ...newUser, role: e.target.value })} className="text-[10px] px-2 py-1 bg-[var(--bg)] border border-[var(--border)] rounded text-[var(--fg)]">
                          <option value="member">Member</option>
                          <option value="admin">Admin</option>
                        </select>
                        <button onClick={() => addUser(company.id)} disabled={addingUser} className="flex-1 text-[10px] px-2 py-1 rounded bg-[var(--accent)] text-white disabled:opacity-40">{addingUser ? "Creating..." : "Create"}</button>
                        <button onClick={() => { setAddingUserTo(null); setFormError(""); }} className="text-[10px] px-2 py-1 text-[var(--muted)]">Cancel</button>
                      </div>
                    </div>
                  ) : (
                    <button
                      onClick={() => { setAddingUserTo(company.id); setNewUser({ username: "", email: "", password: "", role: "member" }); }}
                      className="text-[10px] text-[var(--muted)] hover:text-[var(--fg)] px-2"
                    >
                      + Add User
                    </button>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
