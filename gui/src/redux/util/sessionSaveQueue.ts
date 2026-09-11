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

import { mergeMeasurementIntent } from "./sessionSaveIntent";

/**
 * 方案.md §五.16.4「保存边界（按显式开关，不按 reason）」：**调用方**声明本次保存是否
 * 建立了一个新的完整会话内容版本，以及是哪一个版本。
 *
 * reason 只用于诊断/日志/测试描述，**不参与计量决策** —— 新增或重命名 reason 不得改变
 * 计量语义，否则「真正推进了 revision 的新 action」会静默漏计量，而「名字像终态但没推进
 * revision 的保存」会静默多计量。字段是必填的：编译器强制每个入队点表态。
 */
export type SessionSaveMeasurementIntent =
  | { kind: "none" }
  | {
      /**
       * 本次保存建立了新的完整会话内容版本，且当时的 `conversationRevision`
       * 就是这个值。构造保存载荷时会再校验它与 session 当前值一致；
       * 不一致（保存期间又变了）则**不携带** measurement，磁盘 metrics 保持原状。
       */
      kind: "conversation-version";
      conversationRevision: number;
    };

export type PendingSave = {
  revision: number;
  reason: string;
  measurementIntent: SessionSaveMeasurementIntent;
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

/**
 * Coalesce a new pending save into the session's single slot (方案.md §五.16.4).
 *
 * `revision` / `reason` are last-write-wins — the newest snapshot is the one that
 * must reach disk. The **measurement intent is merged** instead: a later
 * bookkeeping save (`none`) must not silently swallow a `conversation-version`
 * obligation that a terminal established while the previous save was running.
 * Merging the intent is safe because the payload builder still checks the stated
 * revision against the session's current one.
 */
export function setPendingSave(sessionId: string, entry: PendingSave): void {
  const previous = pendingSaves.get(sessionId);
  pendingSaves.set(
    sessionId,
    previous
      ? {
          ...entry,
          measurementIntent: mergeMeasurementIntent(
            previous.measurementIntent,
            entry.measurementIntent,
          ),
        }
      : entry,
  );
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
