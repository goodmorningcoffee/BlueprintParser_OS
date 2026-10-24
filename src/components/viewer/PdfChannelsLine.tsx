"use client";

// [census F2 2026-10-24] One compact line in the Page Intelligence panel: what the PDF itself
// carries on this page (pageIntelligence.channels, recorded at upload by the channel census).
// Renders nothing for pages uploaded before the census or whose census failed.

import { channelsLine, storedPageChannels } from "@/lib/pdf-channels/summary";

export default function PdfChannelsLine({ intelligence }: { intelligence: unknown }) {
  const record = storedPageChannels(intelligence);
  if (!record) return null;
  return (
    <div className="px-3 py-1 border-b border-[var(--border)] text-[10px] text-[var(--muted)]" title="From the PDF file itself at upload (text layer, line-work, images) — not OCR">
      {channelsLine(record)}
    </div>
  );
}
