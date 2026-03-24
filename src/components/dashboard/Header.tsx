"use client";

import Link from "next/link";
import { signOut, useSession } from "next-auth/react";

export default function Header() {
  const { data: session } = useSession();

  return (
    <header className="h-14 border-b border-[var(--border)] bg-[var(--surface)] flex items-center justify-between px-4">
      <Link href="/home" className="text-lg font-bold tracking-tight">
        BlueprintParser
      </Link>

      <div className="flex items-center gap-4">
        {session?.user && (
          <>
            <span className="text-sm text-[var(--muted)]">
              {session.user.username || session.user.email}
            </span>
            {session.user.role === "admin" && (
              <Link
                href="/admin"
                className="text-sm text-[var(--muted)] hover:text-[var(--fg)]"
              >
                Admin
              </Link>
            )}
            <button
              onClick={() => signOut({ callbackUrl: "/" })}
              className="text-sm text-[var(--muted)] hover:text-[var(--fg)]"
            >
              Sign out
            </button>
          </>
        )}
      </div>
    </header>
  );
}
