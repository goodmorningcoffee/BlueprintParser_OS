"use client";

// [TP-3 WP-3.E] Root-only "Parse engine" card (admin › Pipeline). GET/PUT /api/admin/parse-engine
// (validated again on the server, audited). The kill switch turns the Tables & Notes workspace off and
// sends every tool back to its classic path at once, without a deploy. Each tool can be pinned to
// legacy or engine, or left on "default", which follows the code default (the builder flips a default
// only after the engine beats the classic tool on the test data; the next release ships the flip).
// The crop-cache switch covers the standard (Python) crop results only: paid Textract results are
// always cached for signed-in users so nobody pays twice for the same box.

import { useEffect, useState } from "react";
import { apiErrorMessage, getJson, persistFetch } from "@/lib/client-persist";
import { PARSE_ENGINE_TOOL_IDS, type ParseEngineFlags, type ParseEngineMode, type ParseEngineToolId } from "@/lib/parse-engine/types";

interface AdminView {
  stored: unknown;
  effective: ParseEngineFlags;
  defaults: ParseEngineFlags;
  invalid: string[];
}

type Choice = "default" | ParseEngineMode;
interface Draft {
  killSwitch: boolean;
  cropCache: "default" | "on" | "off";
  tools: Record<ParseEngineToolId, Choice>;
}

const TOOL_LABELS: Record<ParseEngineToolId, string> = {
  workspace: "Tables & Notes workspace",
  tablesRoute: "Schedules / tables (classic parse)",
  keynoteRoute: "Keynotes (classic parse)",
  notesClassifier: "Notes classifier",
  specClassifier: "Spec classifier",
  notesAuto: "Notes (automatic stage)",
  specAuto: "Specs (automatic stage)",
};

const btn = "px-2.5 py-1 rounded border border-[var(--border)] hover:border-[var(--accent)] disabled:opacity-40";
const sel = "px-1.5 py-0.5 bg-[var(--bg)] border border-[var(--border)] rounded";

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** The stored overrides as the editable draft ("default" where nothing is pinned). */
export function draftFromStored(stored: unknown): Draft {
  const doc = isObj(stored) ? stored : {};
  const tools = isObj(doc.tools) ? doc.tools : {};
  const draft: Draft = {
    killSwitch: doc.killSwitch === true,
    cropCache: doc.cropCache === true ? "on" : doc.cropCache === false ? "off" : "default",
    tools: {} as Record<ParseEngineToolId, Choice>,
  };
  for (const id of PARSE_ENGINE_TOOL_IDS) {
    const m = tools[id];
    draft.tools[id] = m === "legacy" || m === "engine" ? m : "default";
  }
  return draft;
}

/** The PUT body: only pinned fields are sent, so unpinned ones keep following the code default. */
export function bodyFromDraft(d: Draft): { killSwitch: boolean; cropCache?: boolean; tools: Partial<Record<ParseEngineToolId, ParseEngineMode>> } {
  const tools: Partial<Record<ParseEngineToolId, ParseEngineMode>> = {};
  for (const id of PARSE_ENGINE_TOOL_IDS) {
    const c = d.tools[id];
    if (c !== "default") tools[id] = c;
  }
  return { killSwitch: d.killSwitch, ...(d.cropCache === "default" ? {} : { cropCache: d.cropCache === "on" }), tools };
}

export default function ParseEngineCard() {
  const [view, setView] = useState<AdminView | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [message, setMessage] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let live = true;
    getJson<AdminView>("/api/admin/parse-engine")
      .then((v) => {
        if (!live) return;
        setView(v);
        setDraft(draftFromStored(v.stored));
      })
      .catch((err: unknown) => {
        if (live) setMessage(`Could not load the parse-engine flags: ${err instanceof Error ? err.message : String(err)}`);
      });
    return () => {
      live = false;
    };
  }, []);

  const dirty = !!view && !!draft && JSON.stringify(bodyFromDraft(draft)) !== JSON.stringify(bodyFromDraft(draftFromStored(view.stored)));

  async function save() {
    if (!draft) return;
    setSaving(true);
    setMessage("");
    try {
      const next = (await persistFetch("/api/admin/parse-engine", bodyFromDraft(draft), "PUT")) as AdminView | null;
      if (next && isObj(next) && "effective" in next) {
        setView(next);
        setDraft(draftFromStored(next.stored));
      }
      setMessage(draft.killSwitch ? "Saved — the kill switch is ON: every tool uses its classic path." : "Saved.");
    } catch (err) {
      setMessage(err instanceof Error ? err.message : apiErrorMessage(err) || "Save failed");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-1.5 px-3 py-2 mb-3 rounded border border-[var(--border)] bg-[var(--surface)] text-xs" data-testid="parse-engine-card">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium text-[var(--fg)]">Parse engine (root)</span>
        <label className="flex items-center gap-1">
          <input
            type="checkbox"
            aria-label="Kill switch"
            checked={draft?.killSwitch ?? false}
            disabled={!draft}
            onChange={(e) => setDraft((d) => (d ? { ...d, killSwitch: e.target.checked } : d))}
          />
          Kill switch {draft?.killSwitch ? "(ON: everything classic)" : ""}
        </label>
        <label className="flex items-center gap-1">
          Crop cache
          <select
            aria-label="Crop cache"
            className={sel}
            value={draft?.cropCache ?? "default"}
            disabled={!draft}
            onChange={(e) => setDraft((d) => (d ? { ...d, cropCache: e.target.value as Draft["cropCache"] } : d))}
          >
            <option value="default">default ({view?.defaults.cropCache ? "on" : "off"})</option>
            <option value="on">on</option>
            <option value="off">off</option>
          </select>
        </label>
        <button type="button" onClick={save} disabled={saving || !draft || !dirty} className={btn}>
          {saving ? "Saving..." : "Save"}
        </button>
      </div>
      <table className="w-full max-w-xl">
        <tbody>
          {PARSE_ENGINE_TOOL_IDS.map((id) => (
            <tr key={id}>
              <td className="pr-2 py-0.5 text-[var(--fg)]">{TOOL_LABELS[id]}</td>
              <td className="pr-2">
                <select
                  aria-label={TOOL_LABELS[id]}
                  className={sel}
                  value={draft?.tools[id] ?? "default"}
                  disabled={!draft}
                  onChange={(e) => setDraft((d) => (d ? { ...d, tools: { ...d.tools, [id]: e.target.value as Choice } } : d))}
                >
                  <option value="default">default ({view?.defaults.tools[id] ?? "…"})</option>
                  <option value="legacy">legacy</option>
                  <option value="engine">engine</option>
                </select>
              </td>
              <td className="text-[10px] text-[var(--muted)]">now: {view?.effective.tools[id] ?? "…"}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="text-[10px] text-[var(--muted)]">
        &quot;default&quot; follows the code default, which moves to engine only after the engine beats the classic tool on
        the test data. The crop cache switch covers standard crop results only; paid Textract results are always kept.
      </div>
      {view && view.invalid.length > 0 && (
        <div className="text-amber-400">Ignored stored fields: {view.invalid.join(", ")} (saving replaces the document).</div>
      )}
      {message && <div className={message.startsWith("Saved") ? "text-green-400" : "text-red-400"}>{message}</div>}
    </div>
  );
}
