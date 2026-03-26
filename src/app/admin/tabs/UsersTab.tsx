"use client";

interface UserItem {
  id: string;
  username: string;
  email: string;
  role: string;
  canRunModels: boolean;
}

interface UsersTabProps {
  users: UserItem[];
  currentEmail: string;
  newUser: { username: string; email: string; password: string; role: string };
  setNewUser: (u: { username: string; email: string; password: string; role: string }) => void;
  onCreateUser: () => void;
  onToggleCanRunModels: (userId: string, canRunModels: boolean) => void;
  onDeleteUser: (userId: string, username: string) => void;
}

export default function UsersTab({
  users, currentEmail, newUser, setNewUser, onCreateUser, onToggleCanRunModels, onDeleteUser,
}: UsersTabProps) {
  return (
    <div className="space-y-6">
      <section>
        <h2 className="text-lg font-semibold mb-3">Users</h2>
        <div className="border border-[var(--border)] rounded-lg overflow-hidden mb-4">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-[var(--border)] text-left text-[var(--muted)]">
                <th className="px-3 py-2">Username</th>
                <th className="px-3 py-2">Email</th>
                <th className="px-3 py-2">Role</th>
                <th className="px-3 py-2 text-center">Can Run Models</th>
                <th className="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id} className="border-b border-[var(--border)] last:border-0">
                  <td className="px-3 py-2 font-medium">{u.username}</td>
                  <td className="px-3 py-2 text-[var(--muted)]">{u.email}</td>
                  <td className="px-3 py-2">
                    <span className="text-xs px-2 py-0.5 rounded bg-[var(--bg)] text-[var(--muted)]">
                      {u.role}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-center">
                    <button
                      onClick={() => onToggleCanRunModels(u.id, !u.canRunModels)}
                      className={`px-3 py-1 text-xs rounded border transition-colors ${
                        u.canRunModels
                          ? "bg-green-600/20 border-green-500/30 text-green-400 hover:bg-green-600/30"
                          : "bg-[var(--bg)] border-[var(--border)] text-[var(--muted)] hover:border-red-400/50 hover:text-red-400"
                      }`}
                    >
                      {u.canRunModels ? "Yes" : "No"}
                    </button>
                  </td>
                  <td className="px-3 py-2 text-right">
                    {u.email !== currentEmail && (
                      <button
                        onClick={() => onDeleteUser(u.id, u.username)}
                        className="text-xs text-[var(--muted)] hover:text-red-400"
                      >
                        Delete
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
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
            onClick={onCreateUser}
            className="px-4 py-1.5 text-sm bg-[var(--accent)] text-white rounded hover:bg-[var(--accent-hover)]"
          >
            Create User
          </button>
        </div>
      </section>
    </div>
  );
}
