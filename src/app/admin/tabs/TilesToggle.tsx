"use client";

// [tiles T9 2026-10-24] Root-only "Tile images at upload" switch (admin › Pipeline), beside the upload
// compute picker. GET/PUT /api/admin/tiles (validated again on the server, audited). Off = new
// uploads get no tile pyramid (the page PNG still does); the Reprocess "Tile images" stage backfills
// or re-cuts regardless of this switch. Levels are tile edge sizes in px, largest first by habit.

import { useEffect, useState } from "react";
import { apiErrorMessage, persistFetch } from "@/lib/client-persist";
import { formatTileLevels, parseTileLevels, type TilesSetting } from "@/lib/tiles/settings";

interface TilesSettingResponse extends TilesSetting {
  valid: boolean;
  defaults: TilesSetting;
}

const btn = "px-2.5 py-1 rounded border border-[var(--border)] hover:border-[var(--accent)] disabled:opacity-40";

export default function TilesToggle() {
  const [data, setData] = useState<TilesSettingResponse | null>(null);
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [levelsText, setLevelsText] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let live = true;
    fetch("/api/admin/tiles")
      .then(async (res) => {
        const body = await res.json().catch(() => null);
        if (!res.ok) throw new Error(apiErrorMessage(body) || `HTTP ${res.status}`);
        if (live) setData(body as TilesSettingResponse);
      })
      .catch((err: unknown) => {
        if (live) setMessage(`Could not load the tile setting: ${err instanceof Error ? err.message : String(err)}`);
      });
    return () => {
      live = false;
    };
  }, []);

  const currentEnabled = data?.enabled ?? true;
  const currentLevels = data ? formatTileLevels(data.levels) : "";
  const shownEnabled = enabled ?? currentEnabled;
  const shownLevels = levelsText ?? currentLevels;
  const parsedLevels = parseTileLevels(shownLevels);
  const dirty = shownEnabled !== currentEnabled || shownLevels.trim() !== currentLevels;

  async function save() {
    if (!parsedLevels) {
      setMessage("Levels must be 1–4 unique whole numbers (px), e.g. 3600, 1280");
      return;
    }
    setSaving(true);
    setMessage("");
    try {
      await persistFetch("/api/admin/tiles", { enabled: shownEnabled, levels: parsedLevels }, "PUT");
      setData((d) => (d ? { ...d, enabled: shownEnabled, levels: parsedLevels, valid: true } : d));
      setEnabled(null);
      setLevelsText(null);
      setMessage(`Saved — new uploads ${shownEnabled ? `are tiled at ${formatTileLevels(parsedLevels)} px` : "are not tiled"}.`);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-1 px-3 py-2 mb-3 rounded border border-[var(--border)] bg-[var(--surface)] text-xs" data-testid="tiles-toggle">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium text-[var(--fg)]">Tile images at upload (root)</span>
        <label className="flex items-center gap-1">
          <input type="checkbox" checked={shownEnabled} disabled={!data} onChange={(e) => setEnabled(e.target.checked)} />
          {shownEnabled ? "On" : "Off"}
        </label>
        <input
          aria-label="Tile sizes (px)"
          value={shownLevels}
          disabled={!data}
          onChange={(e) => setLevelsText(e.target.value)}
          className="px-2 py-1 w-36 bg-[var(--bg)] border border-[var(--border)] rounded"
          placeholder={data ? formatTileLevels(data.defaults.levels) : "Loading…"}
        />
        <button type="button" onClick={save} disabled={saving || !data || !dirty} className={btn}>
          {saving ? "Saving..." : "Save"}
        </button>
      </div>
      <div className="text-[10px] text-[var(--muted)]">
        Cuts every uploaded page into overlapping tiles at native 300 DPI (one level per size, 20% overlap) stored beside
        the page image in S3 for the detectors and labelling. Off saves storage; Reprocess › Tile images backfills later.
      </div>
      {message && <div className={message.startsWith("Saved") ? "text-green-400" : "text-red-400"}>{message}</div>}
    </div>
  );
}
