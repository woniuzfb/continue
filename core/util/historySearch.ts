import * as fs from "fs";

import { BaseSessionMetadata, Session } from "..";
import { getSessionFilePath, getSessionsListPath } from "./paths";

export interface HistorySearchResult {
  sessionId: string;
  title: string;
  snippet: string;
}

/**
 * In-memory cache of session file contents keyed by file mtime, so repeated
 * searches only re-read session files that actually changed on disk. Session
 * files are only written when a session is saved, so this stays fresh without
 * any explicit invalidation hooks.
 */
const contentCache = new Map<string, { mtimeMs: number; text: string }>();

export function clearHistorySearchCache(): void {
  contentCache.clear();
}

function loadSessionText(
  sessionId: string,
): { mtimeMs: number; text: string } | undefined {
  const filepath = getSessionFilePath(sessionId);
  try {
    const stat = fs.statSync(filepath);
    const cached = contentCache.get(sessionId);
    if (cached && cached.mtimeMs === stat.mtimeMs) {
      return cached;
    }
    const session: Session = JSON.parse(fs.readFileSync(filepath, "utf8"));
    const text = (session.history ?? [])
      .map((item) => {
        const content = item.message?.content;
        if (typeof content === "string") {
          return content;
        }
        if (Array.isArray(content)) {
          return content
            .map((part) => (part.type === "text" ? (part.text ?? "") : ""))
            .join(" ");
        }
        return "";
      })
      .join("\n");
    const entry = { mtimeMs: stat.mtimeMs, text };
    contentCache.set(sessionId, entry);
    return entry;
  } catch {
    // Missing/unreadable session file — drop any stale cache entry
    contentCache.delete(sessionId);
    return undefined;
  }
}

function makeSnippet(text: string, index: number, matchLength: number): string {
  const start = Math.max(0, index - 40);
  const end = Math.min(text.length, index + matchLength + 60);
  const snippet = text.slice(start, end).replace(/\s+/g, " ").trim();
  return `${start > 0 ? "…" : ""}${snippet}${end < text.length ? "…" : ""}`;
}

/**
 * Search the CONTENT of all saved sessions (not just titles). The query is
 * split into tokens and every token must appear in a session's message text
 * (case-insensitive AND match). Returns matching sessions newest-first with a
 * text snippet around the first match.
 */
export function searchSessionContent(
  query: string,
  workspaceDirectory?: string,
  limit = 50,
): HistorySearchResult[] {
  const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) {
    return [];
  }

  let sessions: BaseSessionMetadata[] = [];
  try {
    sessions = JSON.parse(fs.readFileSync(getSessionsListPath(), "utf8"));
  } catch {
    return [];
  }
  // Newest first (sessions.json is chronological by creation)
  const reversed = sessions
    .filter((s) => typeof (s as any).session_id !== "string")
    .reverse();

  const results: HistorySearchResult[] = [];
  for (const meta of reversed) {
    if (
      workspaceDirectory &&
      meta.workspaceDirectory?.toLowerCase() !==
        workspaceDirectory.toLowerCase()
    ) {
      continue;
    }
    const entry = loadSessionText(meta.sessionId);
    if (!entry) {
      continue;
    }
    const lower = entry.text.toLowerCase();
    if (!tokens.every((t) => lower.includes(t))) {
      continue;
    }
    const firstIdx = lower.indexOf(tokens[0]);
    results.push({
      sessionId: meta.sessionId,
      title: meta.title,
      snippet: makeSnippet(entry.text, firstIdx, tokens[0].length),
    });
    if (results.length >= limit) {
      break;
    }
  }
  return results;
}
