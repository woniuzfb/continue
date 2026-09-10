import { v4 as uuidv4 } from "uuid";

import type { ChatHistoryItem } from "../index.js";

/**
 * Core-side legacy message ID stabilization (P2 of
 * `bugs/Legacy_messageID_stabilization_设计.md`).
 *
 * Legacy sessions were written before `message.id` was persisted, so every
 * `load()` re-reads the same id-less items from disk. Minting an id per load
 * would make two `loadPage()` calls disagree (G1), so ids are allocated from a
 * **per-process** table keyed by the absolute array index — the one coordinate
 * `load()` can see without any offset arithmetic (see the design's §10.1/§10.2).
 *
 * This module never writes to disk. P3 (`history/migrateIds`) is what makes the
 * ids durable; until then they only need to be stable within this process.
 */

/** role + content digest of one history item. */
type Fingerprint = string;

type Entry = {
  id: string;
  /** Fingerprint at assignment time. `""` means "was the streaming tail". */
  fingerprint: Fingerprint;
};

type SessionTable = {
  /** absoluteIndex -> assignment */
  entries: Map<number, Entry>;
};

const tables = new Map<string, SessionTable>();

/** FNV-1a — cheap, allocation-free, stable across processes. */
function hashInto(value: string, seed: number): number {
  let hash = seed;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function contentDigest(content: unknown): number {
  if (typeof content === "string") {
    return hashInto(content, 2166136261);
  }
  if (Array.isArray(content)) {
    let hash = 2166136261;
    for (const part of content) {
      if (part && typeof part === "object") {
        const p = part as {
          type?: string;
          text?: string;
          imageUrl?: { url?: string };
        };
        hash = hashInto(`${p.type ?? ""}\u0000${p.text ?? ""}`, hash);
        hash = hashInto(p.imageUrl?.url ?? "", hash);
      }
    }
    return hash;
  }
  return 0;
}

/**
 * Fingerprint used to answer "is index i still the same item?". Content is
 * included so a genuine rewrite (compact / delete / external edit) is detected,
 * but the caller blanks it for the **streaming tail** — see R1 in the design:
 * the last assistant message grows in place during streaming, and treating that
 * as "the array changed" would rebuild the table and churn ids mid-stream.
 */
function fingerprintOf(item: ChatHistoryItem | undefined): Fingerprint {
  if (!item || typeof item !== "object") {
    return "";
  }
  const message = item.message as
    | { role?: string; content?: unknown }
    | undefined;
  if (!message) {
    return "";
  }
  return `${message.role ?? ""}\u0000${contentDigest(message.content)}`;
}

/**
 * Read the persisted message identity off a history item, or `undefined` when
 * it is absent/empty. Exported so the migration path (`history/migrateIds`)
 * applies exactly the same "is this id already present?" rule as the stabilizer.
 */
export function readMessageId(item: ChatHistoryItem): string | undefined {
  const id = (item.message as { id?: unknown }).id;
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

/**
 * Assign a stable id to every item that lacks one, in place, matching the
 * in-place style of the `load()` slimming helpers (`stripAttachedFileContent`
 * et al). Items that already carry a persisted id are never rewritten.
 */
export function stabilizeWholeHistory(
  sessionId: string,
  fullHistory: ChatHistoryItem[],
): void {
  if (!Array.isArray(fullHistory) || fullHistory.length === 0) {
    tables.delete(sessionId);
    return;
  }

  const lastIndex = fullHistory.length - 1;
  // R1: the tail's content is deliberately not part of the fingerprint.
  const current = fullHistory.map((item, index) =>
    index === lastIndex ? "" : fingerprintOf(item),
  );

  // A table is only reusable while it still describes the same array. Any
  // mismatch on a compared index means the array was rewritten (compact /
  // delete / external modification) -> discard it rather than hand out ids that
  // now point at different items. Blank fingerprints were recorded for a
  // streaming tail, so they are skipped here and reused below.
  let table = tables.get(sessionId);
  if (table) {
    for (const [index, entry] of table.entries) {
      if (index >= fullHistory.length) {
        table = undefined;
        break;
      }
      if (entry.fingerprint === "") {
        continue;
      }
      if (entry.fingerprint !== current[index]) {
        table = undefined;
        break;
      }
    }
  }

  const entries = new Map<number, Entry>();
  for (let i = 0; i < fullHistory.length; i++) {
    const message = fullHistory[i].message as { id?: string };
    const persisted = readMessageId(fullHistory[i]);
    const reusable = table?.entries.get(i);
    // A blank stored fingerprint means "this index was the streaming tail when
    // we recorded it" -> its content was allowed to change, so keep its id.
    const canReuse =
      reusable !== undefined &&
      (reusable.fingerprint === "" || reusable.fingerprint === current[i]);

    const id = persisted ?? (canReuse ? reusable!.id : uuidv4());
    if (persisted === undefined) {
      message.id = id;
    }
    entries.set(i, { id, fingerprint: current[i] });
  }

  tables.set(sessionId, { entries });
}

/**
 * Drop a session's allocation table. Exported for the (future) migration path
 * and for tests; `load()` deliberately does not call it after a save, because
 * persisted ids already win on the next load and dropping the table would
 * re-mint the frozen head of a truncated save (which carries no ids).
 */
export function invalidateMessageIdAllocations(sessionId: string): void {
  tables.delete(sessionId);
}

/** Test hook: drop one session's table, or every table. */
export function resetMessageIdAllocations(sessionId?: string): void {
  if (sessionId === undefined) {
    tables.clear();
  } else {
    tables.delete(sessionId);
  }
}
