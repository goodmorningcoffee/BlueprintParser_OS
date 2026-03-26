"use client";

interface SettingsTabProps {
  toggles: { sagemakerEnabled: boolean; quotaEnabled: boolean; hasPassword: boolean };
  togglePassword: string;
  setTogglePassword: (v: string) => void;
  toggleError: string;
  setToggleError: (v: string) => void;
  newTogglePass: string;
  setNewTogglePass: (v: string) => void;
  currentTogglePass: string;
  setCurrentTogglePass: (v: string) => void;
  onToggle: (toggle: "sagemaker" | "quota", enabled: boolean) => void;
  onSetTogglePassword: () => void;
  passwordForm: { currentPassword: string; newPassword: string };
  setPasswordForm: (f: { currentPassword: string; newPassword: string }) => void;
  onChangePassword: () => void;
}

export default function SettingsTab({
  toggles, togglePassword, setTogglePassword, toggleError, setToggleError,
  newTogglePass, setNewTogglePass, currentTogglePass, setCurrentTogglePass,
  onToggle, onSetTogglePassword, passwordForm, setPasswordForm, onChangePassword,
}: SettingsTabProps) {
  return (
    <div className="space-y-8">
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
                onClick={onSetTogglePassword}
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
                  onClick={() => onToggle("sagemaker", !toggles.sagemakerEnabled)}
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
                  onClick={() => onToggle("quota", !toggles.quotaEnabled)}
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
                    <button onClick={onSetTogglePassword} disabled={newTogglePass.length < 6}
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
