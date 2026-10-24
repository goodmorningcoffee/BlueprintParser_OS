"use client";

// [classifier builder track 3] The recipe list: built-in / custom, enabled, version, "modified from
// built-in" badge, unsaved marker; new custom recipe.

import { useState } from "react";
import type { ClassifierRecipe } from "@/lib/classifier-engine";

const INPUT = "px-2 py-1 text-xs bg-[var(--bg)] border border-[var(--border)] rounded text-[var(--fg)] outline-none";

export interface RecipeListItem { recipe: ClassifierRecipe; modified: boolean; unsaved: boolean }

export interface RecipeListProps {
  items: RecipeListItem[];
  selected: string | null;
  onSelect: (id: string) => void;
  onNew: (id: string, name: string) => void;
  onRemoveCustom: (id: string) => void;
}

export default function RecipeList({ items, selected, onSelect, onNew, onRemoveCustom }: RecipeListProps) {
  const [draft, setDraft] = useState({ id: "", name: "" });
  const idOk = /^[a-z0-9][a-z0-9._-]{0,79}$/.test(draft.id) && !items.some((i) => i.recipe.id === draft.id);
  return (
    <div className="space-y-2">
      <ul className="space-y-1">
        {items.map(({ recipe, modified, unsaved }) => (
          <li key={recipe.id}>
            <button type="button" onClick={() => onSelect(recipe.id)} aria-current={selected === recipe.id ? "true" : undefined}
              className={`w-full text-left px-2 py-1.5 rounded border text-xs ${selected === recipe.id ? "border-[var(--accent)] bg-[var(--accent)]/10" : "border-[var(--border)] hover:border-[var(--fg)]/30"}`}>
              <div className="flex items-center gap-1.5">
                <span className={`font-medium ${recipe.enabled ? "" : "line-through opacity-60"}`}>{recipe.name}</span>
                {unsaved && <span className="text-amber-400" title="unsaved changes">●</span>}
              </div>
              <div className="flex flex-wrap gap-1 mt-0.5 text-[10px] text-[var(--muted)]">
                <span className="font-mono">{recipe.id}</span>
                <span>v{recipe.version}</span>
                <span className={`px-1 rounded ${recipe.source === "built-in" ? "bg-[var(--accent)]/15 text-[var(--accent)]" : "bg-amber-500/15 text-amber-300"}`}>{recipe.source}</span>
                {modified && <span className="px-1 rounded bg-amber-500/15 text-amber-300">modified from built-in</span>}
                {!recipe.enabled && <span className="px-1 rounded bg-red-500/15 text-red-300">disabled</span>}
                <span>{recipe.classes.length} classes</span>
              </div>
            </button>
            {recipe.source === "custom" && (
              <button type="button" className="text-[10px] text-[var(--muted)] hover:text-red-400 px-2" onClick={() => onRemoveCustom(recipe.id)}>remove custom recipe</button>
            )}
          </li>
        ))}
      </ul>
      <div className="border-t border-[var(--border)] pt-2 space-y-1">
        <p className="text-[10px] text-[var(--muted)]">New custom recipe</p>
        <input className={`${INPUT} w-full`} placeholder="id (e.g. acme.louvers)" value={draft.id} onChange={(e) => setDraft({ ...draft, id: e.target.value })} />
        <input className={`${INPUT} w-full`} placeholder="name" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
        <button type="button" disabled={!idOk || !draft.name.trim()} className="px-2 py-1 text-[10px] rounded border border-[var(--border)] hover:border-emerald-400/50 disabled:opacity-50"
          onClick={() => { onNew(draft.id, draft.name.trim()); setDraft({ id: "", name: "" }); }}>+ Create recipe</button>
      </div>
    </div>
  );
}
