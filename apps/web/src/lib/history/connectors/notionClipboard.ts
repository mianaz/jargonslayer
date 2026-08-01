import type { MeetingSession } from "@jargonslayer/core/types";
import { buildMarkdownReport, copyMarkdownToClipboard } from "../export";
import { openExternal } from "@/lib/platform/openExternal";

export type NotionClipboardResult = "opened" | "copied-only" | "copy-failed";

/** Zero-account fallback while the hosted Notion OAuth bridge is not
 *  configured: write rich+plain clipboard flavours and open Notion.
 *  Both operations are started in the original click stack so browser
 *  popup/clipboard user-activation checks do not expire between awaits. */
export async function exportSessionToNotionClipboard(
  session: MeetingSession,
): Promise<NotionClipboardResult> {
  const [copied, opened] = await Promise.all([
    copyMarkdownToClipboard(buildMarkdownReport(session)),
    openExternal("https://www.notion.so").then(
      () => true,
      (err) => {
        console.warn("[notion] failed to open Notion", err);
        return false;
      },
    ),
  ]);
  if (!copied) return "copy-failed";
  return opened ? "opened" : "copied-only";
}
