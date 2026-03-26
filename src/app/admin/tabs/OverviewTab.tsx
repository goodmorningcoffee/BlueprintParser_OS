"use client";

interface InviteItem {
  id: number;
  email: string;
  name: string | null;
  company: string | null;
  seen: boolean;
  createdAt: string;
}

interface OverviewTabProps {
  invites: InviteItem[];
  unseenInvites: number;
  showInvites: boolean;
  onMarkSeen: () => void;
}

export default function OverviewTab({ invites, unseenInvites, showInvites, onMarkSeen }: OverviewTabProps) {
  return (
    <section>
      <button
        onClick={onMarkSeen}
        className={`px-3 py-1.5 text-sm rounded border ${
          unseenInvites > 0
            ? "chat-pulse"
            : showInvites
              ? "border-[var(--accent)] text-[var(--accent)]"
              : "border-[var(--border)] text-[var(--muted)] hover:text-[var(--fg)]"
        }`}
      >
        Invites{unseenInvites > 0 ? ` (${unseenInvites})` : ""}
      </button>
      {showInvites && (
        <div className="mt-4 border border-[var(--border)] rounded-lg overflow-hidden">
          {invites.length === 0 ? (
            <div className="p-4 text-sm text-[var(--muted)] text-center">No invite requests yet.</div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[var(--border)] text-left text-[var(--muted)]">
                  <th className="px-3 py-2">Email</th>
                  <th className="px-3 py-2">Name</th>
                  <th className="px-3 py-2">Company</th>
                  <th className="px-3 py-2">Date</th>
                </tr>
              </thead>
              <tbody>
                {invites.map((inv) => (
                  <tr key={inv.id} className="border-b border-[var(--border)] last:border-0">
                    <td className="px-3 py-2">{inv.email}</td>
                    <td className="px-3 py-2 text-[var(--muted)]">{inv.name || "\u2014"}</td>
                    <td className="px-3 py-2 text-[var(--muted)]">{inv.company || "\u2014"}</td>
                    <td className="px-3 py-2 text-[var(--muted)]">{new Date(inv.createdAt).toLocaleDateString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </section>
  );
}
