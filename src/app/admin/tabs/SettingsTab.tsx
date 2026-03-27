"use client";

interface SettingsTabProps {
  passwordForm: { currentPassword: string; newPassword: string };
  setPasswordForm: (f: { currentPassword: string; newPassword: string }) => void;
  onChangePassword: () => void;
}

export default function SettingsTab({
  passwordForm, setPasswordForm, onChangePassword,
}: SettingsTabProps) {
  return (
    <div className="space-y-8">
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
            onClick={onChangePassword}
            className="px-4 py-1.5 text-sm bg-[var(--accent)] text-white rounded hover:bg-[var(--accent-hover)]"
          >
            Update Password
          </button>
        </div>
      </section>
    </div>
  );
}
