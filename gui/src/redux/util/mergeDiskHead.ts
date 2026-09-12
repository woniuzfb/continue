/**
 * 方案.md §7.2.6：**磁盘冻结头部 + 当前 runtime 尾部**的合并规则，只有这一份实现。
 *
 * 三个调用方共用一个语义，禁止各写一遍（复制一份就意味着某天只有一处改了去重或 provenance
 * 规则）：
 *
 * ```text
 * loadFullHistory            水合：把合并结果写回可见窗口（发送后不再走它）
 * loadFullRequestHistory     只读：合并结果只作为本次请求历史，窗口不动
 * ```
 *
 * 这里的输入**必须**是在 await 之后重新读取的 runtime 尾部：磁盘读取期间窗口可能收到流式
 * chunk、工具结果、编辑或另一次水合，用 await 之前的快照合并会静默丢掉这些更新。
 */
export type MergeDiskHeadInput<T> = {
  /** `history/load` 返回的原始磁盘数组（未经 GUI bubble merge）。 */
  diskHistory: T[];
  /** **await 之后**重新读取的可见窗口尾部。 */
  runtimeHistory: T[];
  /** 该窗口声称的冻结头部条数（`pagination.loadedOffset`）。 */
  loadedOffset: number;
};

export type MergeDiskHeadResult<T> =
  | {
      kind: "merged";
      history: T[];
    }
  /** 磁盘比窗口声称的冻结头部还短：合并会丢掉头部，必须中止而不是降级成截断历史。 */
  | { kind: "disk-shorter-than-head"; diskLength: number; headCount: number }
  /** 窗口此刻已经不是发起时的那个（generation / offset 变了）：调用方重新取或中止。 */
  | { kind: "window-moved" };

/**
 * 纯函数：不读 state、不 dispatch、不 await。调用方负责在 await 之后重新读取 `runtimeHistory`
 * 并做自己的门禁（generation / offset / revision），这里只负责合并语义本身：
 *
 * ```text
 * [disk.slice(0, min(loadedOffset, disk.length)), ...runtimeHistory]
 * ```
 *
 * 为什么是「磁盘只取头部、尾部整个来自 runtime」：可见窗口是权威的尾部（可能含尚未落盘的
 * 合并气泡、刚提交的 user + placeholder），而磁盘的尾部在保存后被重写过、与窗口的坐标并不
 * 一一对应。`loadedOffset` 是这两段的分界线，正是水合与懒加载保存共用的契约。
 */
export function mergeDiskHeadWithRuntimeTail<T>({
  diskHistory,
  runtimeHistory,
  loadedOffset,
}: MergeDiskHeadInput<T>): MergeDiskHeadResult<T> {
  const headCount = loadedOffset ?? 0;
  if (diskHistory.length < headCount) {
    return {
      kind: "disk-shorter-than-head",
      diskLength: diskHistory.length,
      headCount,
    };
  }
  const safeHeadCount = Math.min(headCount, diskHistory.length);
  return {
    kind: "merged",
    history: [...diskHistory.slice(0, safeHeadCount), ...runtimeHistory],
  };
}
