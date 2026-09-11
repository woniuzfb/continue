/**
 * Module-level save queue (方案.md §七.5).
 *
 * The queue lives outside Redux on purpose: it is *scheduling* state, not
 * session state, and the Redux projection (`persistence.state`) can lag behind
 * it by a tick. Anything that needs to know "is a write for this session still
 * in flight?" must ask this module rather than read `persistence.state`.
 *
 * It was extracted out of `thunks/sessionPersistence.ts` so the legacy
 * message-ID migration gate can ask that question without importing the save
 * thunk (that import would close a module cycle: the save thunk kicks the
 * migration after a save settles).
 *
 * The maps themselves are never exported — callers get accessors and the
 * read-only `hasPendingSessionSave` predicate, so no caller can hold a stale
 * reference to the queue.
 */

export type PendingSave = {
  revision: number;
  reason: string;
};

const pendingSaves = new Map<string, PendingSave>();
const runningSaves = new Map<string, Promise<void>>();

/**
 * True while a save for this session is queued or currently running.
 *
 * A caller that only reads `persistence.state` can be wrong in both directions:
 * a save that was just enqueued has not touched Redux yet, and a save that
 * just settled may already have cleared the queue while Redux still says
 * "saving". Both cases must block a concurrent disk writer.
 */
export function hasPendingSessionSave(sessionId: string): boolean {
  return pendingSaves.has(sessionId) || runningSaves.has(sessionId);
}

export function getPendingSave(sessionId: string): PendingSave | undefined {
  return pendingSaves.get(sessionId);
}

export function setPendingSave(sessionId: string, entry: PendingSave): void {
  pendingSaves.set(sessionId, entry);
}

export function deletePendingSave(sessionId: string): void {
  pendingSaves.delete(sessionId);
}

export function getRunningSave(sessionId: string): Promise<void> | undefined {
  return runningSaves.get(sessionId);
}

export function setRunningSave(
  sessionId: string,
  running: Promise<void>,
): void {
  runningSaves.set(sessionId, running);
}

export function deleteRunningSave(sessionId: string): void {
  runningSaves.delete(sessionId);
}

export function pendingSaveSessionIds(): string[] {
  return [...pendingSaves.keys()];
}

export function runningSaveSessionIds(): string[] {
  return [...runningSaves.keys()];
}

/** Test helper: drop module-level queue state between tests. */
export function resetSessionSaveQueues(): void {
  pendingSaves.clear();
  runningSaves.clear();
}
