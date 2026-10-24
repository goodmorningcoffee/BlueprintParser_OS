"use client";

// [classifier builder track 3 2026-10-24] Admin › Classifiers — see and edit every rule the classifier
// engine runs (lib/classifier-engine), preview a draft on real pages, save the company overlay, run it
// on a project. Loads GET /api/admin/classifiers (built-ins + overlay + effective + signal catalog),
// edits EFFECTIVE recipes as drafts (draft-ops.ts, pure), saves the overlay that reproduces the drafts
// (PUT /api/admin/classifiers/overlay — validated server-side; the same validator runs here first so
// the message is immediate). Root may pick a company. Sits beside Heuristics (owner gate: the
// HeuristicsTab stays until the port is accepted). Components live in ./classifiers/.

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  BUILT_IN_RECIPES, blankRecipe, validateOverlay,
  type ClassifierOverlay, type ClassifierRecipe, type SignalCatalog,
} from "@/lib/classifier-engine";
import PreviewPane, { type PreviewProject } from "./classifiers/PreviewPane";
import RecipeEditor from "./classifiers/RecipeEditor";
import RecipeList from "./classifiers/RecipeList";
import { isModified, overlayFromDrafts, type Drafts } from "./classifiers/draft-ops";

interface BuilderPayload {
  companyId: number;
  companyName: string;
  builtIns: ClassifierRecipe[];
  builtInsHash: string;
  overlay: ClassifierOverlay | null;
  effective: ClassifierRecipe[];
  catalog: SignalCatalog;
}

interface Company { id: number; name: string }

export interface ClassifiersTabProps {
  projects: PreviewProject[];
  isRootAdmin: boolean;
}

const INPUT = "px-2 py-1 text-xs bg-[var(--bg)] border border-[var(--border)] rounded text-[var(--fg)] outline-none";
const draftsOf = (recipes: readonly ClassifierRecipe[]): Drafts => Object.fromEntries(recipes.map((r) => [r.id, JSON.parse(JSON.stringify(r)) as ClassifierRecipe]));
const sameJson = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

export default function ClassifiersTab({ projects, isRootAdmin }: ClassifiersTabProps) {
  const [data, setData] = useState<BuilderPayload | null>(null);
  const [drafts, setDrafts] = useState<Drafts>({});
  const [selected, setSelected] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [companyId, setCompanyId] = useState<number | null>(null);
  const [companies, setCompanies] = useState<Company[]>([]);
  const [ownCompanyId, setOwnCompanyId] = useState<number | null>(null);

  const load = useCallback(async (cid: number | null) => {
    setLoading(true);
    try {
      const res = await fetch(cid === null ? "/api/admin/classifiers" : `/api/admin/classifiers?companyId=${cid}`);
      if (!res.ok) { setMessage({ kind: "error", text: `Could not load the classifiers (HTTP ${res.status})` }); setData(null); return; }
      const payload = (await res.json()) as BuilderPayload;
      setData(payload);
      setDrafts(draftsOf(payload.effective));
      setSelected((s) => s && payload.effective.some((r) => r.id === s) ? s : payload.effective[0]?.id ?? null);
      if (cid === null) setOwnCompanyId(payload.companyId);
    } catch (e) { setMessage({ kind: "error", text: e instanceof Error ? e.message : "Could not load the classifiers" }); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { void load(companyId); }, [companyId, load]);
  useEffect(() => {
    if (!isRootAdmin) return;
    fetch("/api/admin/companies").then(async (r) => { if (r.ok) setCompanies(((await r.json()) as Company[]).map((c) => ({ id: c.id, name: c.name }))); }).catch(() => { /* picker stays empty */ });
  }, [isRootAdmin]);

  const builtIns = data?.builtIns ?? (BUILT_IN_RECIPES as ClassifierRecipe[]);
  const builtInOf = (id: string) => builtIns.find((r) => r.id === id);
  const savedDrafts = useMemo(() => draftsOf(data?.effective ?? []), [data]);
  const items = Object.values(drafts).map((recipe) => ({ recipe, modified: isModified(builtInOf(recipe.id), recipe), unsaved: !sameJson(recipe, savedDrafts[recipe.id]) }));
  const dirty = items.some((i) => i.unsaved) || Object.keys(savedDrafts).some((id) => !drafts[id]);
  const draft = selected ? drafts[selected] ?? null : null;

  const save = async () => {
    if (!data) return;
    const overlay = overlayFromDrafts(builtIns, drafts);
    const checked = validateOverlay(overlay, builtIns);
    if (checked.errors.length) { setMessage({ kind: "error", text: `Not saved: ${checked.errors.slice(0, 5).join("; ")}` }); return; }
    setSaving(true); setMessage(null);
    try {
      const res = await fetch("/api/admin/classifiers/overlay", {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ overlay, ...(companyId !== null ? { companyId } : {}) }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) { setMessage({ kind: "error", text: body?.error?.message ?? `Save failed (HTTP ${res.status})` }); return; }
      const versions = body.versions as Record<string, number> | undefined;
      setMessage({ kind: "ok", text: `Saved${versions && Object.keys(versions).length ? ` — ${Object.entries(versions).map(([id, v]) => `${id} v${v}`).join(", ")}` : " (no company changes; built-ins apply)"}. Run the recipes on a project to refresh its proposals.` });
      await load(companyId);
    } catch (e) { setMessage({ kind: "error", text: e instanceof Error ? e.message : "Save failed" }); }
    finally { setSaving(false); }
  };

  const discard = () => { setDrafts(draftsOf(data?.effective ?? [])); setMessage(null); };

  return (
    <div className="space-y-4" data-testid="classifiers-tab">
      <div className="flex flex-wrap items-center gap-3">
        <div>
          <h2 className="text-lg font-semibold">Classifiers</h2>
          <p className="text-xs text-[var(--muted)]">Every rule the classifier engine runs: candidates → detect head → naming classes, each signal a weighted row. Edit, preview on real pages, save for {data?.companyName ?? "your company"}, then run on a project.</p>
        </div>
        {isRootAdmin && companies.length > 0 && (
          <label className="text-[10px] text-[var(--muted)]">company{" "}
            <select className={INPUT} value={companyId ?? ownCompanyId ?? ""} aria-label="company" onChange={(e) => setCompanyId(Number(e.target.value) === ownCompanyId ? null : Number(e.target.value))}>
              {companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </label>
        )}
        <div className="ml-auto flex items-center gap-2">
          {dirty && <button type="button" className="px-3 py-1 text-xs rounded border border-[var(--border)]" onClick={discard}>Discard changes</button>}
          <button type="button" className="px-3 py-1 text-xs rounded bg-[var(--accent)] text-white disabled:opacity-50" disabled={!dirty || saving || !data} onClick={save}>{saving ? "Saving…" : "Save for company"}</button>
        </div>
      </div>
      {message && <p className={`text-xs ${message.kind === "ok" ? "text-emerald-300" : "text-red-400"}`} role="status">{message.text}</p>}
      {loading && !data && <p className="text-xs text-[var(--muted)]">Loading recipes…</p>}
      {!loading && !data && <p className="text-xs text-[var(--muted)]">Nothing to show — reload the page or check the server log.</p>}
      {data && (
        <div className="grid lg:grid-cols-[16rem_1fr] gap-4">
          <RecipeList items={items} selected={selected} onSelect={setSelected}
            onNew={(id, name) => { setDrafts((d) => ({ ...d, [id]: blankRecipe(id, name) })); setSelected(id); }}
            onRemoveCustom={(id) => { setDrafts((d) => { const next = { ...d }; delete next[id]; return next; }); setSelected((s) => (s === id ? null : s)); }} />
          <div className="space-y-4 min-w-0">
            {draft
              ? <RecipeEditor draft={draft} builtIn={builtInOf(draft.id)} catalog={data.catalog} onChange={(next) => setDrafts((d) => ({ ...d, [next.id]: next }))} />
              : <p className="text-xs text-[var(--muted)] italic">Select a recipe on the left, or create a custom one.</p>}
            <div className="border-t border-[var(--border)] pt-3">
              <PreviewPane draft={draft} projects={projects} companyId={companyId} canRun={companyId === null} />
            </div>
          </div>
        </div>
      )}
      {data && data.catalog.models.length === 0 && <p className="text-[10px] text-amber-400">No YOLO models are registered for this company — yolo signals cannot pick classes from a catalog (type them in a model&apos;s class list first).</p>}
    </div>
  );
}
