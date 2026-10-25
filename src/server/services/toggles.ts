// [refactor jul7 S055] admin/toggles SOLO — read the app-global feature toggles + set-password/
// toggle mutations, folded from the legacy route (git show 3ba89e6:src/app/api/admin/toggles/
// route.ts). Char: __tests__/admin-toggles.route.test.ts (TG-*). requireAdmin (the shell
// provides auth:"admin"). Sanctioned diffs A (flat auth + all validation literals + the dynamic
// set-password error → envelope) + E (PUT `await req.json()` → shell "Invalid JSON body"); no
// catch-500 → NO B. The @/lib/toggles calls (S3 app-global + the INDEPENDENT bcrypt toggle-
// password subsystem) are ported verbatim; the toggle-name→key mapping preserved.

import {
  getToggles,
  setToggle,
  hasTogglePassword,
  setTogglePassword,
  verifyTogglePassword,
} from "@/lib/toggles";
import { ApiError } from "@/server/api/envelope";
import { audit } from "@/lib/audit";
import type { AuthSession } from "@/lib/api-utils";
import { requireVerifiedRoot } from "@/server/api/root-authority";

export async function getTogglesStatus(): Promise<unknown> {
  const toggles = await getToggles();
  const hasPassword = await hasTogglePassword();

  return {
    sagemakerEnabled: toggles.sagemakerEnabled,
    quotaEnabled: toggles.quotaEnabled,
    hasPassword,
  };
}

export async function updateToggle(body: Record<string, unknown>, session: AuthSession): Promise<unknown> {
  // [2026-10-25] Root only (verified 2FA) — the shell is auth:"root"; this is the in-service re-check.
  requireVerifiedRoot(session);
  const actor = { userId: session.user.dbId, companyId: session.user.companyId };
  // Set or change the toggle password
  if (body.action === "set-password") {
    const { newPassword, currentPassword } = body as { newPassword?: string; currentPassword?: string };
    if (!newPassword || newPassword.length < 6) {
      throw new ApiError("VALIDATION", "Password must be at least 6 characters");
    }
    const result = await setTogglePassword(newPassword, currentPassword);
    if (!result.success) {
      throw new ApiError("UNAUTHORIZED", result.error ?? "Unauthorized");
    }
    audit("toggle_password_changed", actor);
    return { success: true };
  }

  // Toggle a setting
  const { toggle, enabled, password } = body as { toggle?: string; enabled?: unknown; password?: string };

  if (!toggle || typeof enabled !== "boolean" || !password) {
    throw new ApiError("VALIDATION", "toggle, enabled, and password required");
  }

  if (toggle !== "sagemaker" && toggle !== "quota") {
    throw new ApiError("VALIDATION", "Invalid toggle");
  }

  // Verify the independent toggle password
  const hasPass = await hasTogglePassword();
  if (!hasPass) {
    throw new ApiError("VALIDATION", "Toggle password not set. Set it first.");
  }

  const valid = await verifyTogglePassword(password);
  if (!valid) {
    throw new ApiError("UNAUTHORIZED", "Invalid toggle password");
  }

  const key = toggle === "sagemaker" ? "sagemakerEnabled" : "quotaEnabled";
  const before = await getToggles(true);
  const updated = await setToggle(key, enabled);
  audit("toggle_changed", { ...actor, details: { toggle: key, before: before[key], after: updated[key] } });

  return {
    success: true,
    sagemakerEnabled: updated.sagemakerEnabled,
    quotaEnabled: updated.quotaEnabled,
  };
}
