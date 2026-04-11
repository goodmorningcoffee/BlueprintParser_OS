"use client";

import { useState } from "react";

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
type Auth = "public" | "session" | "admin" | "root";

interface ApiParam {
  name: string;
  type: string;
  required?: boolean;
  desc: string;
}

interface ApiEndpointProps {
  method: Method;
  path: string;
  auth?: Auth;
  desc: string;
  params?: ApiParam[];
  example?: string;
}

const METHOD_COLOR: Record<Method, string> = {
  GET: "text-emerald-400",
  POST: "text-sky-400",
  PUT: "text-amber-400",
  PATCH: "text-orange-400",
  DELETE: "text-red-400",
};

const AUTH_COLOR: Record<Auth, string> = {
  public: "text-[var(--muted)] border-[var(--border)]",
  session: "text-sky-400/80 border-sky-400/30",
  admin: "text-amber-400/90 border-amber-400/30",
  root: "text-red-400/90 border-red-400/40",
};

export function ApiEndpoint({
  method,
  path,
  auth = "session",
  desc,
  params,
  example,
}: ApiEndpointProps) {
  const [open, setOpen] = useState(false);
  const expandable = (params && params.length > 0) || !!example;

  return (
    <div className="py-1.5 border-b border-[var(--border)]/60">
      <button
        type="button"
        onClick={() => expandable && setOpen((o) => !o)}
        className={`w-full text-left flex flex-wrap items-baseline gap-2 ${expandable ? "cursor-pointer" : "cursor-default"}`}
      >
        <span className={`font-mono font-bold text-[12px] w-14 shrink-0 ${METHOD_COLOR[method]}`}>
          {method}
        </span>
        <span className="font-mono text-sm text-[var(--fg)]">{path}</span>
        <span
          className={`text-[10px] px-1.5 py-0.5 rounded bg-[var(--surface)] border uppercase tracking-wider ${AUTH_COLOR[auth]}`}
        >
          {auth}
        </span>
        <span className="text-sm text-[var(--muted)]">{desc}</span>
        {expandable && (
          <span className="ml-auto text-[10px] text-[var(--muted)]">{open ? "▾" : "▸"}</span>
        )}
      </button>

      {open && expandable && (
        <div className="mt-2 pl-16 pb-2 space-y-2">
          {params && params.length > 0 && (
            <div>
              <div className="text-[10px] uppercase tracking-wider text-[var(--muted)] mb-1">
                Params
              </div>
              <ul className="space-y-1 text-[13px]">
                {params.map((p) => (
                  <li key={p.name} className="font-mono">
                    <span className="text-[var(--accent)]">{p.name}</span>
                    <span className="text-[var(--muted)]">: {p.type}</span>
                    {p.required && <span className="text-red-400/80"> *</span>}
                    <span className="text-[var(--fg)]/90 font-sans"> — {p.desc}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {example && (
            <div>
              <div className="text-[10px] uppercase tracking-wider text-[var(--muted)] mb-1">
                Example
              </div>
              <pre className="text-[13px] font-mono bg-[var(--bg)] border border-[var(--border)] rounded p-2 overflow-x-auto text-[var(--fg)]/95">
                {example}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
