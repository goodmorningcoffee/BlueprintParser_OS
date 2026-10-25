/**
 * [2026-10-25 root hardening] The ROOT_ADMIN_EMAIL bootstrap address is reserved: it may be
 * created only by root (admin-users.ts createUser) and never self-registered (invite-register.ts),
 * so nobody can seat himself at that address ahead of the owner. The bootstrap promotion itself is
 * one-shot (lib/auth.ts: only while no root exists).
 */
export function isReservedRootBootstrapEmail(email: string, env: Record<string, string | undefined> = process.env): boolean {
  const reserved = env.ROOT_ADMIN_EMAIL?.trim().toLowerCase();
  return !!reserved && email.trim().toLowerCase() === reserved;
}
