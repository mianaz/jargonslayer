import type { MeetingSession } from "@jargonslayer/core/types";
import { buildMarkdownNote, copyMarkdownToClipboard } from "../export";
import { openExternal } from "@/lib/platform/openExternal";

/** Obsidian's official URI can create a note from clipboard contents.
 *  Keeping the report out of the URI avoids URL-length limits and keeps
 *  the full Markdown/frontmatter payload intact. */
export function buildObsidianClipboardUrl(title: string): string {
  const params = new URLSearchParams({ name: title, clipboard: "" });
  return `obsidian://new?${params.toString()}`;
}

export type ObsidianExportResult = "opened" | "copied-only" | "copy-failed";

export async function exportSessionToObsidian(
  session: MeetingSession,
): Promise<ObsidianExportResult> {
  const copied = await copyMarkdownToClipboard(buildMarkdownNote(session));
  if (!copied) return "copy-failed";

  try {
    await openExternal(buildObsidianClipboardUrl(session.title));
    return "opened";
  } catch (err) {
    console.warn("[obsidian] failed to open Obsidian URI", err);
    return "copied-only";
  }
}
